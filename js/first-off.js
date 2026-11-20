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
import { DRIVE_UPLOAD_URL, DRIVE_UPLOAD_SECRET, ROUTE_CARD_FOLDER_URL } from "../drive-config.js";

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

// Where a card stands with quality:
//   signed     - quality signed it off (nobody else needs to review it)
//   sent-back  - quality sent it back to the machine shop
//   waiting    - the machine shop sent it to quality (at any stage) and it is
//                waiting for them; this is what the sidebar badge counts
//   ready      - every operation passed but it hasn't been sent yet
//   progress   - still being filled in
export function qualityState(wo) {
  const f = wo.firstOff;
  if (!f || !f.attempts || f.attempts.length === 0) return "progress";
  const q = f.quality;
  if (q && q.status === "signed") return "signed";
  if (q && q.status === "sent-back") return "sent-back";
  if (f.sentToQuality) return "waiting";
  return attemptOutcome(lastAttempt(wo)) === "pass" ? "ready" : "progress";
}

// What the Route cards list shows for a work order that holds (or is covered
// by) a first-off.
export function routeCardInfo(wo) {
  if (!wo.firstOff) return { result: "covered", attempt: 0, quality: `Follows ${wo.firstOffRef}`, tone: "", state: "covered" };
  const attempt = lastAttempt(wo);
  const outcome = attemptOutcome(attempt);
  const q = wo.firstOff.quality;
  const state = qualityState(wo);
  const text = {
    signed: `Signed off, ${q && q.by}`,
    "sent-back": "Sent back",
    waiting: "Waiting for quality",
    ready: "Ready to send",
    progress: "Not ready"
  }[state];
  const tone = { signed: "ok", "sent-back": "bad", waiting: "blue", ready: "", progress: "" }[state];
  return { result: outcome || "progress", attempt: attempt.n, quality: text, tone, state };
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
// "Add work order" box: what is typed survives the card re-drawing itself.
let woQuery = "";
// The "+ Add spot check" form: open or closed.
let spotOpen = false;

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

  const sent = wo.firstOff.sentToQuality;
  const crossChecks = wo.firstOff.crossChecks || [];
  const opsWithResult = current.ops.filter((o) => o.result).length;
  const crossList = crossChecks.length
    ? `<div class="hint" style="margin:0 0 8px;">Quality cross-checks: ${crossChecks
        .map((c) => `${esc(c.by)} (after ${esc(c.afterOps)} op${c.afterOps === 1 ? "" : "s"}, ${esc(formatDate(c.at))}${c.note ? ": " + esc(c.note) : ""})`)
        .join(" · ")}</div>`
    : "";

  // Two plain boxes: what the machine shop does, and what quality does.
  const machineShopBox = sent
    ? `<div class="hint" style="margin:0 0 8px;">Sent by ${esc(sent.by)} · ${esc(formatDate(sent.at))}, after ${esc(sent.afterOps)} operation${sent.afterOps === 1 ? "" : "s"}${sent.partial ? " (partial check)" : ""}. Quality has been notified.</div>
       <button class="btn" id="fo-q-recall">Take back from quality</button>`
    : opsWithResult >= 1
      ? `<div class="hint" style="margin:0 0 8px;">${outcome === "pass" ? "Every operation has passed." : "Not every operation is done yet, so this is a partial check."}</div>
         <div class="form-group" style="padding:0;"><label>Sent by</label><select id="fo-q-sendby">${personOptions("")}</select></div>
         <button class="btn primary-lime" id="fo-q-send">Send to quality${outcome === "pass" ? "" : " (partial check)"}</button>`
      : `<div class="hint">Record a result on the operation first, then you can send it to quality.</div>`;

  const qualityBox = `${crossList}
     <div class="form-group" style="padding:0;"><label>Reviewed by</label><select id="fo-q-by">${personOptions("")}</select></div>
     <div class="form-group" style="padding:0;"><label>Note (needed to send back)</label><input id="fo-q-note" placeholder="Optional for a cross-check or sign-off" /></div>
     <div class="fo-btns"><button class="btn" id="fo-q-cross">Cross-check</button><button class="btn danger" id="fo-q-back">Send back</button>${outcome === "pass" ? `<button class="btn primary-lime" id="fo-q-sign">Final sign-off</button>` : ""}</div>
     ${outcome === "pass" ? "" : `<div class="hint" style="margin-top:6px;">Final sign-off unlocks once every operation has passed.</div>`}`;

  const qualityBlock = signed
    ? `<div class="ok-box">Signed off by ${esc(quality.by)} · ${esc(formatDate(quality.at))}${quality.note ? " · " + esc(quality.note) : ""}.
         Nobody else in quality needs to review this card.</div>
       ${crossChecks.length ? `<div style="padding:0 16px;">${crossList}</div>` : ""}
       <div class="btn-row"><button class="btn" id="fo-q-withdraw">Withdraw sign-off</button></div>`
    : sentBack
      ? `<div class="warn-box">Sent back by ${esc(quality.by)} · ${esc(formatDate(quality.at))}: ${esc(quality.note)}</div>`
      : `<div class="fo-two">
           <div class="fo-box"><div class="fo-box-title">Machine shop</div>${machineShopBox}</div>
           <div class="fo-box"><div class="fo-box-title">Quality</div>${qualityBox}</div>
         </div>`;

  const banners = {
    pass: `<div class="ok-box">First-off passed. It covers every work order on this card.</div>`,
    rework: `<div class="warn-box">Rework needed. Hold the work orders on this card until the piece is reworked and re-checked, then start another attempt.</div>`,
    fail: `<div class="warn-box">Failed. Hold the work orders on this card until another attempt passes.</div>`
  };

  const allCovered = [wo, ...coveredOrders];
  const totalPcs = allCovered.reduce((sum, o) => sum + (o.qty || 0), 0);
  const woChips = allCovered
    .map(
      (o, idx) => `<div class="fo-wo">
        <a class="mono" href="#/work-orders/${encodeURIComponent(o.woNo)}"><b>${esc(o.woNo)}</b></a>
        <span class="hint">${esc(o.batchNo) || "no batch yet"} · ${esc(o.qty)} pcs</span>
        ${idx === 0 ? `<span class="rc-chip">holds the card</span>` : `<button class="pill-link" data-uncover="${esc(o.woNo)}">Remove</button>`}
      </div>`
    )
    .join("");

  // Other picked-up orders for this part, matched by number, last digits or batch.
  const matchesFor = (q) => {
    const n = String(q || "").trim().toLowerCase();
    return candidates.filter((o) => !n || o.woNo.toLowerCase().includes(n) || String(o.batchNo || "").toLowerCase().includes(n));
  };
  const matchRows = (list) =>
    list.length === 0
      ? `<div class="hint" style="padding:6px 16px;">No open work order for this part matches.</div>`
      : list
          .slice(0, 6)
          .map(
            (o) => `<div class="fo-match">
              <div><b class="mono">${esc(o.woNo)}</b>
                <div class="hint">${esc(o.qty)} pcs · batch ${esc(o.batchNo) || "none yet"}${o.assignee ? " · " + esc(o.assignee) : ""}</div></div>
              <button class="btn" data-add-wo="${esc(o.woNo)}">Add</button>
            </div>`
          )
          .join("") +
        (list.length > 1 ? `<div style="padding:6px 16px;"><button class="pill-link" id="fo-wo-addall">Add all ${list.length}</button></div>` : "");

  const spotRows = spots
    .map(
      (s) => `<tr>
        <td>${esc(formatDate(s.at))}</td>
        <td>${s.woNo ? `<span class="mono">${esc(s.woNo)}</span>${s.batch ? ` <span class="hint">${esc(s.batch)}</span>` : ""}` : esc(s.batch) || "—"}</td>
        <td class="mono">${esc(s.pieces)}</td>
        <td><span class="rc-chip ${s.result === "pass" ? "ok" : "bad"}">${s.result === "pass" ? "Pass" : "Fail"}</span></td>
        <td>${esc(initials(s.by))}</td>
        <td>${esc(s.note)}</td>
      </tr>`
    )
    .join("");
  const spotFails = spots.filter((s) => s.result === "fail").length;
  const earlier = attempts.length > 1 ? ` · ${attempts.slice(0, -1).map((a) => `Attempt ${a.n}: ${esc(FIRST_OFF_LABELS[attemptOutcome(a) || "progress"])}`).join(" · ")}` : "";

  root.innerHTML = `
    <div class="section-title">Work orders on this card <span class="hint" style="font-weight:400;">${allCovered.length} order${allCovered.length === 1 ? "" : "s"}, ${totalPcs} pcs</span></div>
    <div class="fo-wos">${woChips}</div>
    ${
      candidates.length
        ? `<div class="fo-addwo"><input id="fo-wo-q" value="${esc(woQuery)}" placeholder="Add work order: number or last digits" autocomplete="off" /></div>
           <div id="fo-wo-matches">${matchRows(matchesFor(woQuery))}</div>`
        : `<div class="hint" style="padding:0 16px;">No other picked-up orders for this part to add.</div>`
    }

    <div class="section-title fo-title-row"><span>Machine shop: first-off</span><button class="pill-link" id="fo-add-op">+ Add operation</button></div>
    <div class="hint" style="padding:0 16px 8px;">Attempt ${current.n} · started ${esc(formatDate(current.startedAt))}${earlier}</div>
    ${current.ops.map(opBlock).join("")}
    ${banners[outcome] || ""}
    ${canRetry ? `<div class="btn-row"><button class="btn primary-lime" id="fo-new-attempt">Start another attempt</button></div>` : ""}

    <div class="section-title fo-title-row"><span>Spot checks</span><button class="pill-link" id="fo-spot-open">${spotOpen ? "Close" : "+ Add spot check"}</button></div>
    ${
      spots.length
        ? `<table class="reject-table"><thead><tr><th>When</th><th>Work order</th><th>Pcs</th><th>Result</th><th>By</th><th>Note</th></tr></thead><tbody>${spotRows}</tbody></table>`
        : `<div class="hint" style="padding:0 16px;">No spot checks yet.</div>`
    }
    ${spotFails ? `<div class="warn-box">${spotFails} spot check failed. It is recorded with its note and shown in the PDF. Nothing is held automatically.</div>` : ""}
    ${
      spotOpen
        ? `<div class="fo-grid" style="margin-top:10px;">
             <div class="form-group"><label>Work order</label>
               <select id="fo-spot-wo">${allCovered.map((o) => `<option value="${esc(o.woNo)}">${esc(o.woNo)}${o.batchNo ? " · " + esc(o.batchNo) : ""}</option>`).join("")}</select></div>
             <div class="form-group"><label>Pieces checked</label><input id="fo-spot-pcs" type="number" min="1" step="1" value="1" inputmode="numeric" /></div>
             <div class="form-group"><label>Result</label><select id="fo-spot-result"><option value="pass">Pass</option><option value="fail">Fail</option></select></div>
             <div class="form-group"><label>Checked by</label><select id="fo-spot-by">${personOptions("")}</select></div>
           </div>
           <div class="form-group"><label>Note</label><input id="fo-spot-note" placeholder="What you found" /></div>
           <div class="btn-row"><button class="btn primary-lime" id="fo-spot-add">Save spot check</button></div>`
        : ""
    }

    <div class="section-title">Send to quality and sign-off</div>
    ${qualityBlock}

    <div class="section-title">Report</div>
    <div class="hint" style="padding:0 16px 8px;">The PDF has the work orders, the operation with initials, spot checks and the quality review. ${signed ? "It is signed off." : "It stays a draft until quality signs off."} Save to Drive downloads it and opens the Route card files folder.</div>
    <div class="btn-row">
      <button class="btn ${signed ? "primary-lime" : ""}" id="fo-pdf">${signed ? "Download signed PDF" : "Download draft PDF"}</button>
      <button class="btn" id="fo-pdf-drive">Save to Drive</button>
    </div>
  `;

  // The matches list updates as you type, without redrawing the card (that
  // would drop the cursor out of the box).
  const qInput = root.querySelector("#fo-wo-q");
  if (qInput) {
    qInput.oninput = () => {
      woQuery = qInput.value;
      root.querySelector("#fo-wo-matches").innerHTML = matchRows(matchesFor(woQuery));
    };
  }

  root.onclick = async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.id === "fo-new-attempt") return startAttempt(wo);
    if (t.id === "fo-add-op") return void (await saveAttempt(wo, (a) => void a.ops.push(blankFirstOffOp())));
    if (t.id === "fo-pdf") {
      if (!downloadRouteCardPdf(wo, allOrders)) toast("The PDF tool is still loading. Try again in a moment.");
      return;
    }
    if (t.id === "fo-pdf-drive") {
      // Open the folder first: a new tab is only allowed straight from the click.
      const tab = window.open(ROUTE_CARD_FOLDER_URL, "_blank", "noopener");
      if (!downloadRouteCardPdf(wo, allOrders)) {
        if (tab) tab.close();
        toast("The PDF tool is still loading. Try again in a moment.");
        return;
      }
      toast("PDF downloaded. Drag it into the Drive folder that just opened.");
      return;
    }
    if (t.id === "fo-q-send") {
      const by = await pickName(root.querySelector("#fo-q-sendby"));
      if (!by) return void toast("Pick who is sending it.");
      const saved = await saveFirstOff(wo, (f) => {
        const cur = f.attempts[f.attempts.length - 1];
        const done = cur.ops.filter((o) => o.result).length;
        f.sentToQuality = { by, at: Date.now(), afterOps: done, partial: attemptOutcome(cur) !== "pass", attempt: f.attempts.length };
      });
      if (saved) toast("Sent to quality. They'll see it on Route cards.");
      return;
    }
    if (t.id === "fo-q-recall") return void (await saveFirstOff(wo, (f) => void delete f.sentToQuality));
    if (t.id === "fo-q-cross") {
      const by = await pickName(root.querySelector("#fo-q-by"));
      if (!by) return void toast("Pick who is cross-checking.");
      const note = root.querySelector("#fo-q-note").value.trim();
      const saved = await saveFirstOff(wo, (f) => {
        const cur = f.attempts[f.attempts.length - 1];
        f.crossChecks = [
          ...(f.crossChecks || []),
          { by, at: Date.now(), note, afterOps: cur.ops.filter((o) => o.result).length, attempt: f.attempts.length }
        ];
        // A mid-way check goes back to the machine shop to carry on with the
        // later operations; a finished card stays with quality for sign-off.
        if (attemptOutcome(cur) !== "pass") delete f.sentToQuality;
      });
      if (saved) toast("Cross-check recorded.");
      return;
    }
    if (t.id === "fo-q-sign" || t.id === "fo-q-back") {
      const by = await pickName(root.querySelector("#fo-q-by"));
      const note = root.querySelector("#fo-q-note").value.trim();
      const sign = t.id === "fo-q-sign";
      if (!by) return void toast("Pick who is reviewing.");
      if (!sign && !note) return void toast("Add a note so the machine shop knows what to fix.");
      await saveFirstOff(
        wo,
        (f) => {
          f.quality = { status: sign ? "signed" : "sent-back", by, at: Date.now(), note, attempt: f.attempts.length };
          delete f.sentToQuality;
        },
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
    if (t.dataset.addWo || t.id === "fo-wo-addall") {
      const picks = t.dataset.addWo ? [t.dataset.addWo] : matchesFor(woQuery).map((o) => o.woNo);
      if (picks.length === 0) return;
      try {
        await addFirstOffCovers(wo, picks);
        woQuery = "";
        toast(`${picks.length} work order${picks.length === 1 ? "" : "s"} added to this card.`);
      } catch (err) {
        console.error(err);
        toast("Couldn't save — check your connection.");
      }
      return;
    }
    if (t.id === "fo-spot-open") {
      spotOpen = !spotOpen;
      return void renderFirstOff(wo, root);
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
      // A spot check is logged against a work order (its batch is kept too,
      // so the report still shows which batch the piece came from).
      const spotWo = root.querySelector("#fo-spot-wo").value;
      const spotOrder = allCovered.find((o) => o.woNo === spotWo) || wo;
      const spot = {
        at: Date.now(),
        woNo: spotOrder.woNo,
        batch: spotOrder.batchNo || "",
        pieces,
        result: root.querySelector("#fo-spot-result").value,
        by,
        note: root.querySelector("#fo-spot-note").value.trim()
      };
      // Close the form before saving: the card redraws as soon as the data
      // changes, so it would otherwise redraw with the form still open.
      spotOpen = false;
      const saved = await saveFirstOff(wo, (f) => void (f.spots = [...(f.spots || []), spot]));
      if (!saved) spotOpen = true;
      return;
    }
  };

  root.onchange = async (e) => {
    const t = e.target;
    const i = Number(t.dataset.op);
    if (t.dataset.file !== undefined) return uploadAttachment(wo, Number(t.dataset.file), t.files[0], root);
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

// The name picked in a person dropdown; "+ Add new name" asks for it and saves
// it to the shared list. Empty when nothing is picked.
async function pickName(select) {
  let name = select ? select.value : "";
  if (name === ADD_NEW) {
    name = (window.prompt("New name") || "").trim();
    if (name) await ensureKnownUser(name);
  }
  return name;
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
  delete firstOff.sentToQuality;
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
