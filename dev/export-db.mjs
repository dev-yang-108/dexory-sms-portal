/* Exports the whole live Firestore database (read-only) to one JSON file in
   backups/. Nothing is written or changed in the database.

   Run from the project folder:
     npm install --no-save firebase@10.13.2     (first time only)
     node dev/export-db.mjs

   The file lands in backups/, which is gitignored (it holds real stock and
   work-order data) and never deployed. */

import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs } from "firebase/firestore";
import { mkdirSync, writeFileSync } from "node:fs";

// Same public web config the app itself uses (firebase-config.js).
const app = initializeApp({
  apiKey: "AIzaSyBo4jWj8X9TVGsdGv1C0GQ7RgvyscjkeS8",
  authDomain: "dexory-cnc-stockflow.firebaseapp.com",
  projectId: "dexory-cnc-stockflow",
  storageBucket: "dexory-cnc-stockflow.firebasestorage.app",
  messagingSenderId: "331186111154",
  appId: "1:331186111154:web:b28a333a8fd8a4de96bfab"
});
const db = getFirestore(app);

const COLLECTIONS = ["stockItems", "transactions", "workOrders", "partMaster", "batches", "config", "idns", "cocs"];

// Firestore timestamps become epoch milliseconds, like the app's own dates.
function plain(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}

const out = { exportedAt: new Date().toISOString(), project: "dexory-cnc-stockflow", collections: {} };
for (const name of COLLECTIONS) {
  try {
    const snap = await getDocs(collection(db, name));
    out.collections[name] = Object.fromEntries(snap.docs.map((d) => [d.id, plain(d.data())]));
    console.log(`${name.padEnd(13)} ${snap.size} documents`);
  } catch (err) {
    // e.g. the live security rules don't allow this collection yet.
    out.collections[name] = { _error: err.code || String(err) };
    console.log(`${name.padEnd(13)} SKIPPED (${err.code || err})`);
  }
}

mkdirSync("backups", { recursive: true });
const file = `backups/database-export-${out.exportedAt.replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\nSaved ${file}`);
process.exit(0);
