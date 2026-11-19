/* The portal shell: sidebar + top bar around whatever view just mounted.
   Views that already render their own .dx-app (the list/report pages) only
   get the top bar added; every other page (item, forms, work order pages...)
   is wrapped in the full shell here, so no view has to know about it. Below
   860px the sidebar and top bar are hidden by CSS and the page looks as it
   always did. */

import { esc, toast } from "./render.js";
import { dxNavHTML, wireSectionNav, navEntry, navKeyForHash } from "./section-nav.js";
import { listStockItems } from "./db.js";
import { startQualityNotify, refreshQualityBadges } from "./quality-notify.js";
import { navigate } from "../app.js";

function topBarHTML(key) {
  const { group, label } = navEntry(key);
  return `
    <header class="dx-top">
      <span class="dx-crumb">${group ? `${esc(group)} / ` : ""}${esc(label)}</span>
      <input class="dx-search" id="dx-search" type="search" placeholder="Search part number or work order" aria-label="Search part number or work order" />
    </header>
  `;
}

export function applyShell() {
  const app = document.getElementById("app");
  if (!app) return;
  // The tablet floor view is its own full-screen layout, not a portal page.
  if ((location.hash || "").startsWith("#/floor")) return;

  let main = app.querySelector(".dx-main");
  if (!app.querySelector(".dx-app")) {
    const key = navKeyForHash(location.hash);
    const page = document.createElement("div");
    page.className = "dx-page";
    while (app.firstChild) page.appendChild(app.firstChild);

    const shell = document.createElement("div");
    shell.className = "dx-app dx-app--wrapped";
    shell.innerHTML = `${dxNavHTML(key)}<div class="dx-main"></div>`;
    main = shell.querySelector(".dx-main");
    main.appendChild(page);
    app.appendChild(shell);
  }

  if (!main.querySelector(".dx-top")) {
    const key = navKeyForHash(location.hash);
    main.insertAdjacentHTML("afterbegin", topBarHTML(key));
  }

  wireSectionNav(app);
  startQualityNotify();
  refreshQualityBadges();
  const search = app.querySelector("#dx-search");
  if (search) search.onkeydown = (e) => e.key === "Enter" && runSearch(search);
}

// A work order number goes straight to that order; anything else is matched
// against part numbers (the last few digits are enough while they're unique).
async function runSearch(input) {
  const q = input.value.trim();
  if (!q) return;

  if (/^dex-wo-/i.test(q)) {
    navigate("#/work-orders/" + encodeURIComponent(q.toUpperCase()));
    input.value = "";
    return;
  }

  const items = await listStockItems();
  const needle = q.toLowerCase();
  const exact = items.filter((i) => i.partNumber.toLowerCase() === needle);
  const matches = exact.length ? exact : items.filter((i) => i.partNumber.toLowerCase().includes(needle));

  if (matches.length === 1) {
    navigate("#/item/" + encodeURIComponent(matches[0].partNumber));
    input.value = "";
  } else if (matches.length === 0) {
    toast(`No part or work order matches "${q}".`);
  } else {
    toast(`${matches.length} parts match "${q}". Type a few more digits.`);
  }
}
