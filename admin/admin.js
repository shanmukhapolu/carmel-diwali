import {
  CONFIG,
  VOLUNTEER_POSITIONS,
  formatTime,
  formatShiftTime,
  getPositionById,
  getShiftById,
  findShift,
  normalizeLastName,
  normalizePhoneNumber
} from "../config.js";

import { db } from "../firebase-init.js";
import { requireAdmin, logout, isEnabledAdmin } from "./auth.js";
import { reserveShiftAndCreateRegistration } from "../app.js";

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const REGISTRATIONS_COLLECTION = "registrations";
const CHECKINS_COLLECTION = "checkins";
const CHECKIN_ACTIVITY_COLLECTION = "checkinActivity";
const SHIFT_COUNTS_COLLECTION = "shiftCounts";
const ADMINS_COLLECTION = "admins";

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

const EVENT_DATE = new Date(`${CONFIG.eventDate}T00:00:00`);
const EVENT_TIME_ZONE = CONFIG.timeZone || "America/New_York";
const EVENT_TIME_ZONE_LABEL = CONFIG.timeZoneLabel || "EST";

let activeStatsTab = "registration";

const REGISTRATION_START = new Date("2026-08-15T00:00:00");

const $ = (id) => document.getElementById(id);

let registrations = [];
let adminDirectory = new Map();
let shiftCapacities = new Map();

let tableState = {
  sortKey: "createdAt",
  sortDirection: "desc",
  page: 1,
  pageSize: 25
};


/* =========================================================
   AUTH / PAGE INITIALIZATION
========================================================= */

requireAdmin({
  onReady: (user, profile) => {
    initShell(user, profile);

    if (location.pathname.includes("manage")) {
      initManagePage(user, profile);
      return;
    }

    if (location.pathname.includes("checkin")) {
      initCheckinPage(user, profile);
      return;
    }

    if (location.pathname.includes("registrations")) {
      initRegistrationsPage();
      return;
    }

    if (location.pathname.includes("statistics")) {
      initStatisticsPage();
      return;
    }
  },

  onDenied: (message) => showError(message),
});


/* =========================================================
   SHELL / NAVIGATION
========================================================= */

function initShell(user, profile) {
  renderNavigation(profile);

  setText(
    "admin-email",
    profile.email ||
      user.email ||
      "Admin"
  );

  setText(
    "event-meta",
    `${CONFIG.eventName} • ${formatDriveDate(
      CONFIG.eventDate
    )} • ${CONFIG.location}`
  );

  setText(
    "drive-meta",
    `${CONFIG.eventName} • ${formatDriveDate(
      CONFIG.eventDate
    )} • ${CONFIG.location}`
  );

  $("logout")?.addEventListener(
    "click",
    logout
  );
}

function renderNavigation(profile) {
  document.querySelectorAll(".nav").forEach((nav) => {
    nav.textContent = "";

    const adminLinks = [
      ["Dashboard", "/admin/"],
      ["Volunteers", "/admin/registrations.html"],
      ["Manage", "/admin/manage.html"],
      ["Check-In", "/admin/checkin.html"],
      ["Statistics", "/admin/statistics.html"]
    ];

    let current =
      location.pathname.split("/").pop() ||
      "index.html";

    if (
      location.pathname.endsWith("/admin/checkin/") ||
      location.pathname.endsWith("/admin/checkin") ||
      location.pathname.includes("checkin")
    ) {
      current = "checkin.html";
    }

    if (
      location.pathname.endsWith("/admin/") ||
      location.pathname.endsWith("/admin")
    ) {
      current = "index.html";
    }

    if (location.pathname.includes("manage")) {
      current = "manage.html";
    }

    adminLinks.forEach(([label, href]) => {
      const a = document.createElement("a");

      a.href = href;
      a.textContent = label;

      if (
        href.endsWith(current) ||
        (href === "/admin/" && current === "index.html") ||
        (href === "/admin/checkin.html" && current === "checkin.html") ||
        (href === "/admin/manage.html" && current === "manage.html")
      ) {
        a.className = "active";
      }

      nav.appendChild(a);
    });
  });
}


/* =========================================================
   MANAGE REGISTRATIONS PAGE
========================================================= */

async function initManagePage(user, profile) {
  await loadShiftCapacities();

  // ---- Populate the manual-registration shift selector ----
  const manualShiftSel = $("manual-shift");

  if (manualShiftSel) {
    manualShiftSel.textContent = "";

    manualShiftSel.append(
      new Option("Select an available shift…", "")
    );

    VOLUNTEER_POSITIONS.forEach((position) => {
      position.shifts?.forEach((shift) => {
        const capData =
          shiftCapacities.get(shift.id) || {
            capacity: shift.capacity || 0,
            count: 0
          };

        const remaining =
          Math.max(
            0,
            Number(capData.capacity) -
              Number(capData.count)
          );

        const label =
          `${position.name} — ${formatShiftTime(shift)}` +
          (remaining > 0
            ? ` (${remaining} available)`
            : " (Full)");

        const opt = new Option(
          label,
          `${position.id}::${shift.id}`
        );

        opt.disabled = remaining <= 0;

        manualShiftSel.append(opt);
      });
    });
  }

  // ---- Lookup form ----
  const lookupForm = $("lookup-form");
  const lookupStatus = $("lookup-status");
  const lookupSection = $("lookup-results-section");
  const lookupRows = $("lookup-rows");
  const lookupCount = $("lookup-results-count");

  function hideLookupResults() {
    if (lookupSection) {
      lookupSection.style.display = "none";
    }
  }

  $("btn-lookup-reset")?.addEventListener("click", () => {
    if ($("lookup-lastname")) $("lookup-lastname").value = "";
    if ($("lookup-phone"))    $("lookup-phone").value = "";
    hideLookupResults();

    if (lookupStatus) {
      lookupStatus.textContent =
        "Enter a last name or phone number to look up registrations.";
    }
  });

  lookupForm?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const rawLast = $("lookup-lastname")?.value.trim() || "";
    const rawPhone = $("lookup-phone")?.value.trim() || "";

    if (!rawLast && !rawPhone) {
      if (lookupStatus) {
        lookupStatus.textContent =
          "Please enter a last name, phone number, or both.";
      }

      return;
    }

    if (lookupStatus) {
      lookupStatus.textContent = "Searching…";
    }

    const normLast = normalizeLastName(rawLast);
    const normPhone = normalizePhoneNumber(rawPhone);

    try {
      // Load all registrations and filter client-side.
      // (A small dataset; no server-side compound query needed.)
      const snap = await getDocs(
        query(
          collection(db, REGISTRATIONS_COLLECTION),
          orderBy("createdAt", "desc")
        )
      );

      const results = snap.docs
        .map((d) => serialize({ id: d.id, ...d.data() }))
        .filter((r) => {
          const rLast = normalizeLastName(r.lastName);
          const rPhone = normalizePhoneNumber(r.phone);

          const lastMatch =
            !normLast || rLast === normLast;

          const phoneMatch =
            !normPhone || rPhone === normPhone;

          return lastMatch && phoneMatch;
        });

      if (lookupSection) {
        lookupSection.style.display = "";
      }

      if (lookupCount) {
        lookupCount.textContent =
          `${results.length} result${results.length !== 1 ? "s" : ""}`;
      }

      if (lookupStatus) {
        lookupStatus.textContent = "";
      }

      // Render results rows.
      if (lookupRows) {
        lookupRows.textContent = "";

        if (!results.length) {
          const row = document.createElement("tr");
          const cell = document.createElement("td");

          cell.colSpan = 9;
          cell.textContent =
            "No registrations found matching those criteria.";

          row.appendChild(cell);
          lookupRows.appendChild(row);
          return;
        }

        results.forEach((record) => {
          const row = document.createElement("tr");

          [
            record.id,

            `${record.firstName || ""} ${record.lastName || ""}`.trim(),

            record.is18OrOlder === true
              ? "Yes (18+)"
              : record.is18OrOlder === false
              ? "No (<18)"
              : "—",

            record.phone,

            record.email,

            positionLabel(
              record.positionId,
              record.positionName || record.position
            ),

            shiftLabel(record.shiftId, record.shiftLabel),

            operationalLabel(record.checkin?.status)
          ].forEach((value) => {
            const cell = document.createElement("td");
            cell.textContent = value ?? "";
            row.appendChild(cell);
          });

          // Actions cell.
          const actionsCell = document.createElement("td");
          actionsCell.className = "table-actions";

          actionsCell.appendChild(
            smallButton(
              "Cancel Registration",
              () =>
                showManageCancelModal(
                  record,
                  () => {
                    // Refresh the lookup results after cancel.
                    lookupForm.dispatchEvent(
                      new Event("submit", { cancelable: true })
                    );
                  }
                ),
              "danger-lite"
            )
          );

          row.appendChild(actionsCell);

          row.addEventListener("click", () => showDetail(record));

          actionsCell.addEventListener("click", (e) =>
            e.stopPropagation()
          );

          lookupRows.appendChild(row);
        });
      }
    } catch (lookupError) {
      console.error("[Admin Manage] lookup failed:", lookupError);

      if (lookupStatus) {
        lookupStatus.textContent =
          "Could not search registrations. Please try again.";
      }
    }
  });

  // ---- Manual registration form ----
  const manualForm = $("manual-reg-form");
  const manualError = $("manual-error");
  const manualSuccess = $("manual-success");

  manualForm?.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (manualError) manualError.textContent = "";
    if (manualSuccess) manualSuccess.textContent = "";

    const firstName = $("manual-firstname")?.value.trim() || "";
    const lastName  = $("manual-lastname")?.value.trim()  || "";
    const email     = $("manual-email")?.value.trim()     || "";
    const phone     = $("manual-phone")?.value.trim()     || "";
    const notes     = $("manual-notes")?.value.trim()     || "";

    const is18Raw = document.querySelector(
      "input[name='manual-is18OrOlder']:checked"
    )?.value;

    const is18OrOlder =
      is18Raw === "yes" ? true :
      is18Raw === "no"  ? false :
      null;

    const shiftValue = $("manual-shift")?.value || "";

    if (!firstName || !lastName || !email || !phone || !shiftValue || is18OrOlder === null) {
      if (manualError) {
        manualError.textContent =
          "All fields are required. Please complete the form.";
      }

      return;
    }

    const [positionId, shiftId] = shiftValue.split("::");

    const submitBtn = $("btn-manual-submit");

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Registering…";
    }

    try {
      const confirmationId =
        await reserveShiftAndCreateRegistration({
          firstName,
          lastName,
          email,
          phone,
          is18OrOlder,
          positionId,
          shiftId,
          notes,
          registeredByAdmin: true,
          registeredByUid: user.uid,
          registeredByName: adminDisplayName(profile, user)
        });

      if (manualSuccess) {
        manualSuccess.textContent =
          `Registration created. Confirmation ID: ${confirmationId}`;
      }

      manualForm.reset();

      // Refresh capacity display.
      await loadShiftCapacities();

      // Rebuild the shift selector so the capacity counts update.
      if (manualShiftSel) {
        manualShiftSel.textContent = "";
        manualShiftSel.append(
          new Option("Select an available shift…", "")
        );

        VOLUNTEER_POSITIONS.forEach((position) => {
          position.shifts?.forEach((shift) => {
            const capData =
              shiftCapacities.get(shift.id) || {
                capacity: shift.capacity || 0,
                count: 0
              };

            const remaining =
              Math.max(
                0,
                Number(capData.capacity) -
                  Number(capData.count)
              );

            const label =
              `${position.name} — ${formatShiftTime(shift)}` +
              (remaining > 0
                ? ` (${remaining} available)`
                : " (Full)");

            const opt = new Option(
              label,
              `${position.id}::${shift.id}`
            );

            opt.disabled = remaining <= 0;

            manualShiftSel.append(opt);
          });
        });
      }
    } catch (regError) {
      const code = regError?.message || regError?.code || "";

      let message =
        "Could not complete registration. Please try again.";

      if (code === "DUPLICATE_REGISTRATION") {
        message =
          "A registration with this email already exists.";
      } else if (code === "DUPLICATE_NAME_PHONE") {
        message =
          "A registration with this last name and phone number already exists.";
      } else if (code === "SHIFT_FULL") {
        message =
          "That shift is now full. Please choose another.";
      } else if (code === "SHIFT_UNAVAILABLE") {
        message =
          "The selected shift is unavailable.";
      }

      if (manualError) {
        manualError.textContent = message;
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Create Volunteer Registration";
      }
    }
  });
}


