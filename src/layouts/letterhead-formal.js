/**
 * Layout: Letterhead Formal.
 *
 * # Purpose
 * A formal corporate-letterhead document: a tall, full-width accent band
 * across the top carrying the vendor identity in reversed-out white
 * text, a generous title strip, roomy borderless party blocks, and a
 * borderless line-item table separated only by faint horizontal rules
 * (the "no gridlines, lots of air" aesthetic of premium printed
 * stationery). Drives layout #4 of the pluggable system. Contrasts with
 * classic-bordered's heavy grid — exercises DocRithm's extraction on a
 * gridless, whitespace-delimited table.
 *
 * # Layout interface
 * Exports the full shared layout interface (see clean-modern.js). Money
 * goes through shared `format.js` helpers.
 *
 * # Design decisions (this layout)
 * - The header is a full-bleed coloured band (drawn via a doc-level
 *   `background` so it spans the top margin) with white text on top.
 * - Line-item + tax tables are borderless with `lightHorizontalLines`
 *   only; the totals block is a soft grey card.
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

const A4_W = 595;

/** @returns {Record<string, object>} */
export function commonStyles() {
  return {
    docTitle: { fontSize: 18, bold: true, color: 'white' },
    vendorNameWhite: { fontSize: 16, bold: true, color: 'white' },
    addressWhite: { fontSize: 8, color: '#EEEEEE' },
    addressLine: { fontSize: 8, color: '#555555' },
    sectionLabel: { fontSize: 8, bold: true, color: '#999999', characterSpacing: 0.6 },
    partyName: { fontSize: 11, bold: true, color: '#222222' },
    fieldLabel: { fontSize: 8, color: '#777777' },
    fieldValue: { fontSize: 9, color: '#222222' },
    tableHeader: { fontSize: 8.5, bold: true, color: '#444444' },
    cell: { fontSize: 8.5, color: '#333333' },
    cellRight: { fontSize: 8.5, color: '#333333', alignment: 'right' },
    totalsLabel: { fontSize: 9, color: '#555555', alignment: 'right' },
    totalsValue: { fontSize: 9, color: '#222222', alignment: 'right' },
    grandLabel: { fontSize: 12, bold: true, alignment: 'right' },
    grandValue: { fontSize: 12, bold: true, alignment: 'right' },
    wordsLine: { fontSize: 9, italics: true, color: '#333333' },
    h2: { fontSize: 10, bold: true, color: '#444444' },
    signatureName: { fontSize: 9, bold: true },
    signatureMeta: { fontSize: 8, color: '#555555' },
    disclaimer: { fontSize: 7, italics: true, color: '#999999' },
    footerSmall: { fontSize: 7, color: '#999999' },
  };
}

/** @returns {object} */
export function defaultPageDefinition() {
  return {
    pageSize: 'A4',
    pageMargins: [46, 130, 46, 55],
    defaultStyle: { font: 'Roboto', fontSize: 9, lineHeight: 1.2, color: '#333333' },
  };
}

/**
 * Doc-level background: a full-bleed accent band across the top of the
 * page. Painted beneath all content so the header text sits on top.
 * pdfmake calls this per page with (currentPage, pageSize).
 *
 * @param {object} order
 * @returns {Function} pdfmake background callback
 */
export function pageBackground(order) {
  const accent = order.vendor.accentColor;
  return () => ({
    canvas: [{ type: 'rect', x: 0, y: 0, w: A4_W, h: 96, color: accent }],
  });
}

/**
 * @param {object} order
 * @returns {string}
 */
function docTitleText(order) {
  return order.docType === 'invoice' ? 'TAX INVOICE' : 'PURCHASE ORDER';
}

/**
 * Vendor identity in reversed-out white text (sits on the accent band
 * painted by pageBackground).
 * @param {object} order
 * @returns {object}
 */
