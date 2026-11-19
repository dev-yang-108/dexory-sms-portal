# Dexory Raw Stock

Shop-floor raw material stock tracker with barcode lookup. Plain HTML/CSS/JS,
no build step, backed by Firebase (Firestore + Hosting).

## 1. Create the Firebase project (you do this part - needs your Google login)

1. Go to https://console.firebase.google.com and click **Add project**.
2. Name it (e.g. `dexory-raw-stock`), finish the wizard (Google Analytics is optional, you can skip it).
3. In the left nav, open **Build > Firestore Database** → **Create database** →
   **Standard edition** → start in **production mode** → pick a region close to you.
4. Click the gear icon → **Project settings** → scroll to **Your apps** →
   click the **</>** (web) icon → register an app (any nickname) → it shows a
   `firebaseConfig` object. Copy it.
5. Paste those values into [`firebase-config.js`](firebase-config.js), replacing the
   `TODO_REPLACE...` placeholders.

## 2. Install the Firebase CLI

```bash
npm install -g firebase-tools
firebase login
```

## 3. Point the CLI at your project

Copy `.firebaserc.example` to `.firebaserc` and put your project ID in it, or run:

```bash
firebase use --add
```
and pick the project you created in step 1.

## 4. Deploy rules + hosting

From inside `dexory-raw-stock/`:

```bash
firebase deploy --only firestore:rules,hosting
```

Firebase Hosting will print a URL like `https://your-project.web.app` - bookmark
that on the shop floor tablet/laptop.

## 5. (Optional) Set up AI scanning for CoC uploads

The "Scan with AI" button on **Add stock via CoC** reads a photo/PDF of a
supplier's Certificate of Conformity and fills in the form for you (still
editable, still nothing saved until you confirm). It's optional - the CoC
feature works fine without it, just typed in by hand.

This calls Claude (Anthropic), via a small endpoint `server.js` itself
exposes (`/api/extract-coc`) - not Firebase - so there's no Firebase billing
plan or Google Cloud setup involved. The Claude API key lives only on
whichever machine runs `server.js` (e.g. the shop laptop/tablet itself), and
is never sent to the browser.

1. Get an API key at https://console.anthropic.com/settings/keys (needs an
   Anthropic account with billing set up - Claude's API is pay-per-use, not
   a flat plan; a few scans a day costs a trivial amount).
2. Copy [`.env.example`](.env.example) to `.env` (same folder as
   `server.js`) and paste your key in:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
   `.env` is gitignored - it never gets committed.
3. Restart `server.js` if it was already running (`node server.js`) so it
   picks up the new `.env`.

That's it - no Firebase console steps, no billing plan upgrade, no key ever
touches the browser's own code. If scanning fails, the error toast says
why (no key configured, Claude couldn't read the file, or the server's
unreachable) - check that message first.

**Note:** because the Claude call happens in `server.js`, scanning only
works while that specific machine's server is running - if you deploy this
app to Firebase Hosting as a static site (step 4 above), the `/api/`
endpoint won't exist there. For a shop-floor laptop/tablet running its own
local `server.js`, that's exactly the intended setup; if you need scanning
to work from a hosted deployment too, that'd need a real backend (a Cloud
Function or similar) instead of this local-server shortcut.

## Local development

No build step - it's static files, but ES modules need to be served over
`http://` or `https://` (not opened directly as a `file://` path). Either:

- `firebase serve --only hosting` (or any static file server) and open
  `http://localhost:5000`, or
- Open [`index.html?mock=1`](index.html?mock=1) (or [`dev/preview.html`](dev/preview.html))
  through a static server to click through the whole app - including
  book-in/take, low-stock flagging, scanning, printing - against a
  localStorage-backed mock Firestore, with **no real Firebase project
  needed**. See "Local development without Firebase" below.

Camera barcode scanning additionally requires HTTPS or `localhost`.

## How it's put together

- `index.html` / `style.css` - single-page shell, one `#app` div the router
  re-renders into.
- `firebase-config.js` - Firebase v9+ modular SDK init (loaded as ES modules
  straight from the gstatic CDN, no bundler) + Firestore offline persistence.
  Also the single switch point for the `?mock=1` dev backend (see below).
- `js/db.js` - all Firestore reads/writes, the `stockItems` /
  `transactions` collection schemas, low-stock math, and the book-in/take
  write.
- `js/coc-extract.js` - "Scan with AI": posts an uploaded CoC photo/PDF to
  this same server's own `/api/extract-coc` endpoint and gets structured
  JSON back to pre-fill the CoC form. See "Set up AI scanning for CoC
  uploads" above before expecting this to do anything.
