/* Builds a route card's PDF in the browser (jsPDF, loaded from index.html)
   and downloads it: the covered orders, every operation of the latest
   attempt with initials and times, the spot checks and the quality review.
   Until quality signs the card off it is marked as a draft. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");

// Built by hand rather than toLocaleString(): some locales put a narrow
// no-break space before AM/PM, which the PDF's built-in font can't draw.
function fmt(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// The built-in PDF font only covers Latin-1.
const clean = (s) => String(s === null || s === undefined ? "" : s).replace(/[^\x20-\xFF]/g, "?");

function initialsOf(name) {
  return String(name || "")
    .replace(/[^A-Za-z ]/g, "")
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

const NAVY = [11, 26, 72];
const MUTED = [90, 107, 130];
const RED = [180, 35, 24];
const GREEN = [31, 122, 77];
const AMBER = [138, 90, 0];

const RESULT_LABEL = { pass: "Pass", rework: "Rework", fail: "Fail" };
const RESULT_COLOR = { pass: GREEN, rework: AMBER, fail: RED };
const DISPOSITION_LABEL = {
  scrap: "Scrapped, logged as a reject",
  rework: "Reworked, re-checked in the next attempt",
  accept: "Accepted with a note"
};

export function downloadRouteCardPdf(wo, orders) {
  const JsPdf = window.jspdf && window.jspdf.jsPDF;
  if (!JsPdf) return false;

  const doc = new JsPdf({ unit: "mm", format: "a4" });
  const W = 210;
  const M = 14;
  const RIGHT = W - M;
  const LIMIT = 280;
  let y = 0;

  const firstOff = wo.firstOff;
  const attempt = firstOff.attempts[firstOff.attempts.length - 1];
  const quality = firstOff.quality;
  const signed = !!quality && quality.status === "signed";
  const covered = (orders || []).filter((o) => (firstOff.covers || []).includes(o.woNo));
  const allCovered = [wo, ...covered];
  const totalQty = allCovered.reduce((sum, o) => sum + (o.qty || 0), 0);

  const newPageIfNeeded = (height) => {
    if (y + height > LIMIT) {
      doc.addPage();
      y = M;
    }
  };

  const write = (str, x, size, bold, color, opts) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(...(color || NAVY));
    doc.text(clean(str), x, y, opts);
  };

  const heading = (str) => {
    newPageIfNeeded(14);
    y += 5;
    write(str, M, 11, true);
    y += 2;
    doc.setDrawColor(211, 221, 235);
    doc.line(M, y, RIGHT, y);
    y += 5;
  };

  const note = (str) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    const lines = doc.splitTextToSize(clean(str), RIGHT - M);
    newPageIfNeeded(lines.length * 4 + 1);
    doc.text(lines, M, y);
    y += lines.length * 4 + 1;
  };

  // cols: [{ label, w }]; rows: arrays of strings or { text, color, bold }.
  const table = (cols, rows, withHeader = true) => {
    const drawRow = (cells, header) => {
      const lines = cells.map((cell, i) => {
        const text = typeof cell === "object" && cell !== null ? cell.text : cell;
        doc.setFont("helvetica", header || (cell && cell.bold) ? "bold" : "normal");
        doc.setFontSize(8.5);
        return doc.splitTextToSize(clean(text), cols[i].w - 3);
      });
      const height = Math.max(...lines.map((l) => l.length)) * 3.9 + 3;
      newPageIfNeeded(height);
      if (header) {
        doc.setFillColor(233, 240, 249);
        doc.rect(M, y, RIGHT - M, height, "F");
      }
      let x = M;
      cells.forEach((cell, i) => {
        const color = header ? NAVY : (cell && cell.color) || NAVY;
        doc.setFont("helvetica", header || (cell && cell.bold) ? "bold" : "normal");
        doc.setFontSize(8.5);
        doc.setTextColor(...color);
        doc.text(lines[i], x + 1.5, y + 4.2);
        x += cols[i].w;
      });
      y += height;
      doc.setDrawColor(211, 221, 235);
      doc.line(M, y, RIGHT, y);
    };
    if (withHeader) drawRow(cols.map((c) => c.label), true);
    rows.forEach((r) => drawRow(r, false));
    y += 2;
  };

  // Header band
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, W, 26, "F");
  y = 12;
  write("Dexory", M, 20, true, [255, 255, 255]);
  y = 19;
  write("SMS portal  |  Route card and first-off inspection", M, 9, false, [196, 208, 232]);
  y = 12;
  const banner = signed
    ? "SIGNED OFF"
    : quality && quality.status === "sent-back"
      ? "SENT BACK"
      : "DRAFT - awaiting quality sign-off";
  write(banner, RIGHT, 11, true, signed ? [203, 254, 52] : [255, 255, 255], { align: "right" });
  y = 19;
  write(`Generated ${fmt(Date.now())}`, RIGHT, 8.5, false, [196, 208, 232], { align: "right" });

  y = 36;
  table(
    [{ w: 32 }, { w: 55 }, { w: 32 }, { w: 63 }],
    [
      [{ text: "Work order", color: MUTED }, { text: wo.woNo, bold: true }, { text: "Part number", color: MUTED }, { text: wo.partNo, bold: true }],
      [{ text: "Revision", color: MUTED }, `R${wo.rev}`, { text: "Part name", color: MUTED }, wo.partName || ""],
      [{ text: "Qty covered", color: MUTED }, `${totalQty} pcs`, { text: "Attempt", color: MUTED }, `${attempt.n} of ${firstOff.attempts.length}`],
      [{ text: "First-off checks", color: MUTED }, "1 piece", { text: "Started", color: MUTED }, fmt(attempt.startedAt)]
    ],
    false
  );

  heading("Work orders and batches covered");
  table(
    [{ label: "Work order", w: 50 }, { label: "Batch", w: 90 }, { label: "Qty", w: 42 }],
    allCovered.map((o) => [o.woNo, o.batchNo || "-", `${o.qty} pcs`])
  );

  heading(`Operations (attempt ${attempt.n})`);
  table(
    [
      { label: "Op", w: 12 },
      { label: "Machine", w: 30 },
      { label: "Operated by", w: 30 },
      { label: "2nd check by", w: 30 },
      { label: "Result", w: 20 },
      { label: "Notes", w: 60 }
    ],
    attempt.ops.map((op, i) => {
      const notes = [
        op.disposition && DISPOSITION_LABEL[op.disposition],
        op.comment,
        op.file ? `Attachment: ${op.file.name} (${op.file.url})` : ""
      ]
        .filter(Boolean)
        .join(". ");
      return [
        `OP${i + 1}`,
        op.machine || "-",
        op.operatedBy ? `${initialsOf(op.operatedBy)} ${op.operatedBy}\n${fmt(op.operatedAt)}` : "-",
        op.checkedBy ? `${initialsOf(op.checkedBy)} ${op.checkedBy}\n${fmt(op.checkedAt)}` : "-",
        { text: RESULT_LABEL[op.result] || "-", color: RESULT_COLOR[op.result] || NAVY, bold: true },
        notes || "-"
      ];
    })
  );

  if (firstOff.attempts.length > 1) {
    note(
      "Earlier attempts: " +
        firstOff.attempts
          .slice(0, -1)
          .map((a) => {
            const results = (a.ops || []).map((o) => o.result);
            const outcome = results.includes("fail") ? "Failed" : results.includes("rework") ? "Rework" : "Passed";
            return `Attempt ${a.n} ${outcome} (${fmt(a.startedAt)})`;
          })
          .join("; ")
    );
  }

  heading("Spot checks during the run");
  const spots = firstOff.spots || [];
  if (spots.length === 0) {
    note("No spot checks were recorded.");
  } else {
    table(
      [
        { label: "When", w: 34 },
        { label: "Work order / batch", w: 40 },
        { label: "Pcs", w: 14 },
        { label: "Result", w: 20 },
        { label: "By", w: 24 },
        { label: "Note", w: 50 }
      ],
      spots.map((s) => [
        fmt(s.at),
        s.woNo ? `${s.woNo}${s.batch ? " " + s.batch : ""}` : s.batch || "-",
        String(s.pieces),
        { text: s.result === "pass" ? "Pass" : "Fail", color: s.result === "pass" ? GREEN : RED, bold: true },
        `${initialsOf(s.by)} ${s.by || ""}`,
        s.note || ""
      ])
    );
  }

  heading("Quality review");
  if (signed) {
    note(`Signed off by ${quality.by} on ${fmt(quality.at)}.${quality.note ? " Note: " + quality.note : ""}`);
  } else if (quality && quality.status === "sent-back") {
    note(`Sent back by ${quality.by} on ${fmt(quality.at)}. Note: ${quality.note}`);
  } else {
    note("Not yet reviewed by quality. This PDF is a draft.");
  }
  // Mid-way checks by quality before the final sign-off.
  (firstOff.crossChecks || []).forEach((c) => {
    note(`Cross-check by ${c.by} on ${fmt(c.at)}, after ${c.afterOps} operation${c.afterOps === 1 ? "" : "s"}.${c.note ? " Note: " + c.note : ""}`);
  });

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p += 1) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(clean(`Dexory SMS portal  |  ${wo.woNo}  |  Page ${p} of ${pages}`), M, 290);
  }

  doc.save(`${wo.woNo}-route-card${signed ? "" : "-draft"}.pdf`);
  return true;
}
