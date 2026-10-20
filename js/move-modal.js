/* "Move stock between areas" modal - shifts qty from one area's count to
   another for the same part (e.g. Farm -> Production before a work order
   can deduct it). Opened from an item's area cards. */

import { esc, toast } from "./render.js";
import { AREAS, AREA_LABELS, areaQty, moveStockBetweenAreas } from "./db.js";
import { populateUserSelect, wireUserSelect, resolveUser } from "./users.js";

export function openMoveModal({ item, fromArea, onDone }) {
  const otherAreas = AREAS.filter((a) => a !== fromArea);
  const fromQty = areaQty(item, fromArea);

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">Move stock</div>
      <div class="modal-sub">${esc(item.partNumber)} · ${esc(AREA_LABELS[fromArea])} has ${fromQty} pcs on hand.</div>

      <div class="form-group">
        <label>To</label>
        <select id="move-to-area">
          ${otherAreas.map((a) => `<option value="${a}">${esc(AREA_LABELS[a])}</option>`).join("")}
        </select>
      </div>

      <div class="form-group">
        <label>Qty to move</label>
        <input type="number" id="move-qty" min="1" max="${fromQty}" step="1" inputmode="numeric" autofocus />
      </div>

      <div class="form-group">
        <label>User name</label>
        <select id="move-user"></select>
      </div>
      <div class="form-group" id="move-other-wrap" style="display:none;">
        <label>Name</label>
        <input id="move-other-name" placeholder="Name" />
      </div>

      <div class="btn-row">
        <button class="btn" id="move-cancel">Cancel</button>
        <button class="btn primary-lime" id="move-confirm">Move stock</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const userSelect = overlay.querySelector("#move-user");
  const otherWrap = overlay.querySelector("#move-other-wrap");
  populateUserSelect(userSelect);
  wireUserSelect(userSelect, otherWrap);

  overlay.querySelector("#move-cancel").onclick = () => overlay.remove();
  overlay.querySelector("#move-confirm").onclick = async () => {
    const qty = Number(overlay.querySelector("#move-qty").value);
    if (!qty || qty <= 0) {
      toast("Enter a quantity greater than 0.");
      return;
    }
    if (qty > fromQty) {
      toast(`${AREA_LABELS[fromArea]} only has ${fromQty} pcs.`);
      return;
    }
    const toArea = overlay.querySelector("#move-to-area").value;
    const user = await resolveUser(userSelect, overlay.querySelector("#move-other-name"));
    if (!user) {
      toast("Enter a name.");
      return;
    }

    overlay.remove();
    toast(`Moved to ${AREA_LABELS[toArea]}.`);
    onDone && onDone();
    moveStockBetweenAreas(item, { fromArea, toArea, qty, user }).catch((err) => {
      console.error(err);
      toast("Couldn't save that change - check your connection.");
    });
  };
}
