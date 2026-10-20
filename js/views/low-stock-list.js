/* Dedicated Low Stock page - the same card/logic as the Dashboard's widget,
   just as its own full page reachable directly from the nav rail (the
   Dashboard widget is capped height for a quick glance; this is the whole
   list, searchable). */

import { mount, setViewCleanup } from "../render.js";
import { subscribeStockItems } from "../db.js";
import { lowStockItemsOf, lowStockCardsHTML } from "../low-stock.js";
import { dxNavHTML, wireSectionNav } from "../section-nav.js";
import { navigate } from "../../app.js";

let stockUnsub = null;
let allStock = [];

export function renderLowStockListView() {
  if (stockUnsub) stockUnsub();

  mount(`
    <div class="dx-app">
      ${dxNavHTML("low-stock")}
      <div class="dx-main">
        <div class="dx-content" style="max-width:1200px;">
          <div class="dash-title">Low Stock</div>
          <div class="dash-sub">Everything in Production under the reorder threshold, most urgent first.</div>
          <div class="form-group" style="padding:0 16px;margin-bottom:16px;">
            <input type="search" id="low-stock-search" placeholder="Search part number, name…" />
          </div>
          <div class="card-grid" id="low-stock-grid" style="max-height:none;"></div>
        </div>
      </div>
    </div>
  `);

  wireSectionNav();
  document.getElementById("low-stock-search").oninput = renderFiltered;

  stockUnsub = subscribeStockItems((items) => {
    allStock = items;
    renderFiltered();
  });

  setViewCleanup(() => {
    if (stockUnsub) stockUnsub();
    stockUnsub = null;
  });
}

function renderFiltered() {
  const grid = document.getElementById("low-stock-grid");
  if (!grid) return;

  const q = (document.getElementById("low-stock-search").value || "").toLowerCase().trim();
  const items = lowStockItemsOf(allStock).filter((item) => {
    if (!q) return true;
    return (item.partNumber + " " + (item.partName || "")).toLowerCase().includes(q);
  });

  grid.innerHTML = lowStockCardsHTML(items);
  grid.querySelectorAll("[data-part]").forEach((el) => {
    el.onclick = () => navigate("#/item/" + encodeURIComponent(el.dataset.part));
  });
}
