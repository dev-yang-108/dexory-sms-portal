/* Item detail: spec card, per-area stock cards, barcode + print, recent activity. */

import { esc, mount, setViewCleanup, formatDate, toast } from "../render.js";
import {
  subscribeStockItem,
  cyclesRemaining,
  isLowStock,
  listRecentTransactions,
  listTransactionPage,
  deleteStockItem,
  AREAS,
  AREA_LABELS,
  DEDUCTION_AREA,
  areaQty,
  areaLocation,
  areasWithStock,
  negativeAreas,
  blankYield,
  coveringBlanks,
  makeablePieces
} from "../db.js";
import { renderBarcodeInto, downloadBarcodePng } from "../barcode.js";
import { openQtyModal } from "../qty-modal.js";
import { openMoveModal } from "../move-modal.js";
import { navigate } from "../../app.js";

let detailUnsub = null;
let currentItem = null;
let historyPage = 0;
let historyOpen = false;

export function renderDetailView(partNumber) {
  if (detailUnsub) detailUnsub();
  historyOpen = false;
  historyPage = 0;

  mount(`
    <header class="topbar">
      <button class="icon-btn" id="btn-back" aria-label="Back">&larr;</button>
      <div class="topbar-spacer"></div>
      <a class="pill-link" id="btn-edit">Edit</a>
    </header>
    <div id="detail-body"><div class="empty-state">Loading…</div></div>
  `);

  document.getElementById("btn-back").onclick = () => navigate("#/");

  detailUnsub = subscribeStockItem(partNumber, (item) => {
    currentItem = item;
    if (!item) {
      document.getElementById("detail-body").innerHTML = `
        <div class="empty-state">Stock item "${esc(partNumber)}" was not found. It may have been deleted, or the barcode is stale.</div>
      `;
      return;
    }
    document.getElementById("btn-edit").onclick = () => navigate("#/edit/" + encodeURIComponent(item.partNumber));
    renderBody(item);
  });

  setViewCleanup(() => {
    if (detailUnsub) detailUnsub();
    detailUnsub = null;
  });
}

