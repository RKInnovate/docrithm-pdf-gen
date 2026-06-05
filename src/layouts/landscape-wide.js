/**
 * Layout: Landscape Wide.
 *
 * # Purpose
 * An A4 LANDSCAPE document with a wide, multi-column line-item table —
 * the format used when an invoice carries many tax/quantity columns
 * that don't fit a portrait page (separate Taxable / CGST / SGST / IGST
 * amount columns printed inline per line, not just a trailing summary).
 * Drives layout #5 of the pluggable system. Exercises DocRithm's
 * extraction against landscape orientation and a wide per-line tax grid.
 *
 * # Layout interface
 * Exports the full shared layout interface (see clean-modern.js). Money
 * goes through shared `format.js` helpers.
 *
 * # Design decisions (this layout)
 * - `pageSize: 'A4'` + `pageOrientation: 'landscape'`. Printable width
 *   is 842 − 36 − 36 = 770 pt; the header rule / footer line use 770.
 * - The line-item table carries per-line tax columns (Taxable + the
 *   CGST/SGST or IGST amount) in addition to the trailing HSN summary —
 *   the extra width is the whole point of going landscape.
 */

import {
  formatDate,
  formatDateTime,
  formatCurrency,
  amountInWords,
  signatoryFor,
  DISCLAIMER,
} from '../format.js';

export { formatDate, formatDateTime };

// Printable width in landscape A4 with 36pt side margins.
const RULE_W = 770;

/** @returns {Record<string, object>} */
export function commonStyles() {
  return {
    docTitle: { fontSize: 18, bold: true },
    vendorName: { fontSize: 14, bold: true },
    addressLine: { fontSize: 8, color: '#444444' },
    sectionLabel: { fontSize: 8, bold: true, color: '#888888', characterSpacing: 0.5 },
    partyName: { fontSize: 10, bold: true },
    fieldLabel: { fontSize: 8, color: '#666666' },
    fieldValue: { fontSize: 9, color: '#222222' },
    tableHeader: { fontSize: 8, bold: true, color: 'white' },
    cell: { fontSize: 8, color: '#222222' },
    cellRight: { fontSize: 8, color: '#222222', alignment: 'right' },
    totalsLabel: { fontSize: 9, color: '#444444', alignment: 'right' },
    totalsValue: { fontSize: 9, color: '#222222', alignment: 'right' },
    grandLabel: { fontSize: 11, bold: true, color: 'white', alignment: 'right' },
    grandValue: { fontSize: 11, bold: true, color: 'white', alignment: 'right' },
    wordsLine: { fontSize: 9, italics: true, color: '#333333' },
    h2: { fontSize: 10, bold: true },
    signatureName: { fontSize: 9, bold: true },
    signatureMeta: { fontSize: 8, color: '#555555' },
    disclaimer: { fontSize: 7, italics: true, color: '#888888' },
    footerSmall: { fontSize: 7, color: '#888888' },
  };
}

/** @returns {object} */
export function defaultPageDefinition() {
  return {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [36, 96, 36, 50],
    defaultStyle: { font: 'Roboto', fontSize: 8.5, lineHeight: 1.12, color: '#222222' },
  };
}

/**
 * @param {object} order
 * @returns {string}
 */
function docTitleText(order) {
  return order.docType === 'invoice' ? 'TAX INVOICE' : 'PURCHASE ORDER';
}

/**
 * @param {object} order
 * @returns {object}
 */
