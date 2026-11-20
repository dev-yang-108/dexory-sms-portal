/* Stock Availability: a read-only, all-parts-at-once status board - Part
   No./Name plus Production and Farm location+qty, color-coded by how many
   robot cycles that combined stock is worth. Everything else (Rev, Material,
   stock size, comments...) stays one click away on the part's own detail
   page rather than cluttering this view - this is for a fast at-a-glance
   scan, not the full record. Reached from the desktop nav rail, same as
   Dashboard/Low Stock/Rejects - a report, not a place you act from (use the
   main board's +Add/-Take/Move for that).

   Status color uses Production + Farm combined (Prototype excluded, same as
   the rest of this page) against whichever of the two robot types' own
   consumption rate is more constraining for that part - i.e. however many
   cycles that combined stock would last the *faster-consuming* robot, not
   an average or a sum of both robots' demand. Thresholds: <5 cycles red,
   5-9 orange, 10+ green - deliberately the same 5-cycle cutoff the existing
   Low Stock badge elsewhere in the app already uses, just extended with a
   comfortable/caution middle band instead of a flat yes/no.
*/

import { esc, mount, setViewCleanup } from "../render.js";
import { subscribeStockItems, productionParts, areaQty, areaLocation, hasNegativeStock, worstCyclesRemaining, isLowStock, blankYield } from "../db.js";
import { lowStockAction } from "../low-stock.js";
import { dxNavHTML, wireSectionNav } from "../section-nav.js";
import { navigate } from "../../app.js";

const DISPLAY_AREAS = ["production", "farm"];

let itemsUnsub = null;
let allItems = [];
let showEmpty = false;
let maxCycles = "";
let lowOnly = false;

export function renderStockAvailabilityView() {
  if (itemsUnsub) itemsUnsub();
  // Opened from the dashboard's Low stock tile as #/stock-availability?low=1;
  // from the sidebar it always starts showing everything.
  lowOnly = new URLSearchParams((location.hash.split("?")[1] || "")).get("low") === "1";

  mount(`
    <div class="dx-app">
      ${dxNavHTML("stock-availability")}
      <div class="dx-main">
        <div class="dx-content" style="max-width:1240px;">
          <div class="dash-title">Stock Availability</div>
          <div class="dash-sub">Production + Farm stock per part, colored by how many robots it covers. Click a part for full details.</div>

          <div class="chip-row" style="padding:0 16px;">
            <input type="search" id="avail-search" placeholder="Search part number, name…" style="flex:1;" />
            <input type="number" min="0" step="1" id="avail-max-cycles" placeholder="Max robots left" style="width:140px;" />
            <button class="chip-toggle ${lowOnly ? "is-active" : ""}" id="btn-avail-low">Low stock only</button>
            <button class="chip-toggle ${showEmpty ? "is-active" : ""}" id="btn-avail-show-empty">Show 0 pcs too</button>
          </div>
          <div class="hint" style="margin:0 0 10px 16px;">"Low stock only" shows parts with stock for under 5 robots, with what to move or order. "Max robots left" narrows the list to parts at or below that many robots. It uses whichever of the two robots (7-section or 10-section) runs out first.</div>

          <div id="avail-body" style="padding:16px;"><div class="empty-state">Loading…</div></div>
        </div>
      </div>
    </div>
  `);

  wireSectionNav();

  document.getElementById("avail-search").oninput = renderBody;
  document.getElementById("avail-max-cycles").oninput = (e) => {
    maxCycles = e.target.value;
    renderBody();
  };
  const lowBtn = document.getElementById("btn-avail-low");
  lowBtn.onclick = () => {
    lowOnly = !lowOnly;
    lowBtn.classList.toggle("is-active", lowOnly);
    renderBody();
  };
  const showEmptyBtn = document.getElementById("btn-avail-show-empty");
  showEmptyBtn.onclick = () => {
    showEmpty = !showEmpty;
    showEmptyBtn.classList.toggle("is-active", showEmpty);
    renderBody();
  };

  itemsUnsub = subscribeStockItems((items) => {
    allItems = productionParts(items);
    renderBody();
  });

  setViewCleanup(() => {
    if (itemsUnsub) itemsUnsub();
    itemsUnsub = null;
  });
}