async function renderBody(item) {
  const cycles = cyclesRemaining(item);
  const low = isLowStock(item);
  const negAreas = negativeAreas(item);
  const stockedAreas = areasWithStock(item);
  // Just the locations themselves, no Farm/Production/Prototype labels -
  // this sits right under the barcode, not another stock breakdown.
  const stockedLocations = Array.from(new Set(stockedAreas.map((a) => areaLocation(item, a)).filter(Boolean)));
  const barcodeLocSummary = stockedLocations.map((l) => esc(l)).join(" &nbsp;·&nbsp; ");

  document.getElementById("detail-body").innerHTML = `
    <header class="item-header">
      <div class="item-header-number mono">${esc(item.partNumber)}</div>
      <div class="item-header-part">${esc(item.partName) || esc(item.material) || "—"}</div>
    </header>

    <section>
      <div class="kv">
        <div class="kv-row"><span class="k">Part name</span><span class="v">${esc(item.partName) || "—"}</span></div>
        <div class="kv-row"><span class="k">Rev</span><span class="v">${esc(item.rev) || "—"}</span></div>
        <div class="kv-row"><span class="k">Material</span><span class="v">${esc(item.material) || "—"}</span></div>
        <div class="kv-row"><span class="k">Stock size</span><span class="v">${esc(item.stockSize) || "—"}</span></div>
        <div class="kv-row"><span class="k">Form</span><span class="v">${esc(item.form) || "—"}</span></div>
        <div class="kv-row"><span class="k">Pieces per blank</span><span class="v">${esc(item.piecesPerBlank || 1)} pcs</span></div>
        <div class="kv-row"><span class="k">Qty per 7-section robot</span><span class="v">${esc(item.perRobotCycle)} pcs</span></div>
        <div class="kv-row"><span class="k">Qty per 10-section robot</span><span class="v">${esc(item.perRobotCycle10Sec || 1)} pcs</span></div>
      </div>
    </section>

    <section>
      <div class="section-title">Comments</div>
      <div class="kv"><div class="kv-row" style="display:block;"><span class="v" style="text-align:left;font-weight:400;">${item.comments ? esc(item.comments) : `<span style="color:var(--sub);">No comments yet.</span>`}</span></div></div>
    </section>

    <section>
      <div class="section-title">Stock by area</div>
      ${
        negAreas.length > 0
          ? `<div class="negative-stock-banner" style="margin:0 16px 10px;">⚠ Negative stock in ${negAreas.map((a) => esc(AREA_LABELS[a])).join(" &amp; ")} — more was taken than was on hand. Book in stock or correct the quantity to clear this.</div>`
          : ""
      }
      ${low ? `<div class="low-badge-inline" style="margin:0 16px 10px;">LOW STOCK — PRODUCTION + FARM</div>` : ""}
      <div class="area-grid">
        ${AREAS.map((a) => renderAreaCard(item, a)).join("")}
      </div>
      <div class="kv" style="margin-top:12px;">
        <div class="kv-row"><span class="k">Production + Farm</span><span class="v">${areaQty(item, DEDUCTION_AREA)} + ${areaQty(item, "farm")} = ${coveringBlanks(item)} ${blankYield(item) > 1 ? "blanks" : "pcs"}</span></div>
        ${
          blankYield(item) > 1
            ? `<div class="kv-row"><span class="k">Pieces per blank</span><span class="v">× ${blankYield(item)}</span></div>`
            : ""
        }
        <div class="kv-row"><span class="k">Parts we can make</span><span class="v"><b>${makeablePieces(item)} pcs</b></span></div>
      </div>
      <div class="hint" style="padding:8px 16px 0;">Work orders only ever deduct from Production — ${cycles === Infinity ? "No robot uses this part." : `Stock for ~${cycles} robot${cycles === 1 ? "" : "s"} between Production and Farm combined.`}</div>
    </section>

    <section>
      <div class="section-title">Barcode</div>
      <div class="barcode-block">
        <svg id="barcode-svg"></svg>
        <div class="barcode-text mono">${esc(item.partNumber)}</div>
        ${barcodeLocSummary ? `<div class="barcode-loc-line">${barcodeLocSummary}</div>` : ""}
        <button class="btn primary-lime" id="btn-download">Download barcode (PNG)</button>
        <button class="btn" id="btn-print">Print barcode label</button>
      </div>
    </section>

    <section id="activity-section">
      <div class="section-title">Recent activity</div>
      <div class="log-list" id="recent-log"><div class="empty-state">Loading…</div></div>
      <button class="pill-link standalone-btn" id="btn-history">View full history</button>
      <div id="history-wrap"></div>
    </section>

    <section>
      <button class="btn danger" id="btn-delete-item">Delete stock item</button>
    </section>

    <div class="print-label" aria-hidden="true">
      <svg id="print-barcode-svg"></svg>
      <div class="print-label-number mono">${esc(item.partNumber)}</div>
      <div class="print-label-loc">${stockedLocations.map((l) => esc(l)).join(" · ")}</div>
    </div>
  `;

  renderBarcodeInto(document.getElementById("barcode-svg"), item.partNumber);
  renderBarcodeInto(document.getElementById("print-barcode-svg"), item.partNumber);

  AREAS.forEach((a) => {
    const bookinBtn = document.getElementById("btn-bookin-" + a);
    const takeBtn = document.getElementById("btn-take-" + a);
    const moveBtn = document.getElementById("btn-move-" + a);
    if (bookinBtn) bookinBtn.onclick = () => openQtyModal({ item, type: "book-in", area: a, onDone: () => {} });
    if (takeBtn) takeBtn.onclick = () => openQtyModal({ item, type: "take", area: a, onDone: () => {} });
    if (moveBtn) moveBtn.onclick = () => openMoveModal({ item, fromArea: a, onDone: () => {} });
  });

  document.getElementById("btn-print").onclick = () => window.print();
  document.getElementById("btn-download").onclick = () => {
    if (!downloadBarcodePng(item.partNumber, stockedLocations.join(" · "))) toast("Barcode isn't ready yet, try again in a moment");
  };
  document.getElementById("btn-history").onclick = () => toggleHistory(item);
  document.getElementById("btn-delete-item").onclick = () => {
    const proceed = window.confirm(`Delete stock item ${item.partNumber}? This can't be undone.`);
    if (!proceed) return;
    deleteStockItem(item.partNumber)
      .then(() => {
        toast("Stock item deleted.");
        navigate("#/");
      })
      .catch((err) => {
        console.error(err);
        toast("Couldn't delete — check your connection.");
      });
  };

  const recent = await listRecentTransactions(item.partNumber, 10);
  const recentEl = document.getElementById("recent-log");
  if (recentEl) recentEl.innerHTML = renderLogRows(recent, "No activity yet.");
}

