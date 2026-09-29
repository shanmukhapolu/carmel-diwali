import {
  CONFIG,
  normalizePhoneNumber
} from "../config.js";

import { db } from "../firebase-init.js";
import { requireAdmin, logout } from "./auth.js";

import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const REGISTRATIONS_COLLECTION = "registrations";
const WHATSAPP_CONTACTS_COLLECTION = "whatsappContacts";

const $ = (id) => document.getElementById(id);

let groups = [];

const state = {
  search: "",
  status: ""
};

requireAdmin({
  onReady: (user, profile) => {
    initShell(user);
    initPage(user);
  },
  onDenied: (message) => showError(message)
});

function initShell(user) {
  const adminName =
    [
      user?.displayName,
      user?.email
    ]
      .filter(Boolean)
      .join(" · ") ||
    "Administrator";

  setText("admin-email", adminName);

  const date = new Intl.DateTimeFormat(
    "en-US",
    {
      month: "long",
      day: "numeric",
      year: "numeric"
    }
  ).format(
    new Date(CONFIG.eventDate + "T00:00:00")
  );

  setText(
    "event-meta",
    CONFIG.eventName +
      " • " +
      date +
      " • " +
      CONFIG.location
  );

  $("logout")?.addEventListener(
    "click",
    logout
  );
}

async function initPage(user) {
  bindFilters(user);
  await refresh(user);
}

function bindFilters(user) {
  $("whatsapp-search")?.addEventListener(
    "input",
    () => {
      state.search =
        String(
          $("whatsapp-search")?.value || ""
        )
          .trim()
          .toLowerCase();

      render();
    }
  );

  $("whatsapp-status-filter")?.addEventListener(
    "change",
    () => {
      state.status =
        $("whatsapp-status-filter")?.value || "";

      render();
    }
  );

  $("whatsapp-clear-filters")?.addEventListener(
    "click",
    () => {
      state.search = "";
      state.status = "";

      if ($("whatsapp-search")) {
        $("whatsapp-search").value = "";
      }

      if ($("whatsapp-status-filter")) {
        $("whatsapp-status-filter").value = "";
      }

      clearError();
      render();
    }
  );

  $("whatsapp-refresh")?.addEventListener(
    "click",
    async () => {
      await refresh(user);
    }
  );
}

async function refresh(user) {
  setText(
    "whatsapp-counts",
    "Loading WhatsApp contacts..."
  );

  setText(
    "whatsapp-visible-count",
    ""
  );

  try {
    const [registrations, statuses] =
      await Promise.all([
        loadRegistrations(),
        loadStatuses()
      ]);

    const built =
      buildGroups(
        registrations,
        statuses
      );

    groups = built.groups;

    render();

    const statusCounts = {
      joined: 0,
      invited: 0,
      not_valid: 0,
      not_joined: 0
    };

    groups.forEach(
      (group) => {
        if (
          Object.prototype.hasOwnProperty.call(
            statusCounts,
            group.status
          )
        ) {
          statusCounts[group.status] += 1;
        }
      }
    );

    const missing =
      built.missingPhoneRegistrations;

    setText(
      "whatsapp-counts",
      String(groups.length) +
        " unique phone numbers · " +
        String(statusCounts.joined) +
        " joined · " +
        String(statusCounts.invited) +
        " invited · " +
        String(statusCounts.not_joined) +
        " not joined · " +
        String(statusCounts.not_valid) +
        " not valid" +
        (
          missing
            ? " · " +
              String(missing) +
              " registration" +
              (
                missing === 1
                  ? ""
                  : "s"
              ) +
              " with missing/invalid phone"
            : ""
        )
    );

    clearError();
  } catch (error) {
    console.error(
      "[Admin WhatsApp] load failed:",
      error
    );

    setText(
      "whatsapp-counts",
      "Could not load WhatsApp contacts."
    );

    showError(
      "Could not load WhatsApp contacts. Please refresh and try again."
    );
  }
}

async function loadRegistrations() {
  const q =
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
    await getDocs(q);

  return snapshot.docs.map(
    (entry) => ({
      id: entry.id,
      ...entry.data()
    })
  );
}

async function loadStatuses() {
  const snapshot =
    await getDocs(
      collection(
        db,
        WHATSAPP_CONTACTS_COLLECTION
      )
    );

  const statuses =
    new Map();

  snapshot.docs.forEach(
    (entry) => {
      const data =
        entry.data();

      if (
        data.eventId ===
        CONFIG.eventId
      ) {
        const allowedStatuses = new Set([
          "joined",
          "invited",
          "not_valid",
          "not_joined"
        ]);

        if (
          allowedStatuses.has(
            data.status
          )
        ) {
          statuses.set(
            entry.id,
            data.status
          );
        }
      }
    }
  );

  return statuses;
}

