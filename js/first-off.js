/* First-off inspection card on a work order: the machine shop checks 1 piece,
   operation by operation - which machine, who operated, who 2nd-checked (a
   different person), pass / rework / fail, what happened to a failed piece, a
   comment and one attachment (saved to Google Drive once it is connected).
   One first-off can cover other work orders/batches of the same part run
   together, and random spot checks during the run are logged against their
   batch. Rework or fail means starting another attempt; earlier attempts stay
   on the record. Stored on the work order itself as
   firstOff = { attempts: [...], covers: [woNo...], spots: [...], quality }. */

import { esc, toast, formatDate } from "./render.js";
import {
  updateWorkOrderFields,
  listMachines,
  addMachine,
  machineLabel,
  listKnownUsers,
  ensureKnownUser,
  listWorkOrders,
  addFirstOffCovers,
  removeFirstOffCover,
  recordWorkOrderReject,
  blankFirstOffOp,
  newFirstOffAttempt
} from "./db.js";
import { downloadRouteCardPdf } from "./route-card-pdf.js";
import { DRIVE_UPLOAD_URL, DRIVE_UPLOAD_SECRET } from "../drive-config.js";

const ADD_NEW = "__add_new__";
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const FIRST_OFF_LABELS = {
  none: "Not started",
  covered: "Covered",
  progress: "In progress",
  pass: "Passed",
  rework: "Rework",
  fail: "Failed"
};

const lastAttempt = (wo) => wo.firstOff.attempts[wo.firstOff.attempts.length - 1];

// A failed or reworked piece that was accepted with a note no longer holds
// the card up, so it counts as a pass.
const effectiveResult = (op) => ((op.result === "fail" || op.result === "rework") && op.disposition === "accept" ? "pass" : op.result);

// Any fail wins over rework, rework over pass - and pass only once every
// operation has been passed.
export function attemptOutcome(attempt) {
  const results = (attempt.ops || []).map(effectiveResult);
  if (results.includes("fail")) return "fail";
  if (results.includes("rework")) return "rework";
  if (results.length && results.every((r) => r === "pass")) return "pass";
  return "";
}

export function firstOffStatus(wo) {
  if (!wo.firstOff || !wo.firstOff.attempts || wo.firstOff.attempts.length === 0) return wo.firstOffRef ? "covered" : "none";
  return attemptOutcome(lastAttempt(wo)) || "progress";
}

// What the Route cards list shows for a work order that holds (or is covered
// by) a first-off. Quality signs off a card once every operation has passed.
export function routeCardInfo(wo) {
  if (!wo.firstOff) return { result: "covered", attempt: 0, quality: `Follows ${wo.firstOffRef}`, tone: "" };
  const attempt = lastAttempt(wo);
  const outcome = attemptOutcome(attempt);
  const q = wo.firstOff.quality;
  let quality = "Not ready";
  let tone = "";
  if (q && q.status === "signed") {
    quality = `Signed off, ${q.by}`;
    tone = "ok";
  } else if (q && q.status === "sent-back") {
    quality = "Sent back";
    tone = "bad";
  } else if (outcome === "pass") {
    quality = "Awaiting quality";
    tone = "blue";
  }
  return { result: outcome || "progress", attempt: attempt.n, quality, tone };
}

