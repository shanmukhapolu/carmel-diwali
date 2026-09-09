// ============================================================================
// manage.js
//
// Public Manage Registrations page.
//
// Identity:
//   Last name + phone
//        ↓
//   First name when multiple volunteers match
//        ↓
//   View this volunteer's registrations
//        ↓
//   Cancel individual shift
//        ↓
//   Add another non-overlapping shift
//
// Important:
//   - Email is NOT used to identify the volunteer.
//   - Email is automatically reused from the existing registration.
//   - A volunteer may register for multiple non-overlapping shifts.
//   - A volunteer cannot register for the same shift twice.
//   - Cancelling a shift permanently removes that registration.
//   - No Firebase Cloud Functions are used.
// ============================================================================

import {
  CONFIG,
  VOLUNTEER_POSITIONS,
  formatShiftTime,
  getRegistrationLookupId,
  normalizeFirstName,
  normalizeLastName,
  normalizePhoneNumber,
  timeToMinutes,
} from "../config.js";

import { db } from "../firebase-init.js";

import {
  collection,
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

// ============================================================================
// DOM
// ============================================================================

const lookupForm =
  document.getElementById("lookup-form");

const lastNameInput =
  document.getElementById("lookup-last-name");

const phoneInput =
  document.getElementById("lookup-phone");

const firstNameInput =
  document.getElementById("lookup-first-name");

const identityStep =
  document.getElementById("identity-step");

const lookupError =
  document.getElementById("lookup-error");

const lookupButton =
  document.getElementById("lookup-button");

const resultsSection =
  document.getElementById("results-section");

const resultsName =
  document.getElementById("results-name");

const resultsContact =
  document.getElementById("results-contact");

const registrationList =
  document.getElementById("registration-list");

const newSearchButton =
  document.getElementById("new-search");

const addShiftGrid =
  document.getElementById("add-shift-grid");

const addNotesInput =
  document.getElementById("add-notes");

const addShiftError =
  document.getElementById("add-shift-error");

const addShiftButton =
  document.getElementById("add-shift-button");

// ============================================================================
// STATE
// ============================================================================

let lookupId = null;

let lookupEntries = [];

let selectedIdentityEntries = [];

let selectedShift = null;

let lookupStage = "initial";

let lookupSubmitting = false;

const availabilityCache = {};

// ============================================================================
// GENERAL HELPERS
// ============================================================================

function formatPhoneNumber(value) {
  const digits =
    String(value || "")
      .replace(/\D/g, "")
      .slice(0, 10);

  if (digits.length <= 3) {
    return digits;
  }

  if (digits.length <= 6) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  }

  return `(${digits.slice(0, 3)}) ${digits.slice(
    3,
    6
  )}-${digits.slice(6)}`;
}

function setError(elementId, message) {
  const element =
    document.getElementById(elementId);

  if (element) {
    element.textContent =
      message || "";
  }
}

function clearErrors() {
  document
    .querySelectorAll(".error")
    .forEach((element) => {
      element.textContent = "";
    });
}

function isActive(entry) {
  return (
    entry &&
    typeof entry.registrationId === "string" &&
    entry.status === "registered"
  );
}

function getActiveEntries(entries) {
  return Array.isArray(entries)
    ? entries.filter(isActive)
    : [];
}

function getDistinctFirstNames(entries) {
  return [
    ...new Set(
      getActiveEntries(entries)
        .map(
          (entry) =>
            entry.normalizedFirstName
        )
        .filter(Boolean)
    ),
  ];
}

function hasTimeOverlap(
  startA,
  endA,
  startB,
  endB
) {
  const aStart =
    timeToMinutes(startA);

  const aEnd =
    timeToMinutes(endA);

  const bStart =
    timeToMinutes(startB);

  const bEnd =
    timeToMinutes(endB);

  return (
    aStart < bEnd &&
    bStart < aEnd
  );
}

/**
 * Existing lookup entries store the normalized email indirectly in
 * emailGuardKey. Decode it so Manage can reuse the volunteer's original
 * email without asking for it again.
 */
function getStoredEmail(entry) {
  if (
    entry &&
    typeof entry.email === "string" &&
    entry.email.trim()
  ) {
    return entry.email.trim().toLowerCase();
  }

  if (
    entry &&
    typeof entry.emailGuardKey === "string"
  ) {
    try {
      return decodeURIComponent(
        entry.emailGuardKey
      )
        .trim()
        .toLowerCase();
    } catch {
      return "";
    }
  }

  return "";
}

