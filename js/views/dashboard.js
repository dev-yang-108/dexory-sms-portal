/* Live dashboard: opened vs closed work orders, last week vs this week, plus
   the actual open/closed lists at a glance. Reached from a dedicated icon on
   the desktop nav rail - opens full-width in the main content area rather
   than crammed into the narrow rail itself. "Closed" here means an IDN was
   generated (the real-world completion/delivery event), not strictly the
   work order's own status flipping to Complete - a WO can be fully
   delivered in several IDNs before it ever shows Complete. */

import { esc, mount, setViewCleanup } from "../render.js";
import { subscribeWorkOrders, subscribeIdns, subscribeRecentBookIns, remainingQty } from "../db.js";
import { dxNavHTML, wireSectionNav } from "../section-nav.js";
import { navigate } from "../../app.js";

// How far back the "Stock added" graph looks - "2 to 3 months" per how this
// was scoped, so 90 days (~13 weeks).
const STOCK_ADDED_DAYS = 90;

let woUnsub = null;
let idnUnsub = null;
let bookInUnsub = null;
let allOrders = [];
let allIdns = [];
let allBookIns = [];

export function renderDashboardView() {
  if (woUnsub) woUnsub();
  if (idnUnsub) idnUnsub();
  if (bookInUnsub) bookInUnsub();

  mount(`
    <div class="dx-app">
      ${dxNavHTML("dashboard")}
      <div class="dx-main">
        <div class="dx-content" style="max-width:1200px;">
          <div class="dash-title">Dashboard</div>
          <div class="dash-sub">Live - updates as work orders and IDNs change.</div>
          <div id="dash-body"><div class="empty-state">Loading…</div></div>
        </div>
      </div>
    </div>
  `);

  wireSectionNav();

  const refresh = () => renderDashboard(allOrders, allIdns, allBookIns);
  woUnsub = subscribeWorkOrders((orders) => {
    allOrders = orders;
    refresh();
  });
  idnUnsub = subscribeIdns((idns) => {
    allIdns = idns;
    refresh();
  });
  bookInUnsub = subscribeRecentBookIns(STOCK_ADDED_DAYS, (bookIns) => {
    allBookIns = bookIns;
    refresh();
  });

  setViewCleanup(() => {
    if (woUnsub) woUnsub();
    if (idnUnsub) idnUnsub();
    if (bookInUnsub) bookInUnsub();
    woUnsub = null;
    idnUnsub = null;
    bookInUnsub = null;
  });
}

