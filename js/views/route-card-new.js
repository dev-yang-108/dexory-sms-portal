/* New route card: pick the work orders one first-off will cover (one part at
   a time, and only orders the machine shop has already picked up). Part,
   revision, name, qty and batches fill in from the orders; everything else
   is filled in on the card itself. */

import { esc, mount, setViewCleanup, toast } from "../render.js";
import { subscribeWorkOrders, createRouteCard } from "../db.js";
import { dxNavHTML, wireSectionNav } from "../section-nav.js";
import { navigate } from "../../app.js";

let unsub = null;
let candidates = [];
let parents = new Map();
let selected = new Set();

export function renderRouteCardNewView() {
  if (unsub) unsub();
  selected = new Set();

  mount(`
    <div class="dx-app">
      ${dxNavHTML("route-cards")}
      <div class="dx-main">
        <div class="dx-content">
          <div class="dash-title">New route card</div>
          <div class="dash-sub">Pick the work orders this first-off covers. The details fill in by themselves.</div>
          <div id="rcn-body" style="padding:8px 16px 16px;"><div class="empty-state">Loading…</div></div>
        </div>
      </div>
    </div>
  `);

  wireSectionNav();

  unsub = subscribeWorkOrders((orders) => {
    parents = new Map(orders.filter((o) => o.isParent).map((o) => [o.woNo, o]));
    // Running orders only (Open or Issued), a real order (not a Production
    // Request parent) and not already on a route card.
    candidates = orders
      .filter((o) => !o.isParent && (o.status === "Open" || o.status === "Issued") && !o.firstOff && !o.firstOffRef)
      .sort((a, b) => (a.date || 0) - (b.date || 0));
    renderBody();
  });
  setViewCleanup(() => {
    if (unsub) unsub();
    unsub = null;
  });
}

function renderBody() {
  const body = document.getElementById("rcn-body");
  if (!body) return;

  const chosen = candidates.filter((o) => selected.has(o.woNo));
  const lockedPart = chosen.length ? chosen[0].partNo : null;

  const pick = (o) => {
    const otherPart = lockedPart && o.partNo !== lockedPart;
    return `
      <label class="rcn-pick ${selected.has(o.woNo) ? "is-on" : ""} ${otherPart ? "is-off" : ""}">
        <input type="checkbox" data-wo="${esc(o.woNo)}" ${selected.has(o.woNo) ? "checked" : ""} ${otherPart ? "disabled" : ""} />
        <div>
          <div><b class="mono">${esc(o.woNo)}</b> <span class="rc-chip">${esc(o.status)}</span></div>
          <div class="hint">${esc(o.partNo)} · R${esc(o.rev)} · ${esc(o.qty)} pcs · batch ${esc(o.batchNo) || "none yet"}${o.assignee ? " · " + esc(o.assignee) : ""}</div>
          ${otherPart ? `<div class="hint" style="color:var(--orange);">Different part. Finish this card first.</div>` : ""}
        </div>
      </label>`;
  };

  const first = chosen[0];
  const batches = chosen.map((o) => o.batchNo).filter(Boolean);
  const cell = (label, value) => `<div class="rc-cell"><span>${label}</span><b>${value}</b></div>`;

  // A Production Request is a heading with its running weekly orders under
  // it; everything else is a plain single order.
  const singles = candidates.filter((o) => !o.parentWoNo);
  const parentNos = [...new Set(candidates.filter((o) => o.parentWoNo).map((o) => o.parentWoNo))];
  const groupHTML = parentNos
    .map((parentNo) => {
      const children = candidates.filter((o) => o.parentWoNo === parentNo);
      const parent = parents.get(parentNo);
      return `
        <div class="rcn-group">
          <div class="rcn-group-head">
            <div><b class="mono">${esc(parentNo)}</b> <span class="rc-chip">Production request</span>
              <div class="hint">${parent ? esc(parent.partNo) + " · " : ""}${children.length} week${children.length === 1 ? "" : "s"} running</div></div>
            <button class="pill-link" data-group="${esc(parentNo)}">Select all weeks</button>
          </div>
          ${children.map(pick).join("")}
        </div>`;
    })
    .join("");

  body.innerHTML = `
    <div class="rcn-cols">
      <div>
        <div class="section-title" style="margin-top:0;">1. Choose work orders</div>
        ${groupHTML}
        ${singles.length ? `${parentNos.length ? `<div class="hint" style="margin:6px 0;">Single orders</div>` : ""}${singles.map(pick).join("")}` : ""}
        ${candidates.length ? "" : `<div class="empty-state">No work orders are ready. Orders appear here once the machine shop has picked them up.</div>`}
      </div>
      <div>
        <div class="section-title" style="margin-top:0;">2. Filled in automatically</div>
        <div class="rc-meta">
          ${cell("Part number", first ? esc(first.partNo) : "Choose an order")}
          ${cell("Revision", first ? "R" + esc(first.rev) : "None yet")}
          ${cell("Part name", first ? esc(first.partName) || "None yet" : "None yet")}
          ${cell("Total qty", chosen.reduce((s, o) => s + (o.qty || 0), 0) + " pcs")}
          ${cell("Batches", batches.length ? esc(batches.join(", ")) : "None yet")}
          ${cell("Orders covered", chosen.length)}
        </div>
        <div class="rcn-manual"><b>3. The machine shop fills in:</b> machines, operated by, 2nd check by, results, comments and one attachment per operation.</div>
        <div class="btn-row">
          <button class="btn" id="rcn-cancel">Cancel</button>
          <button class="btn primary-lime" id="rcn-create">Create route card</button>
        </div>
      </div>
    </div>
  `;

  body.querySelectorAll("input[data-wo]").forEach((box) => {
    box.onchange = () => {
      if (box.checked) selected.add(box.dataset.wo);
      else selected.delete(box.dataset.wo);
      renderBody();
    };
  });
  body.querySelectorAll("[data-group]").forEach((btn) => {
    btn.onclick = () => {
      // The first order ticked fixes the part, so a group only adds weeks of
      // that same part.
      const part = lockedPart || (candidates.find((o) => o.parentWoNo === btn.dataset.group) || {}).partNo;
      candidates.filter((o) => o.parentWoNo === btn.dataset.group && o.partNo === part).forEach((o) => selected.add(o.woNo));
      renderBody();
    };
  });
  document.getElementById("rcn-cancel").onclick = () => navigate("#/route-cards");
  document.getElementById("rcn-create").onclick = async () => {
    if (chosen.length === 0) {
      toast("Choose at least one work order.");
      return;
    }
    const [primary, ...rest] = chosen;
    try {
      await createRouteCard(primary.woNo, rest.map((o) => o.woNo));
      toast("Route card created.");
      navigate("#/route-cards/" + encodeURIComponent(primary.woNo));
    } catch (err) {
      console.error(err);
      toast("Couldn't save — check your connection.");
    }
  };
}
