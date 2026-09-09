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
  formatShiftTime,
  getPositionById,
  getShiftById,
  findShift,
  normalizeFirstName,
  normalizeLastName,
  normalizePhoneNumber,
  getRegistrationLookupId,
  sha256Hex,
} from "./config.js";

import {
  db,
  logSafeEvent,
} from "./firebase-init.js";

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

const form =
  document.getElementById(
    "registration-form"
  );

const confirmationView =
  document.getElementById(
    "confirmation-view"
  );

const statusLive =
  document.getElementById(
    "status-live"
  );

const positionShiftList =
  document.getElementById(
    "slot-grid"
  );

const submitBtn =
  document.getElementById(
    "submit-btn"
  );

const errSubmit =
  document.getElementById(
    "err-submit"
  );

// ----------------------------------------------------------------------------
// Module state
// ----------------------------------------------------------------------------

let selectedPositionId = null;
let selectedShiftId = null;

let shiftAvailability = {};
let submissionInFlight = false;

let eventConfig = {
  ...CONFIG,
};

// ============================================================================
// Pure helper functions
// ============================================================================

function parseIsoDate(value) {
  if (typeof value !== "string") {
    return null;
  }

  const match =
    /^(\d{4})-(\d{2})-(\d{2})$/.exec(
      value.trim()
    );

  if (!match) {
    return null;
  }

  const year =
    Number(match[1]);

  const month =
    Number(match[2]);

  const day =
    Number(match[3]);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  return {
    year,
    month,
    day,
  };
}

function formatDisplayDate(
  isoDate,
  { weekday = false } = {}
) {
  const parts =
    parseIsoDate(
      isoDate
    );

  if (!parts) {
    return isoDate;
  }

  const date =
    new Date(
      parts.year,
      parts.month - 1,
      parts.day
    );

  return date.toLocaleDateString(
    "en-US",
    {
      ...(weekday
        ? {
            weekday:
              "long",
          }
        : {}),
      year: "numeric",
      month: "long",
      day: "numeric",
    }
  );
}

function isLikelyValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    String(value || "").trim()
  );
}

function formatPhoneNumber(value) {
  const digits =
    String(value || "")
      .replace(/\D/g, "")
      .slice(0, 10);

  if (digits.length <= 3) {
    return digits;
  }

  if (digits.length <= 6) {
    return `(${digits.slice(
      0,
      3
    )}) ${digits.slice(
      3
    )}`;
  }

  return `(${digits.slice(
    0,
    3
  )}) ${digits.slice(
    3,
    6
  )}-${digits.slice(
    6
  )}`;
}

function normalizePhoneInput(event) {
  event.target.value =
    formatPhoneNumber(
      event.target.value
    );
}

function timeToMinutes(hhmm) {
  const text =
    String(hhmm || "");

  const hour =
    Number(
      text.slice(0, 2)
    );

  const minute =
    Number(
      text.slice(2)
    );

  return (
    hour * 60 +
    minute
  );
}

function hasTimeOverlap(
  startA,
  endA,
  startB,
  endB
) {
  const aStart =
    timeToMinutes(
      startA
    );

  const aEnd =
    timeToMinutes(
      endA
    );

  const bStart =
    timeToMinutes(
      startB
    );

  const bEnd =
    timeToMinutes(
      endB
    );

  return (
    aStart < bEnd &&
    bStart < aEnd
  );
}

function formatShiftDuration(
  startTime,
  endTime
) {
  const start =
    timeToMinutes(
      startTime
    );

  const end =
    timeToMinutes(
      endTime
    );

  const minutes =
    end - start;

  if (minutes <= 0) {
    return "";
  }

  const hours =
    Math.floor(
      minutes / 60
    );

  const remainingMinutes =
    minutes % 60;

  if (
    hours > 0 &&
    remainingMinutes > 0
  ) {
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
    const snap =
      await getDoc(
        doc(
          db,
          "eventSettings",
          CONFIG.eventId
        )
      );

    if (!snap.exists()) {
      return;
    }

    const data =
      snap.data();

    eventConfig = {
      ...CONFIG,

      eventName:
        data.eventName ||
        CONFIG.eventName,

      eventDate:
        data.eventDate ||
        CONFIG.eventDate,

      location:
        data.location ||
        CONFIG.location,

      timeZone:
        data.timeZone ||
        CONFIG.timeZone,

      timeZoneLabel:
        data.timeZoneLabel ||
        CONFIG.timeZoneLabel,
    };
  } catch (error) {
    logRegistrationStep(
      "Event settings load failed; using bundled defaults",
      {
        code:
          error?.code ||
          error?.message ||
          "unknown",
      }
    );
  }
}

