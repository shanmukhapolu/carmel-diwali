import { app, db } from "../firebase-init.js";
import {
  getAuth,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

export const auth = getAuth(app);

export const UNAUTHORIZED =
  "Your account is not authorized to access the Carmel Diwali Festival volunteer administration area.";

export async function getAdminProfile(user) {
  if (!user?.uid) return null;

  const uidProfile = await readAdminDocument(user.uid);
  if (isEnabledRole(uidProfile)) return uidProfile;

  const email = normalizeEmail(user.email);
  if (!email) return null;

  const emailIdProfile = await readAdminDocument(email);
  if (isEnabledRole(emailIdProfile)) return emailIdProfile;

  return null;
}

async function readAdminDocument(adminId) {
  try {
    const snap = await getDoc(doc(db, "admins", adminId));

    return snap.exists()
      ? normalizeAdminProfile(snap.id, snap.data())
      : null;
  } catch (error) {
    console.info("[Diwali Admin Auth] admin document read failed", {
      adminId,
      code: error?.code || "unknown",
    });

    return null;
  }
}

function normalizeAdminProfile(id, data) {
  const role = String(data?.role || "none").toLowerCase();
  const status = String(data?.status || "disabled").toLowerCase();

  return {
    id,
    ...data,
    email: normalizeEmail(data?.email),
    role: ["admin", "checkin", "none"].includes(role)
      ? role
      : "none",
    status: status === "enabled" ? "enabled" : "disabled",
  };
}

export function isEnabledAdmin(profile) {
  return (
    profile?.role === "admin" &&
    profile.status === "enabled"
  );
}

export function isEnabledCheckin(profile) {
  return (
    profile?.role === "checkin" &&
    profile.status === "enabled"
  );
}

export function canUseCheckin(profile) {
  return (
    isEnabledAdmin(profile) ||
    isEnabledCheckin(profile)
  );
}

function isEnabledRole(profile) {
  return (
    isEnabledAdmin(profile) ||
    isEnabledCheckin(profile)
  );
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function finishAuthCheck() {
  document.body.classList.remove("admin-auth-checking");
  document.body.classList.add("admin-auth-ready");
}

export function requireAdmin({
  onReady,
  onDenied,
  allowCheckin = false,
  adminOnly = false,
} = {}) {
  return onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.replace("/admin/login.html");
      return;
    }

    try {
      const profile = await getAdminProfile(user);

      finishAuthCheck();

      if (!profile) {
        onDenied?.(UNAUTHORIZED);
        return;
      }

      // Pages that require full administrator privileges.
      if (adminOnly && !isEnabledAdmin(profile)) {
        window.location.replace("/admin/checkin.html");
        return;
      }

      // Pages that do not explicitly allow check-in staff
      // are restricted to full administrators.
      if (!allowCheckin && !isEnabledAdmin(profile)) {
        window.location.replace("/admin/checkin.html");
        return;
      }

      // Check-in pages can be accessed by either administrators
      // or staff with the dedicated check-in role.
      if (allowCheckin && !canUseCheckin(profile)) {
        onDenied?.(UNAUTHORIZED);
        return;
      }

      onReady?.(user, profile);
    } catch (error) {
      finishAuthCheck();

      console.info("[Diwali Admin Auth] authorization failed", {
        code: error?.code || "unknown",
        message: error?.message || String(error),
      });

      onDenied?.(
        "Authorization could not be verified. Please try again later."
      );
    }
  });
}

export async function logout() {
  await signOut(auth);
  window.location.replace("/admin/login.html");
}