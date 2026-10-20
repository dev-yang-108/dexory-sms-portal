/* IDN (internal delivery note) list: same peer treatment as Stock and
   Work Orders. "+ New" prompts for a work order number first, since every
   IDN is generated from one. */

import { esc, mount, setViewCleanup, formatDate, toast } from "../render.js";
import { subscribeIdns, getWorkOrder } from "../db.js";
import { sectionTabsHTML, dxNavHTML, wireSectionNav } from "../section-nav.js";
import { navigate } from "../../app.js";

let idnUnsub = null;
let allIdns = [];

export function renderIdnsListView() {
  if (idnUnsub) idnUnsub();

  mount(`
    <div class="dx-app">
      ${dxNavHTML("idn")}
      <div class="dx-main">
        <header class="topbar list-topbar">
          <div class="brand">
            <span class="brand-word">Dexory</span>
            <span class="brand-tag">Raw stock</span>
          </div>
        </header>

        ${sectionTabsHTML("idn")}

        <div class="dx-content">
          <div class="dx-stats" id="dx-stats"></div>

          <div class="list-controls">
            <div class="search-row">
              <input type="search" id="search-input" placeholder="Search IDN no., WO no., part no…" />
              <button class="btn-new" id="btn-new-idn">+ New</button>
            </div>
          </div>

          <table class="dx-table">
            <thead>
              <tr><th>IDN no.</th><th>Work order</th><th>Part no.</th><th style="text-align:right;">Qty</th><th>Date</th></tr>
            </thead>
            <tbody id="idn-table-body"></tbody>
          </table>

          <div id="idn-list" class="item-list dx-mobile-list">
            <div class="skeleton-list">
              ${Array.from({ length: 3 }).map(() => `<div class="skeleton-card"></div>`).join("")}
            </div>
          </div>
        </div>
      </div>
    </div>
  `);

  wireSectionNav();
  document.getElementById("btn-new-idn").onclick = promptForWorkOrder;
  document.getElementById("search-input").oninput = renderFiltered;

  idnUnsub = subscribeIdns((idns) => {
    allIdns = idns;
    renderFiltered();
  });
  setViewCleanup(() => {
    if (idnUnsub) idnUnsub();
    idnUnsub = null;
  });
}

async function promptForWorkOrder() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">New IDN</div>
      <div class="modal-sub">Every delivery note is generated from a work order.</div>
      <div class="form-group">
        <label>Work order no.</label>
        <input id="idn-wo-no" class="mono" placeholder="e.g. DEX-WO-0001" />
      </div>
      <div class="btn-row">
        <button class="btn" id="idn-wo-cancel">Cancel</button>
        <button class="btn primary-lime" id="idn-wo-go">Continue</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.querySelector("#idn-wo-cancel").onclick = () => overlay.remove();
  overlay.querySelector("#idn-wo-go").onclick = async () => {
    const woNo = overlay.querySelector("#idn-wo-no").value.trim();
    if (!woNo) {
      toast("Enter a work order no.");
      return;
    }
    const wo = await getWorkOrder(woNo);
    if (!wo) {
      toast(`Work order ${woNo} not found.`);
      return;
    }
    overlay.remove();
    navigate("#/idns/new?woNo=" + encodeURIComponent(woNo));
  };
}

function renderStats(idns) {
  const statsEl = document.getElementById("dx-stats");
  if (!statsEl) return;
  const live = idns.filter((i) => !i.voided);
  const totalQty = live.reduce((sum, i) => sum + (i.qty || 0), 0);
  statsEl.innerHTML = `
    <div class="dx-stat"><div class="num">${idns.length}</div><div class="lbl">IDNs</div></div>
    <div class="dx-stat"><div class="num">${totalQty}</div><div class="lbl">Total pcs delivered</div></div>
    <div class="dx-stat"><div class="num">${new Set(live.map((i) => i.woNo)).size}</div><div class="lbl">Work orders covered</div></div>
  `;
}

function renderFiltered() {
  const listEl = document.getElementById("idn-list");
  const tableBody = document.getElementById("idn-table-body");
  if (!listEl || !tableBody) return;

  renderStats(allIdns);

  const q = (document.getElementById("search-input").value || "").toLowerCase().trim();
  const matches = allIdns
    .filter((idn) => {
      if (!q) return true;
      const hay = [idn.idnNo, idn.woNo, idn.partNo].join(" ").toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  if (allIdns.length === 0) {
    const empty = `<div class="empty-state">No delivery notes yet — generate one from a work order, or tap + New.</div>`;
    listEl.innerHTML = empty;
    tableBody.innerHTML = `<tr><td colspan="5" style="padding:0;border:none;">${empty}</td></tr>`;
    return;
  }

  if (matches.length === 0) {
    const empty = `<div class="empty-state">No delivery notes match.</div>`;
    listEl.innerHTML = empty;
    tableBody.innerHTML = `<tr><td colspan="5" style="padding:0;border:none;">${empty}</td></tr>`;
    return;
  }

  listEl.innerHTML = matches
    .map(
      (idn) => `
        <div class="item-card" data-idn="${esc(idn.idnNo)}" style="${idn.voided ? "opacity:.55;" : ""}">
          <div class="item-card-main">
            <div class="item-stock-number mono">${esc(idn.idnNo)}${idn.voided ? ` <span class="type-badge type-badge--cancelled" style="text-decoration:none;">VOIDED</span>` : ""}</div>
            <div class="item-secondary">${esc(idn.partNo)} · ${esc(idn.woNo)} · ${formatDate(idn.date)}</div>
          </div>
          <div class="item-card-qty">
            <div class="item-qty mono">${idn.qty} pcs</div>
          </div>
        </div>
      `
    )
    .join("");

  tableBody.innerHTML = matches
    .map(
      (idn) => `
        <tr data-idn="${esc(idn.idnNo)}" style="${idn.voided ? "opacity:.55;" : ""}">
          <td class="mono">${esc(idn.idnNo)}${idn.voided ? ` <span class="type-badge type-badge--cancelled" style="text-decoration:none;">VOIDED</span>` : ""}</td>
          <td class="mono">${esc(idn.woNo)}</td>
          <td class="mono">${esc(idn.partNo)}</td>
          <td class="mono" style="text-align:right;">${idn.qty} pcs</td>
          <td>${formatDate(idn.date)}</td>
        </tr>
      `
    )
    .join("");

  document.querySelectorAll(".item-card[data-idn], #idn-table-body tr[data-idn]").forEach((row) => {
    row.onclick = () => navigate("#/idns/" + encodeURIComponent(row.dataset.idn));
  });
}
