/* Shared low-stock computation + card rendering - used by both the
   Dashboard's "Low stock" widget and the dedicated Low Stock page, so the
   two never drift apart on what counts as low or how the Move/Order
   message is worded. */

import { esc } from "./render.js";
import { isLowStock, cyclesRemaining, areaQty, DEDUCTION_AREA, LOW_STOCK_CYCLES } from "./db.js";

// Most urgent (fewest cycles left) first.
export function lowStockItemsOf(stock) {
  return stock.filter((item) => isLowStock(item)).sort((a, b) => cyclesRemaining(a) - cyclesRemaining(b));
}

export function lowStockCardsHTML(items) {
  if (items.length === 0) return `<div class="empty-state">Nothing low on stock right now.</div>`;
  return items.map(lowStockCardHTML).join("");
}

function lowStockCardHTML(item) {
  const qty = areaQty(item, DEDUCTION_AREA);
  const farmQty = areaQty(item, "farm");
  const perCycle = Number(item.perRobotCycle) || 1;
  const needed = Math.max(0, LOW_STOCK_CYCLES * perCycle - qty);
  const cycles = cyclesRemaining(item);

  // Production being low doesn't mean the shop is actually short of the
  // part - it might just need moving over from Farm. Only call for an
  // order once Farm itself can't cover the shortfall either.
  let actionHTML;
  if (farmQty >= needed) {
    actionHTML = `<div class="wo-card-need move">Move +${needed} from Farm</div>`;
  } else if (farmQty > 0) {
    actionHTML = `<div class="wo-card-need move">Move +${farmQty} from Farm</div><div class="wo-card-need">Order +${needed - farmQty} more</div>`;
  } else {
    actionHTML = `<div class="wo-card-need">Order +${needed} more</div>`;
  }

  return `
    <div class="wo-card low-stock" data-part="${esc(item.partNumber)}">
      <div class="wo-card-top">
        <div class="wo-card-no">${esc(item.partNumber)}</div>
        <div class="wo-card-qty">${qty}</div>
      </div>
      <div class="wo-card-part">${esc(item.partName) || esc(item.material) || "—"}</div>
      <div class="wo-card-farm">Farm: ${farmQty} pcs · ~${cycles} cycle${cycles === 1 ? "" : "s"} left</div>
      ${actionHTML}
    </div>
  `;
}
