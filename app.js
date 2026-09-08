// ============================================================================
// app.js
//
// UI + form logic for the Carmel Diwali Festival volunteer registration form.
//
// Firebase initialization lives in firebase-init.js; this file orchestrates
// the DOM and talks to Firebase.
//
// SECURITY REMINDERS:
//   - Never insert user-entered text with innerHTML. Use textContent.
//   - Never log volunteer PII to the console.
//   - Never put volunteer PII into URLs, localStorage, or sessionStorage.
//   - Client-side validation is UX only. Firestore Security Rules and any
//     trusted backend must provide the authoritative security boundary.
// ============================================================================

import {
  CONFIG,
  VOLUNTEER_POSITIONS,
  formatTime,
  formatShiftTime,
  getPositionById,
  getShiftById,
  findShift,
  normalizeLastName,
  normalizePhoneNumber,
} from "./config.js";

import { db, logSafeEvent } from "./firebase-init.js";

import {
  doc,
  getDoc,
  collection,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

// ----------------------------------------------------------------------------
// DOM references
// ----------------------------------------------------------------------------

const form = document.getElementById("registration-form");
const confirmationView = document.getElementById("confirmation-view");
const statusLive = document.getElementById("status-live");

const positionShiftList = document.getElementById("slot-grid");

const submitBtn = document.getElementById("submit-btn");
const errSubmit = document.getElementById("err-submit");

// ----------------------------------------------------------------------------
// Module state
// ----------------------------------------------------------------------------

let selectedPositionId = null;
let selectedShiftId = null;

let shiftAvailability = {};
let submissionInFlight = false;

let eventConfig = { ...CONFIG };

// ============================================================================
// Pure helper functions
// ============================================================================

function parseIsoDate(value) {
  if (typeof value !== "string") return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());

  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  return { year, month, day };
}