function getStoredPhone(entry) {
  if (
    entry &&
    typeof entry.phone === "string"
  ) {
    return entry.phone;
  }

  return formatPhoneNumber(
    phoneInput.value
  );
}

// ============================================================================
// LOOKUP
// ============================================================================

async function fetchLookup() {
  const normalizedLast =
    normalizeLastName(
      lastNameInput.value
    );

  if (!normalizedLast) {
    return [];
  }

  lookupId =
    await getRegistrationLookupId(
      lastNameInput.value,
      phoneInput.value,
      CONFIG.eventId
    );

  const lookupRef =
    doc(
      db,
      "registrationLookups",
      lookupId
    );

  const snap =
    await getDoc(
      lookupRef
    );

  if (!snap.exists()) {
    return [];
  }

  const data =
    snap.data();

  if (
    data.eventId !==
      CONFIG.eventId ||
    data.normalizedLastName !==
      normalizedLast
  ) {
    return [];
  }

  if (
    !Array.isArray(
      data.entries
    )
  ) {
    return [];
  }

  return data.entries;
}

// ============================================================================
// LOOKUP FORM
// ============================================================================

async function submitLookup(event) {
  event.preventDefault();

  if (lookupSubmitting) {
    return;
  }

  clearErrors();

  lookupError.textContent = "";

  const lastName =
    lastNameInput.value.trim();

  const phone =
    formatPhoneNumber(
      phoneInput.value
    );

  phoneInput.value = phone;

  if (lastName.length < 2) {
    setError(
      "err-lookup-last-name",
      "Enter your last name."
    );

    return;
  }

  if (
    normalizePhoneNumber(phone)
      .length !== 10
  ) {
    setError(
      "err-lookup-phone",
      "Enter a valid 10-digit phone number."
    );

    return;
  }

  lookupSubmitting = true;

  lookupButton.disabled = true;

  try {
    // ------------------------------------------------------------------------
    // Initial lookup
    // ------------------------------------------------------------------------

    if (lookupStage === "initial") {
      lookupButton.textContent =
        "Searching…";

      lookupEntries =
        await fetchLookup();

      const active =
        getActiveEntries(
          lookupEntries
        );

      if (active.length === 0) {
        lookupError.textContent =
          "We couldn't find an active registration using that last name and phone number.";

        return;
      }

      const firstNames =
        getDistinctFirstNames(
          active
        );

      // Multiple volunteers share the same last name + phone.
      if (firstNames.length > 1) {
        identityStep.classList.remove(
          "hidden"
        );

        lookupStage =
          "first-name";

        lookupButton.textContent =
          "Continue";

        return;
      }

      // Only one volunteer identity exists.
      selectedIdentityEntries =
        active.filter(
          (entry) =>
            entry.normalizedFirstName ===
            firstNames[0]
        );

      showResults();

      return;
    }

    // ------------------------------------------------------------------------
    // First-name disambiguation
    // ------------------------------------------------------------------------

    if (lookupStage === "first-name") {
      const normalizedFirst =
        normalizeFirstName(
          firstNameInput.value
        );

      if (!normalizedFirst) {
        setError(
          "err-lookup-first-name",
          "Enter your first name."
        );

        return;
      }

      const matches =
        getActiveEntries(
          lookupEntries
        ).filter(
          (entry) =>
            entry.normalizedFirstName ===
            normalizedFirst
        );

      if (matches.length === 0) {
        setError(
          "err-lookup-first-name",
          "We couldn't find a volunteer with that first name."
        );

        return;
      }

      selectedIdentityEntries =
        matches;

      showResults();

      return;
    }
  } catch (error) {
    console.error(
      "[diwali-manage] Lookup failed",
      error
    );

    lookupError.textContent =
      "We couldn't complete the lookup. Please try again.";
  } finally {
    lookupSubmitting = false;

    lookupButton.disabled = false;

    if (lookupStage === "initial") {
      lookupButton.textContent =
        "Find My Registrations";
    }

    if (lookupStage === "first-name") {
      lookupButton.textContent =
        "Continue";
    }
  }
}

// ============================================================================
// RESULTS
// ============================================================================

