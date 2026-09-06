import {
  auth,
  getAdminProfile,
  UNAUTHORIZED
} from "./auth.js";

import {
  sendPasswordResetEmail,
  signInWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";

const form = document.getElementById("login-form");
const errorEl = document.getElementById("error");
const submit = document.getElementById("submit");
const forgot = document.getElementById("forgot");

function setBusy(isBusy) {
  submit.disabled = isBusy;
  submit.textContent = isBusy ? "Signing in…" : "Sign In";
}

function show(message = "") {
  errorEl.textContent = message;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  show();
  setBusy(true);

  try {
    const email = form.email.value.trim().toLowerCase();

    const credential = await signInWithEmailAndPassword(
      auth,
      email,
      form.password.value
    );

    const profile = await getAdminProfile(credential.user);

    if (!profile) {
      show(UNAUTHORIZED);
      setBusy(false);
      return;
    }

    window.location.replace("/admin/");
  } catch (error) {
    console.info("[Diwali Admin Login] sign in failed", {
      code: error?.code || "unknown"
    });

    show(
      "Sign-in failed. Check your email, password, and enabled admin profile."
    );

    setBusy(false);
  }
});

forgot.addEventListener("click", async () => {
  show();

  const email = form.email.value.trim().toLowerCase();

  if (!email) {
    show("Enter your email first, then choose forgot password.");
    return;
  }

  try {
    await sendPasswordResetEmail(auth, email);

    show(
      "Password reset email sent if that account exists."
    );
  } catch (error) {
    console.info("[Diwali Admin Login] password reset failed", {
      code: error?.code || "unknown"
    });

    show(
      "Password reset could not be started. Try again later."
    );
  }
});