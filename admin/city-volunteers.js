import {
  CONFIG,
  VOLUNTEER_POSITIONS,
  formatShiftTime,
  getPositionById,
  getShiftById,
  getRegistrationLookupId,
  normalizeFirstName,
  normalizeLastName,
  normalizePhoneNumber,
  sha256Hex,
} from "../config.js";

import { db } from "../firebase-init.js";
import { requireAdmin, logout } from "./auth.js";

import {
  collection,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const EVENT_DATE = CONFIG.eventDate;
const REGISTRATIONS_COLLECTION = "registrations";
const SHIFT_COUNTS_COLLECTION = "shiftCounts";

const $ = (id) => document.getElementById(id);

let existingRegistrations = [];
let shiftCounts = new Map();
let previewRows = [];

requireAdmin({
  onReady: async (user, profile) => {
    setText("admin-email", adminDisplayName(profile, user));
    setText(
      "event-meta",
      `${CONFIG.eventName} • ${formatEventDate(CONFIG.eventDate)} • ${CONFIG.location}`
    );

    $("logout")?.addEventListener("click", logout);

    renderPositionSelects();
    refreshImportShiftSelect();
    bindManualForm();
    bindImportControls();

    await refreshData();
  },

  onDenied: (message) => {
    setText("page-error", message);
  },
});

async function refreshData() {
  try {
    [existingRegistrations, shiftCounts] =
      await Promise.all([
        loadExistingRegistrations(),
        loadShiftCounts(),
      ]);

    refreshManualShiftSelect();
    refreshImportShiftSelect();
    renderPreview();
  } catch (error) {
    console.error("[City Import] load failed", error);
    setText(
      "page-error",
      "Could not load the current volunteer roster. Refresh and try again."
    );
  }
}

function renderPositionSelects() {
  const manual = $("manual-position");

  if (manual) {
    manual.textContent = "";

    VOLUNTEER_POSITIONS.forEach(
      (position) => {
        manual.append(
          new Option(
            position.name,
            position.id
          )
        );
      }
    );

    manual.value = "event-setup";
    manual.addEventListener(
      "change",
      refreshManualShiftSelect
    );
  }

  const imported = $("import-position");

  if (imported) {
    imported.textContent = "";

    VOLUNTEER_POSITIONS.forEach(
      (position) => {
        imported.append(
          new Option(
            position.name,
            position.id
          )
        );
      }
    );

    imported.value = "event-setup";
    imported.addEventListener(
      "change",
      refreshImportShiftSelect
    );
  }
}

function refreshImportShiftSelect() {
  const positionId =
    $("import-position")?.value ||
    "event-setup";

  const shiftSelect =
    $("import-shift");

  if (!shiftSelect) return;

  shiftSelect.textContent = "";

  const position =
    getPositionById(positionId);

  (position?.shifts || []).forEach(
    (shift) => {
      const current =
        Number(
          shiftCounts.get(shift.id)?.count
        ) || 0;

      const capacity =
        Number(
          shiftCounts.get(shift.id)?.capacity ??
            shift.capacity ??
            0
        );

      shiftSelect.append(
        new Option(
          `${formatShiftTime(shift)} • ${current}/${capacity}`,
          shift.id
        )
      );
    }
  );

  updateImportCapacityText();
}

function updateImportCapacityText() {
  const shiftId =
    $("import-shift")?.value ||
    "";

  const shift =
    findConfiguredShift(shiftId);

  if (!shift) {
    setText(
      "import-shift-capacity",
      ""
    );
    return;
  }

  const current =
    Number(
      shiftCounts.get(shift.id)?.count
    ) || 0;

  const capacity =
    Number(
      shiftCounts.get(shift.id)?.capacity ??
        shift.capacity ??
        0
    );

  setText(
    "import-shift-capacity",
    `${current} registered • configured capacity ${capacity}${current >= capacity ? " • over capacity is allowed for admin imports" : ""}`
  );
}

function refreshManualShiftSelect() {
  const positionId =
    $("manual-position")?.value || "event-setup";
  const shiftSelect = $("manual-shift");

  if (!shiftSelect) return;

  shiftSelect.textContent = "";

  const position = getPositionById(positionId);

  (position?.shifts || []).forEach((shift) => {
    shiftSelect.append(
      new Option(
        formatShiftTime(shift),
        shift.id
      )
    );
  });

  updateManualCapacityText();
}

function bindManualForm() {
  $("manual-shift")?.addEventListener(
    "change",
    updateManualCapacityText
  );

  $("import-shift")?.addEventListener(
    "change",
    updateImportCapacityText
  );

  $("manual-form")?.addEventListener(
    "submit",
    submitManualVolunteer
  );
}

function updateManualCapacityText() {
  const shiftId = $("manual-shift")?.value;
  const shift = findConfiguredShift(shiftId);

  if (!shift) {
    setText("manual-shift-capacity", "");
    return;
  }

  const current =
    Number(shiftCounts.get(shift.id)?.count) || 0;
  const capacity =
    Number(
      shiftCounts.get(shift.id)?.capacity ??
      shift.capacity ??
      0
    );

  setText(
    "manual-shift-capacity",
    `${current} registered for this shift • configured capacity ${capacity}${current >= capacity ? " • over capacity is allowed for admin imports" : ""}`
  );
}

async function submitManualVolunteer(event) {
  event.preventDefault();

  const firstName = $("manual-first")?.value.trim() || "";
  const lastName = $("manual-last")?.value.trim() || "";
  const email = normalizeEmail($("manual-email")?.value);
  const phone = normalizePhoneNumber($("manual-phone")?.value);
  const ageValue = $("manual-age")?.value;
  const positionId = $("manual-position")?.value || "";
  const shiftId = $("manual-shift")?.value || "";
  const cityNeed =
    $("manual-city-need")?.value.trim() ||
    "Diwali Festival of Lights - Set Up";

  clearMessage("manual-message");

  if (!firstName || !lastName) {
    return setMessage(
      "manual-message",
      "Enter the volunteer's first and last name."
    );
  }

  if (!email && !phone) {
    return setMessage(
      "manual-message",
      "Enter at least an email or mobile number so the volunteer can be identified."
    );
  }

  const shift = findConfiguredShift(shiftId);
  const position = getPositionById(positionId);

  if (!position || !shift || shift.positionId !== positionId) {
    return setMessage(
      "manual-message",
      "Choose a valid position and shift."
    );
  }

  const duplicate =
    findExistingDuplicate({
      firstName,
      lastName,
      email,
      phone,
      shiftId,
    });

  if (duplicate) {
    return setMessage(
      "manual-message",
      `This volunteer already appears to be registered for ${formatShiftTime(shift)}. No duplicate was added.`,
      "error"
    );
  }

  const candidate = {
    firstName,
    lastName,
    email,
    phone,
    is18OrOlder:
      ageValue === ""
        ? null
        : ageValue === "true",
    positionId,
    shiftId,
    cityNeed,
    cityDate: EVENT_DATE,
    cityStartTime: shift.startTime,
    cityEndTime: shift.endTime,
    sourceMethod: "manual",
    sourceRow: null,
  };

  try {
    $("manual-submit").disabled = true;
    $("manual-submit").textContent = "Adding…";

    const id = await writeCityVolunteer(candidate);

    await refreshData();

    $("manual-form").reset();
    $("manual-position").value = "event-setup";
    refreshManualShiftSelect();

    setMessage(
      "manual-message",
      `Added successfully. Confirmation ID: ${id}`,
      "success"
    );
  } catch (error) {
    console.error("[City Import] manual add failed", error);
    setMessage(
      "manual-message",
      friendlyImportError(error),
      "error"
    );
  } finally {
    $("manual-submit").disabled = false;
    $("manual-submit").textContent = "Add City Volunteer";
  }
}

function bindImportControls() {
  $("preview-import")?.addEventListener(
    "click",
    buildPreview
  );

  $("import-rows")?.addEventListener(
    "click",
    importValidRows
  );

  $("import-shift-mode")?.addEventListener(
    "change",
    updateImportShiftModeUI
  );

  updateImportShiftModeUI();

  $("csv-file")?.addEventListener("change", async () => {
    clearMessage("sheet-message");

    const file = $("csv-file").files?.[0];
    if (!file) return;

    try {
      $("sheet-input").value = await file.text();
      setMessage(
        "sheet-message",
        "CSV loaded. Review the text, then click Preview Rows.",
        "success"
      );
    } catch (error) {
      console.error("[City Import] CSV read failed", error);
      setMessage(
        "sheet-message",
        "Could not read that CSV file."
      );
    }
  });
}

function updateImportShiftModeUI() {
  const mode = $("import-shift-mode")?.value || "configured";
  const helper = $("import-shift-capacity");

  if (helper) {
    helper.textContent =
      mode === "sheet"
        ? "Column G (Start) and H (End) will set each row's assigned shift time. Configured capacity does not block admin imports."
        : "Used for every row when Shift time is set to Use selected timeslot.";
  }
}

function parseSheetInput() {
  const raw = $("sheet-input")?.value || "";
  if (!raw.trim()) return [];

  const firstLine = raw.split(/\r?\n/, 1)[0] || "";
  const looksTabbed = firstLine.includes("\t");

  return looksTabbed
    ? parseTsv(raw)
    : parseCsv(raw);
}

function parseTsv(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.split("\t"));
}