/* =========================================================
   MANAGE — CANCEL / DELETE MODAL
========================================================= */

function showManageCancelModal(record, onSuccess) {
  const root = $("modal-root");
  if (!root) return;

  root.textContent = "";

  const modal = modalShell(
    `Cancel registration for ${
      record.firstName || "this"
    } ${record.lastName || "volunteer"}?`
  );

  const reason = document.createElement("select");

  [
    ["", "Select a required reason"],
    ["volunteer_cancelled", "Volunteer cancelled"],
    ["duplicate", "Duplicate registration"],
    ["data_entry_error", "Data entry error"],
    ["other", "Other"]
  ].forEach(([v, l]) => reason.append(new Option(l, v)));

  const other = document.createElement("textarea");
  other.placeholder = "Required when Other is selected";
  other.className = "hidden";

  const error = document.createElement("p");
  error.className = "error";

  const confirmBtn = smallButton(
    "Cancel Registration & Restore Shift Slot",
    async () => {
      if (
        !reason.value ||
        (reason.value === "other" && !other.value.trim())
      ) {
        error.textContent =
          "Choose a reason. If you select Other, add a written explanation.";

        return;
      }

      try {
        // Audit log.
        await setDoc(
          doc(collection(db, "registrationDeletionLogs")),
          {
            registrationId: record.id,
            shiftId: record.shiftId,
            reason: reason.value,
            otherReason: other.value.trim(),
            deletedAt: serverTimestamp()
          }
        );

        // Atomic delete + capacity restore.
        await runTransaction(db, async (tx) => {
          const regRef = doc(
            db,
            REGISTRATIONS_COLLECTION,
            record.id
          );

          const regSnap = await tx.get(regRef);

          if (!regSnap.exists()) return;

          if (record.shiftId) {
            const countRef = doc(
              db,
              SHIFT_COUNTS_COLLECTION,
              shiftDocId(record.shiftId)
            );

            const countSnap = await tx.get(countRef);

            if (countSnap.exists()) {
              tx.update(countRef, {
                count: Math.max(
                  0,
                  (Number(countSnap.data().count) || 0) - 1
                )
              });
            }
          }

          tx.delete(regRef);
        });

        // Best-effort cleanup.
        await deleteDoc(
          doc(db, CHECKINS_COLLECTION, record.id)
        ).catch(() => {});

        if (record.email) {
          await deleteDoc(
            doc(
              db,
              "registrationGuards",
              `email_${encodeURIComponent(
                String(record.email).toLowerCase().trim()
              )}`
            )
          ).catch(() => {});
        }

        const normLast =
          record.normalizedLastName ||
          normalizeLastName(record.lastName);

        const normPhone =
          record.normalizedPhone ||
          normalizePhoneNumber(record.phone);

        if (normLast && normPhone) {
          await deleteDoc(
            doc(
              db,
              "registrationGuards",
              `name_phone_${normLast}_${normPhone}`
            )
          ).catch(() => {});
        }

        root.textContent = "";
        onSuccess?.();

      } catch (cancelError) {
        console.error("[Admin Manage] cancel failed:", cancelError);
        error.textContent =
          "Cancellation failed. Please try again or check the console.";
      }
    },
    "danger"
  );

  reason.addEventListener("input", () =>
    other.classList.toggle("hidden", reason.value !== "other")
  );

  modal.card.append(
    detailSection("Registration to cancel", [
      ["Volunteer", `${record.firstName || ""} ${record.lastName || ""}`.trim()],
      ["Position", positionLabel(record.positionId, record.positionName || record.position)],
      ["Shift", shiftLabel(record.shiftId, record.shiftLabel)],
      ["Confirmation ID", record.id]
    ]),
    reason,
    other,
    error,
    confirmBtn
  );

  root.appendChild(modal.overlay);
}


/* =========================================================
   REGISTRATIONS / VOLUNTEERS
========================================================= */

async function initRegistrationsPage() {
  fillFilters();
  bindFilters();
  bindRegistrationActions();

  renderTable([]);

  setText(
    "counts",
    "Loading volunteers…"
  );

  await Promise.all([
    loadAdminDirectory(),
    loadShiftCapacities()
  ]);

  registrations =
    await loadRegistrations();

  renderRegistrations();
}


async function loadAdminDirectory() {
  try {
    const snap = await getDocs(
      collection(
        db,
        ADMINS_COLLECTION
      )
    );

    adminDirectory = new Map(
      snap.docs.map((d) => {
        const data = d.data();

        const name =
          [
            data.firstName,
            data.lastName
          ]
            .filter(Boolean)
            .join(" ")
            .trim() ||
          data.name ||
          data.displayName ||
          data.email ||
          d.id;

        return [d.id, name];
      })
    );

  } catch (error) {
    console.info(
      "[Admin Dashboard] admin directory read failed",
      {
        code:
          error?.code ||
          "unknown"
      }
    );

    adminDirectory =
      new Map();
  }
}


async function loadShiftCapacities() {
  try {
    const snap = await getDocs(
      collection(
        db,
        SHIFT_COUNTS_COLLECTION
      )
    );

    shiftCapacities =
      new Map(
        snap.docs.map((d) => [
          d.data().shiftId ||
            d.id.split("_").pop(),

          serialize({
            id: d.id,
            ...d.data()
          })
        ])
      );

  } catch (error) {
    console.error(
      "[Admin Dashboard] shift capacity read failed:",
      error
    );

    shiftCapacities =
      new Map();
  }
}


async function loadRegistrations() {
  try {
    const registrationsQuery =
      query(
        collection(
          db,
          REGISTRATIONS_COLLECTION
        ),
        orderBy(
          "createdAt",
          "desc"
        )
      );

    const snapshot =
      await getDocs(
        registrationsQuery
      );

    console.info(
      "[Admin Dashboard] all volunteers read:",
      snapshot.size
    );

    const records =
      snapshot.docs.map(
        (registration) =>
          serialize({
            id: registration.id,
            ...registration.data()
          })
      );

    const checkins =
      await loadCheckinsMap();

    return records.map(
      (record) => ({
        ...record,

        checkin:
          checkins.get(record.id) ||
          {
            status: "registered"
          }
      })
    );

  } catch (error) {
    console.error(
      "[Admin Dashboard] all volunteers read failed:",
      error
    );

    showError(
      "Could not load volunteers."
    );

    return [];
  }
}


function serialize(value) {
  if (value?.toDate) {
    return value
      .toDate()
      .toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(
      serialize
    );
  }

  if (
    value &&
    typeof value === "object"
  ) {
    return Object.fromEntries(
      Object.entries(value).map(
        ([key, entry]) => [
          key,
          serialize(entry)
        ]
      )
    );
  }

  return value;
}


/* =========================================================
   FILTERS
========================================================= */

function fillFilters() {
  const positionFilter =
    $("filter-position");

  if (positionFilter) {
    VOLUNTEER_POSITIONS.forEach(
      (position) => {
        positionFilter.append(
          new Option(
            position.name,
            position.id
          )
        );
      }
    );
  }

  const shiftFilter =
    $("filter-shift");

  if (shiftFilter) {
    VOLUNTEER_POSITIONS.forEach(
      (position) => {
        position.shifts?.forEach(
          (shift) => {
            shiftFilter.append(
              new Option(
                `${position.name} — ${formatShiftTime(
                  shift
                )}`,
                shift.id
              )
            );
          }
        );
      }
    );
  }

  PAGE_SIZE_OPTIONS.forEach(
    (size) => {
      $("page-size")?.append(
        new Option(
          `${size} per page`,
          String(size),
          size === 25,
          size === 25
        )
      );
    }
  );

  fillSelect(
    "filter-status",
    [
      [
        "registered",
        "Registered"
      ],
      [
        "checked_in",
        "Checked In"
      ],
      [
        "completed",
        "Checked Out"
      ],
      [
        "late",
        "Late"
      ]
    ]
  );
}


function fillSelect(
  id,
  options
) {
  const select = $(id);

  if (!select) return;

  options.forEach(
    ([value, label]) =>
      select.append(
        new Option(
          label,
          value
        )
      )
  );
}


function bindFilters() {
  [
    "search",
    "filter-position",
    "filter-shift",
    "filter-status"
  ].forEach((id) => {
    $(id)?.addEventListener(
      "input",
      () => {
        tableState.page = 1;
        renderRegistrations();
      }
    );
  });

  $("page-size")?.addEventListener(
    "input",
    () => {
      tableState.pageSize =
        Number(
          $("page-size").value
        ) || 25;

      tableState.page = 1;

      renderRegistrations();
    }
  );

  $("clear-filters")?.addEventListener(
    "click",
    () => {
      [
        "search",
        "filter-position",
        "filter-shift",
        "filter-status"
      ].forEach((id) => {
        if ($(id)) {
          $(id).value = "";
        }
      });

      tableState = {
        sortKey: "createdAt",
        sortDirection: "desc",
        page: 1,
        pageSize:
          Number(
            $("page-size")?.value
          ) || 25
      };

      renderRegistrations();
    }
  );

  document
    .querySelectorAll("[data-sort]")
    .forEach((header) => {
      header.addEventListener(
        "click",
        () =>
          setSort(
            header.dataset.sort
          )
      );
    });

  $("prev-page")?.addEventListener(
    "click",
    () => {
      tableState.page -= 1;
      renderRegistrations();
    }
  );

  $("next-page")?.addEventListener(
    "click",
    () => {
      tableState.page += 1;
      renderRegistrations();
    }
  );

  $("refresh")?.addEventListener(
    "click",
    async () => {
      setText(
        "counts",
        "Refreshing volunteers…"
      );

      registrations =
        await loadRegistrations();

      await loadShiftCapacities();

      renderRegistrations();
    }
  );
}


function bindRegistrationActions() {
  $("export-all-csv")?.addEventListener(
    "click",
    () =>
      showExportModal(
        filteredRecords(),
        "all-volunteers",
        "csv"
      )
  );

  $("export-all-pdf")?.addEventListener(
    "click",
    () =>
      showExportModal(
        filteredRecords(),
        "all-volunteers",
        "pdf"
      )
  );
}


/* =========================================================
   SHIFT CAPACITY EDITOR
========================================================= */

