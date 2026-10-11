// Reuse the protected account-provisioning flow in the Staff modal.
import "./signup.js";

import { CONFIG } from "../config.js";
import { db } from "../firebase-init.js";
import { requireAdmin, isEnabledAdmin } from "./auth.js";
import {
  collection,
  getDocs
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
let accounts = [];

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function eventDateLabel(value) {
  const parts = String(value || "").split("-").map(Number);
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "long", day: "numeric", year: "numeric"
  }).format(new Date(parts[0], parts[1] - 1, parts[2]));
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function accountFromDocument(snapshot) {
  const data = snapshot.data() || {};
  const role = String(data.role || "none").trim().toLowerCase();
  if (role !== "admin" && role !== "checkin") return null;

  const email = normalizeEmail(data.email || (snapshot.id.includes("@") ? snapshot.id : ""));
  const fullName = [data.firstName, data.lastName].filter(Boolean).join(" ").trim();
  const displayName = String(data.displayName || data.name || fullName || email || snapshot.id).trim();
  const status = String(data.status || "disabled").trim().toLowerCase() === "enabled"
    ? "enabled"
    : "disabled";
  const createdAt = data.createdAt?.toDate && typeof data.createdAt.toDate === "function"
    ? data.createdAt.toDate()
    : null;

  return { id: snapshot.id, displayName, email, role, status, createdAt };
}

function deduplicateAccounts(source) {
  const byEmail = new Map();
  source.forEach((account) => {
    const key = account.email || "id:" + account.id;
    const existing = byEmail.get(key);
    const preference = (item) =>
      (item.status === "enabled" ? 10 : 0) +
      (item.email && item.id !== item.email ? 2 : 0);
    if (!existing || preference(account) > preference(existing)) byEmail.set(key, account);
  });

  return Array.from(byEmail.values()).sort((a, b) => {
    if (a.status !== b.status) return a.status === "enabled" ? -1 : 1;
    if (a.role !== b.role) return a.role === "admin" ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });
}

function makeMessage(message) {
  const element = document.createElement("p");
  element.className = "muted";
  element.textContent = message;
  return element;
}

function makeBadge(label, className) {
  const badge = document.createElement("span");
  badge.className = "badge" + (className ? " " + className : "");
  badge.textContent = label;
  return badge;
}

function renderStaffList() {
  const root = $("staff-list");
  if (!root) return;

  const search = String($("staff-search")?.value || "").trim().toLowerCase();
  const filtered = accounts.filter((account) =>
    [account.displayName, account.email, account.role, account.status]
      .join(" ")
      .toLowerCase()
      .includes(search)
  );
  const enabled = accounts.filter((account) => account.status === "enabled").length;
  setText(
    "staff-count",
    filtered.length + (filtered.length === 1 ? " person shown" : " people shown") +
      " · " + enabled + " enabled of " + accounts.length
  );

  root.replaceChildren();
  if (!filtered.length) {
    root.appendChild(makeMessage(
      accounts.length ? "No staff accounts match this search." : "No administrator or check-in accounts were found."
    ));
    return;
  }

  const fragment = document.createDocumentFragment();
  filtered.forEach((account) => {
    const card = document.createElement("article");
    card.className = "staff-account-card";

    const identity = document.createElement("div");
    identity.className = "staff-account-identity";
    const name = document.createElement("h3");
    name.textContent = account.displayName;
    const email = document.createElement("p");
    email.className = "staff-account-email";
    email.textContent = account.email || "Email not recorded";
    identity.append(name, email);

    const details = document.createElement("div");
    details.className = "staff-account-details";
    details.appendChild(makeBadge(
      account.role === "admin" ? "Administrator" : "Check-In staff",
      account.role === "checkin" ? "warn" : ""
    ));
    details.appendChild(makeBadge(
      account.status === "enabled" ? "Enabled" : "Disabled",
      account.status === "enabled" ? "ok" : "bad"
    ));

    const created = document.createElement("span");
    created.className = "staff-account-created";
    created.textContent = account.createdAt
      ? "Added " + new Intl.DateTimeFormat("en-US", {
          month: "short", day: "numeric", year: "numeric"
        }).format(account.createdAt)
      : "Date added not recorded";
    details.appendChild(created);

    card.append(identity, details);
    fragment.appendChild(card);
  });
  root.appendChild(fragment);
}

async function loadStaffAccounts() {
  setText("staff-error", "");
  $("staff-refresh").disabled = true;
  $("staff-refresh").textContent = "Refreshing…";
  setText("staff-count", "Loading staff accounts…");
  $("staff-list").replaceChildren(makeMessage("Loading staff accounts…"));

  try {
    const snapshot = await getDocs(collection(db, "admins"));
    accounts = deduplicateAccounts(snapshot.docs.map(accountFromDocument).filter(Boolean));
    renderStaffList();
  } catch (error) {
    console.error("[Diwali Staff] account list could not load:", {
      code: error?.code || "unknown"
    });
    accounts = [];
    $("staff-list").replaceChildren();
    setText(
      "staff-error",
      error?.code === "permission-denied"
        ? "Access denied while loading staff. Sign in with an enabled administrator account."
        : "Could not load staff accounts. Refresh the page and try again."
    );
    setText("staff-count", "Staff list unavailable");
  } finally {
    $("staff-refresh").disabled = false;
    $("staff-refresh").textContent = "Refresh";
  }
}

$("staff-search")?.addEventListener("input", renderStaffList);
$("staff-refresh")?.addEventListener("click", loadStaffAccounts);
$("staff-add")?.addEventListener("click", () => {
  setText("error", "");
  setText("success", "");
  $("signup-form")?.reset();
  const modal = $("staff-modal");
  modal?.classList.remove("hidden");
  modal?.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  $("displayName")?.focus();
});

function closeStaffModal() {
  const modal = $("staff-modal");
  modal?.classList.add("hidden");
  modal?.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

$("staff-modal-close")?.addEventListener("click", closeStaffModal);
$("staff-cancel")?.addEventListener("click", closeStaffModal);
$("staff-modal")?.addEventListener("click", (event) => {
  if (event.target === $("staff-modal")) closeStaffModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("staff-modal").classList.contains("hidden")) closeStaffModal();
});

window.addEventListener("diwali:staff-account-created", async (event) => {
  closeStaffModal();
  setText("staff-success", event.detail?.message || "Staff account created and enabled.");
  $("signup-form")?.reset();
  await loadStaffAccounts();
});

requireAdmin({
  onReady: (user, profile) => {
    if (!isEnabledAdmin(profile)) {
      window.location.replace("/admin/checkin.html");
      return;
    }
    setText("admin-email", user.email || profile.displayName || user.uid);
    setText(
      "event-meta",
      [CONFIG.eventName, eventDateLabel(CONFIG.eventDate), CONFIG.location]
        .filter(Boolean)
        .join(" • ")
    );
    loadStaffAccounts();
  },
  onDenied: (message) => {
    setText("staff-error", message);
    $("staff-add").disabled = true;
  }
});