function parseCsv(raw) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];

    if (quoted) {
      if (char === '"' && raw[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char === "\r") {
      // Ignore CR; LF completes the row.
    } else {
      cell += char;
    }
  }

  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function buildPreview() {
  clearMessage("sheet-message");

  const rows = parseSheetInput();

  if (!rows.length) {
    previewRows = [];
    renderPreview();
    setMessage(
      "sheet-message",
      "Paste rows copied from Google Sheets first."
    );
    return;
  }

  const importPositionId =
    $("import-position")?.value ||
    "event-setup";

  const importPosition =
    getPositionById(importPositionId);

  const importShiftId =
    $("import-shift")?.value ||
    "";

  const shiftMode =
    $("import-shift-mode")?.value ||
    "configured";

  previewRows = rows
    .map((cells, index) =>
      makeCandidateFromSheetRow(
        cells,
        index + 1,
        importPosition,
        importShiftId,
        shiftMode
      )
    )
    .filter(Boolean);

  renderPreview();

  const valid = previewRows.filter(
    (row) =>
      row.status === "ready" ||
      row.status === "warning"
  ).length;

  if (!valid) {
    setMessage(
      "sheet-message",
      "No rows are ready to import. Review the Result column."
    );
  }
}

function makeCandidateFromSheetRow(
  cells,
  rowNumber,
  importPosition,
  importShiftId,
  shiftMode
) {
  const value = (index) =>
    String(cells[index] ?? "").trim();

  const firstName = value(0);
  const lastName = value(1);
  const email = normalizeEmail(value(2));
  const phone = normalizePhoneNumber(value(3));
  const cityNeed = value(4);
  const cityDateRaw = value(5);
  const startRaw = value(6);
  const endRaw = value(7);
  const emergencyContact = value(8);
  const under18Raw = value(9);
  const parentGuardianRaw = value(10);

  const meaningful =
    firstName ||
    lastName ||
    email ||
    phone ||
    cityNeed ||
    cityDateRaw ||
    startRaw ||
    endRaw;

  if (!meaningful) return null;

  if (
    !firstName &&
    !lastName &&
    !email &&
    !phone
  ) {
    return {
      rowNumber,
      firstName: "",
      lastName: "",
      email: "",
      phone: "",
      cityNeed,
      positionId:
        importPosition?.id || "",
      shiftId: "",
      is18OrOlder: null,
      status: "skip",
      result:
        "Blank/section row skipped.",
    };
  }

  if (!firstName || !lastName) {
    return {
      rowNumber,
      firstName,
      lastName,
      email,
      phone,
      cityNeed,
      positionId:
        importPosition?.id || "",
      shiftId: "",
      is18OrOlder:
        parseAge(under18Raw),
      status: "error",
      result:
        "Missing first or last name.",
    };
  }

  const normalizedDate =
    parseCityDate(cityDateRaw);

  if (
    normalizedDate &&
    normalizedDate !== EVENT_DATE
  ) {
    return {
      rowNumber,
      firstName,
      lastName,
      email,
      phone,
      cityNeed,
      positionId:
        importPosition?.id || "",
      shiftId: "",
      is18OrOlder:
        parseAge(under18Raw),
      status: "error",
      result:
        `Date ${cityDateRaw || "missing"} does not match ${EVENT_DATE}.`,
    };
  }

  if (!normalizedDate && cityDateRaw) {
    return {
      rowNumber,
      firstName,
      lastName,
      email,
      phone,
      cityNeed,
      positionId:
        importPosition?.id || "",
      shiftId: "",
      is18OrOlder:
        parseAge(under18Raw),
      status: "error",
      result:
        `Could not read date "${cityDateRaw}".`,
    };
  }

  if (!importPosition) {
    return {
      rowNumber,
      firstName,
      lastName,
      email,
      phone,
      cityNeed,
      positionId: "",
      shiftId: "",
      is18OrOlder:
        parseAge(under18Raw),
      status: "error",
      result:
        "Choose a target position before previewing.",
    };
  }

  let assignedShift = null;

  if (shiftMode === "sheet") {
    const startMinutes =
      parseTimeToMinutes(startRaw);
    const endMinutes =
      parseTimeToMinutes(endRaw);

    if (startMinutes === null || endMinutes === null) {
      return {
        rowNumber,
        firstName,
        lastName,
        email,
        phone,
        cityNeed,
        positionId: importPosition.id,
        shiftId: "",
        is18OrOlder:
          parseAge(under18Raw),
        status: "error",
        result:
          "Could not read the Start/End time in columns G/H. Use times such as 11:00 AM and 1:00 PM.",
      };
    }

    if (endMinutes <= startMinutes) {
      return {
        rowNumber,
        firstName,
        lastName,
        email,
        phone,
        cityNeed,
        positionId: importPosition.id,
        shiftId: "",
        is18OrOlder:
          parseAge(under18Raw),
        status: "error",
        result:
          "The sheet End time must be later than the Start time.",
      };
    }

    const startTime =
      minutesToHHMM(startMinutes);
    const endTime =
      minutesToHHMM(endMinutes);

    const configuredMatch =
      findConfiguredShiftByTimes(
        importPosition.id,
        startTime,
        endTime
      );

    assignedShift =
      configuredMatch || {
        id: buildCityCustomShiftId(
          importPosition.id,
          startTime,
          endTime
        ),
        positionId: importPosition.id,
        positionName: importPosition.name,
        startTime,
        endTime,
        capacity: 0,
        isCustomShift: true,
      };
  } else {
    assignedShift =
      getShiftById(
        importPosition.id,
        importShiftId
      );

    if (!assignedShift) {
      return {
        rowNumber,
        firstName,
        lastName,
        email,
        phone,
        cityNeed,
        positionId: importPosition.id,
        shiftId: "",
        is18OrOlder:
          parseAge(under18Raw),
        status: "error",
        result:
          "Choose a target Timeslot before previewing.",
      };
    }
  }

  const candidate = {
    rowNumber,
    firstName,
    lastName,
    email,
    phone,
    cityNeed,
    positionId: importPosition.id,
    shiftId: assignedShift.id,
    shiftStartTime: assignedShift.startTime,
    shiftEndTime: assignedShift.endTime,
    shiftLabel: formatShiftTime(assignedShift),
    isCustomShift:
      assignedShift.isCustomShift === true,
    is18OrOlder: parseAge(under18Raw),
    cityDate: normalizedDate || EVENT_DATE,
    cityStartTime: startRaw,
    cityEndTime: endRaw,
    emergencyContact,
    parentGuardianEmail:
      extractEmail(parentGuardianRaw),
    sourceMethod: "sheets",
    sourceRow: rowNumber,
    originalCityStartTime:
      startRaw,
    originalCityEndTime:
      endRaw,
    status: "ready",
    result: "",
  };

  if (!email && !phone) {
    candidate.status = "warning";
    candidate.result =
      "No email or mobile. Review this row carefully before importing.";
  }

  return candidate;
}

function parseAge(value) {
  const text = String(value || "").trim().toLowerCase();

  if (!text) return true;
  if (
    text === "x" ||
    text === "yes" ||
    text === "<18" ||
    text.includes("under")
  ) {
    return false;
  }

  if (
    text === "no" ||
    text === "18+" ||
    text.includes("18 or older")
  ) {
    return true;
  }

  return null;
}

function parseCityDate(value) {
  const text = String(value || "").trim();

  if (!text) return null;

  let match =
    text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);

  if (match) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    const year = Number(match[3]);
    return isoDateParts(year, month, day);
  }

  match =
    text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);

  if (match) {
    return isoDateParts(
      Number(match[1]),
      Number(match[2]),
      Number(match[3])
    );
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return isoDateParts(
      parsed.getFullYear(),
      parsed.getMonth() + 1,
      parsed.getDate()
    );
  }

  return null;
}

