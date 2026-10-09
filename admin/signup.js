import {
  firebaseConfig,
  db
} from "../firebase-init.js";

import {
  auth,
  getAdminProfile,
  isEnabledAdmin,
  isEnabledCheckinStaff,
  logout
} from "./auth.js";

import {
  initializeApp,
  deleteApp
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";

import {
  getAuth,
  createUserWithEmailAndPassword,
  deleteUser,
  signOut
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";

import {
  doc,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const form = document.getElementById("signup-form");
const emailInput = document.getElementById("email");
const nameInput = document.getElementById("displayName");
const passwordInput = document.getElementById("password");
const confirmPasswordInput = document.getElementById("confirmPassword");
const errorEl = document.getElementById("error");
const successEl = document.getElementById("success");
const submit = document.getElementById("submit");
const logoutButton = document.getElementById("logout");
const signedInAdminEl = document.getElementById("signed-in-admin");

let currentAdmin = null;
let redirecting = false;

function showError(message = "") {
  errorEl.textContent = message;
}

function showSuccess(message = "") {
  successEl.textContent = message;
}

function setBusy(isBusy) {
  submit.disabled = isBusy || !currentAdmin;
  submit.textContent = isBusy
    ? "Creating account…"
    : "Create Check-In Account";
}

logoutButton.addEventListener("click", logout);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError();
  showSuccess();

  if (!currentAdmin) {
    showError("An enabled administrator must be signed in to create a check-in account.");
    return;
  }

  const displayName = nameInput.value.trim();
  const email = emailInput.value.trim().toLowerCase();
  const password = passwordInput.value;
  const confirmPassword = confirmPasswordInput.value;

  if (!displayName || !email || password.length < 6) {
    showError("Enter a display name, valid email, and password of at least 6 characters.");
    return;
  }

  if (password !== confirmPassword) {
    showError("The passwords do not match.");
    return;
  }

  setBusy(true);

  let creatorApp = null;
  let creatorAuth = null;
  let createdUser = null;
  let profileCreated = false;

  try {
    // A secondary Firebase app creates the new account without signing the
    // current administrator out of the primary app.
    creatorApp = initializeApp(
      firebaseConfig,
      `checkin-account-creator-${Date.now()}`
    );
    creatorAuth = getAuth(creatorApp);

    const credential = await createUserWithEmailAndPassword(
      creatorAuth,
      email,
      password
    );
    createdUser = credential.user;

    // The primary Firestore instance remains authenticated as the administrator.
    // The rules authorize admins to provision the new user's restricted role.
    await setDoc(
      doc(db, "admins", createdUser.uid),
      {
        displayName,
        name: displayName,
        email,
        role: "checkin",
        status: "enabled",
        createdAt: serverTimestamp(),
        createdBy: currentAdmin.uid,
        createdByEmail: currentAdmin.email || "",
        createdVia: "admin_signup"
      }
    );

    profileCreated = true;
    passwordInput.value = "";
    confirmPasswordInput.value = "";
    showSuccess(
      `Account created and enabled for Check-In. Sign in at /admin/login.html using ${email}. The matching Firestore role record was created automatically.`
    );
  } catch (error) {
    console.error("[Diwali Check-In Signup] account creation failed:", {
      code: error?.code || "unknown"
    });

    // Avoid leaving an orphaned Authentication user if the role record could
    // not be created. This is safe because the account was just created here.
    if (createdUser && !profileCreated && creatorAuth) {
      try {
        await deleteUser(createdUser);
      } catch (cleanupError) {
        console.error("[Diwali Check-In Signup] cleanup failed:", {
          code: cleanupError?.code || "unknown"
        });
      }
    }

    const messages = {
      "auth/email-already-in-use": "An account with that email already exists. Use another email or sign in to the existing account.",
      "auth/invalid-email": "Enter a valid email address.",
      "auth/weak-password": "Choose a stronger password with at least 6 characters.",
      "permission-denied": "Firestore denied account provisioning. Confirm you are signed in as an enabled administrator and that the latest Firestore rules are deployed."
    };

    showError(
      messages[error?.code] ||
      (error?.code === "permission-denied"
        ? messages["permission-denied"]
        : "Account creation failed. Check the email, password, administrator access, and deployment status, then try again.")
    );
  } finally {
    if (creatorAuth) {
      try {
        await signOut(creatorAuth);
      } catch {}
    }

    if (creatorApp) {
      try {
        await deleteApp(creatorApp);
      } catch {}
    }

    setBusy(false);
  }
});

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";

onAuthStateChanged(auth, async (user) => {
  if (redirecting) return;

  if (!user) {
    redirecting = true;
    window.location.replace("/admin/login.html?returnTo=%2Fadmin%2Fsignup.html");
    return;
  }

  try {
    const profile = await getAdminProfile(user);

    if (isEnabledAdmin(profile)) {
      currentAdmin = user;
      signedInAdminEl.textContent = `Signed in as administrator: ${user.email || user.uid}`;
      setBusy(false);
      return;
    }

    if (isEnabledCheckinStaff(profile)) {
      redirecting = true;
      window.location.replace("/admin/checkin.html");
      return;
    }

    showError(
      "Only an enabled administrator can create check-in accounts. Sign in with an administrator account."
    );
    signedInAdminEl.textContent = "";
    submit.disabled = true;
  } catch (error) {
    console.error("[Diwali Check-In Signup] admin verification failed:", {
      code: error?.code || "unknown"
    });
    showError("Could not verify administrator access. Reload the page and try again.");
    submit.disabled = true;
  }
});
