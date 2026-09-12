// ============================================================================
// config.js
//
// Single source of truth for event-specific values.
// Update this file when the event's positions, shifts, or capacities change.
//
// NOTE: None of the values in this file are secret. Security comes from
// Firestore Security Rules and a trusted backend, not from hiding
// configuration values in the client.
// ============================================================================

export const CONFIG = {
  eventId: "carmel-diwali-2026",

  eventName: "Carmel Diwali Festival of Lights",
  eventDate: "2026-10-10",

  location: "Carter Green, Carmel, IN",

  timeZone: "America/New_York",
  timeZoneLabel: "Eastern Time",

  // Bump this whenever the registration document shape changes.
  // Firestore rules and any future backend should reject documents with
  // an unexpected schemaVersion.
  schemaVersion: 1,
};

// ============================================================================
// VOLUNTEER POSITIONS
//
// The public registration UI should be organized:
//
// Position
//   → Shift
//      → Available capacity
//
// Keep each position's shifts together so volunteers can choose a role
// first and then select a specific time.
// ============================================================================

export const VOLUNTEER_POSITIONS = [
  {
    id: "event-setup",
    name: "Event Set-Up",
    description:
      "Help prepare Carter Green and the festival area before the event.",
    shifts: [
      {
        id: "event-setup-1100-1300",
        startTime: "1100",
        endTime: "1300",
        capacity: 10,
      },
      {
        id: "event-setup-1300-1500",
        startTime: "1300",
        endTime: "1500",
        capacity: 10,
      },
      {
        id: "event-setup-1500-1700",
        startTime: "1500",
        endTime: "1700",
        capacity: 10,
      },
    ],
  },

  {
    id: "vendor-assistant",
    name: "Vendor Assistant",
    description:
      "Assist festival vendors with setup and event-day needs.",
    shifts: [
      {
        id: "vendor-assistant-1300-1430",
        startTime: "1300",
        endTime: "1430",
        capacity: 5,
      },
      {
        id: "vendor-assistant-1430-1600",
        startTime: "1430",
        endTime: "1600",
        capacity: 5,
      },
    ],
  },

  {
    id: "event-runner-general-support",
    name: "Event Runner / General Support",
    description:
      "Provide general support and help with event operations as needed.",
    shifts: [
      {
        id: "event-runner-1530-1700",
        startTime: "1530",
        endTime: "1700",
        capacity: 5,
      },
      {
        id: "event-runner-1700-1830",
        startTime: "1700",
        endTime: "1830",
        capacity: 5,
      },
      {
        id: "event-runner-1830-2000",
        startTime: "1830",
        endTime: "2000",
        capacity: 5,
      },
      {
        id: "event-runner-2000-2100",
        startTime: "2000",
        endTime: "2100",
        capacity: 5,
      },
    ],
  },

  {
    id: "swagat-committee",
    name: "Swagat Committee",
    description:
      "Help welcome and guide guests during the festival.",
    shifts: [
      {
        id: "swagat-committee-1600-1730",
        startTime: "1600",
        endTime: "1730",
        capacity: 5,
      },
      {
        id: "swagat-committee-1730-1830",
        startTime: "1730",
        endTime: "1830",
        capacity: 5,
      },
      {
        id: "swagat-committee-1830-1930",
        startTime: "1830",
        endTime: "1930",
        capacity: 5,
      },
      {
        id: "swagat-committee-1930-2030",
        startTime: "1930",
        endTime: "2030",
        capacity: 5,
      },
      {
        id: "swagat-committee-2030-2130",
        startTime: "2030",
        endTime: "2130",
        capacity: 5,
      },
    ],
  },

  {
    id: "laddoo-distribution",
    name: "Laddoo Distribution",
    description:
      "Assist with organizing and distributing laddoos to festival attendees.",
    shifts: [
      {
        id: "laddoo-distribution-1600-1730",
        startTime: "1600",
        endTime: "1730",
        capacity: 2,
      },
      {
        id: "laddoo-distribution-1730-1830",
        startTime: "1730",
        endTime: "1830",
        capacity: 2,
      },
      {
        id: "laddoo-distribution-1830-1930",
        startTime: "1830",
        endTime: "1930",
        capacity: 2,
      },
      {
        id: "laddoo-distribution-1930-2030",
        startTime: "1930",
        endTime: "2030",
        capacity: 2,
      },
      {
        id: "laddoo-distribution-2030-2130",
        startTime: "2030",
        endTime: "2130",
        capacity: 2,
      },
    ],
  },

  {
    id: "diya-distribution",
    name: "Diya Distribution",
    description:
      "Help distribute diyas to festival attendees throughout the evening.",
    shifts: [
      {
        id: "diya-distribution-1600-1730",
        startTime: "1600",
        endTime: "1730",
        capacity: 2,
      },
      {
        id: "diya-distribution-1730-1830",
        startTime: "1730",
        endTime: "1830",
        capacity: 2,
      },
      {
        id: "diya-distribution-1830-1930",
        startTime: "1830",
        endTime: "1930",
        capacity: 2,
      },
      {
        id: "diya-distribution-1930-2030",
        startTime: "1930",
        endTime: "2030",
        capacity: 2,
      },
      {
        id: "diya-distribution-2030-2130",
        startTime: "2030",
        endTime: "2130",
        capacity: 2,
      },
    ],
  },

  {
    id: "flower-bracelet-making",
    name: "Flower Bracelet Making",
    description:
      "Assist with the making of flower bracelets for festival attendees.",
    shifts: [
      {
        id: "flower-bracelet-making-1600-1730",
        startTime: "1600",
        endTime: "1730",
        capacity: 3,
      },
      {
        id: "flower-bracelet-making-1730-1830",
        startTime: "1730",
        endTime: "1830",
        capacity: 3,
      },
      {
        id: "flower-bracelet-making-1830-1930",
        startTime: "1830",
        endTime: "1930",
        capacity: 3,
      },
      {
        id: "flower-bracelet-making-1930-2030",
        startTime: "1930",
        endTime: "2030",
        capacity: 3,
      },
      {
        id: "flower-bracelet-making-2030-2130",
        startTime: "2030",
        endTime: "2130",
        capacity: 3,
      },
    ],
  },

  {
    id: "rangoli-crew",
    name: "Rangoli Crew",
    description:
      "Help with the festival's rangoli area and related activities.",
    shifts: [
      {
        id: "rangoli-crew-1600-1730",
        startTime: "1600",
        endTime: "1730",
        capacity: 0,
      },
      {
        id: "rangoli-crew-1730-1830",
        startTime: "1730",
        endTime: "1830",
        capacity: 0,
      },
      {
        id: "rangoli-crew-1830-1930",
        startTime: "1830",
        endTime: "1930",
        capacity: 0,
      },
      {
        id: "rangoli-crew-1930-2030",
        startTime: "1930",
        endTime: "2030",
        capacity: 0,
      },
      {
        id: "rangoli-crew-2030-2130",
        startTime: "2030",
        endTime: "2130",
        capacity: 0,
      },
    ],
  },

  {
    id: "back-stage",
    name: "Back Stage",
    description:
      "Assist with backstage coordination for festival performances.",
    shifts: [
      {
        id: "back-stage-1600-1800",
        startTime: "1600",
        endTime: "1800",
        capacity: 2,
      },
      {
        id: "back-stage-1800-2000",
        startTime: "1800",
        endTime: "2000",
        capacity: 2,
      },
      {
        id: "back-stage-2000-2130",
        startTime: "2000",
        endTime: "2130",
        capacity: 2,
      },
    ],
  },

  {
    id: "volunteer-booth",
    name: "Volunteer Booth",
    description:
      "Assist with volunteer coordination and information at the main booth.",
    shifts: [
      {
        id: "volunteer-booth-1600-1730",
        startTime: "1600",
        endTime: "1730",
        capacity: 2,
      },
      {
        id: "volunteer-booth-1730-1900",
        startTime: "1730",
        endTime: "1900",
        capacity: 2,
      },
      {
        id: "volunteer-booth-1900-2030",
        startTime: "1900",
        endTime: "2030",
        capacity: 2,
      },
      {
        id: "volunteer-booth-2030-2130",
        startTime: "2030",
        endTime: "2130",
        capacity: 2,
      },
    ],
  },

  {
    id: "teardown-cleanup",
    name: "Tear Down & Clean Up",
    description:
      "Help clean and restore the festival area after the event.",
    shifts: [
      {
        id: "teardown-cleanup-2000-2130",
        startTime: "2000",
        endTime: "2130",
        capacity: 10,
      },
      {
        id: "teardown-cleanup-2130-2300",
        startTime: "2130",
        endTime: "2300",
        capacity: 10,
      },
    ],
  },
];

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Convert a 24-hour HHMM value into minutes after midnight.
 */