function renderShiftCapacityEditor() {
  const root =
    $("shift-capacity-grid");

  if (!root) return;

  root.textContent = "";

  let totalShifts = 0;

  VOLUNTEER_POSITIONS.forEach(
    (position) => {
      const positionSection =
        document.createElement(
          "section"
        );

      positionSection.className =
        "shift-capacity-position";

      const heading =
        document.createElement(
          "h3"
        );

      heading.textContent =
        position.name;

      positionSection.appendChild(
        heading
      );

      position.shifts?.forEach(
        (shift) => {
          totalShifts += 1;

          const data =
            shiftCapacities.get(
              shift.id
            ) || {
              capacity:
                shift.capacity ||
                0,
              count: 0
            };

          const wrap =
            document.createElement(
              "div"
            );

          wrap.className =
            "slot-capacity-item";

          const label =
            document.createElement(
              "label"
            );

          label.textContent =
            `${formatShiftTime(
              shift
            )} (${data.count || 0} registered)`;

          const input =
            document.createElement(
              "input"
            );

          input.type = "number";
          input.min = String(
            data.count || 0
          );

          input.value = String(
            data.capacity ??
              shift.capacity ??
              0
          );

          const button =
            smallButton(
              "Save",
              async () => {
                const capacity =
                  Math.max(
                    Number(
                      input.value
                    ) || 0,
                    Number(
                      data.count
                    ) || 0
                  );

                await setDoc(
                  doc(
                    db,
                    SHIFT_COUNTS_COLLECTION,
                    shiftDocId(
                      shift.id
                    )
                  ),
                  {
                    eventId:
                      CONFIG.eventId,

                    shiftId:
                      shift.id,

                    positionId:
                      position.id,

                    position:
                      position.name,

                    label:
                      formatShiftTime(
                        shift
                      ),

                    startTime:
                      shift.startTime,

                    endTime:
                      shift.endTime,

                    capacity,

                    count:
                      Number(
                        data.count
                      ) || 0
                  },
                  {
                    merge: true
                  }
                );

                await loadShiftCapacities();

                renderShiftCapacityEditor();
              }
            );

          wrap.append(
            label,
            input,
            button
          );

          positionSection.appendChild(
            wrap
          );
        }
      );

      root.appendChild(
        positionSection
      );
    }
  );

  setText(
    "shift-preview-count",
    `${totalShifts} shifts`
  );

  setText(
    "slot-preview-count",
    `${totalShifts} shifts`
  );
}


function shiftDocId(shiftId) {
  return `${CONFIG.eventId}_${shiftId}`;
}


/* =========================================================
   TABLE
========================================================= */

function setSort(sortKey) {
  if (
    tableState.sortKey ===
    sortKey
  ) {
    tableState.sortDirection =
      tableState.sortDirection ===
      "asc"
        ? "desc"
        : "asc";
  } else {
    tableState.sortKey =
      sortKey;

    tableState.sortDirection =
      "asc";
  }

  tableState.page = 1;

  renderRegistrations();
}


function renderRegistrations() {
  const filtered =
    filteredRecords();

  const sorted =
    [...filtered].sort(
      compareRecords
    );

  const pageCount =
    Math.max(
      1,
      Math.ceil(
        sorted.length /
          tableState.pageSize
      )
    );

  tableState.page =
    Math.min(
      Math.max(
        1,
        tableState.page
      ),
      pageCount
    );

  const start =
    (tableState.page - 1) *
    tableState.pageSize;

  renderTable(
    sorted.slice(
      start,
      start +
        tableState.pageSize
    )
  );

  renderSortIndicators();

  setText(
    "counts",
    `${filtered.length} matching volunteers · ${registrations.length} total overall`
  );

  setText(
    "page-info",
    `Page ${tableState.page} of ${pageCount}`
  );

  setDisabled(
    "prev-page",
    tableState.page <= 1
  );

  setDisabled(
    "next-page",
    tableState.page >=
      pageCount
  );
}


function filteredRecords() {
  const search =
    (
      $("search")?.value ||
      ""
    )
      .trim()
      .toLowerCase();

  const position =
    $("filter-position")
      ?.value || "";

  const shift =
    $("filter-shift")
      ?.value || "";

  const status =
    $("filter-status")
      ?.value || "";

  return registrations.filter(
    (record) => {
      const searchable = [
        record.firstName,
        record.lastName,
        record.name,
        record.email,
        record.phone,
        record.id,
        record.position,
        record.positionName,
        record.shift,
        record.shiftLabel
      ]
        .join(" ")
        .toLowerCase();

      if (
        search &&
        !searchable.includes(
          search
        )
      ) {
        return false;
      }

      if (
        position &&
        record.positionId !==
          position
      ) {
        return false;
      }

      if (
        shift &&
        record.shiftId !== shift
      ) {
        return false;
      }

      if (
        status &&
        record.checkin
          ?.status !== status
      ) {
        return false;
      }

      return true;
    }
  );
}


function compareRecords(a, b) {
  const direction =
    tableState.sortDirection ===
    "asc"
      ? 1
      : -1;

  const sorters = {
    createdAt: (record) =>
      toDate(
        record.createdAt
      )?.getTime() || 0,

    firstName: (record) =>
      (
        record.firstName ||
        ""
      ).toLowerCase(),

    lastName: (record) =>
      (
        record.lastName ||
        ""
      ).toLowerCase(),

    position: (record) =>
      (
        record.positionName ||
        record.position ||
        ""
      ).toLowerCase(),

    shift: (record) =>
      (
        record.shiftLabel ||
        ""
      ).toLowerCase(),

    status: (record) =>
      (
        record.checkin
          ?.status ||
        "registered"
      ).toLowerCase()
  };

  const getValue =
    sorters[
      tableState.sortKey
    ] ||
    sorters.createdAt;

  return String(
    getValue(a)
  ).localeCompare(
    String(getValue(b)),
    undefined,
    {
      numeric: true
    }
  ) * direction;
}


function renderSortIndicators() {
  document
    .querySelectorAll(
      "[data-sort]"
    )
    .forEach((header) => {
      const active =
        header.dataset.sort ===
        tableState.sortKey;

      header.textContent =
        `${header.dataset.label}${
          active
            ? tableState.sortDirection ===
              "asc"
              ? " ↑"
              : " ↓"
            : ""
        }`;
    });
}


/* =========================================================
   VOLUNTEER TABLE
========================================================= */

function renderTable(records) {
  const rows = $("rows");

  if (!rows) return;

  rows.textContent = "";

  if (!records.length) {
    const row =
      document.createElement(
        "tr"
      );

    const cell =
      document.createElement(
        "td"
      );

    cell.colSpan = 13;

    cell.textContent =
      "No volunteers to display.";

    row.appendChild(cell);

    rows.appendChild(row);

    return;
  }

  records.forEach(
    (record) => {
      const row =
        document.createElement(
          "tr"
        );

      [
        record.id,

        formatTimestamp(
          record.createdAt
        ),

        record.firstName,

        record.lastName,

        record.is18OrOlder === true
          ? "Yes (18+)"
          : record.is18OrOlder === false
          ? "No (<18)"
          : "—",

        record.email,

        record.phone,

        positionLabel(
          record.positionId,
          record.positionName ||
            record.position
        ),

        shiftLabel(
          record.shiftId,
          record.shiftLabel
        ),

        operationalLabel(
          record.checkin
            ?.status
        ),

        formatTimestamp(
          record.checkin
            ?.checkedInAt
        ),

        formatTimestamp(
          record.checkin
            ?.checkedOutAt
        )
      ].forEach(
        (value) => {
          const cell =
            document.createElement(
              "td"
            );

          cell.textContent =
            value ?? "";

          row.appendChild(
            cell
          );
        }
      );

      const actions =
        document.createElement(
          "td"
        );

      actions.className =
        "table-actions";

      actions.append(
        smallButton(
          "Edit",
          () =>
            showEditModal(
              record
            )
        ),

        smallButton(
          "Export",
          () =>
            showExportModal(
              [record],
              `${
                record.firstName ||
                "volunteer"
              }-${
                record.lastName ||
                "registration"
              }`
            )
        ),

        smallButton(
          "Delete",
          () =>
            showDeleteModal(
              record
            ),
          "danger-lite"
        )
      );

      row.appendChild(
        actions
      );

      row.addEventListener(
        "click",
        () =>
          showDetail(record)
      );

      actions.addEventListener(
        "click",
        (event) =>
          event.stopPropagation()
      );

      rows.appendChild(
        row
      );
    }
  );
}


/* =========================================================
   EXPORT
========================================================= */

function smallButton(
  label,
  handler,
  className = "secondary"
) {
  const button =
    document.createElement(
      "button"
    );

  button.type = "button";
  button.className =
    `small-button ${className}`;

  button.textContent =
    label;

  button.addEventListener(
    "click",
    handler
  );

  return button;
}


function showExportModal(
  records,
  filenameBase,
  preferredFormat = ""
) {
  const root =
    $("modal-root");

  if (!root) return;

  root.textContent = "";

  const modal =
    modalShell(
      `Export ${records.length} volunteer${
        records.length === 1
          ? ""
          : "s"
      }`
    );

  const body =
    document.createElement(
      "div"
    );

  body.className =
    "modal-actions-stack";

  const csv =
    smallButton(
      "Download CSV",
      () =>
        downloadCsv(
          records,
          filenameBase
        )
    );

  const pdf =
    smallButton(
      "Open printable PDF view",
      () =>
        openPrintableExport(
          records
        )
    );

  body.append(
    csv,
    pdf
  );

  modal.card.appendChild(
    body
  );

  root.appendChild(
    modal.overlay
  );

  if (
    preferredFormat ===
    "csv"
  ) {
    downloadCsv(
      records,
      filenameBase
    );
  }

  if (
    preferredFormat ===
    "pdf"
  ) {
    openPrintableExport(
      records
    );
  }
}


function exportRows(records) {
  return records.map(
    (r) => ({
      confirmationId:
        r.id,

      submitted:
        formatTimestamp(
          r.createdAt
        ),

      firstName:
        r.firstName,

      lastName:
        r.lastName,

      is18OrOlder:
        r.is18OrOlder === true
          ? "Yes (18+)"
          : r.is18OrOlder === false
          ? "No (<18)"
          : "",

      email:
        r.email,

      phone:
        r.phone,

      position:
        positionLabel(
          r.positionId,
          r.positionName ||
            r.position
        ),

      shift:
        shiftLabel(
          r.shiftId,
          r.shiftLabel
        ),

      status:
        operationalLabel(
          r.checkin?.status
        ),

      checkedInAt:
        formatTimestamp(
          r.checkin
            ?.checkedInAt
        ),

      checkedInBy:
        adminName(
          r.checkin
            ?.checkedInBy,
          r.checkin
            ?.checkedInByName
        ),

      checkedOutAt:
        formatTimestamp(
          r.checkin
            ?.checkedOutAt
        ),

      checkedOutBy:
        adminName(
          r.checkin
            ?.checkedOutBy,
          r.checkin
            ?.checkedOutByName
        )
    })
  );
}


function downloadCsv(
  records,
  filenameBase
) {
  const rows =
    exportRows(records);

  const headers =
    Object.keys(
      rows[0] || {
        confirmationId: ""
      }
    );

  const csv = [
    headers.join(","),

    ...rows.map(
      (row) =>
        headers
          .map(
            (h) =>
              `"${String(
                row[h] ?? ""
              ).replace(
                /"/g,
                '""'
              )}"`
          )
          .join(",")
    )
  ].join("\n");

  const a =
    document.createElement(
      "a"
    );

  a.href =
    URL.createObjectURL(
      new Blob(
        [csv],
        {
          type:
            "text/csv"
        }
      )
    );

  a.download =
    `${filenameBase}.csv`;

  a.click();

  URL.revokeObjectURL(
    a.href
  );
}


