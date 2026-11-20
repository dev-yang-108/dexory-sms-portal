/* New / edit stock item form. */

import { esc, mount, toast } from "../render.js";
import {
  FORMS,
  AREAS,
  AREA_LABELS,
  blankStockItem,
  getStockItem,
  createStockItem,
  updateStockItemFields,
  areaLocation
} from "../db.js";
import { openQtyModal } from "../qty-modal.js";
import { navigate } from "../../app.js";

export async function renderFormView(existingPartNumber, opts) {
  const isEdit = !!existingPartNumber;
  const options = opts || {};

  let item;
  if (isEdit) {
    item = await getStockItem(existingPartNumber);
    if (!item) {
      mount(`<div class="empty-state">Stock item not found.</div>`);
      return;
    }
  } else {
    item = blankStockItem();
    if (options.prefillPartNumber) item.partNumber = options.prefillPartNumber;
  }

  // Part number is the item's permanent identity (the barcode value, the
  // doc id, what scanning and history look up) - locked once it exists,
  // same as a scanned-in prefill locks it before first save too.
  const partNumberReadonly = isEdit || !!options.prefillPartNumber;

  mount(`
    <header class="topbar">
      <button class="icon-btn" id="btn-back" aria-label="Back">&larr;</button>
      <div class="topbar-title">${isEdit ? "Edit stock item" : "New stock item"}</div>
    </header>

    ${
      options.unrecognized
        ? `<div class="info-banner">Scanned an unrecognised barcode — fill in details to create it.</div>`
        : ""
    }

    <form id="item-form">
      <div class="form-group">
        <label>Part number</label>
        <input name="partNumber" value="${esc(item.partNumber)}" ${partNumberReadonly ? "readonly" : ""} placeholder="e.g. DEX05120234" required />
      </div>

      <div class="form-group">
        <label>Part name</label>
        <input name="partName" value="${esc(item.partName || "")}" placeholder="e.g. Bulk head" />
      </div>

      <div class="form-grid2">
        <div class="form-group">
          <label>Rev</label>
          <input name="rev" value="${esc(item.rev || "")}" placeholder="e.g. 1" />
        </div>
        <div class="form-group">
          <label>Material</label>
          <input name="material" value="${esc(item.material)}" placeholder="e.g. Aluminium 6082" />
        </div>
      </div>

      <div class="form-group">
        <label>Form</label>
        <select name="form">
          ${FORMS.map((f) => `<option ${f === item.form ? "selected" : ""}>${esc(f)}</option>`).join("")}
        </select>
      </div>

      <div class="form-group">
        <label>Stock size</label>
        <input name="stockSize" value="${esc(item.stockSize)}" placeholder="e.g. 500 x 300 x 20mm" />
      </div>

      <div class="form-grid2">
        <div class="form-group">
          <label>Qty per 7-section robot</label>
          <input name="perRobotCycle" type="number" min="1" step="1" value="${esc(item.perRobotCycle)}" required />
        </div>
        <div class="form-group">
          <label>Qty per 10-section robot</label>
          <input name="perRobotCycle10Sec" type="number" min="1" step="1" value="${esc(item.perRobotCycle10Sec || 1)}" required />
        </div>
      </div>
      <div class="hint" style="margin:-8px 16px 14px;">Low stock alerts use whichever robot (7-section or 10-section) would run out first.</div>

      <label class="form-group" style="display:flex;gap:10px;align-items:flex-start;">
        <input type="checkbox" name="isPrototype" ${item.isPrototype ? "checked" : ""} style="width:auto;margin-top:3px;" />
        <span><b>Prototype part</b><span class="hint" style="display:block;">One-off or odd-size material. It shows on the Prototype stock page only, and is left out of the Order calculator, Stock availability, Low stock and the dashboard counts.</span></span>
      </label>

      <div class="form-group">
        <label>Pieces per blank</label>
        <input name="piecesPerBlank" type="number" min="1" step="1" value="${esc(item.piecesPerBlank || 1)}" required />
        <div class="hint">How many finished plates one blank of this stock cuts into - pre-fills the Add-stock yield calculation. Leave at 1 if this stock isn't cut down at book-in.</div>
      </div>

      ${
        isEdit
          ? `<div class="form-group">
               <label>Location by area</label>
               ${AREAS.map(
                 (a) =>
                   `<input name="loc_${a}" value="${esc(areaLocation(item, a))}" placeholder="${esc(AREA_LABELS[a])} location" style="margin-bottom:8px;" />`
               ).join("")}
               <div class="hint">Where this part sits within each area. Quantities themselves are managed with Add/Take/Move, not here.</div>
             </div>`
          : `<div class="hint" style="margin:0 16px 14px;">Starts with 0 pcs in every area - use + Add on the stock board right after to put stock in.</div>`
      }

      <div class="form-group">
        <label>Comments</label>
        <textarea name="comments" placeholder="Anything worth flagging about this stock">${esc(item.comments)}</textarea>
      </div>

      <div class="btn-row">
        <button type="submit" class="btn primary-lime">${isEdit ? "Save changes" : "Save & generate barcode"}</button>
      </div>
    </form>

    ${
      isEdit
        ? `<button class="pill-link standalone-btn" id="btn-adjust">Adjust quantity</button>`
        : ""
    }
  `);

  document.getElementById("btn-back").onclick = () => history.back();
  document.getElementById("item-form").onsubmit = (e) => submitForm(e, item, isEdit);

  const adjustBtn = document.getElementById("btn-adjust");
  if (adjustBtn) {
    adjustBtn.onclick = () => {
      openAdjustPicker(item);
    };
  }
}