export function headerBlock(order) {
  const v = order.vendor;
  const accent = v.accentColor;
  return {
    margin: [0, 0, 0, 4],
    stack: [
      {
        columns: [
          {
            width: 42,
            table: { widths: [38], heights: [38], body: [[{ text: v.logoMonogram, color: 'white', bold: true, fontSize: 15, alignment: 'center', margin: [0, 8, 0, 0], fillColor: accent, border: [false, false, false, false] }]] },
            layout: 'noBorders',
          },
          {
            width: '*',
            margin: [10, 0, 0, 0],
            stack: [
              { text: v.name, style: 'vendorName', color: accent },
              { text: `${v.addressLines[0] ?? ''}, ${v.addressLines[1] ?? ''}`, style: 'addressLine' },
              { text: `GSTIN: ${v.gstin}   State: ${v.state} (${v.stateCode})   ${v.phone}`, style: 'addressLine' },
            ],
          },
          { width: 'auto', text: docTitleText(order), style: 'docTitle', color: accent, alignment: 'right' },
        ],
      },
      { margin: [0, 5, 0, 0], canvas: [{ type: 'line', x1: 0, y1: 0, x2: RULE_W, y2: 0, lineWidth: 1.5, lineColor: accent }] },
    ],
  };
}

/**
 * @param {object} order
 * @returns {object}
 */
export function metaBlock(order) {
  const docLabel = order.docType === 'invoice' ? 'Invoice No' : 'PO No';
  const dateLabel = order.docType === 'invoice' ? 'Invoice Date' : 'Order Date';
  const rows = [[docLabel, order.docId]];
  if (!order.suppressOrderDate) rows.push([dateLabel, formatDate(order.orderDate)]);
  if (order.docType === 'invoice' && order.poNumber) rows.push(['Buyer PO Ref', order.poNumber]);
  rows.push([order.docType === 'invoice' ? 'Due Date' : 'Expected By', formatDate(order.dueDate)]);
  rows.push(['Payment Terms', `Net ${order.termDays}`]);
  rows.push(['Tax Type', order.taxType]);
  return {
    margin: [0, 5, 0, 4],
    columns: rows.map(([k, val]) => ({ width: '*', stack: [{ text: k, style: 'fieldLabel' }, { text: val, style: 'fieldValue', bold: true }] })),
  };
}

/**
 * @param {object} order
 * @returns {object}
 */
export function partiesBlock(order) {
  const v = order.vendor;
  const b = order.buyer;
  const card = (title, party) => ({
    stack: [
      { text: title, style: 'sectionLabel', margin: [0, 0, 0, 3] },
      { text: party.name, style: 'partyName' },
      { text: `${party.addressLines[0] ?? ''}, ${party.addressLines[1] ?? ''}`, style: 'addressLine' },
      { text: `GSTIN: ${party.gstin}   State: ${party.state} (${party.stateCode})`, style: 'addressLine' },
    ],
  });
  return {
    margin: [0, 2, 0, 5],
    columns: [
      { width: '*', ...card(order.docType === 'invoice' ? 'Seller / Supplier' : 'Vendor / Supplier', v) },
      { width: '*', ...card('Bill To / Ship To', b) },
    ],
  };
}

/**
 * Wide line-item table with per-line tax columns — the landscape payoff.
 * @param {object} order
 * @returns {object}
 */