function openPrintableExport(
  records
) {
  const win =
    window.open(
      "",
      "_blank"
    );

  if (!win) return;

  const rows =
    exportRows(records);

  const style = `
    <style>
      body {
        font-family: Inter, Arial, sans-serif;
        margin: 24px;
        color: #131a24;
      }

      h1 {
        margin: 0 0 6px;
      }

      .muted {
        color: #61707f;
      }

      .card {
        border: 1px solid #dde3ec;
        border-radius: 18px;
        padding: 18px;
        margin: 14px 0;
        background: #f8fafc;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 10px;
      }

      .item {
        background: #fff;
        border: 1px solid #e5eaf1;
        border-radius: 12px;
        padding: 10px;
      }

      .label {
        font-size: 10px;
        text-transform: uppercase;
        color: #61707f;
        font-weight: 700;
      }

      .value {
        font-weight: 650;
        word-break: break-word;
      }

      table {
        border-collapse: collapse;
        width: 100%;
        font-size: 9px;
        table-layout: fixed;
      }

      td,
      th {
        border: 1px solid #ccd5e1;
        padding: 4px;
        word-break: break-word;
        vertical-align: top;
      }

      th {
        background: #eef2f7;
        font-size: 8px;
        text-transform: uppercase;
      }

      @media print {
        @page {
          size: landscape;
          margin: .35in;
        }

        body {
          margin: 0;
        }

        .card {
          break-inside: avoid;
        }
      }
    </style>
  `;

  const body =
    records.length === 1
      ? `
        <section class="card">
          <h1>Volunteer Registration Card</h1>

          <p class="muted">
            ${escapeHtml(
              CONFIG.eventName
            )}
            ·
            ${escapeHtml(
              formatDriveDate(
                CONFIG.eventDate
              )
            )}
          </p>

          <div class="grid">
            ${
              Object.entries(
                rows[0] || {}
              )
                .map(
                  ([k, v]) =>
                    `
                    <div class="item">
                      <div class="label">
                        ${escapeHtml(
                          k
                        )}
                      </div>

                      <div class="value">
                        ${escapeHtml(
                          v
                        )}
                      </div>
                    </div>
                    `
                )
                .join("")
            }
          </div>
        </section>
      `
      : `
        <h1>Volunteer Registration Export</h1>

        <p class="muted">
          ${records.length}
          volunteers ·
          ${escapeHtml(
            CONFIG.eventName
          )}
        </p>

        <table>
          <thead>
            <tr>
              ${
                Object.keys(
                  rows[0] || {}
                )
                  .map(
                    (h) =>
                      `<th>${escapeHtml(
                        h
                      )}</th>`
                  )
                  .join("")
              }
            </tr>
          </thead>

          <tbody>
            ${
              rows
                .map(
                  (row) =>
                    `
                    <tr>
                      ${
                        Object.values(
                          row
                        )
                          .map(
                            (v) =>
                              `<td>${escapeHtml(
                                v
                              )}</td>`
                          )
                          .join("")
                      }
                    </tr>
                    `
                )
                .join("")
            }
          </tbody>
        </table>
      `;

  win.document.write(
    `<title>Volunteer Export</title>${style}${body}`
  );

  win.document.close();

  win.print();
}


/* =========================================================
   EDIT
========================================================= */

function showEditModal(record) {
  const root = $("modal-root");
  if (!root) return;

  root.textContent = "";

  const modal = modalShell(
    `Edit registration for ${
      record.firstName || "this"
    } ${record.lastName || "volunteer"}`
  );

  const form = document.createElement("form");
  form.className = "settings-grid";
  form.style.gridTemplateColumns = "repeat(auto-fit, minmax(260px, 1fr))";

  function fieldWrap(labelHtml, input) {
    const wrap = document.createElement("div");
    wrap.innerHTML = labelHtml;
    wrap.appendChild(input);
    return wrap;
  }

  const firstNameInput = document.createElement("input");
  firstNameInput.type = "text";
  firstNameInput.value = record.firstName || "";
  firstNameInput.placeholder = "First name";
  firstNameInput.required = true;

  const lastNameInput = document.createElement("input");
  lastNameInput.type = "text";
  lastNameInput.value = record.lastName || "";
  lastNameInput.placeholder = "Last name";
  lastNameInput.required = true;

  const emailInput = document.createElement("input");
  emailInput.type = "email";
  emailInput.value = record.email || "";
  emailInput.placeholder = "volunteer@example.com";
  emailInput.required = true;

  const phoneInput = document.createElement("input");
  phoneInput.type = "tel";
  phoneInput.value = record.phone || "";
  phoneInput.placeholder = "(317) 555-0100";
  phoneInput.required = true;

  const is18Row = document.createElement("div");
  is18Row.style.display = "flex";
  is18Row.style.gap = "16px";
  is18Row.style.marginTop = "8px";
  is18Row.style.alignItems = "center";

  const yesRadio = document.createElement("input");
  yesRadio.type = "radio";
  yesRadio.name = "edit-is18OrOlder";
  yesRadio.value = "yes";
  yesRadio.required = true;
  if (record.is18OrOlder === true) yesRadio.checked = true;
  const yesLabel = document.createElement("label");
  yesLabel.style.display = "inline-flex";
  yesLabel.style.alignItems = "center";
  yesLabel.style.gap = "6px";
  yesLabel.style.cursor = "pointer";
  yesLabel.style.fontWeight = "500";
  yesLabel.appendChild(yesRadio);
  const yesSpan = document.createElement("span");
  yesSpan.textContent = "Yes (18+)";
  yesLabel.appendChild(yesSpan);

  const noRadio = document.createElement("input");
  noRadio.type = "radio";
  noRadio.name = "edit-is18OrOlder";
  noRadio.value = "no";
  noRadio.required = true;
  if (record.is18OrOlder === false) noRadio.checked = true;
  const noLabel = document.createElement("label");
  noLabel.style.display = "inline-flex";
  noLabel.style.alignItems = "center";
  noLabel.style.gap = "6px";
  noLabel.style.cursor = "pointer";
  noLabel.style.fontWeight = "500";
  noLabel.appendChild(noRadio);
  const noSpan = document.createElement("span");
  noSpan.textContent = "No (<18)";
  noLabel.appendChild(noSpan);

  is18Row.append(yesLabel, noLabel);

  const notesInput = document.createElement("input");
  notesInput.type = "text";
  notesInput.value = record.notes || "";
  notesInput.placeholder = "Special skills, requests, or organizer notes";

  const error = document.createElement("p");
  error.className = "error";

  const confirmBtn = smallButton(
    "Save Changes",
    async () => {
      const newFirstName = firstNameInput.value.trim();
      const newLastName = lastNameInput.value.trim();
      const newEmail = emailInput.value.trim();
      const newPhone = phoneInput.value.trim();
      const newNotes = notesInput.value.trim();
      const is18Raw = form.querySelector('input[name="edit-is18OrOlder"]:checked')?.value;
      const newIs18OrOlder = is18Raw === "yes" ? true : is18Raw === "no" ? false : null;

      if (!newFirstName || !newLastName || !newEmail || !newPhone || newIs18OrOlder === null) {
        error.textContent = "All fields are required. Please complete the form.";
        return;
      }

      try {
        await runTransaction(db, async (tx) => {
          const regRef = doc(db, REGISTRATIONS_COLLECTION, record.id);
          tx.update(regRef, {
            firstName: newFirstName,
            lastName: newLastName,
            email: newEmail,
            phone: newPhone,
            is18OrOlder: newIs18OrOlder,
            notes: newNotes,
          });

          if (record.email && newEmail.toLowerCase().trim() !== record.email.toLowerCase().trim()) {
            const oldKey = `email_${encodeURIComponent(String(record.email).toLowerCase().trim())}`;
            const newKey = `email_${encodeURIComponent(String(newEmail).toLowerCase().trim())}`;
            tx.delete(doc(db, "registrationGuards", oldKey));
            tx.set(doc(db, "registrationGuards", newKey), {
              registrationId: record.id,
              createdAt: serverTimestamp(),
            });
          }
        });

        const idx = registrations.findIndex((r) => r.id === record.id);
        if (idx >= 0) {
          registrations[idx] = {
            ...registrations[idx],
            firstName: newFirstName,
            lastName: newLastName,
            email: newEmail,
            phone: newPhone,
            is18OrOlder: newIs18OrOlder,
            notes: newNotes,
          };
        }

        root.textContent = "";
        renderRegistrations();
      } catch (editError) {
        console.error("[Admin] Edit failed:", editError);
        error.textContent = "Update failed. Please try again or check the console.";
      }
    },
    "primary"
  );

  form.append(
    fieldWrap("<label>First Name <span class='req'>*</span></label>", firstNameInput),
    fieldWrap("<label>Last Name <span class='req'>*</span></label>", lastNameInput),
    fieldWrap("<label>Email Address <span class='req'>*</span></label>", emailInput),
    fieldWrap("<label>Phone Number <span class='req'>*</span></label>", phoneInput),
    fieldWrap("<label>18 or Older? <span class='req'>*</span></label>", is18Row),
    (() => {
      const wrap = document.createElement("div");
      wrap.style.gridColumn = "1 / -1";
      const label = document.createElement("label");
      label.htmlFor = "edit-notes";
      label.textContent = "Notes (Optional)";
      wrap.appendChild(label);
      wrap.appendChild(notesInput);
      return wrap;
    })(),
    (() => {
      const wrap = document.createElement("div");
      wrap.style.gridColumn = "1 / -1";
      wrap.style.marginTop = "8px";
      wrap.appendChild(error);
      wrap.appendChild(confirmBtn);
      return wrap;
    })()
  );

  modal.card.appendChild(form);

  root.appendChild(modal.overlay);
}


/* =========================================================
   DELETE
========================================================= */

function showDeleteModal(record) {
  const root =
    $("modal-root");

  if (!root) return;

  root.textContent = "";

  const modal =
    modalShell(
      `Delete ${
        record.firstName ||
        "this"
      } ${
        record.lastName ||
        "volunteer"
      } registration?`
    );

  const reason =
    document.createElement(
      "select"
    );

  [
    [
      "",
      "Select a required reason"
    ],

    [
      "volunteer_cancelled",
      "Volunteer cancelled"
    ],

    [
      "duplicate",
      "Duplicate registration"
    ],

    [
      "testing",
      "Just for testing"
    ],

    [
      "other",
      "Other"
    ]
  ].forEach(
    ([v, l]) =>
      reason.append(
        new Option(
          l,
          v
        )
      )
  );

  const other =
    document.createElement(
      "textarea"
    );

  other.placeholder =
    "Required when Other is selected";

  other.className =
    "hidden";

  const error =
    document.createElement(
      "p"
    );

  error.className =
    "error";

  const confirm =
    smallButton(
      "Delete from Firebase",
      async () => {
        if (
          !reason.value ||
          (
            reason.value ===
              "other" &&
            !other.value.trim()
          )
        ) {
          error.textContent =
            "Choose a reason. If you select Other, add a written explanation.";

          return;
        }

        try {
          // --- 1. Write the deletion audit log (outside transaction so it
          //        always persists even if the transaction retries or fails).
          await setDoc(
            doc(
              collection(
                db,
                "registrationDeletionLogs"
              )
            ),
            {
              registrationId:
                record.id,

              shiftId:
                record.shiftId,

              reason:
                reason.value,

              otherReason:
                other.value.trim(),

              deletedAt:
                serverTimestamp()
            }
          );

          // --- 2. Atomically restore shift capacity and delete the
          //        registration in a single transaction.
          await runTransaction(
            db,
            async (tx) => {
              const regRef = doc(
                db,
                REGISTRATIONS_COLLECTION,
                record.id
              );

              const regSnap =
                await tx.get(regRef);

              if (!regSnap.exists()) {
                // Already deleted — nothing to do.
                return;
              }

              // Restore capacity if a shiftId is known.
              if (record.shiftId) {
                const countRef = doc(
                  db,
                  SHIFT_COUNTS_COLLECTION,
                  shiftDocId(record.shiftId)
                );

                const countSnap =
                  await tx.get(countRef);

                if (countSnap.exists()) {
                  const currentCount =
                    Number(countSnap.data().count) || 0;

                  tx.update(countRef, {
                    count: Math.max(0, currentCount - 1)
                  });
                }
              }

              // Delete the registration.
              tx.delete(regRef);
            }
          );

          // --- 3. Best-effort cleanup of ancillary docs (outside
          //        transaction — these are not capacity-critical).
          await deleteDoc(
            doc(
              db,
              CHECKINS_COLLECTION,
              record.id
            )
          ).catch(() => {});

          // Remove email and name+phone guards so the volunteer can
          // re-register if this was an error.
          if (record.email) {
            const emailKey =
              `email_${encodeURIComponent(
                String(record.email).toLowerCase().trim()
              )}`;

            await deleteDoc(
              doc(db, "registrationGuards", emailKey)
            ).catch(() => {});
          }

          const normLast =
            record.normalizedLastName ||
            normalizeLastName(record.lastName);

          const normPhone =
            record.normalizedPhone ||
            normalizePhoneNumber(record.phone);

          if (normLast && normPhone) {
            const namePhoneKey =
              `name_phone_${normLast}_${normPhone}`;

            await deleteDoc(
              doc(db, "registrationGuards", namePhoneKey)
            ).catch(() => {});
          }

          // --- 4. Update local state and re-render.
          registrations =
            registrations.filter(
              (r) =>
                r.id !==
                record.id
            );

          // Refresh shift capacities so the UI reflects the restored slot.
          await loadShiftCapacities();

          root.textContent = "";

          renderRegistrations();

        } catch (deleteError) {
          console.error(
            "[Admin] Registration deletion failed:",
            deleteError
          );

          error.textContent =
            "Deletion failed. Please try again or check the console.";
        }
      },
      "danger"
    );

  reason.addEventListener(
    "input",
    () =>
      other.classList.toggle(
        "hidden",
        reason.value !==
          "other"
      )
  );

  modal.card.append(
    detailSection(
      "Required deletion reason",
      [
        [
          "Volunteer",
          `${
            record.firstName ||
            ""
          } ${
            record.lastName ||
            ""
          }`.trim()
        ],

        [
          "Position",
          positionLabel(
            record.positionId,
            record.positionName ||
              record.position
          )
        ],

        [
          "Shift",
          shiftLabel(
            record.shiftId,
            record.shiftLabel
          )
        ],

        [
          "Confirmation ID",
          record.id
        ]
      ]
    ),

    reason,
    other,
    error,
    confirm
  );

  root.appendChild(
    modal.overlay
  );
}


