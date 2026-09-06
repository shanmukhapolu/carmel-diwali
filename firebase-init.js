// ============================================================================
// firebase-init.js
//
// Firebase initialization, kept intentionally separate from UI logic
//  app.js). This module is responsible ONLY for:
//   - initializing the Firebase app
//   - exposing the Firestore instance and a couple of narrow helpers
//
// ----------------------------------------------------------------------------
// SECURITY NOTE: read before editing this file
// ----------------------------------------------------------------------------
// The Firebase web config below (apiKey, projectId, etc.) is NOT a secret.
// It identifies which Firebase project this client talks to, the same way a
// URL identifies a server. It is normal and expected for this object to be
// visible in frontend code / browser dev tools.
//
// Actual security comes from:
//   1. Firestore Security Rules (see firestore.rules); these are enforced
//      by Firebase's servers and cannot be bypassed by editing client code.
//   2. In production, a trusted backend (Cloud Function) that re-validates
//      everything the client claims before writing to Firestore.
//
// This file must NEVER contain:
//   - a Firebase Admin SDK / service-account key
//   - any secret used for server-side privileged access
// ============================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { getAnalytics, logEvent, isSupported as analyticsIsSupported } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-analytics.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

// Firebase web configuration for the "blood-drive-test" project. The Web API
// key is not a secret; see the security note above.

const firebaseConfig = {
  apiKey: "AIzaSyA31-qvxuiFPxBhhFcdmv7vgxH0l4Ehe5U",
  authDomain: "volunteerdiwali.firebaseapp.com",
  projectId: "volunteerdiwali",
  storageBucket: "volunteerdiwali.firebasestorage.app",
  messagingSenderId: "24394973552",
  appId: "1:24394973552:web:09cc6f81388ba04186cfb5",
  measurementId: "G-M77J7HX6L4"
};

export const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);

// Analytics is optional and may be unavailable (e.g. blocked by an ad
// blocker, or unsupported browser). Never let analytics failures break the
// registration flow.
let analyticsInstance = null;
analyticsIsSupported()
  .then((supported) => {
    if (supported) {
      analyticsInstance = getAnalytics(app);
    }
  })
  .catch(() => {
    analyticsInstance = null;
  });

// Allow-listed, non-PII event names only. Do NOT pass student names, emails,
// IDs, phone numbers, or dates of birth as event parameters; see PII
// protection requirements in README.md.
const ALLOWED_EVENTS = new Set([
  "blood_drive_form_started",
  "blood_drive_registration_success",
  "blood_drive_registration_error",
  "blood_drive_ineligible_blocked",
]);

/**
 * Logs a non-PII product analytics event. Silently ignores any event name
 * that is not explicitly allow-listed above, and silently no-ops if
 * analytics failed to initialize.
 * @param {string} eventName
 */
export function logSafeEvent(eventName) {
  if (!analyticsInstance || !ALLOWED_EVENTS.has(eventName)) return;
  try {
    logEvent(analyticsInstance, eventName);
  } catch (_err) {
    // Never let analytics errors surface to the student.
  }
}