export function lineItemsTable(order) {
  const accent = order.vendor.accentColor;
  const sym = order.currency.symbol;
  const intra = order.intraState;
  const subtotal = order.totals.subtotal;
  const discount = order.totals.discount;

  const th = (label, align = 'left') => ({ text: label, style: 'tableHeader', fillColor: accent, alignment: align, margin: [3, 3, 3, 3] });
  const header = intra
    ? [th('#'), th('Description'), th('HSN'), th('Qty'), th('Rate', 'right'), th('Amount', 'right'), th('Taxable', 'right'), th('GST%', 'center'), th('CGST', 'right'), th('SGST', 'right'), th('Line Total', 'right')]
    : [th('#'), th('Description'), th('HSN'), th('Qty'), th('Rate', 'right'), th('Amount', 'right'), th('Taxable', 'right'), th('IGST%', 'center'), th('IGST', 'right'), th('Line Total', 'right')];
  const body = [header];

  order.lines.forEach((line, idx) => {
    const stripe = idx % 2 === 1 ? '#F5F5F5' : null;
    // Pro-rata discount share so each printed line's taxable + tax
    // reconcile with the document totals (guard zero subtotal).
    const share = subtotal > 0 ? line.amount / subtotal : 0;
    const lineDiscount = Math.round(discount * share * 100) / 100;
    const lineTaxable = Math.round((line.amount - lineDiscount) * 100) / 100;
    const c = (txt, align, style = 'cell') => ({ text: txt, style, alignment: align, fillColor: stripe, margin: [3, 2, 3, 2] });
    if (intra) {
      const cgst = Math.round((lineTaxable * (line.gstSlab / 2)) / 100 * 100) / 100;
      const sgst = cgst;
      const lineTotal = Math.round((lineTaxable + cgst + sgst) * 100) / 100;
      body.push([
        c(String(idx + 1), 'left'), c(line.description, 'left'), c(line.hsn, 'left'), c(`${line.qty} ${line.unit}`, 'left'),
        c(formatCurrency(line.unitPrice, sym), 'right'), c(formatCurrency(line.amount, sym), 'right'), c(formatCurrency(lineTaxable, sym), 'right'),
        c(`${line.gstSlab}%`, 'center'), c(formatCurrency(cgst, sym), 'right'), c(formatCurrency(sgst, sym), 'right'), c(formatCurrency(lineTotal, sym), 'right'),
      ]);
    } else {
      const igst = Math.round((lineTaxable * line.gstSlab) / 100 * 100) / 100;
      const lineTotal = Math.round((lineTaxable + igst) * 100) / 100;
      body.push([
        c(String(idx + 1), 'left'), c(line.description, 'left'), c(line.hsn, 'left'), c(`${line.qty} ${line.unit}`, 'left'),
        c(formatCurrency(line.unitPrice, sym), 'right'), c(formatCurrency(line.amount, sym), 'right'), c(formatCurrency(lineTaxable, sym), 'right'),
        c(`${line.gstSlab}%`, 'center'), c(formatCurrency(igst, sym), 'right'), c(formatCurrency(lineTotal, sym), 'right'),
      ]);
    }
  });

  const widths = intra
    ? [14, '*', 40, 42, 'auto', 'auto', 'auto', 26, 'auto', 'auto', 'auto']
    : [14, '*', 40, 42, 'auto', 'auto', 'auto', 30, 'auto', 'auto'];

  return {
    margin: [0, 2, 0, 5],
    table: { headerRows: 1, widths, body },
    layout: 'lightHorizontalLines',
  };
}

/**
 * @param {object} order
 * @returns {object}
 */
export function taxSummary(order) {
  const accent = order.vendor.accentColor;
  const sym = order.currency.symbol;
  const intra = order.intraState;
  const th = (label, align = 'right') => ({ text: label, style: 'tableHeader', fillColor: accent, alignment: align, margin: [4, 3, 4, 3] });
  const header = intra
    ? [th('HSN/SAC', 'left'), th('Taxable'), th('CGST%', 'center'), th('CGST'), th('SGST%', 'center'), th('SGST'), th('Total Tax')]
    : [th('HSN/SAC', 'left'), th('Taxable'), th('IGST%', 'center'), th('IGST'), th('Total Tax')];
  const body = [header];
  for (const g of order.hsnSummary) {
    const c = (txt, align = 'right') => ({ text: txt, style: 'cell', alignment: align, margin: [4, 2, 4, 2] });
    body.push(intra
      ? [c(g.hsn, 'left'), c(formatCurrency(g.taxable, sym)), c(`${g.cgstRate}%`, 'center'), c(formatCurrency(g.cgst, sym)), c(`${g.sgstRate}%`, 'center'), c(formatCurrency(g.sgst, sym)), c(formatCurrency(g.totalTax, sym))]
      : [c(g.hsn, 'left'), c(formatCurrency(g.taxable, sym)), c(`${g.igstRate}%`, 'center'), c(formatCurrency(g.igst, sym)), c(formatCurrency(g.totalTax, sym))]);
  }
  return {
    margin: [0, 2, 0, 5],
    columns: [
      {
        width: 'auto',
        stack: [
          { text: 'HSN / SAC-wise Tax Summary', style: 'h2', margin: [0, 2, 0, 3] },
          { table: { headerRows: 1, widths: intra ? ['auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto'] : ['auto', 'auto', 'auto', 'auto', 'auto'], body }, layout: 'lightHorizontalLines' },
        ],
      },
      { width: '*', text: '' },
    ],
  };
}

