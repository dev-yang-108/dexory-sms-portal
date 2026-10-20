/* Rejection report - every reject recorded against any work order, pulled
   out of each order's own history array (there's no separate rejects
   collection) and shown two ways: grouped by part number (which part keeps
   failing) and a flat chronological log (what happened on a given day). */

import { esc, mount, setViewCleanup, formatDate } from "../render.js";
import { subscribeWorkOrders } from "../db.js";
import { dxNavHTML, wireSectionNav } from "../section-nav.js";
import { navigate } from "../../app.js";

let woUnsub = null;
let allOrders = [];
let activeRange = "2weeks";
let activeView = "bypart";
let customFrom = "";
let customTo = "";

const RANGES = [
  { key: "week", label: "This week" },
  { key: "2weeks", label: "Last 2 weeks" },
  { key: "month", label: "This month" },
  { key: "custom", label: "Custom range…" }
];

export function renderRejectReportView() {
  if (woUnsub) woUnsub();

  mount(`
    <div class="dx-app">
      ${dxNavHTML("reject-report")}
      <div class="dx-main">
        <div class="dx-content" style="max-width:900px;">
          <div class="dash-title">Rejection Report</div>
          <div class="dash-sub">Every reject recorded against any work order, filterable and groupable.</div>

          <div class="chip-row" id="range-row" style="padding:0 16px;">
            ${RANGES.map((r) => `<button class="chip-toggle range-chip ${r.key === activeRange ? "is-active" : ""}" data-range="${r.key}">${esc(r.label)}</button>`).join("")}
          </div>

          <div class="chip-row" id="custom-range-row" style="padding:0 16px;display:${activeRange === "custom" ? "flex" : "none"};">
            <div class="form-group" style="margin:0;flex:1;"><label>From</label><input type="date" id="reject-from" value="${esc(customFrom)}" /></div>
            <div class="form-group" style="margin:0;flex:1;"><label>To</label><input type="date" id="reject-to" value="${esc(customTo)}" /></div>
          </div>

          <div class="type-tabs" id="view-tabs" style="max-width:none;">
            <button class="type-tab ${activeView === "bypart" ? "is-active" : ""}" data-view="bypart">By part number</button>
            <button class="type-tab ${activeView === "bydate" ? "is-active" : ""}" data-view="bydate">By date</button>
          </div>

          <div id="reject-body" style="padding:16px;"><div class="empty-state">Loading…</div></div>
        </div>
      </div>
    </div>
  `);

  wireSectionNav();
  wireControls();

  woUnsub = subscribeWorkOrders((orders) => {
    allOrders = orders;
    renderBody();
  });

  setViewCleanup(() => {
    if (woUnsub) woUnsub();
    woUnsub = null;
  });
}

function wireControls() {
  document.querySelectorAll("#range-row [data-range]").forEach((btn) => {
    btn.onclick = () => {
      activeRange = btn.dataset.range;
      renderRejectReportView();
    };
  });
  document.querySelectorAll("#view-tabs [data-view]").forEach((btn) => {
    btn.onclick = () => {
      activeView = btn.dataset.view;
      document.querySelectorAll("#view-tabs [data-view]").forEach((b) => b.classList.toggle("is-active", b === btn));
      renderBody();
    };
  });
  const fromInput = document.getElementById("reject-from");
  const toInput = document.getElementById("reject-to");
  if (fromInput) {
    fromInput.onchange = () => {
      customFrom = fromInput.value;
      renderBody();
    };
  }
  if (toInput) {
    toInput.onchange = () => {
      customTo = toInput.value;
      renderBody();
    };
  }
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

function rangeBounds() {
  const now = Date.now();
  if (activeRange === "week") {
    return { from: startOfWeek(now), to: now };
  }
  if (activeRange === "2weeks") {
    return { from: now - 14 * 86400000, to: now };
  }
  if (activeRange === "month") {
    const d = new Date(now);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return { from: d.getTime(), to: now };
  }
  // custom
  const from = customFrom ? new Date(customFrom + "T00:00:00").getTime() : 0;
  const to = customTo ? new Date(customTo + "T23:59:59").getTime() : now;
  return { from, to };
}

// Flattens every "rejected" history entry out of every work order, with
// part/WO context attached - there's no separate rejects collection, this
// is the only source of truth for what was rejected and when.
function allRejects(orders) {
  const out = [];
  orders.forEach((wo) => {
    (wo.history || []).forEach((h) => {
      if (h.type !== "rejected") return;
      out.push({
        timestamp: h.timestamp,
        qty: h.qty || 0,
        reason: h.reason || "",
        returnedQty: h.returnedQty || 0,
        user: h.user || "",
        partNo: wo.partNo,
        woNo: wo.woNo
      });
    });
  });
  return out;
}

function renderBody() {
  const body = document.getElementById("reject-body");
  if (!body) return;

  const { from, to } = rangeBounds();
  const rejects = allRejects(allOrders)
    .filter((r) => r.timestamp >= from && r.timestamp <= to)
    .sort((a, b) => b.timestamp - a.timestamp);

  body.innerHTML = activeView === "bypart" ? byPartHTML(rejects) : byDateHTML(rejects);

  body.querySelectorAll("[data-wo]").forEach((el) => {
    el.onclick = () => navigate("#/work-orders/" + encodeURIComponent(el.dataset.wo));
  });
}

function byPartHTML(rejects) {
  if (rejects.length === 0) return `<div class="empty-state">No rejects in this range.</div>`;

  const byPart = new Map();
  rejects.forEach((r) => {
    const entry = byPart.get(r.partNo) || { partNo: r.partNo, qty: 0, count: 0 };
    entry.qty += r.qty;
    entry.count += 1;
    byPart.set(r.partNo, entry);
  });
  const rows = Array.from(byPart.values()).sort((a, b) => b.qty - a.qty);
  const max = Math.max(...rows.map((r) => r.qty), 1);

  return `
    <div class="hint" style="margin:0 0 10px;">Sorted by most rejected first - the parts worth asking "why does this keep failing."</div>
    ${rows
      .map(
        (r) => `
        <div class="bar-row">
          <div class="bar-label">${esc(r.partNo)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.max(Math.round((r.qty / max) * 100), 4)}%;"></div></div>
          <div class="bar-val">${r.qty} pcs</div>
          <div class="bar-sub">${r.count} reject${r.count === 1 ? "" : "s"}</div>
        </div>
      `
      )
      .join("")}
  `;
}

function byDateHTML(rejects) {
  if (rejects.length === 0) return `<div class="empty-state">No rejects in this range.</div>`;

  return `
    <table class="reject-table">
      <thead>
        <tr><th>Date</th><th>Part no.</th><th>WO no.</th><th style="text-align:right;">Qty</th><th>Reason</th><th>Who</th></tr>
      </thead>
      <tbody>
        ${rejects
          .map(
            (r) => `
            <tr data-wo="${esc(r.woNo)}" style="cursor:pointer;">
              <td>${formatDate(r.timestamp)}</td>
              <td class="mono">${esc(r.partNo)}</td>
              <td class="mono">${esc(r.woNo)}</td>
              <td class="qty" style="text-align:right;">${r.qty}</td>
              <td>${esc(r.reason || "—")}${r.returnedQty ? `<div class="returned">${r.returnedQty} pcs returned to stock</div>` : ""}</td>
              <td>${esc(r.user)}</td>
            </tr>
          `
          )
          .join("")}
      </tbody>
    </table>
  `;
}