function eventRegistrationTitle() {
  return `${eventConfig.eventName} Volunteer Registration`;
}

function renderConfigurableCopy() {
  document.title =
    eventRegistrationTitle();

  const metaDescription =
    document.querySelector(
      'meta[name="description"]'
    );

  if (metaDescription) {
    metaDescription.setAttribute(
      "content",
      `Register to volunteer at ${eventConfig.eventName}.`
    );
  }

  const title =
    document.querySelector(
      ".title"
    );

  if (title) {
    title.textContent =
      eventRegistrationTitle();
  }

  const submitLabel =
    `Register for ${eventConfig.eventName}`;

  if (submitBtn) {
    submitBtn.textContent =
      submitLabel;
  }

  const dateElements =
    document.querySelectorAll(
      "[data-event-date]"
    );

  dateElements.forEach(
    (element) => {
      element.textContent =
        formatDisplayDate(
          eventConfig.eventDate,
          {
            weekday: true,
          }
        );
    }
  );

  const locationElements =
    document.querySelectorAll(
      "[data-event-location]"
    );

  locationElements.forEach(
    (element) => {
      element.textContent =
        eventConfig.location;
    }
  );
}

// ============================================================================
// Header
// ============================================================================

function renderHeader() {
  const factDate =
    document.getElementById(
      "fact-date"
    );

  const factTime =
    document.getElementById(
      "fact-time"
    );

  const factLocation =
    document.getElementById(
      "fact-location"
    );

  if (factDate) {
    factDate.textContent =
      formatDisplayDate(
        eventConfig.eventDate,
        {
          weekday: true,
        }
      );
  }

  if (factTime) {
    factTime.textContent =
      "Volunteer shifts throughout the day";
  }

  if (factLocation) {
    factLocation.textContent =
      eventConfig.location;
  }
}

// ============================================================================
// Position / shift rendering
// ============================================================================

