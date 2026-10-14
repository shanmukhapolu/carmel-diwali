import {
  CONFIG,
  formatShiftTime,
  getPositionById,
  getShiftById
} from "../config.js";
import { db } from "../firebase-init.js";
import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const TIME_ZONE = CONFIG.timeZone || "America/New_York";
const TIME_ZONE_LABEL = CONFIG.timeZoneLabel || "Eastern Time";
let records = [];
let groups = [];
let selected = null;
let verificationStatuses = new Map();

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[ch]);
}

function dateValue(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function serialize(value) {
  if (value?.toDate) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialize(item)]));
  }
  return value;
}

function normalizeShift(record) {
  const shift = getShiftById(record.positionId, record.shiftId);
  if (shift) {
    return {
      ...record,
      shiftId: shift.id,
      shiftStartTime: shift.startTime,
      shiftEndTime: shift.endTime,
      shiftLabel: formatShiftTime(shift)
    };
  }
  return record;
}

async function loadRecords() {
  const [registrationSnap, checkinSnap, verificationSnap] = await Promise.all([
    getDocs(query(collection(db, "registrations"), orderBy("createdAt", "desc"))),
    getDocs(collection(db, "checkins")),
    getDocs(collection(db, "volunteerVerification"))
  ]);
  verificationStatuses = new Map(verificationSnap.docs.map((item) => [item.id, item.data()]));
  const checkins = new Map(checkinSnap.docs.map((item) => [
    item.id,
    serialize({ id: item.id, ...item.data() })
  ]));
  return registrationSnap.docs.map((item) => {
    const record = normalizeShift(serialize({ id: item.id, ...item.data() }));
    return { ...record, checkin: checkins.get(item.id) || { status: "registered" } };
  });
}

function personName(record) {
  return [record.firstName, record.lastName].filter(Boolean).join(" ").trim() || "Name not provided";
}