function showResults() {
  lookupStage = "complete";

  identityStep.classList.add(
    "hidden"
  );

  resultsSection.classList.remove(
    "hidden"
  );

  const firstEntry =
    selectedIdentityEntries[0];

  if (!firstEntry) {
    return;
  }

  resultsName.textContent =
    `${firstEntry.firstName} ${firstEntry.lastName}`;

  const email =
    getStoredEmail(firstEntry);

  const phone =
    getStoredPhone(firstEntry);

  if (resultsContact) {
    const contactParts = [];

    if (email) {
      contactParts.push(email);
    }

    if (phone) {
      contactParts.push(
        formatPhoneNumber(phone)
      );
    }

    resultsContact.textContent =
      contactParts.join(" • ");
  }

  renderRegistrations();

  renderAddShiftOptions();

  window.scrollTo({
    top:
      resultsSection.offsetTop - 20,
    behavior: "smooth",
  });
}

function renderRegistrations() {
  registrationList.textContent = "";

  const entries =
    getActiveEntries(
      selectedIdentityEntries
    ).sort(
      (a, b) =>
        String(
          a.shiftStartTime
        ).localeCompare(
          String(
            b.shiftStartTime
          )
        )
    );

  if (entries.length === 0) {
    const empty =
      document.createElement("p");

    empty.className =
      "registration-empty";

    empty.textContent =
      "You don't have any active registrations.";

    registrationList.appendChild(
      empty
    );

    return;
  }

  for (
    const entry of entries
  ) {
    const item =
      document.createElement("article");

    item.className =
      "registration-item";

    const main =
      document.createElement("div");

    main.className =
      "registration-item-main";

    const position =
      document.createElement("p");

    position.className =
      "registration-position";

    position.textContent =
      entry.positionName;

    const shift =
      document.createElement("p");

    shift.className =
      "registration-shift";

    shift.textContent =
      entry.shiftLabel ||
      formatShiftTime(
        entry.shiftStartTime,
        entry.shiftEndTime
      );

    main.appendChild(position);
    main.appendChild(shift);

    const actions =
      document.createElement("div");

    actions.className =
      "registration-item-actions";

    const cancelButton =
      document.createElement("button");

    cancelButton.type = "button";
    cancelButton.className =
      "btn cancel-btn";
    cancelButton.textContent =
      "Cancel Shift";

    cancelButton.addEventListener(
      "click",
      () =>
        cancelRegistration(entry)
    );

    actions.appendChild(
      cancelButton
    );

    item.appendChild(main);
    item.appendChild(actions);

    registrationList.appendChild(
      item
    );
  }
}

// ============================================================================
// AVAILABILITY
// ============================================================================

async function loadAvailability() {
  const jobs =
    VOLUNTEER_POSITIONS.flatMap(
      (position) =>
        position.shifts.map(
          async (shift) => {
            const ref =
              doc(
                db,
                "shiftCounts",
                `${CONFIG.eventId}_${shift.id}`
              );

            const snap =
              await getDoc(ref);

            if (snap.exists()) {
              const data =
                snap.data();

              const capacity =
                typeof data.capacity ===
                "number"
                  ? data.capacity
                  : shift.capacity;

              const count =
                typeof data.count ===
                "number"
                  ? data.count
                  : 0;

              availabilityCache[
                shift.id
              ] = {
                capacity,
                count,
                remaining:
                  Math.max(
                    0,
                    capacity - count
                  ),
              };

              return;
            }

            availabilityCache[
              shift.id
            ] = {
              capacity:
                shift.capacity,
              count: 0,
              remaining:
                Math.max(
                  0,
                  shift.capacity
                ),
            };
          }
        )
    );

  await Promise.allSettled(jobs);
}

function getAvailability(shift) {
  return (
    availabilityCache[
      shift.id
    ] || {
      capacity:
        shift.capacity,

      count: 0,

      remaining:
        Math.max(
          0,
          shift.capacity
        ),
    }
  );
}

// ============================================================================
// ADD SHIFT
// ============================================================================

