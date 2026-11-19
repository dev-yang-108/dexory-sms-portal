/* Add stock via Certificate of Conformity (CoC): supplier, CoC number, and
   one or more part/qty/batch lines, previewed and edited before anything is
   saved. Confirming books every line's qty into Production in one atomic
   write - see confirmCoc()/addLinesToCoc() in db.js for what that actually
   touches (a cocs/{cocKey} record, a batches row per line, and the usual
   transaction+areas.qty increment for lines whose part is a real stock
   item).

   "Scan with AI" (coc-extract.js) just pre-fills this same form from an
   uploaded photo/PDF - it never saves anything itself, so a bad read is
   just more fixing by hand, not bad data silently booked into stock. It
   needs a real Firebase project (not the ?mock=1 dev preview) and a
   one-time console setup - see README.md - so it's hidden/disabled there.
*/

import { esc, mount, toast } from "../render.js";
import { buildCocKey, getCoc, confirmCoc, addLinesToCoc, listKnownSuppliers, ensureKnownSupplier, getStockItem, listStockItems } from "../db.js";
import { populateUserSelect, wireUserSelect, resolveUser } from "../users.js";
import { isExtractionAvailable, extractCocFromFiles } from "../coc-extract.js";
import { navigate } from "../../app.js";

let lineSeq = 0;
let lines = []; // [{ id, partNo, qty, batches: [{id, batchNo, qty}], stockItemChecked, stockItemFound }]
let knownSuppliers = [];
// Pages staged for the next scan - built up from either/both the file
// picker and "Take photo" (camera) inputs, so a multi-page CoC can be
// assembled one snap at a time and then scanned together in one call.
let stagedFiles = [];
// Set once the typed supplier+CoC number matches a CoC that already exists -
// switches the form into "add these lines to it" mode instead of creating a
// new one.
let existingCoc = null;
// Every stock part, for "did you mean" hints on part numbers that don't match.
let stockParts = [];

function blankLine() {
  lineSeq += 1;
  return { id: lineSeq, partNo: "", qty: "", batches: [], stockItemChecked: false, stockItemFound: false };
}

