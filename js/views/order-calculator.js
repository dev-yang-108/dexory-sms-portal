/* Order Calculator: "if we build N more 7-Sec robots and M more 10-Sec
   robots, which parts do we need to order more of, and how many?" Required
   qty per part = (qty/7Sec-robot * N) + (qty/10Sec-robot * M); shortfall is
   whatever of that isn't already covered by Production stock on hand - Farm/
   Prototype aren't counted towards it (deliberately: the shortfall answers
   "what do we need to buy", and stock sitting in Farm/Prototype still needs
   moving into Production before it actually covers a build, so this stays a
   conservative "what to order" number rather than assuming that move always
   happens first). Read-only against stock otherwise - this never books
   anything in or out, it's purely a planning calculation.
*/

import { esc, mount, setViewCleanup, toast } from "../render.js";
import { subscribeStockItems, areaQty, DEDUCTION_AREA, blankYield } from "../db.js";
import { dxNavHTML, wireSectionNav } from "../section-nav.js";

let itemsUnsub = null;
let allItems = [];
let qty7 = "";
let qty10 = "";
let showAll = false;

export function renderOrderCalculatorView() {
  if (itemsUnsub) itemsUnsub();

  mount(`
    <div class="dx-app">
      ${dxNavHTML("order-calculator")}
      <div class="dx-main">
        <div class="dx-content" style="max-width:1200px;">
          <div class="dash-title">Order Calculator</div>
          <div class="dash-sub">Enter how many more robots to build - shows what's short in Production and how much to order.</div>

          <div class="form-grid2" style="margin:0 16px 4px;">
            <div class="form-group">
              <label>7 Sec robots to build</label>
              <input type="number" min="0" step="1" id="calc-qty7" placeholder="e.g. 50" />
            </div>
            <div class="form-group">
              <label>10 Sec robots to build</label>
              <input type="number" min="0" step="1" id="calc-qty10" placeholder="e.g. 0" />
            </div>
          </div>

          <div class="chip-row" style="padding:0 16px;">
            <button class="chip-toggle ${showAll ? "is-active" : ""}" id="btn-calc-show-all">Show all parts, not just shortfalls</button>
            <button class="btn" id="btn-calc-download">Download CSV</button>
          </div>

          <div id="calc-body" style="padding:16px;"><div class="empty-state">Enter a quantity above to calculate.</div></div>
        </div>
      </div>
    </div>
  `);

  wireSectionNav();

  const q7Input = document.getElementById("calc-qty7");
  const q10Input = document.getElementById("calc-qty10");
  q7Input.oninput = () => {
    qty7 = q7Input.value;
    renderBody();
  };
  q10Input.oninput = () => {
    qty10 = q10Input.value;
    renderBody();
  };

  const showAllBtn = document.getElementById("btn-calc-show-all");
  showAllBtn.onclick = () => {
    showAll = !showAll;
    showAllBtn.classList.toggle("is-active", showAll);
    renderBody();
  };

  document.getElementById("btn-calc-download").onclick = downloadCsv;

  itemsUnsub = subscribeStockItems((items) => {
    allItems = items;
    renderBody();
  });

  setViewCleanup(() => {
    if (itemsUnsub) itemsUnsub();
    itemsUnsub = null;
  });
}

function calcRows() {
  const n7 = Number(qty7) || 0;
  const n10 = Number(qty10) || 0;
  return allItems
    .map((item) => {
      const required = (Number(item.perRobotCycle) || 0) * n7 + (Number(item.perRobotCycle10Sec) || 0) * n10;
      // Production stock is counted in blanks; the build needs finished
      // parts, so compare in parts and give the shortfall back in whole
      // blanks too (that's what actually gets ordered).
      const yieldPerBlank = blankYield(item);
      const blanksInProduction = areaQty(item, DEDUCTION_AREA);
      const inProduction = blanksInProduction * yieldPerBlank;
      const shortfall = Math.max(0, required - inProduction);
      const blanksToOrder = Math.ceil(shortfall / yieldPerBlank);
      return { item, required, inProduction, blanksInProduction, yieldPerBlank, shortfall, blanksToOrder };
    })
    .filter((r) => r.required > 0);
}

function renderBody() {
  const body = document.getElementById("calc-body");
  if (!body) return;

  const n7 = Number(qty7) || 0;
  const n10 = Number(qty10) || 0;
  if (n7 <= 0 && n10 <= 0) {
    body.innerHTML = `<div class="empty-state">Enter a quantity above to calculate.</div>`;
    return;
  }

  const rows = calcRows();
  const visible = showAll ? rows : rows.filter((r) => r.shortfall > 0);

  if (visible.length === 0) {
    body.innerHTML = `<div class="empty-state">${rows.length === 0 ? "No parts use these robots." : "Nothing to order - Production already covers this build."}</div>`;
    return;
  }

  body.innerHTML = `
    <table class="reject-table">
      <thead>
        <tr>
          <th>Part no.</th>
          <th>Part name</th>
          <th>Material</th>
          <th style="text-align:right;">Required (pcs)</th>
          <th style="text-align:right;">In Production</th>
          <th style="text-align:right;">Shortfall (pcs)</th>
          <th style="text-align:right;">Blanks to order</th>
        </tr>
      </thead>
      <tbody>
        ${visible
          .map(
            (r) => `
            <tr>
              <td class="mono">${esc(r.item.partNumber)}</td>
              <td>${esc(r.item.partName) || "—"}</td>
              <td>${esc(r.item.material) || "—"}</td>
              <td class="mono" style="text-align:right;">${r.required}</td>
              <td class="mono" style="text-align:right;">${r.inProduction} pcs${r.yieldPerBlank > 1 ? `<div class="avail-area-loc">${r.blanksInProduction} × ${r.yieldPerBlank}</div>` : ""}</td>
              <td class="mono" style="text-align:right;${r.shortfall > 0 ? "color:var(--red);font-weight:700;" : ""}">${r.shortfall}</td>
              <td class="mono" style="text-align:right;${r.shortfall > 0 ? "color:var(--red);font-weight:700;" : ""}">${r.blanksToOrder}</td>
            </tr>
          `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function downloadCsv() {
  const rows = calcRows().filter((r) => r.shortfall > 0);
  if (rows.length === 0) {
    toast("Nothing to order yet - enter a quantity first.");
    return;
  }

  const csvEscape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = ["Part No.", "Part Name", "Material", "Required (pcs)", "In Production (pcs)", "Shortfall (pcs)", "Blanks to order"];
  const lines = [header.map(csvEscape).join(",")];
  rows.forEach((r) => {
    lines.push([r.item.partNumber, r.item.partName, r.item.material, r.required, r.inProduction, r.shortfall, r.blanksToOrder].map(csvEscape).join(","));
  });

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const today = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `material-order-${today}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
