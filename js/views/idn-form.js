/* Generate an IDN (internal delivery note) from a work order. Part no.,
   rev, qty and comment are pre-filled from the work order but stay fully
   editable - this just gives you a sensible starting point. Qty defaults
   to whatever's still Remaining and is soft-capped there (warns, doesn't
   block, same pattern as everywhere else stock gets checked). */

import { esc, mount, toast } from "../render.js";
import { getWorkOrder, remainingQty, suggestNextIdnNumber, suggestNextRefNo, createIdnForWorkOrder } from "../db.js";
import { populateUserSelect, wireUserSelect, resolveUser } from "../users.js";
import { navigate } from "../../app.js";

export async function renderIdnFormView(woNo) {
  const wo = woNo ? await getWorkOrder(woNo) : null;
  if (!wo) {
    mount(`<div class="empty-state">Work order "${esc(woNo || "")}" not found.</div>`);
    return;
  }

  const remaining = remainingQty(wo);
  const refNoSuggestion = await suggestNextRefNo();

  mount(`
    <header class="topbar">
      <button class="icon-btn" id="btn-back" aria-label="Back">&larr;</button>
      <div class="topbar-title">New IDN</div>
    </header>

    <div class="info-banner">Generated from <b>${esc(wo.woNo)}</b> — ${esc(wo.partName || wo.partNo)} · R${esc(wo.rev)}. ${remaining} pcs remaining on this order.</div>

    <div class="form-group">
      <label>Part number</label>
      <input id="idn-part-no" value="${esc(wo.partNo)}" />
    </div>

    <div class="form-grid2">
      <div class="form-group">
        <label>Qty (good pcs)</label>
        <input id="idn-qty" type="number" min="1" step="1" value="${esc(remaining || wo.qty)}" inputmode="numeric" />
      </div>
      <div class="form-group">
        <label>Rev</label>
        <input id="idn-rev" value="${esc(wo.rev)}" />
      </div>
    </div>

    <div class="form-group">
      <label>Comment</label>
      <input id="idn-comment" value="${esc(wo.comment || "")}" placeholder="Optional" />
    </div>

    <div class="section-title">Delivery note details</div>

    <div class="form-group">
      <label>Ref no.</label>
      <input id="idn-ref-no" value="${esc(refNoSuggestion)}" placeholder="e.g. MS 824" />
      <div class="hint">Pre-filled as the last one + 1 - edit freely, including the first time to set the prefix/start number.</div>
    </div>

    <div class="form-grid2">
      <div class="form-group">
        <label>PO</label>
        <input id="idn-po" placeholder="e.g. PO00260" />
      </div>
      <div class="form-group">
        <label>VMS</label>
        <input id="idn-vms" placeholder="e.g. 1641" />
      </div>
    </div>

    <div class="form-group">
      <label>Initials</label>
      <input id="idn-initials" placeholder="e.g. MA" style="max-width:120px;" />
      <div class="hint">Whoever's initials go on the physical note - fill this in and "User name" below isn't needed too.</div>
    </div>

    <div id="idn-who-section">
      <div class="form-group">
        <label>User name</label>
        <select id="idn-user"></select>
      </div>
      <div class="form-group" id="idn-other-wrap" style="display:none;">
        <label>Name</label>
        <input id="idn-other-name" placeholder="Name" />
      </div>
    </div>

    <div class="btn-row">
      <button class="btn primary-lime" id="btn-submit-idn">Generate IDN</button>
    </div>
  `);

  document.getElementById("btn-back").onclick = () => history.back();

  const userSelect = document.getElementById("idn-user");
  const otherWrap = document.getElementById("idn-other-wrap");
  populateUserSelect(userSelect);
  wireUserSelect(userSelect, otherWrap);

  const initialsInput = document.getElementById("idn-initials");
  const whoSection = document.getElementById("idn-who-section");
  initialsInput.oninput = () => {
    whoSection.style.display = initialsInput.value.trim() ? "none" : "block";
  };

  document.getElementById("btn-submit-idn").onclick = () => submit(wo, remaining);
}

async function submit(wo, remaining) {
  const partNo = document.getElementById("idn-part-no").value.trim();
  const qty = Number(document.getElementById("idn-qty").value);
  const rev = document.getElementById("idn-rev").value.trim();
  const comment = document.getElementById("idn-comment").value.trim();
  const refNo = document.getElementById("idn-ref-no").value.trim();
  const po = document.getElementById("idn-po").value.trim();
  const vms = document.getElementById("idn-vms").value.trim();
  const initials = document.getElementById("idn-initials").value.trim();

  if (!partNo) {
    toast("Enter a part number.");
    return;
  }
  if (!qty || qty <= 0) {
    toast("Enter a quantity greater than 0.");
    return;
  }
  if (qty > remaining) {
    const proceed = window.confirm(`This work order only has ${remaining} pcs remaining, but this IDN is for ${qty}. Generate it anyway?`);
    if (!proceed) return;
  }

  // Initials already identify who handled this on the physical note - only
  // fall back to the "Who" picker when they're left blank.
  let user = initials;
  if (!user) {
    user = await resolveUser(document.getElementById("idn-user"), document.getElementById("idn-other-name"));
    if (!user) {
      toast("Enter a name, or fill in Initials above.");
      return;
    }
  }

  const btn = document.getElementById("btn-submit-idn");
  btn.disabled = true;
  btn.textContent = "Generating…";

  try {
    const idnNo = await suggestNextIdnNumber();
    await createIdnForWorkOrder({
      idnNo,
      wo,
      qty,
      partNo,
      rev,
      partName: wo.partName,
      comment,
      refNo,
      po,
      vms,
      initials,
      user
    });
    toast("IDN generated.");
    navigate("#/idns/" + encodeURIComponent(idnNo));
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = "Generate IDN";
    toast("Couldn't save — check your connection and try again.");
  }
}