function isoDateParts(year, month, day) {
  if (
    year < 2000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseTimeToMinutes(value) {
  const text = String(value || "").trim();

  let match =
    text.match(/^(\d{1,2})(?::?(\d{2}))?\s*([AP]M)$/i);

  if (match) {
    let hour = Number(match[1]);
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
      return null;
    }

    if (period === "AM") {
      if (hour === 12) hour = 0;
    } else if (hour !== 12) {
      hour += 12;
    }

    return hour * 60 + minute;
  }

  match =
    text.match(/^(\d{1,2}):?(\d{2})$/);

  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return hour * 60 + minute;
}

function minutesToHHMM(minutes) {
  const hour =
    Math.floor(minutes / 60);

  const minute =
    minutes % 60;

  return (
    String(hour).padStart(2, "0") +
    String(minute).padStart(2, "0")
  );
}

function buildCityCustomShiftId(
  positionId,
  startTime,
  endTime
) {
  return `city_${positionId}_${startTime}_${endTime}`;
}

function getCandidateShift(candidate) {
  if (candidate?.isCustomShift) {
    return {
      id: candidate.shiftId,
      positionId: candidate.positionId,
      positionName:
        candidate.positionName ||
        getPositionById(candidate.positionId)?.name ||
        "",
      startTime:
        candidate.shiftStartTime,
      endTime:
        candidate.shiftEndTime,
      capacity: 0,
      isCustomShift: true,
    };
  }

  return findConfiguredShift(
    candidate?.shiftId
  );
}

function findConfiguredShiftByTimes(
  positionId,
  startTime,
  endTime
) {
  const position =
    getPositionById(positionId);

  if (!position) return null;

  const match =
    position.shifts.find(
      (shift) =>
        shift.startTime === startTime &&
        shift.endTime === endTime
    );

  if (!match) return null;

  return {
    ...match,
    positionId: position.id,
    positionName: position.name,
    isCustomShift: false,
  };
}

function timeStringToMinutes(hhmm) {
  const text = String(hhmm || "");
  const hour = Number(text.slice(0, 2));
  const minute = Number(text.slice(2));

  return hour * 60 + minute;
}

function renderPreview() {
  const tbody = $("preview-rows");
  const counts = $("preview-counts");
  const summary = $("preview-summary");
  const importButton = $("import-rows");

  if (!tbody || !counts || !summary) return;

  tbody.textContent = "";
  summary.textContent = "";

  if (!previewRows.length) {
    tbody.appendChild(messageRow("Paste or upload City rows, then choose Preview Rows."));
    counts.textContent = "No rows loaded";
    importButton.disabled = true;
    return;
  }

  const ready =
    previewRows.filter(
      (row) =>
        row.status === "ready" ||
        row.status === "warning"
    ).length;
  const skipped =
    previewRows.filter(
      (row) => row.status === "skip"
    ).length;
  const errors =
    previewRows.filter(
      (row) => row.status === "error"
    ).length;
  const duplicates =
    previewRows.filter(
      (row) => row.status === "duplicate"
    ).length;
  const imported =
    previewRows.filter(
      (row) => row.status === "imported"
    ).length;

  counts.textContent =
    `${ready} ready · ${errors} errors · ${duplicates} duplicates · ${skipped} skipped`;

  appendSummaryBadge(
    summary,
    `${ready} ready`,
    "ok"
  );
  appendSummaryBadge(
    summary,
    `${errors} errors`,
    errors ? "bad" : ""
  );
  appendSummaryBadge(
    summary,
    `${duplicates} duplicates`,
    duplicates ? "warn" : ""
  );
  appendSummaryBadge(
    summary,
    `${skipped} skipped`,
    ""
  );

  if (imported) {
    appendSummaryBadge(
      summary,
      `${imported} imported`,
      "ok"
    );
  }

  previewRows.forEach((row) => {
    const tr = document.createElement("tr");

    if (row.status === "skip") {
      tr.className = "row-skip";
    } else if (
      row.status === "warning" ||
      row.status === "duplicate"
    ) {
      tr.className = "row-warning";
    } else if (row.status === "error") {
      tr.className = "row-error";
    }

    appendCell(tr, row.rowNumber);
    appendCell(
      tr,
      [row.firstName, row.lastName]
        .filter(Boolean)
        .join(" ")
    );
    appendCell(tr, row.email || "—");
    appendCell(
      tr,
      formatPreviewPhone(row.phone)
    );
    appendCell(tr, row.cityNeed || "—");

    const position =
      getPositionById(row.positionId);
    appendCell(
      tr,
      position?.name || "—"
    );

    const shift =
      getCandidateShift(row);
    appendCell(
      tr,
      shift ? formatShiftTime(shift) : "—"
    );

    appendCell(
      tr,
      row.is18OrOlder === true
        ? "18+"
        : row.is18OrOlder === false
        ? "Under 18"
        : "Not specified"
    );

    const resultCell =
      document.createElement("td");
    resultCell.className = "result-cell";
    resultCell.textContent =
      row.status === "ready"
        ? "Ready to import."
        : row.status === "warning"
        ? row.result || "Review before importing."
        : row.status === "imported"
        ? "Imported successfully."
        : row.result || row.status;
    tr.appendChild(resultCell);

    tbody.appendChild(tr);
  });

  importButton.disabled = ready === 0;
  importButton.textContent =
    imported
      ? "Import Remaining Valid Rows"
      : `Import ${ready} Valid Rows`;
}

function messageRow(text) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = 9;
  td.textContent = text;
  tr.appendChild(td);
  return tr;
}

