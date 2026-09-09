// ============================================================================
// manage.js
//
// Public Manage Registrations page.
//
// Architecture:
//   Last name + phone
//        ↓
//   hashed registrationLookups document
//        ↓
//   identify volunteer
//        ↓
//   view active/cancelled shifts
//        ↓
//   cancel individual shift
//        ↓
//   add another non-overlapping shift
//
// No Firebase Cloud Functions are used.
// ============================================================================

import {
  CONFIG,
  VOLUNTEER_POSITIONS,
  formatShiftTime,
  getRegistrationLookupId,
  normalizeFirstName,
  normalizeLastName,
  normalizePhoneNumber,
  sha256Hex,
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

const emailInput =
  document.getElementById("lookup-email");

const identityStep =
  document.getElementById("identity-step");

const emailStep =
  document.getElementById("email-step");

const lookupError =
  document.getElementById("lookup-error");

const lookupButton =
  document.getElementById("lookup-button");

const resultsSection =
  document.getElementById("results-section");

const resultsName =
  document.getElementById("results-name");

const registrationList =
  document.getElementById("registration-list");

const newSearchButton =
  document.getElementById("new-search");

const addShiftGrid =
  document.getElementById("add-shift-grid");

const addEmailInput =
  document.getElementById("add-email");

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

function setError(
  elementId,
  message
) {
  const element =
    document.getElementById(
      elementId
    );

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

function activeEntries(entries) {
  return entries.filter(
    (entry) =>
      entry &&
      typeof entry.registrationId ===
        "string"
  );
}

function isActive(entry) {
  return (
    entry?.status ===
    "registered"
  );
}

function getActiveIdentityEntries() {
  return activeEntries(
    selectedIdentityEntries
  ).filter(isActive);
}

function getDistinctFirstNames(
  entries
) {
  return [
    ...new Set(
      activeEntries(entries)
        .map(
          (entry) =>
            entry.normalizedFirstName
        )
        .filter(Boolean)
    ),
  ];
}

function getDistinctEmailHashes(
  entries
) {
  return [
    ...new Set(
      activeEntries(entries)
        .map(
          (entry) =>
            entry.emailHash
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

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    String(value || "")
      .trim()
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

async function submitLookup(
  event
) {
  event.preventDefault();

  if (
    lookupSubmitting
  ) {
    return;
  }

  clearErrors();

  lookupError.textContent =
    "";

  const lastName =
    lastNameInput.value.trim();

  const phone =
    formatPhoneNumber(
      phoneInput.value
    );

  phoneInput.value =
    phone;

  if (
    lastName.length < 2
  ) {
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

  lookupSubmitting =
    true;

  lookupButton.disabled =
    true;

  try {

    // --------------------------------------------------------------
    // Initial last-name + phone lookup
    // --------------------------------------------------------------

    if (
      lookupStage ===
      "initial"
    ) {
      lookupButton.textContent =
        "Searching…";

      lookupEntries =
        await fetchLookup();

      const active =
        activeEntries(
          lookupEntries
        );

      if (
        active.length === 0
      ) {
        lookupError.textContent =
          "We couldn't find an active registration using that last name and phone number.";

        return;
      }

      const firstNames =
        getDistinctFirstNames(
          active
        );

      if (
        firstNames.length >
        1
      ) {
        identityStep.classList.remove(
          "hidden"
        );

        lookupStage =
          "first-name";

        lookupButton.textContent =
          "Continue";

        return;
      }

      selectedIdentityEntries =
        active.filter(
          (entry) =>
            entry.normalizedFirstName ===
            firstNames[0]
        );

      prepareFinalIdentityStep();

      return;
    }


    // --------------------------------------------------------------
    // First-name disambiguation
    // --------------------------------------------------------------

    if (
      lookupStage ===
      "first-name"
    ) {
      const normalizedFirst =
        normalizeFirstName(
          firstNameInput.value
        );

      if (
        !normalizedFirst
      ) {
        setError(
          "err-lookup-first-name",
          "Enter your first name."
        );

        return;
      }

      const matches =
        activeEntries(
          lookupEntries
        ).filter(
          (entry) =>
            entry.normalizedFirstName ===
            normalizedFirst
        );

      if (
        matches.length ===
        0
      ) {
        setError(
          "err-lookup-first-name",
          "We couldn't find a volunteer with that first name."
        );

        return;
      }

      selectedIdentityEntries =
        matches;

      prepareFinalIdentityStep();

      return;
    }


    // --------------------------------------------------------------
    // Email disambiguation
    // --------------------------------------------------------------

    if (
      lookupStage ===
      "email"
    ) {
      const email =
        emailInput.value
          .trim()
          .toLowerCase();

      if (
        !isEmail(email)
      ) {
        setError(
          "err-lookup-email",
          "Enter a valid email address."
        );

        return;
      }

      const emailHash =
        await sha256Hex(
          email
        );

      const matches =
        selectedIdentityEntries.filter(
          (entry) =>
            entry.emailHash ===
            emailHash
        );

      if (
        matches.length ===
        0
      ) {
        setError(
          "err-lookup-email",
          "That email address does not match the registration information we found."
        );

        return;
      }

      selectedIdentityEntries =
        matches;

      showResults();

      return;
    }

  } catch (error) {

    lookupError.textContent =
      "We couldn't complete the lookup. Please try again.";

  } finally {

    lookupSubmitting =
      false;

    lookupButton.disabled =
      false;

    if (
      lookupStage ===
      "initial"
    ) {
      lookupButton.textContent =
        "Find My Registrations";
    }
  }
}

function prepareFinalIdentityStep() {
  const emailHashes =
    getDistinctEmailHashes(
      selectedIdentityEntries
    );

  if (
    emailHashes.length >
    1
  ) {
    emailStep.classList.remove(
      "hidden"
    );

    lookupStage =
      "email";

    lookupButton.textContent =
      "Continue";

    return;
  }

  showResults();
}

// ============================================================================
// RESULTS
// ============================================================================

function showResults() {
  lookupStage =
    "complete";

  identityStep.classList.add(
    "hidden"
  );

  emailStep.classList.add(
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

  renderRegistrations();

  renderAddShiftOptions();

  window.scrollTo({
    top:
      resultsSection.offsetTop -
      20,
    behavior: "smooth",
  });
}

function renderRegistrations() {
  registrationList.textContent =
    "";

  const entries =
    [
      ...selectedIdentityEntries,
    ].sort(
      (a, b) => {
        if (
          a.status ===
          b.status
        ) {
          return String(
            a.shiftStartTime
          ).localeCompare(
            String(
              b.shiftStartTime
            )
          );
        }

        return a.status ===
          "registered"
          ? -1
          : 1;
      }
    );

  for (
    const entry of entries
  ) {
    const item =
      document.createElement(
        "article"
      );

    item.className =
      "registration-item";

    const main =
      document.createElement(
        "div"
      );

    main.className =
      "registration-item-main";

    const position =
      document.createElement(
        "p"
      );

    position.className =
      "registration-position";

    position.textContent =
      entry.positionName;

    const shift =
      document.createElement(
        "p"
      );

    shift.className =
      "registration-shift";

    shift.textContent =
      entry.shiftLabel ||
      formatShiftTime(
        entry.shiftStartTime,
        entry.shiftEndTime
      );

    const status =
      document.createElement(
        "span"
      );

    status.className =
      "registration-status " +
      (
        isActive(entry)
          ? "active"
          : "cancelled"
      );

    status.textContent =
      isActive(entry)
        ? "Registered"
        : "Cancelled";

    main.appendChild(
      position
    );

    main.appendChild(
      shift
    );

    main.appendChild(
      status
    );

    const actions =
      document.createElement(
        "div"
      );

    actions.className =
      "registration-item-actions";

    if (
      isActive(entry)
    ) {
      const cancelButton =
        document.createElement(
          "button"
        );

      cancelButton.type =
        "button";

      cancelButton.className =
        "btn cancel-btn";

      cancelButton.textContent =
        "Cancel Shift";

      cancelButton.addEventListener(
        "click",
        () =>
          cancelRegistration(
            entry
          )
      );

      actions.appendChild(
        cancelButton
      );
    }

    item.appendChild(
      main
    );

    item.appendChild(
      actions
    );

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

            if (
              snap.exists()
            ) {
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
                    capacity -
                      count
                  ),
              };

            } else {
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
          }
        )
    );

  await Promise.allSettled(
    jobs
  );
}

function getAvailability(
  shift
) {
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
  addShiftGrid.textContent =
    "";

  selectedShift =
    null;

  addShiftButton.disabled =
    true;

  addShiftError.textContent =
    "";

  await loadAvailability();

  const active =
    getActiveIdentityEntries();

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
      document.createElement(
        "h3"
      );

    title.textContent =
      position.name;

    header.appendChild(
      title
    );

    const shifts =
      document.createElement(
        "div"
      );

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
        availability.remaining <=
        0;

      const unavailable =
        shift.capacity <=
        0;

      const button =
        document.createElement(
          "button"
        );

      button.type =
        "button";

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

      if (
        alreadyRegistered
      ) {
        capacity.textContent =
          "Already registered";

      } else if (
        overlapsExisting
      ) {
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
            availability.remaining ===
            1
              ? ""
              : "s"
          } left`;
      }

      button.appendChild(
        time
      );

      button.appendChild(
        capacity
      );

      if (
        !button.disabled
      ) {
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

      shifts.appendChild(
        button
      );
    }

    positionCard.appendChild(
      header
    );

    positionCard.appendChild(
      shifts
    );

    addShiftGrid.appendChild(
      positionCard
    );
  }
}

async function addSelectedShift() {
  if (!selectedShift) {
    return;
  }

  addShiftError.textContent =
    "";

  const email =
    addEmailInput.value
      .trim()
      .toLowerCase();

  if (!isEmail(email)) {
    addShiftError.textContent =
      "Enter a valid email address.";

    return;
  }

  const identity =
    selectedIdentityEntries[0];

  if (!identity) {
    addShiftError.textContent =
      "We couldn't identify the volunteer.";

    return;
  }

  const {
    position,
    shift,
  } =
    selectedShift;

  // Client-side overlap check.
  const overlaps =
    getActiveIdentityEntries()
      .some(
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

  addShiftButton.disabled =
    true;

  addShiftButton.textContent =
    "Adding…";

  try {

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

    const emailGuardKey =
      encodeURIComponent(
        email
      );

    const emailHash =
      await sha256Hex(
        email
      );

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

    const emailGuardRef =
      doc(
        db,
        "registrationGuards",
        `email_shift_${emailGuardKey}_${shift.id}`
      );

    await runTransaction(
      db,
      async (tx) => {

        const [
          shiftSnap,
          personGuardSnap,
          emailGuardSnap,
          lookupSnap,
        ] =
          await Promise.all([
            tx.get(
              shiftRef
            ),
            tx.get(
              personGuardRef
            ),
            tx.get(
              emailGuardRef
            ),
            tx.get(
              lookupRef
            ),
          ]);

        if (
          !lookupSnap.exists()
        ) {
          throw new Error(
            "IDENTITY_NOT_FOUND"
          );
        }

        const lookupData =
          lookupSnap.data();

        const lookupEntries =
          Array.isArray(
            lookupData.entries
          )
            ? lookupData.entries
            : [];

        const activeEntries =
          lookupEntries.filter(
            isActive
          );

        const alreadyRegistered =
          activeEntries.some(
            (entry) =>
              entry.shiftId ===
              shift.id
          );

        if (
          alreadyRegistered
        ) {
          throw new Error(
            "DUPLICATE_SHIFT"
          );
        }

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

        if (
          overlapping
        ) {
          throw new Error(
            "SHIFT_OVERLAP"
          );
        }

        if (
          personGuardSnap.exists() &&
          personGuardSnap.data()?.status !==
            "cancelled"
        ) {
          throw new Error(
            "DUPLICATE_SHIFT"
          );
        }

        if (
          emailGuardSnap.exists() &&
          emailGuardSnap.data()?.status !==
            "cancelled"
        ) {
          throw new Error(
            "DUPLICATE_SHIFT"
          );
        }

        if (
          shift.capacity <=
          0
        ) {
          throw new Error(
            "SHIFT_FULL"
          );
        }

        if (
          shiftSnap.exists()
        ) {
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
                shiftData.count +
                1,
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

            normalizedPhone,

            emailGuardKey,

            manageLookupId:
              lookupId,

            is18OrOlder:
              typeof identity.is18OrOlder ===
              "boolean"
                ? identity.is18OrOlder
                : null,

            notes:
              addNotesInput.value
                .trim(),

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

        tx.set(
          emailGuardRef,
          {
            registrationId:
              registrationRef.id,

            type:
              "email_shift",

            status:
              "active",

            createdAt:
              serverTimestamp(),
          }
        );

        const updatedEntries =
          lookupEntries.filter(
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

          emailHash,

          emailGuardKey,

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

      emailHash,

      emailGuardKey,

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

    addEmailInput.value =
      "";

    addNotesInput.value =
      "";

    selectedShift =
      null;

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

    } else {
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

async function cancelRegistration(
  entry
) {
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

    if (
      typeof entry.emailGuardKey !==
      "string"
    ) {
      throw new Error(
        "MISSING_EMAIL_GUARD_KEY"
      );
    }

    const emailGuardRef =
      doc(
        db,
        "registrationGuards",
        `email_shift_${entry.emailGuardKey}_${entry.shiftId}`
      );

    await runTransaction(
      db,
      async (tx) => {

        // We intentionally do NOT read the private registration document.
        // The lookup record is the public management credential.
        const [
          lookupSnap,
          shiftSnap,
          personGuardSnap,
          emailGuardSnap,
        ] =
          await Promise.all([
            tx.get(
              lookupRef
            ),
            tx.get(
              shiftRef
            ),
            tx.get(
              personGuardRef
            ),
            tx.get(
              emailGuardRef
            ),
          ]);

        if (
          !lookupSnap.exists()
        ) {
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
            ? lookupData.registrationIds
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

        const index =
          entries.findIndex(
            (candidate) =>
              candidate.registrationId ===
              entry.registrationId
          );

        if (
          index === -1
        ) {
          throw new Error(
            "REGISTRATION_NOT_FOUND"
          );
        }

        if (
          entries[index].status !==
          "registered"
        ) {
          throw new Error(
            "ALREADY_CANCELLED"
          );
        }

        if (
          !shiftSnap.exists()
        ) {
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

        // Update the public lookup representation.
        entries[index] = {
          ...entries[index],

          status:
            "cancelled",

          cancelledAt:
            new Date().toISOString(),
        };

        // Cancel actual private registration.
        tx.update(
          registrationRef,
          {
            status:
              "cancelled",

            cancelledAt:
              serverTimestamp(),
          }
        );

        // Release one capacity slot.
        tx.update(
          shiftRef,
          {
            count:
              Math.max(
                0,
                shiftData.count -
                  1
              ),
          }
        );

        // Disable duplicate guards.
        if (
          personGuardSnap.exists()
        ) {
          tx.update(
            personGuardRef,
            {
              status:
                "cancelled",

              cancelledAt:
                serverTimestamp(),
            }
          );
        }

        if (
          emailGuardSnap.exists()
        ) {
          tx.update(
            emailGuardRef,
            {
              status:
                "cancelled",

              cancelledAt:
                serverTimestamp(),
            }
          );
        }

        tx.set(
          lookupRef,
          {
            entries,

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

    const localEntry =
      selectedIdentityEntries.find(
        (candidate) =>
          candidate.registrationId ===
          entry.registrationId
      );

    if (localEntry) {
      localEntry.status =
        "cancelled";

      localEntry.cancelledAt =
        new Date().toISOString();
    }

    renderRegistrations();

    await renderAddShiftOptions();

  } catch (error) {

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

    window.alert(
      "We couldn't cancel that shift. Please try again."
    );
  }
}

// ============================================================================
// RESET
// ============================================================================

function resetManagePage() {
  lookupId =
    null;

  lookupEntries =
    [];

  selectedIdentityEntries =
    [];

  selectedShift =
    null;

  lookupStage =
    "initial";

  lookupForm.reset();

  identityStep.classList.add(
    "hidden"
  );

  emailStep.classList.add(
    "hidden"
  );

  resultsSection.classList.add(
    "hidden"
  );

  addShiftGrid.textContent =
    "";

  addShiftError.textContent =
    "";

  clearErrors();

  lookupError.textContent =
    "";

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

phoneInput.addEventListener(
  "input",
  () => {
    phoneInput.value =
      formatPhoneNumber(
        phoneInput.value
      );
  }
);

lookupForm.addEventListener(
  "submit",
  submitLookup
);

addShiftButton.addEventListener(
  "click",
  addSelectedShift
);

newSearchButton.addEventListener(
  "click",
  resetManagePage
);