export function initials(name) {
  return String(name || "")
    .replace(/[^A-Za-z ]/g, "")
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

let renderSeq = 0;
// "Pull more work orders" panel: open/closed and what is ticked survive the
// card re-drawing itself when the data changes.
let pullOpen = false;
const pullSel = new Set();

export async function renderFirstOff(wo, root) {
  if (!root) return;
  if (wo.isParent || wo.status === "Scheduled" || wo.status === "Cancelled") {
    root.innerHTML = "";
    return;
  }

  const title = `<div class="section-title">First-off inspection</div>`;

  if (!wo.firstOff && wo.firstOffRef) {
    root.innerHTML = `${title}<div class="info-banner">Covered by the first-off on <a class="mono" href="#/work-orders/${encodeURIComponent(wo.firstOffRef)}">${esc(wo.firstOffRef)}</a> - no separate check needed.</div>`;
    return;
  }

  if (!wo.firstOff) {
    root.innerHTML = `${title}
      <div class="info-banner">No first-off recorded yet. Start it when the first piece is ready to check - it checks 1 piece.</div>
      <div class="btn-row"><button class="btn primary-lime" id="fo-start">Start first-off</button></div>`;
    root.onclick = (e) => {
      if (e.target.id === "fo-start") startAttempt(wo);
    };
    return;
  }

  const token = String(++renderSeq);
  root.dataset.token = token;
  const [machines, people, allOrders] = await Promise.all([listMachines(), listKnownUsers(), listWorkOrders()]);
  if (!root.isConnected || root.dataset.token !== token) return;

  const attempts = wo.firstOff.attempts;
  const current = lastAttempt(wo);
  const outcome = attemptOutcome(current);
  const covers = wo.firstOff.covers || [];
  const coveredOrders = allOrders.filter((o) => covers.includes(o.woNo));
  const candidates = allOrders.filter(
    (o) => o.partNo === wo.partNo && o.woNo !== wo.woNo && !o.isParent && (o.status === "Open" || o.status === "Issued") && !o.firstOff && !o.firstOffRef
  );
  [...pullSel].forEach((n) => {
    if (!candidates.some((o) => o.woNo === n)) pullSel.delete(n);
  });
  const machineLabels = machines.map(machineLabel);
  const spots = wo.firstOff.spots || [];
  const batchChoices = [...new Set([wo, ...coveredOrders].map((o) => o.batchNo).filter(Boolean))];

  const options = (list, selected, blank) =>
    `<option value="">${blank}</option>` +
    list.map((v) => `<option ${v === selected ? "selected" : ""}>${esc(v)}</option>`).join("");
  const personOptions = (selected) => options(people, selected, "Select") + `<option value="${ADD_NEW}">+ Add new name…</option>`;
  const machineOptions = (selected) =>
    options(selected && !machineLabels.includes(selected) ? [...machineLabels, selected] : machineLabels, selected, "Select machine") +
    `<option value="${ADD_NEW}">+ Type a new machine…</option>`;

  const opBlock = (op, i) => {
    const needsDisposition = op.result === "fail" || op.result === "rework";
    return `
    <div class="fo-op">
      <div class="fo-op-head">
        <span class="fo-op-name">OP${i + 1}</span>
        <div class="fo-result">
          ${[["pass", "Pass"], ["rework", "Rework"], ["fail", "Fail"]]
            .map(([k, label]) => `<button data-result="${k}" data-op="${i}" class="${op.result === k ? "is-" + k : ""}">${label}</button>`)
            .join("")}
        </div>
      </div>
      <div class="fo-grid">
        <div class="form-group"><label>Machine (name or number)</label>
          <select data-field="machine" data-op="${i}">${machineOptions(op.machine)}</select></div>
        <div class="form-group"><label>Operated by</label>
          <select data-field="operatedBy" data-op="${i}">${personOptions(op.operatedBy)}</select>
          <div class="fo-stamp">${op.operatedBy ? `Initials ${esc(initials(op.operatedBy))} · ${esc(formatDate(op.operatedAt))}` : ""}</div></div>
        <div class="form-group"><label>2nd check by</label>
          <select data-field="checkedBy" data-op="${i}">${personOptions(op.checkedBy)}</select>
          <div class="fo-stamp">${op.checkedBy ? `Initials ${esc(initials(op.checkedBy))} · ${esc(formatDate(op.checkedAt))}` : ""}</div></div>
      </div>
      ${
        needsDisposition
          ? `<div class="form-group"><label>What was done with the piece</label>
               <select data-field="disposition" data-op="${i}">
                 <option value="scrap" ${op.disposition === "scrap" ? "selected" : ""}>Scrapped, logged as a reject on the work order</option>
                 <option value="rework" ${op.disposition === "rework" ? "selected" : ""}>Reworked, re-checked in the next attempt</option>
                 <option value="accept" ${op.disposition === "accept" ? "selected" : ""}>Accepted with a note</option>
               </select>
               ${op.rejectAt ? `<div class="fo-stamp">Reject logged on the work order · ${esc(formatDate(op.rejectAt))}</div>` : ""}</div>`
          : ""
      }
      <div class="form-group"><label>Comment</label>
        <input data-field="comment" data-op="${i}" value="${esc(op.comment)}" placeholder="${needsDisposition ? "What went wrong, and what was done" : "Measurements, finding, what was done"}" /></div>
      <div class="fo-attach">
        <span class="hint">Attachment</span>
        ${op.file ? `<a class="fo-chip" href="${esc(op.file.url)}" target="_blank" rel="noopener">${esc(op.file.name)}</a>` : ""}
        <button class="pill-link" data-attach="${i}">${op.file ? "Replace" : DRIVE_UPLOAD_URL ? "Attach photo, PDF or doc" : "Attach (Drive not connected)"}</button>
        <input type="file" hidden data-file="${i}" accept="image/*,.pdf,.doc,.docx" />
      </div>
    </div>`;
  };

  const quality = wo.firstOff.quality;
  const signed = !!quality && quality.status === "signed";
  const sentBack = !!quality && quality.status === "sent-back";
  const canRetry = outcome === "rework" || outcome === "fail" || sentBack;

  const qualityBlock = signed
    ? `<div class="ok-box">Signed off by ${esc(quality.by)} · ${esc(formatDate(quality.at))}${quality.note ? " · " + esc(quality.note) : ""}</div>
       <div class="btn-row"><button class="btn" id="fo-q-withdraw">Withdraw sign-off</button></div>`
    : sentBack
      ? `<div class="warn-box">Sent back by ${esc(quality.by)} · ${esc(formatDate(quality.at))}: ${esc(quality.note)}</div>`
      : outcome === "pass"
        ? `<div class="form-group"><label>Reviewed by</label><select id="fo-q-by">${personOptions("")}</select></div>
           <div class="form-group"><label>Note (needed to send back)</label><input id="fo-q-note" placeholder="Optional for sign-off" /></div>
           <div class="btn-row"><button class="btn danger" id="fo-q-back">Send back</button><button class="btn primary-lime" id="fo-q-sign">Sign off</button></div>`
        : `<div class="hint" style="padding:0 16px;">Quality can review once every operation has passed.</div>`;

  const banners = {
    pass: `<div class="ok-box">First-off passed. It covers the work orders and batches below.</div>`,
    rework: `<div class="warn-box">Rework needed. Hold the covered batches until the piece is reworked and re-checked, then start another attempt.</div>`,
    fail: `<div class="warn-box">Failed. Hold the covered batches until another attempt passes.</div>`
  };

  const allCovered = [wo, ...coveredOrders];
  const totalPcs = allCovered.reduce((sum, o) => sum + (o.qty || 0), 0);
  const coverRows = allCovered
    .map(
      (o, idx) => `<tr>
        <td class="mono"><a href="#/work-orders/${encodeURIComponent(o.woNo)}">${esc(o.woNo)}</a></td>
        <td>${esc(o.batchNo) || "—"}</td>
        <td class="mono">${esc(o.qty)}</td>
        <td style="text-align:right;">${idx === 0 ? `<span class="rc-chip">holds the card</span>` : `<button class="pill-link" data-uncover="${esc(o.woNo)}">Remove</button>`}</td>
      </tr>`
    )
    .join("");

  const groups = [...new Set(candidates.map((o) => o.parentWoNo).filter(Boolean))];
  const pullPanel = `
    <div class="fo-panel">
      <div class="hint" style="margin:0 0 8px;">Same part, already picked up, not on another card.</div>
      ${candidates
        .map(
          (o) => `<label class="rcn-pick ${pullSel.has(o.woNo) ? "is-on" : ""}">
            <input type="checkbox" data-pull="${esc(o.woNo)}" ${pullSel.has(o.woNo) ? "checked" : ""} />
            <div><b class="mono">${esc(o.woNo)}</b>
              <div class="hint">${esc(o.qty)} pcs · batch ${esc(o.batchNo) || "none yet"}${o.assignee ? " · " + esc(o.assignee) : ""}</div></div>
          </label>`
        )
        .join("")}
      <div class="fo-attach" style="padding:0;">
        <button class="pill-link" id="fo-pull-all">Select all ${candidates.length}</button>
        ${groups.map((g) => `<button class="pill-link" data-pull-group="${esc(g)}">Select all of ${esc(g)}</button>`).join("")}
        <button class="pill-link" id="fo-pull-add">Add selected (${pullSel.size})</button>
      </div>
    </div>`;

  const spotRows = spots
    .map(
      (s) => `<tr>
        <td>${esc(formatDate(s.at))}</td>
        <td>${esc(s.batch) || "—"}</td>
        <td class="mono">${esc(s.pieces)}</td>
        <td><span class="rc-chip ${s.result === "pass" ? "ok" : "bad"}">${s.result === "pass" ? "Pass" : "Fail"}</span></td>
        <td>${esc(initials(s.by))}</td>
        <td>${esc(s.note)}</td>
      </tr>`
    )
    .join("");
  const spotFails = spots.filter((s) => s.result === "fail").length;

  root.innerHTML = `
    ${title}
    ${attempts.length > 1 ? `<div class="hint" style="padding:0 16px 8px;">${attempts.slice(0, -1).map((a) => `Attempt ${a.n}: ${esc(FIRST_OFF_LABELS[attemptOutcome(a) || "progress"])} (${esc(formatDate(a.startedAt))})`).join(" · ")}</div>` : ""}
    <div class="hint" style="padding:0 16px 8px;">Attempt ${current.n} · started ${esc(formatDate(current.startedAt))}</div>
    ${current.ops.map(opBlock).join("")}
    <div class="btn-row"><button class="btn" id="fo-add-op">+ Add operation</button></div>
    ${banners[outcome] || ""}
    ${canRetry ? `<div class="btn-row"><button class="btn primary-lime" id="fo-new-attempt">Start another attempt</button></div>` : ""}

    <div class="section-title">Quality review</div>
    ${qualityBlock}

    <div class="section-title">Covers</div>
    <div class="hint" style="padding:0 16px 8px;">One first-off clears all of these work orders and batches. ${allCovered.length} order${allCovered.length === 1 ? "" : "s"}, ${totalPcs} pcs.</div>
    <table class="reject-table"><thead><tr><th>Work order</th><th>Batch</th><th>Qty</th><th></th></tr></thead><tbody>${coverRows}</tbody></table>
    ${
      candidates.length
        ? `<div class="btn-row"><button class="btn" id="fo-pull">${pullOpen ? "Close" : "Pull more work orders"}</button></div>${pullOpen ? pullPanel : ""}`
        : `<div class="hint" style="padding:8px 16px 0;">No other picked-up orders for this part to pull in.</div>`
    }

    <div class="section-title">Spot checks during the run</div>
    <div class="hint" style="padding:0 16px 8px;">Random pieces checked while the batches run. Each one goes on the report with its batch.</div>
    ${
      spots.length
        ? `<table class="reject-table"><thead><tr><th>When</th><th>Batch</th><th>Pcs</th><th>Result</th><th>By</th><th>Note</th></tr></thead><tbody>${spotRows}</tbody></table>`
        : `<div class="hint" style="padding:0 16px;">No spot checks yet.</div>`
    }
    ${spotFails ? `<div class="warn-box">${spotFails} spot check failed. It is recorded with its note and shown in the PDF. Nothing is held automatically.</div>` : ""}
    <div class="fo-grid" style="margin-top:10px;">
      <div class="form-group"><label>Batch</label>
        <select id="fo-spot-batch">${batchChoices.map((b) => `<option>${esc(b)}</option>`).join("")}<option value="">Not listed</option></select></div>
      <div class="form-group"><label>Pieces checked</label><input id="fo-spot-pcs" type="number" min="1" step="1" value="1" inputmode="numeric" /></div>
      <div class="form-group"><label>Result</label><select id="fo-spot-result"><option value="pass">Pass</option><option value="fail">Fail</option></select></div>
      <div class="form-group"><label>Checked by</label><select id="fo-spot-by">${personOptions("")}</select></div>
    </div>
    <div class="form-group"><label>Note</label><input id="fo-spot-note" placeholder="What you found" /></div>
    <div class="btn-row"><button class="btn" id="fo-spot-add">Add spot check</button></div>

    <div class="section-title">Report</div>
    <div class="hint" style="padding:0 16px 8px;">The PDF has the covered orders, every operation with initials, spot checks and the quality review. ${signed ? "It is signed off." : "It stays a draft until quality signs off."}</div>
    <div class="btn-row"><button class="btn ${signed ? "primary-lime" : ""}" id="fo-pdf">${signed ? "Download signed PDF" : "Download draft PDF"}</button></div>

    <div class="section-title">Saved machines</div>
    <div class="hint" style="padding:0 16px 8px;">Pick one from any operation, or type a new one there. A machine needs a name or a number.</div>
    <div class="fo-grid">
      <div class="form-group"><label>Machine name</label><input id="fo-machine-name" placeholder="Waterjet" /></div>
      <div class="form-group"><label>Number</label><input id="fo-machine-number" placeholder="WJ-02" /></div>
    </div>
    <div class="btn-row"><button class="btn" id="fo-machine-add">Save machine</button></div>
    ${machines.length ? `<div class="fo-attach">${machines.map((m) => `<span class="fo-chip">${esc(machineLabel(m))}</span>`).join("")}</div>` : ""}
  `;

  root.onclick = async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.id === "fo-new-attempt") return startAttempt(wo);
    if (t.id === "fo-add-op") return void (await saveAttempt(wo, (a) => void a.ops.push(blankFirstOffOp())));
    if (t.id === "fo-pdf") {
      if (!downloadRouteCardPdf(wo, allOrders)) toast("The PDF tool is still loading. Try again in a moment.");
      return;
    }
    if (t.id === "fo-q-sign" || t.id === "fo-q-back") {
      let by = root.querySelector("#fo-q-by").value;
      if (by === ADD_NEW) {
        by = (window.prompt("New name") || "").trim();
        if (by) await ensureKnownUser(by);
      }
      const note = root.querySelector("#fo-q-note").value.trim();
      const sign = t.id === "fo-q-sign";
      if (!by) return void toast("Pick who is reviewing.");
      if (!sign && !note) return void toast("Add a note so the machine shop knows what to fix.");
      await saveFirstOff(
        wo,
        (f) => void (f.quality = { status: sign ? "signed" : "sent-back", by, at: Date.now(), note, attempt: f.attempts.length }),
        true
      );
      return;
    }
    if (t.id === "fo-q-withdraw") return void (await saveFirstOff(wo, (f) => void delete f.quality, true));
    if (t.dataset.result) {
      const i = Number(t.dataset.op);
      const next = t.dataset.result;
      let scrapped = null;
      const saved = await saveAttempt(wo, (a) => {
        const op = a.ops[i];
        if (!op.operatedBy || !op.checkedBy) return "Pick Operated by and 2nd check by first.";
        if (op.result === next) {
          op.result = "";
          op.disposition = "";
          return;
        }
        op.result = next;
        op.disposition = next === "fail" ? "scrap" : next === "rework" ? "rework" : "";
        if (op.disposition === "scrap" && !op.rejectAt) {
          op.rejectAt = Date.now();
          scrapped = { attempt: a.n, op: i, user: op.checkedBy, comment: op.comment };
        }
      });
      if (saved && scrapped) logScrap(wo, scrapped);
      return;
    }
    if (t.dataset.attach !== undefined) {
      if (!DRIVE_UPLOAD_URL) {
        toast("Google Drive isn't connected yet - attachments will switch on once it is.");
        return;
      }
      root.querySelector(`[data-file="${t.dataset.attach}"]`).click();
      return;
    }
    if (t.id === "fo-pull") {
      pullOpen = !pullOpen;
      return void renderFirstOff(wo, root);
    }
    if (t.id === "fo-pull-all") {
      candidates.forEach((o) => pullSel.add(o.woNo));
      return void renderFirstOff(wo, root);
    }
    if (t.dataset.pullGroup) {
      candidates.filter((o) => o.parentWoNo === t.dataset.pullGroup).forEach((o) => pullSel.add(o.woNo));
      return void renderFirstOff(wo, root);
    }
    if (t.id === "fo-pull-add") {
      const picks = candidates.filter((o) => pullSel.has(o.woNo)).map((o) => o.woNo);
      if (picks.length === 0) return void toast("Tick at least one work order.");
      try {
        await addFirstOffCovers(wo, picks);
        pullSel.clear();
        pullOpen = false;
        toast(`${picks.length} work order${picks.length === 1 ? "" : "s"} added to this first-off.`);
      } catch (err) {
        console.error(err);
        toast("Couldn't save — check your connection.");
      }
      return;
    }
    if (t.dataset.uncover) {
      try {
        await removeFirstOffCover(wo, t.dataset.uncover);
        toast(`${t.dataset.uncover} taken off this first-off.`);
      } catch (err) {
        console.error(err);
        toast("Couldn't save — check your connection.");
      }
      return;
    }
    if (t.id === "fo-spot-add") {
      let by = root.querySelector("#fo-spot-by").value;
      if (by === ADD_NEW) {
        by = (window.prompt("New name") || "").trim();
        if (by) await ensureKnownUser(by);
      }
      const pieces = Math.round(Number(root.querySelector("#fo-spot-pcs").value));
      if (!by) return void toast("Pick who checked it.");
      if (!pieces || pieces < 1) return void toast("Enter how many pieces were checked.");
      const spot = {
        at: Date.now(),
        batch: root.querySelector("#fo-spot-batch").value,
        pieces,
        result: root.querySelector("#fo-spot-result").value,
        by,
        note: root.querySelector("#fo-spot-note").value.trim()
      };
      await saveFirstOff(wo, (f) => void (f.spots = [...(f.spots || []), spot]));
      return;
    }
    if (t.id === "fo-machine-add") {
      const name = root.querySelector("#fo-machine-name").value.trim();
      const number = root.querySelector("#fo-machine-number").value.trim();
      if (!name && !number) {
        toast("Enter a machine name or number.");
        return;
      }
      await addMachine({ name, number });
      toast("Machine saved.");
      renderFirstOff(wo, root);
    }
  };

  root.onchange = async (e) => {
    const t = e.target;
    const i = Number(t.dataset.op);
    if (t.dataset.file !== undefined) return uploadAttachment(wo, Number(t.dataset.file), t.files[0], root);
    if (t.dataset.pull) {
      if (t.checked) pullSel.add(t.dataset.pull);
      else pullSel.delete(t.dataset.pull);
      return void renderFirstOff(wo, root);
    }
    if (!t.dataset.field) return;

    const field = t.dataset.field;
    let value = t.value;
    if (value === ADD_NEW) {
      const isMachine = field === "machine";
      const typed = (window.prompt(isMachine ? "Machine name or number" : "New name") || "").trim();
      if (!typed) return renderFirstOff(wo, root);
      if (isMachine) await addMachine({ name: typed, number: "" });
      else await ensureKnownUser(typed);
      value = typed;
    }

    let scrapped = null;
    const saved = await saveAttempt(wo, (a) => {
      const op = a.ops[i];
      if (field === "operatedBy" || field === "checkedBy") {
        const other = field === "operatedBy" ? op.checkedBy : op.operatedBy;
        if (value && value === other) return "The operator and the 2nd checker must be different people.";
        op[field] = value;
        op[field === "operatedBy" ? "operatedAt" : "checkedAt"] = value ? Date.now() : 0;
      } else if (field === "disposition") {
        if (value === "accept" && !op.comment) return "Add a comment first. It goes in the report.";
        op.disposition = value;
        if (value === "scrap" && !op.rejectAt && (op.result === "fail" || op.result === "rework")) {
          op.rejectAt = Date.now();
          scrapped = { attempt: a.n, op: i, user: op.checkedBy || op.operatedBy, comment: op.comment };
        }
      } else {
        op[field] = value;
      }
    });
    if (saved && scrapped) logScrap(wo, scrapped);
    if (!saved) renderFirstOff(wo, root);
  };
}

