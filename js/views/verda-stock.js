/* Prototype Stock: a simplified, separate page for one-off/odd-size
   Prototype stock (the "prototype" area - see AREA_LABELS in db.js).
   Deliberately a much shorter field set than the main Stock Management
   board - Part No./Name, Stock size, Material, Location, Qty and Comments
   only. Rev and the robot-cycle rates don't apply here: Prototype stock is
   one-off/odd-size material, not something a robot consumes repeatably, so
   this page never shows or asks for them.

   Booking qty in/out of an existing part's Prototype stock reuses the same
   part-picker + qty-modal flow as the main board's own +Add/-Take (just
   pinned to the "prototype" area) - only creating a brand new part that's
   never been in the catalog before gets its own lightweight form here.

   File/route/function names here still say "verda" - that's just the
   internal name this page was first built under, not shown to the user
   anywhere; renaming source files mid-project isn't worth the churn for a
   label that only ever mattered in the UI text.
*/

import { esc, mount, toast, setViewCleanup } from "../render.js";
import { subscribeStockItems, getStockItem, createStockItem, blankStockItem, recordTransaction, areaQty, areaLocation, FORMS } from "../db.js";
import { dxNavHTML, wireSectionNav } from "../section-nav.js";
import { openPartPickerModal } from "../part-picker-modal.js";
import { openQtyModal } from "../qty-modal.js";
import { populateUserSelect, wireUserSelect, resolveUser } from "../users.js";
import { navigate } from "../../app.js";

const AREA = "prototype";

let itemsUnsub = null;
let allItems = [];
let showEmpty = false;

export function renderVerdaStockView() {
  if (itemsUnsub) itemsUnsub();

  mount(`
    <div class="dx-app">
      ${dxNavHTML("verda-stock")}
      <div class="dx-main">
        <div class="dx-content" style="max-width:900px;">
          <div class="dash-title">Prototype Stock</div>
          <div class="dash-sub">One-off/odd-size prototype stock - just the essentials, not the full Production record.</div>

          <div class="quick-actions">
            <button class="qa-add" id="btn-verda-add">+ Add existing part</button>
            <button class="qa-take" id="btn-verda-take">− Take</button>
            <button class="qa-coc" id="btn-verda-new">+ New Prototype item</button>
          </div>

          <div class="chip-row" style="padding:0 16px;">
            <input type="search" id="verda-search" placeholder="Search part number, name, material…" style="flex:1;" />
            <button class="chip-toggle ${showEmpty ? "is-active" : ""}" id="btn-verda-show-empty">Show 0 pcs too</button>
          </div>

          <div id="verda-body" style="padding:16px;"><div class="empty-state">Loading…</div></div>
        </div>
      </div>
    </div>
  `);

  wireSectionNav();

  document.getElementById("verda-search").oninput = renderBody;
  const showEmptyBtn = document.getElementById("btn-verda-show-empty");
  showEmptyBtn.onclick = () => {
    showEmpty = !showEmpty;
    showEmptyBtn.classList.toggle("is-active", showEmpty);
    renderBody();
  };

  document.getElementById("btn-verda-add").onclick = () =>
    openPartPickerModal({
      items: allItems,
      area: AREA,
      requireQty: false,
      title: "Add Prototype stock",
      onPick: (item) => openQtyModal({ item, type: "book-in", area: AREA, onDone: () => {} })
    });
  document.getElementById("btn-verda-take").onclick = () =>
    openPartPickerModal({
      items: allItems,
      area: AREA,
      requireQty: true,
      title: "Take Prototype stock",
      onPick: (item) => openQtyModal({ item, type: "take", area: AREA, onDone: () => {} })
    });
  document.getElementById("btn-verda-new").onclick = openNewVerdaItemModal;

  itemsUnsub = subscribeStockItems((items) => {
    allItems = items;
    renderBody();
  });

  setViewCleanup(() => {
    if (itemsUnsub) itemsUnsub();
    itemsUnsub = null;
  });
}