/* =========================================================
   MODALS / DETAILS
========================================================= */

function modalShell(
  titleText
) {
  const overlay =
    document.createElement(
      "div"
    );

  overlay.className =
    "modal";

  const card =
    document.createElement(
      "div"
    );

  card.className =
    "modal-card";

  const header =
    document.createElement(
      "div"
    );

  header.className =
    "summary-line";

  const title =
    document.createElement(
      "h2"
    );

  title.textContent =
    titleText;

  const close =
    smallButton(
      "Close",
      () => {
        const root =
          $("modal-root");

        if (root) {
          root.textContent =
            "";
        }
      }
    );

  header.append(
    title,
    close
  );

  card.appendChild(
    header
  );

  overlay.appendChild(
    card
  );

  overlay.addEventListener(
    "click",
    (event) => {
      if (
        event.target ===
        overlay
      ) {
        overlay.remove();
      }
    }
  );

  return {
    overlay,
    card
  };
}


function showDetail(record) {
  const root =
    $("modal-root");

  if (!root) return;

  root.textContent = "";

  const modal =
    document.createElement(
      "div"
    );

  modal.className =
    "modal";

  const card =
    document.createElement(
      "div"
    );

  card.className =
    "modal-card";

  const header =
    document.createElement(
      "div"
    );

  header.className =
    "summary-line";

  const title =
    document.createElement(
      "h2"
    );

  title.textContent =
    `${record.firstName || ""} ${
      record.lastName || ""
    }`.trim() ||
    "Volunteer detail";

  const close =
    document.createElement(
      "button"
    );

  close.className =
    "secondary";

  close.type = "button";

  close.textContent =
    "Close";

  header.append(
    title,
    close
  );

  card.append(
    header,

    detailSection(
      "Registration",
      [
        [
          "Confirmation ID",
          record.id
        ],

        [
          "Date submitted",
          formatTimestamp(
            record.createdAt
          )
        ],

        [
          "Event",
          CONFIG.eventName
        ],

        [
          "Event date",
          formatDriveDate(
            record.eventDate ||
              CONFIG.eventDate
          )
        ],

        [
          "Location",
          record.location ||
            CONFIG.location
        ]
      ]
    ),

    detailSection(
      "Volunteer",
      [
        [
          "First name",
          record.firstName
        ],

        [
          "Last name",
          record.lastName
        ],

        [
          "18 or older",
          record.is18OrOlder === true
            ? "Yes (18 or older)"
            : record.is18OrOlder === false
            ? "No (Under 18)"
            : "Not specified"
        ],

        [
          "Email",
          record.email
        ],

        [
          "Phone",
          record.phone
        ]
      ]
    ),

    detailSection(
      "Assignment",
      [
        [
          "Position",
          positionLabel(
            record.positionId,
            record.positionName ||
              record.position
          )
        ],

        [
          "Shift",
          shiftLabel(
            record.shiftId,
            record.shiftLabel
          )
        ],

        [
          "Shift start",
          shiftStartLabel(
            record.shiftId,
            record.shiftStart
          )
        ],

        [
          "Shift end",
          shiftEndLabel(
            record.shiftId,
            record.shiftEnd
          )
        ]
      ]
    ),

    detailSection(
      "Check-in operations",
      [
        [
          "Operational status",
          operationalLabel(
            record.checkin
              ?.status
          )
        ],

        [
          "Checked in",
          formatTimestamp(
            record.checkin
              ?.checkedInAt
          )
        ],

        [
          "Checked in by",
          adminName(
            record.checkin
              ?.checkedInBy,
            record.checkin
              ?.checkedInByName
          )
        ],

        [
          "Checked out",
          formatTimestamp(
            record.checkin
              ?.checkedOutAt
          )
        ],

        [
          "Checked out by",
          adminName(
            record.checkin
              ?.checkedOutBy,
            record.checkin
              ?.checkedOutByName
          )
        ]
      ]
    )
  );

  modal.appendChild(
    card
  );

  root.appendChild(
    modal
  );

  close.addEventListener(
    "click",
    () => {
      root.textContent =
        "";
    }
  );

  modal.addEventListener(
    "click",
    (event) => {
      if (
        event.target ===
        modal
      ) {
        root.textContent =
          "";
      }
    }
  );
}


function detailSection(
  title,
  items
) {
  const section =
    document.createElement(
      "section"
    );

  section.className =
    "detail-section";

  const heading =
    document.createElement(
      "h3"
    );

  heading.textContent =
    title;

  const grid =
    document.createElement(
      "div"
    );

  grid.className =
    "detail-grid";

  items.forEach(
    ([label, value]) => {
      const item =
        document.createElement(
          "div"
        );

      item.className =
        "detail-item";

      item.innerHTML =
        `<div class="detail-label"></div>
         <div class="detail-value"></div>`;

      item.querySelector(
        ".detail-label"
      ).textContent =
        label;

      item.querySelector(
        ".detail-value"
      ).textContent =
        value ??
        "Not provided";

      grid.appendChild(
        item
      );
    }
  );

  section.append(
    heading,
    grid
  );

  return section;
}


/* =========================================================
   CHECK-IN
========================================================= */

async function loadCheckinsMap() {
  const snap =
    await getDocs(
      collection(
        db,
        CHECKINS_COLLECTION
      )
    );

  return new Map(
    snap.docs.map(
      (d) => [
        d.id,
        serialize({
          id: d.id,
          ...d.data()
        })
      ]
    )
  );
}


async function initCheckinPage(
  user,
  profile
) {
  const actorName =
    adminDisplayName(
      profile,
      user
    );

  const search =
    $("checkin-search");

  const results =
    $("checkin-results");

  const summary =
    $("checkin-summary");

  let regs = [];

  let checkins =
    new Map();

  try {
    await loadAdminDirectory();

    const snap =
      await getDocs(
        query(
          collection(
            db,
            REGISTRATIONS_COLLECTION
          ),
          orderBy(
            "createdAt",
            "desc"
          )
        )
      );

    regs =
      snap.docs.map(
        (d) =>
          serialize({
            id: d.id,
            ...d.data()
          })
      );

    setText(
      "checkin-status",
      "Start typing to find a volunteer."
    );

  } catch {
    showError(
      "Could not load volunteers for check-in."
    );
  }

  onSnapshot(
    collection(
      db,
      CHECKINS_COLLECTION
    ),

    (snap) => {
      checkins =
        new Map(
          snap.docs.map(
            (d) => [
              d.id,
              serialize({
                id: d.id,
                ...d.data()
              })
            ]
          )
        );

      markLateRegistrations(
        regs,
        checkins,
        user.uid,
        actorName
      );

      renderOperationsDashboard(
        summary,
        regs,
        checkins,
        user
      );

      renderCheckinResults(
        search?.value || "",
        regs,
        checkins,
        results,
        user
      );
    },

    () =>
      showError(
        "Could not subscribe to check-in updates."
      )
  );

  search?.addEventListener(
    "input",
    () =>
      renderCheckinResults(
        search.value,
        regs,
        checkins,
        results,
        user
      )
  );

  setInterval(
    () => {
      markLateRegistrations(
        regs,
        checkins,
        user.uid,
        actorName
      );

      renderOperationsDashboard(
        summary,
        regs,
        checkins,
        user
      );
    },
    30000
  );

  // Wire up the activity feed that lives in the same page layout.
  initActivityPage();
}


function allShifts() {
  return VOLUNTEER_POSITIONS.flatMap(
    (position) =>
      (position.shifts || []).map(
        (shift) => ({
          ...shift,
          positionId:
            position.id,
          positionName:
            position.name
        })
      )
  );
}


function timeParts(date) {
  const parts =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          EVENT_TIME_ZONE,

        hour: "2-digit",

        minute: "2-digit",

        hour12: false
      }
    ).formatToParts(
      date
    );

  return {
    hour: Number(
      parts.find(
        (p) =>
          p.type ===
          "hour"
      )?.value || 0
    ),

    minute: Number(
      parts.find(
        (p) =>
          p.type ===
          "minute"
      )?.value || 0
    )
  };
}


function shiftMinutes(value) {
  if (
    typeof value ===
    "number"
  ) {
    return value;
  }

  const text =
    String(
      value || ""
    );

  if (
    text.includes(":")
  ) {
    const [
      hour,
      minute
    ] =
      text
        .split(":")
        .map(Number);

    return (
      hour * 60 +
      minute
    );
  }

  return (
    Number(
      text.slice(0, 2)
    ) *
      60 +
    Number(
      text.slice(2)
    )
  );
}


async function markLateRegistrations(
  regs,
  checkins,
  uid,
  actorName
) {
  const now =
    new Date();

  const eventDate =
    CONFIG.eventDate;

  const today =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone:
          EVENT_TIME_ZONE,

        year: "numeric",

        month: "2-digit",

        day: "2-digit"
      }
    ).format(now);

  if (
    today !== eventDate
  ) {
    return;
  }

  const currentMinutes =
    timeParts(
      now
    ).hour *
      60 +
    timeParts(
      now
    ).minute;

  const late =
    regs
      .filter(
        (r) => {
          const shift =
            getShiftById(
              r.shiftId
            );

          if (!shift)
            return false;

          const status =
            checkins.get(
              r.id
            )?.status;

          if (
            [
              "checked_in",
              "completed"
            ].includes(
              status
            )
          ) {
            return false;
          }

          return (
            shiftMinutes(
              shift.endTime
            ) <
            currentMinutes
          );
        }
      )
      .slice(0, 20);

  await Promise.all(
    late.map(
      (r) =>
        setDoc(
          doc(
            db,
            CHECKINS_COLLECTION,
            r.id
          ),
          {
            registrationId:
              r.id,

            status:
              "late",

            lateAt:
              serverTimestamp(),

            updatedAt:
              serverTimestamp(),

            updatedBy:
              uid,

            updatedByName:
              actorName
          },
          {
            merge: true
          }
        )
          .then(
            () =>
              setDoc(
                doc(
                  collection(
                    db,
                    CHECKIN_ACTIVITY_COLLECTION
                  )
                ),
                {
                  registrationId:
                    r.id,

                  action:
                    "late",

                  actorUid:
                    uid,

                  actorName,

                  occurredAt:
                    serverTimestamp()
                }
              )
          )
          .catch(
            () => {}
          )
    )
  );
}