function appendCell(row, value) {
  const td = document.createElement("td");
  td.textContent = String(value ?? "");
  row.appendChild(td);
}

function formatPreviewPhone(value) {
  const digits = normalizePhoneNumber(value);

  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  return digits || "—";
}

function appendSummaryBadge(parent, text, kind) {
  const badge = document.createElement("span");
  badge.className =
    `badge${kind ? ` ${kind}` : ""}`;
  badge.textContent = text;
  parent.appendChild(badge);
}

async function importValidRows() {
  const candidates = previewRows.filter(
    (row) =>
      row.status === "ready" ||
      row.status === "warning"
  );

  if (!candidates.length) {
    return;
  }

  clearMessage("sheet-message");

  const button = $("import-rows");
  button.disabled = true;
  button.textContent = "Importing…";

  let imported = 0;
  let failed = 0;

  for (const candidate of candidates) {
    try {
      await writeCityVolunteer(candidate);
      candidate.status = "imported";
      candidate.result = "Imported successfully.";
      imported += 1;
    } catch (error) {
      console.error(
        "[City Import] row import failed",
        {
          row: candidate.rowNumber,
          code: error?.code || error?.message || "unknown",
        }
      );

      failed += 1;

      if (
        error?.code === "DUPLICATE_SHIFT" ||
        error?.message === "DUPLICATE_SHIFT"
      ) {
        candidate.status = "duplicate";
        candidate.result =
          "This volunteer is already registered for this shift. It was not added.";
      } else {
        candidate.status = "error";
        candidate.result =
          friendlyImportError(error);
      }
    }

    renderPreview();
  }

  await refreshData();

  setMessage(
    "sheet-message",
    `${imported} imported successfully${failed ? ` · ${failed} need review` : ""}.`,
    failed ? "error" : "success"
  );

  button.disabled = previewRows.every(
    (row) =>
      row.status !== "ready" &&
      row.status !== "warning"
  );
  button.textContent = "Import Remaining Valid Rows";
}

