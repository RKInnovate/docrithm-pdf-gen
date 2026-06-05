/**
 * Layout: Classic Bordered.
 *
 * # Purpose
 * The "old-school" procurement document: a full black grid around every
 * block and table cell, ALL-CAPS section headings, a centred title
 * band, and no colour at all (pure black-on-white, the way a
 * traditionally-printed Indian tax invoice from a legacy accounting
 * package looks). Drives layout #2 of the pluggable system. Visually
 * the opposite of clean-modern's airy colour blocks — useful for
 * exercising DocRithm's table-extraction against a dense, fully-ruled
 * grid.
 *
 * # Layout interface
 * Exports the full shared layout interface (see clean-modern.js for the
 * canonical contract). All money formatting goes through the shared
 * `format.js` helpers so the SAME order prints identical numbers across
 * layouts.
 *
 * # Design decisions (this layout)
 * - No accent colour: everything is `#000000` on white. Headings are
 *   ALL CAPS with wide character spacing to read as "rubber-stamped".
 * - Every table uses a solid black full grid (`hLine`/`vLine` width 0.7)
 *   rather than light horizontal lines, and the parties block is a real
 *   two-cell bordered table, not borderless columns.
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

const INK = '#000000';

/**
 * Solid full-grid table layout. Reused by every table in this module.
 * @type {object}
 */
const FULL_GRID = {
  hLineWidth: () => 0.7,
  vLineWidth: () => 0.7,
  hLineColor: () => INK,
  vLineColor: () => INK,
};

/** @returns {Record<string, object>} */
export function commonStyles() {
  return {
    docTitle: { fontSize: 16, bold: true, characterSpacing: 1.5, alignment: 'center' },
    vendorName: { fontSize: 13, bold: true, characterSpacing: 0.5 },
    addressLine: { fontSize: 8, color: INK },
    sectionLabel: { fontSize: 8, bold: true, characterSpacing: 1, color: INK },
    partyName: { fontSize: 10, bold: true },
    fieldLabel: { fontSize: 8, bold: true, color: INK },
    fieldValue: { fontSize: 9, color: INK },
    tableHeader: { fontSize: 8.5, bold: true, color: INK, characterSpacing: 0.3 },
    cell: { fontSize: 8.5, color: INK },
    cellRight: { fontSize: 8.5, color: INK, alignment: 'right' },
    totalsLabel: { fontSize: 9, bold: true, color: INK, alignment: 'right' },
    totalsValue: { fontSize: 9, color: INK, alignment: 'right' },
    grandLabel: { fontSize: 11, bold: true, color: INK, alignment: 'right' },
    grandValue: { fontSize: 11, bold: true, color: INK, alignment: 'right' },
    wordsLine: { fontSize: 9, bold: true, color: INK },
    h2: { fontSize: 10, bold: true, characterSpacing: 0.5 },
    signatureName: { fontSize: 9, bold: true },
    signatureMeta: { fontSize: 8, color: INK },
    disclaimer: { fontSize: 7, italics: true, color: '#444444' },
    footerSmall: { fontSize: 7, color: INK },
  };
}