export function headerBlock(order) {
  const v = order.vendor;
  return {
    margin: [0, 0, 0, 6],
    columns: [
      {
        width: '*',
        stack: [
          { text: v.name, style: 'vendorNameWhite' },
          { text: `${v.addressLines[0] ?? ''}, ${v.addressLines[1] ?? ''}`, style: 'addressWhite' },
          { text: `GSTIN: ${v.gstin}   State: ${v.state} (${v.stateCode})`, style: 'addressWhite' },
        ],
      },
      { width: 'auto', text: docTitleText(order), style: 'docTitle', alignment: 'right' },
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
  return {
    margin: [0, 8, 0, 6],
    columns: rows.map(([k, val]) => ({
      width: '*',
      stack: [{ text: k, style: 'fieldLabel' }, { text: val, style: 'fieldValue', bold: true }],
    })),
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
      { text: title, style: 'sectionLabel', margin: [0, 0, 0, 4] },
      { text: party.name, style: 'partyName' },
      { text: party.addressLines[0] ?? '', style: 'addressLine' },
      { text: party.addressLines[1] ?? '', style: 'addressLine' },
      { text: `GSTIN: ${party.gstin}`, style: 'addressLine' },
      { text: `State: ${party.state} (${party.stateCode})`, style: 'addressLine' },
    ],
  });
  return {
    margin: [0, 4, 0, 8],
    columns: [
      { width: '*', ...card(order.docType === 'invoice' ? 'Seller / Supplier' : 'Vendor / Supplier', v) },
      { width: '*', ...card('Bill To / Ship To', b) },
    ],
  };
}

/**
 * Borderless line-item table, faint horizontal rules only.
 * @param {object} order
 * @returns {object}
 */
export function lineItemsTable(order) {
  const sym = order.currency.symbol;
  const th = (label, align = 'left') => ({ text: label, style: 'tableHeader', alignment: align, margin: [4, 4, 4, 6] });
  const body = [[th('#'), th('Description'), th('HSN'), th('Qty'), th('Rate', 'right'), th('GST%', 'center'), th(`Amount (${sym})`, 'right')]];
  order.lines.forEach((line, idx) => {
    const c = (txt, style = 'cell', align) => ({ text: txt, style, alignment: align, margin: [4, 4, 4, 4] });
    body.push([
      c(String(idx + 1)), c(line.description), c(line.hsn), c(`${line.qty} ${line.unit}`),
      c(formatCurrency(line.unitPrice, sym), 'cellRight'), c(`${line.gstSlab}%`, 'cell', 'center'),
      c(formatCurrency(line.amount, sym), 'cellRight'),
    ]);
  });
  return {
    margin: [0, 2, 0, 6],
    table: { headerRows: 1, widths: [16, '*', 48, 'auto', 'auto', 30, 'auto'], body },
    layout: {
      hLineWidth: (i) => (i === 1 ? 1 : 0.3),
      vLineWidth: () => 0,
      hLineColor: (i) => (i === 1 ? '#999999' : '#DDDDDD'),
    },
  };
}

/**
 * @param {object} order
 * @returns {object}
 */
export function taxSummary(order) {
  const sym = order.currency.symbol;
  const intra = order.intraState;
  const th = (label, align = 'right') => ({ text: label, style: 'tableHeader', alignment: align, margin: [4, 3, 4, 4] });
  const header = intra
    ? [th('HSN/SAC', 'left'), th('Taxable'), th('CGST%', 'center'), th('CGST'), th('SGST%', 'center'), th('SGST'), th('Total Tax')]
    : [th('HSN/SAC', 'left'), th('Taxable'), th('IGST%', 'center'), th('IGST'), th('Total Tax')];
  const body = [header];
  for (const g of order.hsnSummary) {
    const c = (txt, align = 'right') => ({ text: txt, style: 'cell', alignment: align, margin: [4, 3, 4, 3] });
    body.push(intra
      ? [c(g.hsn, 'left'), c(formatCurrency(g.taxable, sym)), c(`${g.cgstRate}%`, 'center'), c(formatCurrency(g.cgst, sym)), c(`${g.sgstRate}%`, 'center'), c(formatCurrency(g.sgst, sym)), c(formatCurrency(g.totalTax, sym))]
      : [c(g.hsn, 'left'), c(formatCurrency(g.taxable, sym)), c(`${g.igstRate}%`, 'center'), c(formatCurrency(g.igst, sym)), c(formatCurrency(g.totalTax, sym))]);
  }
  return {
    margin: [0, 2, 0, 6],
    stack: [
      { text: 'HSN / SAC-wise Tax Summary', style: 'h2', margin: [0, 4, 0, 3] },
      { table: { headerRows: 1, widths: intra ? ['auto', '*', 'auto', '*', 'auto', '*', '*'] : ['auto', '*', 'auto', '*', '*'], body }, layout: { hLineWidth: (i) => (i === 1 ? 1 : 0.3), vLineWidth: () => 0, hLineColor: () => '#DDDDDD' } },
    ],
  };
}