async function writeCityVolunteer(candidate) {
  const position =
    getPositionById(candidate.positionId);

  const shift =
    getCandidateShift(candidate);

  if (
    !position ||
    !shift ||
    !shift.startTime ||
    !shift.endTime ||
    (
      shift.positionId &&
      shift.positionId !== position.id
    )
  ) {
    throw new Error("SHIFT_UNAVAILABLE");
  }

  const firstName = candidate.firstName.trim();
  const lastName = candidate.lastName.trim();
  const email = normalizeEmail(candidate.email);
  const phone = normalizePhoneNumber(candidate.phone);

  const normFirst = normalizeFirstName(firstName);
  const normLast = normalizeLastName(lastName);
  const emailHash = email
    ? await sha256Hex(email)
    : "";
  const emailGuardKey = email
    ? encodeURIComponent(email)
    : "";
  const lookupId = phone
    ? await getRegistrationLookupId(
        lastName,
        phone,
        CONFIG.eventId
      )
    : null;

  const shiftRef = doc(
    db,
    SHIFT_COUNTS_COLLECTION,
    shiftDocId(shift.id)
  );

  const registrationRef = doc(
    collection(db, REGISTRATIONS_COLLECTION)
  );

  const personShiftGuardRef =
    phone
      ? doc(
          db,
          "registrationGuards",
          `person_shift_${normFirst}_${normLast}_${phone}_${shift.id}`
        )
      : null;

  const emailPersonShiftGuardRef =
    email
      ? doc(
          db,
          "registrationGuards",
          `email_person_shift_${emailHash}_${normFirst}_${normLast}_${shift.id}`
        )
      : null;

  const lookupRef =
    lookupId
      ? doc(
          db,
          "registrationLookups",
          lookupId
        )
      : null;

  await runTransaction(db, async (tx) => {
    const refs = [
      shiftRef,
      lookupRef,
      personShiftGuardRef,
      emailPersonShiftGuardRef,
    ].filter(Boolean);

    const snaps = await Promise.all(
      refs.map((ref) => tx.get(ref))
    );

    const getSnap = (ref) => {
      if (!ref) return null;
      const index = refs.indexOf(ref);
      return index >= 0 ? snaps[index] : null;
    };

    const shiftSnap = getSnap(shiftRef);
    const lookupSnap = getSnap(lookupRef);
    const phoneGuardSnap =
      getSnap(personShiftGuardRef);
    const emailGuardSnap =
      getSnap(emailPersonShiftGuardRef);

    // A guard is only a real duplicate when the registration it references
    // still exists and is active. Older/deleted registrations can leave stale
    // guard documents behind, which must not block a new City import.
    const phoneGuardRegistrationId =
      phoneGuardSnap?.exists()
        ? phoneGuardSnap.data()?.registrationId
        : null;

    const emailGuardRegistrationId =
      emailGuardSnap?.exists()
        ? emailGuardSnap.data()?.registrationId
        : null;

    const phoneGuardRegistrationSnap =
      phoneGuardSnap?.exists() &&
      phoneGuardRegistrationId
        ? await tx.get(
            doc(
              db,
              REGISTRATIONS_COLLECTION,
              phoneGuardRegistrationId
            )
          )
        : null;

    const emailGuardRegistrationSnap =
      emailGuardSnap?.exists() &&
      emailGuardRegistrationId
        ? await tx.get(
            doc(
              db,
              REGISTRATIONS_COLLECTION,
              emailGuardRegistrationId
            )
          )
        : null;

    const phoneGuardIsStale =
      phoneGuardSnap?.exists() &&
      (
        !phoneGuardRegistrationId ||
        !phoneGuardRegistrationSnap?.exists() ||
        phoneGuardRegistrationSnap.data()?.status === "cancelled"
      );

    const emailGuardIsStale =
      emailGuardSnap?.exists() &&
      (
        !emailGuardRegistrationId ||
        !emailGuardRegistrationSnap?.exists() ||
        emailGuardRegistrationSnap.data()?.status === "cancelled"
      );

    if (phoneGuardIsStale) {
      tx.delete(personShiftGuardRef);
    } else if (
      phoneGuardSnap?.exists() &&
      phoneGuardSnap.data()?.status !== "cancelled"
    ) {
      throw new Error("DUPLICATE_SHIFT");
    }

    if (emailGuardIsStale) {
      tx.delete(emailPersonShiftGuardRef);
    } else if (
      emailGuardSnap?.exists() &&
      emailGuardSnap.data()?.status !== "cancelled"
    ) {
      throw new Error("DUPLICATE_SHIFT");
    }

    const shiftData =
      shiftSnap?.exists()
        ? shiftSnap.data()
        : null;

    const configuredCapacity =
      candidate.isCustomShift
        ? 0
        : Number(
            shiftData?.capacity ??
            shift.capacity ??
            0
          );

    const currentCount =
      Number(
        shiftData?.count ?? 0
      );

    if (!shiftSnap?.exists()) {
      // Admin imports always consume a spot in the shared shift counter.
      // They are allowed to push count above capacity, but the configured
      // capacity itself remains unchanged so the public form can show Full.
      tx.set(shiftRef, {
        eventId: CONFIG.eventId,
        shiftId: shift.id,
        positionId: position.id,
        positionName: position.name,
        startTime: shift.startTime,
        endTime: shift.endTime,
        label: formatShiftTime(shift),
        capacity: configuredCapacity,
        count: 1,
      });
    } else {
      tx.update(shiftRef, {
        count: currentCount + 1,
        ...(candidate.isCustomShift
          ? {}
          : {
              capacity: Number(
                shiftData?.capacity ??
                shift.capacity ??
                configuredCapacity
              ) || configuredCapacity,
            }),
      });
    }

    const record = {
      schemaVersion: CONFIG.schemaVersion,
      eventId: CONFIG.eventId,
      eventName: CONFIG.eventName,
      eventDate: CONFIG.eventDate,
      location: CONFIG.location,

      firstName,
      lastName,
      email,
      phone,

      normalizedFirstName: normFirst,
      normalizedLastName: normLast,
      normalizedPhone: phone,
      emailGuardKey,
      manageLookupId: lookupId,

      is18OrOlder:
        typeof candidate.is18OrOlder === "boolean"
          ? candidate.is18OrOlder
          : null,

      notes: "",
      positionId: position.id,
      positionName: position.name,
      shiftId: shift.id,
      shiftStartTime: shift.startTime,
      shiftEndTime: shift.endTime,
      shiftLabel: formatShiftTime(shift),
      status: "registered",
      checkInTime: null,
      checkOutTime: null,

      registrationSource: "city_import",
      registrationSourceLabel: "City of Carmel",
      cityImportMethod:
        candidate.sourceMethod || "manual",
      cityImportRow:
        candidate.sourceRow ?? null,
      cityOriginalNeed:
        candidate.cityNeed || "",
      cityOriginalDate:
        candidate.cityDate || CONFIG.eventDate,
      cityOriginalStartTime:
        candidate.cityStartTime || shift.startTime,
      cityOriginalEndTime:
        candidate.cityEndTime || shift.endTime,
      cityEmergencyContact:
        candidate.emergencyContact || "",
      cityParentGuardianEmail:
        candidate.parentGuardianEmail || "",

      createdAt: serverTimestamp(),
    };

    tx.set(registrationRef, record);

    if (personShiftGuardRef) {
      tx.set(personShiftGuardRef, {
        registrationId: registrationRef.id,
        type: "person_shift",
        status: "active",
        firstName: normFirst,
        lastName: normLast,
        phone,
        shiftId: shift.id,
        createdAt: serverTimestamp(),
      });
    }

    if (emailPersonShiftGuardRef) {
      tx.set(emailPersonShiftGuardRef, {
        registrationId: registrationRef.id,
        type: "email_person_shift",
        status: "active",
        emailHash,
        firstName: normFirst,
        lastName: normLast,
        shiftId: shift.id,
        createdAt: serverTimestamp(),
      });
    }

    if (lookupRef) {
      const lookupData =
        lookupSnap?.exists()
          ? lookupSnap.data()
          : {};

      const lookupEntries = Array.isArray(
        lookupData.entries
      )
        ? lookupData.entries.filter(
            (entry) =>
              entry &&
              entry.registrationId !==
                registrationRef.id
          )
        : [];

      lookupEntries.push({
        registrationId: registrationRef.id,

        firstName,
        normalizedFirstName: normFirst,
        lastName,
        normalizedLastName: normLast,
        phone,
        normalizedPhone: phone,
        email,
        emailHash,
        emailGuardKey,

        is18OrOlder:
          typeof candidate.is18OrOlder === "boolean"
            ? candidate.is18OrOlder
            : null,

        positionId: position.id,
        positionName: position.name,
        shiftId: shift.id,
        shiftStartTime: shift.startTime,
        shiftEndTime: shift.endTime,
        shiftLabel: formatShiftTime(shift),
        status: "registered",
        cancelledAt: null,
        registrationSource: "city_import",
      });

      const registrationIds = Array.isArray(
        lookupData.registrationIds
      )
        ? [...lookupData.registrationIds]
        : [];

      if (!registrationIds.includes(registrationRef.id)) {
        registrationIds.push(registrationRef.id);
      }

      tx.set(
        lookupRef,
        {
          eventId: CONFIG.eventId,
          normalizedLastName: normLast,
          entries: lookupEntries,
          registrationIds,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }
  });

  return registrationRef.id;
}

async function loadExistingRegistrations() {
  const snapshot = await getDocs(
    collection(db, REGISTRATIONS_COLLECTION)
  );

  return snapshot.docs.map((item) => ({
    id: item.id,
    ...item.data(),
  }));
}

async function loadShiftCounts() {
  const snapshot = await getDocs(
    collection(db, SHIFT_COUNTS_COLLECTION)
  );

  return new Map(
    snapshot.docs.map((item) => [
      item.data().shiftId || item.id.split("_").pop(),
      item.data(),
    ])
  );
}

function findExistingDuplicate(candidate) {
  const normFirst =
    normalizeFirstName(candidate.firstName);
  const normLast =
    normalizeLastName(candidate.lastName);
  const phone =
    normalizePhoneNumber(candidate.phone);
  const email =
    normalizeEmail(candidate.email);

  return existingRegistrations.find((record) => {
    if (
      record.status === "cancelled" ||
      record.shiftId !== candidate.shiftId ||
      normalizeFirstName(record.firstName) !== normFirst ||
      normalizeLastName(record.lastName) !== normLast
    ) {
      return false;
    }

    const samePhone =
      phone &&
      normalizePhoneNumber(record.phone) === phone;

    const sameEmail =
      email &&
      normalizeEmail(record.email) === email;

    return Boolean(
      samePhone ||
      sameEmail
    );
  });
}

function findConfiguredShift(shiftId) {
  for (const position of VOLUNTEER_POSITIONS) {
    const shift = position.shifts.find(
      (item) => item.id === shiftId
    );

    if (shift) {
      return {
        ...shift,
        positionId: position.id,
        positionName: position.name,
      };
    }
  }

  return null;
}

function shiftDocId(shiftId) {
  return `${CONFIG.eventId}_${shiftId}`;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function extractEmail(value) {
  const match = String(value || "").match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
  );

  return match ? match[0].toLowerCase() : "";
}

function friendlyImportError(error) {
  const code = error?.code || error?.message;

  if (code === "permission-denied") {
    return "Firebase denied this admin write. Check the admin account and Firestore rules.";
  }

  if (code === "DUPLICATE_SHIFT") {
    return "This volunteer is already registered for this shift.";
  }

  if (code === "SHIFT_UNAVAILABLE") {
    return "The selected position or shift is no longer configured.";
  }

  return "The volunteer could not be imported. Review the row and try again.";
}

function adminDisplayName(profile, user) {
  return (
    [
      profile?.firstName,
      profile?.lastName,
    ]
      .filter(Boolean)
      .join(" ")
      .trim() ||
    profile?.name ||
    profile?.displayName ||
    profile?.email ||
    user?.email ||
    "Admin"
  );
}

function findPositionId(positionId) {
  return getPositionById(positionId)?.id || "";
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value ?? "";
}

function setMessage(id, message, kind = "error") {
  const element = $(id);
  if (!element) return;

  element.className = kind === "success" ? "success" : "error";
  element.textContent = message || "";
}

function clearMessage(id) {
  const element = $(id);
  if (!element) return;
  element.className = "error";
  element.textContent = "";
}

function formatEventDate(value) {
  const [
    year,
    month,
    day,
  ] = String(value)
    .split("-")
    .map(Number);

  if (!year || !month || !day) return value;

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(year, month - 1, day));
}