// Monday 00:00 of the week containing `ts`.
function startOfWeek(ts) {
  const d = new Date(ts);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function countInRange(items, field, start, end) {
  return items.filter((i) => {
    const t = i[field] || 0;
    return t >= start && t < end;
  }).length;
}

function renderDashboard(orders, idns, bookIns) {
  const body = document.getElementById("dash-body");
  if (!body) return;

  const now = Date.now();
  const thisWeekStart = startOfWeek(now);
  const lastWeekStart = thisWeekStart - 7 * 86400000;
  const nextWeekStart = thisWeekStart + 7 * 86400000;

  const openedLastWeek = countInRange(orders, "createdAt", lastWeekStart, thisWeekStart);
  const openedThisWeek = countInRange(orders, "createdAt", thisWeekStart, nextWeekStart);

  const liveIdns = idns.filter((i) => !i.voided);
  const closedLastWeek = countInRange(liveIdns, "createdAt", lastWeekStart, thisWeekStart);
  const closedThisWeek = countInRange(liveIdns, "createdAt", thisWeekStart, nextWeekStart);

  // Outstanding work - Open or Issued. Complete/Cancelled aren't "open" by
  // any reading of the word.
  const openOrders = orders
    .filter((wo) => wo.status === "Open" || wo.status === "Issued")
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const closedThisWeekIdns = liveIdns.filter((i) => (i.createdAt || 0) >= thisWeekStart).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  body.innerHTML = `
    <div class="compare-row">
      ${compareCard("Work orders opened", openedLastWeek, openedThisWeek, "var(--blue)", "rgba(86,49,234,.25)")}
      ${compareCard("Work orders closed (IDN completed)", closedLastWeek, closedThisWeek, "var(--green)", "rgba(46,139,87,.25)")}
    </div>

    <div class="section-row"><h3>Stock added</h3><span class="count">last ${STOCK_ADDED_DAYS} days</span></div>
    ${stockAddedWeeklyHTML(bookIns)}

    <div class="section-row"><h3>Open work orders</h3><span class="count">${openOrders.length} open</span></div>
    <div class="card-grid" id="dash-open-grid">${woCardsHTML(openOrders, false)}</div>

    <div class="section-row"><h3>Closed this week</h3><span class="count">${closedThisWeekIdns.length} closed</span></div>
    <div class="card-grid" id="dash-closed-grid">${idnCardsHTML(closedThisWeekIdns)}</div>
  `;

  body.querySelectorAll("[data-wo]").forEach((el) => {
    el.onclick = () => navigate("#/work-orders/" + encodeURIComponent(el.dataset.wo));
  });
  body.querySelectorAll("[data-idn]").forEach((el) => {
    el.onclick = () => navigate("#/idns/" + encodeURIComponent(el.dataset.idn));
  });
}

/*
  Groups book-in transactions (any part, any area) by week for a simple
  "is stock coming in at the usual rate" glance - reuses the bar-row/
  bar-track/bar-fill styling already built for the rejection report so this
  reads as the same kind of bar list, not a second visual language.
*/
function stockAddedWeeklyHTML(bookIns) {
  if (bookIns.length === 0) return `<div class="empty-state">No stock booked in in this window yet.</div>`;

  const byWeek = new Map();
  bookIns.forEach((tx) => {
    const weekStart = startOfWeek(tx.timestamp);
    byWeek.set(weekStart, (byWeek.get(weekStart) || 0) + (tx.qty || 0));
  });

  const weeks = Array.from(byWeek.entries())
    .sort((a, b) => b[0] - a[0])
    .slice(0, 13);
  const max = Math.max(...weeks.map((w) => w[1]), 1);

  return weeks
    .map(([weekStart, qty]) => {
      const label = new Date(weekStart).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      return `
        <div class="bar-row">
          <div class="bar-label">w/c ${esc(label)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.max(Math.round((qty / max) * 100), 4)}%;background:var(--green);"></div></div>
          <div class="bar-val">${qty} pcs</div>
        </div>
      `;
    })
    .join("");
}

function compareCard(title, lastVal, thisVal, barColor, barColorDim) {
  const max = Math.max(lastVal, thisVal, 1);
  const lastH = Math.round((lastVal / max) * 100);
  const thisH = Math.round((thisVal / max) * 100);
  let deltaHTML;
  if (lastVal === 0) {
    deltaHTML = thisVal > 0 ? `<span class="compare-delta up">▲ new</span>` : "";
  } else {
    const pct = Math.round(((thisVal - lastVal) / lastVal) * 100);
    const cls = pct >= 0 ? "up" : "down";
    const arrow = pct >= 0 ? "▲" : "▼";
    deltaHTML = `<span class="compare-delta ${cls}">${arrow} ${pct >= 0 ? "+" : ""}${pct}%</span>`;
  }
  return `
    <div class="compare-card">
      <div class="compare-title">${esc(title)}</div>
      <div class="compare-bars">
        <div class="compare-col"><div class="compare-val">${lastVal}</div><div class="compare-bar" style="height:${Math.max(lastH, 4)}%;background:${barColorDim};"></div></div>
        <div class="compare-col"><div class="compare-val">${thisVal}</div><div class="compare-bar" style="height:${Math.max(thisH, 4)}%;background:${barColor};"></div></div>
      </div>
      <div style="display:flex;gap:24px;">
        <div class="compare-label" style="width:60px;text-align:center;">Last week</div>
        <div class="compare-label" style="width:60px;text-align:center;">This week ${deltaHTML}</div>
      </div>
    </div>
  `;
}

function woCardsHTML(orders, closed) {
  if (orders.length === 0) return `<div class="empty-state">Nothing here right now.</div>`;
  return orders
    .map(
      (wo) => `
      <div class="wo-card ${closed ? "closed" : ""}" data-wo="${esc(wo.woNo)}">
        <div class="wo-card-top">
          <div class="wo-card-no">${esc(wo.woNo)}</div>
          <div class="wo-card-qty">${remainingQty(wo)}</div>
        </div>
        <div class="wo-card-part">${esc(wo.partNo)}</div>
      </div>
    `
    )
    .join("");
}

function idnCardsHTML(idns) {
  if (idns.length === 0) return `<div class="empty-state">Nothing closed this week yet.</div>`;
  return idns
    .map(
      (idn) => `
      <div class="wo-card closed" data-idn="${esc(idn.idnNo)}">
        <div class="wo-card-top">
          <div class="wo-card-no">${esc(idn.woNo)}</div>
          <div class="wo-card-qty">${esc(idn.qty)}</div>
        </div>
        <div class="wo-card-part">${esc(idn.partNo)}</div>
      </div>
    `
    )
    .join("");
}
