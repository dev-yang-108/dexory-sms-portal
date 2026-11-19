/* Builds an IDN (internal delivery note) as a PDF in the browser (jsPDF, loaded
   from index.html) so it can be filed in Drive. Mirrors the on-screen note:
   DEXORY header, reference boxes, date and the part row. A voided IDN is
   stamped VOIDED. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");

function fmt(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// The built-in PDF font only covers Latin-1.
const clean = (s) => String(s === null || s === undefined ? "" : s).replace(/[^\x20-\xFF]/g, "?");

const NAVY = [11, 26, 72];
const MUTED = [90, 107, 130];
const RED = [180, 35, 24];

export function downloadIdnPdf(idn) {
  const JsPdf = window.jspdf && window.jspdf.jsPDF;
  if (!JsPdf) return false;

  const doc = new JsPdf({ unit: "mm", format: "a4" });
  const M = 14;
  const RIGHT = 210 - M;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.setTextColor(...NAVY);
  doc.text("DEXORY", M, 24);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...MUTED);
  ["Unit 4 Verda Park", "Wallingford", "OX10"].forEach((line, i) => doc.text(line, M, 31 + i * 5));

  // Reference boxes, top right.
  const refs = [idn.refNo ? `Ref No. ${idn.refNo}` : "", idn.po || "", idn.vms ? `VMS-${idn.vms}` : "", idn.initials || ""].filter(Boolean);
  let by = 16;
  doc.setTextColor(...NAVY);
  doc.setFontSize(10);
  refs.forEach((r) => {
    doc.setDrawColor(...NAVY);
    doc.rect(RIGHT - 60, by, 60, 8);
    doc.text(clean(r), RIGHT - 57, by + 5.5);
    by += 10;
  });

  let y = Math.max(52, by + 6);
  doc.setFontSize(11);
  doc.text(clean(`Date: ${fmt(idn.date)}`), M, y);
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text(clean(`${idn.idnNo}  |  Work order ${idn.woNo}`), RIGHT, y, { align: "right" });

  y += 10;
  const cols = [
    { label: "Part Number", x: M, w: 62 },
    { label: "Qty", x: M + 62, w: 22 },
    { label: "Rev", x: M + 84, w: 22 },
    { label: "Comment", x: M + 106, w: RIGHT - (M + 106) }
  ];
  doc.setFillColor(...NAVY);
  doc.rect(M, y, RIGHT - M, 8, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(255, 255, 255);
  cols.forEach((c) => doc.text(c.label, c.x + 2, y + 5.5));
  y += 8;

  doc.setFont("helvetica", "normal");
  doc.setTextColor(...NAVY);
  const row = [idn.partNo, idn.qty, idn.rev, idn.comment || ""];
  const wrapped = cols.map((c, i) => doc.splitTextToSize(clean(row[i]), c.w - 4));
  const h = Math.max(8, ...wrapped.map((w) => w.length * 5 + 3));
  doc.setDrawColor(200, 205, 215);
  doc.rect(M, y, RIGHT - M, h);
  cols.forEach((c, i) => doc.text(wrapped[i], c.x + 2, y + 5.5));
  y += h + 12;

  if (idn.voided) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(30);
    doc.setTextColor(...RED);
    doc.text("VOIDED", 105, y + 10, { align: "center", angle: 0 });
    doc.setFontSize(10);
    doc.text(clean(idn.voidedAt ? fmt(idn.voidedAt) : ""), 105, y + 18, { align: "center" });
  }

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text(clean(`Dexory SMS portal  |  ${idn.idnNo}`), M, 290);

  doc.save(`${idn.idnNo}${idn.voided ? "-voided" : ""}.pdf`);
  return true;
}