function isLateArrival(
  record
) {
  const checked =
    toDate(
      record.checkin
        ?.checkedInAt
    );

  if (
    !checked ||
    !record.shiftId
  ) {
    return false;
  }

  const shift =
    getShiftById(
      record.shiftId
    );

  if (!shift) {
    return false;
  }

  const p =
    timeParts(
      checked
    );

  const actual =
    p.hour * 60 +
    p.minute;

  const start =
    shiftMinutes(
      shift.startTime
    );

  const end =
    shiftMinutes(
      shift.endTime
    );

  return (
    actual < start ||
    actual >= end
  );
}


/* =========================================================
   CHECK-IN SEARCH / CARDS
========================================================= */

function renderCheckinResults(
  term,
  regs,
  checkins,
  root,
  user
) {
  if (!root) return;

  const q =
    normalizeSearch(
      term
    );

  root.textContent = "";

  if (
    q.length < 2
  ) {
    return;
  }

  const matches =
    regs
      .filter(
        (r) =>
          normalizeSearch(
            [
              r.firstName,
              r.lastName,
              `${r.firstName || ""} ${
                r.lastName || ""
              }`,
              r.email,
              r.phone,
              r.id,
              r.positionName ||
                r.position,
              r.shiftLabel
            ].join(" ")
          ).includes(q)
      )
      .slice(0, 25);

  setText(
    "checkin-status",
    `${matches.length} matching result${
      matches.length === 1
        ? ""
        : "s"
    }`
  );

  matches.forEach(
    (r) =>
      root.appendChild(
        checkinCard(
          {
            ...r,
            checkin:
              checkins.get(
                r.id
              ) || {
                status:
                  "registered"
              }
          },
          user
        )
      )
  );
}


function checkinCard(
  record,
  user
) {
  const card =
    document.createElement(
      "article"
    );

  card.className =
    "checkin-card";

  const status =
    record.checkin
      ?.status ||
    "registered";

  card.innerHTML =
    `
      <div>
        <h2></h2>
        <p></p>
        <p></p>
      </div>

      <div class="checkin-actions"></div>
    `;

  card.querySelector(
    "h2"
  ).textContent =
    `${record.firstName || ""} ${
      record.lastName || ""
    }`.trim() ||
    "Unnamed volunteer";

  card.querySelectorAll(
    "p"
  )[0].textContent =
    `${positionLabel(
      record.positionId,
      record.positionName ||
        record.position
    )} · ${shiftLabel(
      record.shiftId,
      record.shiftLabel
    )}`;

  card.querySelectorAll(
    "p"
  )[1].textContent =
    `${operationalLabel(
      status
    )}${
      record.checkin
        ?.checkedInAt
        ? ` · Checked in ${timeOnly(
            record.checkin
              .checkedInAt
          )}`
        : ""
    }${
      isLateArrival(
        record
      )
        ? " · Late"
        : ""
    }`;

  const actions =
    card.querySelector(
      ".checkin-actions"
    );

  if (
    status ===
      "registered" ||
    status === "late"
  ) {
    actions.append(
      actionButton(
        status === "late"
          ? "CHECK IN LATE"
          : "CHECK IN",

        () =>
          transitionCheckin(
            record.id,
            "checkin",
            user.uid,
            adminDisplayName(
              null,
              user
            )
          )
      )
    );

  } else if (
    status ===
    "checked_in"
  ) {
    actions.append(
      actionButton(
        "CHECK OUT",

        () =>
          transitionCheckin(
            record.id,
            "checkout",
            user.uid,
            adminDisplayName(
              null,
              user
            )
          )
      )
    );

  } else {
    const completed =
      document.createElement(
        "strong"
      );

    completed.textContent =
      "Completed";

    actions.append(
      completed
    );
  }

  return card;
}


function actionButton(
  label,
  handler
) {
  const b =
    document.createElement(
      "button"
    );

  b.className =
    "primary big-action";

  b.type = "button";

  b.textContent =
    label;

  b.addEventListener(
    "click",
    handler
  );

  return b;
}


/* =========================================================
   CHECK-IN TRANSACTIONS
========================================================= */

async function transitionCheckin(
  id,
  action,
  uid,
  actorName
) {
  try {
    await runTransaction(
      db,
      async (tx) => {
        const ref =
          doc(
            db,
            CHECKINS_COLLECTION,
            id
          );

        const snap =
          await tx.get(ref);

        const current =
          snap.exists()
            ? snap.data()
                .status
            : "registered";

        if (
          action ===
            "checkin" &&
          ![
            "registered",
            "late"
          ].includes(
            current
          )
        ) {
          throw new Error(
            "already-updated"
          );
        }

        if (
          action ===
            "checkout" &&
          current !==
            "checked_in"
        ) {
          throw new Error(
            "already-updated"
          );
        }

        const base = {
          registrationId:
            id,

          updatedAt:
            serverTimestamp(),

          updatedBy:
            uid,

          updatedByName:
            actorName
        };

        const activityRef =
          doc(
            collection(
              db,
              CHECKIN_ACTIVITY_COLLECTION
            )
          );

        if (
          action ===
          "checkin"
        ) {
          tx.set(
            ref,
            {
              ...base,

              status:
                "checked_in",

              checkedInAt:
                serverTimestamp(),

              checkedInBy:
                uid,

              checkedInByName:
                actorName
            },
            {
              merge: true
            }
          );

          tx.set(
            activityRef,
            {
              registrationId:
                id,

              action:
                "checkin",

              actorUid:
                uid,

              actorName,

              occurredAt:
                serverTimestamp()
            }
          );

        } else {
          tx.set(
            ref,
            {
              ...base,

              status:
                "completed",

              checkedOutAt:
                serverTimestamp(),

              checkedOutBy:
                uid,

              checkedOutByName:
                actorName
            },
            {
              merge: true
            }
          );

          tx.set(
            activityRef,
            {
              registrationId:
                id,

              action:
                "checkout",

              actorUid:
                uid,

              actorName,

              occurredAt:
                serverTimestamp()
            }
          );
        }
      }
    );

    setText(
      "checkin-message",
      action ===
        "checkin"
        ? "Volunteer checked in."
        : "Volunteer checked out."
    );

  } catch {
    setText(
      "checkin-message",
      "Another staff member already updated this volunteer. The live status has refreshed."
    );
  }
}


/* =========================================================
   OPERATIONS STATISTICS
========================================================= */

function mergedRecords(
  regs,
  checkins
) {
  return regs.map(
    (r) => ({
      ...r,
      checkin:
        checkins.get(
          r.id
        ) || {
          status:
            "registered"
        }
    })
  );
}


function computeOpsStats(
  regs,
  checkins
) {
  const records =
    mergedRecords(
      regs,
      checkins
    );

  const counts = {
    expected:
      records.length,

    checkedIn: 0,

    checkedOut: 0,

    notArrived: 0,

    late: 0
  };

  for (
    const r of records
  ) {
    const status =
      r.checkin
        ?.status;

    if (
      status ===
      "checked_in"
    ) {
      counts.checkedIn += 1;
    }

    if (
      status ===
      "completed"
    ) {
      counts.checkedOut += 1;
    }

    if (
      status ===
      "late"
    ) {
      counts.late += 1;
    }
  }

  counts.notArrived =
    Math.max(
      0,
      counts.expected -
        counts.checkedIn -
        counts.checkedOut
    );

  counts.rates = {
    checkin:
      percent(
        counts.checkedIn,
        counts.expected
      ),

    checkout:
      percent(
        counts.checkedOut,
        counts.expected
      ),

    notArrived:
      percent(
        counts.notArrived,
        counts.expected
      )
  };

  return counts;
}


function shiftStats(
  shiftId,
  regs,
  checkins
) {
  const shiftRegs =
    regs.filter(
      (r) =>
        r.shiftId ===
        shiftId
    );

  return computeOpsStats(
    shiftRegs,
    checkins
  );
}


function renderOperationsDashboard(
  root,
  regs,
  checkins
) {
  if (!root) return;

  const stats =
    computeOpsStats(
      regs,
      checkins
    );

  root.textContent = "";

  const title =
    document.createElement(
      "h2"
    );

  title.textContent =
    "Today's volunteer stats";

  const list =
    document.createElement(
      "div"
    );

  list.className =
    "checkin-stat-list";

  [
    [
      "Not checked in",
      stats.notArrived
    ],

    [
      "Checked in",
      stats.checkedIn
    ],

    [
      "Checked out",
      stats.checkedOut
    ],

    [
      "Late",
      stats.late
    ],

    [
      "Expected",
      stats.expected
    ]
  ].forEach(
    ([label, value]) => {
      const row =
        document.createElement(
          "div"
        );

      row.className =
        "checkin-stat-row";

      const labelEl =
        document.createElement(
          "span"
        );

      labelEl.textContent =
        label;

      const valueEl =
        document.createElement(
          "b"
        );

      valueEl.textContent =
        String(value);

      row.append(
        labelEl,
        valueEl
      );

      list.appendChild(
        row
      );
    }
  );

  root.append(
    title,
    list
  );
}


/* =========================================================
   ACTIVITY
========================================================= */

async function initActivityPage() {
  const type =
    $("activity-type");

  const staff =
    $("activity-staff");

  const rows =
    $("activity-list");

  let items = [];

  let names =
    new Map();

  try {
    await loadAdminDirectory();

    const regs =
      await getDocs(
        collection(
          db,
          REGISTRATIONS_COLLECTION
        )
      );

    names =
      new Map(
        regs.docs.map(
          (d) => [
            d.id,
            `${d.data().firstName || ""} ${
              d.data().lastName || ""
            }`.trim() ||
              d.id
          ]
        )
      );

    fillAdminFilter(
      staff
    );

  } catch {}

  onSnapshot(
    query(
      collection(
        db,
        CHECKIN_ACTIVITY_COLLECTION
      ),
      orderBy(
        "occurredAt",
        "desc"
      ),
      limit(200)
    ),

    (snap) => {
      items =
        snap.docs.map(
          (d) =>
            serialize({
              id: d.id,
              ...d.data()
            })
        );

      renderActivity(
        items,
        names,
        type?.value || "",
        staff?.value || "",
        rows
      );
    }
  );

  [type, staff].forEach(
    (el) =>
      el?.addEventListener(
        "input",
        () =>
          renderActivity(
            items,
            names,
            type?.value || "",
            staff?.value || "",
            rows
          )
      )
  );
}


function fillAdminFilter(
  select
) {
  if (!select) return;

  select.textContent = "";

  select.append(
    new Option(
      "All admins",
      ""
    )
  );

  [
    ...adminDirectory.entries()
  ]
    .sort(
      (a, b) =>
        a[1].localeCompare(
          b[1]
        )
    )
    .forEach(
      ([uid, name]) =>
        select.append(
          new Option(
            name,
            uid
          )
        )
    );
}


