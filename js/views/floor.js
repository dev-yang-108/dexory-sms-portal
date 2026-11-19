/* Floor view: the tablet screens for the shop floor. A big-button home (add
   Production / Prototype stock, add a CoC, scan a barcode) and the add-stock
   screen with large controls. It books stock in exactly like the Book in
   dialog does, just with touch-sized controls and a search by any part of the
   part number. No sidebar - shell.js leaves #/floor pages alone. */

import { esc, mount, setViewCleanup, toast } from "../render.js";
import {
  subscribeStockItems,
  subscribeRecentBookIns,
  recordTransaction,
  updateStockItemFields,
  areaQty,
  areaLocation,
  blankYield,
  AREA_LABELS
} from "../db.js";
import { populateUserSelect, wireUserSelect, resolveUser } from "../users.js";
import { navigate } from "../../app.js";

const ICONS = {
  plus: `<path d="M12 5v14M5 12h14"/>`,
  flask: `<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/>`,
  file: `<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>`,
  scan: `<path d="M4 7V5a1 1 0 0 1 1-1h2M4 17v2a1 1 0 0 0 1 1h2M20 7V5a1 1 0 0 0-1-1h-2M20 17v2a1 1 0 0 1-1 1h-2M8 8v8M12 8v8M16 8v8"/>`
};