function renderAreaCard(item, area) {
  const qty = areaQty(item, area);
  const loc = areaLocation(item, area);
  const otherAreasHaveNone = qty === 0;
  const isNegative = qty < 0;
  return `
    <div class="area-card ${otherAreasHaveNone ? "area-card--empty" : ""} ${isNegative ? "area-card--negative" : ""}">
      <div class="area-card-head">
        <span class="area-name">${esc(AREA_LABELS[area])}${area === DEDUCTION_AREA ? " <span class=\"area-tag\">deducts here</span>" : ""}</span>
        <span class="area-loc">${loc ? esc(loc) : "—"}</span>
      </div>
      <div class="area-qty mono${isNegative ? " area-qty--negative" : ""}">${qty}${isNegative ? " ⚠" : ""}</div>
      <div class="area-qty-label">pcs on hand</div>
      <div class="area-actions">
        <button id="btn-bookin-${area}">+ Book in</button>
        <button id="btn-take-${area}" ${qty <= 0 ? "disabled" : ""}>&minus; Take</button>
        <button class="move" id="btn-move-${area}" ${qty <= 0 ? "disabled" : ""}>Move &rarr;</button>
      </div>
    </div>
  `;
}

function renderLogRows(rows, emptyMsg) {
  if (!rows || rows.length === 0) return `<div class="empty-state">${emptyMsg}</div>`;
  return rows
    .map((t) => {
      const sign = t.type === "take" ? "−" : "+";
      const cls = t.type === "take" ? "neg" : "pos";
      const areaTag = t.area ? esc(AREA_LABELS[t.area] || t.area) + " · " : "";
      return `
        <div class="log-row">
          <span class="delta ${cls} mono">${sign}${t.qty}</span>
          <span class="log-mid">${areaTag}${esc(t.user)}${t.note ? " · " + esc(t.note) : ""}</span>
          <span class="log-date">${formatDate(t.timestamp)}</span>
        </div>
      `;
    })
    .join("");
}

async function toggleHistory(item) {
  historyOpen = !historyOpen;
  const wrap = document.getElementById("history-wrap");
  const btn = document.getElementById("btn-history");
  if (!historyOpen) {
    wrap.innerHTML = "";
    btn.textContent = "View full history";
    return;
  }
  btn.textContent = "Hide full history";
  historyPage = 0;
  await renderHistoryPage(item);
}

async function renderHistoryPage(item) {
  const wrap = document.getElementById("history-wrap");
  wrap.innerHTML = `<div class="empty-state">Loading…</div>`;
  const { items, hasMore } = await listTransactionPage(item.partNumber, 25, historyPage);
  wrap.innerHTML = `
    <div class="log-list">${renderLogRows(items, "No history.")}</div>
    <div class="history-pager">
      <button class="pill-link" id="btn-prev-page" ${historyPage === 0 ? "disabled" : ""}>← Newer</button>
      <button class="pill-link" id="btn-next-page" ${hasMore ? "" : "disabled"}>Older →</button>
    </div>
  `;
  const prevBtn = document.getElementById("btn-prev-page");
  const nextBtn = document.getElementById("btn-next-page");
  if (prevBtn) prevBtn.onclick = () => {
    if (historyPage === 0) return;
    historyPage -= 1;
    renderHistoryPage(item);
  };
  if (nextBtn) nextBtn.onclick = () => {
    if (!hasMore) return;
    historyPage += 1;
    renderHistoryPage(item);
  };
}
