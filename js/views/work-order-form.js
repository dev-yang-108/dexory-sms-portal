/* New work order: Part Master lookup (or inline new-part capture), qty,
   comment, batch pick, and - if the part has a linked raw stock item -
   an atomic stock deduction with an over-quantity warning. */

import { esc, mount, toast } from "../render.js";
import {
  getPartMaster,
  listBatchesForPart,
  suggestNextWorkOrderNumber,
  suggestReworkWoNumber,
  createWorkOrderWithDeduction,
  getStockItem,
  areaQty,
  DEDUCTION_AREA
} from "../db.js";
import { populateUserSelect, wireUserSelect, resolveUser } from "../users.js";
import { navigate } from "../../app.js";

// Set once a lookup (found or not-found) has run, so submit knows what to write.
let foundPart = null; // PartMaster doc, or null if not found
let lookedUpPartNo = "";
let lookedUpRev = "";
// Cached once the linked stock item field resolves, so the qty field can
// show a live Production-availability check without refetching on every
// keystroke.
let linkedItemCache = null;
// Set when this form was reached via "Duplicate" on a Complete order - the
// new order gets a linked "-RW" number and a back-reference instead of a
// plain sequential one.
let reworkOfWoNo = "";

export async function renderWorkOrderFormView(initial) {
  const opts = initial || {};
  foundPart = null;
  lookedUpPartNo = "";
  lookedUpRev = "";
  linkedItemCache = null;
  reworkOfWoNo = opts.reworkOf || "";

  mount(`
    <header class="topbar">
      <button class="icon-btn" id="btn-back" aria-label="Back">&larr;</button>
      <div class="topbar-title">New work order</div>
    </header>

    ${
      reworkOfWoNo
        ? `<div class="info-banner">Rework of <b>${esc(reworkOfWoNo)}</b> - this order gets a linked ${esc(reworkOfWoNo)}-RW style number automatically.</div>`
        : ""
    }

    <div class="form-grid2">
      <div class="form-group">
        <label>Part no.</label>
        <input id="wo-part-no" value="${esc(opts.partNo || "")}" placeholder="e.g. DEX05120234" />
      </div>
      <div class="form-group">
        <label>Rev</label>
        <input id="wo-rev" value="${esc(opts.rev || "")}" placeholder="e.g. 10" />
      </div>
    </div>
    <div class="btn-row">
      <button class="btn" id="btn-lookup">Look up part</button>
    </div>

    <div id="wo-rest" style="display:none;"></div>
  `);

  document.getElementById("btn-back").onclick = () => history.back();
  document.getElementById("btn-lookup").onclick = () => runLookup(opts);

  if (opts.partNo && opts.rev) {
    await runLookup(opts);
  }
}

