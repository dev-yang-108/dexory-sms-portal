/* New work order (procurement's side): find the part by any part of its
   number or name, Part Master lookup (or inline new-part capture), qty,
   comment, due date. Assignee and batch are left for the machine shop, who
   set them - and take the stock - when they pick the order up. */

import { esc, mount, toast } from "../render.js";
import {
  getPartMaster,
  listStockItems,
  suggestNextWorkOrderNumber,
  suggestReworkWoNumber,
  createWorkOrder,
  createProductionRequest,
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
// Every stock item, loaded once when the form opens - the part number box
// searches this as you type, and a picked part's name/rev come from it.
let stockItems = [];
// The raw stock item this part draws from, resolved once per lookup so the
// qty field can show a live Production-availability note without refetching
// on every keystroke.
let linkedItemCache = null;
// Set when this form was reached via "Duplicate" on a Complete order - the
// new order gets a linked "-RW" number and a back-reference instead of a
// plain sequential one.
let reworkOfWoNo = "";
// A Production Request (multi-week schedule) instead of a single work order
// - only ever opted into explicitly (see "+ Add weekly schedule instead"),
// never the default. scheduleWeeks is free-form: add/remove rows, each a
// {id, weekOf, qty}.
let scheduleMode = false;
let scheduleWeeks = [];
let weekSeq = 0;
// Preview-only - the real parent WO no. is only assigned at submit time (to
// avoid a race if two people open this form at once), but showing the
// numbering pattern (-1, -2, ...) while editing helps confirm the schedule
// looks right before creating it.
let previewWoNo = "";

export async function renderWorkOrderFormView(initial) {
  const opts = initial || {};
  foundPart = null;
  lookedUpPartNo = "";
  lookedUpRev = "";
  linkedItemCache = null;
  stockItems = [];
  reworkOfWoNo = opts.reworkOf || "";
  scheduleMode = false;
  scheduleWeeks = [];

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
        <input id="wo-part-no" value="${esc(opts.partNo || "")}" placeholder="Type the last 4 digits, e.g. 0234" autocomplete="off" />
        <div id="wo-part-suggest" class="part-suggest" style="display:none;"></div>
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

  const partInput = document.getElementById("wo-part-no");
  const suggestBox = document.getElementById("wo-part-suggest");
  const hideSuggestions = () => {
    suggestBox.style.display = "none";
    suggestBox.innerHTML = "";
  };
  partInput.oninput = () => {
    const q = partInput.value.trim().toLowerCase();
    const matches = q
      ? stockItems.filter((i) => `${i.partNumber} ${i.partName || ""}`.toLowerCase().includes(q)).slice(0, 8)
      : [];
    if (matches.length === 0) return hideSuggestions();
    suggestBox.innerHTML = matches
      .map(
        (i) => `<button type="button" class="part-suggest-row" data-part="${esc(i.partNumber)}">
          <span class="mono">${esc(i.partNumber)}</span><span class="part-suggest-name">${esc(i.partName || "")}</span>
        </button>`
      )
      .join("");
    suggestBox.style.display = "block";
    suggestBox.querySelectorAll("[data-part]").forEach((row) => {
      row.onclick = () => {
        const item = stockItems.find((i) => i.partNumber === row.dataset.part);
        partInput.value = item.partNumber;
        if (item.rev) document.getElementById("wo-rev").value = item.rev;
        hideSuggestions();
        if (document.getElementById("wo-rev").value.trim()) runLookup(opts);
        else document.getElementById("wo-rev").focus();
      };
    });
  };
  partInput.onblur = () => setTimeout(hideSuggestions, 150);

  stockItems = await listStockItems();

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

  // The stock item this part draws from: the one its Part Master was last
  // linked to, otherwise the stock item that shares its part number.
  linkedItemCache = await getStockItem((foundPart && foundPart.linkedStockNumber) || partNo);
  const restEl = document.getElementById("wo-rest");
  restEl.style.display = "block";

  const qtyPrefill = opts.qty || "";
  const commentPrefill = opts.comment || (foundPart ? foundPart.defaultComment : "");
  const namePrefill = linkedItemCache ? linkedItemCache.partName || "" : "";

  restEl.innerHTML = `
    ${
      foundPart
        ? `<section>
             <div class="section-title">Part found</div>
             <div class="kv">
               <div class="kv-row"><span class="k">Part name</span><span class="v">${esc(foundPart.partName)}</span></div>
               <div class="kv-row"><span class="k">Rev</span><span class="v">R${esc(rev)}</span></div>
               <div class="kv-row"><span class="k">Unit per robot</span><span class="v">${esc(foundPart.unitPerRobot)} pcs</span></div>
             </div>
           </section>`
        : `<div class="info-banner">Part ${esc(partNo)} rev ${esc(rev)} hasn't been used before — fill in these details once and it'll be remembered next time.</div>
           <div class="form-group">
             <label>Part name</label>
             <input id="wo-new-part-name" value="${esc(namePrefill)}" placeholder="e.g. Gearbox housing" required />
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

    ${
      linkedItemCache
        ? ""
        : `<div class="warn-box">No stock item matches ${esc(partNo)}, so no stock will be deducted when the machine shop picks this order up.</div>`
    }

    <div id="wo-single-fields">
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
        <label>Due date (optional)</label>
        <input type="date" id="wo-due-date" />
        <div class="hint">Shows a green/orange/red indicator on the list and this order's page as it approaches - leave blank for none.</div>
      </div>

      <div class="info-banner">
        <b>Assignee (machine shop)</b> and <b>Batch (machine shop)</b> aren't filled in here - the machine shop sets both, and any split across batches, when they pick this order up. Stock is taken from Production at that point.
      </div>
    </div>

    ${
      !reworkOfWoNo
        ? `<div class="chip-row" style="padding:0 16px;">
             <button type="button" class="chip-toggle" id="btn-toggle-schedule">+ Add weekly schedule instead</button>
           </div>`
        : ""
    }
    <div id="wo-schedule-fields" style="display:none;">
      <div class="info-banner">Creates a Production Request: one work order per week below, each starting Scheduled - stock isn't taken until someone's set as that week's assignee.</div>
      <div class="form-group">
        <label>MRP Easy order no.</label>
        <input id="wo-mrp-order" class="mono" placeholder="e.g. PO00081" />
      </div>
      <div class="section-title">Delivery schedule</div>
      <div id="wo-weeks"></div>
      <div class="btn-row">
        <button type="button" class="btn" id="btn-add-week">+ Add week</button>
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

  document.getElementById("wo-qty").oninput = renderProductionCheck;
  renderProductionCheck();

  const scheduleToggleBtn = document.getElementById("btn-toggle-schedule");
  if (scheduleToggleBtn) {
    scheduleToggleBtn.onclick = (e) => {
      scheduleMode = !scheduleMode;
      document.getElementById("wo-single-fields").style.display = scheduleMode ? "none" : "block";
      document.getElementById("wo-schedule-fields").style.display = scheduleMode ? "block" : "none";
      e.target.classList.toggle("is-active", scheduleMode);
      document.getElementById("btn-submit-wo").textContent = scheduleMode ? "Create production request" : "Create work order";
      if (scheduleMode && scheduleWeeks.length === 0) {
        scheduleWeeks.push(blankWeek());
        renderWeeks();
      }
      if (scheduleMode && !previewWoNo) {
        suggestNextWorkOrderNumber().then((woNo) => {
          previewWoNo = woNo;
          renderWeeks();
        });
      }
    };
  }

  document.getElementById("btn-add-week").onclick = () => {
    scheduleWeeks.push(blankWeek(scheduleWeeks[scheduleWeeks.length - 1]));
    renderWeeks();
  };

  document.getElementById("btn-submit-wo").onclick = submitWorkOrder;
}

// prevWeek (the current last row, before the new one is appended) seeds the
// new row's date (+7 days) and qty, since weekly schedules are almost always
// "same again, next week" - both stay freely editable afterwards.
function blankWeek(prevWeek) {
  weekSeq += 1;
  let weekOf = "";
  if (prevWeek && prevWeek.weekOf) {
    const next = new Date(prevWeek.weekOf + "T00:00:00");
    next.setDate(next.getDate() + 7);
    // Build the yyyy-mm-dd string from local getters, not toISOString() -
    // that converts to UTC first, which quietly shifts the date back a day
    // for anyone in a timezone ahead of UTC.
    const yyyy = next.getFullYear();
    const mm = String(next.getMonth() + 1).padStart(2, "0");
    const dd = String(next.getDate()).padStart(2, "0");
    weekOf = `${yyyy}-${mm}-${dd}`;
  }
  const qty = prevWeek ? prevWeek.qty : "";
  return { id: weekSeq, weekOf, qty };
}

function renderWeeks() {
  const box = document.getElementById("wo-weeks");
  if (!box) return;
  box.innerHTML = scheduleWeeks
    .map(
      (w, i) => `
      <div class="form-grid2 wo-week-row" data-week="${w.id}" style="align-items:flex-end;grid-template-columns:auto 1fr 1fr auto;">
        <div class="form-group" style="min-width:76px;">
          <label>Sub W.O.</label>
          <div class="mono wo-week-subno">${esc(previewWoNo || "DEX-WO-####")}-${i + 1}</div>
        </div>
        <div class="form-group">
          <label>Week of</label>
          <input type="date" class="wo-week-date" value="${esc(w.weekOf)}" />
        </div>
        <div class="form-group" style="display:flex;gap:8px;align-items:flex-end;">
          <div style="flex:1;">
            <label>Qty</label>
            <input type="number" min="1" step="1" class="wo-week-qty" inputmode="numeric" value="${esc(w.qty)}" />
          </div>
          ${scheduleWeeks.length > 1 ? `<button type="button" class="coc-line-remove" data-remove-week="${w.id}" aria-label="Remove week">&times;</button>` : ""}
        </div>
      </div>
    `
    )
    .join("");

  box.querySelectorAll(".wo-week-row").forEach((row) => {
    const id = Number(row.dataset.week);
    const w = scheduleWeeks.find((x) => x.id === id);
    row.querySelector(".wo-week-date").oninput = (e) => (w.weekOf = e.target.value);
    row.querySelector(".wo-week-qty").oninput = (e) => (w.qty = e.target.value);
  });
  box.querySelectorAll("[data-remove-week]").forEach((btn) => {
    btn.onclick = () => {
      scheduleWeeks = scheduleWeeks.filter((w) => w.id !== Number(btn.dataset.removeWeek));
      renderWeeks();
    };
  });
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
    box.innerHTML = `<div class="warn-box">Production only has ${available} pcs of ${esc(linkedItemCache.partNumber)}. ${qty - available} more will need moving into Production before the machine shop can pick this up cleanly.</div>`;
  } else {
    box.innerHTML = `<div class="ok-box">Production has ${available} pcs of ${esc(linkedItemCache.partNumber)} available.</div>`;
  }
}