/** @returns {object} partial pdfmake docDefinition */
export function defaultPageDefinition() {
  return {
    pageSize: 'A4',
    pageMargins: [40, 96, 40, 50],
    defaultStyle: { font: 'Roboto', fontSize: 9, lineHeight: 1.1, color: INK },
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
 * Vendor letterhead inside a bordered box, with a centred title band
 * below it.
 * @param {object} order
 * @returns {object}
 */
export function headerBlock(order) {
  const v = order.vendor;
  return {
    margin: [0, 0, 0, 4],
    stack: [
      {
        table: {
          widths: ['*'],
          body: [[{
            border: [true, true, true, true],
            margin: [6, 4, 6, 4],
            stack: [
              { text: v.name, style: 'vendorName' },
              { text: `${v.addressLines[0] ?? ''}, ${v.addressLines[1] ?? ''}`, style: 'addressLine' },
              { text: `GSTIN: ${v.gstin}    STATE: ${v.state} (${v.stateCode})`, style: 'addressLine' },
              { text: `PH: ${v.phone}    ${v.email}`, style: 'addressLine' },
            ],
          }]],
        },
        layout: FULL_GRID,
      },
      {
        margin: [0, 3, 0, 0],
        table: {
          widths: ['*'],
          body: [[{ text: docTitleText(order), style: 'docTitle', margin: [0, 3, 0, 3], border: [true, true, true, true] }]],
        },
        layout: FULL_GRID,
      },
    ],
  };
}

/**
 * Meta strip rendered as a bordered key/value grid.
 * @param {object} order
 * @returns {object}
 */
export function metaBlock(order) {
  const docLabel = order.docType === 'invoice' ? 'INVOICE NO' : 'PO NO';
  const dateLabel = order.docType === 'invoice' ? 'INVOICE DATE' : 'ORDER DATE';
  const rows = [[`${docLabel}`, order.docId]];
  if (!order.suppressOrderDate) rows.push([dateLabel, formatDate(order.orderDate)]);
  if (order.docType === 'invoice' && order.poNumber) rows.push(['BUYER PO REF', order.poNumber]);
  rows.push([order.docType === 'invoice' ? 'DUE DATE' : 'EXPECTED BY', formatDate(order.dueDate)]);
  rows.push(['PAYMENT TERMS', `NET ${order.termDays}`]);

  return {
    margin: [0, 4, 0, 4],
    table: {
      widths: ['auto', '*', 'auto', '*'],
      // Pack rows two-per-line into a 4-col grid.
      body: chunkPairs(rows).map((pair) =>
        pair.flatMap(([k, val]) => [
          { text: k, style: 'fieldLabel', margin: [4, 2, 4, 2] },
          { text: val, style: 'fieldValue', margin: [4, 2, 4, 2] },
        ]).concat(pair.length === 1 ? [{ text: '', border: [false, false, false, false] }, { text: '', border: [false, false, false, false] }] : []),
      ),
    },
    layout: FULL_GRID,
  };
}

/**
 * Chunk an array of [k,v] rows into pairs (two per visual line).
 * @param {Array} rows
 * @returns {Array<Array>}
 */
function chunkPairs(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += 2) out.push(rows.slice(i, i + 2));
  return out;
}

/**
 * Two bordered party cells side by side.
 * @param {object} order
 * @returns {object}
 */
export function partiesBlock(order) {
  const v = order.vendor;
  const b = order.buyer;
  const cell = (title, party) => ({
    margin: [5, 4, 5, 4],
    border: [true, true, true, true],
    stack: [
      { text: title, style: 'sectionLabel', margin: [0, 0, 0, 2] },
      { text: party.name, style: 'partyName' },
      { text: party.addressLines[0] ?? '', style: 'addressLine' },
      { text: party.addressLines[1] ?? '', style: 'addressLine' },
      { text: `GSTIN: ${party.gstin}`, style: 'addressLine' },
      { text: `STATE: ${party.state} (${party.stateCode})`, style: 'addressLine' },
    ],
  });
  return {
    margin: [0, 2, 0, 4],
    table: {
      widths: ['*', '*'],
      body: [[
        cell(order.docType === 'invoice' ? 'SELLER / SUPPLIER' : 'VENDOR / SUPPLIER', v),
        cell('BILL TO / SHIP TO', b),
      ]],
    },
    layout: FULL_GRID,
  };
}

/**
 * Line-item table, full black grid.
 * @param {object} order
 * @returns {object}
 */
export function lineItemsTable(order) {
  const sym = order.currency.symbol;
  const th = (label, align = 'left') => ({ text: label, style: 'tableHeader', alignment: align, margin: [4, 3, 4, 3] });
  const body = [[
    th('S.NO'), th('DESCRIPTION OF GOODS'), th('HSN'), th('QTY'), th('RATE', 'right'),
    th('GST%', 'center'), th(`AMOUNT (${sym})`, 'right'),
  ]];
  order.lines.forEach((line, idx) => {
    const c = (txt, style = 'cell', align) => ({ text: txt, style, alignment: align, margin: [4, 2, 4, 2] });
    body.push([
      c(String(idx + 1)),
      c(line.description),
      c(line.hsn),
      c(`${line.qty} ${line.unit}`),
      c(formatCurrency(line.unitPrice, sym), 'cellRight'),
      c(`${line.gstSlab}%`, 'cell', 'center'),
      c(formatCurrency(line.amount, sym), 'cellRight'),
    ]);
  });
  return {
    margin: [0, 2, 0, 4],
    table: { headerRows: 1, widths: [22, '*', 48, 'auto', 'auto', 30, 'auto'], body },
    layout: FULL_GRID,
  };
}

/**
 * HSN-wise tax summary, full black grid.
 * @param {object} order
 * @returns {object}
 */
export function taxSummary(order) {
  const sym = order.currency.symbol;
  const intra = order.intraState;
  const th = (label, align = 'right') => ({ text: label, style: 'tableHeader', alignment: align, margin: [4, 2, 4, 2] });
  const header = intra
    ? [th('HSN/SAC', 'left'), th('TAXABLE'), th('CGST%', 'center'), th('CGST'), th('SGST%', 'center'), th('SGST'), th('TOTAL TAX')]
    : [th('HSN/SAC', 'left'), th('TAXABLE'), th('IGST%', 'center'), th('IGST'), th('TOTAL TAX')];
  const body = [header];
  for (const g of order.hsnSummary) {
    const c = (txt, align = 'right') => ({ text: txt, style: 'cell', alignment: align, margin: [4, 2, 4, 2] });
    body.push(intra
      ? [c(g.hsn, 'left'), c(formatCurrency(g.taxable, sym)), c(`${g.cgstRate}%`, 'center'), c(formatCurrency(g.cgst, sym)), c(`${g.sgstRate}%`, 'center'), c(formatCurrency(g.sgst, sym)), c(formatCurrency(g.totalTax, sym))]
      : [c(g.hsn, 'left'), c(formatCurrency(g.taxable, sym)), c(`${g.igstRate}%`, 'center'), c(formatCurrency(g.igst, sym)), c(formatCurrency(g.totalTax, sym))]);
  }
  return {
    margin: [0, 2, 0, 4],
    stack: [
      { text: 'HSN / SAC-WISE TAX SUMMARY', style: 'h2', margin: [0, 2, 0, 2] },
      {
        table: { headerRows: 1, widths: intra ? ['auto', '*', 'auto', '*', 'auto', '*', '*'] : ['auto', '*', 'auto', '*', '*'], body },
        layout: FULL_GRID,
      },
    ],
  };
}

/**
 * Totals box, bordered.
 * @param {object} order
 * @returns {object}
 */
export function totalsBlock(order) {
  const sym = order.currency.symbol;
  const t = order.totals;
  const row = (label, value, grand = false) => [
    { text: label, style: grand ? 'grandLabel' : 'totalsLabel', margin: [6, 2, 6, 2] },
    { text: value, style: grand ? 'grandValue' : 'totalsValue', margin: [6, 2, 6, 2] },
  ];
  const rows = [row('SUBTOTAL', formatCurrency(t.subtotal, sym))];
  if (t.discount > 0) rows.push(row(`DISCOUNT (${t.discountPct}%)`, `- ${formatCurrency(t.discount, sym)}`));
  rows.push(row('TAXABLE VALUE', formatCurrency(t.taxableTotal, sym)));
  if (order.intraState) {
    rows.push(row('CGST', formatCurrency(t.cgst, sym)));
    rows.push(row('SGST', formatCurrency(t.sgst, sym)));
  } else {
    rows.push(row('IGST', formatCurrency(t.igst, sym)));
  }
  if (t.roundOff !== 0) rows.push(row('ROUND OFF', formatCurrency(t.roundOff, sym)));
  rows.push(row('GRAND TOTAL', formatCurrency(t.grandTotal, sym), true));
  return {
    margin: [0, 2, 0, 4],
    columns: [
      { width: '*', text: '' },
      { width: 'auto', table: { widths: ['auto', 'auto'], body: rows }, layout: FULL_GRID },
    ],
  };
}

/**
 * Amount-in-words line.
 * @param {object} order
 * @returns {object}
 */
export function amountWordsLine(order) {
  return { margin: [0, 2, 0, 4], text: `AMOUNT IN WORDS: ${amountInWords(order.totals.grandTotal)}`, style: 'wordsLine' };
}

/**
 * Authorised-signatory block + disclaimer.
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
          { text: `FOR ${order.vendor.name.toUpperCase()}`, style: 'signatureMeta', margin: [0, 0, 0, 22] },
          { text: '_____________________________' },
          { text: sig.name, style: 'signatureName' },
          { text: sig.designation.toUpperCase(), style: 'signatureMeta' },
        ],
      },
      { margin: [0, 10, 0, 0], text: DISCLAIMER, style: 'disclaimer' },
    ],
  };
}

/**
 * Page footer factory.
 * @param {object} order
 * @returns {(currentPage:number, pageCount:number) => object}
 */
export function pageFooter(order) {
  return (currentPage, pageCount) => ({
    margin: [40, 6, 40, 0],
    columns: [
      { width: 'auto', text: `PAGE ${currentPage} OF ${pageCount}`, style: 'footerSmall' },
      { width: '*', text: `${order.docId}`, style: 'footerSmall', alignment: 'center' },
      { width: 'auto', text: 'SYNTHETIC — NOT A REAL DOCUMENT', style: 'footerSmall', alignment: 'right' },
    ],
  });
}
