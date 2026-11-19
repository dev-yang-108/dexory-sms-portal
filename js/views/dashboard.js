/* Live dashboard: this calendar week's opened/closed work orders, low stock
   and rejects as tiles, a "needs attention" list, stock added by week, and
   the open/closed lists. Reached from a dedicated icon on the desktop nav
   rail - opens full-width in the main content area rather than crammed into
   the narrow rail itself. "Closed" here means an IDN was generated (the
   real-world completion/delivery event), not strictly the work order's own
   status flipping to Complete - a WO can be fully delivered in several IDNs
   before it ever shows Complete. */

import { esc, mount, setViewCleanup } from "../render.js";
import {
  subscribeWorkOrders,
  subscribeIdns,
  subscribeRecentBookIns,
  subscribeStockItems,
  remainingQty,
  completedQtyOf,
  isLowStock,
  cyclesRemaining,
  hasNegativeStock,
  dueDateStatus,
  dueDateOf
} from "../db.js";
import { dxNavHTML, wireSectionNav } from "../section-nav.js";
import { routeCardInfo } from "../first-off.js";
import { navigate } from "../../app.js";

// How far back to look for the most recent stock booked in.
const STOCK_ADDED_DAYS = 730;

let woUnsub = null;
let idnUnsub = null;
let bookInUnsub = null;
let stockUnsub = null;
let allOrders = [];
let allIdns = [];
let allBookIns = [];
let allStock = [];