export async function renderCocFormView() {
  lines = [blankLine()];
  existingCoc = null;
  stagedFiles = [];
  knownSuppliers = await listKnownSuppliers();
  try {
    stockParts = await listStockItems();
  } catch (err) {
    console.error(err);
    stockParts = [];
  }

  mount(`
    <header class="topbar">
      <button class="icon-btn" id="btn-back" aria-label="Back">&larr;</button>
      <div class="topbar-title">Add stock via CoC</div>
    </header>

    <div class="info-banner">Fill this in from the supplier's Certificate of Conformity. Part numbers must match your stock list: any that don't are highlighted, and will be created in Prototype stock. Nothing is saved until you confirm at the bottom.</div>

    ${
      isExtractionAvailable()
        ? `<div class="form-group">
             <label>Scan a photo or PDF (optional)</label>
             <input type="file" id="coc-scan-input" accept="image/*,application/pdf" multiple style="display:none;" />
             <input type="file" id="coc-camera-input" accept="image/*" capture="environment" style="display:none;" />
             <div class="btn-row" style="margin:0;">
               <button type="button" class="btn" id="btn-choose-files">Choose file(s)</button>
               <button type="button" class="btn" id="btn-take-photo">📷 Take photo</button>
             </div>
             <div class="hint">Add every page of this CoC (several photos, one at a time if you're using the camera, or one PDF) before scanning - it reads the text and fills in the fields below for you to check and correct. Works best with a flat, well-lit, in-focus photo; a PDF is read most accurately.</div>
             <div id="coc-staged-files"></div>
             <div class="btn-row" style="margin:10px 0 0;">
               <button type="button" class="btn" id="btn-scan">Scan certificate</button>
             </div>
             <div id="coc-scan-status"></div>
           </div>`
        : `<div class="hint" style="margin:0 16px 14px;">AI scanning needs a real Firebase project - not available in this dev preview. Enter the CoC details manually below.</div>`
    }

    <datalist id="coc-supplier-list">
      ${knownSuppliers.map((s) => `<option value="${esc(s.name)}"></option>`).join("")}
    </datalist>

    <div class="form-group">
      <label>Supplier name</label>
      <input id="coc-supplier-name" list="coc-supplier-list" placeholder="e.g. Shropshire Stainless and Aluminium" />
    </div>
    <div class="form-grid2">
      <div class="form-group">
        <label>Supplier code</label>
        <input id="coc-supplier-code" class="mono" placeholder="e.g. SSA" />
      </div>
      <div class="form-group">
        <label>CoC number</label>
        <input id="coc-number" class="mono" placeholder="e.g. 1-213936" />
      </div>
    </div>
    <div class="hint" id="coc-key-preview">Key: —</div>
    <div id="coc-existing-banner"></div>

    <div class="section-title">Lines</div>
    <div id="coc-lines"></div>
    <div class="btn-row">
      <button class="btn" id="btn-add-line">+ Add line</button>
    </div>

    <div class="form-group">
      <label>User name</label>
      <select id="coc-user"></select>
    </div>
    <div class="form-group" id="coc-other-wrap" style="display:none;">
      <label>Name</label>
      <input id="coc-other-name" placeholder="Name" />
    </div>

    <div class="btn-row">
      <button class="btn primary-lime" id="btn-submit-coc">Confirm &amp; book in stock</button>
    </div>
  `);

  document.getElementById("btn-back").onclick = () => history.back();

  const userSelect = document.getElementById("coc-user");
  const otherWrap = document.getElementById("coc-other-wrap");
  populateUserSelect(userSelect);
  wireUserSelect(userSelect, otherWrap);

  document.getElementById("coc-supplier-name").oninput = onSupplierNameInput;
  document.getElementById("coc-supplier-code").oninput = refreshKeyPreview;
  document.getElementById("coc-number").oninput = refreshKeyPreview;
  document.getElementById("coc-number").onblur = checkForExistingCoc;
  document.getElementById("coc-supplier-code").onblur = checkForExistingCoc;
  document.getElementById("btn-add-line").onclick = () => {
    lines.push(blankLine());
    renderLines();
  };
  document.getElementById("btn-submit-coc").onclick = submit;

  if (isExtractionAvailable()) {
    const fileInput = document.getElementById("coc-scan-input");
    const cameraInput = document.getElementById("coc-camera-input");
    document.getElementById("btn-choose-files").onclick = () => fileInput.click();
    document.getElementById("btn-take-photo").onclick = () => cameraInput.click();
    fileInput.onchange = () => addStagedFiles(fileInput.files, fileInput);
    cameraInput.onchange = () => addStagedFiles(cameraInput.files, cameraInput);
    document.getElementById("btn-scan").onclick = runScan;
  }

  renderLines();
}

// Appends newly picked/captured file(s) to the running page list, then
// resets the input's own value - otherwise choosing or re-capturing a file
// with the same name a second time wouldn't fire onchange again.
function addStagedFiles(fileList, inputEl) {
  stagedFiles = stagedFiles.concat(Array.from(fileList || []));
  inputEl.value = "";
  renderStagedFiles();
}

function renderStagedFiles() {
  const box = document.getElementById("coc-staged-files");
  if (!box) return;
  if (stagedFiles.length === 0) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = stagedFiles
    .map(
      (f, i) => `
      <div class="coc-staged-row">
        <span>${esc(f.name || `Photo ${i + 1}`)}</span>
        <button type="button" class="coc-batch-remove" data-staged="${i}" aria-label="Remove page">&times;</button>
      </div>
    `
    )
    .join("");
  box.querySelectorAll("[data-staged]").forEach((btn) => {
    btn.onclick = () => {
      stagedFiles.splice(Number(btn.dataset.staged), 1);
      renderStagedFiles();
    };
  });
}

async function runScan() {
  const statusBox = document.getElementById("coc-scan-status");
  if (stagedFiles.length === 0) {
    toast("Choose a photo or PDF, or take a photo, first.");
    return;
  }

  const btn = document.getElementById("btn-scan");
  btn.disabled = true;
  btn.textContent = "Scanning…";
  statusBox.innerHTML = "";

  try {
    const knownParts = stockParts.map((s) => s.partNumber).filter(Boolean);
    const result = await extractCocFromFiles(stagedFiles, {
      knownSuppliers,
      knownParts,
      onProgress: (msg) => {
        statusBox.innerHTML = `<div class="hint">${esc(msg)}</div>`;
      }
    });
    applyExtractedResult(result);
    const found = result.lines.length;
    statusBox.innerHTML = `
      <div class="${found ? "ok-box" : "warn-box"}">
        ${found ? `Found ${found} part line${found === 1 ? "" : "s"}.` : "Couldn't find any DEX part numbers."}
        This is a text read, so check every field below against the certificate before confirming.
      </div>
      <details class="hint" style="margin-top:8px;">
        <summary>Show the text that was read</summary>
        <pre style="white-space:pre-wrap;font-size:12px;max-height:220px;overflow:auto;margin:6px 0 0;">${esc(result.rawText)}</pre>
      </details>`;
  } catch (err) {
    console.error(err);
    statusBox.innerHTML = `<div class="warn-box">${esc(err.message || "Couldn't scan that file.")}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Scan certificate";
  }
}

// Pre-fills the same editable fields a manual entry would - replaces the
// current draft's lines outright (scanning is meant to be the starting
// point, not merged with whatever was half-typed before it).
function applyExtractedResult(result) {
  document.getElementById("coc-supplier-name").value = result.supplierName;
  onSupplierNameInput();
  if (result.cocNumber) {
    document.getElementById("coc-number").value = result.cocNumber;
    refreshKeyPreview();
    checkForExistingCoc();
  }

  lines = result.lines.length
    ? result.lines.map((l) => ({
        id: ++lineSeq,
        partNo: l.partNo,
        qty: l.qty,
        batches: l.batches.map((b) => ({ id: ++lineSeq, batchNo: b.batchNo, qty: b.qty })),
        stockItemChecked: false,
        stockItemFound: false
      }))
    : [blankLine()];
  renderLines();
  lines.forEach(checkStockItem);
}

function onSupplierNameInput() {
  const name = document.getElementById("coc-supplier-name").value.trim();
  const match = knownSuppliers.find((s) => s.name === name);
  if (match) {
    const codeInput = document.getElementById("coc-supplier-code");
    if (!codeInput.value.trim()) codeInput.value = match.code;
  }
  refreshKeyPreview();
}

function refreshKeyPreview() {
  const code = document.getElementById("coc-supplier-code").value;
  const num = document.getElementById("coc-number").value;
  const key = buildCocKey(code, num);
  document.getElementById("coc-key-preview").textContent = "Key: " + (key || "—");
  if (existingCoc && existingCoc.cocKey !== key) {
    existingCoc = null;
    renderExistingBanner();
    renderSubmitLabel();
  }
}

async function checkForExistingCoc() {
  const code = document.getElementById("coc-supplier-code").value;
  const num = document.getElementById("coc-number").value;
  const key = buildCocKey(code, num);
  if (!key) return;
  existingCoc = await getCoc(key);
  renderExistingBanner();
  renderSubmitLabel();
}

function renderExistingBanner() {
  const box = document.getElementById("coc-existing-banner");
  if (!box) return;
  if (!existingCoc) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `
    <div class="warn-box">
      A CoC with this key already exists (${esc((existingCoc.lines || []).length)} line${(existingCoc.lines || []).length === 1 ? "" : "s"} so far).
      Confirming below will add your new lines to it, not replace it.
      <div class="kv" style="margin-top:8px;">
        ${(existingCoc.lines || [])
          .map(
            (l) =>
              `<div class="kv-row"><span class="k">${esc(l.partNo)}</span><span class="v">${esc(l.qty)} pcs</span></div>`
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderSubmitLabel() {
  const btn = document.getElementById("btn-submit-coc");
  if (!btn) return;
  btn.textContent = existingCoc ? "Add lines to existing CoC" : "Confirm & book in stock";
}

function renderLines() {
  const wrap = document.getElementById("coc-lines");
  if (!wrap) return;

  wrap.innerHTML = lines.map(lineHTML).join("");

  lines.forEach((line) => {
    const row = wrap.querySelector(`[data-line="${line.id}"]`);
    if (!row) return;

    const partInput = row.querySelector(".coc-line-part");
    partInput.oninput = (e) => (line.partNo = e.target.value);
    partInput.onblur = () => checkStockItem(line);

    const qtyInput = row.querySelector(".coc-line-qty");
    qtyInput.oninput = (e) => {
      line.qty = e.target.value;
      if (line.stockItemChecked && !line.stockItemFound) {
        const flag = row.querySelector(".coc-stock-flag");
        if (flag) flag.outerHTML = stockFlagHTML(line);
        wireFlag(line);
      }
    };
    wireFlag(line);

    const removeLineBtn = row.querySelector(".coc-line-remove");
    if (removeLineBtn) {
      removeLineBtn.onclick = () => {
        lines = lines.filter((l) => l.id !== line.id);
        renderLines();
      };
    }

    row.querySelector(".coc-add-batch").onclick = () => {
      line.batches.push({ id: ++lineSeq, batchNo: "", qty: "" });
      renderLines();
    };

    row.querySelectorAll(".coc-batch-row").forEach((batchRow) => {
      const batchId = Number(batchRow.dataset.batch);
      const b = line.batches.find((x) => x.id === batchId);
      if (!b) return;
      batchRow.querySelector(".coc-batch-no").oninput = (e) => (b.batchNo = e.target.value);
      batchRow.querySelector(".coc-batch-qty").oninput = (e) => {
        b.qty = e.target.value;
        recomputeLineQty(line);
      };
      batchRow.querySelector(".coc-batch-remove").onclick = () => {
        line.batches = line.batches.filter((x) => x.id !== batchId);
        recomputeLineQty(line);
        renderLines();
      };
    });
  });
}

// When at least one batch on a line has a qty, the line's total is the sum
// of its batches rather than something typed separately - one number to
// keep straight instead of two that could disagree.
function recomputeLineQty(line) {
  const withQty = line.batches.filter((b) => b.qty !== "" && !Number.isNaN(Number(b.qty)));
  if (withQty.length > 0) {
    line.qty = withQty.reduce((sum, b) => sum + Number(b.qty), 0);
  }
  const wrap = document.getElementById("coc-lines");
  const row = wrap && wrap.querySelector(`[data-line="${line.id}"] .coc-line-qty`);
  if (row) row.value = line.qty;
}

async function checkStockItem(line) {
  const partNo = line.partNo.trim();
  line.stockItemChecked = !!partNo;
  const item = partNo ? await getStockItem(partNo) : null;
  line.stockItemFound = !!item;
  line.stockItemName = item ? item.partName || item.name || "" : "";
  const wrap = document.getElementById("coc-lines");
  const flag = wrap && wrap.querySelector(`[data-line="${line.id}"] .coc-stock-flag`);
  if (flag) flag.outerHTML = stockFlagHTML(line);
  wireFlag(line);
}

// A part number one character away from a real stock part - a likely misread.
function closestStockPart(partNo) {
  const near = stockParts.filter((p) => oneCharAway(p.partNumber, partNo));
  return near.length === 1 ? near[0] : null;
}

function oneCharAway(a, b) {
  if (!a || !b || a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function stockFlagHTML(line) {
  if (!line.stockItemChecked) return `<div class="coc-stock-flag"></div>`;
  if (line.stockItemFound) {
    return `<div class="coc-stock-flag ok-box">In stock list${line.stockItemName ? `: <b>${esc(line.stockItemName)}</b>` : ""} - books into Production.</div>`;
  }
  const close = closestStockPart(line.partNo.trim());
  return `
    <div class="coc-stock-flag coc-proto">
      <div><b>Not in the stock list.</b> Confirming will create <b class="mono">${esc(line.partNo)}</b> as a new part and book ${esc(line.qty || 0)} pcs into <b>PROTOTYPE stock</b>, not Production.</div>
      ${
        close
          ? `<div style="margin-top:6px;">Did you mean <b class="mono">${esc(close.partNumber)}</b>${close.partName ? ` (${esc(close.partName)})` : ""}? <button type="button" class="btn coc-use-closest" style="padding:4px 10px;">Use ${esc(close.partNumber)}</button></div>`
          : ""
      }
      <input class="coc-proto-name" placeholder="Part name (optional)" value="${esc(line.partName || "")}" style="margin-top:8px;" />
    </div>`;
}

// Hooks up the inputs inside a line's flag box (they're rebuilt whenever the
// flag is repainted).
function wireFlag(line) {
  const wrap = document.getElementById("coc-lines");
  const row = wrap && wrap.querySelector(`[data-line="${line.id}"]`);
  if (!row) return;
  const nameInput = row.querySelector(".coc-proto-name");
  if (nameInput) nameInput.oninput = (e) => (line.partName = e.target.value);
  const useBtn = row.querySelector(".coc-use-closest");
  if (useBtn) {
    useBtn.onclick = () => {
      const close = closestStockPart(line.partNo.trim());
      if (!close) return;
      line.partNo = close.partNumber;
      renderLines();
      checkStockItem(line);
    };
  }
}

function lineHTML(line, index) {
  return `
    <div class="coc-line" data-line="${line.id}">
      <div class="coc-line-head">
        <span class="coc-line-no">Line ${index + 1}</span>
        ${lines.length > 1 ? `<button type="button" class="coc-line-remove" aria-label="Remove line">&times;</button>` : ""}
      </div>
      <div class="form-grid2">
        <div class="form-group">
          <label>Part no.</label>
          <input class="coc-line-part mono" value="${esc(line.partNo)}" placeholder="e.g. DEX05120234" />
        </div>
        <div class="form-group">
          <label>Qty (pcs)</label>
          <input class="coc-line-qty" type="number" min="0" step="1" value="${esc(line.qty)}" inputmode="numeric" />
        </div>
      </div>
      ${stockFlagHTML(line)}

      <div class="coc-batches">
        ${line.batches
          .map(
            (b) => `
          <div class="coc-batch-row" data-batch="${b.id}">
            <input class="coc-batch-no mono" value="${esc(b.batchNo)}" placeholder="Supplier batch no." />
            <input class="coc-batch-qty" type="number" min="0" step="1" value="${esc(b.qty)}" placeholder="Qty" inputmode="numeric" />
            <button type="button" class="coc-batch-remove" aria-label="Remove batch">&times;</button>
          </div>
        `
          )
          .join("")}
        <button type="button" class="btn coc-add-batch">+ Add supplier batch no.</button>
      </div>
    </div>
  `;
}

async function submit() {
  const supplierName = document.getElementById("coc-supplier-name").value.trim();
  const supplierCode = document.getElementById("coc-supplier-code").value.trim();
  const cocNumber = document.getElementById("coc-number").value.trim();

  if (!supplierName || !supplierCode || !cocNumber) {
    toast("Enter supplier name, supplier code and CoC number.");
    return;
  }

  const rawLines = lines
    .map((l) => ({
      partNo: l.partNo.trim(),
      partName: (l.partName || "").trim(),
      qty: Number(l.qty) || 0,
      batches: l.batches
        .filter((b) => b.batchNo.trim())
        .map((b) => ({ batchNo: b.batchNo.trim(), qty: Number(b.qty) || 0 }))
    }))
    .filter((l) => l.partNo && l.qty > 0);

  // Two lines for the same part on this same CoC are one traceability unit,
  // not two - merge them here rather than relying on db.js's merge-on-
  // collision to sort it out across two separate `batches.set()` calls
  // inside the same write batch (the second would just clobber the first).
  const byPartNo = new Map();
  rawLines.forEach((l) => {
    const existing = byPartNo.get(l.partNo);
    if (existing) {
      existing.qty += l.qty;
      existing.batches = existing.batches.concat(l.batches);
    } else {
      byPartNo.set(l.partNo, l);
    }
  });
  const cleanedLines = Array.from(byPartNo.values());

  if (cleanedLines.length === 0) {
    toast("Add at least one line with a part no. and qty.");
    return;
  }

  const user = await resolveUser(document.getElementById("coc-user"), document.getElementById("coc-other-name"));
  if (!user) {
    toast("Enter a name.");
    return;
  }

  // Parts that aren't in the stock list go to Prototype - say so, line by
  // line, before anything moves.
  const toPrototype = [];
  for (const l of cleanedLines) {
    if (!(await getStockItem(l.partNo))) toPrototype.push(l);
  }
  if (toPrototype.length) {
    const list = toPrototype.map((l) => `  ${l.partNo}: ${l.qty} pcs`).join("\n");
    const ok = window.confirm(
      `${toPrototype.length} part${toPrototype.length === 1 ? " is" : "s are"} not in the stock list and will be created in PROTOTYPE stock:\n\n${list}\n\nCheck the part numbers against the certificate. Continue?`
    );
    if (!ok) return;
  }

  const submitBtn = document.getElementById("btn-submit-coc");
  submitBtn.disabled = true;
  submitBtn.textContent = "Saving…";

  try {
    await ensureKnownSupplier(supplierName, supplierCode);

    const result = existingCoc
      ? await addLinesToCoc(existingCoc.cocKey, cleanedLines, user)
      : await confirmCoc({ supplierCode, supplierName, cocNumber, lines: cleanedLines, user });

    if (result.missingStockItems.length > 0) {
      toast(`CoC ${result.cocKey} saved. ${result.missingStockItems.length} new part(s) created in Prototype stock - fill in their details.`);
    } else {
      toast(`CoC ${result.cocKey} saved and stock booked in.`);
    }
    navigate("#/");
  } catch (err) {
    console.error(err);
    submitBtn.disabled = false;
    renderSubmitLabel();
    toast(err.message || "Couldn't save — check your connection and try again.");
  }
}