function norm(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function personKey(record) {
  const name = norm(personName(record));
  return name && name !== "name not provided" ? "name:" + name : "registration:" + record.id;
}

function groupPeople(items) {
  const map = new Map();
  items.forEach((record) => {
    const key = personKey(record);
    if (!map.has(key)) map.set(key, { key, name: personName(record), records: [], emails: new Set(), phones: new Set() });
    const group = map.get(key);
    group.records.push(record);
    if (record.email) group.emails.add(String(record.email).trim().toLowerCase());
    if (record.phone) group.phones.add(String(record.phone).trim());
  });
  return Array.from(map.values()).map((group) => ({
    ...group,
    records: group.records.slice().sort((a, b) =>
      (dateValue(a.createdAt)?.getTime() || 0) - (dateValue(b.createdAt)?.getTime() || 0)),
    emails: Array.from(group.emails),
    phones: Array.from(group.phones)
  })).map((group) => {
    group.isUnder18 = group.records.some((record) => record.is18OrOlder === false || record.is18OrOlder === "no" || record.is18OrOlder === "false");
    group.status = verificationStatuses.get(encodeURIComponent(group.key)) || {};
    group.includedShiftIds = group.records.filter((record) => (duration(record)?.minutes || 0) > 0).map((record) => record.id);
    return group;
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function positionName(record) {
  return getPositionById(record.positionId)?.name || record.positionName || record.position || "Volunteer";
}

function shiftName(record) {
  const configured = getShiftById(record.positionId, record.shiftId);
  if (configured) return formatShiftTime(configured);
  return record.shiftLabel || "Shift time not specified";
}

function timestamp(value) {
  const date = dateValue(value);
  if (!date) return "Not recorded";
  return date.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZone: TIME_ZONE
  });
}

function duration(record) {
  const checkin = record.checkin || {};
  const start = dateValue(checkin.checkedInAt);
  const end = dateValue(checkin.checkedOutAt);
  if (!start || !end || end < start) return null;
  const method = ["actual_current_time", "estimated_shift_end", "custom"].includes(checkin.checkoutMethod)
    ? checkin.checkoutMethod : inferCheckoutMethod(record, end);
  return { minutes: (end.getTime() - start.getTime()) / 60000, method, start, end };
}

function inferCheckoutMethod(record, end) {
  const position = getPositionById(record.positionId);
  const shift = position?.shifts?.find((item) => item.id === record.shiftId) ||
    position?.shifts?.find((item) =>
      String(item.startTime) === String(record.shiftStartTime) &&
      String(item.endTime) === String(record.shiftEndTime));
  if (!shift?.endTime) return "actual_current_time";

  const raw = String(shift.endTime).replace(/\D/g, "").padStart(4, "0").slice(-4);
  if (!/^\d{4}$/.test(raw)) return "actual_current_time";

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(end);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const localDate = values.year + "-" + values.month + "-" + values.day;
  const localTime = values.hour + values.minute;

  return localDate === CONFIG.eventDate &&
    localTime === raw &&
    values.second === "00" &&
    end.getMilliseconds() === 0
    ? "estimated_shift_end"
    : "actual_current_time";
}

function hoursSummary(items) {
  const sum = {
    all: 0, actual: 0, estimated: 0, custom: 0, timed: 0,
    missingIn: 0, missingOut: 0, incomplete: 0
  };
  items.forEach((record) => {
    const start = dateValue(record.checkin?.checkedInAt);
    const end = dateValue(record.checkin?.checkedOutAt);
    const time = duration(record);
    if (time) {
      sum.all += time.minutes;
      sum.timed += 1;
      if (time.method === "estimated_shift_end") sum.estimated += time.minutes;
      else if (time.method === "custom") sum.custom += time.minutes;
      else sum.actual += time.minutes;
    }
    if (!start) sum.missingIn += 1;
    if (start && !end) sum.missingOut += 1;
    if (!time) sum.incomplete += 1;
  });
  return sum;
}

function showHours(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0 hrs";
  const n = Math.round(minutes);
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (h && m) return h + "h " + m + "m";
  if (h) return h + (h === 1 ? " hr" : " hrs");
  return m + " min";
}

function checkoutLabel(record) {
  const end = dateValue(record.checkin?.checkedOutAt);
  if (!end) return record.checkin?.status === "checked_in" ? "Still checked in · no checkout" : "No checkout recorded";
  const time = duration(record);
  if (time?.method === "estimated_shift_end") return "Estimated shift end";
  if (time?.method === "custom") return "Custom/admin time";
  return "Actual booth checkout";
}

function stateLabel(record) {
  return ({
    registered: "No check-in recorded",
    late: "Marked late · no check-in",
    checked_in: "Checked in",
    completed: "Checkout recorded"
  })[record.checkin?.status || "registered"] || "Unknown";
}

function matches(group, queryText) {
  const q = norm(queryText);
  if (!q) return false;
  const digits = q.replace(/\D/g, "");
  return group.records.some((record) => {
    const fields = [
      personName(record), record.firstName, record.lastName,
      record.email, record.phone, record.id, record.confirmationId
    ].map(norm);
    if (fields.some((field) => field.includes(q))) return true;
    if (digits.length >= 4 && String(record.phone || "").replace(/\D/g, "").includes(digits)) return true;
    return false;
  });
}

function renderResults() {
  const root = $("verification-results");
  if (!root) return;
  const queryText = $("verification-search")?.value.trim() || "";
  const ageFilter = $("verification-age-filter")?.value || "";
  const completionFilter = $("verification-completion-filter")?.value || "";
  const found = groups.filter((group) => {
    if (queryText && !matches(group, queryText)) return false;
    if (ageFilter === "under18" && !group.isUnder18) return false;
    if (ageFilter === "18plus" && group.isUnder18) return false;
    if (completionFilter === "incomplete" && group.status?.verificationComplete && group.status?.certificateEmailed) return false;
    if (completionFilter === "complete" && !(group.status?.verificationComplete && group.status?.certificateEmailed)) return false;
    return true;
  });
  if (!found.length) {
    root.innerHTML = "<section class='panel verification-empty'><h2>No matching volunteers</h2><p>Check the spelling or try another name, email, or phone number.</p></section>";
    if (selected) {
      selected = null;
      renderDetail();
    }
    return;
  }
  root.innerHTML = "<section class='panel verification-results-panel'><div class='verification-results-heading'><div><p class='eyebrow'>Matching volunteers</p><h2>" +
    found.length + (found.length === 1 ? " volunteer found" : " volunteers found") +
    "</h2></div><span class='verification-hint'>" +
    (found.length > 1 ? "Choose the correct person" : "Select to review attendance") +
    "</span></div><div class='verification-candidate-list'>" +
    found.map((group) => {
      const roles = Array.from(new Set(group.records.map(positionName)));
      const summary = hoursSummary(group.records);
      return "<button type='button' class='verification-candidate " +
        (selected?.key === group.key ? "selected" : "") + "' data-verification-key='" + esc(group.key) + "'>" +
        "<span class='verification-avatar'>" + esc((group.name[0] || "?").toUpperCase()) + "</span>" +
        "<span class='verification-candidate-main'><strong>" + esc(group.name) + "</strong><span>" +
        esc(roles.join(" · ")) + "</span><small>Email: " + esc(group.emails.join(", ") || "Not provided") +
        "</small><small>Phone: " + esc(group.phones.join(", ") || "Not provided") +
        "</small><small>" + group.records.length + " shift record(s)</small></span>" +
        "<span class='verification-candidate-hours'><strong>" + esc(showHours(summary.all)) +
        "</strong><small>recorded duration</small></span><span class='verification-candidate-arrow'>›</span></button>";
    }).join("") + "</div>" +
    (found.length > 1 ? "<p class='muted verification-privacy-note'>A contact detail may be shared by family members. Choose the individual volunteer by name.</p>" : "") +
    "</section>";

  root.querySelectorAll("[data-verification-key]").forEach((button) => {
    button.addEventListener("click", () => {
      selected = found.find((group) => group.key === button.dataset.verificationKey) || null;
      renderResults();
      renderDetail();
    });
  });
}

function completeServiceDescription(value) {
  const text = String(value || "").trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
  if (!text) return "Their time and effort helped make " + CONFIG.eventName + " a success.";
  if (/helped make .+ a success$/i.test(text)) return text + ".";
  return text + ". Their time and effort helped make " + CONFIG.eventName + " a success.";
}

function personalizedServiceDescription(items) {
  const taskByName = {
    "event set-up": "helped prepare the festival grounds and activity areas before the event opened",
    "vendor assistant": "supported festival vendors with setup and event-day needs",
    "event runner / general support": "provided hands-on operational support to event staff as needs arose",
    "swagat committee": "welcomed attendees and helped direct guests through the festival",
    "laddoo distribution": "helped organize and distribute laddoos to festival attendees",
    "diya distribution": "helped distribute diyas to attendees throughout the festival",
    "flower bracelet making": "supported the flower-bracelet activity for festival attendees",
    "rangoli crew": "helped prepare and support the rangoli area and its activities",
    "back stage": "supported backstage coordination for festival performances",
    "guest services": "answered guest questions and provided directions and event information at the main booth",
    "block printing": "guided children through a hands-on block-printing activity",
    "parking assistants": "directed attendees and volunteers to parking and helped keep traffic organized",
    "tear down & clean up": "helped dismantle event areas and restore the grounds after the festival"
  };
  const tasks = Array.from(new Set((items || []).map((record) => {
    const role = positionName(record);
    return taskByName[norm(role)] ||
      "contributed to the work and responsibilities of the " + role + " team";
  })));

  if (!tasks.length) {
    return completeServiceDescription(
      "This volunteer contributed to the work and responsibilities of the volunteer team"
    );
  }

  const firstTask = tasks[0].charAt(0).toLowerCase() + tasks[0].slice(1);
  const additionalTasks = tasks.slice(1).map((task) => {
    const phrase = task.charAt(0).toLowerCase() + task.slice(1);
    return "They also " + phrase + ".";
  });
  const description = "This volunteer " + firstTask + ". " +
    additionalTasks.join(" ") +
    (additionalTasks.length ? " " : "") +
    "Their time and effort helped make " + CONFIG.eventName + " a success.";
  return completeServiceDescription(description);
}

function volunteerShiftSummary(items) {
  return Array.from(new Set(items.map((record) =>
    positionName(record) + " · " + shiftName(record)
  ))).join("; ");
}

function renderDetail() {
  const root = $("verification-detail");
  if (!root) return;
  if (!selected) {
    root.innerHTML = "<section class='panel verification-empty verification-detail-placeholder'><div class='verification-empty-icon'>▤</div><h2>Volunteer attendance</h2><p>Select a volunteer to review their shifts, attendance timestamps, and document details.</p></section>";
    return;
  }

  if (!Array.isArray(selected.includedShiftIds)) selected.includedShiftIds = selected.records.filter((record) => (duration(record)?.minutes || 0) > 0).map((record) => record.id);
  const includedRecords = selected.records.filter((record) => selected.includedShiftIds.includes(record.id));
  const sum = hoursSummary(includedRecords);
  const roleText = Array.from(new Set(includedRecords.map(positionName))).join(", ");
  const serviceDescription = personalizedServiceDescription(includedRecords);
  const estimated = sum.estimated > 0;
  const custom = sum.custom > 0;
  const warning = sum.incomplete > 0 || estimated || custom;
  const shiftMarkup = selected.records.map((record, index) => {
    const time = duration(record);
    const included = selected.includedShiftIds.includes(record.id);
    const inAt = dateValue(record.checkin?.checkedInAt);
    const outAt = dateValue(record.checkin?.checkedOutAt);
    const state = time?.method === "estimated_shift_end" ? "estimated" : time ? "recorded" : "incomplete";
    const timeText = time ? showHours(time.minutes) + " · " + checkoutLabel(record) : checkoutLabel(record);
    return "<article class='verification-shift-row'><label class='verification-shift-select'><input type='checkbox' data-include-shift='" + esc(record.id) + "'" + (included ? " checked" : "") + "><span>Include</span></label><div class='verification-shift-index'>" + (index + 1) +
      "</div><div class='verification-shift-main'><strong>" + esc(positionName(record)) +
      "</strong><span>" + esc(shiftName(record)) + "</span><small>" + esc(stateLabel(record)) +
      "</small></div><div class='verification-shift-times'><span><b>In</b> " +
      esc(timestamp(inAt)) + "</span><span><b>Out</b> " + esc(timestamp(outAt)) +
      "</span><small>" + esc(timeText) + "</small></div><span class='verification-shift-status " + state +
      "'>" + (state === "estimated" ? "ESTIMATED" : state === "recorded" ? "TIMED" : "REVIEW") +
      "</span></article>";
  }).join("");

  root.innerHTML = "<section class='panel verification-volunteer-summary'><div class='verification-profile-head'><div><p class='eyebrow'>Selected volunteer</p><h2>" +
    esc(selected.name) + "</h2><p class='muted'>" + selected.records.length + " shift record(s) · " +
    (selected.isUnder18 ? "<strong class='verification-age-badge'>UNDER 18</strong> · " : "") + esc(roleText || "No shifts selected") + "</p><p class='verification-contact-detail'>Email: " + esc(selected.emails.join(", ") || "Not provided") +
    " <button type='button' class='secondary verification-copy-email' data-copy-email='" + esc(selected.emails[0] || "") + "'>Copy email</button> · Phone: " + esc(selected.phones.join(", ") || "Not provided") +
    "</p><p class='verification-status-controls'><label><input type='checkbox' id='verification-complete' " + (selected.status?.verificationComplete ? "checked" : "") + "> Verification complete</label><label><input type='checkbox' id='certificate-emailed' " + (selected.status?.certificateEmailed ? "checked" : "") + "> Certificate emailed</label><span id='verification-save-status' class='muted'>Status is tracked in Firebase</span></p></div><button id='verification-change-person' type='button' class='secondary'>Choose another</button></div>" +
    "<div class='verification-stat-grid'><div class='verification-stat'><span>Recorded time</span><strong>" +
    esc(showHours(sum.all)) + "</strong><small>" + sum.timed + " timed shifts</small></div><div class='verification-stat'><span>Actual checkout time</span><strong>" +
    esc(showHours(sum.actual)) + "</strong><small>Not estimated</small></div><div class='verification-stat'><span>Estimated duration</span><strong>" +
    esc(showHours(sum.estimated)) + "</strong><small>Shift-end placeholder</small></div><div class='verification-stat'><span>Incomplete records</span><strong>" +
    sum.incomplete + "</strong><small>of " + selected.records.length + " shift records</small></div></div>" +
    (warning ? "<div class='verification-review-note'><strong>Review recommended before issuing.</strong> " +
      (sum.missingOut ? sum.missingOut + " shift record(s) have no checkout time. " : "") +
      (sum.missingIn ? sum.missingIn + " shift record(s) have no check-in time. " : "") +
      (estimated ? "Includes " + showHours(sum.estimated) + " estimated from scheduled shift end. " : "") +
      (custom ? showHours(sum.custom) + " uses a custom/admin checkout time. " : "") +
      "The editable hours below apply to the generated document only.</div>" :
      "<div class='verification-clear-note'><strong>Attendance timestamps are complete.</strong> Review the totals and document details before issuing.</div>") +
    "<h3 class='verification-subheading'>Attendance by shift</h3><p class='muted'>Select only the shifts you want included in certified hours, roles, and description. Zero-hour shifts are excluded by default.</p><div class='verification-shift-list'>" + shiftMarkup + "</div></section>" +
    "<section class='panel verification-editor'><p class='eyebrow'>Document details</p><h2>Prepare a letter or certificate</h2>" +
    "<p class='muted'>Edits apply to the generated document only; the registration and attendance records remain unchanged. Correct attendance timestamps first through Check-In → EDIT TIMES when needed.</p>" +
    "<div class='verification-form-grid'><div class='verification-field'><label for='verification-name'>Name as it should appear</label><input id='verification-name' value='" +
    esc(selected.name) + "' autocomplete='off'></div><div class='verification-field'><label for='verification-hours'>Service hours to certify</label><input id='verification-hours' type='number' min='0' step='0.01' value='" +
    (sum.all / 60).toFixed(2) + "'><small>Calculated from selected shifts with valid check-in and checkout timestamps. Adjust only after reviewing exceptions.</small></div>" +
    "<div class='verification-field verification-field-wide'><label for='verification-roles'>Role(s) / contribution</label><input id='verification-roles' value='" +
    esc(roleText) + "'><small>Separate multiple roles with commas, semicolons, or new lines. Each role will be listed on the generated document.</small></div><div class='verification-field verification-field-wide'><label for='verification-description'>Service description</label><textarea id='verification-description' rows='3'>" + esc(serviceDescription) + "</textarea></div>" +
    "<div class='verification-field'><label for='verification-signer'>Authorized signer's name</label><input id='verification-signer' value='Sonal Sanghani' autocomplete='off'></div>" +
    "<div class='verification-field'><label for='verification-title'>Signer's title</label><input id='verification-title' value='Volunteer Coordinator'></div></div>" +
    "<p id='verification-document-error' class='error' role='alert'></p><div class='verification-actions'><button id='verification-generate-letter' type='button' class='secondary'>Generate verification letter</button><button id='verification-generate-certificate' type='button' class='primary'>Generate certificate</button></div></section>";

  root.querySelectorAll("[data-include-shift]").forEach((checkbox) => checkbox.addEventListener("change", () => {
    const id = checkbox.dataset.includeShift;
    selected.includedShiftIds = checkbox.checked ? Array.from(new Set([...selected.includedShiftIds, id])) : selected.includedShiftIds.filter((item) => item !== id);
    renderDetail();
  }));
  root.querySelectorAll("[data-copy-email]").forEach((button) => button.addEventListener("click", async () => {
    const email = button.dataset.copyEmail || "";
    if (!email) return;
    try { await navigator.clipboard.writeText(email); button.textContent = "Copied"; }
    catch { button.textContent = "Copy failed"; }
  }));
  const saveVerificationStatus = async () => {
    if (!selected) return;
    const status = {
      personKey: selected.key, personName: selected.name,
      verificationComplete: $("verification-complete")?.checked || false,
      certificateEmailed: $("certificate-emailed")?.checked || false,
      updatedAt: serverTimestamp()
    };
    try {
      await setDoc(doc(db, "volunteerVerification", encodeURIComponent(selected.key)), status, { merge: true });
      selected.status = { verificationComplete: status.verificationComplete, certificateEmailed: status.certificateEmailed };
      verificationStatuses.set(encodeURIComponent(selected.key), selected.status);
      const statusNode = $("verification-save-status"); if (statusNode) statusNode.textContent = "Saved";
      renderResults();
    } catch (error) {
      console.error("[Verification] Status save failed", error);
      const statusNode = $("verification-save-status"); if (statusNode) statusNode.textContent = "Save failed; check permissions";
    }
  };
  $("verification-complete")?.addEventListener("change", saveVerificationStatus);
  $("certificate-emailed")?.addEventListener("change", saveVerificationStatus);
  $("verification-change-person")?.addEventListener("click", () => {
    selected = null;
    renderResults();
    renderDetail();
  });
  $("verification-generate-letter")?.addEventListener("click", () => generateDocument("letter"));
  $("verification-generate-certificate")?.addEventListener("click", () => generateDocument("certificate"));
}

function driveDate(value) {
  const parts = String(value || "").split("-").map(Number);
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return "";
  const monthName = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ][parts[1] - 1];
  if (!monthName) return "";
  return monthName + " " + parts[2] + ", " + parts[0];
}

function generateDocument(kind) {
  if (!selected) return;
  const name = $("verification-name")?.value.trim() || "";
  const role = $("verification-roles")?.value.trim() || "";
  const description = $("verification-description")?.value.trim() || "";
  const signer = $("verification-signer")?.value.trim() || "";
  const signerTitle = $("verification-title")?.value.trim() || "";
  const selectedRoleSource = selected.includedShiftIds
    ? selected.records.filter((record) => selected.includedShiftIds.includes(record.id)).map(positionName).join(", ")
    : role;
  const rawRoleParts = Array.from(new Set(
    selectedRoleSource.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean)
  ));
  const certificateRoleParts = rawRoleParts.length ? rawRoleParts : ["Volunteer"];
  const certificateRoleText = certificateRoleParts.map((item) => item.toUpperCase()).join(" · ");
  const isMultipleCertificateRoles = certificateRoleParts.length > 1;
  const certificateRoleLabel = (isMultipleCertificateRoles ? "ROLES: " : "ROLE: ") + certificateRoleText;
  // Replace the fixed role pill embedded in the background with an opaque,
  // HTML-drawn panel sized to the content.
  const certificateRoleWidth = Math.min(76, Math.max(
    34,
    28 + certificateRoleParts.length * 4 + Math.min(certificateRoleText.length, 80) * 0.35
  ));
  const certificateRoleLeft = (100 - certificateRoleWidth) / 2;
  const certificateRoleFont = Math.max(
    7.4,
    Math.min(10, 10 - Math.max(0, certificateRoleText.length - 45) * 0.025 -
      Math.max(0, certificateRoleParts.length - 3) * 0.25)
  );
  const estimatedRoleLines = Math.max(
    1,
    Math.ceil(certificateRoleText.length / Math.max(34, certificateRoleWidth * 1.6))
  );
  const certificateRoleHeight = Math.min(9.6, 3.2 + estimatedRoleLines * 1.7);
  // Leave a clear gap below the service sentence and let the role panel cover
  // the smaller pill baked into the background artwork.
  const certificateRoleTop = 63.3;
  const certificateRoleGap = 0.9;
  const certificateDescriptionTop = Math.min(
    73.2,
    Math.max(68.8, certificateRoleTop + certificateRoleHeight + certificateRoleGap)
  );
  // Preserve an even breathing space before the event/date line.
  const certificateDescriptionHeight = Math.max(2.8, 77.1 - certificateDescriptionTop - 1.2);

  // Keep long recipient names on one line by shrinking the type to fit the
  // available width rather than allowing a line break.
  const nameMeasureContext = document.createElement("canvas").getContext("2d");
  if (nameMeasureContext) nameMeasureContext.font = "700 35pt Georgia, 'Times New Roman', serif";
  const measuredNameWidth = nameMeasureContext?.measureText(name).width || name.length * 22;
  const certificateNameFont = measuredNameWidth > 0
    ? Math.max(14, Math.min(35, 35 * (0.80 * 11 * 96) / measuredNameWidth))
    : 35;
  const hours = Number($("verification-hours")?.value);
  const error = $("verification-document-error");

  if (!name || !signer || !signerTitle || !Number.isFinite(hours) || hours < 0) {
    if (error) error.textContent = "Enter a volunteer name, valid non-negative hours, and the authorized signer's name and title.";
    return;
  }

  const win = window.open("", "_blank");
  if (!win) {
    if (error) error.textContent = "The document window was blocked. Allow pop-ups for this admin site and try again.";
    return;
  }
  if (error) error.textContent = "";

  const isCertificate = kind === "certificate";
  const issueDate = new Intl.DateTimeFormat("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: TIME_ZONE
  }).format(new Date());
  const eventDate = driveDate(CONFIG.eventDate);
  const hourText = hours.toLocaleString("en-US", { maximumFractionDigits: 2 }) + (hours === 1 ? " hour" : " hours");
  const includedRecords = selected.records.filter((record) => selected.includedShiftIds?.includes(record.id));
  const descriptionText = completeServiceDescription(description || personalizedServiceDescription(includedRecords));
  const signoff = "<div class='signature'><div class='signature-name'>" + esc(signer) +
    "</div><div class='signature-rule'></div><strong>" + esc(signer) +
    "</strong><span>" + esc(signerTitle) + "</span></div>";
  const certificateSignoff = "<div class='signature certificate-signature'><div class='signature-handwriting'>" +
    esc(signer) + "</div><div class='signature-rule'></div><strong class='signature-printed-name'>" +
    esc(signer) + "</strong><span>" + esc(signerTitle) + "</span></div>";
  const certificateDate = "<div class='signature certificate-date'><strong class='date-issued-value'>" +
    esc(issueDate) + "</strong><div class='signature-rule'></div><span>Date issued</span></div>";

  let page = "";
  if (isCertificate) {
    page = "<main class='certificate ornate-certificate'>" +
      "<img class='certificate-background' src='/assets/diwali-certificate-background.png' alt='' />" +
      "<div class='certificate-overlay certificate-recipient' style='font-size:" +
      certificateNameFont.toFixed(1) + "pt'>" + esc(name) + "</div>" +
      "<div class='certificate-overlay certificate-hours'>In recognition of <strong>" + esc(hourText) + "</strong> of dedicated volunteer service<br>at the Carmel Diwali Festival of Lights.</div>" +
      "<img class='certificate-logo' src='/assets/diwali-logo.avif' alt='Carmel Diwali Festival of Lights logo' onerror='this.hidden=true' />" +
      "<div class='certificate-overlay certificate-role" +
      (isMultipleCertificateRoles ? " certificate-role-multiple" : "") +
      "' style='left:" + certificateRoleLeft.toFixed(1) + "%;width:" +
      certificateRoleWidth.toFixed(1) + "%;top:" + certificateRoleTop.toFixed(1) +
      "%;min-height:" + certificateRoleHeight.toFixed(1) + "%;font-size:" +
      certificateRoleFont.toFixed(1) + "pt'>" + esc(certificateRoleLabel) + "</div>" +
      "<div class='certificate-overlay certificate-description' style='top:" +
      certificateDescriptionTop.toFixed(1) + "%;height:" + certificateDescriptionHeight.toFixed(1) +
      "%'>" + esc(descriptionText) + "</div>" +
      "<div class='certificate-overlay certificate-event-line'>" + esc((eventDate + " | " + CONFIG.location).toUpperCase()) + "</div>" +
      "<div class='certificate-overlay certificate-signer-script'>" + esc(signer) + "</div>" +
      "<div class='certificate-overlay certificate-signer-name'>" + esc(signer) + "</div>" +
      "<div class='certificate-overlay certificate-signer-title'>" + esc(signerTitle) + "</div>" +
      "<div class='certificate-overlay certificate-issue-date'>" + esc(issueDate) + "</div>" +
      "</main>";
  } else {
    page = "<main class='letter'><div class='letter-brand'>" +
      "<img class='letter-logo' src='/assets/diwali-logo.avif' alt='Carmel Diwali Festival of Lights logo' onerror='this.hidden=true' />" +
      "<div class='letter-brand-text'><strong>" + esc(CONFIG.eventName) +
      "</strong><span>Volunteer Service Verification</span></div></div>" +
      "<div class='letter-ornament' aria-hidden='true'><span>◆</span><span>✦</span><span>◆</span></div>" +
      "<div class='issued-date'>" + esc(issueDate) + "</div><h1>Volunteer Hours Verification</h1>" +
      "<p>To whom it may concern,</p><p>This letter verifies that <strong>" + esc(name) +
      "</strong> volunteered with the <strong>" + esc(CONFIG.eventName) + "</strong>, held on <strong>" +
      esc(eventDate) + "</strong> at " + esc(CONFIG.location) + ".</p><p>Based on the event's attendance records and organizer review, " +
      esc(name) + " contributed <strong>" + esc(hourText) + "</strong> of service " +
      (rawRoleParts.length > 1 ? "across the following roles: " : "in the role of ") +
      "<strong>" + esc(rawRoleParts.join("; ") || "Volunteer") + "</strong>.</p><p>" +
      esc(descriptionText.replace(/[.!?]+$/, "")) + ".</p><p>This letter is provided at the volunteer's request for service-hour documentation. Please contact the event organizers with any questions about this verification.</p>" +
      "<div class='letter-signoff'><p>Sincerely,</p>" + signoff + "</div><div class='letter-footer'><span>" +
      esc(eventDate) + "</span><span>" + esc(CONFIG.location) + "</span></div></main>";
  }

  const css = [
    "*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}",
    "body{margin:0;background:#f4f0f9;color:#282331;font:11pt/1.7 Inter,Arial,sans-serif}",
    ".toolbar{position:sticky;top:0;display:flex;justify-content:space-between;gap:12px;padding:12px 22px;background:#fff;border-bottom:1px solid #e7e0ef;z-index:2}.toolbar span{font-size:10pt;color:#756b82}.toolbar button{border:0;border-radius:9px;padding:10px 16px;background:#6d28d9;color:#fff;font:inherit;font-weight:700;cursor:pointer}",
    ".letter,.certificate{position:relative;width:8.5in;height:auto;min-height:11in;margin:20px auto;background:#fff;box-shadow:0 10px 35px rgba(50,30,80,.1);overflow:visible}",
    ".letter{padding:.7in .82in .6in;display:flex;flex-direction:column}.letter-brand{display:flex;align-items:center;gap:14px}.monogram{display:grid;place-items:center;width:48px;height:48px;border-radius:50%;background:#4c1d95;color:#fff;font:16pt Georgia,serif}.letter-brand strong,.letter-brand span{display:block}.letter-brand strong{font-size:12pt;color:#3b1b65}.letter-brand span{font-size:9pt;color:#7b718b;letter-spacing:.03em}.accent{height:3px;background:linear-gradient(90deg,#6d28d9,#c4b5fd,#f2ecfc);margin:22px 0 25px}.issued-date{text-align:right;color:#766d81;font-size:9.5pt;margin-bottom:22px}.letter h1{font:28pt/1.14 Georgia,serif;color:#3b1b65;margin:0 0 24px;letter-spacing:-.02em}.letter p{margin:0 0 15px}.letter strong{color:#322044}.letter-signoff{margin-top:20px}.letter-signoff p{margin-bottom:20px}.signature-name{font:italic 19pt Georgia,serif;color:#5b21b6;margin-bottom:2px}.signature-rule{border-top:1px solid #b8a9ca;width:2.2in;margin:6px 0 7px}.signature strong,.signature span{display:block}.signature strong{font-size:9pt;color:#3f3152}.signature span{font-size:9pt;color:#7e738b}.letter-footer{display:flex;justify-content:space-between;gap:12px;margin-top:auto;padding-top:16px;border-top:1px solid #e8e1f0;font-size:8.5pt;color:#80768b}",
    ".certificate{padding:.4in;background:#fff}.frame{position:absolute;inset:.25in;border:1px solid #b69ae7;pointer-events:none}.frame:before{content:'';position:absolute;inset:7px;border:1px solid #e2d7f4}.certificate-inner{position:relative;height:10.2in;border:1px solid #f0eafa;padding:.43in .45in .32in;display:flex;flex-direction:column;align-items:center;text-align:center;background:radial-gradient(circle at 50% 7%,#faf7ff,white 37%)}.brand-kicker{color:#7c3aed;letter-spacing:.17em;font-size:9pt;font-weight:800}.overline{margin-top:18px;color:#857699;letter-spacing:.15em;font-size:7.8pt;font-weight:700}.certificate h1{font:30pt/1.14 Georgia,serif;color:#3b1b65;margin:25px 0 18px}.certificate h1 span{color:#6d28d9}.intro{margin:0;color:#746a81}.recipient{font:30pt/1.2 Georgia,serif;color:#4c1d95;border-bottom:1px solid #d8c7f5;min-width:4.5in;max-width:100%;overflow-wrap:anywhere;padding:0 12px 12px;margin:10px 0 18px}.short-rule{width:55px;height:3px;border-radius:10px;background:#8b5cf6;margin-bottom:17px}.main-copy{max-width:5.8in;margin:0 auto;color:#4d4559;font-size:11.5pt;line-height:1.65}.main-copy strong{color:#38224e}.event-line{margin:18px 0 0;color:#746a81;font-size:9pt}.event-line span{color:#a78bfa;padding:0 7px}.certificate-bottom{width:100%;display:grid;grid-template-columns:1fr 76px 1fr;gap:12px;align-items:end;margin-top:auto;padding-top:28px}.certificate-bottom .signature{text-align:center;min-width:0}.certificate-bottom .signature-rule{width:auto;max-width:1.7in;margin:6px auto 7px}.certificate-bottom .signature-name{font-size:14pt;min-height:24px;overflow-wrap:anywhere}.certificate-bottom .signature strong{font-size:8.5pt}.certificate-bottom .signature span{font-size:7.5pt;line-height:1.4}.seal{width:72px;height:72px;border:1px solid #a78bfa;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#6d28d9;box-shadow:inset 0 0 0 4px #f3edff}.seal strong{font:21pt Georgia,serif}.seal span{font-size:5.5pt;letter-spacing:.07em;font-weight:800;line-height:1.25}.certificate-note{border-top:1px solid #e8e1f0;margin-top:24px;padding-top:9px;width:100%;font-size:8pt;color:#8b8196}",
    "@page{size:Letter " + (isCertificate ? "landscape" : "portrait") + ";margin:0}@media print{html,body{margin:0;background:#fff}.toolbar{display:none}.letter{width:8.5in;height:auto;min-height:11in;margin:0;box-shadow:none;overflow:visible;page-break-after:avoid;break-after:avoid;padding:.7in .82in .6in}.letter-footer{margin-top:auto}.certificate{width:11in;height:auto;min-height:8.5in;margin:0;padding:.22in .28in;overflow:visible;box-shadow:none;page-break-after:avoid;break-after:avoid}}",
    "@media screen and (max-width:900px){.letter,.certificate{width:100%;min-height:100vh;margin:10px auto;height:auto}.letter{padding:34px 26px}.certificate{padding:18px}.certificate-inner{height:auto;min-height:900px;padding:30px 18px}.recipient{min-width:0;width:100%;font-size:25pt}.certificate-bottom{grid-template-columns:1fr 70px 1fr;gap:6px}}",
    ".certificate{width:11in;height:auto;min-height:8.5in;padding:.22in .28in;background:radial-gradient(ellipse at top,#fffdf6 0%,#fff 60%,#faf5ff 100%);overflow:visible}.certificate .frame{inset:.17in;border:2px solid #cba85c;box-shadow:inset 0 0 0 5px #fff,inset 0 0 0 6px #e3d2f7;z-index:0}.certificate .frame:before{inset:7px;border:1px solid #8e63b5}.certificate .mandala{position:absolute;z-index:1;top:2.4in;color:#c9a454;font-size:55pt;line-height:1;opacity:.64}.certificate .mandala-left{left:.43in}.certificate .mandala-right{right:.43in}.certificate-inner{height:auto;min-height:8.06in;padding:.25in .55in .22in;border:0;overflow:visible;justify-content:flex-start;background:radial-gradient(ellipse at 50% 0%,#faf3ff 0%,#fff 54%)}.festival-lockup{width:100%;display:grid;grid-template-columns:48px 1fr 48px;align-items:center;gap:12px;text-align:left}.festival-monogram{display:grid;place-items:center;width:44px;height:44px;border:1px solid #c59c43;border-radius:50%;box-shadow:inset 0 0 0 3px #f8edcf;background:#4c1d68;color:#f9e8b2;font:15pt Georgia,serif}.brand-kicker{color:#532564;letter-spacing:.2em;font-size:11pt;font-weight:850}.festival-subline{font-size:7.5pt;color:#86728f;letter-spacing:.13em;margin-top:2px}.festival-year{display:grid;place-items:center;width:42px;height:42px;border:1px solid #ddc58d;border-radius:50%;color:#946c22;font:13pt Georgia,serif}.certificate-ornament{color:#b38b39;letter-spacing:.32em;font-size:14pt;line-height:1;margin-top:7px}.overline{margin-top:6px;color:#8b6d9a;letter-spacing:.18em;font-size:7pt;font-weight:800}.certificate h1{font:26pt/1.12 Georgia,serif;color:#3b1b65;margin:9px 0 4px;letter-spacing:-.015em}.certificate h1 span{color:#6d28d9}.certificate .intro{margin:0;color:#746a81;font-size:9pt}.certificate .recipient{font:27pt/1.08 Georgia,serif;color:#4c1d95;border-bottom:1px solid #d8c7f5;min-width:0;width:min(7.8in,100%);max-width:100%;padding:0 12px 6px;margin:5px 0 5px;overflow-wrap:anywhere}.certificate .short-rule{width:56px;height:2px;background:#bc943f;margin:0 auto 7px}.certificate .main-copy{max-width:9.1in;margin:0 auto;color:#4d4559;font-size:10pt;line-height:1.4}.certificate .main-copy strong{color:#38224e}.certificate-note{max-width:9.1in;margin:6px auto 0;padding:0;border:0;font-size:8.3pt;line-height:1.35;color:#655772}.certificate-shifts{max-width:9.2in;margin:6px auto 0;font-size:7.7pt;line-height:1.3;color:#6c5b7c}.certificate-shifts span{display:block;color:#986f25;font-size:6.5pt;font-weight:850;letter-spacing:.14em;margin-bottom:2px}.certificate .event-line{margin:6px 0 0;color:#746a81;font-size:8pt}.certificate .event-line span{color:#b38b39;padding:0 7px}.certificate-bottom{width:86%;display:grid;grid-template-columns:1fr 110px 1fr;gap:14px;align-items:end;margin: auto auto 0;padding-top:9px}.certificate-bottom .signature{text-align:center;min-width:0}.certificate-bottom .signature-rule{width:auto;max-width:2in;border-color:#c3a961;margin:5px auto 5px}.certificate-bottom .signature-name{font-size:12pt;min-height:18px;overflow-wrap:anywhere}.certificate-bottom .signature strong{font-size:8pt;color:#3f3152}.certificate-bottom .signature span{font-size:7pt;line-height:1.3}.diya-seal{display:flex;flex-direction:column;justify-content:center;align-items:center;gap:0}.diya-seal svg{width:95px;height:40px}.diya-seal span{font-size:5.5pt;letter-spacing:.1em;color:#8b6a32;font-weight:800}@media screen and (max-width:900px){.certificate{width:100%;height:auto;min-height:0;padding:18px}.certificate-inner{height:auto;min-height:700px;padding:28px 20px}.certificate .mandala{display:none}.certificate-bottom{width:100%;grid-template-columns:1fr 80px 1fr}.certificate .recipient{width:100%;font-size:25pt}}@media print{.letter{height:auto;min-height:11in;overflow:visible}.certificate{width:11in;height:auto;min-height:8.5in;padding:.22in .28in;overflow:visible;box-shadow:none;page-break-after:avoid;break-after:avoid}}",
    ".letter{background:#fffaf0;border:3px double #c8a65b;color:#302333;box-shadow:inset 0 0 0 6px #fffaf0,inset 0 0 0 7px #ead9ad}.letter-brand{gap:17px}.letter-logo{display:block;width:66px;height:66px;flex:0 0 66px;object-fit:contain;object-position:center}.letter-brand-text{min-width:0}.letter-brand strong{font:600 18pt/1.15 'Cormorant Garamond',Georgia,serif;color:#45184f;letter-spacing:.015em}.letter-brand span{display:block;margin-top:4px;color:#806c83;letter-spacing:.13em;text-transform:uppercase;font:600 8pt/1.3 'EB Garamond',Georgia,serif}.letter-ornament{display:flex;align-items:center;justify-content:center;gap:8px;margin:25px 0 27px;color:#b38a35;font:12pt/1 Georgia,serif}.letter-ornament span:nth-child(2){font-size:17pt;color:#532564}.issued-date{color:#796780;font:italic 11pt/1.3 'EB Garamond',Georgia,serif;margin-bottom:20px}.letter h1{font:600 29pt/1.08 'Cormorant Garamond',Georgia,serif;color:#45184f;letter-spacing:.005em;margin:0 0 23px}.letter p{color:#302637;font:12.3pt/1.65 'EB Garamond',Georgia,serif}.letter strong{color:#39203e;font-weight:700}.letter-signoff{margin-top:20px}.signature-name{font:28pt/1 'Allura','Dancing Script',cursive;color:#532564;margin-bottom:1px}.signature-rule{border-top:1px solid #bd9849;width:2.35in;margin:2px 0 7px}.signature strong{font:700 11pt/1.2 'EB Garamond',Georgia,serif;color:#45184f;letter-spacing:.035em}.signature span{font:500 10pt/1.3 'EB Garamond',Georgia,serif;color:#766680}.letter-footer{border-top:1px solid #d9c58f;color:#786983;font:10pt/1.3 'EB Garamond',Georgia,serif;padding-top:13px}.letter-footer span:first-child{color:#946c22}",
  ];

  const certificateCss = `

    @page{size:Letter landscape;margin:0}
    .certificate.ornate-certificate{position:relative;isolation:isolate;box-sizing:border-box;width:11in;height:8.5in;min-width:11in;min-height:8.5in;margin:20px auto;padding:0;overflow:hidden;background:#fdfaf2;color:#391344;box-shadow:0 8px 30px rgba(35,15,47,.12);-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .certificate-background{position:absolute;z-index:0;left:0;top:0;display:block;width:100%;height:100%;max-width:none;object-fit:fill}
    .certificate-logo{position:absolute;z-index:2;left:4.4%;top:3.2%;width:7.2%;height:8.2%;object-fit:contain;object-position:center}
    .certificate-overlay{position:absolute;z-index:1;display:flex;align-items:center;justify-content:center;box-sizing:border-box;margin:0;padding:0;text-align:center}
    .certificate-recipient{left:9%;width:82%;top:42.6%;height:8.6%;font:700 35pt/1.08 Georgia,'Times New Roman',serif;color:#36103f;white-space:nowrap;overflow:hidden;overflow-wrap:normal}
    .certificate-hours{left:26%;width:48%;top:54.5%;height:7.3%;flex-direction:column;font:11.3pt/1.28 Georgia,'Times New Roman',serif;color:#45294c}
    .certificate-hours strong{font-weight:700;color:#36103f}
    .certificate-role{position:relative;left:33%;width:34%;top:63.3%;height:auto;min-height:4.8%;max-height:9.6%;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:.12in .18in;border:1.4px solid #b38a35;border-radius:9px;background:#fffaf0;color:#45184f;font:700 11pt/1.14 'Cormorant Garamond',Georgia,serif;letter-spacing:.035em;text-align:center;white-space:normal;overflow:visible;overflow-wrap:anywhere;box-shadow:inset 0 0 0 3px #fffaf0,inset 0 0 0 4px rgba(179,138,53,.28)}
    .certificate-role::before{content:'';position:absolute;inset:4px;border:1px solid rgba(179,138,53,.34);border-radius:5px;pointer-events:none}
    .certificate-role-multiple{letter-spacing:.015em;line-height:1.12}
    .certificate-description{left:22%;width:56%;top:68.1%;height:7.1%;font:10.2pt/1.28 Georgia,'Times New Roman',serif;color:#4b304e;overflow:hidden;padding:0 2px}
    .certificate-event-line{left:23%;width:54%;top:77.1%;height:3.4%;font:700 8.9pt/1.1 Georgia,'Times New Roman',serif;letter-spacing:.12em;color:#5f145e;white-space:nowrap;overflow:hidden}
    .certificate-signer-script{left:18%;width:28%;top:81.9%;height:5.8%;font:27pt/1 'Allura','Dancing Script','Segoe Script',cursive;color:#351143;white-space:nowrap;overflow:hidden}
    .certificate-signer-name{left:18%;width:28%;top:89.2%;height:2.1%;font:700 9.2pt/1.1 Georgia,'Times New Roman',serif;color:#4b1b4e}
    .certificate-signer-title{left:18%;width:28%;top:91.2%;height:2%;font:9pt/1.1 Georgia,'Times New Roman',serif;color:#67536d}
    .certificate-issue-date{left:60%;width:22%;top:84.2%;height:3.4%;font:600 11pt/1.1 Georgia,'Times New Roman',serif;color:#40164e;white-space:nowrap}
    @media screen and (max-width:1100px){
      .certificate.ornate-certificate{width:calc(100vw - 24px);height:auto;min-width:0;min-height:0;aspect-ratio:1320 / 1020;margin:16px auto}
      .certificate-recipient{font-size:3.05vw}
      .certificate-hours{font-size:1.05vw;line-height:1.26}
      .certificate-role{font-size:1.03vw}
      .certificate-description{font-size:.95vw}
      .certificate-event-line{font-size:.78vw}
      .certificate-signer-script{font-size:2.45vw}
      .certificate-signer-name{font-size:.78vw}
      .certificate-signer-title{font-size:.76vw}
      .certificate-issue-date{font-size:.9vw}
    }
    @media print{
      html,body{width:11in;height:8.5in;margin:0;padding:0;background:#fff}
      .toolbar{display:none!important}
      .certificate.ornate-certificate{width:11in;height:8.5in;min-width:11in;min-height:8.5in;margin:0;padding:0;overflow:hidden;box-shadow:none;break-after:avoid;page-break-after:avoid}
      .certificate-background{width:11in;height:8.5in}
    }
  `;
  const html = "<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>" +
    esc(CONFIG.eventName) + " · " + (isCertificate ? "Volunteer Certificate" : "Hours Verification Letter") +
    "</title><link rel='preconnect' href='https://fonts.googleapis.com'><link rel='preconnect' href='https://fonts.gstatic.com' crossorigin>" +
    "<link href='https://fonts.googleapis.com/css2?family=Allura&family=Cormorant+Garamond:wght@400;500;600;700&family=EB+Garamond:wght@400;500;600;700&family=Dancing+Script:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap' rel='stylesheet'><style>" +
    css.join("\n") + (isCertificate ? certificateCss : "") + "</style></head><body><div class='toolbar'><span>" +
    (isCertificate ? "Volunteer service certificate" : "Volunteer service verification letter") +
    " · Review, then print or save as PDF</span><button onclick='window.print()'>Print / Save PDF</button></div>" +
    page + "<script>window.addEventListener('load',()=>{const printWhenReady=()=>setTimeout(()=>{window.focus();window.print();},100);if(document.fonts&&document.fonts.ready){document.fonts.ready.then(printWhenReady).catch(printWhenReady)}else{printWhenReady()}});<\/script></body></html>";

  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
}

export async function initVerificationPage() {
  const results = $("verification-results");
  if (results) results.innerHTML = "<section class='panel'><p class='muted'>Loading volunteer attendance…</p></section>";
  $("verification-search")?.addEventListener("input", renderResults);
  try {
    records = await loadRecords();
    groups = groupPeople(records);
    renderResults();
    renderDetail();
  } catch (error) {
    console.error("[Verification] Could not load volunteer records", { code: error?.code || "unknown" });
    if (results) results.innerHTML = "<section class='panel'><h2>Could not load volunteer records</h2><p class='muted'>Refresh the page or check your administrator access.</p></section>";
  }
}