// Shared by both submit paths: part name / new-PartMaster capture and the
// linked stock item lookup are identical whether this becomes a single work
// order or a Production Request's schedule of children. Returns null (after
// toasting) if something required is missing - callers just return in that
// case.
async function resolvePartAndStock() {
  const partNo = lookedUpPartNo;
  const rev = lookedUpRev;
  const linkedStockItem = linkedItemCache;
  const linkedStockNumber = linkedStockItem ? linkedStockItem.partNumber : "";

  let partName;
  let newPartMaster = null;
  let updatePartMasterLinkedStock;

  if (foundPart) {
    partName = foundPart.partName;
    if (linkedStockNumber && linkedStockNumber !== (foundPart.linkedStockNumber || "")) {
      updatePartMasterLinkedStock = linkedStockNumber;
    }
  } else {
    const partNameInput = document.getElementById("wo-new-part-name").value.trim();
    const unitPerRobot = Number(document.getElementById("wo-new-unit-per-robot").value) || 1;
    if (!partNameInput) {
      toast("Enter a part name.");
      return null;
    }
    const defaultComment = document.getElementById("wo-new-default-comment").value.trim();
    partName = partNameInput;
    newPartMaster = { partNo, rev, partName: partNameInput, unitPerRobot, linkedStockNumber, defaultComment };
  }

  return { partNo, rev, partName, newPartMaster, updatePartMasterLinkedStock, linkedStockItem };
}