function formatDisplayDate(isoDate, { weekday = false } = {}) {
  const parts = parseIsoDate(isoDate);

  if (!parts) return isoDate;

  const date = new Date(
    parts.year,
    parts.month - 1,
    parts.day
  );

  return date.toLocaleDateString("en-US", {
    ...(weekday ? { weekday: "long" } : {}),
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function isLikelyValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    String(value || "").trim()
  );
}

function formatPhoneNumber(value) {
  const digits = String(value || "")
    .replace(/\D/g, "")
    .slice(0, 10);

  if (digits.length <= 3) {
    return digits;
  }

  if (digits.length <= 6) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  }

  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function normalizePhoneInput(event) {
  event.target.value = formatPhoneNumber(event.target.value);
}

function formatShiftDuration(startTime, endTime) {
  const start = Number(startTime.slice(0, 2)) * 60 +
    Number(startTime.slice(2));

  const end = Number(endTime.slice(0, 2)) * 60 +
    Number(endTime.slice(2));

  const minutes = end - start;

  if (minutes <= 0) {
    return "";
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours > 0 && remainingMinutes > 0) {
    return `${hours} hr ${remainingMinutes} min`;
  }

  if (hours > 0) {
    return `${hours} hr`;
  }

  return `${remainingMinutes} min`;
}

// ============================================================================
// Event configuration
// ============================================================================

async function loadEventSettings() {
  try {
    const snap = await getDoc(
      doc(db, "eventSettings", CONFIG.eventId)
    );

    if (!snap.exists()) {
      return;
    }

    const data = snap.data();

    eventConfig = {
      ...CONFIG,
      eventName: data.eventName || CONFIG.eventName,
      eventDate: data.eventDate || CONFIG.eventDate,
      location: data.location || CONFIG.location,
      timeZone: data.timeZone || CONFIG.timeZone,
      timeZoneLabel:
        data.timeZoneLabel || CONFIG.timeZoneLabel,
    };
  } catch (error) {
    logRegistrationStep(
      "Event settings load failed; using bundled defaults",
      {
        code: error?.code || error?.message || "unknown",
      }
    );
  }
}

function eventRegistrationTitle() {
  return `${eventConfig.eventName} Volunteer Registration`;
}

function renderConfigurableCopy() {
  document.title = eventRegistrationTitle();

  const metaDescription = document.querySelector(
    'meta[name="description"]'
  );

  if (metaDescription) {
    metaDescription.setAttribute(
      "content",
      `Register to volunteer at ${eventConfig.eventName}.`
    );
  }

  const title = document.querySelector(".title");

  if (title) {
    title.textContent = eventRegistrationTitle();
  }

  const submitLabel =
    `Register for ${eventConfig.eventName}`;

  if (submitBtn) {
    submitBtn.textContent = submitLabel;
  }

  const dateElements = document.querySelectorAll(
    "[data-event-date]"
  );

  dateElements.forEach((element) => {
    element.textContent = formatDisplayDate(
      eventConfig.eventDate,
      { weekday: true }
    );
  });

  const locationElements = document.querySelectorAll(
    "[data-event-location]"
  );

  locationElements.forEach((element) => {
    element.textContent = eventConfig.location;
  });
}

// ============================================================================
// Header
// ============================================================================

function renderHeader() {
  const factDate = document.getElementById("fact-date");
  const factTime = document.getElementById("fact-time");
  const factLocation = document.getElementById("fact-location");

  if (factDate) {
    factDate.textContent = formatDisplayDate(
      eventConfig.eventDate,
      { weekday: true }
    );
  }

  if (factTime) {
    factTime.textContent = "Volunteer shifts throughout the day";
  }

  if (factLocation) {
    factLocation.textContent = eventConfig.location;
  }
}

// ============================================================================
// Position / shift rendering
// ============================================================================

function renderPositionShiftList() {
  if (!positionShiftList) {
    return;
  }

  positionShiftList.textContent = "";

  for (const position of VOLUNTEER_POSITIONS) {
    const positionCard =
      document.createElement("section");

    positionCard.className = "position-card";
    positionCard.dataset.positionId =
      position.id;

    const positionHeader =
      document.createElement("div");

    positionHeader.className =
      "position-header";

    const headerText =
      document.createElement("div");

    headerText.className =
      "position-header-text";

    const title =
      document.createElement("h3");

    title.className =
      "position-title";

    title.textContent =
      position.name;

    const description =
      document.createElement("p");

    description.className =
      "position-description";

    description.textContent =
      position.description || "";

    headerText.appendChild(title);
    headerText.appendChild(description);

    positionHeader.appendChild(headerText);

    const shiftList =
      document.createElement("div");

    shiftList.className =
      "shift-list";

    shiftList.setAttribute(
      "role",
      "group"
    );

    shiftList.setAttribute(
      "aria-label",
      `${position.name} shifts`
    );

    for (const shift of position.shifts) {
      const availability =
        shiftAvailability[shift.id] || {
          capacity: shift.capacity,
          count: 0,
        };

      const capacity =
        Number(availability.capacity);

      const count =
        Number(availability.count);

      const remaining =
        Math.max(
          0,
          capacity - count
        );

      const isFull =
        remaining <= 0;

      const isSelected =
        selectedPositionId === position.id &&
        selectedShiftId === shift.id;

      const button =
        document.createElement("button");

      button.type = "button";

      button.className =
        "shift-btn" +
        (isSelected ? " selected" : "") +
        (isFull ? " full" : "");

      button.disabled = isFull;

      button.setAttribute(
        "aria-pressed",
        String(isSelected)
      );

      button.dataset.positionId =
        position.id;

      button.dataset.shiftId =
        shift.id;

      const timeElement =
        document.createElement("span");

      timeElement.className =
        "shift-time";

      timeElement.textContent =
        formatShiftTime(
          shift.startTime,
          shift.endTime
        );

      const duration =
        formatShiftDuration(
          shift.startTime,
          shift.endTime
        );

      const capacityElement =
        document.createElement("span");

      capacityElement.className =
        "shift-capacity";

      if (isFull) {
        capacityElement.textContent =
          "Full";
      } else if (isSelected) {
        capacityElement.textContent =
          "✓ Selected";
      } else {
        capacityElement.textContent =
          `${remaining} spot${
            remaining === 1 ? "" : "s"
          } left`;
      }

      button.appendChild(timeElement);
      button.appendChild(capacityElement);

      if (duration) {
        const durationElement =
          document.createElement("span");

        durationElement.className =
          "shift-duration";

        durationElement.textContent =
          duration;

        button.appendChild(
          durationElement
        );
      }

      if (!isFull) {
        button.addEventListener(
          "click",
          () => {
            selectedPositionId =
              position.id;

            selectedShiftId =
              shift.id;

            renderPositionShiftList();

            setError("slot", "");

            announce(
              `${position.name}, ${formatShiftTime(
                shift.startTime,
                shift.endTime
              )} selected.`
            );
          }
        );
      }

      shiftList.appendChild(button);
    }

    positionCard.appendChild(
      positionHeader
    );

    positionCard.appendChild(
      shiftList
    );

    positionShiftList.appendChild(
      positionCard
    );
  }
}

// ============================================================================
// Shift availability
// ============================================================================

function shiftDocId(shiftId) {
  return `${eventConfig.eventId}_${shiftId}`;
}

/**
 * Best-effort read of current shift availability.
 *
 * This is only for display. The authoritative capacity check happens
 * inside the Firestore transaction in reserveShiftAndCreateRegistration().
 */
async function loadShiftAvailability() {
  const results = await Promise.allSettled(
    VOLUNTEER_POSITIONS.flatMap((position) =>
      position.shifts.map(async (shift) => {
        const ref = doc(
          db,
          "shiftCounts",
          shiftDocId(shift.id)
        );

        const snap = await getDoc(ref);

        if (snap.exists()) {
          const data = snap.data();

          return [
            shift.id,
            {
              capacity:
                typeof data.capacity === "number"
                  ? data.capacity
                  : shift.capacity,

              count:
                typeof data.count === "number"
                  ? data.count
                  : 0,
            },
          ];
        }

        return [
          shift.id,
          {
            capacity: shift.capacity,
            count: 0,
          },
        ];
      })
    )
  );

  const next = {};

  for (const result of results) {
    if (result.status === "fulfilled") {
      const [shiftId, availability] = result.value;
      next[shiftId] = availability;
    }
  }

  shiftAvailability = next;

  renderPositionShiftList();
}

// ============================================================================
// Validation
// ============================================================================

function setError(fieldId, message) {
  const errorElement = document.getElementById(
    `err-${fieldId}`
  );

  if (errorElement) {
    errorElement.textContent = message || "";
  }

  const input = document.getElementById(fieldId);

  if (input) {
    if (message) {
      input.setAttribute("aria-invalid", "true");
    } else {
      input.removeAttribute("aria-invalid");
    }
  }
}

function clearAllErrors() {
  document.querySelectorAll(".error").forEach((element) => {
    element.textContent = "";
  });

  document
    .querySelectorAll("[aria-invalid]")
    .forEach((element) => {
      element.removeAttribute("aria-invalid");
    });
}

/**
 * Validate the complete volunteer registration form.
 */
export function validateForm(
  formEl,
  currentSelectedPositionId,
  currentSelectedShiftId
) {
  const firstName =
    document.getElementById("firstName")?.value.trim() || "";

  const lastName =
    document.getElementById("lastName")?.value.trim() || "";

  const email =
    document.getElementById("studentEmail")?.value.trim() || "";

  const phoneInput =
    document.getElementById("phone");

  const phone =
    formatPhoneNumber(phoneInput?.value || "");

  const notes =
    document.getElementById("notes")?.value.trim() || "";

  const eligAge =
    document.getElementById("eligAge");

  let valid = true;
  let firstInvalidFieldId = null;

  const fail = (fieldId, message) => {
    setError(fieldId, message);

    if (!firstInvalidFieldId) {
      firstInvalidFieldId = fieldId;
    }

    valid = false;
  };

  if (!firstName || firstName.length < 2) {
    fail(
      "firstName",
      "Enter your first name."
    );
  }

  if (!lastName || lastName.length < 2) {
    fail(
      "lastName",
      "Enter your last name."
    );
  }

  if (!email || !isLikelyValidEmail(email)) {
    fail(
      "studentEmail",
      "Enter a valid email address."
    );
  }

  if (!phone || phone.replace(/\D/g, "").length !== 10) {
    fail(
      "phone",
      "Enter a valid 10-digit phone number."
    );
  } else if (phoneInput) {
    phoneInput.value = phone;
  }

  const ageInput = formEl?.querySelector('input[name="is18OrOlder"]:checked');
  if (!ageInput) {
    fail(
      "is18OrOlder",
      "Please indicate whether you are 18 years of age or older."
    );
  }
  const is18OrOlder = ageInput ? ageInput.value === "yes" : null;

  const position =
    currentSelectedPositionId
      ? getPositionById(currentSelectedPositionId)
      : null;

  const shift =
    currentSelectedPositionId &&
    currentSelectedShiftId
      ? getShiftById(
          currentSelectedPositionId,
          currentSelectedShiftId
        )
      : null;

  if (!position) {
    fail(
      "slot",
      "Choose a volunteer position."
    );
  }

  if (!shift) {
    fail(
      "slot",
      "Choose an available volunteer shift."
    );
  }

  if (!eligAge?.checked) {
    fail(
      "eligAge",
      "Please confirm that you can attend your selected shift."
    );
  }

  return {
    valid,
    firstInvalidFieldId,
    position,
    shift,
    payload: {
      firstName,
      lastName,
      email,
      phone,
      is18OrOlder,
      positionId: currentSelectedPositionId,
      shiftId: currentSelectedShiftId,
      notes,
    },
  };
}

// ============================================================================
// Firestore registration
// ============================================================================

/**
 * Atomically reserves capacity and creates the volunteer registration.
 *
 * Firestore structure:
 *
 * shiftCounts/{eventId_shiftId}
 * registrations/{registrationId}
 * registrationGuards/{email-based guard}
 *
 * The capacity check and registration creation happen in one transaction,
 * preventing two simultaneous registrations from exceeding capacity.
 */
export async function reserveShiftAndCreateRegistration(
  payload
) {
  const shiftRef = doc(
    db,
    "shiftCounts",
    shiftDocId(payload.shiftId)
  );

  const registrationRef = doc(
    collection(db, "registrations")
  );

  const emailGuardRef = doc(
    db,
    "registrationGuards",
    `email_${encodeURIComponent(
      payload.email.toLowerCase().trim()
    )}`
  );

  const normLast = normalizeLastName(payload.lastName);
  const normPhone = normalizePhoneNumber(payload.phone);
  const phoneNameGuardRef = normLast && normPhone
    ? doc(db, "registrationGuards", `name_phone_${normLast}_${normPhone}`)
    : null;

  const shiftResult = findShift(payload.shiftId);

  if (
    !shiftResult ||
    shiftResult.position.id !== payload.positionId
  ) {
    throw new Error("SHIFT_UNAVAILABLE");
  }

  const { position, shift } = shiftResult;

  await runTransaction(db, async (tx) => {
    const reads = [
      tx.get(shiftRef),
      tx.get(emailGuardRef),
    ];
    if (phoneNameGuardRef) {
      reads.push(tx.get(phoneNameGuardRef));
    }

    const results = await Promise.all(reads);
    const shiftSnap = results[0];
    const emailGuardSnap = results[1];
    const phoneNameGuardSnap = phoneNameGuardRef ? results[2] : null;

    if (emailGuardSnap.exists()) {
      throw new Error(
        "DUPLICATE_REGISTRATION"
      );
    }

    if (phoneNameGuardSnap && phoneNameGuardSnap.exists()) {
      throw new Error(
        "DUPLICATE_NAME_PHONE"
      );
    }

    if (!shiftSnap.exists()) {
      tx.set(shiftRef, {
        eventId: eventConfig.eventId,
        shiftId: shift.id,
        positionId: position.id,
        positionName: position.name,
        startTime: shift.startTime,
        endTime: shift.endTime,
        label: formatShiftTime(
          shift.startTime,
          shift.endTime
        ),
        capacity: shift.capacity,
        count: 1,
      });

      tx.set(
        registrationRef,
        buildRegistrationRecord(
          payload,
          position,
          shift
        )
      );

      tx.set(emailGuardRef, {
        registrationId: registrationRef.id,
        createdAt: serverTimestamp(),
      });

      if (phoneNameGuardRef) {
        tx.set(phoneNameGuardRef, {
          registrationId: registrationRef.id,
          lastName: normLast,
          phone: normPhone,
          createdAt: serverTimestamp(),
        });
      }

      return;
    }

    const shiftData = shiftSnap.data();

    if (
      typeof shiftData.capacity !== "number" ||
      typeof shiftData.count !== "number"
    ) {
      throw new Error(
        "SHIFT_UNAVAILABLE"
      );
    }

    if (
      shiftData.count >= shiftData.capacity
    ) {
      throw new Error("SHIFT_FULL");
    }

    tx.update(shiftRef, {
      count: shiftData.count + 1,
    });

    tx.set(
      registrationRef,
      buildRegistrationRecord(
        payload,
        position,
        shift
      )
    );

    tx.set(emailGuardRef, {
      registrationId: registrationRef.id,
      createdAt: serverTimestamp(),
    });

    if (phoneNameGuardRef) {
      tx.set(phoneNameGuardRef, {
        registrationId: registrationRef.id,
        lastName: normLast,
        phone: normPhone,
        createdAt: serverTimestamp(),
      });
    }
  });

  return registrationRef.id;
}

export function buildRegistrationRecord(
  payload,
  position,
  shift
) {
  return {
    schemaVersion:
      eventConfig.schemaVersion,

    eventId:
      eventConfig.eventId,

    eventName:
      eventConfig.eventName,

    eventDate:
      eventConfig.eventDate,

    location:
      eventConfig.location,

    firstName:
      payload.firstName,

    lastName:
      payload.lastName,

    email:
      payload.email,

    phone:
      payload.phone,

    normalizedLastName:
      normalizeLastName(payload.lastName),

    normalizedPhone:
      normalizePhoneNumber(payload.phone),

    is18OrOlder:
      typeof payload.is18OrOlder === "boolean"
        ? payload.is18OrOlder
        : null,

    notes:
      payload.notes || "",

    positionId:
      position.id,

    positionName:
      position.name,

    shiftId:
      shift.id,

    shiftStartTime:
      shift.startTime,

    shiftEndTime:
      shift.endTime,

    shiftLabel:
      formatShiftTime(
        shift.startTime,
        shift.endTime
      ),

    status:
      "registered",

    checkInTime:
      null,

    checkOutTime:
      null,

    createdAt:
      serverTimestamp(),
  };
}

// ============================================================================
// Submission
// ============================================================================

async function submitRegistration(event) {
  event.preventDefault();

  if (submissionInFlight) {
    return;
  }

  clearAllErrors();
  setError("submit", "");

  const {
    valid,
    firstInvalidFieldId,
    position,
    shift,
    payload,
  } = validateForm(
    form,
    selectedPositionId,
    selectedShiftId
  );

  if (!valid) {
    scrollToField(firstInvalidFieldId);

    announce(
      "Please fix the highlighted fields before submitting."
    );

    return;
  }

  submissionInFlight = true;

  submitBtn.disabled = true;
  submitBtn.textContent = "Registering…";

  try {
    logRegistrationStep(
      "Submitting volunteer registration transaction"
    );

    const confirmationId =
      await reserveShiftAndCreateRegistration(
        payload
      );

    logRegistrationStep(
      "Volunteer registration transaction completed"
    );

    logSafeEvent(
      "diwali_volunteer_registration_success"
    );

    showConfirmation({
      firstName: payload.firstName,
      lastName: payload.lastName,
      is18OrOlder: payload.is18OrOlder,
      position,
      shift,
      confirmationId,
    });
  } catch (error) {
    logSafeEvent(
      "diwali_volunteer_registration_error"
    );

    handleSubmissionError(error);
  } finally {
    submissionInFlight = false;

    submitBtn.disabled = false;

    submitBtn.textContent =
      `Register for ${eventConfig.eventName}`;
  }
}

// ============================================================================
// Submission errors
// ============================================================================

function handleSubmissionError(error) {
  const code =
    error &&
    (error.code || error.message);

  logRegistrationStep(
    "Volunteer registration failed",
    {
      code:
        code || "unknown",
    }
  );

  if (code === "permission-denied") {
    setError(
      "submit",
      "Registration could not be saved because Firebase permissions blocked the request. Please ask the organizers to check the latest Firestore rules."
    );

    announce(
      "Registration could not be saved because Firebase permissions blocked the request."
    );

    return;
  }

  if (
    code ===
    "DUPLICATE_REGISTRATION"
  ) {
    setError(
      "submit",
      "It looks like this email has already been used to register for the festival."
    );

    announce(
      "It looks like this email has already been used to register for the festival."
    );

    return;
  }

  if (code === "DUPLICATE_NAME_PHONE") {
    setError(
      "submit",
      "A volunteer registration with this last name and phone number already exists."
    );

    announce(
      "A volunteer registration with this last name and phone number already exists."
    );

    return;
  }

  if (
    code === "SHIFT_FULL" ||
    code === "SHIFT_UNAVAILABLE"
  ) {
    setError(
      "slot",
      "That shift just filled up. Please choose another available shift."
    );

    loadShiftAvailability();

    announce(
      "That shift just filled up. Please choose another available shift."
    );

    return;
  }

  setError(
    "submit",
    "We could not complete your registration. Please try again or contact the festival organizers."
  );

  announce(
    "We could not complete your registration. Please try again."
  );
}

// ============================================================================
// Safe diagnostics
// ============================================================================

function logRegistrationStep(
  message,
  details = {}
) {
  // Never include names, emails, phone numbers, DOBs, addresses, or
  // other volunteer PII in diagnostics.
  console.info(
    "[diwali-volunteer-registration]",
    message,
    details
  );
}

function announce(message) {
  if (statusLive) {
    statusLive.textContent = message;
  }
}

// ============================================================================
// Confirmation view
// ============================================================================

function showConfirmation({
  firstName,
  lastName,
  is18OrOlder,
  position,
  shift,
  confirmationId,
}) {
  document.body.classList.add(
    "confirmation-mode"
  );

  form.classList.add("hidden");
  confirmationView.classList.remove("hidden");

  setText(
    "sum-student",
    `${firstName} ${lastName}`
  );

  setText(
    "sum-age",
    is18OrOlder === true
      ? "Yes (18 or older)"
      : is18OrOlder === false
      ? "No (Under 18)"
      : "Not specified"
  );

  setText(
    "sum-date",
    formatDisplayDate(
      eventConfig.eventDate,
      { weekday: true }
    )
  );

  setText(
    "sum-location",
    eventConfig.location
  );

  setText(
    "sum-position",
    position.name
  );

  setText(
    "sum-slot",
    formatShiftTime(
      shift.startTime,
      shift.endTime
    )
  );

  setText(
    "sum-confid",
    confirmationId
  );

  const eventNameElement =
    document.getElementById(
      "sum-event"
    );

  if (eventNameElement) {
    eventNameElement.textContent =
      eventConfig.eventName;
  }

  confirmationView.setAttribute(
    "tabindex",
    "-1"
  );

  confirmationView.focus();
}

function setText(id, value) {
  const element =
    document.getElementById(id);

  if (element) {
    element.textContent =
      value ?? "";
  }
}

// ============================================================================
// Reset
// ============================================================================

function resetForm() {
  form.reset();

  selectedPositionId = null;
  selectedShiftId = null;

  clearAllErrors();

  document.body.classList.remove(
    "confirmation-mode"
  );

  confirmationView.classList.add(
    "hidden"
  );

  form.classList.remove(
    "hidden"
  );

  renderPositionShiftList();

  loadShiftAvailability();

  window.scrollTo({
    top: 0,
    behavior: "smooth",
  });
}

// ============================================================================
// Wiring
// ============================================================================

async function init() {
  await loadEventSettings();

  renderConfigurableCopy();
  renderHeader();
  renderPositionShiftList();

  const phoneInput =
    document.getElementById("phone");

  if (phoneInput) {
    phoneInput.addEventListener(
      "input",
      normalizePhoneInput
    );
  }

  if (form) {
    form.addEventListener(
      "submit",
      submitRegistration
    );
  }

  const printButton =
    document.getElementById(
      "print-btn"
    );

  if (printButton) {
    printButton.addEventListener(
      "click",
      () => window.print()
    );
  }

  const resetButton =
    document.getElementById(
      "reset-btn"
    );

  if (resetButton) {
    resetButton.addEventListener(
      "click",
      resetForm
    );
  }

  logSafeEvent(
    "diwali_volunteer_form_started"
  );

  // Best-effort availability warm-up.
  // Failure here does not prevent registration.
  loadShiftAvailability().catch(
    (error) => {
      logRegistrationStep(
        "Shift availability warm-up failed",
        {
          code:
            error?.code ||
            error?.message ||
            "unknown",
        }
      );
    }
  );
}

// Only run the registration page initializer when the registration form
// is present. admin.js imports reserveShiftAndCreateRegistration from this
// module, so this guard prevents the admin pages from accidentally wiring
// up registration-form event listeners against DOM elements that don't exist.
if (document.getElementById("registration-form")) {
  document.addEventListener(
    "DOMContentLoaded",
    init
  );
}