- `js/barcode.js` - barcode generation (JsBarcode, Code128), camera scanning
  (native `BarcodeDetector` API, falling back to `@zxing/library`), and the
  keyboard-wedge (HID handheld scanner) listener.
- `js/qty-modal.js` - the shared "Take stock" / "Book in" modal, reused by
  the edit form's "Adjust quantity" action.
- `js/render.js` - tiny shared helpers (escaping, mounting HTML, toasts).
- `js/views/*.js` - one file per screen: list, detail, new/edit form, scan.
- `app.js` - hash-based router (`#/`, `#/item/:stockNumber`, `#/new`,
  `#/edit/:stockNumber`, `#/scan`) + boots the keyboard-wedge listener.

### Data model

```
stockItems/{stockNumber}                 // one doc per material+size+part combo
{
  stockNumber,       // e.g. "RS-0042" - also the doc id and the barcode value
  partNumber, material, stockSize,
  form,              // "Blank" | "Waterjet profile" | "Long bar"
  approxWeight, location,
  perRobotCycle,      // pcs consumed per robot cycle
  currentQty,         // pcs - only ever changed via a transaction, see below
  createdAt, updatedAt
}

transactions/{autoId}                    // one doc per stock movement
{
  stockItemId, stockNumber,  // denormalized for easy display/query
  type,          // "book-in" | "take"
  qty,           // positive - sign is implied by type
  balanceAfter,  // currentQty snapshot right after this transaction
  user,          // Dev / Igor / Nathan / free-text "Other"
  note,
  timestamp
}
```

### Book-in / take: why a batch instead of `runTransaction()`

Every book-in/take needs to (a) feel instant, (b) work offline on shop wifi
and sync later, and (c) never let the log and the counter drift apart.
Firestore's `runTransaction()` guarantees read-then-write correctness but
**doesn't work offline** - it needs a live round trip to the server. So
`recordTransaction()` in `js/db.js` instead uses a `writeBatch()`:

- The transaction log doc and the `stockItems.currentQty` update commit
  together as one batch - atomic (all-or-nothing), but queueable offline
  like any other write, unlike a transaction.
- The counter itself is updated with `increment()`, resolved server-side, so
  several queued offline taps never race or clobber each other.
- The log entry's `balanceAfter` is computed from the last value the local
  cache saw (updated optimistically the instant a write is issued) - accurate
  for the real use case of one tablet at the shelf.

### Low stock rule

An item is flagged red when `Math.floor(currentQty / perRobotCycle) < 5` -
i.e. under 5 robot cycles remaining. This scales per item by its own
`perRobotCycle`, not a flat pcs threshold (see `isLowStock()` in `js/db.js`).

### Barcodes

Each item's barcode is just its `stockNumber` (Code128, via JsBarcode) -
never its data - so nothing needs reprinting when an item's details change.
Scanning (camera or handheld HID scanner) decodes straight back to a
`stockNumber` and looks it up:

- Found → straight to that item's detail page.
- Not found → the "New stock item" form, `stockNumber` prefilled and
  read-only, with a banner explaining why.

### Keyboard-wedge (handheld) scanning

A handheld barcode scanner acts like a keyboard - it "types" the code into
whatever has focus and sends Enter. `js/barcode.js`'s `initKeyboardWedge()`
keeps a hidden, off-screen text input focused whenever nothing else needs
focus, and treats an Enter inside it as a completed scan. It steps aside the
moment you focus a real field and reclaims focus once you're done, so it
never steals keystrokes meant for a visible input, and needs no camera or
button press.

### Label printing

The item detail page always renders a hidden `.print-label` block (barcode +
stockNumber + partNumber + location, sized for a ~60x40mm label). "Print
barcode label" just calls `window.print()`; `@media print` rules hide
everything else on the page and show only that block - no separate print
route needed.

### Local development without Firebase (`?mock=1`)

`dev/mock-firestore.js` is a localStorage-backed stand-in for the same
handful of modular Firestore functions `js/db.js` calls (`collection`,
`doc`, `getDoc`/`getDocs`, `setDoc`/`updateDoc`, `onSnapshot`, `query` +
`where`/`limit`, `writeBatch`, `increment`). `firebase-config.js` swaps it in
in place of the real CDN SDK whenever the page URL has `?mock=1` - nothing
else in the app knows or cares which backend it's talking to. It's seeded
with a few example stock items and transactions on first load. Never loaded
by the production import path (no `?mock=1` in a real deployed URL).

### Security rules

`firestore.rules` allows read/write to anyone with the app URL, matching the
"internal shop tool" requirement - there's no login. If this ever needs to
be locked down, the natural next step is Firebase Auth (e.g. a shared PIN or
Google sign-in restricted to your workspace domain) and rules that check
`request.auth != null`.
