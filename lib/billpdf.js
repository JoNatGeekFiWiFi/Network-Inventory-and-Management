// Invoices and quotes as PDFs, using the same writer as signed agreements.
import { createPdf, wrapText, textWidth } from './pdf.js';

const M = { left: 54, right: 54 };
const PAGE_W = 612;
const WIDTH = PAGE_W - M.left - M.right;

const money = (n) => '$' + Number(n || 0).toFixed(2);

/**
 * A customer-facing invoice or quote.
 *
 * `kind` is 'Invoice' or 'Quote'. `lines` are {description, quantity, amount}.
 * Returns the PDF builder; call .build() for the bytes.
 */
export function renderStatement({
  kind = 'Invoice', number = '', company = {}, customer = '', email = '',
  date = '', due = '', lines = [], subtotal = null, taxRate = 0, tax = 0, total = 0, balance = null,
  notes = '', terms = '', payUrl = ''
} = {}) {
  const pdf = createPdf({ title: `${kind} ${number}`, author: company.name || '' });
  let top = 52;

  pdf.text(company.name || kind, { x: M.left, top, font: 'Helvetica-Bold', size: 14 });
  const head = kind.toUpperCase();
  pdf.text(head, { x: PAGE_W - M.right - textWidth(head, 'Helvetica-Bold', 14), top, font: 'Helvetica-Bold', size: 14 });
  top += 16;
  const contact = [company.address, [company.phone, company.email].filter(Boolean).join(' · ')].filter(Boolean);
  for (const line of contact) {
    pdf.text(line, { x: M.left, top, size: 9, colour: [0.35, 0.35, 0.35] });
    top += 12;
  }
  top += 8;
  pdf.line(M.left, top, PAGE_W - M.right, top, { colour: [0.2, 0.2, 0.2], width: 1.25 });
  top += 22;

  pdf.text(number, { x: M.left, top, font: 'Helvetica-Bold', size: 16 });
  top += 20;
  const meta = [
    ['Bill to', customer || '—'],
    ['Email', email || '—'],
    ['Date', date || '—'],
    [kind === 'Quote' ? 'Valid until' : 'Due', due || '—']
  ];
  for (const [label, value] of meta) {
    pdf.text(label, { x: M.left, top, font: 'Helvetica-Bold', size: 9, colour: [0.35, 0.35, 0.35] });
    pdf.text(String(value), { x: M.left + 88, top, size: 10 });
    top += 14;
  }
  top += 10;

  const rows = lines.map(it => [it.description || '', String(it.quantity ?? ''), money(it.amount)]);
  top = pdf.table(rows, {
    x: M.left, top, width: WIDTH,
    columns: [
      { label: 'Description', weight: 6 },
      { label: 'Qty', weight: 1.2, align: 'center' },
      { label: 'Amount', weight: 2, align: 'right' }
    ],
    bottom: 700
  });
  top += 8;

  const sub = subtotal != null ? subtotal : lines.reduce((s, it) => s + Number(it.amount || 0), 0);
  const totals = [['Subtotal', money(sub)]];
  if (Number(tax) > 0) totals.push([`Tax (${taxRate}%)`, money(tax)]);
  totals.push(['Total', money(total)]);
  if (balance != null && kind === 'Invoice') totals.push(['Balance due', money(balance)]);
  for (const [label, value] of totals) {
    const bold = label === 'Total' || label === 'Balance due';
    pdf.text(label, { x: PAGE_W - M.right - 160, top, font: bold ? 'Helvetica-Bold' : 'Helvetica', size: 10 });
    const vw = textWidth(value, bold ? 'Helvetica-Bold' : 'Helvetica', 10);
    pdf.text(value, { x: PAGE_W - M.right - vw, top, font: bold ? 'Helvetica-Bold' : 'Helvetica', size: 10 });
    top += 15;
  }

  if (payUrl) {
    top += 8;
    pdf.text(kind === 'Invoice' ? 'Pay online' : 'Respond online', { x: M.left, top, font: 'Helvetica-Bold', size: 9 });
    top += 13;
    for (const line of wrapText(payUrl, WIDTH, 'Helvetica', 9)) {
      pdf.text(line, { x: M.left, top, size: 9, colour: [0.1, 0.25, 0.55] });
      top += 12;
    }
  }
  if (notes) {
    top += 10;
    pdf.text('Notes', { x: M.left, top, font: 'Helvetica-Bold', size: 9 });
    top += 13;
    for (const line of wrapText(notes, WIDTH, 'Helvetica', 9)) {
      if (top > 730) { pdf.addPage(); top = 56; }
      if (line) pdf.text(line, { x: M.left, top, size: 9 });
      top += 12;
    }
  }
  if (terms) {
    top += 10;
    pdf.text('Terms', { x: M.left, top, font: 'Helvetica-Bold', size: 9 });
    top += 13;
    for (const line of wrapText(terms, WIDTH, 'Helvetica', 9)) {
      if (top > 730) { pdf.addPage(); top = 56; }
      if (line) pdf.text(line, { x: M.left, top, size: 9, colour: [0.3, 0.3, 0.3] });
      top += 12;
    }
  }

  pdf.decorate((index, count) => {
    const y = 768;
    const page = `Page ${index + 1} of ${count}`;
    pdf.text(page, { x: PAGE_W - M.right - textWidth(page, 'Helvetica', 8), top: y, size: 8, colour: [0.45, 0.45, 0.45] });
    pdf.text(`${company.name || ''} · ${kind} ${number}`, { x: M.left, top: y, size: 8, colour: [0.45, 0.45, 0.45] });
  });
  return pdf;
}
