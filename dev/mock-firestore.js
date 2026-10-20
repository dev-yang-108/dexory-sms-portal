/*
  Dev-only stand-in for the Firebase v9+ modular Firestore SDK, so the app
  can be clicked through - including book-in/take, low-stock flagging,
  scanning, printing - before a real Firebase project exists. Backed by
  localStorage. Loaded only via firebase-config.js when the page URL has
  ?mock=1; never referenced by the production import path.

  Implements just the slice of the modular API js/db.js actually calls:
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot,
  query, where, orderBy, limit, writeBatch, increment, arrayUnion,
  arrayRemove. Not a general Firestore emulator.
*/

const STORE_KEY = "dexory_raw_stock_mock_v9";
let seq = 0;

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (err) {
    /* fall through to seed */
  }
  const seeded = seedData();
  saveStore(seeded);
  return seeded;
}

function saveStore(store) {
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

function seedData() {
  const now = Date.now();
  // Keyed by partNumber now, not stockNumber - stockNumber is just an
  // optional note field, kept here purely for realism (some items have one
  // carried over from before this change, some don't). Each item's stock
  // now lives per-area (Farm/Production/Prototype) rather than as one qty.
  const stockItems = {
    "P-1042-A": {
      partNumber: "P-1042-A",
      stockNumber: "RS-0001",
      material: "Aluminium 6082",
      stockSize: "500 x 300 x 20mm",
      form: "Blank",
      approxWeight: "2.4 kg/pc",
      piecesPerBlank: 4,
      perRobotCycle: 4,
      areas: {
        farm: { qty: 40, location: "F-2" },
        production: { qty: 48, location: "A-1" },
        prototype: { qty: 0, location: "" }
      },
      createdAt: now - 20 * 86400000,
      updatedAt: now - 3600000
    },
    "P-2091-B": {
      partNumber: "P-2091-B",
      stockNumber: "RS-0002",
      material: "Mild steel S275",
      stockSize: "Bar, 40mm dia x 3m",
      form: "Long bar",
      approxWeight: "29.6 kg/m",
      piecesPerBlank: 1,
      perRobotCycle: 2,
      areas: {
        farm: { qty: 0, location: "" },
        production: { qty: 6, location: "B-3" },
        prototype: { qty: 0, location: "" }
      },
      createdAt: now - 40 * 86400000,
      updatedAt: now - 7200000
    },
    "P-3310-C": {
      partNumber: "P-3310-C",
      stockNumber: "",
      material: "Stainless 316L",
      stockSize: "Waterjet profile, 220 x 180 x 8mm",
      form: "Waterjet profile",
      approxWeight: "1.1 kg/pc",
      piecesPerBlank: 1,
      perRobotCycle: 6,
      areas: {
        farm: { qty: 0, location: "" },
        production: { qty: 90, location: "A-4" },
        prototype: { qty: 20, location: "C-2" }
      },
      createdAt: now - 5 * 86400000,
      updatedAt: now - 86400000
    }
  };

  function yymm(ts) {
    const d = new Date(ts);
    return String(d.getFullYear() % 100).padStart(2, "0") + String(d.getMonth() + 1).padStart(2, "0");
  }

  const partMaster = {
    "P-1042-A__R10": {
      partNo: "P-1042-A",
      rev: "10",
      partName: "Gearbox housing",
      unitPerRobot: 4,
      linkedStockNumber: "P-1042-A",
      defaultComment: "Standard batch for Acme line",
      createdAt: now - 20 * 86400000,
      updatedAt: now - 20 * 86400000
    },
    "P-9999-X__R1": {
      partNo: "P-9999-X",
      rev: "1",
      partName: "Bracket bushing",
      unitPerRobot: 2,
      linkedStockNumber: "",
      defaultComment: "",
      createdAt: now - 6 * 86400000,
      updatedAt: now - 6 * 86400000
    }
  };

  const batchTs1 = now - 20 * 86400000;
  const batchTs2 = now - 4 * 86400000;
  // Both fall in the same month here, so they get sequence 01 and 02, not
  // two "01"s - same rule the real suggestNextBatchNumber() follows.
  const sameMonth = yymm(batchTs1) === yymm(batchTs2);
  const batchNo1 = "42-A-" + yymm(batchTs1) + "-01";
  const batchNo2 = "42-A-" + yymm(batchTs2) + "-" + (sameMonth ? "02" : "01");
  const batches = {
    // batchNo1 was booked in through the item's own detail page (linked from
    // the start); batchNo2 demonstrates booking in before a Raw Stock No.
    // was assigned - unlinked until someone edits it in.
    [batchNo1]: { batchNo: batchNo1, stockNumber: "P-1042-A", partNo: "P-1042-A", qtyAdded: 60, blanksReceived: 15, piecesPerBlank: 4, area: "production", bookInDate: batchTs1, createdAt: batchTs1 },
    [batchNo2]: { batchNo: batchNo2, stockNumber: "", partNo: "P-1042-A", qtyAdded: 24, blanksReceived: 6, piecesPerBlank: 4, area: "", bookInDate: batchTs2, createdAt: batchTs2 }
  };

  const woTs1 = now - 15 * 86400000;
  const woTs2 = now - 3 * 86400000;
  const woNo1 = "DEX-WO-0001";
  const woNo2 = "DEX-WO-0002";
  const idnNo1 = "IDN-0001";
  const idnTs1 = now - 2 * 86400000;
  const workOrders = {
    [woNo1]: {
      woNo: woNo1,
      partNo: "P-1042-A",
      rev: "10",
      partName: "Gearbox housing",
      date: woTs1,
      qty: 12,
      batchNo: batchNo2,
      comment: "Acme batch 3",
      linkedStockNumber: "P-1042-A",
      status: "Open",
      completedQty: 9,
      rejectedQty: 1,
      history: [
        { type: "completed", qty: 9, idnNo: idnNo1, user: "Dev", timestamp: idnTs1 },
        { type: "rejected", qty: 1, reason: "Failed dimensional check", returnedQty: 0, user: "Igor", timestamp: now - 1800000 }
      ],
      createdAt: woTs1,
      updatedAt: now - 1800000
    },
    [woNo2]: {
      woNo: woNo2,
      partNo: "P-2091-B",
      rev: "1",
      partName: "Bar stock bracket",
      date: woTs2,
      qty: 4,
      batchNo: "",
      comment: "Line 2 rework",
      linkedStockNumber: "P-2091-B",
      status: "Complete",
      completedQty: 4,
      rejectedQty: 0,
      history: [{ type: "completed", qty: 4, idnNo: "IDN-0002", user: "Nathan", timestamp: now - 2 * 86400000 }],
      createdAt: woTs2,
      updatedAt: now - 5 * 86400000
    }
  };

  const idns = {
    [idnNo1]: {
      idnNo: idnNo1,
      woNo: woNo1,
      partNo: "P-1042-A",
      rev: "10",
      partName: "Gearbox housing",
      qty: 9,
      comment: "Acme batch 3",
      refNo: "MS 824",
      po: "PO00260",
      vms: "1641",
      initials: "MA",
      date: idnTs1,
      createdAt: idnTs1
    },
    "IDN-0002": {
      idnNo: "IDN-0002",
      woNo: woNo2,
      partNo: "P-2091-B",
      rev: "1",
      partName: "Bar stock bracket",
      qty: 4,
      comment: "Line 2 rework",
      refNo: "MS 811",
      po: "PO00251",
      vms: "1602",
      initials: "DS",
      date: now - 2 * 86400000,
      createdAt: now - 2 * 86400000
    }
  };

  const transactions = {};
  function addTx(stockNumber, type, area, qty, balanceAfter, user, note, timestamp, workOrderNumber) {
    seq += 1;
    const id = "seed-" + seq;
    transactions[id] = {
      stockItemId: stockNumber,
      stockNumber,
      type,
      area,
      qty,
      balanceAfter,
      user,
      note: note || "",
      workOrderNumber: workOrderNumber || "",
      timestamp
    };
  }
  addTx("P-1042-A", "book-in", "production", 60, 60, "Dev", "Batch " + batchNo1, batchTs1);
  addTx("P-1042-A", "take", "production", 12, 48, "Igor", "Work order " + woNo1, now - 3600000, woNo1);
  addTx("P-1042-A", "book-in", "farm", 40, 40, "Dev", "Delivery", now - 10 * 86400000);
  addTx("P-2091-B", "book-in", "production", 10, 10, "Nathan", "Delivery", now - 40 * 86400000);
  addTx("P-2091-B", "take", "production", 4, 6, "Igor", "Job 4488", now - 7200000, woNo2);
  addTx("P-3310-C", "book-in", "production", 100, 100, "Dev", "Delivery", now - 5 * 86400000);
  addTx("P-3310-C", "take", "production", 10, 90, "Nathan", "Job 4502", now - 86400000, woNo1);
  addTx("P-3310-C", "book-in", "prototype", 20, 20, "Dev", "Waterjet offcuts", now - 3 * 86400000);
  // A few more book-ins spread across recent weeks, purely so the
  // Dashboard's "Stock added" graph has something to show in the mock.
  addTx("P-1042-A", "book-in", "production", 16, 48, "Dev", "Delivery", now - 12 * 86400000);
  addTx("P-2091-B", "book-in", "production", 8, 10, "Dev", "Delivery", now - 26 * 86400000);
  addTx("P-3310-C", "book-in", "production", 30, 90, "Dev", "CoC SSA-1-213936", now - 33 * 86400000);
  addTx("P-1042-A", "book-in", "production", 22, 48, "Dev", "Delivery", now - 47 * 86400000);

  // One seeded CoC (point 6 of the feature: confirming a CoC books every
  // line's qty in and records the full batch breakdown) so the manual-entry
  // flow has an existing example to look at/merge into in the mock.
  const cocTs = now - 33 * 86400000;
  const cocKey = "SSA-1-213936";
  const cocs = {
    [cocKey]: {
      cocKey,
      supplierCode: "SSA",
      supplierName: "Shropshire Stainless and Aluminium",
      cocNumber: "1-213936",
      lines: [
        {
          partNo: "P-3310-C",
          qty: 30,
          batches: [
            { batchNo: "145088G", qty: 8 },
            { batchNo: "145365A", qty: 22 }
          ]
        }
      ],
      createdAt: cocTs,
      createdBy: "Dev"
    }
  };
  const cocLineBatchNo = `${cocKey}_P-3310-C`;
  batches[cocLineBatchNo] = {
    batchNo: cocLineBatchNo,
    stockNumber: "P-3310-C",
    partNo: "P-3310-C",
    qtyAdded: 30,
    blanksReceived: 0,
    piecesPerBlank: 0,
    area: "production",
    bookInDate: cocTs,
    createdAt: cocTs,
    cocKey,
    supplierBatches: [
      { batchNo: "145088G", qty: 8 },
      { batchNo: "145365A", qty: 22 }
    ]
  };

  const config = {
    knownUsers: { names: ["Dev", "Sarah M.", "Marcus K."], updatedAt: now },
    knownSuppliers: { list: [{ name: "Shropshire Stainless and Aluminium", code: "SSA" }], updatedAt: now }
  };

  return { stockItems, transactions, workOrders, partMaster, batches, config, idns, cocs };
}

// Firestore keys like "areas.production.qty" address a nested field without
// touching the rest of that nested object - real Firestore does this
// natively in update()/batch.update(); this mock has to replicate it by
// hand since it just stores plain JS objects.
function getDeep(obj, path) {
  return path.split(".").reduce((o, p) => (o == null ? undefined : o[p]), obj);
}
function setDeep(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function applyFieldValues(current, patch) {
  const next = JSON.parse(JSON.stringify(current || {}));
  Object.keys(patch).forEach((key) => {
    const val = patch[key];
    let resolved;
    if (val && val.__op === "increment") {
      resolved = (getDeep(current, key) || 0) + val.amount;
    } else if (val && val.__op === "arrayUnion") {
      resolved = (getDeep(current, key) || []).concat(val.items);
    } else if (val && val.__op === "arrayRemove") {
      const removeStrs = val.items.map((it) => JSON.stringify(it));
      resolved = (getDeep(current, key) || []).filter((el) => !removeStrs.includes(JSON.stringify(el)));
    } else {
      resolved = val;
    }
    setDeep(next, key, resolved);
  });
  return next;
}

const collectionListeners = {}; // name -> [cb]
const docListeners = {}; // "name/id" -> [cb]

function notifyCollection(name, store) {
  (collectionListeners[name] || []).forEach((cb) => cb(Object.values(store[name] || {})));
}
function notifyDoc(name, id, store) {
  const key = name + "/" + id;
  (docListeners[key] || []).forEach((cb) => cb(store[name] ? store[name][id] : undefined));
}

function makeDocRef(name, id) {
  return { __type: "doc", name, id };
}
function makeCollectionRef(name) {
  return { __type: "collection", name };
}
function makeQueryRef(collectionRef, constraints) {
  return { __type: "query", name: collectionRef.name, constraints };
}

export function collection(_db, name) {
  return makeCollectionRef(name);
}

export function doc(dbOrCollectionRef, name, id) {
  if (dbOrCollectionRef && dbOrCollectionRef.__type === "collection") {
    const autoId = name === undefined ? "auto-" + Date.now() + "-" + ++seq : name;
    return makeDocRef(dbOrCollectionRef.name, autoId);
  }
  // doc(db, name, id)
  return makeDocRef(name, id);
}

export async function getDoc(ref) {
  const store = loadStore();
  const data = store[ref.name] ? store[ref.name][ref.id] : undefined;
  return { exists: () => data !== undefined, data: () => data, id: ref.id };
}

export async function getDocs(refOrQuery) {
  const store = loadStore();
  const name = refOrQuery.name;
  let docsArr = Object.entries(store[name] || {}).map(([id, data]) => ({ id, data: () => data }));

  if (refOrQuery.__type === "query") {
    // Applied in a fixed order (filter, then sort, then limit) regardless of
    // how the constraints were listed - matches real Firestore query
    // semantics closely enough for this mock's purposes.
    const whereConstraints = refOrQuery.constraints.filter((c) => c.__op === "where");
    const orderByConstraint = refOrQuery.constraints.find((c) => c.__op === "orderBy");
    const limitConstraint = refOrQuery.constraints.find((c) => c.__op === "limit");

    whereConstraints.forEach((c) => {
      docsArr = docsArr.filter((d) => d.data()[c.field] === c.value);
    });
    if (orderByConstraint) {
      const { field, dir } = orderByConstraint;
      docsArr = docsArr.slice().sort((a, b) => {
        const av = a.data()[field];
        const bv = b.data()[field];
        if (av === bv) return 0;
        const cmp = av > bv ? 1 : -1;
        return dir === "desc" ? -cmp : cmp;
      });
    }
    if (limitConstraint) {
      docsArr = docsArr.slice(0, limitConstraint.n);
    }
  }
  return { docs: docsArr };
}

export async function setDoc(ref, data) {
  const store = loadStore();
  store[ref.name] = store[ref.name] || {};
  store[ref.name][ref.id] = { ...data };
  saveStore(store);
  notifyCollection(ref.name, store);
  notifyDoc(ref.name, ref.id, store);
}

export async function updateDoc(ref, patch) {
  const store = loadStore();
  store[ref.name] = store[ref.name] || {};
  store[ref.name][ref.id] = applyFieldValues(store[ref.name][ref.id] || {}, patch);
  saveStore(store);
  notifyCollection(ref.name, store);
  notifyDoc(ref.name, ref.id, store);
}

export async function deleteDoc(ref) {
  const store = loadStore();
  if (store[ref.name]) delete store[ref.name][ref.id];
  saveStore(store);
  notifyCollection(ref.name, store);
  notifyDoc(ref.name, ref.id, store);
}

export function onSnapshot(refOrQuery, cb) {
  if (refOrQuery.__type === "doc") {
    const key = refOrQuery.name + "/" + refOrQuery.id;
    getDoc(refOrQuery).then(cb);
    docListeners[key] = docListeners[key] || [];
    const wrapped = (data) => cb({ exists: () => data !== undefined, data: () => data, id: refOrQuery.id });
    docListeners[key].push(wrapped);
    return () => {
      docListeners[key] = (docListeners[key] || []).filter((f) => f !== wrapped);
    };
  }
  // collection or query
  const name = refOrQuery.name;
  getDocs(refOrQuery).then(cb);
  collectionListeners[name] = collectionListeners[name] || [];
  const wrapped = (list) => cb({ docs: list.map((data) => ({ data: () => data })) });
  collectionListeners[name].push(wrapped);
  return () => {
    collectionListeners[name] = (collectionListeners[name] || []).filter((f) => f !== wrapped);
  };
}

export function query(collectionRef, ...constraints) {
  return makeQueryRef(collectionRef, constraints);
}

export function where(field, op, value) {
  return { __op: "where", field, op, value };
}

export function orderBy(field, dir) {
  return { __op: "orderBy", field, dir: dir || "asc" };
}

export function limit(n) {
  return { __op: "limit", n };
}

export function writeBatch(_db) {
  const ops = [];
  return {
    set(ref, data) {
      ops.push({ kind: "set", ref, data });
    },
    update(ref, patch) {
      ops.push({ kind: "update", ref, patch });
    },
    delete(ref) {
      ops.push({ kind: "delete", ref });
    },
    async commit() {
      for (const op of ops) {
        if (op.kind === "set") await setDoc(op.ref, op.data);
        else if (op.kind === "update") await updateDoc(op.ref, op.patch);
        else if (op.kind === "delete") await deleteDoc(op.ref);
      }
    }
  };
}

export function increment(amount) {
  return { __op: "increment", amount };
}

export function arrayUnion(...items) {
  return { __op: "arrayUnion", items };
}

export function arrayRemove(...items) {
  return { __op: "arrayRemove", items };
}

export function getMockDb() {
  return { __mockDb: true };
}
