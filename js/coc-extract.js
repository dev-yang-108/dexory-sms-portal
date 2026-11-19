/* "Scan" for the CoC form - reads one or more uploaded CoC pages (photos
   and/or a PDF) right in the browser, with no server and no API key, and
   hands back the same {supplierName, cocNumber, lines} shape the manual-entry
   form already edits.

   How it reads:
   - Photos: Tesseract.js (free OCR) turns the picture into text.
   - PDFs: pdf.js pulls the text straight out of the file when it has any
     (exact), and only falls back to OCR on scanned pages.
   - parseCocText() then looks for the things a CoC always has: a certificate
     number, the supplier name, "DEX..." part numbers, quantities and batch /
     lot / heat numbers.

   It never saves anything - it only pre-fills the editable preview in
   coc-form.js, so a wrong guess is just a field to fix by hand. The raw text
   it read is returned too, so the form can show it for copy-paste.

   Both libraries load from a CDN the first time they're needed, so a normal
   page load stays fast.
*/

const TESSERACT_SRC = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const PDFJS_SRC = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER_SRC = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// Phone photos are 12MP+; OCR gains nothing past this and takes much longer.
const MAX_IMAGE_EDGE = 2000;
const MAX_PAGES = 8;
const IMAGE_PASSES = [
  { psm: "3", scale: 1 },
  { psm: "6", scale: 2 },
  { psm: "11", scale: 1.5 }
];

export function isExtractionAvailable() {
  return true;
}

const scriptCache = new Map();
function loadScript(src) {
  if (!scriptCache.has(src)) {
    scriptCache.set(
      src,
      new Promise((resolve, reject) => {
        const el = document.createElement("script");
        el.src = src;
        el.onload = resolve;
        el.onerror = () => {
          scriptCache.delete(src);
          reject(new Error("Couldn't load the reading tool - check your internet connection and try again."));
        };
        document.head.appendChild(el);
      })
    );
  }
  return scriptCache.get(src);
}

/* ---------- Reading pages into text ---------- */

async function imageToCanvas(file, extraScale = 1) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height)) * extraScale;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // No contrast filter: on real phone photos it made the OCR drop whole rows.
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// psm "3" = whole page (best for part rows); "6" = one block (best for the
// header's certificate number). Real photos read differently under each.
async function ocrCanvases(canvases, onProgress, psm = "3", label = "") {
  await loadScript(TESSERACT_SRC);
  let pageNo = 0;
  const worker = await window.Tesseract.createWorker("eng", 1, {
    logger: (m) => {
      if (m.status === "recognizing text" && onProgress) {
        onProgress(`Reading page ${pageNo} of ${canvases.length}${label}… ${Math.round((m.progress || 0) * 100)}%`);
      } else if (onProgress && pageNo === 0) {
        onProgress("Getting the reading tool ready (first time only)…");
      }
    }
  });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const out = [];
    for (const canvas of canvases) {
      pageNo += 1;
      const { data } = await worker.recognize(canvas);
      out.push(data.text || "");
    }
    return out;
  } finally {
    await worker.terminate();
  }
}

// Rebuilds readable lines from pdf.js text items (grouped by their y position).
function pdfItemsToText(items) {
  const rows = [];
  items.forEach((it) => {
    if (!it.str || !it.str.trim()) return;
    const y = Math.round(it.transform[5]);
    const row = rows.find((r) => Math.abs(r.y - y) <= 3);
    if (row) row.items.push(it);
    else rows.push({ y, items: [it] });
  });
  rows.sort((a, b) => b.y - a.y);
  return rows
    .map((r) =>
      r.items
        .sort((a, b) => a.transform[4] - b.transform[4])
        .map((i) => i.str.trim())
        .join("  ")
    )
    .join("\n");
}