function buildGroups(
  registrations,
  statuses
) {
  const byPhone =
    new Map();

  let missingPhoneRegistrations = 0;

  registrations.forEach(
    (record) => {
      const normalizedPhone =
        normalizePhoneNumber(
          String(
            record.phone || ""
          )
        );

      if (!normalizedPhone) {
        missingPhoneRegistrations += 1;
        return;
      }

      if (!byPhone.has(normalizedPhone)) {
        byPhone.set(
          normalizedPhone,
          {
            normalizedPhone,
            displayPhone:
              String(
                record.phone || ""
              ).trim(),
            names: new Map(),
            emails: new Map(),
            assignments: new Map(),
            registrationCount: 0,
            status:
              statuses.get(
                normalizedPhone
              ) ||
              "not_joined"
          }
        );
      }

      const group =
        byPhone.get(
          normalizedPhone
        );

      group.registrationCount += 1;

      const name =
        [
          record.firstName,
          record.lastName
        ]
          .filter(Boolean)
          .join(" ")
          .trim() ||
        record.name ||
        "Unnamed volunteer";

      const nameKey =
        normalizeText(name);

      if (
        nameKey &&
        !group.names.has(nameKey)
      ) {
        group.names.set(
          nameKey,
          name
        );
      }

      const email =
        String(
          record.email || ""
        ).trim();

      const emailKey =
        email.toLowerCase();

      if (
        emailKey &&
        !group.emails.has(emailKey)
      ) {
        group.emails.set(
          emailKey,
          email
        );
      }

      const position =
        record.positionName ||
        record.position ||
        "Position";

      const shift =
        record.shiftLabel ||
        record.shift ||
        "Shift";

      const assignment =
        position +
        " — " +
        shift;

      const assignmentKey =
        String(
          record.positionId || ""
        ) +
        "|" +
        String(
          record.shiftId || ""
        ) +
        "|" +
        normalizeText(
          assignment
        );

      if (
        !group.assignments.has(
          assignmentKey
        )
      ) {
        group.assignments.set(
          assignmentKey,
          assignment
        );
      }
    }
  );

  const result =
    Array.from(
      byPhone.values()
    )
      .map(
        (group) => ({
          normalizedPhone:
            group.normalizedPhone,

          displayPhone:
            group.displayPhone ||
            group.normalizedPhone,

          names:
            Array.from(
              group.names.values()
            ),

          emails:
            Array.from(
              group.emails.values()
            ),

          assignments:
            Array.from(
              group.assignments.values()
            ),

          registrationCount:
            group.registrationCount,

          status:
            group.status,

          searchable: [
            group.normalizedPhone,
            group.displayPhone,
            ...group.names.values(),
            ...group.emails.values(),
            ...group.assignments.values()
          ]
            .join(" ")
            .toLowerCase()
        })
      )
      .sort(
        (a, b) =>
          a.normalizedPhone.localeCompare(
            b.normalizedPhone,
            undefined,
            {
              numeric: true
            }
          )
      );

  return {
    groups: result,
    missingPhoneRegistrations
  };
}

function normalizeText(value) {
  return String(
    value || ""
  )
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(
      /[^a-z0-9]/g,
      ""
    );
}

function render() {
  const rows =
    $("whatsapp-rows");

  if (!rows) return;

  rows.textContent = "";

  const visible =
    groups.filter(
      (group) => {
        if (
          state.search &&
          !group.searchable.includes(
            state.search
          )
        ) {
          return false;
        }

        if (
          state.status &&
          group.status !==
            state.status
        ) {
          return false;
        }

        return true;
      }
    );

  setText(
    "whatsapp-visible-count",
    String(visible.length) +
      " shown"
  );

  if (!visible.length) {
    const row =
      document.createElement("tr");

    const cell =
      document.createElement("td");

    cell.colSpan = 6;
    cell.className =
      "whatsapp-empty";

    cell.textContent =
      "No phone numbers match your search or filter.";

    row.appendChild(cell);
    rows.appendChild(row);
    return;
  }

  visible.forEach(
    (group) => {
      rows.appendChild(
        createRow(
          group
        )
      );
    }
  );
}