async function runLookup(opts) {
  const partNo = document.getElementById("wo-part-no").value.trim();
  const rev = document.getElementById("wo-rev").value.trim();
  if (!partNo || !rev) {
    toast("Enter both part no. and rev first.");
    return;
  }

  lookedUpPartNo = partNo;
  lookedUpRev = rev;
  foundPart = await getPartMaster(partNo, rev);

  const batches = await listBatchesForPart(partNo);
  const restEl = document.getElementById("wo-rest");
  restEl.style.display = "block";

  const qtyPrefill = opts.qty || "";
  const commentPrefill = opts.comment || (foundPart ? foundPart.defaultComment : "");
  const linkedStockPrefill = foundPart ? foundPart.linkedStockNumber || "" : "";

  restEl.innerHTML = `
    ${
      foundPart
        ? `<section>
             <div class="section-title">Part found</div>
             <div class="kv">
               <div class="kv-row"><span class="k">Part name</span><span class="v">${esc(foundPart.partName)}</span></div>
               <div class="kv-row"><span class="k">Unit per robot</span><span class="v">${esc(foundPart.unitPerRobot)} pcs</span></div>
             </div>
           </section>`
        : `<div class="info-banner">Part ${esc(partNo)} rev ${esc(rev)} hasn't been used before — fill in these details once and it'll be remembered next time.</div>
           <div class="form-group">
             <label>Part name</label>
             <input id="wo-new-part-name" placeholder="e.g. Gearbox housing" required />
           </div>
           <div class="form-group">
             <label>Unit per robot</label>
             <input id="wo-new-unit-per-robot" type="number" min="1" step="1" value="1" required />
           </div>
           <div class="form-group">
             <label>Default comment</label>
             <input id="wo-new-default-comment" placeholder="Used to prefill future work orders for this part" />
           </div>`
    }

    <div class="form-group">
      <label>Linked stock item - part no. (optional)</label>
      <input id="wo-linked-stock" class="mono" value="${esc(linkedStockPrefill)}" placeholder="e.g. DEX05120234" />
      <div class="hint">The raw stock item's own part number. Leave blank if this work order doesn't deduct from a tracked raw stock item. Deducts from Production specifically - never Farm or Prototype.</div>
    </div>

    <div class="form-group">
      <label>Qty (pcs)</label>
      <input id="wo-qty" type="number" min="1" step="1" value="${esc(qtyPrefill)}" inputmode="numeric" />
      <div id="wo-production-check"></div>
    </div>

    <div class="form-group">
      <label>Comment</label>
      <input id="wo-comment" value="${esc(commentPrefill)}" placeholder="Optional" />
    </div>

    <div class="form-group">
      <label>Batch</label>
      <select id="wo-batch">
        <option value="" selected>Select a batch…</option>
        ${batchOptionsHTML(batches)}
      </select>
      ${batches.length === 0 ? `<div class="hint">No batches booked in yet for this part.</div>` : ""}
    </div>

    <div class="chip-row" style="padding:0 16px;">
      <button type="button" class="chip-toggle" id="btn-toggle-second-batch">+ Split across a second CoC/batch</button>
    </div>
    <div class="form-group" id="wo-batch2-wrap" style="display:none;">
      <label>Second batch</label>
      <select id="wo-batch2">
        <option value="" selected>Select a batch…</option>
        ${batchOptionsHTML(batches)}
      </select>
      <div class="hint">Used when this order's material is drawn from two different CoC receipts (e.g. 10 pcs from one, 10 from the other) - both show on the order as "A" and "B".</div>
      <div class="form-grid2" style="margin-top:8px;">
        <div class="form-group">
          <label>Qty from A</label>
          <input id="wo-batch1-qty" type="number" min="0" step="1" inputmode="numeric" />
        </div>
        <div class="form-group">
          <label>Qty from B</label>
          <input id="wo-batch2-qty" type="number" min="0" step="1" inputmode="numeric" />
        </div>
      </div>
    </div>

    <div class="form-group">
      <label>User name</label>
      <select id="wo-user"></select>
    </div>
    <div class="form-group" id="wo-other-wrap" style="display:none;">
      <label>Name</label>
      <input id="wo-other-name" placeholder="Name" />
    </div>

    <div class="btn-row">
      <button class="btn primary-lime" id="btn-submit-wo">Create work order</button>
    </div>
  `;

  const userSelect = document.getElementById("wo-user");
  const otherWrap = document.getElementById("wo-other-wrap");
  populateUserSelect(userSelect);
  wireUserSelect(userSelect, otherWrap);

  const linkedInput = document.getElementById("wo-linked-stock");
  const qtyInput = document.getElementById("wo-qty");
  const refreshCheck = async () => {
    const partNo = linkedInput.value.trim();
    if (!partNo) {
      linkedItemCache = null;
      document.getElementById("wo-production-check").innerHTML = "";
      return;
    }
    linkedItemCache = await getStockItem(partNo);
    renderProductionCheck();
  };
  linkedInput.onblur = refreshCheck;
  qtyInput.oninput = renderProductionCheck;
  if (linkedStockPrefill) refreshCheck();

  const batch2Wrap = document.getElementById("wo-batch2-wrap");
  document.getElementById("btn-toggle-second-batch").onclick = (e) => {
    const nowOpen = batch2Wrap.style.display === "none";
    batch2Wrap.style.display = nowOpen ? "block" : "none";
    e.target.classList.toggle("is-active", nowOpen);
  };

  document.getElementById("btn-submit-wo").onclick = submitWorkOrder;
}

function batchOptionsHTML(batches) {
  return batches
    .map((b) => `<option value="${esc(b.batchNo)}">${esc(b.batchNo)} (${esc(b.qtyAdded)} pcs, ${new Date(b.bookInDate).toLocaleDateString()})</option>`)
    .join("");
}