function renderPositionShiftList() {
  if (!positionShiftList) {
    return;
  }

  positionShiftList.textContent =
    "";

  for (
    const position of
      VOLUNTEER_POSITIONS
  ) {
    const positionCard =
      document.createElement(
        "section"
      );

    positionCard.className =
      "position-card";

    positionCard.dataset.positionId =
      position.id;

    const positionHeader =
      document.createElement(
        "div"
      );

    positionHeader.className =
      "position-header";

    const headerText =
      document.createElement(
        "div"
      );

    headerText.className =
      "position-header-text";

    const title =
      document.createElement(
        "h3"
      );

    title.className =
      "position-title";

    title.textContent =
      position.name;

    const description =
      document.createElement(
        "p"
      );

    description.className =
      "position-description";

    description.textContent =
      position.description ||
      "";

    headerText.appendChild(
      title
    );

    headerText.appendChild(
      description
    );

    positionHeader.appendChild(
      headerText
    );

    const shiftList =
      document.createElement(
        "div"
      );

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

    for (
      const shift of
        position.shifts
    ) {
      const availability =
        shiftAvailability[
          shift.id
        ] || {
          capacity:
            shift.capacity,
          count: 0,
        };

      const capacity =
        Number(
          availability.capacity
        );

      const count =
        Number(
          availability.count
        );

      const remaining =
        Math.max(
          0,
          capacity - count
        );

      const isFull =
        remaining <= 0;

      const isSelected =
        selectedPositionId ===
          position.id &&
        selectedShiftId ===
          shift.id;

      const button =
        document.createElement(
          "button"
        );

      button.type =
        "button";

      button.className =
        "shift-btn" +
        (
          isSelected
            ? " selected"
            : ""
        ) +
        (
          isFull
            ? " full"
            : ""
        );

      button.disabled =
        isFull;

      button.setAttribute(
        "aria-pressed",
        String(
          isSelected
        )
      );

      button.dataset.positionId =
        position.id;

      button.dataset.shiftId =
        shift.id;

      const timeElement =
        document.createElement(
          "span"
        );

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
        document.createElement(
          "span"
        );

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
            remaining === 1
              ? ""
              : "s"
          } left`;
      }

      button.appendChild(
        timeElement
      );

      button.appendChild(
        capacityElement
      );

      if (duration) {
        const durationElement =
          document.createElement(
            "span"
          );

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

            setError(
              "slot",
              ""
            );

            announce(
              `${position.name}, ${formatShiftTime(
                shift.startTime,
                shift.endTime
              )} selected.`
            );
          }
        );
      }

      shiftList.appendChild(
        button
      );
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
 * Best-effort availability read for display only.
 *
 * The authoritative capacity check happens inside the Firestore transaction.
 */
async function loadShiftAvailability() {
  const results =
    await Promise.allSettled(
      VOLUNTEER_POSITIONS.flatMap(
        (position) =>
          position.shifts.map(
            async (shift) => {
              const ref =
                doc(
                  db,
                  "shiftCounts",
                  shiftDocId(
                    shift.id
                  )
                );

              const snap =
                await getDoc(
                  ref
                );

              if (snap.exists()) {
                const data =
                  snap.data();

                return [
                  shift.id,
                  {
                    capacity:
                      typeof data.capacity ===
                      "number"
                        ? data.capacity
                        : shift.capacity,

                    count:
                      typeof data.count ===
                      "number"
                        ? data.count
                        : 0,
                  },
                ];
              }

              return [
                shift.id,
                {
                  capacity:
                    shift.capacity,

                  count: 0,
                },
              ];
            }
          )
      )
    );

  const next = {};

  for (
    const result of results
  ) {
    if (
      result.status ===
      "fulfilled"
    ) {
      const [
        shiftId,
        availability,
      ] = result.value;

      next[shiftId] =
        availability;
    }
  }

  shiftAvailability =
    next;

  renderPositionShiftList();
}

// ============================================================================
// Validation
// ============================================================================

function setError(
  fieldId,
  message
) {
  const errorElement =
    document.getElementById(
      `err-${fieldId}`
    );

  if (errorElement) {
    errorElement.textContent =
      message || "";
  }

  const input =
    document.getElementById(
      fieldId
    );

  if (input) {
    if (message) {
      input.setAttribute(
        "aria-invalid",
        "true"
      );
    } else {
      input.removeAttribute(
        "aria-invalid"
      );
    }
  }
}

function clearAllErrors() {
  document
    .querySelectorAll(
      ".error"
    )
    .forEach(
      (element) => {
        element.textContent =
          "";
      }
    );

  document
    .querySelectorAll(
      "[aria-invalid]"
    )
    .forEach(
      (element) => {
        element.removeAttribute(
          "aria-invalid"
        );
      }
    );
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
    document.getElementById(
      "firstName"
    )?.value.trim() ||
    "";

  const lastName =
    document.getElementById(
      "lastName"
    )?.value.trim() ||
    "";

  const email =
    document.getElementById(
      "studentEmail"
    )?.value.trim() ||
    "";

  const phoneInput =
    document.getElementById(
      "phone"
    );

  const phone =
    formatPhoneNumber(
      phoneInput?.value ||
        ""
    );

  const notes =
    document.getElementById(
      "notes"
    )?.value.trim() ||
    "";

  const eligAge =
    document.getElementById(
      "eligAge"
    );

  let valid = true;

  let firstInvalidFieldId =
    null;

  const fail = (
    fieldId,
    message
  ) => {
    setError(
      fieldId,
      message
    );

    if (
      !firstInvalidFieldId
    ) {
      firstInvalidFieldId =
        fieldId;
    }

    valid = false;
  };

  if (
    !firstName ||
    firstName.length < 2
  ) {
    fail(
      "firstName",
      "Enter your first name."
    );
  }

  if (
    !lastName ||
    lastName.length < 2
  ) {
    fail(
      "lastName",
      "Enter your last name."
    );
  }

  if (
    !email ||
    !isLikelyValidEmail(
      email
    )
  ) {
    fail(
      "studentEmail",
      "Enter a valid email address."
    );
  }

  if (
    !phone ||
    phone.replace(
      /\D/g,
      ""
    ).length !== 10
  ) {
    fail(
      "phone",
      "Enter a valid 10-digit phone number."
    );
  } else if (
    phoneInput
  ) {
    phoneInput.value =
      phone;
  }

  const ageInput =
    formEl?.querySelector(
      'input[name="is18OrOlder"]:checked'
    );

  if (!ageInput) {
    fail(
      "is18OrOlder",
      "Please indicate whether you are 18 years of age or older."
    );
  }

  const is18OrOlder =
    ageInput
      ? ageInput.value ===
        "yes"
      : null;

  const position =
    currentSelectedPositionId
      ? getPositionById(
          currentSelectedPositionId
        )
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
      positionId:
        currentSelectedPositionId,
      shiftId:
        currentSelectedShiftId,
      notes,
    },
  };
}

// ============================================================================
// Volunteer identity matching
// ============================================================================

/**
 * Determines whether an existing registration belongs to the same volunteer.
 *
 * Primary identity:
 *   First name + last name + phone
 *
 * Additional identity signal:
 *   First name + last name + email
 *
 * Email alone is intentionally NOT sufficient, because multiple volunteers
 * may legitimately use the same email address.
 */
function isSameVolunteer(
  entry,
  {
    normFirst,
    normLast,
    normPhone,
    emailHash,
  }
) {
  if (!entry) {
    return false;
  }

  const sameName =
    entry.normalizedFirstName ===
      normFirst &&
    entry.normalizedLastName ===
      normLast;

  if (!sameName) {
    return false;
  }

  const samePhone =
    entry.normalizedPhone ===
    normPhone;

  const sameEmail =
    typeof emailHash ===
      "string" &&
    entry.emailHash ===
      emailHash;

  return (
    samePhone ||
    sameEmail
  );
}

// ============================================================================
// Firestore registration
// ============================================================================

/**
 * Atomically reserves capacity and creates a volunteer registration.
 *
 * Rules:
 *
 *   Same volunteer + same shift
 *       → BLOCK
 *
 *   Same volunteer + overlapping shift
 *       → BLOCK
 *
 *   Same volunteer + non-overlapping shift
 *       → ALLOW
 *
 *   Different first name + same email/phone
 *       → ALLOW
 *
 * Email is never used by itself as a volunteer identity.
 */
export async function reserveShiftAndCreateRegistration(
  payload
) {
  const shiftRef =
    doc(
      db,
      "shiftCounts",
      shiftDocId(
        payload.shiftId
      )
    );

  const registrationRef =
    doc(
      collection(
        db,
        "registrations"
      )
    );

  const normFirst =
    normalizeFirstName(
      payload.firstName
    );

  const normLast =
    normalizeLastName(
      payload.lastName
    );

  const normPhone =
    normalizePhoneNumber(
      payload.phone
    );

  const normEmail =
    String(
      payload.email || ""
    )
      .trim()
      .toLowerCase();

  const emailGuardKey =
    encodeURIComponent(
      normEmail
    );

  const emailHash =
    await sha256Hex(
      normEmail
    );

  const lookupId =
    await getRegistrationLookupId(
      payload.lastName,
      payload.phone,
      eventConfig.eventId
    );

  const lookupRef =
    doc(
      db,
      "registrationLookups",
      lookupId
    );

  // Exact person + shift guard.
  const personShiftGuardRef =
    doc(
      db,
      "registrationGuards",
      `person_shift_${normFirst}_${normLast}_${normPhone}_${payload.shiftId}`
    );

  // Same first/last/email + shift guard.
  // This supplements the phone-based identity without making email alone
  // a restriction.
  const emailPersonShiftGuardRef =
    doc(
      db,
      "registrationGuards",
      `email_person_shift_${emailHash}_${normFirst}_${normLast}_${payload.shiftId}`
    );

  const shiftResult =
    findShift(
      payload.shiftId
    );

  if (
    !shiftResult ||
    shiftResult.position.id !==
      payload.positionId
  ) {
    throw new Error(
      "SHIFT_UNAVAILABLE"
    );
  }

  const {
    position,
    shift,
  } = shiftResult;

  await runTransaction(
    db,
    async (tx) => {
      const [
        shiftSnap,
        lookupSnap,
        personShiftGuardSnap,
        emailPersonShiftGuardSnap,
      ] = await Promise.all([
        tx.get(
          shiftRef
        ),
        tx.get(
          lookupRef
        ),
        tx.get(
          personShiftGuardRef
        ),
        tx.get(
          emailPersonShiftGuardRef
        ),
      ]);

      // ----------------------------------------------------------------------
      // Exact duplicate guards.
      // ----------------------------------------------------------------------

      if (
        personShiftGuardSnap.exists() &&
        personShiftGuardSnap.data()?.status !==
          "cancelled"
      ) {
        throw new Error(
          "DUPLICATE_SHIFT"
        );
      }

      if (
        emailPersonShiftGuardSnap.exists() &&
        emailPersonShiftGuardSnap.data()?.status !==
          "cancelled"
      ) {
        throw new Error(
          "DUPLICATE_SHIFT"
        );
      }

      // ----------------------------------------------------------------------
      // Determine existing registrations for this volunteer.
      // ----------------------------------------------------------------------

      const lookupData =
        lookupSnap.exists()
          ? lookupSnap.data()
          : {};

      const lookupEntries =
        Array.isArray(
          lookupData.entries
        )
          ? lookupData.entries
          : [];

      const sameVolunteerEntries =
        lookupEntries
          .filter(
            (entry) =>
              entry &&
              entry.status ===
                "registered"
          )
          .filter(
            (entry) =>
              isSameVolunteer(
                entry,
                {
                  normFirst,
                  normLast,
                  normPhone,
                  emailHash,
                }
              )
          );

      // ----------------------------------------------------------------------
      // Same volunteer + same shift.
      // ----------------------------------------------------------------------

      const alreadyRegistered =
        sameVolunteerEntries.some(
          (entry) =>
            entry.shiftId ===
            payload.shiftId
        );

      if (
        alreadyRegistered
      ) {
        throw new Error(
          "DUPLICATE_SHIFT"
        );
      }

      // ----------------------------------------------------------------------
      // Same volunteer + overlapping shift.
      // ----------------------------------------------------------------------

      const overlapping =
        sameVolunteerEntries.some(
          (entry) =>
            hasTimeOverlap(
              entry.shiftStartTime,
              entry.shiftEndTime,
              shift.startTime,
              shift.endTime
            )
        );

      if (overlapping) {
        throw new Error(
          "SHIFT_OVERLAP"
        );
      }

      // ----------------------------------------------------------------------
      // Capacity.
      // ----------------------------------------------------------------------

      if (
        shift.capacity <= 0
      ) {
        throw new Error(
          "SHIFT_FULL"
        );
      }

      if (
        !shiftSnap.exists()
      ) {
        tx.set(
          shiftRef,
          {
            eventId:
              eventConfig.eventId,

            shiftId:
              shift.id,

            positionId:
              position.id,

            positionName:
              position.name,

            startTime:
              shift.startTime,

            endTime:
              shift.endTime,

            label:
              formatShiftTime(
                shift.startTime,
                shift.endTime
              ),

            capacity:
              shift.capacity,

            count:
              1,
          }
        );
      } else {
        const shiftData =
          shiftSnap.data();

        if (
          typeof shiftData.capacity !==
            "number" ||
          typeof shiftData.count !==
            "number"
        ) {
          throw new Error(
            "SHIFT_UNAVAILABLE"
          );
        }

        if (
          shiftData.count >=
          shiftData.capacity
        ) {
          throw new Error(
            "SHIFT_FULL"
          );
        }

        tx.update(
          shiftRef,
          {
            count:
              shiftData.count + 1,
          }
        );
      }

      // ----------------------------------------------------------------------
      // Create private registration.
      // ----------------------------------------------------------------------

      tx.set(
        registrationRef,
        buildRegistrationRecord(
          {
            ...payload,

            emailGuardKey,

            manageLookupId:
              lookupId,
          },
          position,
          shift
        )
      );

      // ----------------------------------------------------------------------
      // Create phone-based person/shift guard.
      // ----------------------------------------------------------------------

      tx.set(
        personShiftGuardRef,
        {
          registrationId:
            registrationRef.id,

          type:
            "person_shift",

          status:
            "active",

          firstName:
            normFirst,

          lastName:
            normLast,

          phone:
            normPhone,

          shiftId:
            payload.shiftId,

          createdAt:
            serverTimestamp(),
        }
      );

      // ----------------------------------------------------------------------
      // Create email + name + shift supplemental guard.
      // ----------------------------------------------------------------------

      tx.set(
        emailPersonShiftGuardRef,
        {
          registrationId:
            registrationRef.id,

          type:
            "email_person_shift",

          status:
            "active",

          emailHash,

          firstName:
            normFirst,

          lastName:
            normLast,

          shiftId:
            payload.shiftId,

          createdAt:
            serverTimestamp(),
        }
      );

      // ----------------------------------------------------------------------
      // Update public Manage Registrations lookup.
      // ----------------------------------------------------------------------

      let updatedLookupEntries =
        lookupEntries.filter(
          (entry) =>
            entry &&
            entry.registrationId !==
              registrationRef.id
        );

      updatedLookupEntries.push(
        {
          registrationId:
            registrationRef.id,

          firstName:
            payload.firstName,

          normalizedFirstName:
            normFirst,

          lastName:
            payload.lastName,

          normalizedLastName:
            normLast,

          phone:
            payload.phone,

          normalizedPhone:
            normPhone,

          // Stored so Manage can reuse the email automatically.
          email:
            normEmail,

          emailHash,

          emailGuardKey,

          is18OrOlder:
            payload.is18OrOlder,

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

          cancelledAt:
            null,
        }
      );

      const existingRegistrationIds =
        Array.isArray(
          lookupData.registrationIds
        )
          ? [
              ...lookupData.registrationIds,
            ]
          : [];

      if (
        !existingRegistrationIds.includes(
          registrationRef.id
        )
      ) {
        existingRegistrationIds.push(
          registrationRef.id
        );
      }

      tx.set(
        lookupRef,
        {
          eventId:
            eventConfig.eventId,

          normalizedLastName:
            normLast,

          entries:
            updatedLookupEntries,

          registrationIds:
            existingRegistrationIds,

          updatedAt:
            serverTimestamp(),
        },
        {
          merge: true,
        }
      );
    }
  );

  return registrationRef.id;
}

// ============================================================================
// Registration record builder
// ============================================================================

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

    normalizedFirstName:
      normalizeFirstName(
        payload.firstName
      ),

    normalizedLastName:
      normalizeLastName(
        payload.lastName
      ),

    normalizedPhone:
      normalizePhoneNumber(
        payload.phone
      ),

    emailGuardKey:
      payload.emailGuardKey,

    manageLookupId:
      payload.manageLookupId,

    is18OrOlder:
      typeof payload.is18OrOlder ===
      "boolean"
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

  if (
    submissionInFlight
  ) {
    return;
  }

  clearAllErrors();

  setError(
    "submit",
    ""
  );

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
    scrollToField(
      firstInvalidFieldId
    );

    announce(
      "Please fix the highlighted fields before submitting."
    );

    return;
  }

  submissionInFlight =
    true;

  submitBtn.disabled =
    true;

  submitBtn.textContent =
    "Registering…";

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
      firstName:
        payload.firstName,

      lastName:
        payload.lastName,

      is18OrOlder:
        payload.is18OrOlder,

      position,

      shift,

      confirmationId,
    });
  } catch (error) {
    logSafeEvent(
      "diwali_volunteer_registration_error"
    );

    handleSubmissionError(
      error
    );
  } finally {
    submissionInFlight =
      false;

    submitBtn.disabled =
      false;

    submitBtn.textContent =
      `Register for ${eventConfig.eventName}`;
  }
}

// ============================================================================
// Submission errors
// ============================================================================

function handleSubmissionError(
  error
) {
  const code =
    error &&
    (
      error.code ||
      error.message
    );

  logRegistrationStep(
    "Volunteer registration failed",
    {
      code:
        code ||
        "unknown",
    }
  );

  if (
    code ===
    "permission-denied"
  ) {
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
    "DUPLICATE_SHIFT"
  ) {
    setError(
      "submit",
      "Looks like you're already registered for this shift. Please choose a different shift."
    );

    announce(
      "Looks like you're already registered for this shift. Please choose a different shift."
    );

    return;
  }

  if (
    code ===
    "SHIFT_OVERLAP"
  ) {
    setError(
      "submit",
      "That shift overlaps one of your existing shifts. Please choose a different shift."
    );

    announce(
      "That shift overlaps one of your existing shifts. Please choose a different shift."
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

function announce(
  message
) {
  if (statusLive) {
    statusLive.textContent =
      message;
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

  form.classList.add(
    "hidden"
  );

  confirmationView.classList.remove(
    "hidden"
  );

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
      {
        weekday: true,
      }
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

function setText(
  id,
  value
) {
  const element =
    document.getElementById(
      id
    );

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

  selectedPositionId =
    null;

  selectedShiftId =
    null;

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
    document.getElementById(
      "phone"
    );

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

// Only initialize the public registration page when its form exists.
// admin.js imports reserveShiftAndCreateRegistration(), so this prevents the
// registration page event listeners from being attached on admin pages.
if (
  document.getElementById(
    "registration-form"
  )
) {
  document.addEventListener(
    "DOMContentLoaded",
    init
  );
}