function combinedQty(item) {
  return DISPLAY_AREAS.reduce((sum, a) => sum + areaQty(item, a), 0);
}

// The more constraining of the two robots' own cycle counts - whichever
// runs out sooner is the one that actually matters for "do we need to order".
const worstCycles = worstCyclesRemaining;

function statusOf(cycles, item) {
  // Distinct from plain "<5 cycles" red - this item has actually been
  // over-deducted (see hasNegativeStock()), not just running low.
  if (item && hasNegativeStock(item)) return { cls: "status-negative", label: "⚠ Negative" };
  const robots = (n) => `${n} robot${n === 1 ? "" : "s"}`;
  if (cycles < 5) return { cls: "status-red", label: cycles === Infinity ? "—" : robots(cycles) };
  if (cycles < 10) return { cls: "status-orange", label: robots(cycles) };
  return { cls: "status-green", label: cycles === Infinity ? "—" : `${cycles}+ robots` };
}

// Only a low-stock part needs doing something about: bring Farm stock into
// Production first (free), then order whatever is still short.
function actionHTML(item) {
  if (!isLowStock(item)) return `<span class="avail-area-loc">—</span>`;
  const { moveBlanks, orderBlanks } = lowStockAction(item);
  const unit = blankYield(item) > 1 ? " blanks" : "";
  const chips = [];
  if (moveBlanks > 0) chips.push(`<span class="status-pill status-orange">Move +${moveBlanks} from Farm</span>`);
  if (orderBlanks > 0) chips.push(`<span class="status-pill status-red">Order +${orderBlanks}${unit}</span>`);
  return chips.length ? `<div class="avail-actions">${chips.join("")}</div>` : `<span class="avail-area-loc">—</span>`;
}

function areaCellHTML(item, area) {
  const qty = areaQty(item, area);
  const loc = areaLocation(item, area);
  return `<td><div class="avail-area-qty mono${qty < 0 ? " avail-area-qty--negative" : ""}">${qty} pcs</div><div class="avail-area-loc">${esc(loc) || "—"}</div></td>`;
}

function renderBody() {
  const body = document.getElementById("avail-body");
  if (!body) return;

  const q = (document.getElementById("avail-search").value || "").toLowerCase().trim();
  const cyclesLimit = maxCycles === "" ? null : Number(maxCycles);

  // A low-stock part is often one with nothing left, so that view always
  // includes empty parts rather than hiding exactly what needs ordering.
  const scoped = showEmpty || lowOnly ? allItems : allItems.filter((item) => combinedQty(item) > 0);
  const matches = scoped
    .filter((item) => {
      if (q) {
        const hay = [item.partNumber, item.partName].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (lowOnly && !isLowStock(item)) return false;
      if (cyclesLimit !== null && worstCycles(item) > cyclesLimit) return false;
      return true;
    })
    .sort((a, b) => (lowOnly ? worstCycles(a) - worstCycles(b) : 0));

  if (allItems.length === 0) {
    body.innerHTML = `<div class="empty-state">No stock items yet.</div>`;
    return;
  }
  if (matches.length === 0) {
    body.innerHTML = `<div class="empty-state">No parts match.</div>`;
    return;
  }

  body.innerHTML = `
    <table class="reject-table avail-table">
      <thead>
        <tr>
          <th>Part no.</th>
          <th>Part name</th>
          <th>Production</th>
          <th>Farm</th>
          <th>Status</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${matches
          .map((item) => {
            const status = statusOf(worstCycles(item), item);
            return `
            <tr data-part="${esc(item.partNumber)}" style="cursor:pointer;">
              <td class="mono">${esc(item.partNumber)}</td>
              <td>${esc(item.partName) || "—"}</td>
              ${areaCellHTML(item, "production")}
              ${areaCellHTML(item, "farm")}
              <td><span class="status-pill ${status.cls}">${esc(status.label)}</span></td>
              <td>${actionHTML(item)}</td>
            </tr>
          `;
          })
          .join("")}
      </tbody>
    </table>
  `;

  body.querySelectorAll("tr[data-part]").forEach((row) => {
    row.onclick = () => navigate("#/item/" + encodeURIComponent(row.dataset.part));
  });
}
