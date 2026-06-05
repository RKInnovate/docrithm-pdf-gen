/**
 * Layout: Compact Dense.
 *
 * # Purpose
 * A tightly-packed, low-margin document that crams the maximum content
 * onto each page — small fonts, minimal line-height, dot-leader rows in
 * the meta + totals blocks (the `label .......... value` style used by
 * many small-business billing printouts), and a borderless line-item
 * table with thin separators. Drives layout #3 of the pluggable system.
 * Stresses DocRithm's extraction on tight, dense, low-whitespace
 * documents where columns nearly touch.
 *
 * # Layout interface
 * Exports the full shared layout interface (see clean-modern.js). Money
 * goes through the shared `format.js` helpers for cross-layout
 * numeric consistency.
 *
 * # Design decisions (this layout)
 * - 7.5–8.5pt body, lineHeight 1.0, 28pt side margins — denser than any
 *   other layout.
 * - Dot leaders are emulated with pdfmake `columns` where the middle
 *   column is a repeated-dot string that fills the gap; this is the
 *   only way pdfmake renders a true leader without tab stops.
 * - A single muted accent (vendor accent at reduced prominence) on the
 *   table header only; everything else is greyscale to keep it austere.
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

/** @returns {Record<string, object>} */
export function commonStyles() {
  return {
    docTitle: { fontSize: 13, bold: true },
    vendorName: { fontSize: 11, bold: true },
    addressLine: { fontSize: 7.5, color: '#333333' },
    sectionLabel: { fontSize: 7.5, bold: true, color: '#666666' },
    partyName: { fontSize: 9, bold: true },
    fieldLabel: { fontSize: 7.5, color: '#555555' },
    fieldValue: { fontSize: 8, color: '#222222' },
    tableHeader: { fontSize: 7.5, bold: true, color: 'white' },
    cell: { fontSize: 7.5, color: '#222222' },
    cellRight: { fontSize: 7.5, color: '#222222', alignment: 'right' },
    leaderDot: { fontSize: 7.5, color: '#AAAAAA' },
    totalsLabel: { fontSize: 8, color: '#444444' },
    totalsValue: { fontSize: 8, color: '#222222', alignment: 'right' },
    grandLabel: { fontSize: 9.5, bold: true },
    grandValue: { fontSize: 9.5, bold: true, alignment: 'right' },
    wordsLine: { fontSize: 7.5, italics: true, color: '#333333' },
    h2: { fontSize: 8.5, bold: true },
    signatureName: { fontSize: 8, bold: true },
    signatureMeta: { fontSize: 7, color: '#555555' },
    disclaimer: { fontSize: 6.5, italics: true, color: '#999999' },
    footerSmall: { fontSize: 6.5, color: '#888888' },
  };
}

