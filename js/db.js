/*
  Firestore access layer. Collections: stockItems/{partNumber}, transactions/{auto-id}

  stockItems is keyed by Part No. - a part number never changes once
  assigned, so barcodes/scans/URLs built on it never go stale. There is no
  separate "Raw stock no." any more (dropped for simplicity); items created
  before that field was removed may still carry a leftover `stockNumber` in
  their data, but nothing reads or writes it going forward. Anywhere below
  that reads `.partNumber` off a stock item to use as its identity - a doc
  id, a transaction/batch/work order's link - is doing that on purpose
  (transactions/batches also keep a field literally named `stockNumber` for
  this same part-number value - an old name for a still-load-bearing query
  field, unrelated to the item-level note field that got removed).

  A part number's stock isn't a single quantity - the same part can sit in
  Farm (raw material storage), Production (what work orders draw from) and
  Prototype (one-off/odd sizes) at once, each with its own qty and
  location: item.areas = { farm: {qty, location}, production: {...}, ... }.
  Work orders only ever deduct from Production (DEDUCTION_AREA below) -
  moveStockBetweenAreas() is how stock gets shifted into Production from
  Farm/Prototype first.
*/

import {
  db,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  writeBatch,
  increment,
  arrayUnion,
  arrayRemove
} from "../firebase-config.js";

export const FORMS = ["Blank", "Waterjet profile", "Long bar"];

// Order here drives tab order everywhere areas are shown - Production is
// the main/default one.
export const AREAS = ["production", "farm", "prototype"];
export const AREA_LABELS = { farm: "Farm", production: "Production", prototype: "Prototype" };

// The only area work orders are ever allowed to deduct from - Farm and
// Prototype are manual take/book-in only. moveStockBetweenAreas() shifts
// stock into Production first when it's short.
export const DEDUCTION_AREA = "production";

function blankArea() {
  return { qty: 0, location: "" };
}

export function areaQty(item, area) {
  return (item.areas && item.areas[area] && item.areas[area].qty) || 0;
}

export function areaLocation(item, area) {
  return (item.areas && item.areas[area] && item.areas[area].location) || "";
}

// Every area currently holding stock for this item, in AREAS order - used
// to list locations on the barcode block/label.
export function areasWithStock(item) {
  return AREAS.filter((a) => areaQty(item, a) > 0);
}

// Over-deducting is allowed (nothing here blocks it - see the various
// "proceed anyway?" confirms before a take), but it should never be silent
// afterward. Anywhere this item's stock shows up can check this and flag it.
export function negativeAreas(item) {
  return AREAS.filter((a) => areaQty(item, a) < 0);
}

export function hasNegativeStock(item) {
  return negativeAreas(item).length > 0;
}

export const STOCK_COLLECTION = "stockItems";
export const TRANSACTIONS_COLLECTION = "transactions";
export const WORK_ORDERS_COLLECTION = "workOrders";
export const PART_MASTER_COLLECTION = "partMaster";
export const BATCHES_COLLECTION = "batches";
export const CONFIG_COLLECTION = "config";
export const IDNS_COLLECTION = "idns";
export const COCS_COLLECTION = "cocs";

// Sentinel option value the "Who" pickers use for their "+ Add new name"
// entry - never a real name, so it can't collide with one.
export const ADD_NAME_VALUE = "__add_name__";

// "Scheduled" only ever applies to a weekly child work order generated from
// a Production Request (see createProductionRequest) - it means stock
// hasn't been deducted yet, deliberately deferred until someone actually
// picks the job up (setWorkOrderAssignee flips Scheduled -> Open and
// deducts at that point). A normal, single work order never passes through
// Scheduled at all - it's created directly at Open, same as always.
export const WORK_ORDER_STATUSES = ["Scheduled", "Open", "Issued", "Complete", "Cancelled"];

// Flag an item red when fewer than this many robot cycles remain.
export const LOW_STOCK_CYCLES = 5;

// Robot cycles are a Production-line concept, but Farm stock counts towards
// it too - Farm is just the overflow/raw-material shelf for the same stock,
// one moveStockBetweenAreas() away from Production, so it's real coverage
// against running out, not separate from it. Prototype stock is excluded
// deliberately (one-off/odd-size material, not production-line stock).
// Judged against whichever of the part's two robots (7 sec / 10 sec) would
// run out first - see worstCyclesRemaining(). This is the one definition of
// "cycles left" used by the dashboard, the item page and Stock availability.
export function cyclesRemaining(item) {
  return worstCyclesRemaining(item);
}

// Stock is counted in blanks (a plate or bar), and each blank is cut into
// piecesPerBlank finished parts - so what the robots can actually consume is
// blanks x that yield, not the raw blank count.
export function blankYield(item) {
  return Math.max(1, Number(item.piecesPerBlank) || 1);
}

export function coveringBlanks(item) {
  return areaQty(item, DEDUCTION_AREA) + areaQty(item, "farm");
}

export function makeablePieces(item) {
  return coveringBlanks(item) * blankYield(item);
}

// Robot cycles the item's stock lasts the more demanding of its two robots -
// Infinity when neither robot uses the part (a missing rate isn't a shortage).
export function worstCyclesRemaining(item) {
  const pieces = makeablePieces(item);
  const cyclesAt = (rate) => (rate > 0 ? Math.floor(pieces / rate) : Infinity);
  return Math.min(cyclesAt(Number(item.perRobotCycle) || 0), cyclesAt(Number(item.perRobotCycle10Sec) || 0));
}

export function isLowStock(item) {
  return cyclesRemaining(item) < LOW_STOCK_CYCLES;
}

/*
  Completed/Rejected are derived from history, not stored as their own
  separately-incremented counters - a stored counter and an append-only log
  are two copies of the same fact, and keeping both in sync (increment here,
  arrayRemove there) is exactly the kind of thing that quietly drifts apart
  after a delete-and-redo on patchy wifi. Computing them from history every
  time means there's only one source of truth, so they can't drift from it.
*/
// "adjusted" entries are plain manual corrections to the count (see
// adjustWorkOrderCount) - a signed delta rather than a qty, so they can
// move the total either direction without needing an IDN or a reject.
export function completedQtyOf(wo) {
  return Math.max(
    0,
    (wo.history || []).reduce((sum, h) => {
      if (h.type === "completed") return sum + (h.qty || 0);
      if (h.type === "adjusted" && h.field === "completed") return sum + (h.delta || 0);
      return sum;
    }, 0)
  );
}

export function rejectedQtyOf(wo) {
  return Math.max(
    0,
    (wo.history || []).reduce((sum, h) => {
      if (h.type === "rejected") return sum + (h.qty || 0);
      if (h.type === "adjusted" && h.field === "rejected") return sum + (h.delta || 0);
      return sum;
    }, 0)
  );
}

// Ordered - Completed - Rejected. Never negative even if data's mid-write.
export function remainingQty(wo) {
  return Math.max(0, (wo.qty || 0) - completedQtyOf(wo) - rejectedQtyOf(wo));
}

// How many days' grace before a due date counts as "coming up soon" (amber)
// rather than comfortably on track (green).
export const DUE_SOON_DAYS = 7;

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// The date this work order's own traffic-light colour counts down to. A
// Production Request's weekly child is due the week it's scheduled for
// (weekOf); a plain standalone order uses its own optional dueDate field.
// The parent row itself has no date of its own to show - it's an aggregate
// of its weeks, each coloured individually once you open it.
export function dueDateOf(wo) {
  if (wo.parentWoNo) return wo.weekOf || null;
  if (wo.isParent) return null;
  return wo.dueDate || null;
}

// "red" | "orange" | "green" | null - same three colours/names as the Stock
// Availability page's own status pill, for one consistent vocabulary across
// the app. null means nothing to show - either finished (Complete/Cancelled,
// so the countdown no longer matters) or no due date has been set yet, never
// an error state.
export function dueDateStatus(wo) {
  if (wo.status === "Complete" || wo.status === "Cancelled") return null;
  const due = dueDateOf(wo);
  if (!due) return null;
  const daysLeft = Math.round((startOfDay(due) - startOfDay(Date.now())) / 86400000);
  if (daysLeft < 0) return "red";
  if (daysLeft <= DUE_SOON_DAYS) return "orange";
  return "green";
}