async function renderAddShiftOptions() {
  addShiftGrid.textContent = "";

  selectedShift = null;

  addShiftButton.disabled = true;

  addShiftError.textContent = "";

  await loadAvailability();

  const active =
    getActiveEntries(
      selectedIdentityEntries
    );

  for (
    const position of
      VOLUNTEER_POSITIONS
  ) {
    const positionCard =
      document.createElement(
        "section"
      );

    positionCard.className =
      "manage-position";

    const header =
      document.createElement(
        "div"
      );

    header.className =
      "manage-position-header";

    const title =
      document.createElement("h3");

    title.textContent =
      position.name;

    header.appendChild(title);

    const shifts =
      document.createElement("div");

    shifts.className =
      "manage-shifts";

    for (
      const shift of
        position.shifts
    ) {
      const availability =
        getAvailability(
          shift
        );

      const alreadyRegistered =
        active.some(
          (entry) =>
            entry.shiftId ===
            shift.id
        );

      const overlapsExisting =
        active.some(
          (entry) =>
            hasTimeOverlap(
              entry.shiftStartTime,
              entry.shiftEndTime,
              shift.startTime,
              shift.endTime
            )
        );

      const isFull =
        availability.remaining <= 0;

      const unavailable =
        shift.capacity <= 0;

      const button =
        document.createElement(
          "button"
        );

      button.type = "button";
      button.className =
        "manage-shift";

      button.disabled =
        alreadyRegistered ||
        overlapsExisting ||
        isFull ||
        unavailable;

      const time =
        document.createElement(
          "span"
        );

      time.className =
        "manage-shift-time";

      time.textContent =
        formatShiftTime(
          shift.startTime,
          shift.endTime
        );

      const capacity =
        document.createElement(
          "span"
        );

      capacity.className =
        "manage-shift-capacity";

      if (alreadyRegistered) {
        capacity.textContent =
          "Already registered";
      } else if (overlapsExisting) {
        capacity.textContent =
          "Overlaps another shift";
      } else if (
        unavailable ||
        isFull
      ) {
        capacity.textContent =
          "Full";
      } else {
        capacity.textContent =
          `${availability.remaining} spot${
            availability.remaining === 1
              ? ""
              : "s"
          } left`;
      }

      button.appendChild(time);
      button.appendChild(capacity);

      if (!button.disabled) {
        button.addEventListener(
          "click",
          () => {
            document
              .querySelectorAll(
                ".manage-shift.selected"
              )
              .forEach(
                (selected) =>
                  selected.classList.remove(
                    "selected"
                  )
              );

            button.classList.add(
              "selected"
            );

            selectedShift = {
              position,
              shift,
            };

            addShiftButton.disabled =
              false;
          }
        );
      }

      shifts.appendChild(button);
    }

    positionCard.appendChild(header);
    positionCard.appendChild(shifts);

    addShiftGrid.appendChild(
      positionCard
    );
  }
}