/** @returns {object} */
export function defaultPageDefinition() {
  return {
    pageSize: 'A4',
    pageMargins: [28, 78, 28, 42],
    defaultStyle: { font: 'Roboto', fontSize: 8, lineHeight: 1.0, color: '#222222' },
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
 * A dot-leader row: label on the left, value on the right, dots filling
 * the gap between. pdfmake has no tab stops, so the leader is a middle
 * column of repeated dots that the layout engine clips to the available
 * width.
 *
 * @param {string} label
 * @param {string} value
 * @returns {object} pdfmake columns node
 */
function leaderRow(label, value) {
  return {
    columns: [
      { width: 'auto', text: label, style: 'fieldLabel' },
      { width: '*', text: ' ' + '.'.repeat(120), style: 'leaderDot', noWrap: true },
      { width: 'auto', text: value, style: 'fieldValue', alignment: 'right' },
    ],
    columnGap: 3,
    margin: [0, 0.5, 0, 0.5],
  };
}

/**
 * @param {object} order
 * @returns {object}
 */
export function headerBlock(order) {
  const v = order.vendor;
  return {
    margin: [0, 0, 0, 3],
    stack: [
      {
        columns: [
          {
            width: '*',
            stack: [
              { text: v.name, style: 'vendorName', color: v.accentColor },
              { text: `${v.addressLines[0] ?? ''}, ${v.addressLines[1] ?? ''}`, style: 'addressLine' },
              { text: `GSTIN: ${v.gstin} | State: ${v.state} (${v.stateCode}) | ${v.phone}`, style: 'addressLine' },
            ],
          },
          { width: 'auto', text: docTitleText(order), style: 'docTitle', color: v.accentColor, alignment: 'right' },
        ],
      },
      { margin: [0, 3, 0, 0], canvas: [{ type: 'line', x1: 0, y1: 0, x2: 539, y2: 0, lineWidth: 0.8, lineColor: v.accentColor }] },
    ],
  };
}

/**
 * Meta block as dot-leader rows in two columns.
 * @param {object} order
 * @returns {object}
 */
export function metaBlock(order) {
  const docLabel = order.docType === 'invoice' ? 'Invoice No' : 'PO No';
  const dateLabel = order.docType === 'invoice' ? 'Invoice Date' : 'Order Date';
  const left = [[docLabel, order.docId]];
  if (!order.suppressOrderDate) left.push([dateLabel, formatDate(order.orderDate)]);
  const right = [];
  if (order.docType === 'invoice' && order.poNumber) right.push(['Buyer PO Ref', order.poNumber]);
  right.push([order.docType === 'invoice' ? 'Due Date' : 'Expected By', formatDate(order.dueDate)]);
  right.push(['Payment Terms', `Net ${order.termDays}`]);
  return {
    margin: [0, 3, 0, 3],
    columns: [
      { width: '*', stack: left.map(([k, val]) => leaderRow(k, val)) },
      { width: 16, text: ' ' },
      { width: '*', stack: right.map(([k, val]) => leaderRow(k, val)) },
    ],
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
      { text: title, style: 'sectionLabel' },
      { text: party.name, style: 'partyName' },
      { text: `${party.addressLines[0] ?? ''}, ${party.addressLines[1] ?? ''}`, style: 'addressLine' },
      { text: `GSTIN: ${party.gstin} | ${party.state} (${party.stateCode})`, style: 'addressLine' },
    ],
  });
  return {
    margin: [0, 2, 0, 3],
    columns: [
      { width: '*', ...card(order.docType === 'invoice' ? 'Seller' : 'Vendor', v) },
      { width: '*', ...card('Bill To / Ship To', b) },
    ],
  };
}

/**
 * @param {object} order
 * @returns {object}
 */
