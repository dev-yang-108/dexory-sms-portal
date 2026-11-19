/* IDN detail - renders the actual delivery note (matching the real Dexory
   template) plus a Print button. window.print() with @media print rules
   isolates just the note itself, same pattern as the barcode label. */

import { esc, mount, setViewCleanup, formatDate, toast } from "../render.js";
import { subscribeIdn, voidIdn } from "../db.js";
import { navigate } from "../../app.js";
import { downloadIdnPdf } from "../idn-pdf.js";
import { IDN_FOLDER_URL } from "../../drive-config.js";

let idnUnsub = null;

export function renderIdnDetailView(idnNo) {
  if (idnUnsub) idnUnsub();

  mount(`
    <header class="topbar">
      <button class="icon-btn" id="btn-back" aria-label="Back">&larr;</button>
      <div class="topbar-spacer"></div>
      <button class="pill-link" id="btn-drive">Save to Drive</button>
      <button class="pill-link" id="btn-print">Send to printer</button>
    </header>
    <div id="idn-body"><div class="empty-state">Loading…</div></div>
  `);

  document.getElementById("btn-back").onclick = () => navigate("#/idns");

  idnUnsub = subscribeIdn(idnNo, (idn) => {
    if (!idn) {
      document.getElementById("idn-body").innerHTML = `<div class="empty-state">IDN "${esc(idnNo)}" was not found.</div>`;
      return;
    }
    renderBody(idn);
  });

  setViewCleanup(() => {
    if (idnUnsub) idnUnsub();
    idnUnsub = null;
  });
}

function renderBody(idn) {
  document.getElementById("idn-body").innerHTML = `
    ${idn.voided ? `<div class="low-badge-inline" style="margin:16px;">VOIDED${idn.voidedAt ? " · " + formatDate(idn.voidedAt) : ""}</div>` : ""}
    <div class="idn-print-area">
      <div class="idn-sheet ${idn.voided ? "idn-sheet--voided" : ""}">
        <div class="idn-head">
          <div>
            <div class="idn-logo">DEXORY</div>
            <div class="idn-addr">Unit 4 Verda Park<br/>Wallingford<br/><br/>OX10</div>
          </div>
          <div class="idn-refs">
            ${idn.refNo ? `<div class="idn-refbox">Ref No. ${esc(idn.refNo)}</div>` : ""}
            ${idn.po ? `<div class="idn-refbox">${esc(idn.po)}</div>` : ""}
            ${idn.vms ? `<div class="idn-refbox">VMS-${esc(idn.vms)}</div>` : ""}
            ${idn.initials ? `<div class="idn-refgap"></div><div class="idn-refbox" style="text-align:center;">${esc(idn.initials)}</div>` : ""}
          </div>
        </div>
        <div class="idn-date">Date: ${formatDate(idn.date)}</div>
        <table class="idn-table">
          <thead><tr><th>Part Number</th><th>Qty</th><th>Rev</th><th>Comment</th></tr></thead>
          <tbody>
            <tr><td>${esc(idn.partNo)}</td><td class="idn-num">${esc(idn.qty)}</td><td class="idn-num">${esc(idn.rev)}</td><td>${esc(idn.comment || "")}</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <section>
      <div class="section-title">From</div>
      <div class="kv">
        <div class="kv-row"><span class="k">Work order</span><span class="v">${esc(idn.woNo)}</span></div>
        <div class="kv-row"><span class="k">IDN no.</span><span class="v">${esc(idn.idnNo)}</span></div>
      </div>
    </section>

    <section>
      ${
        idn.voided
          ? `<div class="hint">This IDN is voided - it stays on record but no longer counts toward ${esc(idn.woNo)}'s Completed total.</div>`
          : `<button class="btn danger" id="btn-void-idn">Void IDN</button>`
      }
    </section>
  `;

  document.getElementById("btn-print").onclick = () => window.print();
  document.getElementById("btn-drive").onclick = () => {
    // Open the folder first: a new tab is only allowed straight from the click.
    const tab = window.open(IDN_FOLDER_URL, "_blank", "noopener");
    if (!downloadIdnPdf(idn)) {
      if (tab) tab.close();
      toast("The PDF tool is still loading. Try again in a moment.");
      return;
    }
    toast("PDF downloaded. Drag it into the Drive folder that just opened.");
  };
  const voidBtn = document.getElementById("btn-void-idn");
  if (voidBtn) {
    voidBtn.onclick = () => {
      const proceed = window.confirm(
        `Void ${idn.idnNo}? This reduces the Completed count on ${idn.woNo} by ${idn.qty} pcs. The IDN stays on record, clearly marked voided, rather than disappearing.`
      );
      if (!proceed) return;
      voidIdn(idn)
        .then(() => toast("IDN voided."))
        .catch((err) => {
          console.error(err);
          toast("Couldn't void — check your connection.");
        });
    };
  }
}
