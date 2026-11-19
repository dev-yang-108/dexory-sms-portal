/* Stock Added - every time new stock was booked in, newest first, grouped by
   month. Reads the same book-in transactions the dashboard's "last stock
   added" does (isStockAddedTx filters out area moves and work order
   returns), so the two always agree. */

import { esc, mount, setViewCleanup, formatDate } from "../render.js";
import { subscribeRecentBookIns, AREA_LABELS } from "../db.js";
import { dxNavHTML, wireSectionNav } from "../section-nav.js";

// A couple of years back is plenty; subscribeRecentBookIns only ever looks at
// the latest 3000 transactions anyway.
const LOOKBACK_DAYS = 730;

let unsub = null;
let allBookIns = [];
let activeMonth = "all";

function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function renderStockAddedView() {
  if (unsub) unsub();

  mount(`
    <div class="dx-app">
      ${dxNavHTML("stock-added")}
      <div class="dx-main">
        <div class="dx-content" style="max-width:900px;">
          <div class="dash-title">Stock Added</div>
          <div class="dash-sub">Every time stock was loaded in, newest first, grouped by month.</div>
          <div class="form-group" style="padding:0 16px;max-width:260px;"><label>Month</label><select id="added-month"></select></div>
          <div id="added-body" style="padding:16px;"><div class="empty-state">Loading…</div></div>
        </div>
      </div>
    </div>
  `);

  wireSectionNav();

  unsub = subscribeRecentBookIns(LOOKBACK_DAYS, (bookIns) => {
    allBookIns = bookIns;
    renderBody();
  });

  setViewCleanup(() => {
    if (unsub) unsub();
    unsub = null;
  });
}

function renderBody() {
  const body = document.getElementById("added-body");
  const select = document.getElementById("added-month");
  if (!body || !select) return;

  const sorted = [...allBookIns].sort((a, b) => b.timestamp - a.timestamp);
  const months = Array.from(new Set(sorted.map((t) => monthKey(t.timestamp))));
  if (activeMonth !== "all" && !months.includes(activeMonth)) activeMonth = "all";

  select.innerHTML =
    `<option value="all">All months</option>` +
    months.map((m) => `<option value="${m}" ${m === activeMonth ? "selected" : ""}>${esc(monthLabel(m))}</option>`).join("");
  select.onchange = () => {
    activeMonth = select.value;
    renderBody();
  };

  if (sorted.length === 0) {
    body.innerHTML = `<div class="empty-state">No stock has been booked in yet.</div>`;
    return;
  }

  const shown = months.filter((m) => activeMonth === "all" || m === activeMonth);
  body.innerHTML = shown
    .map((m) => {
      const rows = sorted.filter((t) => monthKey(t.timestamp) === m);
      const total = rows.reduce((sum, t) => sum + (t.qty || 0), 0);
      return `
        <div class="section-row" style="padding:0;margin-top:8px;"><h3>${esc(monthLabel(m))}</h3><span class="count">${rows.length} entries · ${total} pcs</span></div>
        <div style="margin-bottom:24px;overflow-x:auto;">
          <table class="reject-table">
            <thead><tr><th>Date</th><th>Part number</th><th>Qty</th><th>Area</th><th>By</th><th>Note</th></tr></thead>
            <tbody>
              ${rows
                .map(
                  (t) => `<tr>
                <td>${esc(formatDate(t.timestamp))}</td>
                <td class="mono"><a href="#/item/${encodeURIComponent(t.stockNumber || t.stockItemId || "")}">${esc(t.stockNumber || t.stockItemId || "")}</a></td>
                <td class="mono">${t.qty || 0}</td>
                <td>${esc(AREA_LABELS[t.area] || t.area || "")}</td>
                <td>${esc(t.user || "")}</td>
                <td>${esc(t.note || "")}</td>
              </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>`;
    })
    .join("");
}