export function lineItemsTable(order) {
  const accent = order.vendor.accentColor;
  const sym = order.currency.symbol;
  const th = (label, align = 'left') => ({ text: label, style: 'tableHeader', fillColor: accent, alignment: align, margin: [3, 2, 3, 2] });
  const body = [[th('#'), th('Description'), th('HSN'), th('Qty'), th('Rate', 'right'), th('GST%', 'center'), th(`Amt (${sym})`, 'right')]];
  order.lines.forEach((line, idx) => {
    const c = (txt, style = 'cell', align) => ({ text: txt, style, alignment: align, margin: [3, 1.5, 3, 1.5] });
    body.push([
      c(String(idx + 1)), c(line.description), c(line.hsn), c(`${line.qty} ${line.unit}`),
      c(formatCurrency(line.unitPrice, sym), 'cellRight'), c(`${line.gstSlab}%`, 'cell', 'center'),
      c(formatCurrency(line.amount, sym), 'cellRight'),
    ]);
  });
  return {
    margin: [0, 2, 0, 3],
    table: { headerRows: 1, widths: [12, '*', 42, 'auto', 'auto', 26, 'auto'], body },
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
  const th = (label, align = 'right') => ({ text: label, style: 'tableHeader', fillColor: accent, alignment: align, margin: [3, 2, 3, 2] });
  const header = intra
    ? [th('HSN', 'left'), th('Taxable'), th('CGST'), th('SGST'), th('Tax')]
    : [th('HSN', 'left'), th('Taxable'), th('IGST%', 'center'), th('IGST'), th('Tax')];
  const body = [header];
  for (const g of order.hsnSummary) {
    const c = (txt, align = 'right') => ({ text: txt, style: 'cell', alignment: align, margin: [3, 1.5, 3, 1.5] });
    body.push(intra
      ? [c(g.hsn, 'left'), c(formatCurrency(g.taxable, sym)), c(formatCurrency(g.cgst, sym)), c(formatCurrency(g.sgst, sym)), c(formatCurrency(g.totalTax, sym))]
      : [c(g.hsn, 'left'), c(formatCurrency(g.taxable, sym)), c(`${g.igstRate}%`, 'center'), c(formatCurrency(g.igst, sym)), c(formatCurrency(g.totalTax, sym))]);
  }
  return {
    margin: [0, 2, 0, 3],
    stack: [
      { text: 'HSN-wise Tax Summary', style: 'h2', margin: [0, 1, 0, 1] },
      { table: { headerRows: 1, widths: intra ? ['auto', '*', '*', '*', '*'] : ['auto', '*', 'auto', '*', '*'], body }, layout: 'lightHorizontalLines' },
    ],
  };
}

/**
 * Totals as dot-leader rows (no box).
 * @param {object} order
 * @returns {object}
 */
export function totalsBlock(order) {
  const sym = order.currency.symbol;
  const t = order.totals;
  const rows = [['Subtotal', formatCurrency(t.subtotal, sym)]];
  if (t.discount > 0) rows.push([`Discount (${t.discountPct}%)`, `- ${formatCurrency(t.discount, sym)}`]);
  rows.push(['Taxable Value', formatCurrency(t.taxableTotal, sym)]);
  if (order.intraState) { rows.push(['CGST', formatCurrency(t.cgst, sym)]); rows.push(['SGST', formatCurrency(t.sgst, sym)]); }
  else rows.push(['IGST', formatCurrency(t.igst, sym)]);
  if (t.roundOff !== 0) rows.push(['Round Off', formatCurrency(t.roundOff, sym)]);
  const leaders = rows.map(([k, val]) => leaderRow(k, val));
  leaders.push({
    columns: [
      { width: '*', text: 'GRAND TOTAL', style: 'grandLabel' },
      { width: 'auto', text: formatCurrency(t.grandTotal, sym), style: 'grandValue' },
    ],
    margin: [0, 2, 0, 0],
  });
  return {
    margin: [0, 2, 0, 3],
    columns: [
      { width: '*', text: '' },
      { width: 240, stack: leaders },
    ],
  };
}

/**
 * @param {object} order
 * @returns {object}
 */
export function amountWordsLine(order) {
  return { margin: [0, 1, 0, 3], text: `Amount in words: ${amountInWords(order.totals.grandTotal)}`, style: 'wordsLine' };
}

/**
 * @param {object} order
 * @returns {object}
 */
export function signatureBlock(order) {
  const sig = signatoryFor(order.docId);
  return {
    margin: [0, 8, 0, 0],
    stack: [
      {
        alignment: 'right',
        stack: [
          { text: `For ${order.vendor.name}`, style: 'signatureMeta', margin: [0, 0, 0, 16] },
          { text: '________________________' },
          { text: sig.name, style: 'signatureName' },
          { text: sig.designation, style: 'signatureMeta' },
        ],
      },
      { margin: [0, 6, 0, 0], text: DISCLAIMER, style: 'disclaimer' },
    ],
  };
}

/**
 * @param {object} order
 * @returns {(currentPage:number, pageCount:number) => object}
 */
export function pageFooter(order) {
  return (currentPage, pageCount) => ({
    margin: [28, 4, 28, 0],
    columns: [
      { width: 'auto', text: `Page ${currentPage}/${pageCount}`, style: 'footerSmall' },
      { width: '*', text: `${order.docId}`, style: 'footerSmall', alignment: 'center' },
      { width: 'auto', text: 'Synthetic — not a real document', style: 'footerSmall', alignment: 'right' },
    ],
  });
}
