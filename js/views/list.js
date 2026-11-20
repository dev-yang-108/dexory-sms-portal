/* Stock list (home screen): a simple per-area board. Part number, quantity
   and location are the only things front and center - + Add / - Take /
   Move act directly from here without opening an item first. Renders as a
   dashboard shell (nav rail + table) at desktop widths and a compact card
   list on a phone - both markups exist at once, CSS picks which shows (see
   the dx-* rules in style.css). */

import { esc, mount, setViewCleanup } from "../render.js";
import { subscribeStockItems, productionParts, AREA_LABELS, areaQty, areaLocation, makeablePieces, blankYield, worstCyclesRemaining } from "../db.js";
import { sectionTabsHTML, dxNavHTML, wireSectionNav } from "../section-nav.js";
import { openQtyModal } from "../qty-modal.js";
import { openMoveModal } from "../move-modal.js";
import { openPartPickerModal } from "../part-picker-modal.js";
import { navigate } from "../../app.js";

// This board is Production Stock specifically - Prototype has its own
// separate, simplified sidebar page (verda-stock.js) now, so it's
// deliberately left out of these tabs rather than duplicating it here.
const BOARD_AREAS = ["production", "farm"];

let listUnsub = null;
let allItems = [];
// Kept across remounts (not reset to a default each time) so switching to an
// item's detail and back leaves you on the tab you were looking at.
let activeArea = BOARD_AREAS[0];
let showEmpty = false;

export function renderListView() {
  if (listUnsub) listUnsub();

  mount(`
    <div class="dx-app">
      ${dxNavHTML("stock")}
      <div class="dx-main">
        <header class="topbar list-topbar">
          <div class="brand">
            <span class="brand-word">Dexory</span>
            <span class="brand-tag">SMS</span>
          </div>
        </header>

        ${sectionTabsHTML("stock")}

        <div class="type-tabs" id="type-tabs">
          ${BOARD_AREAS.map(
            (a) => `<button class="type-tab ${a === activeArea ? "is-active" : ""}" data-area="${esc(a)}">${esc(AREA_LABELS[a])}</button>`
          ).join("")}
        </div>

        <div class="dx-content">
          <div class="quick-actions">
            <button class="qa-add" id="btn-qa-add">+ Add</button>
            <button class="qa-take" id="btn-qa-take">&minus; Take</button>
            <button class="qa-move" id="btn-qa-move">&#8646; Move</button>
            <button class="qa-coc" id="btn-qa-coc">&#128196; CoC</button>
          </div>

          <div class="list-controls">
            <div class="search-row">
              <input type="search" id="search-input" placeholder="Search part number, name, location…" />
              <button class="btn-new" id="btn-new">+ New</button>
            </div>
            <div class="chip-row">
              <button class="chip-toggle ${showEmpty ? "is-active" : ""}" id="btn-show-empty">Show 0 pcs too</button>
            </div>
          </div>

          <table class="dx-table">
            <thead>
              <tr><th>Part no.</th><th>Part name</th><th>Location</th><th>Details</th><th style="text-align:right;">Production</th><th style="text-align:right;">Farm</th><th style="text-align:right;">Total</th><th style="text-align:right;">Can make</th></tr>
            </thead>
            <tbody id="item-table-body"></tbody>
          </table>

          <div id="item-list" class="item-list dx-mobile-list">
            <div class="skeleton-list">
              ${Array.from({ length: 5 }).map(() => `<div class="skeleton-card"></div>`).join("")}
            </div>
          </div>
        </div>
      </div>
    </div>

    <button class="fab-scan" id="btn-scan" aria-label="Scan barcode">
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 7V5a1 1 0 0 1 1-1h2M4 17v2a1 1 0 0 0 1 1h2M20 7V5a1 1 0 0 0-1-1h-2M20 17v2a1 1 0 0 1-1 1h-2M7 8v8M11 8v8M14 8v8M17 8v8"/>
      </svg>
    </button>
  `);

  wireSectionNav();
  document.getElementById("btn-new").onclick = () => navigate("#/new");
  document.getElementById("btn-scan").onclick = () => navigate("#/scan");
  document.getElementById("search-input").oninput = renderFiltered;
  const showEmptyBtn = document.getElementById("btn-show-empty");
  showEmptyBtn.onclick = () => {
    showEmpty = !showEmpty;
    showEmptyBtn.classList.toggle("is-active", showEmpty);
    renderFiltered();
  };

  document.getElementById("btn-qa-add").onclick = () =>
    openPartPickerModal({
      items: allItems,
      area: activeArea,
      requireQty: false,
      title: "Add stock — " + AREA_LABELS[activeArea],
      onPick: (item) => openQtyModal({ item, type: "book-in", area: activeArea, onDone: () => {} })
    });
  document.getElementById("btn-qa-take").onclick = () =>
    openPartPickerModal({
      items: allItems,
      area: activeArea,
      requireQty: true,
      title: "Take stock — " + AREA_LABELS[activeArea],
      onPick: (item) => openQtyModal({ item, type: "take", area: activeArea, onDone: () => {} })
    });
  document.getElementById("btn-qa-move").onclick = () =>
    openPartPickerModal({
      items: allItems,
      area: activeArea,
      requireQty: true,
      title: "Move stock — " + AREA_LABELS[activeArea],
      onPick: (item) => openMoveModal({ item, fromArea: activeArea, onDone: () => {} })
    });
  document.getElementById("btn-qa-coc").onclick = () => navigate("#/coc/new");

  document.querySelectorAll("#type-tabs .type-tab").forEach((tab) => {
    tab.onclick = () => {
      if (tab.dataset.area === activeArea) return;
      activeArea = tab.dataset.area;
      renderListView();
    };
  });

  listUnsub = subscribeStockItems((items) => {
    allItems = productionParts(items);
    renderFiltered();
  });
  setViewCleanup(() => {
    if (listUnsub) listUnsub();
    listUnsub = null;
  });
}

