/* One route card: header with where it stands, then the first-off card itself
   (operations, covers, quality review) - the same card shown on the work
   order's own page, just opened from here. A covered order jumps to the card
   that covers it. */

import { esc, mount, setViewCleanup, toast } from "../render.js";
import { subscribeWorkOrder, deleteRouteCard } from "../db.js";
import { dxNavHTML, wireSectionNav } from "../section-nav.js";
import { renderFirstOff, routeCardInfo, FIRST_OFF_LABELS } from "../first-off.js";
import { navigate } from "../../app.js";

let unsub = null;

async function confirmDelete(wo) {
  const q = wo.firstOff.quality;
  if (q && q.status === "signed") {
    toast("This card is signed off. Withdraw the sign-off before deleting it.");
    return;
  }
  const covers = (wo.firstOff.covers || []).length;
  const proceed = window.confirm(
    `Are you sure you want to delete the route card for ${wo.woNo}?\n\n` +
      `This removes its operations, spot checks and quality review.` +
      (covers ? ` The ${covers} other order${covers === 1 ? "" : "s"} it covered can be put on a new card.` : "") +
      ` Rejects already logged from it stay on the work order. This can't be undone.`
  );
  if (!proceed) return;
  try {
    await deleteRouteCard(wo);
    toast("Route card deleted.");
    navigate("#/route-cards");
  } catch (err) {
    console.error(err);
    toast("Couldn't delete — check your connection.");
  }
}

export function renderRouteCardDetailView(woNo) {
  if (unsub) unsub();

  mount(`
    <div class="dx-app">
      ${dxNavHTML("route-cards")}
      <div class="dx-main">
        <div class="dx-content" style="max-width:860px;">
          <div id="rcd-head"><div class="empty-state">Loading…</div></div>
          <div id="rcd-card"></div>
          <div id="rcd-delete"></div>
        </div>
      </div>
    </div>
  `);

  wireSectionNav();

  unsub = subscribeWorkOrder(woNo, (wo) => {
    const head = document.getElementById("rcd-head");
    const card = document.getElementById("rcd-card");
    if (!head || !card) return;

    if (!wo) {
      head.innerHTML = `<div class="empty-state">Route card "${esc(woNo)}" was not found.</div>`;
      card.innerHTML = "";
      return;
    }
    if (!wo.firstOff && wo.firstOffRef) {
      navigate("#/route-cards/" + encodeURIComponent(wo.firstOffRef));
      return;
    }
    if (!wo.firstOff) {
      head.innerHTML = `<div class="empty-state">${esc(wo.woNo)} has no route card yet. <a class="pill-link" href="#/route-cards/new">New route card</a></div>`;
      card.innerHTML = "";
      return;
    }

    const info = routeCardInfo(wo);
    const resultTone = { pass: "ok", rework: "warn", fail: "bad" }[info.result] || "";
    const cell = (label, value) => `<div class="rc-cell"><span>${label}</span><b>${value}</b></div>`;
    head.innerHTML = `
      <div class="rc-head">
        <div>
          <div class="dash-title"><span class="mono">${esc(wo.woNo)}</span> first-off</div>
          <div class="dash-sub">${esc(wo.partNo)} · ${esc(wo.partName) || "No part name"} · R${esc(wo.rev)}</div>
        </div>
        <div class="rc-chips">
          <span class="rc-chip">Attempt ${info.attempt}</span>
          <span class="rc-chip ${resultTone}">${esc(FIRST_OFF_LABELS[info.result] || info.result)}</span>
          <span class="rc-chip ${info.tone}">${esc(info.quality)}</span>
        </div>
      </div>
      <div class="rc-meta" style="padding:0 16px 8px;">
        ${cell("Work order", `<a class="mono" href="#/work-orders/${encodeURIComponent(wo.woNo)}">${esc(wo.woNo)}</a>`)}
        ${cell("Part number", esc(wo.partNo))}
        ${cell("Revision", "R" + esc(wo.rev))}
        ${cell("Qty", esc(wo.qty) + " pcs")}
        ${cell("Batch", esc(wo.batchNo) || "None yet")}
        ${cell("First-off checks", "1 piece")}
      </div>
    `;
    renderFirstOff(wo, card);

    document.getElementById("rcd-delete").innerHTML = `<section><button class="btn danger" id="rcd-delete-btn">Delete route card</button></section>`;
    document.getElementById("rcd-delete-btn").onclick = () => confirmDelete(wo);
  });
  setViewCleanup(() => {
    if (unsub) unsub();
    unsub = null;
  });
}
