/* Work orders list: filter by part no., rev, date range, status.
   Same dashboard-shell / card-list duality as the stock list, since this
   is now a peer section, not a sub-page reached only via a link. */

import { esc, mount, setViewCleanup, formatDate } from "../render.js";
import { subscribeWorkOrders, WORK_ORDER_STATUSES, remainingQty, dueDateStatus } from "../db.js";
import { sectionTabsHTML, dxNavHTML, wireSectionNav } from "../section-nav.js";
import { navigate } from "../../app.js";

let woUnsub = null;
let allOrders = [];

export function renderWorkOrdersListView() {
  if (woUnsub) woUnsub();

  mount(`
    <div class="dx-app">
      ${dxNavHTML("orders")}
      <div class="dx-main">
        <header class="topbar list-topbar">
          <div class="brand">
            <span class="brand-word">Dexory</span>
            <span class="brand-tag">SMS</span>
          </div>
        </header>

        ${sectionTabsHTML("orders")}

        <div class="dx-content">
          <div class="dx-stats" id="dx-stats"></div>

          <div class="list-controls">
            <div class="search-row">
              <input type="search" id="search-input" placeholder="Search part no., WO no…" />
              <button class="btn-new" id="btn-new-wo">+ New</button>
            </div>

            <div class="chip-row">
              <select id="filter-status" class="chip-select">
                <option value="">All statuses</option>
                ${WORK_ORDER_STATUSES.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}
              </select>
              <select id="filter-rev" class="chip-select"><option value="">All revs</option></select>
              <a class="pill-link" id="btn-stock-in">Book in stock</a>
            </div>
            <div class="chip-row">
              <div class="form-group" style="margin:0;flex:1;">
                <label>From</label>
                <input type="date" id="filter-from" />
              </div>
              <div class="form-group" style="margin:0;flex:1;">
                <label>To</label>
                <input type="date" id="filter-to" />
              </div>
            </div>
          </div>

          <table class="dx-table">
            <thead>
              <tr><th>WO no.</th><th>Part</th><th>Rev</th><th style="text-align:right;">Ordered</th><th style="text-align:right;">Remaining</th><th>Status</th><th>Assignee</th></tr>
            </thead>
            <tbody id="wo-table-body"></tbody>
          </table>

          <div id="wo-list" class="item-list dx-mobile-list">
            <div class="skeleton-list">
              ${Array.from({ length: 3 }).map(() => `<div class="skeleton-card"></div>`).join("")}
            </div>
          </div>
        </div>
      </div>
    </div>
  `);

  wireSectionNav();
  document.getElementById("btn-new-wo").onclick = () => navigate("#/work-orders/new");
  document.getElementById("btn-stock-in").onclick = () => navigate("#/stock-in");

  ["search-input", "filter-status", "filter-rev", "filter-from", "filter-to"].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener(id === "search-input" ? "input" : "change", renderFiltered);
  });

  woUnsub = subscribeWorkOrders((orders) => {
    allOrders = orders;
    populateRevOptions(orders);
    renderFiltered();
  });
  setViewCleanup(() => {
    if (woUnsub) woUnsub();
    woUnsub = null;
  });
}

function populateRevOptions(orders) {
  const revSel = document.getElementById("filter-rev");
  if (!revSel) return;
  const prev = revSel.value;
  const revs = Array.from(new Set(orders.map((wo) => wo.rev).filter(Boolean))).sort();
  revSel.innerHTML = `<option value="">All revs</option>` + revs.map((r) => `<option value="${esc(r)}">R${esc(r)}</option>`).join("");
  revSel.value = prev;
}

function badgeClass(status) {
  if (status === "Complete") return "type-badge--prototype";
  if (status === "Issued") return "type-badge--issued";
  if (status === "Cancelled") return "type-badge--cancelled";
  return "type-badge--production";
}

// A Production Request's own weekly children are a different unit - they
// show up inside the parent's own detail page, not cluttering this flat
// list one row per week. Only the parent (or a plain standalone order) gets
// a row here.
function topLevelOrdersOf(orders) {
  return orders.filter((wo) => !wo.parentWoNo);
}

function secondaryLine(wo) {
  if (wo.isParent) {
    return `${esc(wo.partName || wo.partNo)} · R${esc(wo.rev)} · ${esc(wo.weekCount || 0)} week${wo.weekCount === 1 ? "" : "s"}${wo.mrpOrderNo ? " · " + esc(wo.mrpOrderNo) : ""}`;
  }
  return `${esc(wo.partName || wo.partNo)} · R${esc(wo.rev)} · ${esc(wo.qty)} pcs · ${formatDate(wo.date)}${wo.assignee ? " · " + esc(wo.assignee) : ""}`;
}