function renderBody() {
  const body = document.getElementById("verda-body");
  if (!body) return;

  const q = (document.getElementById("verda-search").value || "").toLowerCase().trim();
  const scoped = showEmpty ? allItems : allItems.filter((item) => areaQty(item, AREA) > 0);
  const matches = scoped.filter((item) => {
    if (!q) return true;
    const hay = [item.partNumber, item.partName, item.material].join(" ").toLowerCase();
    return hay.includes(q);
  });

  if (allItems.length === 0) {
    body.innerHTML = `<div class="empty-state">No stock items yet.</div>`;
    return;
  }
  if (matches.length === 0) {
    body.innerHTML = `<div class="empty-state">No parts match.</div>`;
    return;
  }

  body.innerHTML = `
    <table class="reject-table">
      <thead>
        <tr>
          <th>Part no.</th>
          <th>Part name</th>
          <th>Stock size</th>
          <th>Material</th>
          <th>Location</th>
          <th style="text-align:right;">Qty</th>
          <th>Comments</th>
        </tr>
      </thead>
      <tbody>
        ${matches
          .map(
            (item) => `
            <tr data-part="${esc(item.partNumber)}" style="cursor:pointer;">
              <td class="mono">${esc(item.partNumber)}</td>
              <td>${esc(item.partName) || "—"}</td>
              <td>${esc(item.stockSize) || "—"}</td>
              <td>${esc(item.material) || "—"}</td>
              <td>${esc(areaLocation(item, AREA)) || "—"}</td>
              <td class="mono" style="text-align:right;">${areaQty(item, AREA)} pcs</td>
              <td>${esc(item.comments) || "—"}</td>
            </tr>
          `
          )
          .join("")}
      </tbody>
    </table>
  `;

  body.querySelectorAll("tr[data-part]").forEach((row) => {
    row.onclick = () => navigate("#/item/" + encodeURIComponent(row.dataset.part));
  });
}

// Only for a part that's never existed in the catalog before - an existing
// part just uses "+ Add existing part" above instead, same as the main
// board's own +Add does for its areas.
function openNewVerdaItemModal() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">+ New Prototype item</div>
      <div class="modal-sub">For a part that isn't in the catalog yet. Only what Prototype stock actually needs.</div>

      <div class="form-group">
        <label>Part number</label>
        <input id="verda-new-partno" class="mono" placeholder="e.g. DEX05120234" />
      </div>
      <div class="form-group">
        <label>Part name</label>
        <input id="verda-new-partname" placeholder="e.g. Prototype bracket" />
      </div>
      <div class="form-group">
        <label>Stock size</label>
        <input id="verda-new-size" placeholder="e.g. 500 x 300 x 20mm" />
      </div>
      <div class="form-group">
        <label>Material</label>
        <input id="verda-new-material" placeholder="e.g. Aluminium 6082" />
      </div>
      <div class="form-group">
        <label>Qty (pcs)</label>
        <input id="verda-new-qty" type="number" min="1" step="1" inputmode="numeric" />
      </div>
      <div class="form-group">
        <label>Comments</label>
        <textarea id="verda-new-comments" placeholder="Anything worth flagging"></textarea>
      </div>
      <div class="form-group">
        <label>User name</label>
        <select id="verda-new-user"></select>
      </div>
      <div class="form-group" id="verda-new-other-wrap" style="display:none;">
        <label>Name</label>
        <input id="verda-new-other-name" placeholder="Name" />
      </div>

      <div class="btn-row">
        <button class="btn" id="verda-new-cancel">Cancel</button>
        <button class="btn primary-lime" id="verda-new-confirm">Create</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.querySelector("#verda-new-cancel").onclick = () => overlay.remove();

  const userSelect = overlay.querySelector("#verda-new-user");
  const otherWrap = overlay.querySelector("#verda-new-other-wrap");
  populateUserSelect(userSelect);
  wireUserSelect(userSelect, otherWrap);

  overlay.querySelector("#verda-new-confirm").onclick = async () => {
    const partNumber = overlay.querySelector("#verda-new-partno").value.trim();
    const partName = overlay.querySelector("#verda-new-partname").value.trim();
    const stockSize = overlay.querySelector("#verda-new-size").value.trim();
    const material = overlay.querySelector("#verda-new-material").value.trim();
    const qty = Number(overlay.querySelector("#verda-new-qty").value);
    const comments = overlay.querySelector("#verda-new-comments").value.trim();

    if (!partNumber) {
      toast("Enter a part number.");
      return;
    }
    if (!qty || qty <= 0) {
      toast("Enter a quantity greater than 0.");
      return;
    }
    const existing = await getStockItem(partNumber);
    if (existing) {
      toast(`Part number ${partNumber} already exists - use "+ Add existing part" instead.`);
      return;
    }
    const user = await resolveUser(userSelect, overlay.querySelector("#verda-new-other-name"));
    if (!user) {
      toast("Enter a name.");
      return;
    }

    const confirmBtn = overlay.querySelector("#verda-new-confirm");
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Creating…";

    try {
      const item = { ...blankStockItem(), partNumber, partName, stockSize, material, comments, form: FORMS[0], isPrototype: true };
      await createStockItem(item);
      await recordTransaction(item, { type: "book-in", qty, user, note: "New Prototype stock", area: AREA });
      toast("Prototype item created.");
      overlay.remove();
    } catch (err) {
      console.error(err);
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Create";
      toast("Couldn't save — check your connection and try again.");
    }
  };
}
