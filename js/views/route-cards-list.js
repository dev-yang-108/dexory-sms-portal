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
  { key: "awaiting", label: "Awaiting quality" },
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
  if (activeFilter === "awaiting") return info.quality === "Awaiting quality";
  if (activeFilter === "progress") return info.result === "progress";
  return info.result === activeFilter;
}

function renderBody() {
  const body = document.getElementById("rc-body");
  if (!body) return;

  const byNo = new Map(allOrders.map((o) => [o.woNo, o]));
  const cards = allOrders
    .filter((o) => o.firstOff || o.firstOffRef)
    .map((o) => ({ wo: o, info: routeCardInfo(o) }))
    .filter((c) => matchesFilter(c.info))
    .sort((a, b) => (b.wo.updatedAt || 0) - (a.wo.updatedAt || 0));

  if (allOrders.every((o) => !o.firstOff && !o.firstOffRef)) {
    body.innerHTML = `<div class="empty-state">No route cards yet. Press New route card to start a first-off.</div>`;
    return;
  }
  if (cards.length === 0) {
    body.innerHTML = `<div class="empty-state">No route cards match this filter.</div>`;
    return;
  }

  body.innerHTML = `
    <div style="overflow-x:auto;">
      <table class="reject-table">
        <thead><tr><th>Route card</th><th>Part</th><th>Covers</th><th>Attempt</th><th>Result</th><th>Quality sign-off</th><th>Updated</th></tr></thead>
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
