/* Route cards: every first-off inspection record, whichever work order holds
   it (or is covered by one). Filter by where each card stands, open one to
   fill it in or have quality review it. */

import { esc, mount, setViewCleanup, formatDate } from "../render.js";
import { subscribeWorkOrders } from "../db.js";
import { dxNavHTML, wireSectionNav } from "../section-nav.js";
import { routeCardInfo, FIRST_OFF_LABELS } from "../first-off.js";
import { navigate } from "../../app.js";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "progress", label: "In progress" },
  { key: "awaiting", label: "Waiting for quality" },
  { key: "signed", label: "Signed off" },
  { key: "rework", label: "Rework" },
  { key: "fail", label: "Failed" },
  { key: "pass", label: "Passed" }
];

let unsub = null;
let allOrders = [];
let activeFilter = "all";

export function renderRouteCardsListView() {
  if (unsub) unsub();

  mount(`
    <div class="dx-app">
      ${dxNavHTML("route-cards")}
      <div class="dx-main">
        <div class="dx-content">
          <div class="rc-head">
            <div>
              <div class="dash-title">Route cards</div>
              <div class="dash-sub">First-off inspection records. The machine shop fills them in, quality signs each card off.</div>
            </div>
            <button class="btn primary-lime" id="rc-new">New route card</button>
          </div>
          <div class="chip-row" id="rc-filters">
            ${FILTERS.map((f) => `<button class="chip-toggle ${f.key === activeFilter ? "is-active" : ""}" data-filter="${f.key}">${f.label}</button>`).join("")}
          </div>
          <div class="rc-dates">
            <span class="rc-dates-label">Date</span>
            <span class="chip-row" id="rc-ranges" style="padding:0;">
              ${RANGES.map((r) => `<button class="chip-toggle ${r.key === activeRange ? "is-active" : ""}" data-range="${r.key}">${r.label}</button>`).join("")}
            </span>
            <span id="rc-custom" ${activeRange === "custom" ? "" : "hidden"}>
              <input type="date" id="rc-from" value="${customFrom}" aria-label="From date" /> to
              <input type="date" id="rc-to" value="${customTo}" aria-label="To date" />
            </span>
          </div>
          <div id="rc-body" style="padding:8px 16px 16px;"><div class="empty-state">Loading…</div></div>
        </div>
      </div>
    </div>
  `);

  wireSectionNav();
  document.getElementById("rc-new").onclick = () => navigate("#/route-cards/new");
  document.querySelectorAll("#rc-filters [data-filter]").forEach((btn) => {
    btn.onclick = () => {
      activeFilter = btn.dataset.filter;
      document.querySelectorAll("#rc-filters [data-filter]").forEach((b) => b.classList.toggle("is-active", b === btn));
      renderBody();
    };
  });

  document.querySelectorAll("#rc-ranges [data-range]").forEach((btn) => {
    btn.onclick = () => {
      activeRange = btn.dataset.range;
      document.querySelectorAll("#rc-ranges [data-range]").forEach((b) => b.classList.toggle("is-active", b === btn));
      document.getElementById("rc-custom").hidden = activeRange !== "custom";
      renderBody();
    };
  });
  document.getElementById("rc-from").onchange = (e) => {
    customFrom = e.target.value;
    renderBody();
  };
  document.getElementById("rc-to").onchange = (e) => {
    customTo = e.target.value;
    renderBody();
  };

  unsub = subscribeWorkOrders((orders) => {
    allOrders = orders;
    renderBody();
  });
  setViewCleanup(() => {
    if (unsub) unsub();
    unsub = null;
  });
}

function matchesFilter(info) {
  if (activeFilter === "all") return true;
  if (activeFilter === "awaiting") return info.state === "waiting";
  if (activeFilter === "signed") return info.state === "signed";
  if (activeFilter === "progress") return info.result === "progress";
  return info.result === activeFilter;
}