export function blankStockItem() {
  return {
    partNumber: "",
    partName: "",
    rev: "",
    material: "",
    stockSize: "",
    form: FORMS[0],
    piecesPerBlank: 1,
    // Two separate robot types run at different cycle times and consume
    // parts at different rates - perRobotCycle is the 7-second robot's rate
    // (also what Low Stock/cyclesRemaining() below is keyed to, since that
    // calc only ever assumed one robot); perRobotCycle10Sec is the second
    // robot's own rate, tracked alongside it but not yet feeding into Low
    // Stock - see isLowStock()'s comment.
    perRobotCycle: 1,
    perRobotCycle10Sec: 1,
    areas: { farm: blankArea(), production: blankArea(), prototype: blankArea() },
    comments: ""
  };
}

function stockItemsRef() {
  return collection(db, STOCK_COLLECTION);
}

function stockItemRef(partNumber) {
  return doc(db, STOCK_COLLECTION, sanitizeIdPart(partNumber));
}

function transactionsRef() {
  return collection(db, TRANSACTIONS_COLLECTION);
}

function workOrdersRef() {
  return collection(db, WORK_ORDERS_COLLECTION);
}

function workOrderRef(workOrderNumber) {
  return doc(db, WORK_ORDERS_COLLECTION, workOrderNumber);
}

function partMasterRef() {
  return collection(db, PART_MASTER_COLLECTION);
}

// Firestore doc IDs can't contain "/" - sanitize since part numbers and
// revs are free text and occasionally have one.
function sanitizeIdPart(s) {
  return String(s || "").replace(/\//g, "-");
}

function partMasterId(partNo, rev) {
  return `${sanitizeIdPart(partNo)}__R${sanitizeIdPart(rev)}`;
}

function partMasterDocRef(partNo, rev) {
  return doc(db, PART_MASTER_COLLECTION, partMasterId(partNo, rev));
}

function batchesRef() {
  return collection(db, BATCHES_COLLECTION);
}

function batchRef(batchNo) {
  return doc(db, BATCHES_COLLECTION, sanitizeIdPart(batchNo));
}

function knownUsersRef() {
  return doc(db, CONFIG_COLLECTION, "knownUsers");
}

function knownSuppliersRef() {
  return doc(db, CONFIG_COLLECTION, "knownSuppliers");
}

function cocsRef() {
  return collection(db, COCS_COLLECTION);
}

function cocRef(cocKey) {
  return doc(db, COCS_COLLECTION, sanitizeIdPart(cocKey));
}

function idnsRef() {
  return collection(db, IDNS_COLLECTION);
}

function idnRef(idnNo) {
  return doc(db, IDNS_COLLECTION, sanitizeIdPart(idnNo));
}

const DEFAULT_USERS = ["Dev"];

// The "Who" list starts from just whoever has actually been typed in before
// (seeded with "Dev" so it's never empty) - no fixed roster to edit when
// someone joins or leaves the team.
export async function listKnownUsers() {
  const snap = await getDoc(knownUsersRef());
  const names = snap.exists() ? snap.data().names : null;
  return names && names.length ? names : DEFAULT_USERS;
}

export async function ensureKnownUser(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return;
  const snap = await getDoc(knownUsersRef());
  const names = snap.exists() ? snap.data().names || [] : [];
  if (names.includes(trimmed)) return;
  await setDoc(knownUsersRef(), { names: [...names, trimmed], updatedAt: Date.now() });
}

// Machines are saved once as {name, number} so the first-off card can pick
// from a list instead of typing - same "one config doc holding a list"
// shape as knownUsers/knownSuppliers.
function machinesRef() {
  return doc(db, CONFIG_COLLECTION, "machines");
}

export async function listMachines() {
  const snap = await getDoc(machinesRef());
  return snap.exists() ? snap.data().list || [] : [];
}

// How a machine reads everywhere: "WJ-01 · Waterjet", or just whichever of
// the two was entered.
export const machineLabel = (m) => [m.number, m.name].filter(Boolean).join(" · ");

// A machine needs a name or a number, not both - whatever the shop calls it.
export async function addMachine({ name, number }) {
  const list = await listMachines();
  const clean = { name: String(name || "").trim(), number: String(number || "").trim() };
  if (!clean.name && !clean.number) return list;
  const label = machineLabel(clean).toLowerCase();
  if (list.some((m) => machineLabel(m).toLowerCase() === label)) return list;
  const next = [...list, clean];
  await setDoc(machinesRef(), { list: next, updatedAt: Date.now() });
  return next;
}

export const blankFirstOffOp = () => ({
  machine: "",
  operatedBy: "",
  operatedAt: 0,
  checkedBy: "",
  checkedAt: 0,
  result: "",
  // What happened to a failed or reworked piece: "scrap" | "rework" | "accept".
  disposition: "",
  // When a scrapped piece was logged as a reject on the work order (so it is
  // only ever logged once).
  rejectAt: 0,
  comment: "",
  file: null
});

export const newFirstOffAttempt = (n) => ({
  n,
  startedAt: Date.now(),
  ops: Array.from({ length: 3 }, blankFirstOffOp)
});

// A route card is a first-off started for one or more work orders of the same
// part: the first one holds the inspection, the rest point back at it.
export async function createRouteCard(primaryWoNo, coveredWoNos) {
  const now = Date.now();
  const batch = writeBatch(db);
  batch.update(workOrderRef(primaryWoNo), {
    firstOff: { attempts: [newFirstOffAttempt(1)], covers: coveredWoNos },
    updatedAt: now
  });
  coveredWoNos.forEach((woNo) => batch.update(workOrderRef(woNo), { firstOffRef: primaryWoNo, updatedAt: now }));
  await batch.commit();
}

// One first-off can cover several work orders/batches run together: the
// covered order just points back at the one that holds the inspection, and
// the holder lists who it covers.
export async function addFirstOffCovers(primaryWo, coveredWoNos) {
  const now = Date.now();
  const have = primaryWo.firstOff.covers || [];
  const added = coveredWoNos.filter((n) => !have.includes(n));
  const firstOff = { ...primaryWo.firstOff, covers: [...have, ...added] };
  const batch = writeBatch(db);
  batch.update(workOrderRef(primaryWo.woNo), { firstOff, updatedAt: now });
  added.forEach((woNo) => batch.update(workOrderRef(woNo), { firstOffRef: primaryWo.woNo, updatedAt: now }));
  await batch.commit();
}

// Removes a route card and lets every order it covered be put on another one.
// Rejects already logged on the work order from this card stay where they are.
export async function deleteRouteCard(wo) {
  const now = Date.now();
  const batch = writeBatch(db);
  batch.update(workOrderRef(wo.woNo), { firstOff: null, updatedAt: now });
  (wo.firstOff.covers || []).forEach((woNo) => batch.update(workOrderRef(woNo), { firstOffRef: "", updatedAt: now }));
  await batch.commit();
}

// Takes an order back off the card. The empty firstOffRef reads as "not on a
// card", so it can be pulled onto another one.
export async function removeFirstOffCover(primaryWo, coveredWoNo) {
  const now = Date.now();
  const firstOff = { ...primaryWo.firstOff, covers: (primaryWo.firstOff.covers || []).filter((n) => n !== coveredWoNo) };
  const batch = writeBatch(db);
  batch.update(workOrderRef(primaryWo.woNo), { firstOff, updatedAt: now });
  batch.update(workOrderRef(coveredWoNo), { firstOffRef: "", updatedAt: now });
  await batch.commit();
}

/*
  Same "grows from what's actually been typed before" idea as knownUsers,
  but each entry is a {name, code} pair - the supplier's full name (as
  printed on their CoC) mapped to the short code used in the CoC key
  (SUPPLIERCODE-CoCNumber). Lets the CoC form auto-fill a supplier's code
  once it's been typed once, without a separate supplier-master screen to
  maintain.
*/
export async function listKnownSuppliers() {
  const snap = await getDoc(knownSuppliersRef());
  const list = snap.exists() ? snap.data().list : null;
  return list && list.length ? list : [];
}

export async function ensureKnownSupplier(name, code) {
  const trimmedName = String(name || "").trim();
  const trimmedCode = String(code || "").trim();
  if (!trimmedName || !trimmedCode) return;
  const snap = await getDoc(knownSuppliersRef());
  const list = snap.exists() ? snap.data().list || [] : [];
  const idx = list.findIndex((s) => s.name === trimmedName);
  if (idx >= 0) {
    if (list[idx].code === trimmedCode) return;
    list[idx] = { name: trimmedName, code: trimmedCode };
  } else {
    list.push({ name: trimmedName, code: trimmedCode });
  }
  await setDoc(knownSuppliersRef(), { list, updatedAt: Date.now() });
}

export async function listStockItems() {
  const snap = await getDocs(stockItemsRef());
  return snap.docs.map((d) => d.data());
}

export function subscribeStockItems(onChange) {
  return onSnapshot(stockItemsRef(), (snap) => {
    onChange(snap.docs.map((d) => d.data()));
  });
}

export async function getStockItem(partNumber) {
  const snap = await getDoc(stockItemRef(partNumber));
  return snap.exists() ? snap.data() : null;
}

export function subscribeStockItem(partNumber, onChange) {
  return onSnapshot(stockItemRef(partNumber), (snap) => {
    onChange(snap.exists() ? snap.data() : null);
  });
}

export async function createStockItem(item) {
  const now = Date.now();
  const record = { ...item, createdAt: now, updatedAt: now };
  await setDoc(stockItemRef(item.partNumber), record);
  return record;
}

// Fields only - never touches areas.*.qty. That only ever changes through
// recordTransaction()/moveStockBetweenAreas(), so the transactions log
// always explains every change. Dot-path keys (e.g. "areas.farm.location")
// are fine here - Firestore merges nested fields without overwriting the
// rest of the areas map.
export async function updateStockItemFields(partNumber, fields) {
  await updateDoc(stockItemRef(partNumber), { ...fields, updatedAt: Date.now() });
}

// Removes the stockItems doc itself. Existing transactions/batches/work
// orders that reference this part number are left as-is - deleting the
// item doesn't erase the historical fact that stock moved; it just means
// there's no longer a live item to look them up from.
export async function deleteStockItem(partNumber) {
  await deleteDoc(stockItemRef(partNumber));
}

export async function listWorkOrders() {
  const snap = await getDocs(workOrdersRef());
  return snap.docs.map((d) => d.data());
}

export function subscribeWorkOrders(onChange) {
  return onSnapshot(workOrdersRef(), (snap) => {
    onChange(snap.docs.map((d) => d.data()));
  });
}

export async function getWorkOrder(workOrderNumber) {
  const snap = await getDoc(workOrderRef(workOrderNumber));
  return snap.exists() ? snap.data() : null;
}

export function subscribeWorkOrder(workOrderNumber, onChange) {
  return onSnapshot(workOrderRef(workOrderNumber), (snap) => {
    onChange(snap.exists() ? snap.data() : null);
  });
}

export async function updateWorkOrderFields(workOrderNumber, fields) {
  await updateDoc(workOrderRef(workOrderNumber), { ...fields, updatedAt: Date.now() });
}

// ---- Part master ----

export function blankPartMaster(partNo, rev) {
  return {
    partNo: partNo || "",
    rev: rev || "",
    partName: "",
    unitPerRobot: 1,
    linkedStockNumber: "",
    defaultComment: ""
  };
}

export async function getPartMaster(partNo, rev) {
  const snap = await getDoc(partMasterDocRef(partNo, rev));
  return snap.exists() ? snap.data() : null;
}

export async function createPartMaster(part) {
  const now = Date.now();
  const record = { ...part, createdAt: now, updatedAt: now };
  await setDoc(partMasterDocRef(part.partNo, part.rev), record);
  return record;
}

// ---- Batches ----
// Batch No. format: last 4 chars of Part No. + YYMM + a 2-digit sequence
// that resets each month, per part. The sequence is derived by counting
// this part's existing batches for that month rather than a separate
// counter doc - one fewer moving part, and it self-heals if a batch is
// ever deleted.
function yymm(date) {
  const d = date || new Date();
  return String(d.getFullYear() % 100).padStart(2, "0") + String(d.getMonth() + 1).padStart(2, "0");
}

export async function listBatchesForPart(partNo) {
  const q = query(batchesRef(), where("partNo", "==", partNo), limit(2000));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data()).sort((a, b) => b.bookInDate - a.bookInDate);
}

