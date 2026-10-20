/* Book in stock for a part - creates a Batch row, and (if a raw stock item
   is linked) also books the qty into that item's area ledger. */

import { esc, mount, toast } from "../render.js";
import { listStockItems, getStockItem, suggestNextBatchNumber, bookInStockForPart, AREAS, AREA_LABELS } from "../db.js";
import { populateUserSelect, wireUserSelect, resolveUser } from "../users.js";
import { navigate } from "../../app.js";

export async function renderStockInView() {
  const stockItems = await listStockItems();

  mount(`
    <header class="topbar">
      <button class="icon-btn" id="btn-back" aria-label="Back">&larr;</button>
      <div class="topbar-title">Book in stock</div>
    </header>

    <div class="form-group">
      <label>Part no.</label>
      <input id="in-part-no" placeholder="e.g. DEX05120234" required />
    </div>

    <div class="form-group">
      <label>Linked stock item (optional)</label>
      <select id="in-stock-number">
        <option value="">No linked stock item</option>
        ${stockItems.map((s) => `<option value="${esc(s.partNumber)}" data-yield="${esc(s.piecesPerBlank || 1)}">${esc(s.partNumber)}${s.partName ? " — " + esc(s.partName) : ""}</option>`).join("")}
      </select>
      <div class="hint">Leave blank to just log the batch - you can link it later by re-entering this batch on a future book-in.</div>
    </div>

    <div class="form-group" id="in-area-wrap" style="display:none;">
      <label>Area</label>
      <select id="in-area">
        ${AREAS.map((a) => `<option value="${a}">${esc(AREA_LABELS[a])}</option>`).join("")}
      </select>
    </div>

    <div class="form-grid2">
      <div class="form-group">
        <label>Blanks received</label>
        <input id="in-blanks" type="number" min="1" step="1" value="1" inputmode="numeric" required />
      </div>
      <div class="form-group">
        <label>Pieces per blank</label>
        <input id="in-yield" type="number" min="1" step="1" value="1" inputmode="numeric" required />
      </div>
    </div>
    <div class="compute-preview" id="in-preview">= 1 pcs added</div>

    <div class="form-group">
      <label>User name</label>
      <select id="in-user"></select>
    </div>
    <div class="form-group" id="in-other-wrap" style="display:none;">
      <label>Name</label>
      <input id="in-other-name" placeholder="Name" />
    </div>

    <div class="btn-row">
      <button class="btn primary-lime" id="btn-submit-in">Book in stock</button>
    </div>
  `);

  document.getElementById("btn-back").onclick = () => history.back();

  const userSelect = document.getElementById("in-user");
  const otherWrap = document.getElementById("in-other-wrap");
  populateUserSelect(userSelect);
  wireUserSelect(userSelect, otherWrap);

  const stockSelect = document.getElementById("in-stock-number");
  const areaWrap = document.getElementById("in-area-wrap");
  const yieldInput = document.getElementById("in-yield");
  stockSelect.onchange = () => {
    const opt = stockSelect.options[stockSelect.selectedIndex];
    areaWrap.style.display = stockSelect.value ? "block" : "none";
    if (stockSelect.value) yieldInput.value = opt.dataset.yield || 1;
    renderPreview();
  };

  document.getElementById("in-blanks").oninput = renderPreview;
  yieldInput.oninput = renderPreview;
  renderPreview();

  document.getElementById("btn-submit-in").onclick = submit;
}

function renderPreview() {
  const blanks = Number(document.getElementById("in-blanks").value) || 0;
  const yieldPer = Number(document.getElementById("in-yield").value) || 0;
  document.getElementById("in-preview").textContent = "= " + blanks * yieldPer + " pcs added";
}

async function submit() {
  const partNo = document.getElementById("in-part-no").value.trim();
  const blanksReceived = Number(document.getElementById("in-blanks").value);
  const piecesPerBlank = Number(document.getElementById("in-yield").value);
  const qtyAdded = blanksReceived * piecesPerBlank;
  const linkedPartNumber = document.getElementById("in-stock-number").value;
  const area = document.getElementById("in-area").value;

  if (!partNo) {
    toast("Enter a part no.");
    return;
  }
  if (!qtyAdded || qtyAdded <= 0) {
    toast("Enter blanks received and pieces per blank greater than 0.");
    return;
  }

  const user = await resolveUser(document.getElementById("in-user"), document.getElementById("in-other-name"));
  if (!user) {
    toast("Enter a name.");
    return;
  }

  const submitBtn = document.getElementById("btn-submit-in");
  submitBtn.disabled = true;
  submitBtn.textContent = "Saving…";

  try {
    const linkedStockItem = linkedPartNumber ? await getStockItem(linkedPartNumber) : null;
    const batchNo = await suggestNextBatchNumber(partNo);
    await bookInStockForPart({
      batchNo,
      partNo,
      qtyAdded,
      blanksReceived,
      piecesPerBlank,
      bookInDate: Date.now(),
      user,
      linkedStockItem,
      area
    });
    toast(`Batch ${batchNo} booked in.`);
    navigate(linkedStockItem ? "#/item/" + encodeURIComponent(linkedStockItem.partNumber) : "#/work-orders");
  } catch (err) {
    console.error(err);
    submitBtn.disabled = false;
    submitBtn.textContent = "Book in stock";
    toast("Couldn't save — check your connection and try again.");
  }
}