// A scrapped first-off piece is a reject like any other: it lands on the
// work order (so the Rejects report and the counts include it). Nothing goes
// back to stock - the piece is gone.
function logScrap(wo, { attempt, op, user, comment }) {
  const reason = `First-off attempt ${attempt}, OP${op + 1}${comment ? ": " + comment : ""}`;
  recordWorkOrderReject(wo, { qty: 1, reason, returnedQty: 0, user }).catch((err) => {
    console.error(err);
    toast("The first-off was saved, but the reject couldn't be logged. Record it on the work order.");
  });
}

async function startAttempt(wo) {
  const firstOff = wo.firstOff ? JSON.parse(JSON.stringify(wo.firstOff)) : { attempts: [], covers: [] };
  firstOff.attempts.push(newFirstOffAttempt(firstOff.attempts.length + 1));
  // A new attempt needs a fresh review; the earlier decision stays on record.
  if (firstOff.quality) {
    firstOff.qualityHistory = [...(firstOff.qualityHistory || []), firstOff.quality];
    delete firstOff.quality;
  }
  try {
    await updateWorkOrderFields(wo.woNo, { firstOff });
  } catch (err) {
    console.error(err);
    toast("Couldn't save — check your connection.");
  }
}

async function saveAttempt(wo, mutate) {
  return saveFirstOff(wo, (firstOff) => mutate(firstOff.attempts[firstOff.attempts.length - 1]));
}