const icon = (name, color) =>
  `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

let unsub = null;
let itemsUnsub = null;

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function renderFloorHomeView() {
  if (unsub) unsub();

  const tile = (hash, iconName, title, sub, main) => `
    <button class="fl-tile ${main ? "fl-tile--main" : ""}" data-hash="${hash}">
      <span class="fl-ic">${icon(iconName, main ? "#CBFE34" : "#0B1A48")}</span>
      <span><span class="fl-tile-t">${title}</span><span class="fl-tile-s">${sub}</span></span>
    </button>`;

  mount(`
    <div class="fl">
      <header class="fl-head">
        <div>
          <div class="fl-title">Floor view</div>
          <div class="fl-sub">Dexory SMS portal · Stock in, CoCs and scanning</div>
        </div>
        <div class="fl-date mono">${esc(new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }))}</div>
      </header>
      <main class="fl-main">
        <div class="fl-tiles">
          ${tile("#/floor/add/production", "plus", "Add production stock", "Blanks arriving for Production or Farm", true)}
          ${tile("#/floor/add/prototype", "flask", "Add prototype stock", "One-off and odd-size material", false)}
          ${tile("#/coc/new", "file", "Add CoC", "Scan or type a certificate of conformity", false)}
          ${tile("#/scan", "scan", "Scan barcode", "Open a part from its label", false)}
        </div>
        <section class="fl-card">
          <div class="fl-card-title">Added today</div>
          <div id="fl-today"><div class="fl-empty">Loading…</div></div>
        </section>
        <a class="fl-portal" href="#/dashboard">Open the full portal</a>
      </main>
    </div>
  `);

  document.querySelectorAll(".fl-tile[data-hash]").forEach((btn) => {
    btn.onclick = () => navigate(btn.dataset.hash);
  });

  unsub = subscribeRecentBookIns(1, (rows) => {
    const box = document.getElementById("fl-today");
    if (!box) return;
    const today = rows.filter((t) => t.timestamp >= startOfToday()).sort((a, b) => b.timestamp - a.timestamp);
    box.innerHTML = today.length
      ? today
          .map(
            (t) => `
            <div class="fl-row">
              <div><div class="mono fl-row-t">${esc(t.stockNumber || t.stockItemId)}</div><div class="fl-row-s">${esc(AREA_LABELS[t.area] || t.area || "")} · ${esc(t.user)}</div></div>
              <div class="mono fl-row-q">+${esc(t.qty)}</div>
            </div>`
          )
          .join("")
      : `<div class="fl-empty">Nothing added yet today.</div>`;
  });
  setViewCleanup(() => {
    if (unsub) unsub();
    unsub = null;
  });
}

export function renderFloorAddView(kind) {
  if (itemsUnsub) itemsUnsub();

  const isPrototype = kind === "prototype";
  const areas = isPrototype ? ["prototype"] : ["production", "farm"];
  const unit = isPrototype ? "pcs" : "blanks";
  const unitOf = (n) => (n === 1 ? (isPrototype ? "pc" : "blank") : unit);
  let area = areas[0];
  let item = null;
  let qty = 1;
  let items = [];

  mount(`
    <div class="fl">
      <header class="fl-head">
        <button class="fl-back" id="fl-back" aria-label="Back to floor view">&larr;</button>
        <div style="flex:1;">
          <div class="fl-title">${isPrototype ? "Add prototype stock" : "Add production stock"}</div>
          <div class="fl-sub">Floor view</div>
        </div>
      </header>
      <main class="fl-main">
        <div class="fl-field">
          <label for="fl-part">Part number</label>
          <input id="fl-part" class="fl-box mono" placeholder="Type the last digits, e.g. 0234" autocomplete="off" />
          <div id="fl-sug"></div>
          <div id="fl-picked"></div>
        </div>

        <div class="fl-field">
          <label for="fl-qty">${isPrototype ? "Quantity (pcs)" : "Quantity in blanks"}</label>
          <div class="fl-step">
            <button class="fl-stepbtn" id="fl-minus" aria-label="One less">&minus;</button>
            <input id="fl-qty" class="fl-box mono fl-qty" type="number" min="1" step="1" inputmode="numeric" value="1" />
            <button class="fl-stepbtn" id="fl-plus" aria-label="One more">+</button>
          </div>
          <div class="fl-hint" id="fl-preview"></div>
        </div>

        ${
          areas.length > 1
            ? `<div class="fl-field"><label>Add to</label><div class="fl-seg">${areas
                .map((a) => `<button class="fl-segbtn ${a === area ? "is-on" : ""}" data-area="${a}">${esc(AREA_LABELS[a])}</button>`)
                .join("")}</div></div>`
            : ""
        }

        <div class="fl-field">
          <label for="fl-loc">Location</label>
          <input id="fl-loc" class="fl-box" placeholder="e.g. A-1" />
        </div>

        <div class="fl-field">
          <label for="fl-user">Who is adding</label>
          <select id="fl-user" class="fl-box"></select>
        </div>
        <div class="fl-field" id="fl-other-wrap" style="display:none;">
          <label for="fl-other">Name</label>
          <input id="fl-other" class="fl-box" placeholder="Name" />
        </div>
      </main>
      <footer class="fl-foot">
        <button class="fl-btn" id="fl-cancel">Cancel</button>
        <button class="fl-btn fl-btn--pri" id="fl-confirm"></button>
      </footer>
    </div>
  `);

  const partInput = document.getElementById("fl-part");
  const sugBox = document.getElementById("fl-sug");
  const pickedBox = document.getElementById("fl-picked");
  const qtyInput = document.getElementById("fl-qty");
  const locInput = document.getElementById("fl-loc");
  const userSelect = document.getElementById("fl-user");

  populateUserSelect(userSelect);
  wireUserSelect(userSelect, document.getElementById("fl-other-wrap"));

  function refresh() {
    document.getElementById("fl-confirm").textContent = `Add ${qty} ${unitOf(qty)}`;
    const preview = document.getElementById("fl-preview");
    const yieldPerBlank = item ? blankYield(item) : 1;
    preview.textContent =
      !isPrototype && item && yieldPerBlank > 1
        ? `${qty} ${unitOf(qty)} × ${yieldPerBlank} pieces per blank = ${qty * yieldPerBlank} pcs we can make`
        : "";
    pickedBox.innerHTML = item
      ? `<div class="fl-picked"><div><div class="mono fl-row-t">${esc(item.partNumber)}</div><div class="fl-row-s">${esc(item.partName) || "No part name"}${item.rev ? " · R" + esc(item.rev) : ""} · ${areaQty(item, area)} ${unitOf(areaQty(item, area))} in ${esc(AREA_LABELS[area])} now</div></div><span class="fl-ok">Selected</span></div>`
      : "";
  }

  function pick(next) {
    item = next;
    partInput.value = item.partNumber;
    sugBox.innerHTML = "";
    locInput.value = areaLocation(item, area);
    refresh();
  }

  partInput.oninput = () => {
    item = null;
    const q = partInput.value.trim().toLowerCase();
    const matches = q ? items.filter((i) => `${i.partNumber} ${i.partName || ""}`.toLowerCase().includes(q)).slice(0, 6) : [];
    sugBox.innerHTML = matches.length
      ? `<div class="fl-sug">${matches
          .map(
            (i) => `<button class="fl-sug-row" data-part="${esc(i.partNumber)}"><span class="mono fl-row-t">${esc(i.partNumber)}</span><span class="fl-row-s">${esc(i.partName || "")}</span></button>`
          )
          .join("")}</div>`
      : q
        ? `<div class="fl-hint">No part matches. Add new parts from the portal.</div>`
        : "";
    sugBox.querySelectorAll("[data-part]").forEach((btn) => {
      btn.onclick = () => pick(items.find((i) => i.partNumber === btn.dataset.part));
    });
    refresh();
  };

  qtyInput.oninput = () => {
    qty = Math.max(1, Math.round(Number(qtyInput.value)) || 1);
    refresh();
  };
  const setQty = (n) => {
    qty = Math.max(1, n);
    qtyInput.value = qty;
    refresh();
  };
  document.getElementById("fl-minus").onclick = () => setQty(qty - 1);
  document.getElementById("fl-plus").onclick = () => setQty(qty + 1);

  document.querySelectorAll(".fl-segbtn").forEach((btn) => {
    btn.onclick = () => {
      area = btn.dataset.area;
      document.querySelectorAll(".fl-segbtn").forEach((b) => b.classList.toggle("is-on", b === btn));
      if (item) locInput.value = areaLocation(item, area);
      refresh();
    };
  });

  document.getElementById("fl-back").onclick = () => navigate("#/floor");
  document.getElementById("fl-cancel").onclick = () => navigate("#/floor");
  document.getElementById("fl-confirm").onclick = async () => {
    if (!item) return void toast("Pick a part first.");
    const user = await resolveUser(userSelect, document.getElementById("fl-other"));
    if (!user) return void toast("Enter a name.");

    const location = locInput.value.trim();
    const target = item;
    const targetArea = area;
    const amount = qty;
    toast(`${amount} ${unitOf(amount)} added to ${AREA_LABELS[targetArea]}.`);
    navigate("#/floor");

    recordTransaction(target, { type: "book-in", qty: amount, user, note: "", area: targetArea })
      .then(() => {
        if (location !== areaLocation(target, targetArea)) {
          return updateStockItemFields(target.partNumber, { [`areas.${targetArea}.location`]: location });
        }
      })
      .catch((err) => {
        console.error(err);
        toast("Couldn't save that change - check your connection.");
      });
  };

  itemsUnsub = subscribeStockItems((all) => {
    items = all;
  });
  setViewCleanup(() => {
    if (itemsUnsub) itemsUnsub();
    itemsUnsub = null;
  });
  refresh();
}