function renderActivity(
  items,
  names,
  type,
  staff,
  root
) {
  if (!root) return;

  root.textContent = "";

  const filtered =
    items.filter(
      (i) =>
        (!type ||
          i.action ===
            type) &&
        (!staff ||
          i.actorUid ===
            staff)
    );

  if (!filtered.length) {
    const empty =
      document.createElement(
        "p"
      );

    empty.className =
      "muted";

    empty.textContent =
      "No activity matches these filters.";

    root.appendChild(
      empty
    );

    return;
  }

  filtered.forEach(
    (i) => {
      const div =
        document.createElement(
          "article"
        );

      div.className =
        "activity-card";

      const actionLabels = {
        checkin:
          "Checked in",

        checkout:
          "Checked out",

        late:
          "Marked late"
      };

      const action =
        actionLabels[
          i.action
        ] ||
        i.action ||
        "Updated";

      div.innerHTML =
        `
          <div>
            <strong></strong>
            <p></p>
          </div>

          <time></time>
        `;

      div.querySelector(
        "strong"
      ).textContent =
        `${action}: ${
          names.get(
            i.registrationId
          ) ||
          i.registrationId
        }`;

      div.querySelector(
        "p"
      ).textContent =
        `By ${
          adminName(
            i.actorUid,
            i.actorName
          ) ||
          "Unknown admin"
        }`;

      div.querySelector(
        "time"
      ).textContent =
        formatTimestampWithSeconds(
          i.occurredAt
        );

      root.appendChild(
        div
      );
    }
  );
}


/* =========================================================
   STATISTICS
========================================================= */

async function initStatisticsPage() {
  const stats =
    $("stats");

  if (stats) {
    stats.innerHTML =
      '<section class="panel"><p>Loading statistics…</p></section>';
  }

  registrations =
    await loadRegistrations();

  bindStatsTabs();

  renderStats(
    registrations
  );

  $("generate-report")?.addEventListener(
    "click",
    () =>
      openVolunteerReport(
        registrations
      )
  );
}


function bindStatsTabs() {
  document
    .querySelectorAll(
      "[data-stats-tab]"
    )
    .forEach((button) => {
      button.addEventListener(
        "click",
        () => {
          activeStatsTab =
            button.dataset
              .statsTab ||
            "registration";

          document
            .querySelectorAll(
              "[data-stats-tab]"
            )
            .forEach(
              (tab) =>
                tab.classList.toggle(
                  "active",
                  tab ===
                    button
                )
            );

          renderStats(
            registrations
          );
        }
      );
    });
}


function renderStats(
  records
) {
  const stats =
    $("stats");

  if (!stats) return;

  const total =
    records.length;

  const all =
    allShifts();

  const capacity =
    all.reduce(
      (sum, shift) =>
        sum +
        Number(
          shiftCapacities.get(
            shift.id
          )?.capacity ??
            shift.capacity ??
            0
        ),
      0
    );

  const byShift =
    Object.fromEntries(
      all.map(
        (shift) => [
          shift.id,
          0
        ]
      )
    );

  const byPosition =
    Object.fromEntries(
      VOLUNTEER_POSITIONS.map(
        (position) => [
          position.id,
          0
        ]
      )
    );

  const byDate =
    dateRange(
      REGISTRATION_START,
      EVENT_DATE
    ).map(
      (date) => ({
        date,
        count: 0
      })
    );

  const byDateMap =
    Object.fromEntries(
      byDate.map(
        (entry) => [
          isoDate(
            entry.date
          ),
          entry
        ]
      )
    );

  records.forEach(
    (record) => {
      if (
        byShift[
          record.shiftId
        ] != null
      ) {
        byShift[
          record.shiftId
        ] += 1;
      }

      if (
        byPosition[
          record.positionId
        ] != null
      ) {
        byPosition[
          record.positionId
        ] += 1;
      }

      const submitted =
        toDate(
          record.createdAt
        );

      if (
        submitted &&
        byDateMap[
          isoDate(
            submitted
          )
        ]
      ) {
        byDateMap[
          isoDate(
            submitted
          )
        ].count += 1;
      }
    }
  );

  const todayCount =
    countSince(
      records,
      startOfDay(
        new Date()
      ),
      addDays(
        startOfDay(
          new Date()
        ),
        1
      )
    );

  const weekCount =
    countSince(
      records,
      addDays(
        startOfDay(
          new Date()
        ),
        -6
      ),
      addDays(
        startOfDay(
          new Date()
        ),
        1
      )
    );

  const highestDay =
    byDate.reduce(
      (best, entry) =>
        entry.count >
        best.count
          ? entry
          : best,
      byDate[0] || {
        date: EVENT_DATE,
        count: 0
      }
    );

  const average =
    byDate.length
      ? (
          total /
          byDate.length
        ).toFixed(1)
      : "0";

  const shiftCounts =
    all.map(
      (shift) => ({
        ...shift,

        count:
          byShift[
            shift.id
          ] || 0,

        capacity:
          Number(
            shiftCapacities.get(
              shift.id
            )?.capacity ??
              shift.capacity ??
              0
          )
      })
    );

  const positionRows =
    VOLUNTEER_POSITIONS
      .map(
        (position) => ({
          ...position,

          count:
            byPosition[
              position.id
            ] || 0
        })
      )
      .sort(
        (a, b) =>
          b.count -
          a.count
      );

  stats.textContent = "";

  if (
    activeStatsTab ===
    "dayof"
  ) {
    const checkins =
      new Map(
        records.map(
          (r) => [
            r.id,
            r.checkin || {
              status:
                "registered"
            }
          ]
        )
      );

    stats.append(
      dayOfOverview(
        records
      ),

      dayOfStatsPanel(
        records
      ),

      shiftOverview(
        records,
        checkins
      )
    );

    return;
  }

  stats.append(
    statGrid([
      [
        "Total volunteers",
        total
      ],

      [
        "Registrations today",
        todayCount
      ],

      [
        "Registrations this week",
        weekCount
      ],

      [
        "Remaining capacity",
        Math.max(
          0,
          capacity -
            total
        )
      ]
    ]),

    chartPanel(
      "Registrations over time",
      "Daily volunteer registrations through the event date.",

      byDate.map(
        (entry) => ({
          label:
            shortDate(
              entry.date
            ),

          value:
            entry.count
        })
      ),

      [
        `Total volunteers — ${total}`,

        `Average registrations per day — ${average}`,

        `Highest-registration day — ${shortDate(
          highestDay.date
        )} (${highestDay.count})`
      ]
    ),

    chartPanel(
      "Shift analytics",
      "Volunteer capacity filled for each event shift.",

      shiftCounts.map(
        (shift) => ({
          label:
            `${shift.positionName} — ${formatShiftTime(
              shift
            )}`,

          value:
            shift.count,

          max:
            shift.capacity
        })
      ),

      shiftRows(
        shiftCounts
      ),

      {
        listClass:
          "appointment-list"
      }
    ),

    chartPanel(
      "Position analytics",
      "Volunteer registrations by event position.",

      positionRows.map(
        (position) => ({
          label:
            position.name,

          value:
            position.count
        })
      ),

      positionLeaderboardRows(
        positionRows,
        total
      ),

      {
        panelClass:
          "position-panel",

        listClass:
          "leaderboard-list"
      }
    )
  );
}


/* =========================================================
   STATISTICS COMPONENTS
========================================================= */

function statGrid(items) {
  const grid =
    document.createElement(
      "div"
    );

  grid.className =
    "grid stats-grid";

  items.forEach(
    ([label, value, note]) => {
      const card =
        document.createElement(
          "div"
        );

      card.className =
        "stat-card";

      card.innerHTML =
        `
          <div class="muted"></div>
          <div class="stat-value"></div>
          <div class="stat-note"></div>
        `;

      card.querySelector(
        ".muted"
      ).textContent =
        label;

      card.querySelector(
        ".stat-value"
      ).textContent =
        String(value);

      card.querySelector(
        ".stat-note"
      ).textContent =
        note || "";

      grid.appendChild(
        card
      );
    }
  );

  return grid;
}


function chartPanel(
  title,
  description,
  data,
  rows,
  options = {}
) {
  const panel =
    document.createElement(
      "section"
    );

  panel.className = [
    "panel",
    options.panelClass
  ]
    .filter(Boolean)
    .join(" ");

  const max =
    Math.max(
      1,
      ...data.map(
        (item) =>
          item.max ||
          item.value
      )
    );

  const chart =
    document.createElement(
      "div"
    );

  chart.className = [
    "chart",
    options.chartClass
  ]
    .filter(Boolean)
    .join(" ");

  data.forEach(
    (item) => {
      const bar =
        document.createElement(
          "div"
        );

      bar.className =
        "bar";

      bar.style.height =
        `${Math.max(
          4,
          (item.value /
            max) *
            100
        )}%`;

      bar.title =
        `${item.label}: ${item.value}`;

      bar.innerHTML =
        `
          <strong></strong>
          <span></span>
        `;

      bar.querySelector(
        "strong"
      ).textContent =
        String(
          item.value
        );

      bar.querySelector(
        "span"
      ).textContent =
        item.label;

      chart.appendChild(
        bar
      );
    }
  );

  panel.append(
    headingBlock(
      title,
      description
    ),

    chart,

    listElement(
      rows,
      options.listClass
    )
  );

  return panel;
}


function headingBlock(
  title,
  description
) {
  const wrap =
    document.createElement(
      "div"
    );

  const heading =
    document.createElement(
      "h2"
    );

  heading.textContent =
    title;

  const copy =
    document.createElement(
      "p"
    );

  copy.className =
    "muted";

  copy.textContent =
    description;

  wrap.append(
    heading,
    copy
  );

  return wrap;
}


function listElement(
  rows,
  extraClass = ""
) {
  const list =
    document.createElement(
      "div"
    );

  list.className = [
    "list",
    "analytics-list",
    extraClass
  ]
    .filter(Boolean)
    .join(" ");

  rows.forEach(
    (row) => {
      const item =
        document.createElement(
          "div"
        );

      item.className = [
        "list-row",
        row.className
      ]
        .filter(Boolean)
        .join(" ");

      item.textContent =
        row.text ||
        row;

      list.appendChild(
        item
      );
    }
  );

  return list;
}


function shiftRows(
  shifts
) {
  const sorted =
    [...shifts].sort(
      (a, b) =>
        b.count -
        a.count
    );

  const summaryRows = [
    {
      text:
        `Most filled shift — ${
          sorted[0]
            ? `${sorted[0].positionName} — ${formatShiftTime(
                sorted[0]
              )} (${sorted[0].count})`
            : "None"
        }`,

      className:
        "featured-row"
    }
  ];

  return summaryRows.concat(
    shifts.map(
      (shift) => ({
        text:
          `${shift.positionName} — ${formatShiftTime(
            shift
          )}: ${shift.count} of ${shift.capacity} filled (${Math.round(
            shift.capacity
              ? (shift.count /
                  shift.capacity) *
                  100
              : 0
          )}%)`,

        className:
          "subtle-row"
      })
    )
  );
}


function positionLeaderboardRows(
  positions,
  total
) {
  return positions.map(
    (
      position,
      index
    ) => ({
      text:
        `#${index + 1} ${
          position.name
        } — ${
          position.count
        } volunteers (${percent(
          position.count,
          total
        )})`,

      className:
        "leaderboard-row"
    })
  );
}


/* =========================================================
   DAY-OF STATISTICS
========================================================= */

function dayOfOverview(
  records
) {
  const stats =
    computeOpsStats(
      records,
      new Map(
        records.map(
          (r) => [
            r.id,
            r.checkin || {
              status:
                "registered"
            }
          ]
        )
      )
    );

  return statGrid([
    [
      "Not checked in yet",
      stats.notArrived
    ],

    [
      "Currently checked in",
      stats.checkedIn
    ],

    [
      "Checked out / done",
      stats.checkedOut
    ],

    [
      "Late",
      stats.late
    ],

    [
      "Total expected",
      stats.expected
    ]
  ]);
}