// Once quality has signed a card off, the operations are frozen until the
// sign-off is withdrawn - otherwise a signed record could change silently.
async function saveFirstOff(wo, mutate, allowSigned) {
  const firstOff = JSON.parse(JSON.stringify(wo.firstOff));
  if (!allowSigned && firstOff.quality && firstOff.quality.status === "signed") {
    toast("This card is signed off. Withdraw the sign-off to change it.");
    return false;
  }
  const problem = mutate(firstOff);
  if (problem) {
    toast(problem);
    return false;
  }
  try {
    await updateWorkOrderFields(wo.woNo, { firstOff });
    return true;
  } catch (err) {
    console.error(err);
    toast("Couldn't save — check your connection.");
    return false;
  }
}

async function uploadAttachment(wo, opIndex, file, root) {
  if (!file) return;
  const okType = file.type.startsWith("image/") || /\.(pdf|docx?|jpe?g|png|heic|webp)$/i.test(file.name);
  if (!okType) {
    toast("Attach a photo, PDF or Word doc.");
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    toast("That file is over 10 MB.");
    return;
  }

  const button = root.querySelector(`[data-attach="${opIndex}"]`);
  button.disabled = true;
  button.textContent = "Uploading…";
  try {
    const uploaded = await uploadToDrive(file, wo.woNo, opIndex + 1);
    await saveAttempt(wo, (a) => void (a.ops[opIndex].file = uploaded));
    toast("Attachment saved to Google Drive.");
  } catch (err) {
    console.error(err);
    toast("Couldn't upload to Google Drive — try again.");
    renderFirstOff(wo, root);
  }
}

async function uploadToDrive(file, woNo, opNo) {
  let blob = file;
  let mimeType = file.type || "application/octet-stream";
  let name = file.name;
  if (file.type.startsWith("image/")) {
    const shrunk = await shrinkImage(file);
    if (shrunk) {
      blob = shrunk;
      mimeType = "image/jpeg";
      name = name.replace(/\.[^.]+$/, "") + ".jpg";
    }
  }
  const fileName = `OP${opNo}-${name}`;
  const res = await fetch(DRIVE_UPLOAD_URL, {
    method: "POST",
    // text/plain keeps this a "simple" request - Apps Script web apps don't
    // answer the preflight a JSON content type would trigger.
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ secret: DRIVE_UPLOAD_SECRET, folder: woNo, name: fileName, mimeType, data: await toBase64(blob) })
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || "Upload failed");
  return { name: fileName, url: json.url };
}

// Phone photos are several MB; a 1600px JPEG is plenty for an inspection
// record. Returns null (upload the original) if the browser can't decode it.
async function shrinkImage(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
  } catch (err) {
    return null;
  }
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