export async function suggestNextBatchNumber(partNo) {
  const ym = yymm();
  const existing = await listBatchesForPart(partNo);
  const last4 = String(partNo || "").slice(-4).padStart(4, "0");
  const countThisMonth = existing.filter((b) => (b.batchNo || "").includes(`-${ym}-`)).length;
  return `${last4}-${ym}-${String(countThisMonth + 1).padStart(2, "0")}`;
}

export async function createBatch(batch) {
  const record = { ...batch, createdAt: Date.now() };
  await setDoc(batchRef(batch.batchNo), record);
  return record;
}

/*
  Booking in stock for a part always creates a Batch row - whether or not a
  Raw Stock No. is given yet. When one is given, the batch row and the
  usual book-in transaction + areas.{area}.qty increment commit together in the
  same atomic batch, same reasoning as everywhere else in this file.
*/
export async function bookInStockForPart({ batchNo, partNo, qtyAdded, blanksReceived, piecesPerBlank, bookInDate, user, linkedStockItem, area }) {
  const batch = writeBatch(db);

  batch.set(batchRef(batchNo), {
    batchNo,
    stockNumber: linkedStockItem ? linkedStockItem.partNumber : "",
    partNo,
    qtyAdded: Math.abs(qtyAdded),
    blanksReceived: blanksReceived || 0,
    piecesPerBlank: piecesPerBlank || 0,
    area: linkedStockItem ? area : "",
    bookInDate,
    createdAt: Date.now()
  });

  if (linkedStockItem) {
    const balanceAfter = areaQty(linkedStockItem, area) + Math.abs(qtyAdded);
    const txRef = doc(transactionsRef());
    batch.set(txRef, {
      stockItemId: linkedStockItem.partNumber,
      stockNumber: linkedStockItem.partNumber,
      type: "book-in",
      area,
      qty: Math.abs(qtyAdded),
      balanceAfter,
      user,
      note: `Batch ${batchNo}`,
      workOrderNumber: "",
      timestamp: bookInDate
    });
    batch.update(stockItemRef(linkedStockItem.partNumber), {
      [`areas.${area}.qty`]: increment(Math.abs(qtyAdded)),
      updatedAt: Date.now()
    });
  }

  await batch.commit();
}

// ---- Certificates of Conformity (CoC) ----
// A CoC is keyed by SupplierCode-CoCNumber, e.g. "SSA-1-213936" - the same
// key a supplier's own paperwork reference would use, so it reads straight
// off the document rather than being an arbitrary internal id.
export function buildCocKey(supplierCode, cocNumber) {
  const code = String(supplierCode || "").trim();
  const num = String(cocNumber || "").trim();
  if (!code || !num) return "";
  return sanitizeIdPart(`${code}-${num}`);
}

export async function getCoc(cocKey) {
  const snap = await getDoc(cocRef(cocKey));
  return snap.exists() ? snap.data() : null;
}

// The one `batches` row a CoC line books into - `<cocKey>_<partNo>`, so
// every line for the same part on the same CoC (whether confirmed together
// or added later via addLinesToCoc) lands on the same row rather than a
// fresh one each time.
function cocLineBatchNo(cocKey, partNo) {
  return sanitizeIdPart(`${cocKey}_${partNo}`);
}