async function addSelectedShift() {
  if (!selectedShift) {
    return;
  }

  addShiftError.textContent = "";

  const identity =
    selectedIdentityEntries[0];

  if (!identity) {
    addShiftError.textContent =
      "We couldn't identify the volunteer.";

    return;
  }

  const email =
    getStoredEmail(identity);

  if (!email) {
    addShiftError.textContent =
      "We couldn't find the email address associated with this registration.";

    return;
  }

  const {
    position,
    shift,
  } = selectedShift;

  const normalizedFirst =
    identity.normalizedFirstName ||
    normalizeFirstName(
      identity.firstName
    );

  const normalizedLast =
    normalizeLastName(
      lastNameInput.value
    );

  const normalizedPhone =
    normalizePhoneNumber(
      phoneInput.value
    );

  // --------------------------------------------------------------------------
  // Client-side overlap check
  // --------------------------------------------------------------------------

  const overlaps =
    getActiveEntries(
      selectedIdentityEntries
    ).some(
      (entry) =>
        hasTimeOverlap(
          entry.shiftStartTime,
          entry.shiftEndTime,
          shift.startTime,
          shift.endTime
        )
    );

  if (overlaps) {
    addShiftError.textContent =
      "That shift overlaps one of your existing shifts.";

    return;
  }

  addShiftButton.disabled = true;
  addShiftButton.textContent = "Adding…";

  try {
    const shiftRef =
      doc(
        db,
        "shiftCounts",
        `${CONFIG.eventId}_${shift.id}`
      );

    const lookupRef =
      doc(
        db,
        "registrationLookups",
        lookupId
      );

    const registrationRef =
      doc(
        collection(
          db,
          "registrations"
        )
      );

    const personGuardRef =
      doc(
        db,
        "registrationGuards",
        `person_shift_${normalizedFirst}_${normalizedLast}_${normalizedPhone}_${shift.id}`
      );

    await runTransaction(
      db,
      async (tx) => {
        const [
          shiftSnap,
          personGuardSnap,
          lookupSnap,
        ] = await Promise.all([
          tx.get(shiftRef),
          tx.get(personGuardRef),
          tx.get(lookupRef),
        ]);

        if (!lookupSnap.exists()) {
          throw new Error(
            "IDENTITY_NOT_FOUND"
          );
        }

        const lookupData =
          lookupSnap.data();

        const allEntries =
          Array.isArray(
            lookupData.entries
          )
            ? lookupData.entries
            : [];

        // Only consider the selected volunteer's active registrations.
        const activeEntries =
          allEntries
            .filter(isActive)
            .filter(
              (entry) =>
                entry.normalizedFirstName ===
                  normalizedFirst &&
                entry.normalizedLastName ===
                  normalizedLast &&
                entry.normalizedPhone ===
                  normalizedPhone
            );

        // Same volunteer + same shift.
        const alreadyRegistered =
          activeEntries.some(
            (entry) =>
              entry.shiftId ===
              shift.id
          );

        if (alreadyRegistered) {
          throw new Error(
            "DUPLICATE_SHIFT"
          );
        }

        // Same volunteer + overlapping shift.
        const overlapping =
          activeEntries.some(
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

        // Strong duplicate guard.
        if (
          personGuardSnap.exists() &&
          personGuardSnap.data()?.status !==
            "cancelled"
        ) {
          throw new Error(
            "DUPLICATE_SHIFT"
          );
        }

        if (shift.capacity <= 0) {
          throw new Error(
            "SHIFT_FULL"
          );
        }

        // --------------------------------------------------------------------
        // Reserve capacity
        // --------------------------------------------------------------------

        if (shiftSnap.exists()) {
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
        } else {
          tx.set(
            shiftRef,
            {
              eventId:
                CONFIG.eventId,

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
        }

        // --------------------------------------------------------------------
        // Create registration
        // --------------------------------------------------------------------

        tx.set(
          registrationRef,
          {
            schemaVersion:
              CONFIG.schemaVersion,

            eventId:
              CONFIG.eventId,

            eventName:
              CONFIG.eventName,

            eventDate:
              CONFIG.eventDate,

            location:
              CONFIG.location,

            firstName:
              identity.firstName,

            lastName:
              identity.lastName,

            email,

            phone:
              formatPhoneNumber(
                phoneInput.value
              ),

            normalizedFirstName:
              normalizedFirst,

            normalizedLastName:
              normalizedLast,

            normalizedPhone:
              normalizedPhone,

            emailGuardKey:
              encodeURIComponent(email),

            manageLookupId:
              lookupId,

            is18OrOlder:
              typeof identity.is18OrOlder ===
              "boolean"
                ? identity.is18OrOlder
                : null,

            notes:
              addNotesInput.value.trim(),

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
          }
        );

        // --------------------------------------------------------------------
        // Person-specific duplicate guard
        // --------------------------------------------------------------------

        tx.set(
          personGuardRef,
          {
            registrationId:
              registrationRef.id,

            type:
              "person_shift",

            status:
              "active",

            firstName:
              normalizedFirst,

            lastName:
              normalizedLast,

            phone:
              normalizedPhone,

            shiftId:
              shift.id,

            createdAt:
              serverTimestamp(),
          }
        );

        // --------------------------------------------------------------------
        // Update public lookup
        // --------------------------------------------------------------------

        const updatedEntries =
          allEntries.filter(
            (entry) =>
              entry &&
              entry.registrationId !==
                registrationRef.id
          );

        updatedEntries.push({
          registrationId:
            registrationRef.id,

          firstName:
            identity.firstName,

          normalizedFirstName:
            normalizedFirst,

          lastName:
            identity.lastName,

          normalizedLastName:
            normalizedLast,

          phone:
            formatPhoneNumber(
              phoneInput.value
            ),

          normalizedPhone:
            normalizedPhone,

          email,

          emailHash:
            identity.emailHash || null,

          emailGuardKey:
            encodeURIComponent(email),

          is18OrOlder:
            identity.is18OrOlder,

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
        });

        const registrationIds =
          Array.isArray(
            lookupData.registrationIds
          )
            ? [
                ...lookupData.registrationIds,
              ]
            : [];

        if (
          !registrationIds.includes(
            registrationRef.id
          )
        ) {
          registrationIds.push(
            registrationRef.id
          );
        }

        tx.set(
          lookupRef,
          {
            eventId:
              CONFIG.eventId,

            normalizedLastName:
              normalizedLast,

            entries:
              updatedEntries,

            registrationIds,

            updatedAt:
              serverTimestamp(),
          },
          {
            merge: true,
          }
        );
      }
    );

    // Update local state immediately.
    selectedIdentityEntries.push({
      registrationId:
        registrationRef.id,

      firstName:
        identity.firstName,

      normalizedFirstName:
        normalizedFirst,

      lastName:
        identity.lastName,

      normalizedLastName:
        normalizedLast,

      phone:
        formatPhoneNumber(
          phoneInput.value
        ),

      normalizedPhone:
        normalizedPhone,

      email,

      emailGuardKey:
        encodeURIComponent(email),

      emailHash:
        identity.emailHash || null,

      is18OrOlder:
        identity.is18OrOlder,

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
    });

    addNotesInput.value = "";

    selectedShift = null;

    renderRegistrations();

    await renderAddShiftOptions();

    window.alert(
      "Your additional shift has been added."
    );
  } catch (error) {
    if (
      error?.message ===
      "DUPLICATE_SHIFT"
    ) {
      addShiftError.textContent =
        "You're already registered for that shift.";
    } else if (
      error?.message ===
      "SHIFT_OVERLAP"
    ) {
      addShiftError.textContent =
        "That shift overlaps one of your existing shifts.";
    } else if (
      error?.message ===
      "SHIFT_FULL"
    ) {
      addShiftError.textContent =
        "That shift just filled up. Please choose another shift.";

      await renderAddShiftOptions();
    } else if (
      error?.message ===
      "SHIFT_UNAVAILABLE"
    ) {
      addShiftError.textContent =
        "That shift is currently unavailable.";
    } else if (
      error?.message ===
      "IDENTITY_NOT_FOUND"
    ) {
      addShiftError.textContent =
        "We couldn't verify your registration. Please start a new search.";
    } else {
      console.error(
        "[diwali-manage] Add shift failed",
        error
      );

      addShiftError.textContent =
        "We couldn't add that shift. Please try again.";
    }
  } finally {
    addShiftButton.textContent =
      "Add Selected Shift";

    addShiftButton.disabled =
      !selectedShift;
  }
}

// ============================================================================
// CANCELLATION
// ============================================================================

async function cancelRegistration(entry) {
  const confirmed =
    window.confirm(
      `Cancel ${entry.positionName} — ${entry.shiftLabel}?`
    );

  if (!confirmed) {
    return;
  }

  try {
    const lookupRef =
      doc(
        db,
        "registrationLookups",
        lookupId
      );

    const registrationRef =
      doc(
        db,
        "registrations",
        entry.registrationId
      );

    const shiftRef =
      doc(
        db,
        "shiftCounts",
        `${CONFIG.eventId}_${entry.shiftId}`
      );

    const personGuardRef =
      doc(
        db,
        "registrationGuards",
        `person_shift_${entry.normalizedFirstName}_${entry.normalizedLastName}_${normalizePhoneNumber(
          phoneInput.value
        )}_${entry.shiftId}`
      );

    await runTransaction(
      db,
      async (tx) => {
        const [
          lookupSnap,
          shiftSnap,
          personGuardSnap,
        ] = await Promise.all([
          tx.get(lookupRef),
          tx.get(shiftRef),
          tx.get(personGuardRef),
        ]);

        if (!lookupSnap.exists()) {
          throw new Error(
            "REGISTRATION_NOT_FOUND"
          );
        }

        const lookupData =
          lookupSnap.data();

        if (
          lookupData.eventId !==
          CONFIG.eventId
        ) {
          throw new Error(
            "REGISTRATION_NOT_FOUND"
          );
        }

        const registrationIds =
          Array.isArray(
            lookupData.registrationIds
          )
            ? [
                ...lookupData.registrationIds,
              ]
            : [];

        if (
          !registrationIds.includes(
            entry.registrationId
          )
        ) {
          throw new Error(
            "REGISTRATION_NOT_FOUND"
          );
        }

        const entries =
          Array.isArray(
            lookupData.entries
          )
            ? [
                ...lookupData.entries,
              ]
            : [];

        const registrationIndex =
          entries.findIndex(
            (candidate) =>
              candidate &&
              candidate.registrationId ===
                entry.registrationId
          );

        if (
          registrationIndex === -1
        ) {
          throw new Error(
            "REGISTRATION_NOT_FOUND"
          );
        }

        const storedEntry =
          entries[
            registrationIndex
          ];

        if (
          storedEntry.status !==
          "registered"
        ) {
          throw new Error(
            "ALREADY_CANCELLED"
          );
        }

        if (!shiftSnap.exists()) {
          throw new Error(
            "SHIFT_UNAVAILABLE"
          );
        }

        const shiftData =
          shiftSnap.data();

        if (
          typeof shiftData.count !==
          "number"
        ) {
          throw new Error(
            "SHIFT_UNAVAILABLE"
          );
        }

        // --------------------------------------------------------------------
        // Permanently remove the public lookup entry.
        // --------------------------------------------------------------------

        const updatedEntries =
          entries.filter(
            (candidate) =>
              candidate &&
              candidate.registrationId !==
                entry.registrationId
          );

        const updatedRegistrationIds =
          registrationIds.filter(
            (registrationId) =>
              registrationId !==
              entry.registrationId
          );

        // --------------------------------------------------------------------
        // Permanently delete the private registration.
        // --------------------------------------------------------------------

        tx.delete(
          registrationRef
        );

        // --------------------------------------------------------------------
        // Release capacity.
        // --------------------------------------------------------------------

        tx.update(
          shiftRef,
          {
            count:
              Math.max(
                0,
                shiftData.count - 1
              ),
          }
        );

        // --------------------------------------------------------------------
        // Remove the person/shift duplicate guard.
        // --------------------------------------------------------------------

        if (
          personGuardSnap.exists()
        ) {
          tx.delete(
            personGuardRef
          );
        }

        // --------------------------------------------------------------------
        // Update lookup.
        // --------------------------------------------------------------------

        tx.set(
          lookupRef,
          {
            eventId:
              CONFIG.eventId,

            normalizedLastName:
              normalizeLastName(
                lastNameInput.value
              ),

            entries:
              updatedEntries,

            registrationIds:
              updatedRegistrationIds,

            updatedAt:
              serverTimestamp(),
          },
          {
            merge: true,
          }
        );
      }
    );

    // Remove from local UI immediately.
    selectedIdentityEntries =
      selectedIdentityEntries.filter(
        (candidate) =>
          candidate.registrationId !==
          entry.registrationId
      );

    // Refresh the displayed registrations.
    renderRegistrations();

    await renderAddShiftOptions();

    window.alert(
      "That shift has been cancelled."
    );
  } catch (error) {
    console.error(
      "[diwali-manage] Cancellation failed",
      error
    );

    if (
      error?.message ===
      "ALREADY_CANCELLED"
    ) {
      window.alert(
        "That shift has already been cancelled."
      );

      return;
    }

    if (
      error?.message ===
      "REGISTRATION_NOT_FOUND"
    ) {
      window.alert(
        "That registration could not be found."
      );

      return;
    }

    if (
      error?.message ===
      "SHIFT_UNAVAILABLE"
    ) {
      window.alert(
        "The shift information could not be updated. Please try again."
      );

      return;
    }

    window.alert(
      "We couldn't cancel that shift. Please try again."
    );
  }
}

// ============================================================================
// RESET
// ============================================================================

function resetManagePage() {
  lookupId = null;

  lookupEntries = [];

  selectedIdentityEntries = [];

  selectedShift = null;

  lookupStage = "initial";

  lookupForm.reset();

  identityStep.classList.add(
    "hidden"
  );

  resultsSection.classList.add(
    "hidden"
  );

  addShiftGrid.textContent = "";

  addShiftError.textContent = "";

  if (resultsContact) {
    resultsContact.textContent = "";
  }

  clearErrors();

  lookupError.textContent = "";

  lookupButton.textContent =
    "Find My Registrations";

  window.scrollTo({
    top: 0,
    behavior: "smooth",
  });
}

// ============================================================================
// WIRING
// ============================================================================

if (phoneInput) {
  phoneInput.addEventListener(
    "input",
    () => {
      phoneInput.value =
        formatPhoneNumber(
          phoneInput.value
        );
    }
  );
}

if (lookupForm) {
  lookupForm.addEventListener(
    "submit",
    submitLookup
  );
}

if (addShiftButton) {
  addShiftButton.addEventListener(
    "click",
    addSelectedShift
  );
}

if (newSearchButton) {
  newSearchButton.addEventListener(
    "click",
    resetManagePage
  );
}