/* What to do about a low-stock part: how much to move from Farm into
   Production, and how many more blanks to order to get back above the
   low-stock line. Shown in the Action column of Stock availability. */

import { areaQty, LOW_STOCK_CYCLES, blankYield, makeablePieces } from "./db.js";

export function lowStockAction(item) {
  // Farm stock not yet moved into Production still counts as cover, but the
  // robot only draws from Production - moving it over is free, ordering isn't.
  const moveBlanks = Math.max(0, areaQty(item, "farm"));

  // The shortfall is judged on the more demanding of the two robots, in
  // pieces, then converted back to whole blanks.
  const rate = Math.max(Number(item.perRobotCycle) || 0, Number(item.perRobotCycle10Sec) || 0);
  const neededPieces = Math.max(0, LOW_STOCK_CYCLES * rate - makeablePieces(item));
  const orderBlanks = Math.ceil(neededPieces / blankYield(item));

  return { moveBlanks, orderBlanks };
}