export function timeToMinutes(hhmm) {
  const text = String(hhmm ?? "");
  const hour = Number(text.slice(0, 2));
  const minute = Number(text.slice(2));

  return hour * 60 + minute;
}

/**
 * Convert a 24-hour HHMM value into a user-friendly label.
 *
 * Example:
 *   "1100" → "11:00 AM"
 *   "1430" → "2:30 PM"
 */
export function formatTime(hhmm) {
  const text = String(hhmm ?? "");
  const hour24 = Number(text.slice(0, 2));
  const minute = Number(text.slice(2));

  const period = hour24 >= 12 ? "PM" : "AM";
  const hour12 =
    hour24 % 12 === 0 ? 12 : hour24 % 12;

  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

/**
 * Format a shift as a readable range.
 *
 * Accepts either two HHMM strings:
 *   formatShiftTime("1100", "1300") → "11:00 AM – 1:00 PM"
 *
 * Or a shift object with startTime/endTime properties:
 *   formatShiftTime({ startTime: "1100", endTime: "1300" })
 *   → "11:00 AM – 1:00 PM"
 */
export function formatShiftTime(
  startTime,
  endTime
) {
  let start = startTime;
  let end = endTime;

  if (
    startTime &&
    typeof startTime === "object"
  ) {
    start = startTime.startTime;
    end = startTime.endTime;
  }

  if (typeof start !== "string") {
    start = String(start ?? "");
  }

  if (typeof end !== "string") {
    end = String(end ?? "");
  }

  return `${formatTime(start)} – ${formatTime(end)}`;
}

/**
 * Find a position by its ID.
 */
export function getPositionById(positionId) {
  return VOLUNTEER_POSITIONS.find(
    (position) =>
      position.id === positionId
  );
}

/**
 * Find a shift by position ID and shift ID.
 */
export function getShiftById(
  positionId,
  shiftId
) {
  const position =
    getPositionById(positionId);

  if (!position) {
    return null;
  }

  return (
    position.shifts.find(
      (shift) =>
        shift.id === shiftId
    ) || null
  );
}

/**
 * Find a shift and its parent position from a shift ID.
 */
export function findShift(shiftId) {
  for (
    const position of VOLUNTEER_POSITIONS
  ) {
    const shift =
      position.shifts.find(
        (candidate) =>
          candidate.id === shiftId
      );

    if (shift) {
      return {
        position,
        shift,
      };
    }
  }

  return null;
}

/**
 * Return every configured shift as a flat array.
 *
 * Useful for admin dashboards, validation, exports, and Firestore
 * configuration checks.
 */
export function getAllShifts() {
  return VOLUNTEER_POSITIONS.flatMap(
    (position) =>
      position.shifts.map(
        (shift) => ({
          ...shift,
          positionId:
            position.id,
          positionName:
            position.name,
        })
      )
  );
}

/**
 * Normalizes a last name for reliable duplicate comparison.
 * Trims whitespace, lowercases, removes accents/diacritics,
 * and strips non-alphanumeric characters.
 */
export function normalizeLastName(name) {
  if (typeof name !== "string") {
    return "";
  }

  return name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .replace(
      /[^a-z0-9]/g,
      ""
    );
}

/**
 * Normalizes a first name for reliable identity comparison.
 * Trims whitespace, lowercases, removes accents/diacritics,
 * and strips non-alphanumeric characters.
 */
export function normalizeFirstName(name) {
  if (typeof name !== "string") {
    return "";
  }

  return name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .replace(
      /[^a-z0-9]/g,
      ""
    );
}

/**
 * Normalizes a phone number for reliable duplicate comparison.
 * Extracts digits only and standardizes standard 10-digit /
 * 11-digit (leading 1) numbers.
 */
export function normalizePhoneNumber(phone) {
  if (typeof phone !== "string") {
    return "";
  }

  const digits =
    phone.replace(/\D/g, "");

  if (
    digits.length === 11 &&
    digits.startsWith("1")
  ) {
    return digits.slice(1);
  }

  return digits;
}

/**
 * SHA-256 hash returned as lowercase hexadecimal.
 *
 * Used for the public Manage Registrations lookup key so the person's
 * last name and phone number are not placed directly into a URL or
 * Firestore document ID.
 */
export async function sha256Hex(value) {
  const text =
    String(value ?? "");

  const bytes =
    new TextEncoder().encode(text);

  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      bytes
    );

  return Array.from(
    new Uint8Array(digest)
  )
    .map(
      (byte) =>
        byte
          .toString(16)
          .padStart(2, "0")
    )
    .join("");
}

/**
 * Create the deterministic public Manage Registrations lookup ID.
 *
 * The lookup key is bound to the event so the same identity information
 * from another event cannot accidentally resolve to this event's records.
 */
export async function getRegistrationLookupId(
  lastName,
  phone,
  eventId = CONFIG.eventId
) {
  const normalizedLastName =
    normalizeLastName(
      lastName
    );

  const normalizedPhone =
    normalizePhoneNumber(
      phone
    );

  return sha256Hex(
    `${eventId}|${normalizedLastName}|${normalizedPhone}`
  );
}