async function readPdf(file, onProgress) {
  await loadScript(PDFJS_SRC);
  const pdfjs = window.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const texts = [];
  const scanned = []; // pages with no text layer, to OCR
  const pages = Math.min(pdf.numPages, MAX_PAGES);
  for (let n = 1; n <= pages; n++) {
    if (onProgress) onProgress(`Opening PDF page ${n} of ${pages}…`);
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const text = pdfItemsToText(content.items);
    if (text.replace(/\s/g, "").length > 40) {
      texts.push(text);
    } else {
      const viewport = page.getViewport({ scale: 2.2 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      scanned.push(canvas);
    }
  }
  if (scanned.length) texts.push(...(await ocrCanvases(scanned, onProgress)));
  return texts;
}

/* ---------- Turning text into CoC fields ---------- */

function hasDigit(s) {
  return /\d/.test(s || "");
}

function cleanToken(s) {
  return (s || "").replace(/^[\s.:\-#]+|[\s.,;:]+$/g, "");
}

function findCocNumber(text) {
  const patterns = [
    // "Certificate of Conformity" heading with the number on the next line
    // (as on Shropshire's delivery note), allowing a stray OCR line between.
    /conformity[\s\S]{0,60}?\b(\d{1,2}-\d{5,7})\b/gi,
    /\bDSP[-\s](\d{1,2}-\d{5,7})\b/gi,
    /(?:certificate|cert\.?|c\.?o\.?c\.?|coc)\s*(?:of\s+conformity\s*|of\s+conformance\s*)?(?:no\.?|number|num\.?|ref(?:erence)?\.?|#)\s*[:.\-]?\s*([A-Z0-9][A-Z0-9\-\/]{3,})/gi,
    /(?:certificate|cert\.?|coc)[^\n]{0,30}?\b(\d[\d\-\/]{3,})/gi
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) {
      const token = cleanToken(m[1]);
      if (hasDigit(token)) return token;
    }
  }
  return "";
}

function findSupplier(lines, knownSuppliers) {
  const lower = lines.join("\n").toLowerCase();
  const known = (knownSuppliers || []).find((s) => s.name && lower.includes(s.name.toLowerCase()));
  if (known) return known.name;
  // Logos often OCR as only part of the name, so also accept a supplier whose
  // distinctive first word (5+ letters, e.g. "Shropshire") is on the page.
  const byFirstWord = (knownSuppliers || []).filter((s) => {
    const w = (s.name || "").split(/\s+/)[0].toLowerCase();
    return w.length >= 5 && lower.includes(w);
  });
  if (byFirstWord.length === 1) return byFirstWord[0].name;
  // Our own company appears as the delivery address - never the supplier.
  const companyLine = lines
    .slice(0, 15)
    .find((l) => /\b(ltd|limited|inc|llc|gmbh|plc|s\.?a\.?|b\.?v\.?|co\.|corporation|metals?)\b/i.test(l) && l.length < 80 && !/dexory/i.test(l));
  return companyLine ? companyLine.replace(/[^\w &.,'()\-]/g, "").trim() : "";
}

// A quantity with a unit on it ("4 Pcs", "2Pcs", "8 off", "Qty: 12").
function findUnitQty(line) {
  const m = line.match(/(?<![\d.,])(\d{1,6})\s*(?:pcs?|pieces|off)\b/i) || line.match(/\b(?:qty|quantity)\s*[:.\-]?\s*(\d{1,6})\b/i);
  return m ? Number(m[1]) : 0;
}

// Last plain whole number on the part's own line - only a fallback for
// certificates that print the quantity with no unit.
function findLooseQty(line) {
  const text = line.replace(/\bDEX[\s\-]?[0-9O]{6,}/gi, " ").replace(/\b(rev|issue|iss|r)\.?\s*[:\-]?\s*\d+\b/gi, " ");
  const ints = (text.match(/(?<![\d.,\-])\d{1,6}(?![\d.,\-]\d)/g) || []).map(Number).filter((n) => n > 0);
  return ints.length ? ints[ints.length - 1] : 0;
}

function editDistance1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

export function parseCocText(rawText, knownSuppliers, knownParts) {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const parts = []; // { partNo, lineIdx, qty }
  lines.forEach((line, i) => {
    const re = /\bDEX[\s\-]?([0-9O]{6,})/gi;
    let m;
    while ((m = re.exec(line))) {
      // Never silently swapped for a similar stock part: a mismatch is shown
      // to the user by the form instead (it may be a genuine new part).
      const partNo = "DEX" + m[1].replace(/O/gi, "0");
      const qty = findUnitQty(line);
      parts.push({ partNo, lineIdx: i, qty, unitLine: qty ? i : -1, batches: [] });
    }
  });

  // On many delivery notes the quantity sits in its own column, so it isn't on
  // the part's line. Pair every "N Pcs" with the part rows in reading order.
  const unitQtys = [];
  lines.forEach((line, i) => {
    const q = findUnitQty(line);
    if (q) unitQtys.push({ lineIdx: i, qty: q });
  });
  const needQty = parts.filter((p) => !p.qty);
  if (needQty.length) {
    const used = new Set(parts.filter((p) => p.qty).map((p) => p.lineIdx));
    const free = unitQtys.filter((u) => !used.has(u.lineIdx));
    if (free.length === parts.length) {
      parts.forEach((p, k) => {
        if (!p.qty) {
          p.qty = free[k].qty;
          p.unitLine = free[k].lineIdx;
        }
      });
    } else {
      needQty.forEach((p) => {
        const nearest = free.filter((u) => !u.taken).sort((a, b) => Math.abs(a.lineIdx - p.lineIdx) - Math.abs(b.lineIdx - p.lineIdx))[0];
        if (nearest) {
          p.qty = nearest.qty;
          p.unitLine = nearest.lineIdx;
          nearest.taken = true;
        } else {
          p.qty = findLooseQty(lines[p.lineIdx]);
        }
      });
    }
  }

  // Batch / lot / heat numbers belong to the part line above them (or, if they
  // are printed in a header before any part, to the first part).
  const batchRe = /(?:batch|lot|heat|cast|charge)\s*(?:no\.?|number|#)?\s*[:.\-]?\s*([A-Z0-9][A-Z0-9\-\/]{2,})/gi;
  lines.forEach((line, i) => {
    let m;
    batchRe.lastIndex = 0;
    while ((m = batchRe.exec(line))) {
      const batchNo = cleanToken(m[1]);
      if (!hasDigit(batchNo) || /^dex/i.test(batchNo) || !parts.length) continue;
      const owner = [...parts].reverse().find((p) => p.lineIdx <= i) || parts[0];
      if (owner.batches.some((b) => b.batchNo === batchNo)) continue;
      const unitQty = line.match(/(\d{1,6})\s*(?:pcs?|pieces|off)\b/i);
      owner.batches.push({ batchNo, qty: unitQty ? Number(unitQty[1]) : "" });
    }
  });

  // One entry per part number; a part printed twice is one line.
  const byPart = new Map();
  parts.forEach((p) => {
    const have = byPart.get(p.partNo);
    if (have) {
      have.qty += p.qty;
      p.batches.forEach((b) => {
        if (!have.batches.some((x) => x.batchNo === b.batchNo)) have.batches.push(b);
      });
    } else {
      byPart.set(p.partNo, { partNo: p.partNo, qty: p.qty, batches: p.batches.slice() });
    }
  });
  const outLines = [...byPart.values()].map((l) => {
    if (l.batches.length === 1 && l.batches[0].qty === "") l.batches[0].qty = l.qty || "";
    return l;
  });

  // A quantity the OCR found but whose part number it couldn't read: keep it
  // as a line with the part left empty, to be typed in.
  unitQtys
    .filter((u) => !parts.some((p) => p.unitLine === u.lineIdx))
    .forEach((u) => outLines.push({ partNo: "", qty: u.qty, batches: [] }));

  return {
    supplierName: findSupplier(lines, knownSuppliers),
    cocNumber: findCocNumber(lines.join("\n")),
    lines: outLines
  };
}

/*
  files: images and/or PDFs, all pages of one CoC. Options:
    onProgress(message) - status text while reading
    knownSuppliers      - [{name, code}] so a known supplier is recognised
    knownParts          - stock part numbers, to correct a one-digit misread
  Throws with a message safe to show the user directly.
*/
export async function extractCocFromFiles(files, { onProgress, knownSuppliers, knownParts } = {}) {
  const list = Array.from(files || []);
  if (list.length === 0) throw new Error("Choose a photo or PDF first.");

  const pdfTexts = [];
  const images = [];
  // Photos are read three different ways (different layout mode and size);
  // OCR rarely makes the same digit mistake in all three, so a vote across
  // them catches a one-digit misread (e.g. 0197 read as 0187).
  const passTexts = [];
  try {
    for (const f of list) {
      if (f.type === "application/pdf" || /\.pdf$/i.test(f.name || "")) {
        pdfTexts.push(...(await readPdf(f, onProgress)));
      } else {
        images.push(f);
      }
    }
    if (images.length) {
      for (const [i, pass] of IMAGE_PASSES.entries()) {
        const canvases = [];
        for (const f of images) canvases.push(await imageToCanvas(f, pass.scale));
        const label = ` (look ${i + 1} of ${IMAGE_PASSES.length})`;
        passTexts.push((await ocrCanvases(canvases, onProgress, pass.psm, label)).join("\n"));
      }
    }
  } catch (err) {
    console.error("CoC reading failed:", err);
    throw new Error(err.message && /internet|reading tool/i.test(err.message) ? err.message : "Couldn't read that file - try a clearer photo, or enter the details manually below.");
  }

  const texts = passTexts.length ? passTexts.map((t) => [...pdfTexts, t].join("\n")) : [pdfTexts.join("\n")];
  const rawText = texts.length > 1 ? texts.map((t, i) => `--- look ${i + 1} ---\n${t}`).join("\n\n") : texts[0];
  if (texts.every((t) => t.replace(/\s/g, "").length < 20)) {
    throw new Error("Couldn't find any text on that page - try a clearer, well-lit photo, or enter the details manually below.");
  }

  const results = texts.map((t) => parseCocText(t, knownSuppliers, knownParts));
  const result = voteOnResults(results, knownParts);
  return { ...result, rawText };
}

// Merges the reads of one photo. The read that found the most part lines is
// the base; each of its part numbers is replaced by whichever near-identical
// spelling (within one character) most reads agree on.
export function voteOnResults(results, knownParts) {
  const base = results.reduce((best, r) => (r.lines.length > best.lines.length ? r : best), results[0]);
  const votes = new Map();
  results.forEach((r) => r.lines.forEach((l) => l.partNo && votes.set(l.partNo, (votes.get(l.partNo) || 0) + 1)));

  const lines = base.lines.map((l) => {
    if (!l.partNo) return l;
    const cluster = [...votes.keys()].filter((p) => editDistance1(p, l.partNo));
    cluster.sort((a, b) => votes.get(b) - votes.get(a) || Number((knownParts || []).includes(b)) - Number((knownParts || []).includes(a)));
    return { ...l, partNo: cluster[0] || l.partNo };
  });

  const first = (key) => results.map((r) => r[key]).find(Boolean) || "";
  return { supplierName: first("supplierName"), cocNumber: first("cocNumber"), lines };
}
