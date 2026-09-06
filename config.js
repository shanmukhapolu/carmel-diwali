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
    description: "Help prepare Carter Green and the festival area before the event.",
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
    description: "Assist festival vendors with setup and event-day needs.",
    shifts: [
      {
        id: "vendor-assistant-1300-1430",
        startTime: "1300",
        endTime: "1430",
        capacity: 10,
      },
      {
        id: "vendor-assistant-1430-1600",
        startTime: "1430",
        endTime: "1600",
        capacity: 10,
      },
    ],
  },

  {
    id: "event-runner-general-support",
    name: "Event Runner / General Support",
    description: "Provide general support and help with event operations as needed.",
    shifts: [
      {
        id: "event-runner-1530-1700",
        startTime: "1530",
        endTime: "1700",
        capacity: 10,
      },
      {
        id: "event-runner-1700-1830",
        startTime: "1700",
        endTime: "1830",
        capacity: 10,
      },
      {
        id: "event-runner-1830-2000",
        startTime: "1830",
        endTime: "2000",
        capacity: 10,
      },
      {
        id: "event-runner-2000-2100",
        startTime: "2000",
        endTime: "2100",
        capacity: 10,
      },
    ],
  },

  {
    id: "swagat-committee",
    name: "Swagat Committee",
    description: "Help welcome and guide guests during the festival.",
    shifts: [
      {
        id: "swagat-committee-1600-1730",
        startTime: "1600",
        endTime: "1730",
        capacity: 10,
      },
    ],
  },

  {
    id: "laddoo-distribution",
    name: "Laddoo Distribution",
    description: "Assist with organizing and distributing laddoos to festival attendees.",
    shifts: [
      {
        id: "laddoo-distribution-1600-1730",
        startTime: "1600",
        endTime: "1730",
        capacity: 10,
      },
    ],
  },

  {
    id: "rangoli-crew",
    name: "Rangoli Crew",
    description: "Help with the festival's rangoli area and related activities.",
    shifts: [
      {
        id: "rangoli-crew-1600-1800",
        startTime: "1600",
        endTime: "1800",
        capacity: 10,
      },
    ],
  },

  {
    id: "back-stage",
    name: "Back Stage",
    description: "Assist with backstage coordination for festival performances.",
    shifts: [
      {
        id: "back-stage-1600-1800",
        startTime: "1600",
        endTime: "1800",
        capacity: 10,
      },
      {
        id: "back-stage-1800-2000",
        startTime: "1800",
        endTime: "2000",
        capacity: 10,
      },
      {
        id: "back-stage-2000-2130",
        startTime: "2000",
        endTime: "2130",
        capacity: 10,
      },
    ],
  },

  {
    id: "diya-distribution",
    name: "Diya Distribution",
    description: "Help distribute diyas to festival attendees throughout the evening.",
    shifts: [
      {
        id: "diya-distribution-1600-1730",
        startTime: "1600",
        endTime: "1730",
        capacity: 10,
      },
      {
        id: "diya-distribution-1730-1830",
        startTime: "1730",
        endTime: "1830",
        capacity: 10,
      },
      {
        id: "diya-distribution-1830-1930",
        startTime: "1830",
        endTime: "1930",
        capacity: 10,
      },
      {
        id: "diya-distribution-1930-2030",
        startTime: "1930",
        endTime: "2030",
        capacity: 10,
      },
      {
        id: "diya-distribution-2030-2130",
        startTime: "2030",
        endTime: "2130",
        capacity: 10,
      },
    ],
  },

  {
    id: "teardown-cleanup",
    name: "Tear Down & Clean Up",
    description: "Help clean and restore the festival area after the event.",
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
  const hour = Number(hhmm.slice(0, 2));
  const minute = Number(hhmm.slice(2));

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
  const hour24 = Number(hhmm.slice(0, 2));
  const minute = Number(hhmm.slice(2));

  const period = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

/**
 * Format a shift as a readable range.
 *
 * Example:
 *   "1100" → "1300"
 *   becomes "11:00 AM – 1:00 PM"
 */
export function formatShiftTime(startTime, endTime) {
  return `${formatTime(startTime)} – ${formatTime(endTime)}`;
}

/**
 * Find a position by its ID.
 */
export function getPositionById(positionId) {
  return VOLUNTEER_POSITIONS.find(
    (position) => position.id === positionId
  );
}

/**
 * Find a shift by position ID and shift ID.
 */
export function getShiftById(positionId, shiftId) {
  const position = getPositionById(positionId);

  if (!position) {
    return null;
  }

  return position.shifts.find((shift) => shift.id === shiftId) || null;
}

/**
 * Find a shift and its parent position from a shift ID.
 */
export function findShift(shiftId) {
  for (const position of VOLUNTEER_POSITIONS) {
    const shift = position.shifts.find(
      (candidate) => candidate.id === shiftId
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
  return VOLUNTEER_POSITIONS.flatMap((position) =>
    position.shifts.map((shift) => ({
      ...shift,
      positionId: position.id,
      positionName: position.name,
    }))
  );
}