function dayOfStatsPanel(
  records
) {
  const stats =
    computeOpsStats(
      records,
      new Map(
        records.map(
          (r) => [
            r.id,
            r.checkin || {
              status:
                "registered"
            }
          ]
        )
      )
    );

  return chartPanel(
    "Day-of volunteer operations",
    "Real-time attendance statistics from check-in and check-out records.",

    [
      {
        label:
          "Expected",

        value:
          stats.expected
      },

      {
        label:
          "Checked In",

        value:
          stats.checkedIn
      },

      {
        label:
          "Checked Out",

        value:
          stats.checkedOut
      },

      {
        label:
          "Late",

        value:
          stats.late
      }
    ],

    [
      `Expected — ${stats.expected}`,

      `Not arrived — ${stats.notArrived} (${stats.rates.notArrived})`,

      `Check-in rate — ${stats.rates.checkin}`,

      `Checkout rate — ${stats.rates.checkout}`
    ]
  );
}


function shiftOverview(
  regs,
  checkins
) {
  const panel =
    document.createElement(
      "section"
    );

  panel.className =
    "panel ops-wide";

  panel.append(
    headingBlock(
      "Shift overview",
      "Attendance for every configured volunteer shift."
    )
  );

  const table =
    document.createElement(
      "table"
    );

  table.className =
    "compact-table";

  table.innerHTML =
    `
      <thead>
        <tr>
          <th>Position</th>
          <th>Shift</th>
          <th>Expected</th>
          <th>Checked In</th>
          <th>Checked Out</th>
          <th>Not Arrived</th>
        </tr>
      </thead>
    `;

  const body =
    document.createElement(
      "tbody"
    );

  allShifts().forEach(
    (shift) => {
      const s =
        shiftStats(
          shift.id,
          regs,
          checkins
        );

      const tr =
        document.createElement(
          "tr"
        );

      [
        shift.positionName,

        formatShiftTime(
          shift
        ),

        s.expected,

        s.checkedIn,

        s.checkedOut,

        s.notArrived
      ].forEach(
        (value) => {
          const td =
            document.createElement(
              "td"
            );

          td.textContent =
            String(value);

          tr.appendChild(
            td
          );
        }
      );

      body.appendChild(
        tr
      );
    }
  );

  table.appendChild(
    body
  );

  panel.appendChild(
    table
  );

  return panel;
}


/* =========================================================
   REPORT
========================================================= */

function openVolunteerReport(
  records
) {
  const win =
    window.open(
      "",
      "_blank"
    );

  if (!win) return;

  const stats =
    computeOpsStats(
      records,
      new Map(
        records.map(
          (r) => [
            r.id,
            r.checkin || {
              status:
                "registered"
            }
          ]
        )
      )
    );

  const rows =
    exportRows(records);

  win.document.write(
    `
      <title>
        ${escapeHtml(
          CONFIG.eventName
        )} Report
      </title>

      <style>
        body {
          font-family: Inter, Arial, sans-serif;
          margin: 28px;
          color: #131a24;
        }

        .hero {
          border: 1px solid #dde3ec;
          border-radius: 20px;
          padding: 22px;
          background: #f8fafc;
        }

        h1 {
          margin: 0 0 8px;
        }

        .grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 10px;
          margin: 18px 0;
        }

        .card {
          border: 1px solid #dde3ec;
          border-radius: 14px;
          padding: 12px;
        }

        .num {
          font-size: 28px;
          font-weight: 800;
          color: #07345e;
        }

        table {
          border-collapse: collapse;
          width: 100%;
          font-size: 10px;
          table-layout: fixed;
        }

        th,
        td {
          border: 1px solid #d8dee8;
          padding: 5px;
          word-break: break-word;
        }

        th {
          background: #eef2f7;
        }

        @media print {
          @page {
            size: landscape;
            margin: .35in;
          }
        }
      </style>

      <section class="hero">
        <h1>
          ${escapeHtml(
            CONFIG.eventName
          )}
          Volunteer Report
        </h1>

        <p>
          ${escapeHtml(
            formatDriveDate(
              CONFIG.eventDate
            )
          )}
          ·
          ${escapeHtml(
            CONFIG.location
          )}
          ·
          Times shown in
          ${escapeHtml(
            EVENT_TIME_ZONE_LABEL
          )}
        </p>
      </section>

      <div class="grid">
        ${[
          [
            "Expected",
            stats.expected
          ],

          [
            "Checked In",
            stats.checkedIn
          ],

          [
            "Checked Out",
            stats.checkedOut
          ],

          [
            "Late",
            stats.late
          ],

          [
            "Not Arrived",
            stats.notArrived
          ]
        ]
          .map(
            ([label, value]) =>
              `
                <div class="card">
                  <div>
                    ${escapeHtml(
                      label
                    )}
                  </div>

                  <div class="num">
                    ${escapeHtml(
                      value
                    )}
                  </div>
                </div>
              `
          )
          .join("")}
      </div>

      <h2>Attendance rates</h2>

      <p>
        Check-in
        ${stats.rates.checkin}
        · Checkout
        ${stats.rates.checkout}
        · Not arrived
        ${stats.rates.notArrived}
      </p>

      <h2>All volunteers</h2>

      <table>
        <thead>
          <tr>
            ${
              Object.keys(
                rows[0] || {}
              )
                .map(
                  (h) =>
                    `<th>${escapeHtml(
                      h
                    )}</th>`
                )
                .join("")
            }
          </tr>
        </thead>

        <tbody>
          ${
            rows
              .map(
                (row) =>
                  `
                    <tr>
                      ${
                        Object.values(
                          row
                        )
                          .map(
                            (v) =>
                              `<td>${escapeHtml(
                                v
                              )}</td>`
                          )
                          .join("")
                      }
                    </tr>
                  `
              )
              .join("")
          }
        </tbody>
      </table>
    `
  );

  win.document.close();

  win.print();
}


/* =========================================================
   LABEL / FORMATTING HELPERS
========================================================= */

function normalizeSearch(
  value
) {
  return String(
    value || ""
  )
    .toLowerCase()
    .replace(
      /[^a-z0-9@.]+/g,
      " "
    )
    .trim();
}


function operationalLabel(
  value
) {
  return (
    {
      registered:
        "Registered",

      late:
        "Late",

      checked_in:
        "Checked In",

      completed:
        "Completed"
    }[value] ||
    "Registered"
  );
}


function adminDisplayName(
  profile,
  user
) {
  return [
    profile?.firstName,
    profile?.lastName
  ]
    .filter(Boolean)
    .join(" ")
    .trim() ||
    profile?.name ||
    profile?.displayName ||
    profile?.email ||
    user?.email ||
    user?.uid ||
    "Admin";
}


function adminName(
  uid,
  fallback = ""
) {
  return (
    fallback ||
    adminDirectory.get(
      uid
    ) ||
    uid ||
    ""
  );
}


function positionLabel(
  id,
  fallback = ""
) {
  return (
    getPositionById(
      id
    )?.name ||
    fallback ||
    id ||
    ""
  );
}


function shiftLabel(
  id,
  fallback = ""
) {
  const shift =
    getShiftById(id);

  return (
    shift
      ? formatShiftTime(
          shift
        )
      : fallback ||
        id ||
        ""
  );
}


function shiftStartLabel(
  id,
  fallback = ""
) {
  const shift =
    getShiftById(id);

  return shift
    ? formatTime(
        shift.startTime
      )
    : fallback || "";
}


function shiftEndLabel(
  id,
  fallback = ""
) {
  const shift =
    getShiftById(id);

  return shift
    ? formatTime(
        shift.endTime
      )
    : fallback || "";
}


function timeOnly(
  value
) {
  const d =
    toDate(value);

  return d
    ? d
        .toLocaleTimeString(
          "en-US",
          {
            hour:
              "numeric",

            minute:
              "2-digit",

            timeZone:
              EVENT_TIME_ZONE,

            timeZoneName:
              "short"
          }
        )
        .replace(
          /EDT|GMT[-+]\d+/,
          EVENT_TIME_ZONE_LABEL
        )
    : "";
}


function formatTimestamp(
  value
) {
  const date =
    toDate(value);

  return date
    ? date
        .toLocaleString(
          "en-US",
          {
            dateStyle:
              "medium",

            timeStyle:
              "short",

            timeZone:
              EVENT_TIME_ZONE
          }
        )
        .replace(
          /EDT|GMT[-+]\d+/,
          EVENT_TIME_ZONE_LABEL
        )
    : "";
}


function formatTimestampWithSeconds(
  value
) {
  const date =
    toDate(value);

  return date
    ? date
        .toLocaleString(
          "en-US",
          {
            dateStyle:
              "medium",

            timeStyle:
              "medium",

            timeZone:
              EVENT_TIME_ZONE
          }
        )
        .replace(
          /EDT|GMT[-+]\d+/,
          EVENT_TIME_ZONE_LABEL
        )
    : "";
}


function formatDriveDate(
  value
) {
  if (!value) return "";

  const [
    year,
    month,
    day
  ] =
    String(value)
      .split("-")
      .map(Number);

  if (
    !year ||
    !month ||
    !day
  ) {
    return "";
  }

  return new Intl.DateTimeFormat(
    "en-US",
    {
      month:
        "long",

      day:
        "numeric",

      year:
        "numeric"
    }
  ).format(
    new Date(
      year,
      month - 1,
      day
    )
  );
}


function formatDate(
  value
) {
  if (!value) return "";

  const [
    year,
    month,
    day
  ] =
    String(value)
      .split("-")
      .map(Number);

  if (
    !year ||
    !month ||
    !day
  ) {
    return "";
  }

  return new Intl.DateTimeFormat(
    "en-US",
    {
      month:
        "short",

      day:
        "numeric",

      year:
        "numeric"
    }
  ).format(
    new Date(
      year,
      month - 1,
      day
    )
  );
}


function toDate(
  value
) {
  const date =
    value
      ? new Date(value)
      : null;

  return date &&
    !Number.isNaN(
      date.getTime()
    )
    ? date
    : null;
}


function setText(
  id,
  value
) {
  const element =
    $(id);

  if (element) {
    element.textContent =
      value;
  }
}


function setDisabled(
  id,
  disabled
) {
  const element =
    $(id);

  if (element) {
    element.disabled =
      disabled;
  }
}


function showError(
  message
) {
  setText(
    "error",
    message
  );

  setText(
    "counts",
    "Unable to load volunteers"
  );
}


function startOfDay(
  date
) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate()
  );
}


function addDays(
  date,
  days
) {
  const result =
    new Date(date);

  result.setDate(
    result.getDate() +
      days
  );

  return result;
}


function isoDate(
  date
) {
  if (
    !(
      date instanceof
      Date
    ) ||
    Number.isNaN(
      date.getTime()
    )
  ) {
    return "";
  }

  const year =
    date.getFullYear();

  const month =
    String(
      date.getMonth() + 1
    ).padStart(
      2,
      "0"
    );

  const day =
    String(
      date.getDate()
    ).padStart(
      2,
      "0"
    );

  return `${year}-${month}-${day}`;
}


function shortDate(
  date
) {
  return date.toLocaleDateString(
    "en-US",
    {
      month:
        "short",

      day:
        "numeric"
    }
  );
}


function dateRange(
  start,
  end
) {
  const dates = [];

  for (
    let d =
      startOfDay(
        start
      );

    d <= end;

    d =
      addDays(
        d,
        1
      )
  ) {
    dates.push(
      new Date(d)
    );
  }

  return dates;
}


function countSince(
  records,
  start,
  end
) {
  return records.filter(
    (record) => {
      const date =
        toDate(
          record.createdAt
        );

      return (
        date &&
        date >= start &&
        date < end
      );
    }
  ).length;
}


function percent(
  value,
  total
) {
  return total
    ? `${Math.round(
        (value / total) *
          100
      )}%`
    : "0%";
}


function escapeHtml(
  value
) {
  return String(
    value ?? ""
  ).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]
  );
}