function createRow(group) {
  const row =
    document.createElement("tr");

  const statusCell =
    document.createElement("td");

  statusCell.className =
    "whatsapp-status-cell";

  const statusWrap =
    document.createElement("div");

  statusWrap.className =
    "whatsapp-status-wrap";

  const statusSelect =
    document.createElement("select");

  statusSelect.className =
    "whatsapp-status-select";

  statusSelect.id =
    "whatsapp-" +
    group.normalizedPhone;

  [
    ["joined", "Joined"],
    ["invited", "Invited"],
    ["not_valid", "Not valid"],
    ["not_joined", "Not joined"]
  ].forEach(
    ([value, label]) => {
      statusSelect.append(
        new Option(
          label,
          value,
          false,
          group.status === value
        )
      );
    }
  );

  statusSelect.setAttribute(
    "aria-label",
    "WhatsApp group status for " +
      group.displayPhone
  );

  statusSelect.addEventListener(
    "change",
    async () => {
      const nextStatus =
        statusSelect.value;

      statusSelect.disabled = true;

      try {
        await saveStatus(
          group,
          nextStatus
        );

        group.status =
          nextStatus;

        clearError();
        render();
      } catch (error) {
        console.error(
          "[Admin WhatsApp] status update failed:",
          error
        );

        statusSelect.value =
          group.status;

        statusSelect.disabled =
          false;

        showError(
          "Could not update WhatsApp status. Please try again."
        );
      }
    }
  );

  statusWrap.append(
    statusSelect
  );

  statusCell.appendChild(
    statusWrap
  );

  const phoneCell =
    document.createElement("td");

  phoneCell.className =
    "whatsapp-phone-cell";

  phoneCell.textContent =
    formatPhone(
      group.displayPhone,
      group.normalizedPhone
    );

  const namesCell =
    document.createElement("td");

  namesCell.appendChild(
    createStack(
      group.names,
      "No name provided"
    )
  );

  const emailsCell =
    document.createElement("td");

  emailsCell.appendChild(
    createStack(
      group.emails,
      "No email provided"
    )
  );

  const registrationsCell =
    document.createElement("td");

  registrationsCell.className =
    "whatsapp-count-cell";

  registrationsCell.textContent =
    String(
      group.registrationCount
    );

  const shiftsCell =
    document.createElement("td");

  shiftsCell.appendChild(
    createStack(
      group.assignments,
      "No shift details"
    )
  );

  row.append(
    statusCell,
    phoneCell,
    namesCell,
    emailsCell,
    registrationsCell,
    shiftsCell
  );

  return row;
}

function createStack(
  values,
  emptyLabel
) {
  const wrap =
    document.createElement("div");

  wrap.className =
    "whatsapp-stack";

  if (!values.length) {
    const empty =
      document.createElement("span");

    empty.className =
      "muted";

    empty.textContent =
      emptyLabel;

    wrap.appendChild(
      empty
    );

    return wrap;
  }

  values.forEach(
    (value) => {
      const item =
        document.createElement("div");

      item.textContent =
        value;

      wrap.appendChild(
        item
      );
    }
  );

  return wrap;
}

function formatPhone(
  displayPhone,
  normalizedPhone
) {
  if (
    normalizedPhone.length === 10
  ) {
    return "(" +
      normalizedPhone.slice(0, 3) +
      ") " +
      normalizedPhone.slice(3, 6) +
      "-" +
      normalizedPhone.slice(6);
  }

  return displayPhone ||
    normalizedPhone;
}

async function saveStatus(
  group,
  status
) {
  const allowedStatuses = new Set([
    "joined",
    "invited",
    "not_valid",
    "not_joined"
  ]);

  if (!allowedStatuses.has(status)) {
    throw new Error(
      "Invalid WhatsApp status."
    );
  }

  await setDoc(
    doc(
      db,
      WHATSAPP_CONTACTS_COLLECTION,
      group.normalizedPhone
    ),
    {
      eventId:
        CONFIG.eventId,

      normalizedPhone:
        group.normalizedPhone,

      phone:
        formatPhone(
          group.displayPhone,
          group.normalizedPhone
        ),

      status,

      updatedAt:
        serverTimestamp()
    },
    {
      merge: true
    }
  );
}

function setText(
  id,
  value
) {
  const element = $(id);

  if (element) {
    element.textContent =
      value ?? "";
  }
}

function showError(message) {
  setText(
    "error",
    message
  );
}

function clearError() {
  setText(
    "error",
    ""
  );
}