export function renderDashboardView() {
  if (woUnsub) woUnsub();
  if (idnUnsub) idnUnsub();
  if (bookInUnsub) bookInUnsub();
  if (stockUnsub) stockUnsub();

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

  const refresh = () => renderDashboard(allOrders, allIdns, allBookIns, allStock);
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
  stockUnsub = subscribeStockItems((items) => {
    allStock = items;
    refresh();
  });

  setViewCleanup(() => {
    if (woUnsub) woUnsub();
    if (idnUnsub) idnUnsub();
    if (bookInUnsub) bookInUnsub();
    if (stockUnsub) stockUnsub();
    woUnsub = null;
    idnUnsub = null;
    bookInUnsub = null;
    stockUnsub = null;
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

function renderDashboard(orders, idns, bookIns, stock) {
  const body = document.getElementById("dash-body");
  if (!body) return;

  const now = Date.now();
  const thisWeekStart = startOfWeek(now);
  const nextWeekStart = thisWeekStart + 7 * 86400000;

  const openedThisWeek = countInRange(orders, "createdAt", thisWeekStart, nextWeekStart);

  const liveIdns = idns.filter((i) => !i.voided);
  const closedThisWeek = countInRange(liveIdns, "createdAt", thisWeekStart, nextWeekStart);

  // Outstanding work - Open or Issued. Complete/Cancelled aren't "open" by
  // any reading of the word. Scheduled children are deliberately left out:
  // nobody's picked them up yet.
  const openOrders = orders
    .filter((wo) => wo.status === "Open" || wo.status === "Issued")
    .sort(byDueDate);

  const closedThisWeekIdns = liveIdns.filter((i) => (i.createdAt || 0) >= thisWeekStart).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  // Picked up and part-way through: some pieces already completed, some still
  // to go, or reopened after an IDN (Issued).
  const inProgress = openOrders.filter((wo) => wo.status === "Issued" || (completedQtyOf(wo) > 0 && remainingQty(wo) > 0));

  const lowStock = stock.filter(isLowStock);
  const negativeStock = stock.filter(hasNegativeStock);
  const rejects = rejectsThisWeek(orders, thisWeekStart, nextWeekStart);
  const rejectedPcs = rejects.reduce((sum, r) => sum + r.qty, 0);
  const rejectedParts = new Set(rejects.map((r) => r.partNo)).size;

  const cardsToReview = orders.filter((wo) => wo.firstOff && routeCardInfo(wo).quality === "Awaiting quality").length;

  const weekEnd = new Date(nextWeekStart - 86400000);
  const weekLabel = `${new Date(thisWeekStart).toLocaleDateString(undefined, { day: "numeric", month: "short" })} – ${weekEnd.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;

  body.innerHTML = `
    <div class="dash-week">Week of ${esc(weekLabel)}</div>
    <div class="dash-tiles">
      ${tileHTML("Opened", openedThisWeek, "this week", "blue", "#/work-orders")}
      ${tileHTML("Closed", closedThisWeek, "IDN completed", "green", "#/idns")}
      ${tileHTML("Low stock", lowStock.length, negativeStock.length ? `${negativeStock.length} negative` : "items", "red", "#/stock-availability?low=1")}
      ${tileHTML("Route cards to review", cardsToReview, "awaiting quality", "blue", "#/route-cards")}
      ${tileHTML("Rejected pcs", rejectedPcs, `${rejectedParts} part${rejectedParts === 1 ? "" : "s"}`, "orange", "#/reject-report")}
    </div>

    <div class="dash-two">
      <div class="dash-panel">
        <h4>Needs attention</h4>
        ${attentionHTML(lowStock, negativeStock, orders)}
      </div>
      <div class="dash-panel">
        <h4>In progress work orders <span class="count">${inProgress.length}</span></h4>
        ${inProgressHTML(inProgress)}
      </div>
    </div>

    <div class="section-row"><h3>Stock added</h3><span class="count dash-link" data-hash="#/stock-added">See all by month →</span></div>
    ${lastStockAddedHTML(bookIns)}

    <div class="section-row"><h3>Open work orders</h3><span class="count">${openOrders.length} open · by due date</span></div>
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
  body.querySelectorAll("[data-hash]").forEach((el) => {
    el.onclick = () => navigate(el.dataset.hash);
  });
}

// Orders with a due date first (soonest at the top), undated ones after,
// newest first among those.
function byDueDate(a, b) {
  const da = dueDateOf(a);
  const db = dueDateOf(b);
  if (da && db) return da < db ? -1 : da > db ? 1 : 0;
  if (da) return -1;
  if (db) return 1;
  return (b.createdAt || 0) - (a.createdAt || 0);
}

function rejectsThisWeek(orders, start, end) {
  const out = [];
  orders.forEach((wo) => {
    (wo.history || []).forEach((h) => {
      if (h.type === "rejected" && h.timestamp >= start && h.timestamp < end) {
        out.push({ partNo: wo.partNo, qty: h.qty || 0, reason: h.reason || "" });
      }
    });
  });
  return out;
}

function tileHTML(label, value, note, tone, hash) {
  return `
    <button class="dash-tile dash-tile--${tone}" data-hash="${esc(hash)}">
      <span class="dash-tile-label">${esc(label)}</span>
      <span class="dash-tile-value">${value}</span>
      <span class="dash-tile-note">${esc(note)}</span>
    </button>
  `;
}

function attentionHTML(lowStock, negativeStock, orders) {
  const rows = [];
  const dated = orders.filter((wo) => ["red", "orange"].includes(dueDateStatus(wo))).sort(byDueDate);
  dated.forEach((wo) => {
    const status = dueDateStatus(wo);
    rows.push({ text: wo.woNo, pill: status === "red" ? "Overdue" : "Due soon", cls: `status-${status}`, hash: "#/work-orders/" + encodeURIComponent(wo.woNo) });
  });
  negativeStock.forEach((i) => rows.push({ text: i.partNumber, pill: "Negative stock", cls: "status-negative", hash: "#/item/" + encodeURIComponent(i.partNumber) }));
  lowStock
    .filter((i) => !hasNegativeStock(i))
    .forEach((i) => rows.push({ text: i.partNumber, pill: `Low · ${cyclesRemaining(i)} cycles`, cls: "status-red", hash: "#/item/" + encodeURIComponent(i.partNumber) }));

  if (rows.length === 0) return `<div class="empty-state">All clear.</div>`;
  const extra = rows.length - 8;
  return rows
    .slice(0, 8)
    .map((r) => `<div class="dash-row" data-hash="${esc(r.hash)}"><span class="mono">${esc(r.text)}</span><span class="status-pill ${r.cls}">${esc(r.pill)}</span></div>`)
    .join("") + (extra > 0 ? `<div class="dash-row dash-row--link" data-hash="#/stock-availability?low=1"><span>${extra} more · see Stock availability</span><span>→</span></div>` : "");
}


function lastStockAddedHTML(bookIns) {
  if (bookIns.length === 0) return `<div class="empty-state">No stock booked in in this window yet.</div>`;

  const last = bookIns.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
  const date = new Date(last.timestamp).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "long", year: "numeric" });
  return `
    <div class="dash-panel dash-last-added" style="margin:0 16px 28px;">
      <div class="dash-tile-label">Last stock added</div>
      <div class="dash-last-date">${esc(date)}</div>
      <div class="dash-tile-note" style="color:var(--sub);">${last.qty || 0} pcs of ${esc(last.stockNumber || last.stockItemId || "")}${last.user ? " · by " + esc(last.user) : ""}</div>
    </div>
  `;
}

function inProgressHTML(orders) {
  if (orders.length === 0) return `<div class="empty-state">Nothing in progress.</div>`;
  return orders
    .slice(0, 5)
    .map(
      (wo) => `<div class="dash-row" data-wo="${esc(wo.woNo)}"><span class="mono">${esc(wo.woNo)}</span><span>${esc(wo.partNo)} · ${completedQtyOf(wo)}/${wo.qty || 0} done</span></div>`
    )
    .join("");
}

function woCardsHTML(orders, closed) {
  if (orders.length === 0) return `<div class="empty-state">Nothing here right now.</div>`;
  return orders
    .map(
      (wo) => `
      <div class="wo-card ${closed ? "closed" : ""} ${dueClass(wo)}" data-wo="${esc(wo.woNo)}">
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

function dueClass(wo) {
  const status = dueDateStatus(wo);
  return status ? `due-${status}` : "";
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
