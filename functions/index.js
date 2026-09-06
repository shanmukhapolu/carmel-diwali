const { onDocumentDeleted } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();

/**
 * Keeps volunteer shift availability synchronized with registrations.
 *
 * When an organizer deletes a volunteer registration from Firestore, this
 * trigger decrements the matching non-PII shift counter so that the public
 * signup form immediately shows the reopened spot.
 */
exports.releaseShiftOnRegistrationDelete = onDocumentDeleted(
  "registrations/{registrationId}",
  async (event) => {
    const deletedRegistration = event.data?.data();

    if (!deletedRegistration) return;

    const { eventId, shiftId } = deletedRegistration;

    if (
      typeof eventId !== "string" ||
      typeof shiftId !== "string"
    ) {
      logger.warn(
        "Deleted registration missing shift metadata",
        {
          registrationId: event.params.registrationId,
        }
      );
      return;
    }

    const shiftRef = admin
      .firestore()
      .doc(`shiftCounts/${eventId}_${shiftId}`);

    await admin.firestore().runTransaction(async (tx) => {
      const shiftSnap = await tx.get(shiftRef);

      if (!shiftSnap.exists) {
        logger.warn(
          "Shift counter missing while releasing deleted registration",
          {
            registrationId: event.params.registrationId,
            eventId,
            shiftId,
          }
        );
        return;
      }

      const currentCount = shiftSnap.get("count");

      if (typeof currentCount !== "number") {
        logger.warn(
          "Shift counter count is not numeric while releasing deleted registration",
          {
            registrationId: event.params.registrationId,
            eventId,
            shiftId,
          }
        );
        return;
      }

      tx.update(shiftRef, {
        count: Math.max(0, currentCount - 1),
      });
    });
  }
);