function renderProductionCheck() {
  const box = document.getElementById("wo-production-check");
  if (!box) return;
  if (!linkedItemCache) {
    box.innerHTML = "";
    return;
  }
  const qty = Number(document.getElementById("wo-qty").value) || 0;
  const available = areaQty(linkedItemCache, DEDUCTION_AREA);
  if (qty > available) {
    box.innerHTML = `<div class="warn-box">Production only has ${available} pcs of ${esc(linkedItemCache.partNumber)}. Move ${qty - available} more from Farm/Prototype into Production before creating this order.</div>`;
  } else {
    box.innerHTML = `<div class="ok-box">Production has ${available} pcs of ${esc(linkedItemCache.partNumber)} available.</div>`;
  }
}

async function submitWorkOrder() {
  const partNo = lookedUpPartNo;
  const rev = lookedUpRev;
  const qty = Number(document.getElementById("wo-qty").value);
  const comment = document.getElementById("wo-comment").value.trim();
  const batch1No = document.getElementById("wo-batch").value;

  if (!qty || qty <= 0) {
    toast("Enter a quantity greater than 0.");
    return;
  }

  // The second-CoC split is opt-in (hidden until "+ Split across a second
  // CoC/batch" is clicked) - only build cocDraws/combine the display string
  // when it's actually open and a second batch was picked.
  const batch2Wrap = document.getElementById("wo-batch2-wrap");
  const splitOpen = batch2Wrap.style.display !== "none";
  const batch2No = splitOpen ? document.getElementById("wo-batch2").value : "";

  let batchNo = batch1No;
  let cocDraws = [];
  if (splitOpen && batch1No && batch2No) {
    const qtyA = Number(document.getElementById("wo-batch1-qty").value) || 0;
    const qtyB = Number(document.getElementById("wo-batch2-qty").value) || 0;
    batchNo = `${batch1No} (A) + ${batch2No} (B)`;
    cocDraws = [
      { batchNo: batch1No, label: "A", qtyDrawn: qtyA },
      { batchNo: batch2No, label: "B", qtyDrawn: qtyB }
    ];
  }

  const user = await resolveUser(document.getElementById("wo-user"), document.getElementById("wo-other-name"));
  if (!user) {
    toast("Enter a name.");
    return;
  }

  const linkedStockNumber = document.getElementById("wo-linked-stock").value.trim();

  let partName;
  let newPartMaster = null;
  let updatePartMasterLinkedStock;

  if (foundPart) {
    partName = foundPart.partName;
    if (linkedStockNumber !== (foundPart.linkedStockNumber || "")) {
      updatePartMasterLinkedStock = linkedStockNumber;
    }
  } else {
    const partNameInput = document.getElementById("wo-new-part-name").value.trim();
    const unitPerRobot = Number(document.getElementById("wo-new-unit-per-robot").value) || 1;
    if (!partNameInput) {
      toast("Enter a part name.");
      return;
    }
    const defaultComment = document.getElementById("wo-new-default-comment").value.trim();
    partName = partNameInput;
    newPartMaster = {
      partNo,
      rev,
      partName: partNameInput,
      unitPerRobot,
      linkedStockNumber,
      defaultComment
    };
  }

  let linkedStockItem = null;
  if (linkedStockNumber) {
    linkedStockItem = await getStockItem(linkedStockNumber);
    if (!linkedStockItem) {
      const proceed = window.confirm(
        `Stock item with part no. "${linkedStockNumber}" doesn't exist. Create this work order without deducting any stock?`
      );
      if (!proceed) return;
    } else if (qty > areaQty(linkedStockItem, DEDUCTION_AREA)) {
      const available = areaQty(linkedStockItem, DEDUCTION_AREA);
      toast(`Production only has ${available} pcs of ${linkedStockItem.partNumber}. Move ${qty - available} more into Production before creating this order.`);
      return;
    }
  }

  const submitBtn = document.getElementById("btn-submit-wo");
  submitBtn.disabled = true;
  submitBtn.textContent = "Creating…";

  try {
    const woNo = reworkOfWoNo ? await suggestReworkWoNumber(reworkOfWoNo) : await suggestNextWorkOrderNumber();
    await createWorkOrderWithDeduction({
      woNo,
      partNo,
      rev,
      partName,
      qty,
      batchNo,
      cocDraws,
      comment,
      user,
      newPartMaster,
      updatePartMasterLinkedStock,
      linkedStockItem,
      reworkOf: reworkOfWoNo
    });
    toast("Work order created.");
    navigate("#/work-orders/" + encodeURIComponent(woNo));
  } catch (err) {
    console.error(err);
    submitBtn.disabled = false;
    submitBtn.textContent = "Create work order";
    toast("Couldn't save — check your connection and try again.");
  }
}