/*
  Shared by confirmCoc/addLinesToCoc: queues up this line's stock impact into
  the given (not-yet-committed) batch. Always writes a `batches` row - keyed
  cocLineBatchNo(cocKey, partNo) - with the original supplier batch numbers
  nested as `supplierBatches` rather than split into separate batch rows,
  and a `cocKey` back-reference. That row is what lets the Work Order form's
  existing Batch dropdown (listBatchesForPart) surface CoC-sourced material
  alongside manually booked-in batches, unchanged.

  If a line for this same (cocKey, partNo) was already booked before -
  addLinesToCoc merging a second page's line into a part this CoC already
  covers - this merges into that same row (summed qty, concatenated
  supplierBatches) rather than overwriting it; `existingBatch` is that row's
  current data, read by the caller before this batch was opened.

  Only writes the transaction + areas.production.qty increment when this
  part is an actual tracked stock item - a CoC line for a part with no
  stockItems doc yet still gets its paperwork recorded, just no stock
  movement (surfaced to the caller as a missing stock item).
*/
function addLineBookInOps(batch, { cocKey, line, stockItem, existingBatch, user, now }) {
  const lineBatchNo = cocLineBatchNo(cocKey, line.partNo);
  const qty = Math.abs(line.qty);
  const mergedQty = (existingBatch ? existingBatch.qtyAdded || 0 : 0) + qty;
  const mergedSupplierBatches = (existingBatch ? existingBatch.supplierBatches || [] : []).concat(line.batches || []);

  // A part that is in the stock list books into Production. A part that is
  // NOT is created as a new stock item with its quantity in Prototype (flagged
  // needsReview so someone fills in its details). A later page of the same CoC
  // adding to such a part stays in Prototype.
  const isNew = !stockItem;
  const createdHere = !!stockItem && stockItem.fromCoc === cocKey && stockItem.needsReview;
  const area = isNew || createdHere ? "prototype" : "production";

  batch.set(batchRef(lineBatchNo), {
    batchNo: lineBatchNo,
    stockNumber: line.partNo,
    partNo: line.partNo,
    qtyAdded: mergedQty,
    blanksReceived: 0,
    piecesPerBlank: 0,
    area,
    bookInDate: now,
    createdAt: existingBatch ? existingBatch.createdAt : now,
    cocKey,
    supplierBatches: mergedSupplierBatches
  });

  const txRef = doc(transactionsRef());
  batch.set(txRef, {
    stockItemId: line.partNo,
    stockNumber: line.partNo,
    type: "book-in",
    area,
    qty,
    balanceAfter: areaQty(stockItem || {}, area) + qty,
    user,
    note: isNew ? `CoC ${cocKey} (new part, Prototype)` : `CoC ${cocKey}`,
    workOrderNumber: "",
    timestamp: now
  });

  if (isNew) {
    const base = blankStockItem();
    batch.set(stockItemRef(line.partNo), {
      ...base,
      partNumber: line.partNo,
      partName: (line.partName || "").trim(),
      areas: { ...base.areas, prototype: { qty, location: "" } },
      comments: `Created from CoC ${cocKey} - not in the stock list, so booked into Prototype. Needs its details filling in.`,
      fromCoc: cocKey,
      needsReview: true,
      createdAt: now,
      updatedAt: now
    });
  } else {
    batch.update(stockItemRef(stockItem.partNumber), {
      [`areas.${area}.qty`]: increment(qty),
      updatedAt: now
    });
  }
}

/*
  Confirming a new CoC is one atomic batch: the cocs/{cocKey} record itself
  (the source of truth for the document - supplier, CoC number, and every
  line's full batch/qty breakdown) plus each line's stock impact. Nothing is
  written until this is called - the upload/preview screen holds the whole
  draft client-side until the user confirms, per how this was scoped.
*/
export async function confirmCoc({ supplierCode, supplierName, cocNumber, lines, user }) {
  const cocKey = buildCocKey(supplierCode, cocNumber);
  if (!cocKey) throw new Error("Supplier code and CoC number are required.");
  if (await getCoc(cocKey)) throw new Error("A CoC with this key already exists.");

  const now = Date.now();
  const batch = writeBatch(db);
  const prepared = await prepareCocLines(cocKey, lines);

  batch.set(cocRef(cocKey), {
    cocKey,
    supplierCode: String(supplierCode).trim(),
    supplierName: supplierName || "",
    cocNumber: String(cocNumber).trim(),
    lines: prepared.map((p) => p.line),
    createdAt: now,
    createdBy: user || ""
  });

  prepared.forEach((p) => addLineBookInOps(batch, { cocKey, line: p.line, stockItem: p.stockItem, existingBatch: p.existingBatch, user, now }));

  await batch.commit();
  return { cocKey, missingStockItems: prepared.filter((p) => !p.stockItem).map((p) => p.line.partNo) };
}

// Looks up each line's stock item and existing batch row. A line whose part is
// not in the stock list is tagged `prototype: true` on the stored CoC record.
async function prepareCocLines(cocKey, lines) {
  const out = [];
  for (const line of lines) {
    const stockItem = await getStockItem(line.partNo);
    const existingBatch = await getDoc(batchRef(cocLineBatchNo(cocKey, line.partNo))).then((s) => (s.exists() ? s.data() : null));
    out.push({ line: stockItem ? line : { ...line, prototype: true }, stockItem, existingBatch });
  }
  return out;
}

// Appending more lines (e.g. a page that was missed the first time) to a CoC
// that's already been confirmed - same per-line stock impact as confirmCoc,
// but merges into the existing cocs/{cocKey} doc's `lines` instead of
// creating a new one.
export async function addLinesToCoc(cocKey, newLines, user) {
  const existing = await getCoc(cocKey);
  if (!existing) throw new Error("CoC not found.");

  const now = Date.now();
  const batch = writeBatch(db);
  const prepared = await prepareCocLines(cocKey, newLines);

  batch.update(cocRef(cocKey), {
    lines: [...(existing.lines || []), ...prepared.map((p) => p.line)],
    updatedAt: now
  });

  prepared.forEach((p) => addLineBookInOps(batch, { cocKey, line: p.line, stockItem: p.stockItem, existingBatch: p.existingBatch, user, now }));

  await batch.commit();
  return { cocKey, missingStockItems: prepared.filter((p) => !p.stockItem).map((p) => p.line.partNo) };
}

/*
  Moves qty from one area's count to another for the same part - logged as
  a matched pair (a take on the source area, a book-in on the destination)
  so both areas' own history stays honest, rather than one opaque "transfer"
  row that only one side's log would show.
*/
export async function moveStockBetweenAreas(item, { fromArea, toArea, qty, user }) {
  const now = Date.now();
  const amount = Math.abs(qty);
  // No floor at 0 - if this takes fromArea negative, the log should say so
  // honestly rather than quietly reporting 0 (see hasNegativeStock()).
  const fromBalance = areaQty(item, fromArea) - amount;
  const toBalance = areaQty(item, toArea) + amount;

  const batch = writeBatch(db);
  batch.set(doc(transactionsRef()), {
    stockItemId: item.partNumber,
    stockNumber: item.partNumber,
    type: "take",
    area: fromArea,
    qty: amount,
    balanceAfter: fromBalance,
    user,
    note: `Moved to ${AREA_LABELS[toArea]}`,
    workOrderNumber: "",
    timestamp: now
  });
  batch.set(doc(transactionsRef()), {
    stockItemId: item.partNumber,
    stockNumber: item.partNumber,
    type: "book-in",
    area: toArea,
    qty: amount,
    balanceAfter: toBalance,
    user,
    note: `Moved from ${AREA_LABELS[fromArea]}`,
    workOrderNumber: "",
    timestamp: now
  });
  batch.update(stockItemRef(item.partNumber), {
    [`areas.${fromArea}.qty`]: increment(-amount),
    [`areas.${toArea}.qty`]: increment(amount),
    updatedAt: now
  });
  await batch.commit();
}

