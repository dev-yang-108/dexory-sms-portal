/* Edit an existing work order: qty, comment, batch, and raw stock no. are
   all editable - changes to qty/linked stock reconcile the stock ledger
   with a fresh adjustment transaction rather than rewriting history. */

import { esc, mount, toast } from "../render.js";
import { getWorkOrder, getStockItem, listBatchesForPart, updateWorkOrderReconciled, areaQty, DEDUCTION_AREA } from "../db.js";
import { populateUserSelect, wireUserSelect, resolveUser } from "../users.js";
import { navigate } from "../../app.js";

export async function renderWorkOrderEditView(woNo) {
  const wo = await getWorkOrder(woNo);
  if (!wo) {
    mount(`<div class="empty-state">Work order not found.</div>`);
    return;
  }

  const batches = await listBatchesForPart(wo.partNo);

  mount(`
    <header class="topbar">
      <button class="icon-btn" id="btn-back" aria-label="Back">&larr;</button>
      <div class="topbar-title">Edit work order</div>
    </header>

    <section>
      <div class="kv">
        <div class="kv-row"><span class="k">WO no.</span><span class="v">${esc(wo.woNo)}</span></div>
        <div class="kv-row"><span class="k">Part no.</span><span class="v">${esc(wo.partNo)}</span></div>
        <div class="kv-row"><span class="k">Part name</span><span class="v">${esc(wo.partName)}</span></div>
        <div class="kv-row"><span class="k">Rev</span><span class="v">R${esc(wo.rev)}</span></div>
      </div>
    </section>

    <div class="form-group">
      <label>Qty (pcs)</label>
      <input id="edit-qty" type="number" min="1" step="1" value="${esc(wo.qty)}" inputmode="numeric" />
    </div>

    <div class="form-group">
      <label>Comment</label>
      <input id="edit-comment" value="${esc(wo.comment)}" placeholder="Optional" />
    </div>

    <div class="form-group">
      <label>Linked stock item - part no. (optional)</label>
      <input id="edit-linked-stock" class="mono" value="${esc(wo.linkedStockNumber)}" placeholder="e.g. DEX05120234" />
      <div class="hint">Changing this or the qty adjusts stock with a new transaction - it never rewrites what already happened.</div>
    </div>

    <div class="form-group">
      <label>Batch</label>
      <select id="edit-batch">
        <option value="">No batch</option>
        ${batches
          .map(
            (b) =>
              `<option value="${esc(b.batchNo)}" ${b.batchNo === wo.batchNo ? "selected" : ""}>${esc(b.batchNo)} (${esc(b.qtyAdded)} pcs, ${new Date(b.bookInDate).toLocaleDateString()})</option>`
          )
          .join("")}
      </select>
    </div>

    <div class="form-group">
      <label>User name</label>
      <select id="edit-user"></select>
    </div>
    <div class="form-group" id="edit-other-wrap" style="display:none;">
      <label>Name</label>
      <input id="edit-other-name" placeholder="Name" />
    </div>

    <div class="btn-row">
      <button class="btn primary-lime" id="btn-save-wo">Save changes</button>
    </div>
  `);

  document.getElementById("btn-back").onclick = () => navigate("#/work-orders/" + encodeURIComponent(wo.woNo));

  const userSelect = document.getElementById("edit-user");
  const otherWrap = document.getElementById("edit-other-wrap");
  populateUserSelect(userSelect);
  wireUserSelect(userSelect, otherWrap);

  document.getElementById("btn-save-wo").onclick = () => submit(wo);
}

async function submit(wo) {
  const qty = Number(document.getElementById("edit-qty").value);
  if (!qty || qty <= 0) {
    toast("Enter a quantity greater than 0.");
    return;
  }
  const comment = document.getElementById("edit-comment").value.trim();
  const batchNo = document.getElementById("edit-batch").value;
  const linkedStockNumber = document.getElementById("edit-linked-stock").value.trim();

  const user = await resolveUser(document.getElementById("edit-user"), document.getElementById("edit-other-name"));
  if (!user) {
    toast("Enter a name.");
    return;
  }

  const oldLinked = wo.linkedStockNumber || "";
  const oldQty = wo.qty || 0;

  // Same over-quantity check as creating a work order, just against
  // whatever the net new draw on each item would be - always a hard block
  // against Production specifically, never an override.
  if (oldLinked === linkedStockNumber) {
    if (linkedStockNumber && qty > oldQty) {
      const item = await getStockItem(linkedStockNumber);
      const extra = qty - oldQty;
      const available = item ? areaQty(item, DEDUCTION_AREA) : 0;
      if (item && extra > available) {
        toast(`This needs ${extra} more pcs than before, but Production only has ${available} pcs of ${item.partNumber}. Move stock into Production first.`);
        return;
      }
    }
  } else if (linkedStockNumber) {
    const item = await getStockItem(linkedStockNumber);
    if (!item) {
      const proceed = window.confirm(`Stock item with part no. "${linkedStockNumber}" doesn't exist. Save without deducting any stock from it?`);
      if (!proceed) return;
    } else if (qty > areaQty(item, DEDUCTION_AREA)) {
      const available = areaQty(item, DEDUCTION_AREA);
      toast(`Production only has ${available} pcs of ${item.partNumber}, but this needs ${qty}. Move stock into Production first.`);
      return;
    }
  }

  const btn = document.getElementById("btn-save-wo");
  btn.disabled = true;
  btn.textContent = "Saving…";

  try {
    await updateWorkOrderReconciled(wo, { qty, comment, batchNo, linkedStockNumber, user });
    toast("Work order updated.");
    navigate("#/work-orders/" + encodeURIComponent(wo.woNo));
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = "Save changes";
    toast("Couldn't save — check your connection and try again.");
  }
}
