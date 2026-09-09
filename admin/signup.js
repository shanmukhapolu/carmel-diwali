import { auth } from "./auth.js";
import { db } from "../firebase-init.js";

import {
  createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";

import {
  doc,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const form = document.getElementById("signup-form");
const errorEl = document.getElementById("error");
const submit = document.getElementById("submit");

function show(message = "") {
  errorEl.textContent = message;
}

function setBusy(isBusy) {
  submit.disabled = isBusy;
  submit.textContent = isBusy
    ? "Creating…"
    : "Create Account";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  show();
  setBusy(true);

  try {
    const displayName = form.displayName?.value.trim() || "";
    const email = form.email.value.trim().toLowerCase();

    const credential = await createUserWithEmailAndPassword(
      auth,
      email,
      form.password.value
    );

    await setDoc(
      doc(db, "admins", credential.user.uid),
      {
        displayName,
        name: displayName,
        email,
        role: "none",
        status: "disabled",
        createdAt: serverTimestamp(),
      }
    );

    show(
      "Account created. An enabled administrator must set your role and status in Firebase before this account can access the volunteer administration system."
    );
  } catch (error) {
    console.info("[Diwali Admin Signup] setup failed", {
      code: error?.code || "unknown",
    });

    show(
      "Account setup failed. Make sure the email and password are valid."
    );
  } finally {
    setBusy(false);
  }
});