// Only items actually holding stock in this area show up in its tab by
// default - a part with 0 pcs in Farm just doesn't clutter that tab until
// some is booked in there. "Show 0 pcs too" opts back in, e.g. right after
// creating a batch of new parts before any of them are stocked yet.
function itemsOfActiveArea() {
  if (showEmpty) return allItems;
  return allItems.filter((item) => areaQty(item, activeArea) > 0);
}

function renderFiltered() {
  const listEl = document.getElementById("item-list");
  const tableBody = document.getElementById("item-table-body");
  if (!listEl || !tableBody) return;

  const q = (document.getElementById("search-input").value || "").toLowerCase().trim();
  const scoped = itemsOfActiveArea();

  const matches = scoped.filter((item) => {
    if (!q) return true;
    const loc = areaLocation(item, activeArea);
    const hay = [item.partNumber, item.partName, loc].join(" ").toLowerCase();
    return hay.includes(q);
  });

  if (scoped.length === 0) {
    const empty = `<div class="empty-state">No stock in ${esc(AREA_LABELS[activeArea])} yet — scan a barcode or tap + Add to put some in.</div>`;
    listEl.innerHTML = empty;
    tableBody.innerHTML = `<tr><td colspan="8"style="padding:0;border:none;">${empty}</td></tr>`;
    return;
  }

  if (matches.length === 0) {
    const empty = `<div class="empty-state">No stock items match. Try clearing search.</div>`;
    listEl.innerHTML = empty;
    tableBody.innerHTML = `<tr><td colspan="8"style="padding:0;border:none;">${empty}</td></tr>`;
    return;
  }

  listEl.innerHTML = matches
    .map((item) => {
      const prod = areaQty(item, "production");
      const farm = areaQty(item, "farm");
      const total = prod + farm;
      const loc = areaLocation(item, activeArea);
      return `
        <div class="simple-row" data-part="${esc(item.partNumber)}">
          <div class="simple-row-main">
            <div class="simple-row-part mono">${esc(item.partNumber)}</div>
            ${item.partName ? `<div class="simple-row-name">${esc(item.partName)}</div>` : ""}
            <div class="simple-row-loc">${esc(loc) || "—"}</div>
            <div class="simple-row-sub">${detailLine(item)}</div>
            <div class="simple-row-sub">Production ${prod} · Farm ${farm}</div>
            <div class="simple-row-sub">Can make ${makeablePieces(item)} pcs${blankYield(item) > 1 ? ` (${total} × ${blankYield(item)})` : ""}${cyclesLabel(item) ? " · " + cyclesLabel(item) : ""}</div>
          </div>
          <div class="simple-row-qty"><div class="num mono qty-total qty-total--${stockTone(item)}">${total}</div><div class="lbl">total</div></div>
        </div>
      `;
    })
    .join("");

  tableBody.innerHTML = matches
    .map((item) => {
      const prod = areaQty(item, "production");
      const farm = areaQty(item, "farm");
      const total = prod + farm;
      const loc = areaLocation(item, activeArea);
      return `
        <tr data-part="${esc(item.partNumber)}">
          <td class="mono">${esc(item.partNumber)}</td>
          <td>${esc(item.partName) || "—"}</td>
          <td>${esc(loc) || "—"}</td>
          <td>${detailLine(item)}</td>
          <td class="mono" style="text-align:right;">${prod}</td>
          <td class="mono" style="text-align:right;">${farm}</td>
          <td style="text-align:right;"><span class="qty-total qty-total--${stockTone(item)} mono" title="${esc(cyclesLabel(item))}">${total}</span></td>
          <td class="mono" style="text-align:right;">${makeablePieces(item)} pcs${cyclesLabel(item) ? `<div class="avail-area-loc">${esc(cyclesLabel(item))}</div>` : ""}</td>
        </tr>
      `;
    })
    .join("");

  document.querySelectorAll(".simple-row[data-part], #item-table-body tr[data-part]").forEach((row) => {
    row.onclick = () => navigate("#/item/" + encodeURIComponent(row.dataset.part));
  });
}

// Same 5 / 10 robot-cycle bands as the Stock Availability page, judged on the
// parts the stock can make (blanks x pieces per blank), not the raw blank count.
function stockTone(item) {
  const cycles = worstCyclesRemaining(item);
  if (cycles < 5) return "red";
  if (cycles < 10) return "amber";
  return "green";
}

function cyclesLabel(item) {
  const cycles = worstCyclesRemaining(item);
  return cycles === Infinity ? "" : `${cycles} robot${cycles === 1 ? "" : "s"}`;
}

function detailLine(item) {
  const parts = [
    `${esc(item.perRobotCycle ?? 1)} pcs/robot`,
    [item.form, item.stockSize].filter(Boolean).map(esc).join(", "),
    item.comments ? `"${esc(item.comments)}"` : ""
  ].filter(Boolean);
  return parts.join(" · ");
}