// ---- Work order numbering ----
// WO No. format: DEX-WO-{4-digit sequence} - one running count for the
// whole shop, same style as suggestNextStockNumber()'s RS-XXXX.
export async function suggestNextWorkOrderNumber() {
  const orders = await listWorkOrders();
  let max = 0;
  orders.forEach((wo) => {
    const m = /^DEX-WO-(\d+)$/.exec(wo.woNo || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return "DEX-WO-" + String(max + 1).padStart(4, "0");
}

/*
  Rework keeps the original order's number visible in its own - "-RW" the
  first time, "-RW2"/"-RW3"... only if the same order ever needs reworking
  more than once (checked by existence rather than counted, so it's never
  off if an earlier rework was itself cancelled rather than deleted).
*/
export async function suggestReworkWoNumber(originalWoNo) {
  let candidate = `${originalWoNo}-RW`;
  let n = 1;
  while (await getWorkOrder(candidate)) {
    n += 1;
    candidate = `${originalWoNo}-RW${n}`;
  }
  return candidate;
}

/*
  Procurement creates a work order; the machine shop picks it up later. So
  creating one only records it - status Scheduled, no assignee, no batch and
  no stock taken. All of that happens in setWorkOrderAssignee, once someone
  in the machine shop assigns it and picks the batch. One atomic batch
  covers the new PartMaster row (only if this part+rev was never seen
  before) and the WorkOrders row itself.
*/
export async function createWorkOrder({
  woNo,
  partNo,
  rev,
  partName,
  qty,
  comment,
  user,
  newPartMaster,
  updatePartMasterLinkedStock,
  linkedStockItem,
  reworkOf,
  dueDate
}) {
  const now = Date.now();
  const batch = writeBatch(db);

  if (newPartMaster) {
    batch.set(partMasterDocRef(partNo, rev), { ...newPartMaster, createdAt: now, updatedAt: now });
  } else if (updatePartMasterLinkedStock !== undefined) {
    // The raw stock link is editable right on the work order form now - if
    // it was changed here, remember that for next time too.
    batch.update(partMasterDocRef(partNo, rev), { linkedStockNumber: updatePartMasterLinkedStock, updatedAt: now });
  }

  batch.set(workOrderRef(woNo), {
    woNo,
    partNo,
    rev,
    partName,
    date: now,
    // Optional - only a plain standalone order has one of its own (a
    // Production Request's weekly children use their own weekOf instead,
    // see dueDateOf()). Blank means "no due-date colour shown yet".
    dueDate: dueDate || null,
    qty: Math.abs(qty),
    // Filled in by the machine shop in setWorkOrderAssignee. cocDraws is set
    // only when the material is split across two CoC-sourced batches -
    // [{batchNo, label: "A"|"B", qtyDrawn}] - while batchNo stays the single
    // combined display string ("<batch A> (A) + <batch B> (B)") so every
    // place that just shows wo.batchNo as plain text keeps working.
    batchNo: "",
    cocDraws: [],
    comment: comment || "",
    linkedStockNumber: linkedStockItem ? linkedStockItem.partNumber : "",
    status: "Scheduled",
    assignee: "",
    creator: user || "",
    // Set only when this order was created via "Duplicate" on a Complete
    // order - a plain cross-reference back to the original job, shown as a
    // clickable link on this order's own page.
    reworkOf: reworkOf || "",
    history: [],
    createdAt: now,
    updatedAt: now
  });

  await batch.commit();
}

/*
  A Production Request is a parent work order for a multi-week delivery
  schedule (MRP Easy order no. + a free-form list of {weekOf, qty} entries),
  one step up from a normal single work order. It never deducts stock
  itself - it's a planning record - and carries no qty of its own beyond the
  schedule's total for display. Each week in the schedule becomes its own
  real child work order (<parentWoNo>-1, -2, -3...), inheriting Part/Rev/MRP
  order no./creator, starting at status "Scheduled" with no assignee and no
  stock taken yet - see setWorkOrderAssignee for when that actually happens.
  All created in one atomic batch: the schedule either fully exists or none
  of it does, never half-created.
*/
export async function createProductionRequest({
  woNo,
  partNo,
  rev,
  partName,
  mrpOrderNo,
  creator,
  schedule,
  newPartMaster,
  updatePartMasterLinkedStock,
  linkedStockItem
}) {
  const now = Date.now();
  const batch = writeBatch(db);

  if (newPartMaster) {
    batch.set(partMasterDocRef(partNo, rev), { ...newPartMaster, createdAt: now, updatedAt: now });
  } else if (updatePartMasterLinkedStock !== undefined) {
    batch.update(partMasterDocRef(partNo, rev), { linkedStockNumber: updatePartMasterLinkedStock, updatedAt: now });
  }

  const totalQty = schedule.reduce((sum, w) => sum + Math.abs(w.qty), 0);
  const linkedStockNumber = linkedStockItem ? linkedStockItem.partNumber : "";

  batch.set(workOrderRef(woNo), {
    woNo,
    partNo,
    rev,
    partName,
    date: now,
    qty: totalQty,
    batchNo: "",
    comment: "",
    linkedStockNumber,
    status: "Scheduled",
    assignee: "",
    creator: creator || "",
    mrpOrderNo: mrpOrderNo || "",
    isParent: true,
    weekCount: schedule.length,
    reworkOf: "",
    history: [],
    createdAt: now,
    updatedAt: now
  });

  schedule.forEach((week, i) => {
    const childWoNo = `${woNo}-${i + 1}`;
    batch.set(workOrderRef(childWoNo), {
      woNo: childWoNo,
      parentWoNo: woNo,
      partNo,
      rev,
      partName,
      date: now,
      weekOf: week.weekOf,
      qty: Math.abs(week.qty),
      batchNo: "",
      comment: "",
      linkedStockNumber,
      status: "Scheduled",
      assignee: "",
      creator: creator || "",
      mrpOrderNo: mrpOrderNo || "",
      reworkOf: "",
      history: [],
      createdAt: now,
      updatedAt: now
    });
  });

  await batch.commit();
}

export async function listChildWorkOrders(parentWoNo) {
  const q = query(workOrdersRef(), where("parentWoNo", "==", parentWoNo), limit(500));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data()).sort((a, b) => (a.weekOf || 0) - (b.weekOf || 0));
}

export function subscribeChildWorkOrders(parentWoNo, onChange) {
  const q = query(workOrdersRef(), where("parentWoNo", "==", parentWoNo), limit(500));
  return onSnapshot(q, (snap) => {
    onChange(snap.docs.map((d) => d.data()).sort((a, b) => (a.weekOf || 0) - (b.weekOf || 0)));
  });
}

/*
  Picking up a Scheduled work order (a plain one from procurement or a
  Production Request's weekly child): sets its assignee and the batch(es)
  the machine shop chose, flips it to Open, and - only now - actually
  deducts its qty from the linked stock item's Production qty. Reads the stock item first
  (before the batch is built) so balanceAfter reflects its current qty,
  same reasoning as every other read-then-batch-write function in this file.
*/
export async function setWorkOrderAssignee(wo, assignee, user, { batchNo = "", cocDraws = [] } = {}) {
  const now = Date.now();
  // A work order saved without a stock link still matches a stock item that
  // shares its part number, so fall back to that rather than silently taking
  // nothing.
  const stockKey = wo.linkedStockNumber || wo.partNo;
  const linkedStockItem = stockKey ? await getStockItem(stockKey) : null;

  const batch = writeBatch(db);
  batch.update(workOrderRef(wo.woNo), {
    assignee,
    status: "Open",
    batchNo,
    cocDraws,
    ...(linkedStockItem ? { linkedStockNumber: linkedStockItem.partNumber } : {}),
    updatedAt: now
  });

  let balanceAfter = null;
  if (linkedStockItem) {
    // No floor at 0 - an honest (possibly negative) balance, not a number
    // that quietly hides an over-deduction.
    balanceAfter = areaQty(linkedStockItem, DEDUCTION_AREA) - Math.abs(wo.qty);
    const txRef = doc(transactionsRef());
    batch.set(txRef, {
      stockItemId: linkedStockItem.partNumber,
      stockNumber: linkedStockItem.partNumber,
      type: "take",
      area: DEDUCTION_AREA,
      qty: Math.abs(wo.qty),
      balanceAfter,
      user,
      note: `Work order ${wo.woNo}`,
      workOrderNumber: wo.woNo,
      timestamp: now
    });
    batch.update(stockItemRef(linkedStockItem.partNumber), {
      [`areas.${DEDUCTION_AREA}.qty`]: increment(-Math.abs(wo.qty)),
      updatedAt: now
    });
  }

  await batch.commit();
  return { balanceAfter };
}

/*
  Editing a work order's qty and/or linked raw stock has to keep the stock
  ledger honest with whatever was actually deducted at creation - it can't
  just overwrite the WO's own qty/linkedStockNumber fields and leave the
  original deduction sitting there unexplained. So this never rewrites the
  original transaction (this app's log is append-only everywhere else too);
  instead it works out the difference and writes a fresh transaction for
  just that difference, tagged to the same work order:
   - same linked item, qty changed: take/book-in just the delta.
   - linked item changed: book the old item's full original qty back in,
     then take the new qty from the new item.
   - either side blank: only the side that has an item gets a transaction.
  All of it - the WO field update plus whichever adjustment transactions
  are needed - commits as one atomic batch.
*/
export async function updateWorkOrderReconciled(wo, { qty, comment, batchNo, linkedStockNumber, user, dueDate }) {
  const now = Date.now();
  const oldQty = wo.qty || 0;
  const oldLinked = wo.linkedStockNumber || "";
  const newQty = Math.abs(qty);
  const newLinked = linkedStockNumber || "";

  const batch = writeBatch(db);
  batch.update(workOrderRef(wo.woNo), {
    qty: newQty,
    comment: comment || "",
    batchNo: batchNo || "",
    linkedStockNumber: newLinked,
    dueDate: dueDate || null,
    updatedAt: now
  });

  // A Scheduled order hasn't taken any stock yet (see setWorkOrderAssignee),
  // so changing its qty or link has nothing to reconcile.
  if (wo.status === "Scheduled") {
    await batch.commit();
    return;
  }

  function writeAdjustment(item, signedDelta) {
    const balanceAfter = areaQty(item, DEDUCTION_AREA) + signedDelta;
    const txRef = doc(transactionsRef());
    batch.set(txRef, {
      stockItemId: item.partNumber,
      stockNumber: item.partNumber,
      type: signedDelta < 0 ? "take" : "book-in",
      area: DEDUCTION_AREA,
      qty: Math.abs(signedDelta),
      balanceAfter,
      user,
      note: `Work order ${wo.woNo} edited`,
      workOrderNumber: wo.woNo,
      timestamp: now
    });
    batch.update(stockItemRef(item.partNumber), {
      [`areas.${DEDUCTION_AREA}.qty`]: increment(signedDelta),
      updatedAt: now
    });
  }

  if (oldLinked === newLinked) {
    if (oldLinked && newQty !== oldQty) {
      const item = await getStockItem(oldLinked);
      if (item) writeAdjustment(item, oldQty - newQty);
    }
  } else {
    if (oldLinked && oldQty > 0) {
      const oldItem = await getStockItem(oldLinked);
      if (oldItem) writeAdjustment(oldItem, oldQty);
    }
    if (newLinked && newQty > 0) {
      const newItem = await getStockItem(newLinked);
      if (newItem) writeAdjustment(newItem, -newQty);
    }
  }

  await batch.commit();
}

/*
  Cancelling a work order has to undo its stock impact, not just mark it
  closed and leave the linked item permanently short (or over) by whatever
  it deducted. The net amount still "owed back" is its original qty minus
  anything a reject already returned - not just wo.qty outright, or a
  reject's return would get double-counted. That net amount is booked back
  in as one ordinary transaction (so the log still explains it).

  This never deletes the work order doc - a deleted order either leaves a
  permanent gap in the numbering, or (worse) frees its number up to be
  reused by a completely unrelated later order, which actually happened
  here before this was changed. Cancelling instead keeps the number
  reserved forever and the order fully visible/recoverable (just flip
  Status back via the dropdown) - "deleted" was never really gone, just
  harder to find.
*/
export async function cancelWorkOrder(wo, user) {
  const now = Date.now();
  const batch = writeBatch(db);
  await queueStockReturn(batch, wo, user, "cancelled", now, new Map());
  batch.update(workOrderRef(wo.woNo), { status: "Cancelled", updatedAt: now });
  await batch.commit();
}

// `running` carries each part's pending balance across several orders in one
// batch (a parent's children often share a part), so every logged
// balanceAfter reflects the orders returned before it, not just the stored qty.
async function queueStockReturn(batch, wo, user, verb, now, running) {
  const alreadyReturned = (wo.history || [])
    .filter((h) => h.type === "rejected")
    .reduce((sum, h) => sum + (h.returnedQty || 0), 0);
  const netToReturn = (wo.qty || 0) - alreadyReturned;

  // A Scheduled work order (an un-picked-up weekly child of a Production
  // Request) never had its qty deducted in the first place - see
  // setWorkOrderAssignee, which is what actually takes the stock. Cancelling
  // it before that point has nothing to give back.
  if (wo.status === "Scheduled" || !wo.linkedStockNumber || netToReturn <= 0) return;
  const item = await getStockItem(wo.linkedStockNumber);
  if (!item) return;

  const base = running.has(item.partNumber) ? running.get(item.partNumber) : areaQty(item, DEDUCTION_AREA);
  const balanceAfter = base + netToReturn;
  running.set(item.partNumber, balanceAfter);
  batch.set(doc(transactionsRef()), {
    stockItemId: item.partNumber,
    stockNumber: item.partNumber,
    type: "book-in",
    area: DEDUCTION_AREA,
    qty: netToReturn,
    balanceAfter,
    user,
    note: `Work order ${wo.woNo} ${verb}`,
    workOrderNumber: wo.woNo,
    timestamp: now
  });
  batch.update(stockItemRef(item.partNumber), {
    [`areas.${DEDUCTION_AREA}.qty`]: increment(netToReturn),
    updatedAt: now
  });
}

/*
  Permanently removes a work order (and, for a Production Request, all its
  weekly children), returning whatever stock they still hold first. Already
  Cancelled orders had theirs returned at cancel time, so they're skipped
  here rather than returned twice. IDNs and old stock-log entries that
  mention the number are left alone and simply point at nothing afterwards.
*/
export async function deleteWorkOrder(wo, user) {
  const now = Date.now();
  const orders = wo.isParent ? [...(await listChildWorkOrders(wo.woNo)), wo] : [wo];
  const batch = writeBatch(db);
  const running = new Map();
  const deleting = new Set(orders.map((o) => o.woNo));
  for (const o of orders) {
    if (!o.isParent && o.status !== "Cancelled") await queueStockReturn(batch, o, user, "deleted", now, running);
    batch.delete(workOrderRef(o.woNo));

    // Don't leave a route card pointing at an order that no longer exists:
    // an order that held a card releases the ones it covered, and an order
    // that was covered comes off its card.
    if (o.firstOff) {
      (o.firstOff.covers || [])
        .filter((n) => !deleting.has(n))
        .forEach((n) => batch.update(workOrderRef(n), { firstOffRef: "", updatedAt: now }));
    }
    if (o.firstOffRef && !deleting.has(o.firstOffRef)) {
      const primary = await getWorkOrder(o.firstOffRef);
      if (primary && primary.firstOff) {
        const firstOff = { ...primary.firstOff, covers: (primary.firstOff.covers || []).filter((n) => n !== o.woNo) };
        batch.update(workOrderRef(primary.woNo), { firstOff, updatedAt: now });
      }
    }
  }
  await batch.commit();
}

// ---- IDN (internal delivery note) numbering ----
// IDN No. format: IDN-{4-digit sequence} - one running count for the whole
// shop, same style as work order numbers.
export async function suggestNextIdnNumber() {
  const snap = await getDocs(idnsRef());
  let max = 0;
  snap.docs.forEach((d) => {
    const m = /^IDN-(\d+)$/.exec(d.data().idnNo || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return "IDN-" + String(max + 1).padStart(4, "0");
}

/*
  Ref No. has no fixed format (unlike IDN/WO numbers) - whatever prefix the
  shop is using this month (e.g. "MS ") is whatever the most recent IDN with
  a trailing number actually used, so there's nothing to suggest until
  someone's typed the first one by hand. From then on this just increments
  that same trailing number - still a plain editable text field, this only
  pre-fills it.
*/
export async function suggestNextRefNo() {
  const snap = await getDocs(idnsRef());
  let prefix = "";
  let max = 0;
  let latestCreatedAt = -Infinity;
  snap.docs.forEach((d) => {
    const data = d.data();
    const m = /^(.*?)(\d+)\s*$/.exec(data.refNo || "");
    if (m && data.createdAt > latestCreatedAt) {
      latestCreatedAt = data.createdAt;
      prefix = m[1];
      max = parseInt(m[2], 10);
    }
  });
  return max > 0 ? `${prefix}${max + 1}` : "";
}

export async function getIdn(idnNo) {
  const snap = await getDoc(idnRef(idnNo));
  return snap.exists() ? snap.data() : null;
}

export function subscribeIdn(idnNo, onChange) {
  return onSnapshot(idnRef(idnNo), (snap) => {
    onChange(snap.exists() ? snap.data() : null);
  });
}

export async function listIdns() {
  const snap = await getDocs(idnsRef());
  return snap.docs.map((d) => d.data());
}

export function subscribeIdns(onChange) {
  return onSnapshot(idnsRef(), (snap) => {
    onChange(snap.docs.map((d) => d.data()));
  });
}

export async function listIdnsForWorkOrder(woNo) {
  const q = query(idnsRef(), where("woNo", "==", woNo), limit(2000));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data()).sort((a, b) => b.createdAt - a.createdAt);
}

/*
  Generating an IDN never touches the stock ledger - the raw material was
  already deducted once, when the work order itself was created. This just
  records that N of the pieces pulled for that work order turned out good
  and are being delivered, so it's one atomic batch covering the new IDN
  document plus the work order's own history - Completed is derived from
  that history (see completedQtyOf), not stored separately.
*/
export async function createIdnForWorkOrder({ idnNo, wo, qty, partNo, rev, partName, comment, refNo, po, vms, initials, user }) {
  const now = Date.now();
  const batch = writeBatch(db);

  batch.set(idnRef(idnNo), {
    idnNo,
    woNo: wo.woNo,
    partNo,
    rev,
    partName: partName || "",
    qty: Math.abs(qty),
    comment: comment || "",
    refNo: refNo || "",
    po: po || "",
    vms: vms || "",
    initials: initials || "",
    date: now,
    createdAt: now
  });

  const newCompleted = completedQtyOf(wo) + Math.abs(qty);
  const newRemaining = (wo.qty || 0) - newCompleted - rejectedQtyOf(wo);
  batch.update(workOrderRef(wo.woNo), {
    history: arrayUnion({ type: "completed", qty: Math.abs(qty), idnNo, user, timestamp: now }),
    // Fully accounted for (nothing left to complete or reject) - closes
    // the order automatically. Still just a normal status, reopen any time.
    ...(newRemaining <= 0 ? { status: "Complete" } : {}),
    updatedAt: now
  });

  await batch.commit();
}

/*
  A reject never touches stock either, unless some of the pulled material
  is actually salvageable - then returnedQty books just that much back in,
  as its own atomic step alongside the work order's rejectedQty/history
  update. A straight loss (returnedQty 0, the default) is just bookkeeping:
  the material was already consumed making the part that failed.
*/
export async function recordWorkOrderReject(wo, { qty, reason, returnedQty, user }) {
  const now = Date.now();
  const batch = writeBatch(db);

  const newRejected = rejectedQtyOf(wo) + Math.abs(qty);
  const newRemaining = (wo.qty || 0) - completedQtyOf(wo) - newRejected;
  batch.update(workOrderRef(wo.woNo), {
    history: arrayUnion({
      type: "rejected",
      qty: Math.abs(qty),
      reason: reason || "",
      returnedQty: Math.abs(returnedQty || 0),
      user,
      timestamp: now
    }),
    // Fully accounted for (nothing left to complete or reject) - closes
    // the order automatically. Still just a normal status, reopen any time.
    ...(newRemaining <= 0 ? { status: "Complete" } : {}),
    updatedAt: now
  });

  if (returnedQty && wo.linkedStockNumber) {
    const item = await getStockItem(wo.linkedStockNumber);
    if (item) {
      const balanceAfter = areaQty(item, DEDUCTION_AREA) + Math.abs(returnedQty);
      const txRef = doc(transactionsRef());
      batch.set(txRef, {
        stockItemId: item.partNumber,
        stockNumber: item.partNumber,
        type: "book-in",
        area: DEDUCTION_AREA,
        qty: Math.abs(returnedQty),
        balanceAfter,
        user,
        note: `Returned from reject on work order ${wo.woNo}`,
        workOrderNumber: wo.woNo,
        timestamp: now
      });
      batch.update(stockItemRef(item.partNumber), {
        [`areas.${DEDUCTION_AREA}.qty`]: increment(Math.abs(returnedQty)),
        updatedAt: now
      });
    }
  }

  await batch.commit();
}

/*
  Deleting a reject entry created by mistake is the mirror of voidIdn():
  remove that exact history object via arrayRemove (Rejected is derived from
  what's left in history, nothing else to adjust there) and recheck whether
  this reopens an order that had auto-closed. If that reject had also
  returned stock to Production, the return has to be taken back out too -
  otherwise the correction silently leaves that stock credited twice (once
  from this entry, once again if the reject gets re-recorded correctly
  afterward).
*/
export async function deleteReject(wo, entry) {
  const now = Date.now();
  const batch = writeBatch(db);

  const wasComplete = wo.status === "Complete";
  const newRejected = rejectedQtyOf(wo) - (entry.qty || 0);
  const newRemaining = (wo.qty || 0) - completedQtyOf(wo) - newRejected;

  batch.update(workOrderRef(wo.woNo), {
    history: arrayRemove(entry),
    ...(wasComplete && newRemaining > 0 ? { status: "Issued" } : {}),
    updatedAt: now
  });

  if (entry.returnedQty && wo.linkedStockNumber) {
    const item = await getStockItem(wo.linkedStockNumber);
    if (item) {
      const balanceAfter = areaQty(item, DEDUCTION_AREA) - Math.abs(entry.returnedQty);
      const txRef = doc(transactionsRef());
      batch.set(txRef, {
        stockItemId: item.partNumber,
        stockNumber: item.partNumber,
        type: "take",
        area: DEDUCTION_AREA,
        qty: Math.abs(entry.returnedQty),
        balanceAfter,
        user: entry.user,
        note: `Reject on work order ${wo.woNo} deleted`,
        workOrderNumber: wo.woNo,
        timestamp: now
      });
      batch.update(stockItemRef(item.partNumber), {
        [`areas.${DEDUCTION_AREA}.qty`]: increment(-Math.abs(entry.returnedQty)),
        updatedAt: now
      });
    }
  }

  await batch.commit();
}

/*
  A direct correction to the Completed/Rejected count itself, for when the
  number's just wrong and there's no real IDN or reject behind the fix - a
  plain "adjusted" history entry carrying the signed delta (not a qty, since
  it has to move the total either direction), so completedQtyOf/
  rejectedQtyOf can still fold it in and the total never becomes its own
  separately-drifting field again. No stock movement either way - the raw
  material was already deducted when the work order was created; this only
  corrects the paperwork count of what became good/bad of it.
*/
export async function adjustWorkOrderCount(wo, { field, newValue, reason, user }) {
  const current = field === "completed" ? completedQtyOf(wo) : rejectedQtyOf(wo);
  const delta = newValue - current;
  if (delta === 0) return;

  const entry = { type: "adjusted", field, delta, reason: reason || "", user, timestamp: Date.now() };
  const newHistory = [...(wo.history || []), entry];
  const newRemaining = Math.max(0, (wo.qty || 0) - completedQtyOf({ history: newHistory }) - rejectedQtyOf({ history: newHistory }));
  const wasComplete = wo.status === "Complete";

  await updateWorkOrderFields(wo.woNo, {
    history: arrayUnion(entry),
    ...(newRemaining <= 0 && !wasComplete ? { status: "Complete" } : {}),
    ...(wasComplete && newRemaining > 0 ? { status: "Issued" } : {})
  });
}

// Mirrors deleteReject() but for an "adjusted" entry - no stock to reverse,
// just the history entry and a status recheck.
export async function deleteAdjustment(wo, entry) {
  const wasComplete = wo.status === "Complete";
  const newHistory = (wo.history || []).filter((h) => h !== entry);
  const newRemaining = Math.max(0, (wo.qty || 0) - completedQtyOf({ history: newHistory }) - rejectedQtyOf({ history: newHistory }));

  await updateWorkOrderFields(wo.woNo, {
    history: arrayRemove(entry),
    ...(wasComplete && newRemaining > 0 ? { status: "Issued" } : {})
  });
}

/*
  Voiding an IDN created by mistake has to undo its effect on the parent
  work order's Completed count, or Remaining would stay permanently wrong.
  The matching history entry is removed via arrayRemove, which needs the
  exact object it's matching against - found by idnNo rather than rebuilt,
  since arrayUnion may have stored it with key ordering we can't rely on
  reproducing byte-for-byte. If the WO was itself cancelled since, there's
  nothing to reconcile against - just void the IDN.

  The IDN document itself is kept (flagged voided), never deleted - same
  reasoning as cancelling a work order: a deleted IDN frees its number up
  for a completely unrelated later delivery note to reuse, which is worse
  than a permanent gap. A voided one stays on record, visibly marked.
*/
export async function voidIdn(idn) {
  const batch = writeBatch(db);
  const wo = await getWorkOrder(idn.woNo);

  if (wo) {
    const matchingEntry = (wo.history || []).find(
      (h) => h.type === "completed" && h.idnNo === idn.idnNo
    );
    // Nothing left in history to account for (already removed, e.g. by an
    // earlier attempt that got re-tried after a slow/offline write) - a
    // second decrement here with nothing to match would just drag
    // Completed below what the log actually explains.
    if (matchingEntry) {
      const wasComplete = wo.status === "Complete";
      const newHistory = wo.history.filter((h) => h !== matchingEntry);
      const newCompleted = completedQtyOf({ history: newHistory });
      const newRemaining = (wo.qty || 0) - newCompleted - rejectedQtyOf(wo);

      batch.update(workOrderRef(wo.woNo), {
        history: arrayRemove(matchingEntry),
        // Removing a completion can reopen an order that had auto-closed.
        ...(wasComplete && newRemaining > 0 ? { status: "Issued" } : {}),
        updatedAt: Date.now()
      });
    }
  }

  batch.update(idnRef(idn.idnNo), { voided: true, voidedAt: Date.now() });
  await batch.commit();
}

/*
  Book-in/take is a single atomic batch: the transaction log entry and the
  stockItems.areas.{area}.qty update commit together, all-or-nothing, so the
  quantity can never drift from the log that explains it.

  A batch (not a read-then-verify runTransaction()) is deliberate: this shop
  floor tablet has patchy wifi and writes need to queue and sync later.
  Firestore transactions require a live round trip to the server and simply
  fail offline; a batch queues locally like any other write. increment() is
  used for the same reason - it's resolved server-side, so multiple queued
  taps from the same device never race or clobber each other. balanceAfter
  on the log entry is computed from the last value the local cache saw
  (updated optimistically the instant a write is issued), which is accurate
  for the single-tablet-at-the-shelf case this app is built for.
*/
export async function recordTransaction(item, { type, qty, user, note, workOrderNumber, area }) {
  const signedDelta = type === "take" ? -Math.abs(qty) : Math.abs(qty);
  const balanceAfter = areaQty(item, area) + signedDelta;

  const batch = writeBatch(db);
  const txRef = doc(transactionsRef());
  batch.set(txRef, {
    stockItemId: item.partNumber,
    stockNumber: item.partNumber,
    type,
    area,
    qty: Math.abs(qty),
    balanceAfter,
    user,
    note: note || "",
    workOrderNumber: workOrderNumber || "",
    timestamp: Date.now()
  });
  batch.update(stockItemRef(item.partNumber), {
    [`areas.${area}.qty`]: increment(signedDelta),
    updatedAt: Date.now()
  });
  await batch.commit();

  return balanceAfter;
}

/*
  Firestore needs a composite index to combine an equality filter on one
  field with orderBy on another - an easy-to-miss manual deployment step
  this app avoids entirely by only ever filtering on the single equality
  field (stockNumber, which is auto-indexed on its own) and sorting the
  (bounded) result client-side instead. Fine at this app's scale - one
  shop's worth of movements for one stock item, not a multi-tenant log.
*/
async function allTransactionsForItem(partNumber) {
  const q = query(transactionsRef(), where("stockNumber", "==", partNumber), limit(2000));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data()).sort((a, b) => b.timestamp - a.timestamp);
}

export async function listRecentTransactions(partNumber, count) {
  const all = await allTransactionsForItem(partNumber);
  return all.slice(0, count || 10);
}

// Full history for one item, newest first, paginated client-side 25 at a time.
export async function listTransactionPage(partNumber, pageSize, pageIndex) {
  const all = await allTransactionsForItem(partNumber);
  const start = pageIndex * pageSize;
  return {
    items: all.slice(start, start + pageSize),
    hasMore: start + pageSize < all.length,
    total: all.length
  };
}

export async function listTransactionsForWorkOrder(workOrderNumber) {
  const q = query(transactionsRef(), where("workOrderNumber", "==", workOrderNumber), limit(2000));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data()).sort((a, b) => b.timestamp - a.timestamp);
}

/*
  All book-ins (any part, any area) from the last `days` days, for the
  Dashboard's "Stock added" graph. Unlike allTransactionsForItem this isn't
  scoped to one part, so it can't filter on stockNumber - instead it takes
  the same no-composite-index approach from the other end: order by
  timestamp alone (auto-indexed, no equality filter to combine it with) and
  filter down to book-ins client-side. Bounded by `limit` rather than a
  date range in the query itself, same reasoning as allTransactionsForItem.
*/
// New stock arriving, as opposed to the other book-in legs that just shuffle
// or give back existing stock: the "Moved from" half of an area move, and
// anything tied to a work order (a cancel/edit/reject return).
export function isStockAddedTx(tx) {
  if (tx.type !== "book-in" || tx.workOrderNumber) return false;
  return !String(tx.note || "").startsWith("Moved from");
}

export function subscribeRecentBookIns(days, onChange) {
  const cutoff = Date.now() - days * 86400000;
  const q = query(transactionsRef(), orderBy("timestamp", "desc"), limit(3000));
  return onSnapshot(q, (snap) => {
    const all = snap.docs.map((d) => d.data());
    onChange(all.filter((t) => isStockAddedTx(t) && t.timestamp >= cutoff));
  });
}

export function distinctValues(items, field) {
  return Array.from(new Set(items.map((i) => i[field]).filter(Boolean))).sort();
}
