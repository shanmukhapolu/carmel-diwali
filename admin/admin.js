import {
  CONFIG,
  VOLUNTEER_POSITIONS,
  formatTime,
  formatShiftTime,
  getPositionById,
  getShiftById,
  findShift,
  normalizeLastName,
  normalizeFirstName,
  normalizePhoneNumber,
  getRegistrationLookupId,
  sha256Hex
} from "../config.js";

import { db } from "../firebase-init.js";
import { requireAdmin, logout, isEnabledCheckinStaff } from "./auth.js";

import {
  collection,
  deleteDoc,
  deleteField,
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

const REGISTRATION_START = new Date("2026-09-07T00:00:00");

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
    adminDisplayName(profile, user)
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

    const links = isEnabledCheckinStaff(profile)
      ? [["Check-In", "/admin/checkin.html"]]
      : [
          ["Dashboard", "/admin/"],
          ["Volunteers", "/admin/registrations.html"],
          ["City Import", "/admin/city-volunteers.html"],
          ["WhatsApp", "/admin/whatsapp.html"],
          ["Check-In", "/admin/checkin.html"],
          ["Statistics", "/admin/statistics.html"],
          ["Create Check-In Account", "/admin/signup.html"]
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

    links.forEach(([label, href]) => {
      const a = document.createElement("a");

      a.href = href;
      a.textContent = label;

      if (
        href.endsWith(current) ||
        (href === "/admin/" && current === "index.html") ||
        (href === "/admin/checkin.html" && current === "checkin.html")
      ) {
        a.className = "active";
      }

      nav.appendChild(a);
    });
  });
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
        ...normalizeRegistrationShift(
          record
        ),

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


function normalizeRegistrationShift(record) {
  if (!record) return record;

  const configured =
    getShiftById(
      record.positionId,
      record.shiftId
    );

  if (configured) {
    return {
      ...record,
      shiftId: configured.id,
      shiftStartTime:
        configured.startTime,
      shiftEndTime:
        configured.endTime,
      shiftLabel:
        formatShiftTime(
          configured
        )
    };
  }

  const position =
    getPositionById(
      record.positionId
    );

  if (!position) return record;

  const startTime =
    normalizeStoredShiftTime(
      record.shiftStartTime
    );

  const endTime =
    normalizeStoredShiftTime(
      record.shiftEndTime
    );

  if (!startTime || !endTime) {
    return record;
  }

  const match =
    position.shifts?.find(
      (shift) =>
        shift.startTime ===
          startTime &&
        shift.endTime ===
          endTime
    );

  if (!match) {
    return record;
  }

  return {
    ...record,
    shiftId: match.id,
    shiftStartTime:
      match.startTime,
    shiftEndTime:
      match.endTime,
    shiftLabel:
      formatShiftTime(match)
  };
}