/**
 * @param {object} order
 * @returns {object}
 */
export function totalsBlock(order) {
  const accent = order.vendor.accentColor;
  const sym = order.currency.symbol;
  const t = order.totals;
  const row = (label, value, grand = false) => [
    { text: label, style: grand ? 'grandLabel' : 'totalsLabel', fillColor: grand ? accent : null, margin: [6, 3, 6, 3], border: [false, false, false, false] },
    { text: value, style: grand ? 'grandValue' : 'totalsValue', fillColor: grand ? accent : null, margin: [6, 3, 6, 3], border: [false, false, false, false] },
  ];
  const rows = [row('Subtotal', formatCurrency(t.subtotal, sym))];
  if (t.discount > 0) rows.push(row(`Discount (${t.discountPct}%)`, `- ${formatCurrency(t.discount, sym)}`));
  rows.push(row('Taxable Value', formatCurrency(t.taxableTotal, sym)));
  if (order.intraState) { rows.push(row('CGST', formatCurrency(t.cgst, sym))); rows.push(row('SGST', formatCurrency(t.sgst, sym))); }
  else rows.push(row('IGST', formatCurrency(t.igst, sym)));
  if (t.roundOff !== 0) rows.push(row('Round Off', formatCurrency(t.roundOff, sym)));
  rows.push(row('GRAND TOTAL', formatCurrency(t.grandTotal, sym), true));
  return {
    margin: [0, 2, 0, 4],
    columns: [
      { width: '*', text: '' },
      { width: 'auto', table: { widths: ['auto', 'auto'], body: rows }, layout: 'noBorders' },
    ],
  };
}

/**
 * @param {object} order
 * @returns {object}
 */
export function amountWordsLine(order) {
  return { margin: [0, 2, 0, 5], text: `Amount in words: ${amountInWords(order.totals.grandTotal)}`, style: 'wordsLine' };
}

/**
 * @param {object} order
 * @returns {object}
 */
export function signatureBlock(order) {
  const sig = signatoryFor(order.docId);
  return {
    margin: [0, 10, 0, 0],
    stack: [
      {
        alignment: 'right',
        stack: [
          { text: `For ${order.vendor.name}`, style: 'signatureMeta', margin: [0, 0, 0, 22] },
          { text: '_____________________________', color: '#888888' },
          { text: sig.name, style: 'signatureName' },
          { text: sig.designation, style: 'signatureMeta' },
        ],
      },
      { margin: [0, 10, 0, 0], text: DISCLAIMER, style: 'disclaimer' },
    ],
  };
}

/**
 * @param {object} order
 * @returns {(currentPage:number, pageCount:number) => object}
 */
export function pageFooter(order) {
  return (currentPage, pageCount) => ({
    margin: [36, 8, 36, 0],
    stack: [
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: RULE_W, y2: 0, lineWidth: 0.5, lineColor: '#CCCCCC' }] },
      {
        margin: [0, 4, 0, 0],
        columns: [
          { width: 'auto', text: `Page ${currentPage} of ${pageCount}`, style: 'footerSmall' },
          { width: '*', text: `${order.docId} — ${order.vendor.gstin}`, style: 'footerSmall', alignment: 'center' },
          { width: 'auto', text: 'Synthetic — not a real document', style: 'footerSmall', alignment: 'right' },
        ],
      },
    ],
  });
}
