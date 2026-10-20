/* Shared "which part?" step for the Stock Management board's global
   + Add / - Take / Move actions - lets you act on any part directly from
   the board, without opening its detail page first. */

import { esc } from "./render.js";
import { areaQty, areaLocation, AREA_LABELS } from "./db.js";

export function openPartPickerModal({ items, area, requireQty, title, onPick }) {
  const eligible = requireQty ? items.filter((item) => areaQty(item, area) > 0) : items;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">${esc(title)}</div>
      <div class="modal-sub">${esc(AREA_LABELS[area])}</div>
      <div class="form-group">
        <input type="search" id="picker-search" placeholder="Search part number, name, location…" autofocus />
      </div>
      <div class="log-list" id="picker-list" style="max-height:50vh;overflow-y:auto;"></div>
      <div class="btn-row">
        <button class="btn" id="picker-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.querySelector("#picker-cancel").onclick = () => overlay.remove();

  function renderList(query) {
    const listEl = overlay.querySelector("#picker-list");
    const q = (query || "").toLowerCase().trim();
    const matches = eligible.filter((item) => {
      if (!q) return true;
      const loc = areaLocation(item, area);
      return (item.partNumber + " " + (item.partName || "") + " " + loc).toLowerCase().includes(q);
    });

    if (matches.length === 0) {
      listEl.innerHTML = `<div class="empty-state">${eligible.length === 0 ? "No parts with stock here yet." : "No matches."}</div>`;
      return;
    }

    listEl.innerHTML = matches
      .map((item) => {
        const qty = areaQty(item, area);
        const loc = areaLocation(item, area);
        return `
          <div class="log-row part-pick-row" data-part="${esc(item.partNumber)}" style="cursor:pointer;">
            <span class="log-mid mono" style="font-weight:700;">${esc(item.partNumber)}${item.partName ? " · " + esc(item.partName) : ""}</span>
            <span class="log-mid">${loc ? esc(loc) + " · " : ""}${qty} pcs</span>
          </div>
        `;
      })
      .join("");

    listEl.querySelectorAll("[data-part]").forEach((row) => {
      row.onclick = () => {
        const item = eligible.find((i) => i.partNumber === row.dataset.part);
        overlay.remove();
        onPick(item);
      };
    });
  }

  overlay.querySelector("#picker-search").oninput = (e) => renderList(e.target.value);
  renderList("");
}