function normalizeStoredShiftTime(value) {
  const text =
    String(value || "").trim();

  if (/^\d{3,4}$/.test(text)) {
    return text.padStart(4, "0");
  }

  const match =
    text.match(
      /^(\d{1,2})(?::(\d{2}))?\s*([AP]M)$/i
    );

  if (!match) return "";

  let hour =
    Number(match[1]);

  const minute =
    Number(match[2] || "0");

  const period =
    match[3].toUpperCase();

  if (
    hour < 1 ||
    hour > 12 ||
    minute < 0 ||
    minute > 59
  ) {
    return "";
  }

  if (period === "AM") {
    if (hour === 12) hour = 0;
  } else if (hour !== 12) {
    hour += 12;
  }

  return (
    String(hour).padStart(2, "0") +
    String(minute).padStart(2, "0")
  );
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
    } ${
      record.lastName || "volunteer"
    }`
  );

  const form = document.createElement("form");
  form.className = "settings-grid";
  form.style.gridTemplateColumns =
    "repeat(auto-fit, minmax(260px, 1fr))";

  function fieldWrap(labelHtml, input) {
    const wrap = document.createElement("div");
    wrap.innerHTML = labelHtml;
    wrap.appendChild(input);
    return wrap;
  }

  const firstNameInput =
    document.createElement("input");
  firstNameInput.type = "text";
  firstNameInput.value =
    record.firstName || "";
  firstNameInput.placeholder =
    "First name";
  firstNameInput.required = true;

  const lastNameInput =
    document.createElement("input");
  lastNameInput.type = "text";
  lastNameInput.value =
    record.lastName || "";
  lastNameInput.placeholder =
    "Last name";
  lastNameInput.required = true;

  const emailInput =
    document.createElement("input");
  emailInput.type = "email";
  emailInput.value =
    record.email || "";
  emailInput.placeholder =
    "volunteer@example.com";
  emailInput.required = true;

  const phoneInput =
    document.createElement("input");
  phoneInput.type = "tel";
  phoneInput.value =
    record.phone || "";
  phoneInput.placeholder =
    "(317) 555-0100";
  phoneInput.required = true;

  const positionSelect =
    document.createElement("select");

  VOLUNTEER_POSITIONS.forEach(
    (position) => {
      positionSelect.append(
        new Option(
          position.name,
          position.id,
          false,
          position.id ===
            record.positionId
        )
      );
    }
  );

  const shiftSelect =
    document.createElement("select");

  function refreshEditShiftOptions(
    selectedShiftId = ""
  ) {
    shiftSelect.textContent = "";

    const position =
      getPositionById(
        positionSelect.value
      );

    position?.shifts?.forEach(
      (shift) => {
        shiftSelect.append(
          new Option(
            formatShiftTime(
              shift
            ),
            shift.id,
            false,
            shift.id ===
              selectedShiftId
          )
        );
      }
    );

    if (
      !shiftSelect.value &&
      position?.shifts?.length
    ) {
      shiftSelect.value =
        position.shifts[0].id;
    }
  }

  positionSelect.addEventListener(
    "change",
    () =>
      refreshEditShiftOptions()
  );

  refreshEditShiftOptions(
    findShift(record.shiftId)?.shift
      ? record.shiftId
      : findConfiguredShiftForRecord(
          record
        )?.id
  );

  const is18Row =
    document.createElement(
      "div"
    );

  is18Row.style.display =
    "flex";
  is18Row.style.gap =
    "16px";
  is18Row.style.marginTop =
    "8px";
  is18Row.style.alignItems =
    "center";

  const yesRadio =
    document.createElement(
      "input"
    );

  yesRadio.type = "radio";
  yesRadio.name =
    "edit-is18OrOlder";
  yesRadio.value = "yes";
  yesRadio.required = true;

  if (
    record.is18OrOlder ===
    true
  ) {
    yesRadio.checked = true;
  }

  const yesLabel =
    document.createElement(
      "label"
    );

  yesLabel.style.display =
    "inline-flex";
  yesLabel.style.alignItems =
    "center";
  yesLabel.style.gap =
    "6px";
  yesLabel.style.cursor =
    "pointer";
  yesLabel.style.fontWeight =
    "500";
  yesLabel.appendChild(
    yesRadio
  );

  const yesSpan =
    document.createElement(
      "span"
    );

  yesSpan.textContent =
    "Yes (18+)";

  yesLabel.appendChild(
    yesSpan
  );

  const noRadio =
    document.createElement(
      "input"
    );

  noRadio.type = "radio";
  noRadio.name =
    "edit-is18OrOlder";
  noRadio.value = "no";
  noRadio.required = true;

  if (
    record.is18OrOlder ===
    false
  ) {
    noRadio.checked = true;
  }

  const noLabel =
    document.createElement(
      "label"
    );

  noLabel.style.display =
    "inline-flex";
  noLabel.style.alignItems =
    "center";
  noLabel.style.gap =
    "6px";
  noLabel.style.cursor =
    "pointer";
  noLabel.style.fontWeight =
    "500";
  noLabel.appendChild(
    noRadio
  );

  const noSpan =
    document.createElement(
      "span"
    );

  noSpan.textContent =
    "No (<18)";

  noLabel.appendChild(
    noSpan
  );

  is18Row.append(
    yesLabel,
    noLabel
  );

  const notesInput =
    document.createElement(
      "input"
    );

  notesInput.type = "text";
  notesInput.value =
    record.notes || "";
  notesInput.placeholder =
    "Special skills, requests, or organizer notes";

  const error =
    document.createElement(
      "p"
    );

  error.className =
    "error";

  const confirmBtn =
    smallButton(
      "Save Changes",
      async () => {
        const newFirstName =
          firstNameInput.value.trim();

        const newLastName =
          lastNameInput.value.trim();

        const newEmail =
          emailInput.value
            .trim()
            .toLowerCase();

        const newPhone =
          normalizePhoneNumber(
            phoneInput.value
          );

        const newPositionId =
          positionSelect.value;

        const newShiftId =
          shiftSelect.value;

        const newNotes =
          notesInput.value.trim();

        const is18Raw =
          form.querySelector(
            'input[name="edit-is18OrOlder"]:checked'
          )?.value;

        const newIs18OrOlder =
          is18Raw === "yes"
            ? true
            : is18Raw === "no"
            ? false
            : null;

        const target =
          findShift(
            newShiftId
          );

        if (
          !newFirstName ||
          !newLastName ||
          !newEmail ||
          !newPhone ||
          newIs18OrOlder ===
            null
        ) {
          error.textContent =
            "All fields are required. Please complete the form.";
          return;
        }

        if (
          !target ||
          target.position.id !==
            newPositionId
        ) {
          error.textContent =
            "Choose a valid position and shift.";
          return;
        }

        const newPosition =
          target.position;

        const newShift =
          target.shift;

        const oldPositionId =
          record.positionId;

        const oldShiftId =
          record.shiftId;

        const shiftChanged =
          oldPositionId !==
            newPositionId ||
          oldShiftId !==
            newShiftId;

        const oldNormFirst =
          record.normalizedFirstName ||
          normalizeFirstName(
            record.firstName
          );

        const oldNormLast =
          record.normalizedLastName ||
          normalizeLastName(
            record.lastName
          );

        const oldNormPhone =
          record.normalizedPhone ||
          normalizePhoneNumber(
            record.phone
          );

        const newNormFirst =
          normalizeFirstName(
            newFirstName
          );

        const newNormLast =
          normalizeLastName(
            newLastName
          );

        const emailHash =
          await sha256Hex(
            newEmail
          );

        const oldEmail =
          normalizeEmailForAdmin(
            record.email
          );

        const oldEmailHash =
          oldEmail
            ? await sha256Hex(
                oldEmail
              )
            : "";

        const oldPersonShiftRef =
          oldNormFirst &&
          oldNormLast &&
          oldNormPhone &&
          oldShiftId
            ? doc(
                db,
                "registrationGuards",
                `person_shift_${oldNormFirst}_${oldNormLast}_${oldNormPhone}_${oldShiftId}`
              )
            : null;

        const newPersonShiftRef =
          newNormFirst &&
          newNormLast &&
          newPhone &&
          newShiftId
            ? doc(
                db,
                "registrationGuards",
                `person_shift_${newNormFirst}_${newNormLast}_${newPhone}_${newShiftId}`
              )
            : null;

        const oldEmailShiftRef =
          oldNormFirst &&
          oldNormLast &&
          oldEmailHash &&
          oldShiftId
            ? doc(
                db,
                "registrationGuards",
                `email_person_shift_${oldEmailHash}_${oldNormFirst}_${oldNormLast}_${oldShiftId}`
              )
            : null;

        const newEmailShiftRef =
          newNormFirst &&
          newNormLast &&
          emailHash &&
          newShiftId
            ? doc(
                db,
                "registrationGuards",
                `email_person_shift_${emailHash}_${newNormFirst}_${newNormLast}_${newShiftId}`
              )
            : null;

        const newLookupId =
          newPhone
            ? await getRegistrationLookupId(
                newLastName,
                newPhone,
                CONFIG.eventId
              )
            : null;

        const oldLookupId =
          record.manageLookupId ||
          (
            oldNormPhone
              ? await getRegistrationLookupId(
                  record.lastName,
                  oldNormPhone,
                  CONFIG.eventId
                )
              : null
          );

        const oldLookupRef =
          oldLookupId
            ? doc(
                db,
                "registrationLookups",
                oldLookupId
              )
            : null;

        const newLookupRef =
          newLookupId
            ? doc(
                db,
                "registrationLookups",
                newLookupId
              )
            : null;

        try {
          await runTransaction(
            db,
            async (tx) => {
              const regRef =
                doc(
                  db,
                  REGISTRATIONS_COLLECTION,
                  record.id
                );

              const oldShiftRef =
                oldShiftId
                  ? doc(
                      db,
                      SHIFT_COUNTS_COLLECTION,
                      shiftDocId(
                        oldShiftId
                      )
                    )
                  : null;

              const newShiftRef =
                doc(
                  db,
                  SHIFT_COUNTS_COLLECTION,
                  shiftDocId(
                    newShiftId
                  )
                );

              const readRefs = [
                regRef,
                oldShiftRef,
                newShiftRef,
                oldPersonShiftRef,
                newPersonShiftRef,
                oldEmailShiftRef,
                newEmailShiftRef,
                oldLookupRef,
                newLookupRef,
              ].filter(Boolean);

              const snaps =
                await Promise.all(
                  readRefs.map(
                    (ref) =>
                      tx.get(ref)
                  )
                );

              const getSnap =
                (ref) => {
                  if (!ref) return null;

                  const index =
                    readRefs.indexOf(
                      ref
                    );

                  return index >= 0
                    ? snaps[index]
                    : null;
                };

              const regSnap =
                getSnap(regRef);

              if (
                !regSnap?.exists()
              ) {
                throw new Error(
                  "REGISTRATION_NOT_FOUND"
                );
              }

              const targetPhoneGuardSnap =
                getSnap(
                  newPersonShiftRef
                );

              const targetEmailGuardSnap =
                getSnap(
                  newEmailShiftRef
                );

              if (
                shiftChanged &&
                targetPhoneGuardSnap?.exists() &&
                targetPhoneGuardSnap.data()?.registrationId !==
                  record.id
              ) {
                throw new Error(
                  "TARGET_SHIFT_DUPLICATE"
                );
              }

              if (
                shiftChanged &&
                targetEmailGuardSnap?.exists() &&
                targetEmailGuardSnap.data()?.registrationId !==
                  record.id
              ) {
                throw new Error(
                  "TARGET_SHIFT_DUPLICATE"
                );
              }

              const oldShiftSnap =
                getSnap(
                  oldShiftRef
                );

              const newShiftSnap =
                getSnap(
                  newShiftRef
                );

              const oldCount =
                Number(
                  oldShiftSnap?.data()?.count ??
                    0
                );

              const newCount =
                Number(
                  newShiftSnap?.data()?.count ??
                    0
                );

              const newCapacity =
                Number(
                  newShiftSnap?.data()?.capacity ??
                    newShift.capacity ??
                    0
                );

              if (
                shiftChanged &&
                oldShiftId !==
                  newShiftId
              ) {
                if (
                  oldShiftSnap?.exists()
                ) {
                  tx.update(
                    oldShiftRef,
                    {
                      count:
                        Math.max(
                          0,
                          oldCount - 1
                        ),
                    }
                  );
                }

                if (
                  newShiftSnap?.exists()
                ) {
                  tx.update(
                    newShiftRef,
                    {
                      count:
                        newCount + 1,
                      capacity:
                        newCapacity,
                    }
                  );
                } else {
                  tx.set(
                    newShiftRef,
                    {
                      eventId:
                        CONFIG.eventId,
                      shiftId:
                        newShift.id,
                      positionId:
                        newPosition.id,
                      positionName:
                        newPosition.name,
                      startTime:
                        newShift.startTime,
                      endTime:
                        newShift.endTime,
                      label:
                        formatShiftTime(
                          newShift
                        ),
                      capacity:
                        newCapacity,
                      count:
                        1,
                    }
                  );
                }
              }

              tx.update(
                regRef,
                {
                  firstName:
                    newFirstName,
                  lastName:
                    newLastName,
                  email:
                    newEmail,
                  phone:
                    newPhone,
                  normalizedFirstName:
                    newNormFirst,
                  normalizedLastName:
                    newNormLast,
                  normalizedPhone:
                    newPhone,
                  emailGuardKey:
                    encodeURIComponent(
                      newEmail
                    ),
                  manageLookupId:
                    newLookupId,
                  is18OrOlder:
                    newIs18OrOlder,
                  notes:
                    newNotes,
                  positionId:
                    newPosition.id,
                  positionName:
                    newPosition.name,
                  shiftId:
                    newShift.id,
                  shiftStartTime:
                    newShift.startTime,
                  shiftEndTime:
                    newShift.endTime,
                  shiftLabel:
                    formatShiftTime(
                      newShift
                    ),
                }
              );

              if (
                oldPersonShiftRef &&
                (
                  !newPersonShiftRef ||
                  oldPersonShiftRef.path !==
                    newPersonShiftRef.path
                )
              ) {
                tx.delete(
                  oldPersonShiftRef
                );
              }

              if (newPersonShiftRef) {
                tx.set(
                  newPersonShiftRef,
                  {
                    registrationId:
                      record.id,
                    type:
                      "person_shift",
                    status:
                      "active",
                    firstName:
                      newNormFirst,
                    lastName:
                      newNormLast,
                    phone:
                      newPhone,
                    shiftId:
                      newShift.id,
                    createdAt:
                      serverTimestamp(),
                  }
                );
              }

              if (
                oldEmailShiftRef &&
                (
                  !newEmailShiftRef ||
                  oldEmailShiftRef.path !==
                    newEmailShiftRef.path
                )
              ) {
                tx.delete(
                  oldEmailShiftRef
                );
              }

              if (newEmailShiftRef) {
                tx.set(
                  newEmailShiftRef,
                  {
                    registrationId:
                      record.id,
                    type:
                      "email_person_shift",
                    status:
                      "active",
                    emailHash,
                    firstName:
                      newNormFirst,
                    lastName:
                      newNormLast,
                    shiftId:
                      newShift.id,
                    createdAt:
                      serverTimestamp(),
                  }
                );
              }

              const oldLookupSnap =
                getSnap(
                  oldLookupRef
                );

              const newLookupSnap =
                getSnap(
                  newLookupRef
                );

              const oldEntries =
                Array.isArray(
                  oldLookupSnap?.data()
                    ?.entries
                )
                  ? oldLookupSnap
                      .data()
                      .entries
                  : [];

              const updatedEntry = {
                registrationId:
                  record.id,
                firstName:
                  newFirstName,
                normalizedFirstName:
                  newNormFirst,
                lastName:
                  newLastName,
                normalizedLastName:
                  newNormLast,
                phone:
                  newPhone,
                normalizedPhone:
                  newPhone,
                email:
                  newEmail,
                emailHash,
                emailGuardKey:
                  encodeURIComponent(
                    newEmail
                  ),
                is18OrOlder:
                  newIs18OrOlder,
                positionId:
                  newPosition.id,
                positionName:
                  newPosition.name,
                shiftId:
                  newShift.id,
                shiftStartTime:
                  newShift.startTime,
                shiftEndTime:
                  newShift.endTime,
                shiftLabel:
                  formatShiftTime(
                    newShift
                  ),
                status:
                  "registered",
                cancelledAt:
                  null,
                registrationSource:
                  record.registrationSource ||
                  "admin",
              };

              const targetEntries =
                oldEntries.filter(
                  (entry) =>
                    entry &&
                    entry.registrationId !==
                      record.id
                );

              targetEntries.push(
                updatedEntry
              );

              if (newLookupRef) {
                const newLookupData =
                  newLookupSnap?.exists()
                    ? newLookupSnap.data()
                    : {};

                const mergedEntries =
                  Array.isArray(
                    newLookupData.entries
                  )
                    ? newLookupData.entries.filter(
                        (entry) =>
                          entry &&
                          entry.registrationId !==
                            record.id
                      )
                    : [];

                if (
                  oldLookupRef &&
                  oldLookupRef.path ===
                    newLookupRef.path
                ) {
                  mergedEntries.length = 0;
                  mergedEntries.push(
                    ...targetEntries
                  );
                } else {
                  mergedEntries.push(
                    ...targetEntries
                  );
                }

                const registrationIds =
                  Array.isArray(
                    newLookupData.registrationIds
                  )
                    ? [
                        ...newLookupData.registrationIds,
                      ]
                    : [];

                if (
                  !registrationIds.includes(
                    record.id
                  )
                ) {
                  registrationIds.push(
                    record.id
                  );
                }

                tx.set(
                  newLookupRef,
                  {
                    eventId:
                      CONFIG.eventId,
                    normalizedLastName:
                      newNormLast,
                    entries:
                      mergedEntries,
                    registrationIds,
                    updatedAt:
                      serverTimestamp(),
                  },
                  {
                    merge:
                      true,
                  }
                );
              }

              if (
                oldLookupRef &&
                newLookupRef &&
                oldLookupRef.path !==
                  newLookupRef.path
              ) {
                const remainingOldEntries =
                  oldEntries.filter(
                    (entry) =>
                      entry &&
                      entry.registrationId !==
                        record.id
                  );

                const oldData =
                  oldLookupSnap?.data()
                    || {};

                tx.set(
                  oldLookupRef,
                  {
                    entries:
                      remainingOldEntries,
                    registrationIds:
                      Array.isArray(
                        oldData.registrationIds
                      )
                        ? oldData.registrationIds.filter(
                            (id) =>
                              id !==
                              record.id
                          )
                        : [],
                    updatedAt:
                      serverTimestamp(),
                  },
                  {
                    merge:
                      true,
                  }
                );
              }
            }
          );

          registrations =
            registrations.map(
              (item) =>
                item.id ===
                record.id
                  ? {
                      ...item,
                      firstName:
                        newFirstName,
                      lastName:
                        newLastName,
                      email:
                        newEmail,
                      phone:
                        newPhone,
                      normalizedFirstName:
                        newNormFirst,
                      normalizedLastName:
                        newNormLast,
                      normalizedPhone:
                        newPhone,
                      manageLookupId:
                        newLookupId,
                      is18OrOlder:
                        newIs18OrOlder,
                      notes:
                        newNotes,
                      positionId:
                        newPosition.id,
                      positionName:
                        newPosition.name,
                      shiftId:
                        newShift.id,
                      shiftStartTime:
                        newShift.startTime,
                      shiftEndTime:
                        newShift.endTime,
                      shiftLabel:
                        formatShiftTime(
                          newShift
                        )
                    }
                  : item
            );

          await loadShiftCapacities();

          root.textContent = "";
          renderRegistrations();
        } catch (editError) {
          console.error(
            "[Admin] Edit failed:",
            editError
          );

          error.textContent =
            editError?.message ===
            "TARGET_SHIFT_DUPLICATE"
              ? "That volunteer is already registered for the selected shift."
              : editError?.message ===
                "REGISTRATION_NOT_FOUND"
              ? "That registration could not be found. Refresh the page and try again."
              : "Update failed. Please try again or check the console.";
        }
      },
      "primary"
    );

  form.append(
    fieldWrap(
      "<label>First Name <span class='req'>*</span></label>",
      firstNameInput
    ),
    fieldWrap(
      "<label>Last Name <span class='req'>*</span></label>",
      lastNameInput
    ),
    fieldWrap(
      "<label>Email Address <span class='req'>*</span></label>",
      emailInput
    ),
    fieldWrap(
      "<label>Phone Number <span class='req'>*</span></label>",
      phoneInput
    ),
    fieldWrap(
      "<label>Position <span class='req'>*</span></label>",
      positionSelect
    ),
    fieldWrap(
      "<label>Shift <span class='req'>*</span></label>",
      shiftSelect
    ),
    fieldWrap(
      "<label>18 or Older? <span class='req'>*</span></label>",
      is18Row
    ),
    (() => {
      const wrap =
        document.createElement(
          "div"
        );

      wrap.style.gridColumn =
        "1 / -1";

      const label =
        document.createElement(
          "label"
        );

      label.htmlFor =
        "edit-notes";

      label.textContent =
        "Notes (Optional)";

      wrap.appendChild(
        label
      );

      wrap.appendChild(
        notesInput
      );

      return wrap;
    })(),
    (() => {
      const wrap =
        document.createElement(
          "div"
        );

      wrap.style.gridColumn =
        "1 / -1";

      wrap.style.marginTop =
        "8px";

      wrap.appendChild(
        error
      );

      wrap.appendChild(
        confirmBtn
      );

      return wrap;
    })()
  );

  modal.card.appendChild(
    form
  );

  root.appendChild(
    modal.overlay
  );
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

          // --- 2. Delete the registration. The released server-side
          //        `releaseShiftOnRegistrationDelete` function restores the
          //        shift capacity exactly once, so the client does not
          //        decrement shiftCounts here (that would double-count).
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

          const normFirst =
            record.normalizedFirstName ||
            normalizeFirstName(record.firstName);

          if (
            normFirst &&
            normLast &&
            normPhone &&
            record.shiftId
          ) {
            const personShiftKey =
              `person_shift_${normFirst}_${normLast}_${normPhone}_${record.shiftId}`;

            await deleteDoc(
              doc(db, "registrationGuards", personShiftKey)
            ).catch(() => {});
          }

          if (
            record.email &&
            normFirst &&
            normLast &&
            record.shiftId
          ) {
            const emailHash =
              await sha256Hex(
                String(record.email)
                  .trim()
                  .toLowerCase()
              );

            const emailPersonShiftKey =
              `email_person_shift_${emailHash}_${normFirst}_${normLast}_${record.shiftId}`;

            await deleteDoc(
              doc(db, "registrationGuards", emailPersonShiftKey)
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
    if (!isEnabledCheckinStaff(profile)) {
      await loadAdminDirectory();
    }

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
      regs.length
        ? `${regs.length} volunteer registration${
            regs.length === 1 ? "" : "s"
          } loaded.`
        : "No volunteer registrations found."
    );

    // Immediately render all volunteers as cards so the admin does not
    // have to type into the search box before seeing anyone.
    renderCheckinResults(
      "",
      regs,
      checkins,
      results,
      user,
      actorName,
      isEnabledCheckinStaff(profile)
    );

  } catch (error) {
    console.error(
      "[Admin Check-In] Could not load volunteers:",
      error
    );

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
        user,
        actorName,
        isEnabledCheckinStaff(profile)
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
        user,
        actorName,
        isEnabledCheckinStaff(profile)
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
  initActivityPage(isEnabledCheckinStaff(profile));
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
  const now = new Date();
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: EVENT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);

  if (today !== CONFIG.eventDate) {
    return;
  }

  const currentParts = timeParts(now);
  const currentMinutes = currentParts.hour * 60 + currentParts.minute;

  const candidates = regs
    .filter((record) => {
      const shift = getShiftById(record.shiftId);
      if (!shift) return false;

      const status = checkins.get(record.id)?.status;
      if (["checked_in", "completed", "late"].includes(status)) {
        return false;
      }

      return shiftMinutes(shift.endTime) < currentMinutes;
    })
    .slice(0, 20);

  await Promise.all(
    candidates.map(async (record) => {
      const checkinRef = doc(
        db,
        CHECKINS_COLLECTION,
        record.id
      );
      const activityRef = doc(
        collection(db, CHECKIN_ACTIVITY_COLLECTION)
      );

      try {
        await runTransaction(db, async (tx) => {
          const snap = await tx.get(checkinRef);
          const currentStatus = snap.exists()
            ? snap.data().status
            : "registered";

          // Another device may have checked the volunteer in or marked them late
          // after this device built its local candidate list.
          if (
            ["checked_in", "completed", "late"].includes(
              currentStatus
            )
          ) {
            return false;
          }

          if (
            currentStatus !== "registered" &&
            currentStatus !== undefined &&
            currentStatus !== null
          ) {
            return false;
          }

          tx.set(
            checkinRef,
            {
              registrationId: record.id,
              status: "late",
              lateAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
              updatedBy: uid,
              updatedByName: actorName
            },
            { merge: true }
          );

          tx.set(activityRef, {
            registrationId: record.id,
            action: "late",
            actorUid: uid,
            actorName,
            occurredAt: serverTimestamp()
          });

          return true;
        });
      } catch (error) {
        console.info("[Admin Check-In] Could not mark late:", {
          registrationId: record.id,
          code: error?.code || "unknown"
        });
      }
    })
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
  user,
  actorName,
  checkinOnly = false
) {
  if (!root) return;

  const q =
    normalizeSearch(
      term
    );

  root.textContent = "";

  let matches = regs;

  if (q.length >= 2) {
    matches =
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
  } else {
    // Empty search: show every loaded registration so staff never have
    // to type before seeing volunteers.
    matches = regs;
  }

  setText(
    "checkin-status",
    matches.length
      ? `${matches.length} volunteer registration${
          matches.length === 1 ? "" : "s"
        } shown`
      : q.length >= 2
      ? "No volunteers match your search."
      : "No volunteer registrations found."
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
          user,
          actorName,
          checkinOnly
        )
      )
  );
}


function checkinCard(
  record,
  user,
  actorName,
  checkinOnly = false
) {
  const card = document.createElement("article");
  card.className = "checkin-card";

  const status = record.checkin?.status || "registered";
  card.innerHTML =
    '<div class="checkin-card-info">' +
      '<h2></h2>' +
      '<p class="checkin-assignment"></p>' +
      '<p class="checkin-status-line"></p>' +
      '<p class="checkin-time-detail"></p>' +
      '<p class="checkout-time-detail"></p>' +
    '</div>' +
    '<div class="checkin-actions"></div>';

  card.querySelector("h2").textContent =
    (String(record.firstName || "") + " " +
      String(record.lastName || "")).trim() || "Unnamed volunteer";

  card.querySelector(".checkin-assignment").textContent =
    positionLabel(
      record.positionId,
      record.positionName || record.position
    ) + " · " + shiftLabel(record.shiftId, record.shiftLabel);

  card.querySelector(".checkin-status-line").textContent =
    operationalLabel(status) +
    (isLateArrival(record) ? " · Late" : "");

  const checkedInAt = toDate(record.checkin?.checkedInAt);
  const checkedOutAt = toDate(record.checkin?.checkedOutAt);

  card.querySelector(".checkin-time-detail").textContent =
    "Check-in time: " + (
      checkedInAt
        ? formatTimestamp(checkedInAt) + " " + EVENT_TIME_ZONE_LABEL
        : "Not recorded"
    );

  card.querySelector(".checkout-time-detail").textContent =
    "Check-out time: " + (
      checkedOutAt
        ? formatTimestamp(checkedOutAt) + " " + EVENT_TIME_ZONE_LABEL +
          " · " + checkoutMethodLabel(effectiveCheckoutMethod(record))
        : "Not recorded"
    );

  const actions = card.querySelector(".checkin-actions");

  if (status === "registered" || status === "late") {
    actions.append(
      actionButton(
        status === "late" ? "CHECK IN LATE" : "CHECK IN",
        () => transitionCheckin(
          record.id,
          "checkin",
          user.uid,
          actorName || adminDisplayName(null, user)
        )
      )
    );
  } else if (status === "checked_in") {
    actions.append(
      actionButton(
        "CHECK OUT",
        () => showCheckoutTimeModal(
          record,
          (checkoutAt, checkoutMethod) =>
            transitionCheckin(
              record.id,
              "checkout",
              user.uid,
              actorName || adminDisplayName(null, user),
              checkoutAt,
              checkoutMethod
            )
        )
      )
    );
  } else {
    const completed = document.createElement("strong");
    completed.textContent = "Completed";
    actions.append(completed);
  }

  if (!checkinOnly) {
    actions.append(
      actionButton(
        "EDIT TIMES",
        () => showAttendanceTimesModal(
          record,
          user,
          actorName || adminDisplayName(null, user)
        )
      )
    );
  }

  return card;
}


function showCheckoutTimeModal(record, onConfirm) {
  const root = $("modal-root");
  if (!root) return;

  root.textContent = "";

  const name = [
    record.firstName || "",
    record.lastName || ""
  ].join(" ").trim() || "this volunteer";

  const configuredShift =
    findShift(record.shiftId)?.shift ||
    findConfiguredShiftForRecord(record);

  const shiftEndHHMM = configuredShift
    ? normalizeStoredShiftTimeForAdmin(configuredShift.endTime)
    : "";

  const shiftEndTime = shiftEndHHMM
    ? `${shiftEndHHMM.slice(0, 2)}:${shiftEndHHMM.slice(2, 4)}`
    : "";

  const modal = modalShell(`Check out ${name}`);

  const form = document.createElement("form");
  form.className = "checkout-time-form";

  const intro = document.createElement("p");
  intro.textContent =
    `Choose the checkout timestamp for this volunteer. The event date was ${formatDriveDate(CONFIG.eventDate)}.`;
  form.appendChild(intro);

  const choiceGroup = document.createElement("div");
  choiceGroup.className = "checkout-time-options";

  function addChoice(value, titleText, descriptionText, checked, disabled = false) {
    const label = document.createElement("label");
    label.className = "checkout-time-option";

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "checkout-time-choice";
    radio.value = value;
    radio.checked = checked;
    radio.disabled = disabled;

    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = titleText;
    const description = document.createElement("small");
    description.textContent = descriptionText;

    copy.append(title, description);
    label.append(radio, copy);
    choiceGroup.appendChild(label);
    return radio;
  }

  const shiftRadio = addChoice(
    "shiftEnd",
    "Use shift end time",
    shiftEndHHMM
      ? `${formatDriveDate(CONFIG.eventDate)} at ${formatTime(configuredShift.endTime)} (${EVENT_TIME_ZONE_LABEL})`
      : "No configured shift end time was found for this registration.",
    false,
    !shiftEndHHMM
  );

  const currentRadio = addChoice(
    "current",
    "Use current time",
    `Record the moment you confirm checkout: ${new Date().toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: EVENT_TIME_ZONE
    })} (${EVENT_TIME_ZONE_LABEL}).`,
    true
  );

  const customRadio = addChoice(
    "custom",
    "Choose a custom time",
    `Set a specific time on the event date, ${formatDriveDate(CONFIG.eventDate)}.`,
    false
  );

  const customWrap = document.createElement("div");
  customWrap.className = "checkout-time-custom";

  const customLabel = document.createElement("label");
  customLabel.textContent = "Custom checkout time";
  customLabel.htmlFor = "checkout-custom-time";

  const customInput = document.createElement("input");
  customInput.type = "time";
  customInput.id = "checkout-custom-time";
  customInput.name = "customCheckoutTime";
  customInput.value = shiftEndTime;
  customInput.disabled = true;
  customInput.required = false;

  const customHelp = document.createElement("p");
  customHelp.className = "muted";
  customHelp.textContent =
    "The selected time will be saved on the event date in Eastern Time.";

  customWrap.append(customLabel, customInput, customHelp);
  form.append(choiceGroup, customWrap);

  function syncCustomInput() {
    const useCustom = customRadio.checked;
    customInput.disabled = !useCustom;
    customInput.required = useCustom;
  }

  [shiftRadio, currentRadio, customRadio].forEach((radio) => {
    radio.addEventListener("change", syncCustomInput);
  });

  const error = document.createElement("p");
  error.className = "error";
  error.setAttribute("role", "alert");

  const footer = document.createElement("div");
  footer.className = "checkout-time-footer";

  const cancel = smallButton("Cancel", () => {
    root.textContent = "";
  });
  cancel.className = "secondary";
  cancel.addEventListener("click", () => {
    root.textContent = "";
  }, { once: true });

  const confirm = document.createElement("button");
  confirm.type = "submit";
  confirm.className = "primary";
  confirm.textContent = "Confirm Check Out";

  footer.append(cancel, confirm);
  form.append(error, footer);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";

    const selected =
      form.querySelector('input[name="checkout-time-choice"]:checked')?.value;

    let checkoutAt = null;
    let checkoutMethod = "";

    if (selected === "shiftEnd") {
      checkoutAt = eventDateTimeForTimeValue(shiftEndTime);
      checkoutMethod = "estimated_shift_end";
    } else if (selected === "current") {
      checkoutAt = new Date();
      checkoutMethod = "actual_current_time";
    } else if (selected === "custom") {
      checkoutAt = eventDateTimeForTimeValue(customInput.value);
      checkoutMethod = "custom";
    }

    if (!(checkoutAt instanceof Date) || Number.isNaN(checkoutAt.getTime())) {
      error.textContent = selected === "custom"
        ? "Enter a valid custom checkout time."
        : "Select a valid checkout time.";
      return;
    }

    confirm.disabled = true;
    confirm.textContent = "Saving…";
    root.textContent = "";
    await onConfirm(checkoutAt, checkoutMethod);
  });

  modal.card.appendChild(form);
  root.appendChild(modal.overlay);
}

function eventDateTimeForTimeValue(timeValue) {
  const match = String(timeValue || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (hour > 23 || minute > 59) return null;

  const dateParts = String(CONFIG.eventDate || "")
    .split("-")
    .map(Number);

  if (
    dateParts.length !== 3 ||
    dateParts.some((part) => !Number.isFinite(part) || part <= 0)
  ) {
    return null;
  }

  const [year, month, day] = dateParts;
  const wallClockAsUtc = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    0,
    0
  );

  // Resolve the event's wall-clock time into a true timestamp using the
  // configured event time zone, regardless of the device's local time zone.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EVENT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(wallClockAsUtc));

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );

  const representedAsUtc = Date.UTC(
    values.year,
    values.month - 1,
    values.day,
    values.hour,
    values.minute,
    0,
    0
  );

  const timezoneOffset = representedAsUtc - wallClockAsUtc;
  return new Date(wallClockAsUtc - timezoneOffset);
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


function effectiveCheckoutMethod(record) {
  const attendance = record?.checkin || {};
  const storedMethod = attendance.checkoutMethod;
  if (["actual_current_time", "estimated_shift_end", "custom"].includes(storedMethod)) {
    return storedMethod;
  }

  const checkedOutAt = toDate(attendance.checkedOutAt);
  if (!checkedOutAt) return "actual_current_time";

  // A previous version allowed admins to save the scheduled shift end as a
  // placeholder but did not store the chosen method. Its timestamp is exactly
  // the scheduled minute with zero seconds; infer only that strong match.
  const shift = findShift(record.shiftId)?.shift ||
    findConfiguredShiftForRecord(record);
  const rawEndTime = shift?.endTime || record.shiftEndTime || "";
  const endHHMM = normalizeStoredShiftTimeForAdmin(rawEndTime);
  if (!endHHMM) return "actual_current_time";

  const expectedShiftEnd = eventDateTimeForTimeValue(
    endHHMM.slice(0, 2) + ":" + endHHMM.slice(2, 4)
  );
  if (
    expectedShiftEnd &&
    checkedOutAt.getTime() === expectedShiftEnd.getTime()
  ) {
    return "estimated_shift_end";
  }

  return "actual_current_time";
}


function checkoutMethodLabel(method) {
  switch (method) {
    case "estimated_shift_end":
      return "Estimated shift-end time";
    case "custom":
      return "Custom/admin-adjusted time";
    case "actual_current_time":
    default:
      // The old system recorded the current time and did not store a method.
      // Treat legacy completed records without metadata as actual checkouts.
      return "Actual/current-time checkout";
  }
}

function dateTimeLocalValueForEventTimeZone(value) {
  const date = toDate(value);
  if (!date) return "";

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EVENT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const fields = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return fields.year + "-" + fields.month + "-" + fields.day +
    "T" + fields.hour + ":" + fields.minute;
}

function eventDateTimeForDateTimeLocalValue(value) {
  const match = String(value || "").match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
  );
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);

  if (
    month < 1 || month > 12 ||
    day < 1 || day > 31 ||
    hour > 23 || minute > 59
  ) {
    return null;
  }

  const wallClockAsUtc = Date.UTC(
    year, month - 1, day, hour, minute, 0, 0
  );

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EVENT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(wallClockAsUtc));

  const fields = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );

  const representedAsUtc = Date.UTC(
    fields.year, fields.month - 1, fields.day,
    fields.hour, fields.minute, 0, 0
  );

  const timezoneOffset = representedAsUtc - wallClockAsUtc;
  return new Date(wallClockAsUtc - timezoneOffset);
}

function showAttendanceTimesModal(record, user, actorName) {
  const root = $("modal-root");
  if (!root) return;
  root.textContent = "";

  const existing = record.checkin || {};
  const fullName = (String(record.firstName || "") + " " +
    String(record.lastName || "")).trim() || "Volunteer";
  const modal = modalShell("Edit attendance times · " + fullName);
  const form = document.createElement("form");
  form.className = "checkout-time-form";

  const note = document.createElement("p");
  note.textContent =
    "Admin override: edit the check-in and check-out timestamps for this volunteer. Times are shown in Eastern Time. Existing records change only when you save.";
  form.appendChild(note);

  function addField(labelText, id, value) {
    const wrap = document.createElement("div");
    wrap.className = "checkout-time-custom";

    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = labelText;

    const input = document.createElement("input");
    input.type = "datetime-local";
    input.id = id;
    input.value = dateTimeLocalValueForEventTimeZone(value);
    input.step = "60";

    const hint = document.createElement("small");
    hint.className = "muted";
    hint.textContent = "Leave blank to clear this timestamp.";

    wrap.append(label, input, hint);
    form.appendChild(wrap);
    return input;
  }

  const checkedInInput = addField(
    "Check-in date and time",
    "edit-checked-in-at",
    existing.checkedInAt
  );
  const checkedOutInput = addField(
    "Check-out date and time",
    "edit-checked-out-at",
    existing.checkedOutAt
  );

  const methodWrap = document.createElement("div");
  methodWrap.className = "checkout-time-custom";

  const methodLabel = document.createElement("label");
  methodLabel.htmlFor = "edit-checkout-method";
  methodLabel.textContent = "Checkout classification";

  const methodSelect = document.createElement("select");
  methodSelect.id = "edit-checkout-method";
  [
    ["actual_current_time", "Actual checkout (recorded at the booth)"],
    ["estimated_shift_end", "Estimated shift end (volunteer forgot to check out)"],
    ["custom", "Custom/admin-adjusted time"]
  ].forEach(([value, label]) => {
    methodSelect.append(new Option(label, value));
  });
  methodSelect.value = effectiveCheckoutMethod(record);
  methodSelect.disabled = !existing.checkedOutAt;

  const methodHint = document.createElement("small");
  methodHint.className = "muted";
  methodHint.textContent =
    "Older records without method metadata default to actual/current-time, except exact scheduled shift-end timestamps, which are inferred as estimates.";

  methodWrap.append(methodLabel, methodSelect, methodHint);
  form.appendChild(methodWrap);

  checkedOutInput.addEventListener("input", () => {
    methodSelect.disabled = !checkedOutInput.value;
  });

  const error = document.createElement("p");
  error.className = "error";
  error.setAttribute("role", "alert");

  const footer = document.createElement("div");
  footer.className = "checkout-time-footer";

  const cancel = smallButton("Cancel", () => {
    root.textContent = "";
  });
  cancel.className = "secondary";

  const save = document.createElement("button");
  save.type = "submit";
  save.className = "primary";
  save.textContent = "Save Attendance Times";
  footer.append(cancel, save);

  form.append(error, footer);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";

    const checkedInAt = checkedInInput.value
      ? eventDateTimeForDateTimeLocalValue(checkedInInput.value)
      : null;
    const checkedOutAt = checkedOutInput.value
      ? eventDateTimeForDateTimeLocalValue(checkedOutInput.value)
      : null;

    if (checkedInInput.value && !checkedInAt) {
      error.textContent = "Enter a valid check-in date and time.";
      return;
    }
    if (checkedOutInput.value && !checkedOutAt) {
      error.textContent = "Enter a valid check-out date and time.";
      return;
    }
    if (checkedOutAt && !checkedInAt) {
      error.textContent = "A check-in timestamp is required when a check-out timestamp is set.";
      return;
    }
    if (checkedInAt && checkedOutAt && checkedOutAt < checkedInAt) {
      error.textContent = "Check-out cannot be earlier than check-in.";
      return;
    }

    const checkoutMethod = checkedOutAt ? methodSelect.value : "";
    save.disabled = true;
    save.textContent = "Saving…";
    cancel.disabled = true;

    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, CHECKINS_COLLECTION, record.id);
        const snap = await tx.get(ref);
        const current = snap.exists() ? snap.data() : {};
        const currentStatus = current.status || "registered";

        let nextStatus = "registered";
        if (checkedOutAt) {
          nextStatus = "completed";
        } else if (checkedInAt) {
          nextStatus = "checked_in";
        } else if (currentStatus === "late") {
          nextStatus = "late";
        }

        const patch = {
          registrationId: record.id,
          status: nextStatus,
          checkedInAt: checkedInAt || deleteField(),
          checkedOutAt: checkedOutAt || deleteField(),
          checkoutMethod: checkedOutAt ? checkoutMethod : deleteField(),
          checkedInBy: checkedInAt
            ? (current.checkedInBy || user.uid)
            : deleteField(),
          checkedInByName: checkedInAt
            ? (current.checkedInByName || actorName)
            : deleteField(),
          checkedOutBy: checkedOutAt
            ? (current.checkedOutBy || user.uid)
            : deleteField(),
          checkedOutByName: checkedOutAt
            ? (current.checkedOutByName || actorName)
            : deleteField(),
          lateAt: nextStatus === "late"
            ? (current.lateAt || serverTimestamp())
            : deleteField(),
          updatedAt: serverTimestamp(),
          updatedBy: user.uid,
          updatedByName: actorName
        };

        const activityRef = doc(
          collection(db, CHECKIN_ACTIVITY_COLLECTION)
        );
        tx.set(ref, patch, { merge: true });
        tx.set(activityRef, {
          registrationId: record.id,
          action: "attendance_time_edit",
          actorUid: user.uid,
          actorName,
          occurredAt: serverTimestamp()
        });
      });

      root.textContent = "";
      setText(
        "checkin-message",
        "Attendance times saved for " + fullName +
          ". Other volunteers' records were not changed."
      );
    } catch (saveError) {
      console.error("[Admin Check-In] attendance time edit failed:", {
        code: saveError?.code || "unknown"
      });
      error.textContent =
        "Could not save these timestamps. Refresh and try again.";
      save.disabled = false;
      save.textContent = "Save Attendance Times";
      cancel.disabled = false;
    }
  });

  modal.card.appendChild(form);
  root.appendChild(modal.overlay);
}


/* =========================================================
   CHECK-IN TRANSACTIONS
========================================================= */

async function transitionCheckin(
  id,
  action,
  uid,
  actorName,
  checkoutAt = null,
  checkoutMethod = ""
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

        if (
          action === "checkout" &&
          (!(checkoutAt instanceof Date) ||
            Number.isNaN(checkoutAt.getTime()) ||
            !["actual_current_time", "estimated_shift_end", "custom"].includes(checkoutMethod))
        ) {
          throw new Error("invalid-checkout-time");
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
                checkoutMethod === "actual_current_time"
                  ? serverTimestamp()
                  : checkoutAt,

              checkoutMethod,

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
  const records = mergedRecords(regs, checkins);

  const counts = {
    expected: records.length,
    checkedIn: 0,
    checkedOut: 0,
    customCheckout: 0,
    notArrived: 0,
    late: 0
  };

  for (const record of records) {
    const attendance = record.checkin || {};
    const status = attendance.status;
    const method = effectiveCheckoutMethod(record);
    const hasCheckoutTime = Boolean(toDate(attendance.checkedOutAt));

    // This category represents volunteers still checked in, or whose shift-end
    // was entered as an estimated checkout after they forgot to check out.
    if (
      status === "checked_in" ||
      (status === "completed" &&
        hasCheckoutTime &&
        method === "estimated_shift_end")
    ) {
      counts.checkedIn += 1;
    }

    // The checkout rate is intentionally limited to actual/current-time
    // booth checkouts. Estimates and custom administrative entries are separate.
    if (
      status === "completed" &&
      hasCheckoutTime &&
      method === "actual_current_time"
    ) {
      counts.checkedOut += 1;
    }

    if (
      status === "completed" &&
      hasCheckoutTime &&
      method === "custom"
    ) {
      counts.customCheckout += 1;
    }

    if (status === "late") {
      counts.late += 1;
    }
  }

  counts.notArrived = Math.max(
    0,
    counts.expected -
      counts.checkedIn -
      counts.checkedOut -
      counts.customCheckout
  );

  counts.rates = {
    checkin: percent(counts.checkedIn, counts.expected),
    checkout: percent(counts.checkedOut, counts.expected),
    customCheckout: percent(counts.customCheckout, counts.expected),
    notArrived: percent(counts.notArrived, counts.expected)
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

  const stats = computeOpsStats(regs, checkins);
  root.textContent = "";

  const title = document.createElement("h2");
  title.textContent = "Today's volunteer stats";

  const list = document.createElement("div");
  list.className = "checkin-stat-list";

  [
    ["Not arrived / incomplete", stats.notArrived],
    ["Checked in only / estimated", stats.checkedIn],
    ["Actual booth checkout", stats.checkedOut],
    ["Custom/admin checkout", stats.customCheckout],
    ["Late", stats.late],
    ["Expected", stats.expected]
  ].forEach(([label, value]) => {
    const row = document.createElement("div");
    row.className = "checkin-stat-row";

    const labelEl = document.createElement("span");
    labelEl.textContent = label;

    const valueEl = document.createElement("b");
    valueEl.textContent = String(value);

    row.append(labelEl, valueEl);
    list.appendChild(row);
  });

  root.append(title, list);
}


/* =========================================================
   ACTIVITY
========================================================= */

async function initActivityPage(checkinOnly = false) {
  const type =
    $("activity-type");

  const staff =
    $("activity-staff");

  const rows =
    $("activity-list");

  if (checkinOnly) {
    staff?.closest("div")?.remove();
  }

  let items = [];

  let names =
    new Map();

  try {
    if (!checkinOnly) {
      await loadAdminDirectory();
    }

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

    if (!checkinOnly) {
      fillAdminFilter(staff);
    }

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
          "Marked late",

        attendance_time_edit:
          "Attendance times edited"
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

  await loadShiftCapacities();

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

  const totalRegistrations =
    records.length;

  const volunteerStats =
    buildUniqueVolunteerStats(
      records
    );

  const totalVolunteers =
    volunteerStats.people.size;

  // City-imported volunteers are part of the live roster and all shift/position
  // totals, but their import timestamp is not an actual signup timestamp. Keep
  // them out of time-based registration/new-volunteer analytics so a bulk
  // import does not create a false spike on the import date.
  const activityRecords =
    records.filter(
      (record) =>
        record.registrationSource !==
        "city_import"
    );

  const activityVolunteerStats =
    buildUniqueVolunteerStats(
      activityRecords
    );

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

  const byPositionRegistrations =
    Object.fromEntries(
      VOLUNTEER_POSITIONS.map(
        (position) => [
          position.id,
          0
        ]
      )
    );

  const byPositionVolunteers =
    new Map(
      VOLUNTEER_POSITIONS.map(
        (position) => [
          position.id,
          new Set()
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

  const byNewVolunteerDate =
    dateRange(
      REGISTRATION_START,
      EVENT_DATE
    ).map(
      (date) => ({
        date,
        count: 0
      })
    );

  const byNewVolunteerDateMap =
    Object.fromEntries(
      byNewVolunteerDate.map(
        (entry) => [
          isoDate(
            entry.date
          ),
          entry
        ]
      )
    );

  activityVolunteerStats.firstRegistrationDateByPerson.forEach(
    (date) => {
      const key =
        isoDate(
          date
        );

      if (
        byNewVolunteerDateMap[
          key
        ]
      ) {
        byNewVolunteerDateMap[
          key
        ].count += 1;
      }
    }
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
        byPositionRegistrations[
          record.positionId
        ] != null
      ) {
        byPositionRegistrations[
          record.positionId
        ] += 1;
      }

      if (
        byPositionVolunteers.has(
          record.positionId
        )
      ) {
        byPositionVolunteers
          .get(
            record.positionId
          )
          .add(
            volunteerIdentity(
              record
            )
          );
      }

      const submitted =
        record.registrationSource !==
          "city_import"
          ? toDate(
              record.createdAt
            )
          : null;

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

  const today =
    startOfDay(
      new Date()
    );

  const tomorrow =
    addDays(
      today,
      1
    );

  const weekStart =
    addDays(
      today,
      -6
    );

  const registrationsToday =
    countSince(
      activityRecords,
      today,
      tomorrow
    );

  const registrationsThisWeek =
    countSince(
      activityRecords,
      weekStart,
      tomorrow
    );

  const newVolunteersToday =
    countNewVolunteersSince(
      activityVolunteerStats,
      today,
      tomorrow
    );

  const newVolunteersThisWeek =
    countNewVolunteersSince(
      activityVolunteerStats,
      weekStart,
      tomorrow
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
          activityRecords.length /
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
          registrationCount:
            byPositionRegistrations[
              position.id
            ] || 0,
          volunteerCount:
            byPositionVolunteers
              .get(
                position.id
              )?.size || 0
        })
      )
      .sort(
        (a, b) =>
          b.volunteerCount -
          a.volunteerCount ||
          b.registrationCount -
          a.registrationCount
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
      dayOfCheckoutMethodPanel(
        records
      ),
      dayOfDurationPanel(
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
        "Unique volunteers",
        totalVolunteers,
        "Distinct first + last names, normalized"
      ],
      [
        "Total registrations",
        totalRegistrations,
        "Shift signups; one volunteer may have multiple"
      ],
      [
        "Average registrations / volunteer",
        totalVolunteers
          ? (
              totalRegistrations /
              totalVolunteers
            ).toFixed(1)
          : "0.0",
        "Average shifts signed up per person"
      ],
      [
        "Multi-shift volunteers",
        volunteerStats.multiShiftVolunteers,
        totalVolunteers
          ? percent(
              volunteerStats.multiShiftVolunteers,
              totalVolunteers
            ) +
            " of volunteers"
          : "0% of volunteers"
      ],
      [
        "Registrations today",
        registrationsToday,
        "Shift registrations submitted today"
      ],
      [
        "New volunteers today",
        newVolunteersToday,
        "People whose first registration was today"
      ],
      [
        "Registrations this week",
        registrationsThisWeek,
        "Last 7 calendar days"
      ],
      [
        "New volunteers this week",
        newVolunteersThisWeek,
        "People first seen in the last 7 calendar days"
      ],
      [
        "Remaining shift capacity",
        Math.max(
          0,
          capacity -
            totalRegistrations
        ),
        percent(
          totalRegistrations,
          capacity
        ) +
          " of configured capacity filled"
      ],
      [
        "Most registrations by one volunteer",
        volunteerStats.maxRegistrations,
        volunteerStats.maxRegistrationPerson ||
          "No registrations"
      ]
    ]),

    chartPanel(
      "Registrations over time",
      "Daily shift registrations from September 7 through the event date.",
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
        "Unique volunteers — " +
          totalVolunteers,
        "Total registrations — " +
          totalRegistrations,
        "Average registrations per day — " +
          average,
        "Highest-registration day — " +
          shortDate(
            highestDay.date
          ) +
          " (" +
          highestDay.count +
          ")"
      ]
    ),

    chartPanel(
      "New volunteers over time",
      "Daily count of people whose first registration occurred on or after September 7.",
      byNewVolunteerDate.map(
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
        "Unique volunteers — " +
          totalVolunteers,
        "Multi-shift volunteers — " +
          volunteerStats.multiShiftVolunteers
      ]
    ),

    chartPanel(
      "Shift analytics",
      "Registrations for each event shift. Each shift has its own capacity.",
      shiftCounts.map(
        (shift) => ({
          label:
            shift.positionName +
            " · " +
            formatShiftTime(
              shift
            ),
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
        chartClass:
          "chart-angled-labels",
        listClass:
          "appointment-list"
      }
    ),

    chartPanel(
      "Position analytics",
      "Unique volunteers by position. Registration totals are shown below so repeat shifts are not mistaken for additional people.",
      positionRows.map(
        (position) => ({
          label:
            position.name,
          value:
            position.volunteerCount
        })
      ),
      positionLeaderboardRows(
        positionRows,
        totalVolunteers
      ),
      {
        panelClass:
          "position-panel",
        chartClass:
          "chart-angled-labels",
        listClass:
          "leaderboard-list"
      }
    )
  );
}

/* =========================================================
   UNIQUE VOLUNTEER STATISTICS
========================================================= */

function volunteerIdentity(
  record
) {
  const first =
    normalizeFirstName(
      record.firstName
    );

  const last =
    normalizeLastName(
      record.lastName
    );

  if (
    first &&
    last
  ) {
    return first + "|" + last;
  }

  return "registration:" +
    String(
      record.id
    );
}


function buildUniqueVolunteerStats(
  records
) {
  const people =
    new Map();

  const firstRegistrationDateByPerson =
    new Map();

  records.forEach(
    (record) => {
      const identity =
        volunteerIdentity(
          record
        );

      if (!people.has(identity)) {
        people.set(
          identity,
          {
            name:
              (
                (record.firstName || "") +
                " " +
                (record.lastName || "")
              ).trim() ||
              "Unnamed volunteer",

            registrations: 0
          }
        );
      }

      const person =
        people.get(
          identity
        );

      person.registrations += 1;

      const created =
        toDate(
          record.createdAt
        );

      if (
        created &&
        (
          !firstRegistrationDateByPerson.has(
            identity
          ) ||
          created <
            firstRegistrationDateByPerson.get(
              identity
            )
        )
      ) {
        firstRegistrationDateByPerson.set(
          identity,
          created
        );
      }
    }
  );

  let maxRegistrations = 0;
  let maxRegistrationPerson = "";

  people.forEach(
    (person) => {
      if (
        person.registrations >
        maxRegistrations
      ) {
        maxRegistrations =
          person.registrations;

        maxRegistrationPerson =
          person.name;
      }
    }
  );

  return {
    people,
    firstRegistrationDateByPerson,
    multiShiftVolunteers:
      Array.from(
        people.values()
      ).filter(
        (person) =>
          person.registrations > 1
      ).length,
    maxRegistrations,
    maxRegistrationPerson
  };
}


function countNewVolunteersSince(
  volunteerStats,
  start,
  end
) {
  let count = 0;

  volunteerStats.firstRegistrationDateByPerson.forEach(
    (date) => {
      if (
        date >= start &&
        date < end
      ) {
        count += 1;
      }
    }
  );

  return count;
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
          )}: ${shift.count} of ${shift.capacity} registrations filled (${Math.round(
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
        "#" +
          (index + 1) +
          " " +
          position.name +
          " — " +
          position.volunteerCount +
          " unique volunteers · " +
          position.registrationCount +
          " registrations (" +
          percent(
            position.volunteerCount,
            total
          ) +
          ")",

      className:
        "leaderboard-row"
    })
  );
}


/* =========================================================
   DAY-OF STATISTICS
========================================================= */

function formatDurationMinutes(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "N/A";
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const remainingMinutes = rounded % 60;
  if (hours === 0) return remainingMinutes + " min";
  if (remainingMinutes === 0) return hours + " hr";
  return hours + " hr " + remainingMinutes + " min";
}

function computeAttendanceInsights(records) {
  let actualCheckoutCount = 0;
  let estimatedCheckoutCount = 0;
  let customCheckoutCount = 0;
  let completedWithCheckoutTime = 0;
  let missingTimestampCount = 0;

  const durations = [];
  let actualMinutes = 0;
  let estimatedMinutes = 0;
  let customMinutes = 0;
  let actualTimedShifts = 0;
  let estimatedTimedShifts = 0;
  let customTimedShifts = 0;

  records.forEach((record) => {
    const attendance = record.checkin || {};
    const checkInDate = toDate(attendance.checkedInAt);
    const checkOutDate = toDate(attendance.checkedOutAt);
    const method = effectiveCheckoutMethod(record);

    if (attendance.status === "completed" && checkOutDate) {
      completedWithCheckoutTime += 1;
      if (method === "estimated_shift_end") {
        estimatedCheckoutCount += 1;
      } else if (method === "custom") {
        customCheckoutCount += 1;
      } else {
        // Legacy records are actual checkouts: the old code saved server time.
        actualCheckoutCount += 1;
      }
    }

    if (
      attendance.status === "completed" &&
      checkInDate &&
      checkOutDate &&
      checkOutDate >= checkInDate
    ) {
      const minutes = (checkOutDate.getTime() - checkInDate.getTime()) / 60000;
      durations.push(minutes);

      if (method === "estimated_shift_end") {
        estimatedMinutes += minutes;
        estimatedTimedShifts += 1;
      } else if (method === "custom") {
        customMinutes += minutes;
        customTimedShifts += 1;
      } else {
        actualMinutes += minutes;
        actualTimedShifts += 1;
      }
    } else if (
      attendance.status === "checked_in" ||
      (attendance.status === "completed" && (!checkInDate || !checkOutDate))
    ) {
      missingTimestampCount += 1;
    }
  });

  durations.sort((a, b) => a - b);
  const totalMinutes = durations.reduce((sum, value) => sum + value, 0);
  const midpoint = Math.floor(durations.length / 2);
  const medianMinutes = durations.length
    ? (durations.length % 2
      ? durations[midpoint]
      : (durations[midpoint - 1] + durations[midpoint]) / 2)
    : 0;

  return {
    actualCheckoutCount,
    estimatedCheckoutCount,
    customCheckoutCount,
    completedWithCheckoutTime,
    timedShifts: durations.length,
    missingTimestampCount,
    totalHours: totalMinutes / 60,
    averageMinutes: durations.length ? totalMinutes / durations.length : 0,
    medianMinutes,
    longestMinutes: durations.length ? durations[durations.length - 1] : 0,
    actualHours: actualMinutes / 60,
    estimatedHours: estimatedMinutes / 60,
    customHours: customMinutes / 60,
    actualTimedShifts,
    estimatedTimedShifts,
    customTimedShifts
  };
}


function dayOfOverview(records) {
  const stats = computeOpsStats(
    records,
    new Map(records.map((record) => [
      record.id,
      record.checkin || { status: "registered" }
    ]))
  );
  const insights = computeAttendanceInsights(records);

  return statGrid([
    ["Expected shift assignments", stats.expected, "Volunteer registrations for the event"],
    ["Checked in only / estimated", stats.checkedIn, "Includes currently checked-in volunteers and admin shift-end placeholders"],
    ["Actual booth checkouts", stats.checkedOut, stats.rates.checkout + " of expected registrations"],
    ["Custom/admin-adjusted checkouts", stats.customCheckout, stats.rates.customCheckout + " of expected registrations"],
    ["Not arrived / incomplete", stats.notArrived, stats.rates.notArrived + " of expected registrations"],
    ["Total logged volunteering hours", insights.totalHours.toFixed(1), "Includes estimated shift-end placeholders"],
    ["Average completed shift", formatDurationMinutes(insights.averageMinutes), insights.timedShifts + " shifts with valid timestamps"],
    ["Estimated shift-end checkouts", insights.estimatedCheckoutCount, "Admin placeholder for volunteers who forgot to check out"]
  ]);
}


function dayOfStatsPanel(records) {
  const stats = computeOpsStats(
    records,
    new Map(records.map((record) => [
      record.id,
      record.checkin || { status: "registered" }
    ]))
  );
  const insights = computeAttendanceInsights(records);

  return chartPanel(
    "Attendance completion",
    "Checked-in-only includes volunteers still checked in and those given a shift-end estimate. Actual checkout includes only booth checkouts recorded at current time.",
    [
      { label: "Expected", value: stats.expected },
      { label: "Checked in only / estimate", value: stats.checkedIn },
      { label: "Actual booth checkout", value: stats.checkedOut },
      { label: "Custom/admin time", value: stats.customCheckout },
      { label: "Not arrived", value: stats.notArrived }
    ],
    [
      "Check-in rate (includes shift-end estimates) — " + stats.rates.checkin,
      "Actual/current-time checkout rate — " + stats.rates.checkout,
      "Custom/admin-adjusted checkout rate — " + stats.rates.customCheckout,
      "Valid timed shifts — " + insights.timedShifts,
      "Incomplete/missing timestamps — " + insights.missingTimestampCount
    ]
  );
}


function dayOfCheckoutMethodPanel(records) {
  const insights = computeAttendanceInsights(records);
  return chartPanel(
    "Checkout method split",
    "Actual/current-time means staff processed checkout at the booth. Estimated shift end means an administrator used the scheduled shift end as a placeholder. Custom indicates an explicitly adjusted time.",
    [
      { label: "Actual / current", value: insights.actualCheckoutCount },
      { label: "Estimated shift end", value: insights.estimatedCheckoutCount },
      { label: "Custom / adjusted", value: insights.customCheckoutCount }
    ],
    [
      "Completed with checkout timestamps — " + insights.completedWithCheckoutTime,
      "Legacy records are treated as actual/current-time unless the saved timestamp exactly matches that shift's scheduled end, which is inferred as estimated.",
      "Estimates remain separately identified in individual volunteer records."
    ]
  );
}


function dayOfDurationPanel(records) {
  const insights = computeAttendanceInsights(records);
  return chartPanel(
    "Volunteer hours and shift duration",
    "Calculated from recorded check-in and check-out timestamps. Estimated shift-end checkouts are included, so total hours may include estimated rather than verified time.",
    [
      { label: "Total hours", value: Number(insights.totalHours.toFixed(1)) },
      { label: "Actual hours", value: Number(insights.actualHours.toFixed(1)) },
      { label: "Estimated hours", value: Number(insights.estimatedHours.toFixed(1)) },
      { label: "Custom-time hours", value: Number(insights.customHours.toFixed(1)) }
    ],
    [
      "Completed shifts with valid timestamp pairs — " + insights.timedShifts,
      "Average — " + formatDurationMinutes(insights.averageMinutes),
      "Median — " + formatDurationMinutes(insights.medianMinutes),
      "Longest — " + formatDurationMinutes(insights.longestMinutes),
      "Actual-time shifts — " + insights.actualTimedShifts +
        " · Estimated — " + insights.estimatedTimedShifts +
        " · Custom — " + insights.customTimedShifts
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
          <th>Checked In Only / Estimate</th>
          <th>Actual Checkout</th>
          <th>Custom Checkout</th>
          <th>Not Arrived</th>
          <th>Timed Shifts</th>
          <th>Logged Hours</th>
          <th>Avg. Duration</th>
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

      const shiftRecords = mergedRecords(regs, checkins)
        .filter((record) => record.shiftId === shift.id);
      const durationStats = computeAttendanceInsights(shiftRecords);

      [
        shift.positionName,

        formatShiftTime(
          shift
        ),

        s.expected,

        s.checkedIn,

        s.checkedOut,

        s.customCheckout,

        s.notArrived,

        durationStats.timedShifts,

        durationStats.totalHours.toFixed(1),

        formatDurationMinutes(durationStats.averageMinutes)
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
  const win = window.open("", "_blank");
  if (!win) return;

  const reportRecords = (records || []).map((record) => ({
    ...record,
    checkin: record.checkin || { status: "registered" }
  }));

  const expected = reportRecords.length;
  const people = new Set();
  const positionMap = new Map();
  const shiftMap = new Map();
  const durationEntries = [];
  const checkoutCounts = { actual: 0, estimated: 0, custom: 0, open: 0, noCheckin: 0 };
  let attendedCount = 0;
  let checkinEstimatedCount = 0;
  let lateNoCheckin = 0;
  let adultCount = 0;
  let minorCount = 0;
  let ageUnknownCount = 0;
  let actualMinutes = 0;
  let estimatedMinutes = 0;
  let customMinutes = 0;

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    })[char]);
  }

  function fmtRate(value, total) {
    return total ? Math.round((value / total) * 100) + "%" : "—";
  }

  function fmtMinutes(value) {
    if (!Number.isFinite(value) || value < 0) return "—";
    const rounded = Math.round(value);
    const hours = Math.floor(rounded / 60);
    const minutes = rounded % 60;
    if (hours && minutes) return hours + "h " + minutes + "m";
    if (hours) return hours + "h";
    return minutes + "m";
  }

  function fmtHours(value) {
    return (Number.isFinite(value) ? value : 0).toLocaleString("en-US", {
      maximumFractionDigits: 1,
      minimumFractionDigits: 0
    }) + " h";
  }

  function fmtLongDate(value) {
    return formatDriveDate(value) || "Event date not set";
  }

  function attended(record) {
    const status = record.checkin?.status || "registered";
    return status === "checked_in" ||
      status === "completed" ||
      Boolean(toDate(record.checkin?.checkedInAt)) ||
      Boolean(toDate(record.checkin?.checkedOutAt));
  }

  function checkoutType(record) {
    const status = record.checkin?.status || "registered";
    const checkInAt = toDate(record.checkin?.checkedInAt);
    const checkOutAt = toDate(record.checkin?.checkedOutAt);
    const method = effectiveCheckoutMethod(record);

    if (status === "completed" && checkOutAt) {
      if (method === "estimated_shift_end") return "estimated";
      if (method === "custom") return "custom";
      return "actual";
    }
    if (status === "checked_in" || (checkInAt && !checkOutAt)) return "open";
    if (status === "completed" || checkInAt || checkOutAt) return "open";
    return "noCheckin";
  }

  function nameKey(record) {
    const name = [record.firstName, record.lastName]
      .filter(Boolean)
      .join(" ")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (name) return "name:" + name;
    const email = String(record.email || "").trim().toLocaleLowerCase();
    return email ? "email:" + email : "registration:" + record.id;
  }

  function addDuration(record, positionGroup, shiftGroup) {
    const checkInAt = toDate(record.checkin?.checkedInAt);
    const checkOutAt = toDate(record.checkin?.checkedOutAt);
    if (!checkInAt || !checkOutAt || checkOutAt < checkInAt) return;

    const minutes = (checkOutAt.getTime() - checkInAt.getTime()) / 60000;
    const method = effectiveCheckoutMethod(record);
    durationEntries.push({
      minutes,
      method,
      shiftLabel: shiftGroup.label,
      positionLabel: positionGroup.label
    });
    positionGroup.durations.push(minutes);
    shiftGroup.durations.push(minutes);

    if (minutes > shiftGroup.longestMinutes) {
      shiftGroup.longestMinutes = minutes;
      shiftGroup.longestMethod = method;
    }
    if (minutes > positionGroup.longestMinutes) positionGroup.longestMinutes = minutes;

    if (method === "estimated_shift_end") estimatedMinutes += minutes;
    else if (method === "custom") customMinutes += minutes;
    else actualMinutes += minutes;
  }

  reportRecords.forEach((record) => {
    people.add(nameKey(record));

    const currentStatus = record.checkin?.status || "registered";
    if (
      currentStatus === "checked_in" ||
      (currentStatus === "completed" &&
        toDate(record.checkin?.checkedOutAt) &&
        effectiveCheckoutMethod(record) === "estimated_shift_end")
    ) {
      checkinEstimatedCount += 1;
    }

    if (record.is18OrOlder === true) adultCount += 1;
    else if (record.is18OrOlder === false) minorCount += 1;
    else ageUnknownCount += 1;

    const positionId = String(record.positionId || "unassigned");
    const positionName = positionLabel(
      record.positionId,
      record.positionName || record.position || "Unassigned"
    ) || "Unassigned";
    if (!positionMap.has(positionId)) {
      positionMap.set(positionId, {
        id: positionId, label: positionName, expected: 0, showed: 0,
        noShows: 0, late: 0, durations: [], longestMinutes: 0
      });
    }
    const positionGroup = positionMap.get(positionId);
    positionGroup.expected += 1;

    const shiftId = String(record.shiftId || record.shiftLabel || "unscheduled");
    const shiftKey = positionId + "::" + shiftId;
    const shiftName = shiftLabel(record.shiftId, record.shiftLabel || "Shift not specified") || "Shift not specified";
    if (!shiftMap.has(shiftKey)) {
      shiftMap.set(shiftKey, {
        id: shiftKey,
        label: positionName + " · " + shiftName,
        position: positionName,
        expected: 0,
        showed: 0,
        noShows: 0,
        durations: [],
        longestMinutes: 0,
        longestMethod: "actual_current_time"
      });
    }
    const shiftGroup = shiftMap.get(shiftKey);
    shiftGroup.expected += 1;

    if (attended(record)) {
      attendedCount += 1;
      positionGroup.showed += 1;
      shiftGroup.showed += 1;
    } else {
      positionGroup.noShows += 1;
      shiftGroup.noShows += 1;
      if ((record.checkin?.status || "") === "late") {
        positionGroup.late += 1;
        lateNoCheckin += 1;
      }
    }

    checkoutCounts[checkoutType(record)] += 1;
    addDuration(record, positionGroup, shiftGroup);
  });

  const positionStats = Array.from(positionMap.values()).map((item) => {
    const durations = item.durations.slice().sort((a, b) => a - b);
    const total = durations.reduce((sum, n) => sum + n, 0);
    item.showRate = item.expected ? item.showed / item.expected : 0;
    item.avgMinutes = durations.length ? total / durations.length : 0;
    item.medianMinutes = durations.length
      ? (durations.length % 2
        ? durations[Math.floor(durations.length / 2)]
        : (durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2)
      : 0;
    item.timedCount = durations.length;
    return item;
  });

  const shiftStats = Array.from(shiftMap.values()).map((item) => {
    const durations = item.durations.slice().sort((a, b) => a - b);
    const total = durations.reduce((sum, n) => sum + n, 0);
    item.showRate = item.expected ? item.showed / item.expected : 0;
    item.avgMinutes = durations.length ? total / durations.length : 0;
    item.medianMinutes = durations.length
      ? (durations.length % 2
        ? durations[Math.floor(durations.length / 2)]
        : (durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2)
      : 0;
    item.timedCount = durations.length;
    return item;
  });

  const noShowCount = reportRecords.filter((record) => !attended(record)).length;
  const actualRate = fmtRate(checkoutCounts.actual, expected);
  const checkinEstimatedRate = fmtRate(checkinEstimatedCount, expected);
  const showRate = fmtRate(attendedCount, expected);
  const allDurations = durationEntries.map((item) => item.minutes).sort((a, b) => a - b);
  const totalMinutes = allDurations.reduce((sum, n) => sum + n, 0);
  const avgMinutes = allDurations.length ? totalMinutes / allDurations.length : 0;
  const medianMinutes = allDurations.length
    ? (allDurations.length % 2
      ? allDurations[Math.floor(allDurations.length / 2)]
      : (allDurations[allDurations.length / 2 - 1] + allDurations[allDurations.length / 2]) / 2)
    : 0;
  const longestSession = durationEntries.slice().sort((a, b) => b.minutes - a.minutes)[0] || null;
  const worstNoShowPosition = positionStats.slice().sort((a, b) =>
    b.noShows - a.noShows || b.expected - a.expected
  )[0] || null;
  const bestPosition = positionStats.filter((item) => item.expected >= 2)
    .sort((a, b) => b.showRate - a.showRate || b.expected - a.expected)[0] ||
    positionStats.slice().sort((a, b) => b.showRate - a.showRate || b.expected - a.expected)[0] ||
    null;
  const fullestPosition = positionStats.slice().sort((a, b) =>
    b.expected - a.expected || b.showed - a.showed
  )[0] || null;
  const longestAverageShift = shiftStats.filter((item) => item.timedCount > 0)
    .sort((a, b) => b.avgMinutes - a.avgMinutes || b.timedCount - a.timedCount)[0] || null;
  const zeroNoShowShifts = shiftStats.filter((item) =>
    item.expected >= 2 && item.showed === item.expected
  );
  const singleBookingPerfectShifts = shiftStats.filter((item) =>
    item.expected === 1 && item.showed === 1
  );
  const completedCount = checkoutCounts.actual + checkoutCounts.estimated + checkoutCounts.custom;
  const estimatedRateOfCompleted = completedCount ? checkoutCounts.estimated / completedCount : 0;

  const palette = ["#6d28d9", "#8b5cf6", "#a78bfa", "#c4b5fd", "#ddd6fe", "#4c1d95", "#ede9fe", "#b8a5d8"];
  const mutedColors = {
    actual: "#6d28d9",
    estimated: "#a78bfa",
    custom: "#c4b5fd",
    open: "#6b7280",
    noCheckin: "#e5e7eb"
  };

  function donut(items, centerNumber, centerLabel) {
    const nonzero = items.filter((item) => item.value > 0);
    const total = items.reduce((sum, item) => sum + item.value, 0);
    const circumference = 2 * Math.PI * 62;
    let offset = 0;
    const segments = nonzero.map((item, index) => {
      const length = total ? circumference * item.value / total : 0;
      const color = item.color || palette[index % palette.length];
      const segment = "<circle cx='100' cy='100' r='62' fill='none' stroke='" + color +
        "' stroke-width='23' stroke-dasharray='" + length.toFixed(3) + " " +
        (circumference - length).toFixed(3) + "' stroke-dashoffset='" + (-offset).toFixed(3) +
        "' transform='rotate(-90 100 100)'/>";
      offset += length;
      return segment;
    }).join("");

    const legend = items.map((item, index) => {
      const color = item.color || palette[index % palette.length];
      return "<div class='legend-row'><span class='legend-swatch' style='background:" + color +
        "'></span><span class='legend-label'>" + esc(item.label) +
        "</span><strong>" + item.value + "</strong><span class='legend-percent'>" +
        fmtRate(item.value, total) + "</span></div>";
    }).join("");

    return "<div class='donut-layout'><div class='donut-graphic'><svg viewBox='0 0 200 200' role='img' aria-label='" +
      esc(centerLabel) + "'><circle cx='100' cy='100' r='62' fill='none' stroke='#f0edf5' stroke-width='23'/>" +
      segments + "<circle cx='100' cy='100' r='45' fill='#fff'/>" +
      "<text x='100' y='96' text-anchor='middle' class='donut-number'>" + esc(centerNumber) +
      "</text><text x='100' y='116' text-anchor='middle' class='donut-caption'>" + esc(centerLabel) +
      "</text></svg></div><div class='legend'>" + legend + "</div></div>";
  }

  function positionBarChart(items) {
    if (!items.length) return "<p class='empty'>No position registrations were found.</p>";
    const maxExpected = Math.max(1, ...items.map((item) => item.expected));
    const barX = 236;
    const plotWidth = 420;
    const rateX = 768;
    const rowHeight = 38;
    const height = items.length * rowHeight + 22;
    const rows = items.map((item, index) => {
      const y = 25 + index * rowHeight;
      const totalWidth = plotWidth * item.expected / maxExpected;
      const showedWidth = totalWidth * item.showed / item.expected;
      const noShowWidth = Math.max(0, totalWidth - showedWidth);
      return "<text x='8' y='" + (y + 14) + "' class='svg-label'>" + esc(item.label) +
        "</text><rect x='" + barX + "' y='" + y + "' width='" + showedWidth.toFixed(2) +
        "' height='17' rx='4' fill='#7c3aed'/><rect x='" + (barX + showedWidth).toFixed(2) +
        "' y='" + y + "' width='" + noShowWidth.toFixed(2) +
        "' height='17' rx='2' fill='#e9d5ff'/><text x='" + (barX + totalWidth + 8).toFixed(2) +
        "' y='" + (y + 13) + "' class='svg-small'>" + item.showed + "/" + item.expected +
        "</text><text x='" + rateX + "' y='" + (y + 14) +
        "' class='svg-rate'>" + fmtRate(item.showed, item.expected) + "</text>";
    }).join("");
    return "<svg class='report-chart' viewBox='0 0 790 " + height +
      "' role='img' aria-label='Attendance counts by volunteer position'>" + rows + "</svg>";
  }

  function shiftRateChart(items) {
    if (!items.length) return "<p class='empty'>No shifts with registrations were found.</p>";
    const barX = 280;
    const plotWidth = 380;
    const rateX = 744;
    const rowHeight = 35;
    const height = items.length * rowHeight + 20;
    const rows = items.map((item, index) => {
      const y = 18 + index * rowHeight;
      const width = plotWidth * item.showRate;
      return "<text x='6' y='" + (y + 14) + "' class='svg-label'>" + esc(item.label) +
        "</text><rect x='" + barX + "' y='" + y + "' width='" + plotWidth +
        "' height='15' rx='4' fill='#f3f0f7'/><rect x='" + barX + "' y='" + y +
        "' width='" + width.toFixed(2) + "' height='15' rx='4' fill='#7c3aed'/>" +
        "<text x='" + rateX + "' y='" + (y + 13) + "' class='svg-rate'>" +
        fmtRate(item.showed, item.expected) + " · " + item.showed + "/" + item.expected + "</text>";
    }).join("");
    return "<svg class='report-chart' viewBox='0 0 800 " + height +
      "' role='img' aria-label='Show rates for selected volunteer shifts'>" + rows + "</svg>";
  }

  function reportTable(headers, rows, tableClass) {
    if (!rows.length) return "<p class='empty'>No records are available for this section.</p>";
    return "<table class='" + (tableClass || "") + "'><thead><tr>" +
      headers.map((item) => "<th>" + esc(item) + "</th>").join("") +
      "</tr></thead><tbody>" +
      rows.map((row) => "<tr>" + row.map((item) => "<td>" + esc(item) + "</td>").join("") + "</tr>").join("") +
      "</tbody></table>";
  }

  function insight(title, body, value) {
    return "<article class='insight'><div class='insight-kicker'>" + esc(title) +
      "</div><p>" + body + "</p>" +
      (value ? "<div class='insight-value'>" + esc(value) + "</div>" : "") + "</article>";
  }

  function kpi(label, value, note) {
    return "<article class='kpi'><div class='kpi-label'>" + esc(label) +
      "</div><div class='kpi-value'>" + esc(value) +
      "</div><div class='kpi-note'>" + esc(note || "") + "</div></article>";
  }

  const attendanceMix = [
    { label: "Actual booth checkout", value: checkoutCounts.actual, color: mutedColors.actual },
    { label: "Estimated shift-end checkout", value: checkoutCounts.estimated, color: mutedColors.estimated },
    { label: "Custom/admin checkout", value: checkoutCounts.custom, color: mutedColors.custom },
    { label: "Checked in, no checkout", value: checkoutCounts.open, color: mutedColors.open },
    { label: "No check-in recorded", value: checkoutCounts.noCheckin, color: mutedColors.noCheckin }
  ];

  const positionMix = positionStats.slice().sort((a, b) => b.expected - a.expected);
  const topMix = positionMix.slice(0, 6).map((item, index) => ({
    label: item.label, value: item.expected, color: palette[index % palette.length]
  }));
  const otherPositions = positionMix.slice(6).reduce((sum, item) => sum + item.expected, 0);
  if (otherPositions) topMix.push({ label: "Other positions", value: otherPositions, color: "#d1d5db" });

  const positionTableRows = positionStats.slice().sort((a, b) =>
    b.noShows - a.noShows || b.expected - a.expected
  ).map((item) => [
    item.label, String(item.expected), String(item.showed), String(item.noShows),
    fmtRate(item.showed, item.expected), item.timedCount ? fmtMinutes(item.avgMinutes) : "No timed records"
  ]);

  const sortedShiftStats = shiftStats.slice().sort((a, b) =>
    b.noShows - a.noShows || b.expected - a.expected || a.showRate - b.showRate
  );
  const shiftTableRows = sortedShiftStats.map((item) => [
    item.label, String(item.expected), String(item.showed), String(item.noShows),
    fmtRate(item.showed, item.expected),
    item.timedCount ? fmtMinutes(item.avgMinutes) : "—",
    item.timedCount ? fmtMinutes(item.longestMinutes) : "—"
  ]);

  const worstShifts = shiftStats.filter((item) => item.expected > 0)
    .sort((a, b) => a.showRate - b.showRate || b.noShows - a.noShows || b.expected - a.expected)
    .slice(0, 12);
  const durationShifts = shiftStats.filter((item) => item.timedCount > 0)
    .sort((a, b) => b.avgMinutes - a.avgMinutes || b.timedCount - a.timedCount)
    .slice(0, 8);
  const ageMix = [
    { label: "18 or older", value: adultCount, color: "#6d28d9" },
    { label: "Under 18", value: minorCount, color: "#a78bfa" },
    { label: "Not provided", value: ageUnknownCount, color: "#e5e7eb" }
  ];

  const insights = [];
  if (worstNoShowPosition && worstNoShowPosition.noShows > 0) {
    insights.push(insight(
      "No-show concentration",
      "<strong>" + esc(worstNoShowPosition.label) + "</strong> had the highest number of registrations without a recorded check-in.",
      worstNoShowPosition.noShows + " of " + worstNoShowPosition.expected + " · " +
        fmtRate(worstNoShowPosition.noShows, worstNoShowPosition.expected) + " no-shows"
    ));
  }
  if (bestPosition) {
    insights.push(insight(
      "Strongest attendance rate",
      "<strong>" + esc(bestPosition.label) + "</strong> had the highest observed show rate among positions with " +
        (bestPosition.expected >= 2 ? "at least two registrations." : "available registrations."),
      bestPosition.showed + " of " + bestPosition.expected + " · " + fmtRate(bestPosition.showed, bestPosition.expected) + " showed"
    ));
  }
  if (fullestPosition) {
    insights.push(insight(
      "Largest volunteer role",
      "<strong>" + esc(fullestPosition.label) + "</strong> accounted for the most booked volunteer shifts.",
      fullestPosition.expected + " registrations"
    ));
  }
  if (zeroNoShowShifts.length) {
    insights.push(insight(
      "Full-attendance shifts",
      zeroNoShowShifts.length + " shift" + (zeroNoShowShifts.length === 1 ? "" : "s") +
        " with at least two bookings had no recorded no-shows.",
      zeroNoShowShifts.slice(0, 3).map((item) =>
        item.label + " (" + item.expected + "/" + item.expected + ")"
      ).join(" · ")
    ));
  } else if (singleBookingPerfectShifts.length) {
    insights.push(insight(
      "Full attendance on smaller shifts",
      singleBookingPerfectShifts.length + " shift" + (singleBookingPerfectShifts.length === 1 ? "" : "s") +
        " had one booking and a recorded check-in. These small samples are less conclusive.",
      singleBookingPerfectShifts.slice(0, 3).map((item) => item.label).join(" · ")
    ));
  }
  if (longestAverageShift) {
    insights.push(insight(
      "Longest average recorded duration",
      "<strong>" + esc(longestAverageShift.label) + "</strong> had the longest average recorded session among shifts with usable check-in and checkout timestamps.",
      fmtMinutes(longestAverageShift.avgMinutes) + " average · " + longestAverageShift.timedCount + " timed records"
    ));
  }
  if (longestSession) {
    const methodLabels = {
      actual_current_time: "actual booth checkout",
      estimated_shift_end: "estimated shift end",
      custom: "custom/admin time"
    };
    insights.push(insight(
      "Longest individual recorded session",
      "The longest recorded session was in <strong>" + esc(longestSession.shiftLabel) +
        "</strong>. Its end time was classified as " + esc(methodLabels[longestSession.method] || "a recorded checkout") + ".",
      fmtMinutes(longestSession.minutes)
    ));
  }

  const generatedAt = new Date().toLocaleString("en-US", {
    month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    timeZone: EVENT_TIME_ZONE
  }) + " " + EVENT_TIME_ZONE_LABEL;

  const styleLines = [
    ":root{color-scheme:light;--purple:#6d28d9;--purple-dark:#4c1d95;--purple-soft:#f5f3ff;--lavender:#ddd6fe;--ink:#242033;--muted:#716b7d;--line:#e8e4ed;--paper:#fff;--wash:#faf9fc}",
    "*{box-sizing:border-box}",
    "html{background:#f2eff7}",
    "body{margin:0;background:#f2eff7;color:var(--ink);font:10.5pt/1.52 Inter,Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}",
    ".toolbar{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 22px;background:#fff;border-bottom:1px solid var(--line)}",
    ".toolbar span{font-size:10pt;color:var(--muted)}.print-button{background:var(--purple);color:white;border:0;border-radius:999px;padding:10px 17px;font:inherit;font-weight:700;cursor:pointer}",
    ".page{width:8.5in;min-height:10.4in;margin:22px auto;padding:.58in .62in;background:white;box-shadow:0 8px 34px rgba(40,25,70,.08);page-break-after:always;break-after:page;position:relative;overflow:hidden}",
    ".page:last-child{page-break-after:auto;break-after:auto}",
    ".cover{padding:.8in .72in;display:flex;flex-direction:column;justify-content:space-between;min-height:10.4in;background:linear-gradient(145deg,#fff 0%,#fff 68%,#f8f5ff 100%)}",
    ".cover-rule{height:7px;width:74px;background:var(--purple);border-radius:10px;margin-bottom:25px}",
    ".eyebrow{font-size:9pt;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--purple)}",
    ".cover h1{font-size:39pt;line-height:1.05;letter-spacing:-.045em;max-width:6.1in;margin:20px 0 18px;font-weight:750}",
    ".cover-subtitle{font-size:16pt;line-height:1.35;color:#5d526d;max-width:5.7in}",
    ".cover-meta{margin-top:30px;display:grid;grid-template-columns:1fr 1fr;gap:18px;max-width:5.8in}",
    ".meta-label{display:block;text-transform:uppercase;letter-spacing:.09em;font-size:8pt;color:var(--muted);font-weight:700;margin-bottom:4px}.meta-value{font-size:11pt;font-weight:650}",
    ".cover-bottom{border-top:1px solid var(--line);padding-top:22px;display:flex;justify-content:space-between;gap:20px;align-items:end}.byline{font-size:11pt;font-weight:700}.small-muted{font-size:8.5pt;color:var(--muted)}",
    ".cover-mark{position:absolute;right:-95px;top:2.1in;width:3.6in;height:3.6in;border:1px solid #e9e2fa;border-radius:50%;box-shadow:0 0 0 26px #f9f7ff,0 0 0 54px #fcfbff}",
    ".cover-mark:before,.cover-mark:after{content:'';position:absolute;inset:22%;border:1px solid #e5dafa;border-radius:50%}.cover-mark:after{inset:40%;background:#7c3aed;border:0;box-shadow:0 0 0 12px #eee6ff}",
    ".page-head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:23px}",
    ".page-title{margin:4px 0 0;font-size:23pt;line-height:1.15;letter-spacing:-.03em;font-weight:750}.page-subtitle{font-size:9pt;color:var(--muted);margin-top:7px;max-width:5.8in}.section-number{font-size:8pt;letter-spacing:.12em;text-transform:uppercase;color:var(--purple);font-weight:800;white-space:nowrap;padding-top:5px}",
    ".kpi-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:18px 0 22px}",
    ".kpi{border:1px solid var(--line);padding:14px 15px;border-radius:12px;min-height:94px;background:#fff;break-inside:avoid}.kpi-label{font-size:8pt;color:var(--muted);font-weight:700}.kpi-value{font-size:25pt;line-height:1.2;font-weight:750;letter-spacing:-.035em;margin:3px 0 2px;color:var(--purple-dark)}.kpi-note{font-size:8pt;color:var(--muted)}",
    ".section-title{font-size:14pt;line-height:1.2;margin:21px 0 5px;letter-spacing:-.015em}.section-note{font-size:8.5pt;color:var(--muted);margin:0 0 12px;max-width:7in}",
    ".panel{border:1px solid var(--line);border-radius:13px;padding:16px 17px;margin:12px 0 16px;break-inside:avoid}.panel-title{font-size:11pt;font-weight:750;margin:0 0 5px}.panel-note{font-size:8pt;color:var(--muted);margin:0 0 11px}",
    ".two-col{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}.donut-layout{display:grid;grid-template-columns:170px minmax(0,1fr);align-items:center;gap:12px}.donut-graphic svg{width:100%;height:auto;display:block}.donut-number{font-size:23px;font-weight:750;fill:var(--ink)}.donut-caption{font-size:9px;fill:var(--muted)}",
    ".legend{min-width:0}.legend-row{display:grid;grid-template-columns:9px minmax(0,1fr) 27px 34px;gap:7px;align-items:center;margin:7px 0;font-size:8pt}.legend-swatch{width:8px;height:8px;border-radius:2px}.legend-label{color:#514b5d}.legend-row strong{text-align:right;font-weight:750}.legend-percent{text-align:right;color:var(--muted);font-size:7.5pt}",
    ".insight-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:12px 0}.insight{border-top:2px solid #b9a2ee;background:var(--wash);padding:12px 14px;break-inside:avoid}.insight-kicker{font-size:8pt;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--purple)}.insight p{margin:7px 0 0;font-size:9pt}.insight-value{font-size:9pt;font-weight:750;margin-top:7px;color:var(--purple-dark)}",
    ".report-chart{display:block;width:100%;height:auto;max-height:none;overflow:visible}.svg-label{font:10px Inter,Arial,sans-serif;fill:#42394f}.svg-small{font:9px Inter,Arial,sans-serif;fill:#716b7d}.svg-rate{font:10px Inter,Arial,sans-serif;fill:#4c1d95;font-weight:700}",
    ".chart-legend{display:flex;flex-wrap:wrap;gap:14px;margin:9px 0 0;font-size:8pt;color:var(--muted)}.chart-legend span{display:flex;align-items:center;gap:6px}.chart-legend i{display:inline-block;width:9px;height:9px;border-radius:2px}",
    "table{border-collapse:collapse;width:100%;font-size:8.2pt;margin:10px 0 14px;line-height:1.35}thead{display:table-header-group}th{font-size:7.3pt;text-transform:uppercase;letter-spacing:.04em;text-align:left;color:#5e556b;background:#f5f2fa;font-weight:800}th,td{border-bottom:1px solid var(--line);padding:8px 7px;vertical-align:top;overflow-wrap:anywhere}tbody tr:nth-child(even){background:#fcfbfe}td:first-child{font-weight:650}table.compact th,table.compact td{padding:6px 5px;font-size:7.7pt}",
    ".note-box{border-left:3px solid var(--purple);background:#faf8ff;padding:12px 14px;font-size:8.5pt;color:#514b5d;margin:14px 0}.note-box strong{color:var(--purple-dark)}",
    ".empty{padding:20px 0;color:var(--muted);font-size:9pt}.page-foot{position:absolute;bottom:.28in;left:.62in;right:.62in;border-top:1px solid var(--line);padding-top:8px;display:flex;justify-content:space-between;gap:12px;font-size:7.4pt;color:#938b9e}",
    ".tag{display:inline-block;border-radius:999px;background:var(--purple-soft);color:var(--purple-dark);padding:4px 8px;font-size:7.7pt;font-weight:700}",
    "@page{size:Letter portrait;margin:0} @media print{html,body{background:#fff}.toolbar{display:none}.page{margin:0;width:auto;min-height:10.5in;padding:.55in .6in;box-shadow:none;overflow:visible}.cover{padding:.78in .7in;min-height:10.5in}.page-foot{left:.6in;right:.6in}.page:last-child{page-break-after:auto}.panel,.insight,.kpi{break-inside:avoid}table tr{break-inside:avoid}.cover-mark{opacity:.75}}",
    "@media screen and (max-width:800px){.page{width:100%;margin:10px auto;padding:26px 22px;min-height:auto}.cover{min-height:760px}.cover h1{font-size:31pt}.kpi-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.two-col{grid-template-columns:1fr}.donut-layout{grid-template-columns:145px minmax(0,1fr)}.page-foot{position:static;margin-top:30px}.insight-grid{grid-template-columns:1fr}.cover-mark{right:-180px;opacity:.5}}"
  ];

  const attendanceCards = [
    kpi("Booked shift registrations", expected.toLocaleString("en-US"), "One registration represents one shift"),
    kpi("Distinct volunteers", people.size.toLocaleString("en-US"), "Deduplicated by normalized first and last name"),
    kpi("Check-in / estimated rate", checkinEstimatedRate, checkinEstimatedCount + " check-in-only or estimated-end registrations"),
    kpi("No check-in recorded", noShowCount.toLocaleString("en-US"), fmtRate(noShowCount, expected) + " of booked shifts"),
    kpi("Actual booth checkouts", checkoutCounts.actual.toLocaleString("en-US"), actualRate + " of all booked shifts"),
    kpi("Recorded volunteer time", fmtHours(totalMinutes / 60), durationEntries.length + " sessions with valid start and end timestamps")
  ];

  const executiveInsights = insights.slice(0, 4).join("");
  const remainingInsights = insights.slice(4).join("");
  const pages = [];

  pages.push(
    "<section class='page cover'><div class='cover-mark'></div><div><div class='cover-rule'></div><div class='eyebrow'>Event operations · Post-event report</div>" +
    "<h1>" + esc(CONFIG.eventName) + "<br>Volunteer Report</h1>" +
    "<p class='cover-subtitle'>Attendance, shift coverage and volunteer time. A data-led review of how the volunteer operation performed.</p>" +
    "<div class='cover-meta'><div><span class='meta-label'>Event date</span><span class='meta-value'>" +
    esc(fmtLongDate(CONFIG.eventDate)) + "</span></div><div><span class='meta-label'>Location</span><span class='meta-value'>" +
    esc(CONFIG.location || "Location not specified") + "</span></div><div><span class='meta-label'>Prepared by</span><span class='meta-value'>Shanmukha Polu<br>&amp; Sonal Sanghani</span></div><div><span class='meta-label'>Report generated</span><span class='meta-value'>" +
    esc(generatedAt) + "</span></div></div></div><div class='cover-bottom'><div><div class='byline'>Volunteer Operations Review</div><div class='small-muted'>Attendance outcomes · Role coverage · Shift-level performance · Recorded duration</div></div><div class='eyebrow'>Internal report</div></div></section>"
  );

  pages.push(
    "<section class='page'><div class='page-head'><div><div class='eyebrow'>01 / Executive summary</div><h2 class='page-title'>At a glance</h2><div class='page-subtitle'>A summary of booked shifts, recorded attendance and end-of-shift documentation for " +
    esc(CONFIG.eventName) + ".</div></div><div class='section-number'>Snapshot</div></div>" +
    "<div class='kpi-grid'>" + attendanceCards.join("") + "</div>" +
    "<div class='two-col'><div class='panel'><h3 class='panel-title'>Attendance outcomes</h3><p class='panel-note'>Each registration is counted once. Attendance recorded for " + attendedCount + " of " + expected + " registrations (" + showRate + ").</p>" +
    donut(attendanceMix, String(expected), "booked shifts") + "</div><div class='panel'><h3 class='panel-title'>What stands out</h3><p class='panel-note'>Findings are generated from the current registration and check-in records.</p>" +
    (executiveInsights || "<p class='empty'>Not enough attendance data to generate role-level findings.</p>") + "</div></div>" +
    "<h3 class='section-title'>How to read the numbers</h3><div class='note-box'><strong>Attendance is counted per shift registration.</strong> A volunteer who signed up for two shifts contributes two booked registrations to shift-level attendance, but one person to the distinct-volunteer count. A no-show means no check-in or checkout was recorded for that registration. A shift-end placeholder is reported separately from an actual booth checkout.</div>" +
    "<div class='small-muted'>Event time zone: " + esc(EVENT_TIME_ZONE_LABEL) + ". Source: volunteer registrations and recorded check-in/check-out timestamps.</div>" +
    "<div class='page-foot'><span>" + esc(CONFIG.eventName) + " · Volunteer Operations</span><span>Executive summary</span></div></section>"
  );

  pages.push(
    "<section class='page'><div class='page-head'><div><div class='eyebrow'>02 / Volunteer positions</div><h2 class='page-title'>Where coverage landed</h2><div class='page-subtitle'>Compare the size of each volunteer role with its recorded attendance outcomes.</div></div><div class='section-number'>By role</div></div>" +
    "<div class='two-col'><div class='panel'><h3 class='panel-title'>Booked shifts by position</h3><p class='panel-note'>The six largest roles are shown individually; smaller roles are combined as Other positions.</p>" +
    donut(topMix, String(expected), "registrations") + "</div><div class='panel'><h3 class='panel-title'>Show rate by position</h3><p class='panel-note'>Purple represents registrations with attendance recorded; lavender represents registrations without a recorded check-in.</p>" +
    "<div class='chart-legend'><span><i style='background:#7c3aed'></i>Showed</span><span><i style='background:#e9d5ff'></i>No check-in recorded</span></div>" +
    positionBarChart(positionStats.slice().sort((a, b) => b.noShows - a.noShows || b.expected - a.expected)) + "</div></div>" +
    "<h3 class='section-title'>Position-level results</h3><p class='section-note'>Sorted by the number of registrations without a recorded check-in, then by total bookings. This makes roles with the largest uncovered share easier to identify.</p>" +
    reportTable(["Volunteer position", "Booked", "Showed", "No-show", "Show rate", "Avg. timed session"], positionTableRows, "compact") +
    "<div class='note-box'><strong>Interpretation:</strong> A position with the highest number of no-shows is not necessarily the one with the worst percentage. Read the no-show count alongside the show rate and the number of bookings.</div>" +
    "<div class='page-foot'><span>" + esc(CONFIG.eventName) + " · Volunteer Operations</span><span>Position performance</span></div></section>"
  );

  pages.push(
    "<section class='page'><div class='page-head'><div><div class='eyebrow'>03 / Shift performance</div><h2 class='page-title'>Reliability by shift</h2><div class='page-subtitle'>Shift-level turnout and duration metrics help identify time slots that were well covered and slots that may need a different recruitment approach.</div></div><div class='section-number'>By shift</div></div>" +
    "<div class='panel'><h3 class='panel-title'>Lowest show rates</h3><p class='panel-note'>Up to 12 shifts are displayed, starting with the lowest recorded show rate. The complete shift table follows.</p>" +
    shiftRateChart(worstShifts) + "</div>" +
    "<h3 class='section-title'>All shifts</h3><p class='section-note'>Average and longest session duration are calculated only from records with both a check-in timestamp and a checkout timestamp. Estimated checkout entries are included and should be treated as estimates.</p>" +
    reportTable(["Position · shift", "Booked", "Showed", "No-show", "Show rate", "Avg. duration", "Longest"], shiftTableRows, "compact") +
    "<div class='note-box'><strong>Planning use:</strong> Review low show-rate shifts before opening the next volunteer form. Larger no-show counts may justify extra reminders or a waitlist; low show rates on small shifts should be read in context.</div>" +
    "<div class='page-foot'><span>" + esc(CONFIG.eventName) + " · Volunteer Operations</span><span>Shift performance</span></div></section>"
  );

  const durationRows = durationShifts.map((item) => [
    item.label, String(item.timedCount), fmtMinutes(item.avgMinutes),
    fmtMinutes(item.medianMinutes), fmtMinutes(item.longestMinutes)
  ]);
  const checkoutMethodMix = [
    { label: "Actual booth checkout", value: checkoutCounts.actual, color: mutedColors.actual },
    { label: "Estimated shift end", value: checkoutCounts.estimated, color: mutedColors.estimated },
    { label: "Custom/admin time", value: checkoutCounts.custom, color: mutedColors.custom },
    { label: "Still checked in / incomplete", value: checkoutCounts.open, color: mutedColors.open }
  ];

  pages.push(
    "<section class='page'><div class='page-head'><div><div class='eyebrow'>04 / Volunteer time &amp; closeout</div><h2 class='page-title'>Time recorded and checkout quality</h2><div class='page-subtitle'>Recorded session length is useful for planning, but the checkout method matters when interpreting the totals.</div></div><div class='section-number'>Hours &amp; records</div></div>" +
    "<div class='kpi-grid'>" +
    kpi("Total recorded time", fmtHours(totalMinutes / 60), "Includes actual, estimated and custom checkout times") +
    kpi("Actual-checkout time", fmtHours(actualMinutes / 60), "Only sessions ending with actual booth checkout") +
    kpi("Average recorded session", allDurations.length ? fmtMinutes(avgMinutes) : "—", allDurations.length + " timed sessions") +
    kpi("Median recorded session", allDurations.length ? fmtMinutes(medianMinutes) : "—", "Less sensitive to very long sessions") +
    kpi("Estimated shift-end checkouts", String(checkoutCounts.estimated), fmtRate(checkoutCounts.estimated, completedCount) + " of completed records with checkout times") +
    kpi("Custom/admin checkout times", String(checkoutCounts.custom), "Reported separately from actual booth checkout") +
    "</div><div class='two-col'><div class='panel'><h3 class='panel-title'>Checkout documentation</h3><p class='panel-note'>How completed or open attendance records were closed out.</p>" +
    donut(checkoutMethodMix, String(completedCount), "checkout times") + "</div><div class='panel'><h3 class='panel-title'>Volunteer age response</h3><p class='panel-note'>Based on the age confirmation collected during registration; this is a registration response breakdown.</p>" +
    donut(ageMix, String(expected), "registrations") + "</div></div>" +
    "<h3 class='section-title'>Shifts with the longest average sessions</h3><p class='section-note'>Only shifts with at least one valid start/end pair are included. The average and median can differ when a few sessions are much longer than the rest.</p>" +
    reportTable(["Position · shift", "Timed records", "Average", "Median", "Longest"], durationRows, "compact") +
    (remainingInsights ? "<h3 class='section-title'>Additional findings</h3><div class='insight-grid'>" + remainingInsights + "</div>" : "") +
    "<div class='note-box'><strong>Data-quality note:</strong> " +
    (checkoutCounts.estimated
      ? checkoutCounts.estimated + " checkout time" + (checkoutCounts.estimated === 1 ? " was" : "s were") + " entered as an estimated shift end. " +
        Math.round(estimatedRateOfCompleted * 100) + "% of completed records with checkout timestamps use an estimated end time. Totals that include these sessions are recorded durations, not fully verified volunteer hours."
      : "No checkouts are currently classified as estimated shift-end placeholders. Recorded session durations still depend on the timestamps available.") +
    (checkoutCounts.custom ? " Custom/admin-entered checkout times are also separate from actual booth checkouts." : "") +
    (lateNoCheckin ? " " + lateNoCheckin + " registration" + (lateNoCheckin === 1 ? " was" : "s were") + " marked late but had no check-in timestamp." : "") +
    "</div><div class='small-muted'>Prepared by Shanmukha Polu &amp; Sonal Sanghani · Generated " + esc(generatedAt) + ".</div>" +
    "<div class='page-foot'><span>" + esc(CONFIG.eventName) + " · Volunteer Operations</span><span>Volunteer time &amp; closeout</span></div></section>"
  );

  const html = "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'>" +
    "<title>" + esc(CONFIG.eventName) + " · Volunteer Operations Report</title><style>" + styleLines.join("\n") +
    "</style></head><body><div class='toolbar'><span>Volunteer Operations Report · Print or save as PDF</span><button class='print-button' onclick='window.print()'>Print / Save PDF</button></div>" +
    pages.join("") + "</body></html>";

  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
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
  // Prefer the stored admin display name from the admins directory so
  // the UI never falls back to an email when a display name exists.
  return (
    adminDirectory.get(
      uid
    ) ||
    fallback ||
    uid ||
    ""
  );
}


function normalizeEmailForAdmin(value) {
  return String(
    value || ""
  )
    .trim()
    .toLowerCase();
}

function findConfiguredShiftForRecord(record) {
  const position =
    getPositionById(
      record?.positionId
    );

  if (!position) return null;

  const normalizedStart =
    normalizeStoredShiftTimeForAdmin(
      record?.shiftStartTime
    );

  const normalizedEnd =
    normalizeStoredShiftTimeForAdmin(
      record?.shiftEndTime
    );

  return (
    position.shifts?.find(
      (shift) =>
        shift.startTime ===
          normalizedStart &&
        shift.endTime ===
          normalizedEnd
    ) || null
  );
}

function normalizeStoredShiftTimeForAdmin(value) {
  const text =
    String(value || "").trim();

  if (/^\d{3,4}$/.test(text)) {
    return text.padStart(
      4,
      "0"
    );
  }

  const match =
    text.match(
      /^(\d{1,2})(?::(\d{2}))?\s*([AP]M)$/i
    );

  if (!match) return "";

  let hour =
    Number(match[1]);

  const minute =
    Number(
      match[2] || "0"
    );

  const period =
    match[3].toUpperCase();

  if (
    hour < 1 ||
    hour > 12 ||
    minute < 0 ||
    minute > 59
  ) {
    return "";
  }

  if (
    period === "AM"
  ) {
    if (hour === 12) {
      hour = 0;
    }
  } else if (
    hour !== 12
  ) {
    hour += 12;
  }

  return (
    String(hour).padStart(
      2,
      "0"
    ) +
    String(minute).padStart(
      2,
      "0"
    )
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
    findShift(id)?.shift;

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
    findShift(id)?.shift;

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
    findShift(id)?.shift;

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