/* Shared "Take stock" / "Book in" modal, also reused by the form's "Adjust quantity" action. */

import { esc, toast } from "./render.js";
import { recordTransaction, listWorkOrders, areaQty, AREA_LABELS } from "./db.js";
import { populateUserSelect, wireUserSelect, resolveUser } from "./users.js";

export function openQtyModal({ item, type, area, fixedNote, hideWorkOrder, onDone }) {
  const isTake = type === "take";
  // Book-in is stock arriving, not consumption, so it's never tied to a
  // work order; a manual correction (hideWorkOrder) isn't real consumption
  // either.
  const showWorkOrder = isTake && !hideWorkOrder;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">${isTake ? "− Take stock" : "+ Book in"} — ${esc(AREA_LABELS[area])}</div>
      <div class="modal-sub">${esc(item.partNumber)}</div>

      <div class="form-group">
        <label>Quantity (pcs)</label>
        <input type="number" id="modal-qty" min="1" step="1" inputmode="numeric" autofocus />
      </div>

      <div class="form-group">
        <label>User name</label>
        <select id="modal-user"></select>
      </div>

      <div class="form-group" id="modal-other-wrap" style="display:none;">
        <label>Name</label>
        <input type="text" id="modal-other-name" placeholder="Name" />
      </div>

      ${
        showWorkOrder
          ? `<div class="form-group">
               <label>Work order (optional)</label>
               <select id="modal-work-order">
                 <option value="">No work order</option>
               </select>
             </div>`
          : ""
      }

      <div class="form-group">
        <label>Note (optional)</label>
        <input type="text" id="modal-note" placeholder="Job / part reference" value="${esc(fixedNote || "")}" />
      </div>

      <div class="btn-row">
        <button class="btn" id="modal-cancel">Cancel</button>
        <button class="btn ${isTake ? "danger" : "primary-lime"}" id="modal-confirm">Confirm</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();

  overlay.querySelector("#modal-cancel").onclick = close;
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  const userSelect = overlay.querySelector("#modal-user");
  const otherWrap = overlay.querySelector("#modal-other-wrap");
  populateUserSelect(userSelect);
  wireUserSelect(userSelect, otherWrap);

  const woSelect = overlay.querySelector("#modal-work-order");
  if (woSelect) {
    listWorkOrders().then((orders) => {
      const active = orders.filter((wo) => wo.status !== "Complete");
      woSelect.innerHTML =
        `<option value="">No work order</option>` +
        active
          .map((wo) => `<option value="${esc(wo.woNo)}">${esc(wo.woNo)} — ${esc(wo.partName || wo.partNo || "")}</option>`)
          .join("");
    });
  }

  overlay.querySelector("#modal-confirm").onclick = async () => {
    const qty = Number(overlay.querySelector("#modal-qty").value);
    if (!qty || qty <= 0) {
      toast("Enter a quantity greater than 0.");
      return;
    }
    if (isTake) {
      const available = areaQty(item, area);
      if (qty > available) {
        const proceed = window.confirm(
          `Only ${available} pcs of ${item.partNumber} in ${AREA_LABELS[area]}. Taking ${qty} will leave this at ${available - qty} (negative). Proceed anyway?`
        );
        if (!proceed) return;
      }
    }
    const user = await resolveUser(userSelect, overlay.querySelector("#modal-other-name"));
    if (!user) {
      toast("Enter a name.");
      return;
    }
    const note = overlay.querySelector("#modal-note").value.trim();
    const workOrderNumber = woSelect ? woSelect.value : "";

    /*
      Firestore's write promise doesn't resolve until the server acks it -
      on patchy shop wifi that can take a while, or never until back online.
      The local cache already applies the write (and the item's onSnapshot
      listener) optimistically and instantly, so close the modal right away
      instead of blocking on the network round trip; only report a problem
      if the write eventually, genuinely fails.
    */
    close();
    toast(isTake ? "Stock taken." : "Stock booked in.");
    onDone && onDone();
    recordTransaction(item, { type, qty, user, note, workOrderNumber, area }).catch((err) => {
      console.error(err);
      toast("Couldn't save that change - check your connection.");
    });
  };
}
