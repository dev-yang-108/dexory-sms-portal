/*
  Firebase project config + Firestore init (v9+ modular SDK, loaded from the
  gstatic CDN as ES modules - no npm build).

  TODO: paste your Firebase project's config below. Firebase console ->
  Project settings -> General -> "Your apps" -> Web app -> SDK setup and
  configuration. See README.md for the full setup walkthrough.
*/
const firebaseConfig = {
  apiKey: "AIzaSyBo4jWj8X9TVGsdGv1C0GQ7RgvyscjkeS8",
  authDomain: "dexory-cnc-stockflow.firebaseapp.com",
  projectId: "dexory-cnc-stockflow",
  storageBucket: "dexory-cnc-stockflow.firebasestorage.app",
  messagingSenderId: "331186111154",
  appId: "1:331186111154:web:b28a333a8fd8a4de96bfab"
};

/*
  ?mock=1 swaps in a localStorage-backed Firestore stand-in (dev/mock-firestore.js)
  so the app can be clicked through - including book-in/take flows - before a
  real Firebase project exists. Never used by the deployed app; nothing here
  reads that flag outside of local development.
*/
const USE_MOCK = new URLSearchParams(location.search).get("mock") === "1";

let firestoreModule;
let db;

if (USE_MOCK) {
  firestoreModule = await import("./dev/mock-firestore.js");
  db = firestoreModule.getMockDb();
} else {
  const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js");
  firestoreModule = await import("https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js");

  const app = initializeApp(firebaseConfig);

  // Shop wifi is patchy - keep working (reads from cache, queue writes) while
  // offline, syncing once back online. Falls back to memory-only if the
  // browser can't support persistence (e.g. private browsing).
  try {
    db = firestoreModule.initializeFirestore(app, {
      localCache: firestoreModule.persistentLocalCache({
        tabManager: firestoreModule.persistentMultipleTabManager()
      })
    });
  } catch (err) {
    console.warn("Offline persistence not available, falling back to in-memory cache:", err);
    db = firestoreModule.getFirestore(app);
  }
}

export { db, USE_MOCK };

export const {
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
} = firestoreModule;