async function submitWorkOrder() {
  if (scheduleMode) return submitProductionRequest();

  const qty = Number(document.getElementById("wo-qty").value);
  const comment = document.getElementById("wo-comment").value.trim();
  const dueDateVal = document.getElementById("wo-due-date").value;
  const dueDate = dueDateVal ? new Date(dueDateVal + "T00:00:00").getTime() : null;

  if (!qty || qty <= 0) {
    toast("Enter a quantity greater than 0.");
    return;
  }

  const user = await resolveUser(document.getElementById("wo-user"), document.getElementById("wo-other-name"));
  if (!user) {
    toast("Enter a name.");
    return;
  }

  const resolved = await resolvePartAndStock();
  if (!resolved) return;
  const { partNo, rev, partName, newPartMaster, updatePartMasterLinkedStock, linkedStockItem } = resolved;

  const submitBtn = document.getElementById("btn-submit-wo");
  submitBtn.disabled = true;
  submitBtn.textContent = "Creating…";

  try {
    const woNo = reworkOfWoNo ? await suggestReworkWoNumber(reworkOfWoNo) : await suggestNextWorkOrderNumber();
    await createWorkOrder({
      woNo,
      partNo,
      rev,
      partName,
      qty,
      comment,
      dueDate,
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

async function submitProductionRequest() {
  const mrpOrderNo = document.getElementById("wo-mrp-order").value.trim();
  const schedule = scheduleWeeks
    .map((w) => ({ weekOf: w.weekOf ? new Date(w.weekOf + "T00:00:00").getTime() : 0, qty: Number(w.qty) || 0 }))
    .filter((w) => w.weekOf && w.qty > 0)
    .sort((a, b) => a.weekOf - b.weekOf);

  if (schedule.length === 0) {
    toast("Add at least one week with a date and a qty greater than 0.");
    return;
  }

  const creator = await resolveUser(document.getElementById("wo-user"), document.getElementById("wo-other-name"));
  if (!creator) {
    toast("Enter a name.");
    return;
  }

  const resolved = await resolvePartAndStock();
  if (!resolved) return;
  const { partNo, rev, partName, newPartMaster, updatePartMasterLinkedStock, linkedStockItem } = resolved;

  const submitBtn = document.getElementById("btn-submit-wo");
  submitBtn.disabled = true;
  submitBtn.textContent = "Creating…";

  try {
    const woNo = await suggestNextWorkOrderNumber();
    await createProductionRequest({
      woNo,
      partNo,
      rev,
      partName,
      mrpOrderNo,
      creator,
      schedule,
      newPartMaster,
      updatePartMasterLinkedStock,
      linkedStockItem
    });
    toast(`Production request created - ${schedule.length} week${schedule.length === 1 ? "" : "s"} scheduled.`);
    navigate("#/work-orders/" + encodeURIComponent(woNo));
  } catch (err) {
    console.error(err);
    submitBtn.disabled = false;
    submitBtn.textContent = "Create production request";
    toast("Couldn't save — check your connection and try again.");
  }
}
