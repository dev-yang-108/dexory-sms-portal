/* Small shared render helpers. */

export function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The app registers the portal shell here (app.js) so every view gets the
// sidebar and top bar without importing it - and without a circular import.
let afterMount = null;

export function setMountHook(fn) {
  afterMount = fn;
}

export function mount(html) {
  document.getElementById("app").innerHTML = html;
  if (afterMount) afterMount();
}

/*
  Views that subscribe to Firestore (list, detail) must stop listening once
  the user navigates away, or a snapshot arriving after that crashes trying
  to update DOM elements the current view already replaced.
*/
let currentViewCleanup = null;

export function setViewCleanup(fn) {
  currentViewCleanup = fn;
}

export function runViewCleanup() {
  if (currentViewCleanup) {
    currentViewCleanup();
    currentViewCleanup = null;
  }
}

export function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

export function formatNum(v) {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v !== "number") return v;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export function formatDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