// A card's date is when its first attempt started (a covered order uses its
// own last update). The range works on whole days in the user's own time zone.
const DAY = 86400000;
const startOfDay = (t) => new Date(new Date(t).getFullYear(), new Date(t).getMonth(), new Date(t).getDate()).getTime();
let activeRange = "all";
let customFrom = "";
let customTo = "";

function cardDate(wo) {
  const a = wo.firstOff && wo.firstOff.attempts && wo.firstOff.attempts[0];
  return (a && a.startedAt) || wo.updatedAt || 0;
}

function inRange(wo) {
  if (activeRange === "all") return true;
  const t = cardDate(wo);
  const today = startOfDay(Date.now());
  if (activeRange === "today") return t >= today;
  if (activeRange === "7") return t >= today - 6 * DAY;
  if (activeRange === "30") return t >= today - 29 * DAY;
  const from = customFrom ? startOfDay(customFrom.replace(/-/g, "/")) : 0;
  const to = customTo ? startOfDay(customTo.replace(/-/g, "/")) + DAY : Infinity;
  return t >= from && t < to;
}

const RANGES = [
  { key: "all", label: "All time" },
  { key: "today", label: "Today" },
  { key: "7", label: "Last 7 days" },
  { key: "30", label: "Last 30 days" },
  { key: "custom", label: "Pick dates" }
];

function renderBody() {
  const body = document.getElementById("rc-body");
  if (!body) return;

  const byNo = new Map(allOrders.map((o) => [o.woNo, o]));
  const cards = allOrders
    .filter((o) => o.firstOff || o.firstOffRef)
    .map((o) => ({ wo: o, info: routeCardInfo(o) }))
    .filter((c) => matchesFilter(c.info) && inRange(c.wo))
    .sort((a, b) => (b.wo.updatedAt || 0) - (a.wo.updatedAt || 0));

  if (allOrders.every((o) => !o.firstOff && !o.firstOffRef)) {
    body.innerHTML = `<div class="empty-state">No route cards yet. Press New route card to start a first-off.</div>`;
    return;
  }
  if (cards.length === 0) {
    body.innerHTML = `<div class="empty-state">No route cards match these filters${activeRange === "all" ? "" : " in this date range"}.</div>`;
    return;
  }

  body.innerHTML = `
    <div style="overflow-x:auto;">
      <table class="reject-table">
        <thead><tr><th>Route card</th><th>Part</th><th>Covers</th><th>Attempt</th><th>Result</th><th>Quality sign-off</th><th>Started</th><th>Updated</th></tr></thead>
        <tbody>
          ${cards
            .map(({ wo, info }) => {
              const target = wo.firstOff ? wo.woNo : wo.firstOffRef;
              const covered = wo.firstOff ? [wo, ...(wo.firstOff.covers || []).map((n) => byNo.get(n)).filter(Boolean)] : [];
              const coversText = wo.firstOff
                ? `${covered.length} order${covered.length === 1 ? "" : "s"} · ${covered.reduce((s, o) => s + (o.qty || 0), 0)} pcs`
                : `Covered by ${esc(wo.firstOffRef)}`;
              const resultTone = { pass: "ok", rework: "warn", fail: "bad" }[info.result] || "";
              return `
                <tr data-open="${esc(target)}" style="cursor:pointer;">
                  <td class="mono">${esc(wo.woNo)}</td>
                  <td>${esc(wo.partNo)} · R${esc(wo.rev)}</td>
                  <td>${coversText}</td>
                  <td>${info.attempt || "—"}</td>
                  <td><span class="rc-chip ${resultTone}">${esc(FIRST_OFF_LABELS[info.result] || info.result)}</span></td>
                  <td><span class="rc-chip ${info.tone}">${esc(info.quality)}</span></td>
                  <td>${esc(formatDate(cardDate(wo)))}</td>
                  <td>${esc(formatDate(wo.updatedAt))}</td>
                </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
  body.querySelectorAll("tr[data-open]").forEach((row) => {
    row.onclick = () => navigate("#/route-cards/" + encodeURIComponent(row.dataset.open));
  });
}