function statusOrParentBadgeHTML(wo) {
  if (wo.isParent) return `<span class="type-badge type-badge--production">Production request</span>`;
  return `<span class="type-badge ${badgeClass(wo.status)}">${esc(wo.status || "Open")}</span>`;
}

// A small coloured dot next to the WO no. - green/orange/red per
// dueDateStatus(), nothing at all when there's no due date set or the order
// is already finished (see dueDateStatus()'s own comment).
function dueDotHTML(wo) {
  const status = dueDateStatus(wo);
  if (!status) return "";
  const titles = { red: "Overdue", orange: "Due soon", green: "On track" };
  return `<span class="due-dot due-dot--${status}" title="${esc(titles[status])}"></span>`;
}

function renderStats(orders) {
  const statsEl = document.getElementById("dx-stats");
  if (!statsEl) return;
  const openCount = orders.filter((wo) => wo.status !== "Complete" && wo.status !== "Cancelled").length;
  const totalRemaining = orders.reduce((sum, wo) => sum + remainingQty(wo), 0);
  statsEl.innerHTML = `
    <div class="dx-stat"><div class="num">${orders.length}</div><div class="lbl">Work orders</div></div>
    <div class="dx-stat"><div class="num ${openCount ? "warn" : ""}">${openCount}</div><div class="lbl">Open / Issued</div></div>
    <div class="dx-stat"><div class="num">${totalRemaining}</div><div class="lbl">Total remaining</div></div>
  `;
}

function renderFiltered() {
  const listEl = document.getElementById("wo-list");
  const tableBody = document.getElementById("wo-table-body");
  if (!listEl || !tableBody) return;

  const topLevel = topLevelOrdersOf(allOrders);
  renderStats(topLevel);

  const q = (document.getElementById("search-input").value || "").toLowerCase().trim();
  const statusFilter = document.getElementById("filter-status").value;
  const revFilter = document.getElementById("filter-rev").value;
  const fromVal = document.getElementById("filter-from").value;
  const toVal = document.getElementById("filter-to").value;
  const from = fromVal ? new Date(fromVal + "T00:00:00").getTime() : null;
  const to = toVal ? new Date(toVal + "T23:59:59").getTime() : null;

  const matches = topLevel
    .filter((wo) => {
      if (statusFilter && wo.status !== statusFilter) return false;
      if (revFilter && wo.rev !== revFilter) return false;
      if (from && (wo.date || 0) < from) return false;
      if (to && (wo.date || 0) > to) return false;
      if (q) {
        const hay = [wo.woNo, wo.partNo, wo.partName].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => (b.date || 0) - (a.date || 0));

  if (topLevel.length === 0) {
    const empty = `<div class="empty-state">No work orders yet — tap + New to add one.</div>`;
    listEl.innerHTML = empty;
    tableBody.innerHTML = `<tr><td colspan="7" style="padding:0;border:none;">${empty}</td></tr>`;
    return;
  }

  if (matches.length === 0) {
    const empty = `<div class="empty-state">No work orders match. Try clearing search or filters.</div>`;
    listEl.innerHTML = empty;
    tableBody.innerHTML = `<tr><td colspan="7" style="padding:0;border:none;">${empty}</td></tr>`;
    return;
  }

  listEl.innerHTML = matches
    .map(
      (wo) => `
        <div class="item-card" data-wo="${esc(wo.woNo)}">
          <div class="item-card-main">
            <div class="item-stock-number mono">${dueDotHTML(wo)}${esc(wo.woNo)}</div>
            <div class="item-secondary">${secondaryLine(wo)}</div>
          </div>
          <div class="item-card-qty">
            ${statusOrParentBadgeHTML(wo)}
          </div>
        </div>
      `
    )
    .join("");

  tableBody.innerHTML = matches
    .map(
      (wo) => `
        <tr data-wo="${esc(wo.woNo)}">
          <td class="mono">${dueDotHTML(wo)}${esc(wo.woNo)}</td>
          <td>${esc(wo.partName || wo.partNo)}</td>
          <td class="mono">R${esc(wo.rev)}</td>
          <td class="mono" style="text-align:right;">${esc(wo.qty)} pcs</td>
          <td class="mono" style="text-align:right;">${wo.isParent ? "—" : remainingQty(wo)}</td>
          <td>${statusOrParentBadgeHTML(wo)}</td>
          <td>${esc(wo.assignee || wo.creator) || "—"}</td>
        </tr>
      `
    )
    .join("");

  document.querySelectorAll(".item-card[data-wo], #wo-table-body tr[data-wo]").forEach((row) => {
    row.onclick = () => navigate("#/work-orders/" + encodeURIComponent(row.dataset.wo));
  });
}