/**
 * Totals in a soft grey card.
 * @param {object} order
 * @returns {object}
 */
export function totalsBlock(order) {
  const sym = order.currency.symbol;
  const accent = order.vendor.accentColor;
  const t = order.totals;
  const row = (label, value, grand = false) => [
    { text: label, style: grand ? 'grandLabel' : 'totalsLabel', color: grand ? 'white' : undefined, fillColor: grand ? accent : '#F2F2F2', margin: [8, 3, 8, 3], border: [false, false, false, false] },
    { text: value, style: grand ? 'grandValue' : 'totalsValue', color: grand ? 'white' : undefined, fillColor: grand ? accent : '#F2F2F2', margin: [8, 3, 8, 3], border: [false, false, false, false] },
  ];
  const rows = [row('Subtotal', formatCurrency(t.subtotal, sym))];
  if (t.discount > 0) rows.push(row(`Discount (${t.discountPct}%)`, `- ${formatCurrency(t.discount, sym)}`));
  rows.push(row('Taxable Value', formatCurrency(t.taxableTotal, sym)));
  if (order.intraState) { rows.push(row('CGST', formatCurrency(t.cgst, sym))); rows.push(row('SGST', formatCurrency(t.sgst, sym))); }
  else rows.push(row('IGST', formatCurrency(t.igst, sym)));
  if (t.roundOff !== 0) rows.push(row('Round Off', formatCurrency(t.roundOff, sym)));
  rows.push(row('GRAND TOTAL', formatCurrency(t.grandTotal, sym), true));
  return {
    margin: [0, 4, 0, 4],
    columns: [
      { width: '*', text: '' },
      { width: 'auto', table: { widths: ['*', 'auto'], body: rows }, layout: 'noBorders' },
    ],
  };
}

/**
 * @param {object} order
 * @returns {object}
 */
export function amountWordsLine(order) {
  return { margin: [0, 2, 0, 6], text: `Amount in words: ${amountInWords(order.totals.grandTotal)}`, style: 'wordsLine' };
}

/**
 * @param {object} order
 * @returns {object}
 */
export function signatureBlock(order) {
  const sig = signatoryFor(order.docId);
  return {
    margin: [0, 14, 0, 0],
    stack: [
      {
        alignment: 'right',
        stack: [
          { text: `For ${order.vendor.name}`, style: 'signatureMeta', margin: [0, 0, 0, 24] },
          { text: '_____________________________', color: '#999999' },
          { text: sig.name, style: 'signatureName' },
          { text: sig.designation, style: 'signatureMeta' },
        ],
      },
      { margin: [0, 12, 0, 0], text: DISCLAIMER, style: 'disclaimer' },
    ],
  };
}

/**
 * @param {object} order
 * @returns {(currentPage:number, pageCount:number) => object}
 */
export function pageFooter(order) {
  return (currentPage, pageCount) => ({
    margin: [46, 8, 46, 0],
    columns: [
      { width: 'auto', text: `Page ${currentPage} of ${pageCount}`, style: 'footerSmall' },
      { width: '*', text: `${order.docId} — ${order.vendor.gstin}`, style: 'footerSmall', alignment: 'center' },
      { width: 'auto', text: 'Synthetic — not a real document', style: 'footerSmall', alignment: 'right' },
    ],
  });
}
