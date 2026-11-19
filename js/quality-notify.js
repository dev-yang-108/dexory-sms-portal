/* The quality "notification": a live count of route cards the machine shop has
   sent to quality and nobody has signed off yet. It drives the red number on
   Route cards in the sidebar, and a banner that pops up when a new card
   arrives while the app is open (click it to open that card).

   There is no sign-in yet, so this is the same for everyone who opens the app,
   not a private message to one person. It starts once, on the first page that
   gets the portal shell, and keeps running across page changes. */

import { subscribeWorkOrders } from "./db.js";
import { qualityState } from "./first-off.js";
import { esc } from "./render.js";
import { navigate } from "../app.js";

let started = false;
let waitingNos = [];
let seen = null; // woNos already known to be waiting; null until the first snapshot
let bannerTimer = null;

export function waitingCount() {
  return waitingNos.length;
}

function paintBadges() {
  document.querySelectorAll("[data-rc-badge]").forEach((el) => {
    el.textContent = String(waitingNos.length);
    el.hidden = waitingNos.length === 0;
  });
}

function showBanner(wo) {
  const old = document.getElementById("dx-notice");
  if (old) old.remove();
  clearTimeout(bannerTimer);
  const sent = wo.firstOff.sentToQuality;
  const el = document.createElement("div");
  el.id = "dx-notice";
  el.className = "dx-notice";
  el.innerHTML = `
    <button class="dx-notice-main" type="button">
      <b>${esc(wo.woNo)}</b> was sent to quality${sent && sent.by ? " by " + esc(sent.by) : ""}${sent && sent.partial ? " (partial check)" : ""}. Open card
    </button>
    <button class="dx-notice-x" type="button" aria-label="Dismiss">&times;</button>`;
  document.body.appendChild(el);
  el.querySelector(".dx-notice-main").onclick = () => {
    el.remove();
    navigate("#/route-cards/" + encodeURIComponent(wo.woNo));
  };
  el.querySelector(".dx-notice-x").onclick = () => el.remove();
  bannerTimer = setTimeout(() => el.remove(), 20000);
}

export function startQualityNotify() {
  if (started) return;
  started = true;
  subscribeWorkOrders((orders) => {
    const waiting = orders.filter((o) => o.firstOff && qualityState(o) === "waiting");
    waitingNos = waiting.map((o) => o.woNo);
    paintBadges();
    if (seen) {
      // A card that wasn't waiting before is new: tell them.
      waiting.filter((o) => !seen.has(o.woNo)).slice(0, 1).forEach(showBanner);
    }
    seen = new Set(waitingNos);
  });
}

// Re-applies the current count after a page draws a fresh sidebar.
export function refreshQualityBadges() {
  paintBadges();
}