function openAdjustPicker(item) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">Adjust quantity</div>
      <div class="modal-sub">Corrects the stock count on hand. Still logged, tagged "manual correction".</div>
      <div class="form-group">
        <label>Area</label>
        <select id="adjust-area">
          ${AREAS.map((a) => `<option value="${a}">${esc(AREA_LABELS[a])}</option>`).join("")}
        </select>
      </div>
      <div class="btn-row">
        <button class="btn danger" id="adjust-take">− Correct down</button>
        <button class="btn primary-lime" id="adjust-bookin">+ Correct up</button>
      </div>
      <div class="btn-row">
        <button class="btn" id="adjust-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  const areaSelect = overlay.querySelector("#adjust-area");
  overlay.querySelector("#adjust-cancel").onclick = () => overlay.remove();
  overlay.querySelector("#adjust-take").onclick = () => {
    const area = areaSelect.value;
    overlay.remove();
    openQtyModal({ item, type: "take", area, fixedNote: "manual correction", hideWorkOrder: true });
  };
  overlay.querySelector("#adjust-bookin").onclick = () => {
    const area = areaSelect.value;
    overlay.remove();
    openQtyModal({ item, type: "book-in", area, fixedNote: "manual correction" });
  };
}

async function submitForm(e, originalItem, isEdit) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const partNumber = isEdit ? originalItem.partNumber : String(fd.get("partNumber")).trim();

  if (!partNumber) {
    toast("Part number is required.");
    return;
  }

  if (!isEdit) {
    const existing = await getStockItem(partNumber);
    if (existing) {
      toast(`Part number ${partNumber} already exists.`);
      return;
    }
  }

  try {
    if (isEdit) {
      const fields = {
        partName: fd.get("partName") || "",
        rev: fd.get("rev") || "",
        material: fd.get("material") || "",
        stockSize: fd.get("stockSize") || "",
        form: fd.get("form") || FORMS[0],
        perRobotCycle: Number(fd.get("perRobotCycle")) || 1,
        perRobotCycle10Sec: Number(fd.get("perRobotCycle10Sec")) || 1,
        piecesPerBlank: Number(fd.get("piecesPerBlank")) || 1,
        isPrototype: fd.get("isPrototype") === "on",
        comments: fd.get("comments") || ""
      };
      AREAS.forEach((a) => {
        fields[`areas.${a}.location`] = fd.get(`loc_${a}`) || "";
      });
      await updateStockItemFields(partNumber, fields);
      toast("Stock item saved.");
    } else {
      const areas = {};
      AREAS.forEach((a) => {
        areas[a] = { qty: 0, location: "" };
      });
      await createStockItem({
        partNumber,
        partName: fd.get("partName") || "",
        rev: fd.get("rev") || "",
        material: fd.get("material") || "",
        stockSize: fd.get("stockSize") || "",
        form: fd.get("form") || FORMS[0],
        perRobotCycle: Number(fd.get("perRobotCycle")) || 1,
        perRobotCycle10Sec: Number(fd.get("perRobotCycle10Sec")) || 1,
        piecesPerBlank: Number(fd.get("piecesPerBlank")) || 1,
        isPrototype: fd.get("isPrototype") === "on",
        areas,
        comments: fd.get("comments") || ""
      });
      toast("Stock item created.");
    }
    navigate("#/item/" + encodeURIComponent(partNumber));
  } catch (err) {
    console.error(err);
    toast("Couldn't save — check your connection and try again.");
  }
}
