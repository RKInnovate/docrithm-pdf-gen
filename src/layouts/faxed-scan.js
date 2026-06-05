/**
 * Layout: Faxed / Scanned Look.
 *
 * # Purpose
 * Mimics a photocopied or low-fidelity fax/scan of an otherwise normal
 * purchase document. The *content* is fully real (same order shape,
 * same line items, same tax math, same disclaimer) — only the
 * *rendering* is degraded. The objective is to stress-test DocRithm's
 * OCR + parsing pipeline on realistic low-quality inputs without any
 * external raster post-processing. Drives layout #6 of the pluggable
 * system. The degradation tricks are ported from lab-pdf-gen's
 * faxed-look layout.
 *
 * # Degradation effects (each intentional, not a bug)
 *  1. Off-black body ink (`#262626`) — second-generation photocopy
 *     contrast loss.
 *  2. `characterSpacing: 0.4` on defaultStyle — toner-bleed / ink-spread.
 *  3. Vendor accent overridden to a flat grey-slate (`#4B5563`); brand
 *     colour washes out on a fax.
 *  4. Doc-level `background` paints a full-page light-grey tint
 *     (`#ECECEC`), faint horizontal scan-line bands, and a fixed
 *     toner-smudge polygon — beneath all content.
 *  5. Dashed grey rules for the header underline + section separators.
 *  6. Table borders are flat washed-out grey (pdfmake cannot dash table
 *     borders), no row fills (photocopies drop background tint).
 *
 * # pdfmake quirks
 * - The page tint + scan lines + smudge MUST go in the doc-level
 *   `background` callback (exported here as `pageBackground`) so pdfmake
 *   paints them BEHIND content; putting absolute-positioned canvas nodes
 *   in the flow would occlude the table.
 * - `dash: { length, space }` lives on canvas vector elements only, not
 *   on table-cell borders.
 *
 * # Layout interface
 * Exports the full shared layout interface (see clean-modern.js) PLUS
 * the optional `pageBackground(order)` the document templates wire into
 * the doc-level `background`.
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

// Washed-out palette (see file header for rationale of each value).
const FAX_ACCENT = '#4B5563';
const FAX_INK = '#262626';
const FAX_INK_DARK = '#111111';
const FAX_RULE = '#8A8A8A';
const FAX_BORDER = '#9A9A9A';
const FAX_PAGE_TINT = '#ECECEC';
const FAX_SCAN_LINE = '#D5D5D5';
const FAX_SMUDGE = '#D8D8D8';

// A4 portrait dimensions in pdfmake points. Hard-coded because we draw
// the page-tint rect at absolute coordinates.
const A4_W = 595;
const A4_H = 842;

/** @returns {Record<string, object>} */
export function commonStyles() {
  return {
    docTitle: { fontSize: 17, bold: true, color: FAX_INK_DARK, characterSpacing: 0.6 },
    vendorName: { fontSize: 14, bold: true, color: FAX_ACCENT, characterSpacing: 0.5 },
    addressLine: { fontSize: 8, color: '#555555' },
    sectionLabel: { fontSize: 8, bold: true, color: '#7A7A7A', characterSpacing: 0.7 },
    partyName: { fontSize: 10, bold: true, color: FAX_INK_DARK },
    fieldLabel: { fontSize: 8, color: '#6A6A6A' },
    fieldValue: { fontSize: 9, color: FAX_INK },
    tableHeader: { fontSize: 8.5, bold: true, color: FAX_INK_DARK },
    cell: { fontSize: 8.5, color: FAX_INK },
    cellRight: { fontSize: 8.5, color: FAX_INK, alignment: 'right' },
    totalsLabel: { fontSize: 9, color: '#444444', alignment: 'right' },
    totalsValue: { fontSize: 9, color: FAX_INK, alignment: 'right' },
    grandLabel: { fontSize: 11, bold: true, color: FAX_INK_DARK, alignment: 'right' },
    grandValue: { fontSize: 11, bold: true, color: FAX_INK_DARK, alignment: 'right' },
    wordsLine: { fontSize: 9, italics: true, color: FAX_INK },
    h2: { fontSize: 10, bold: true, color: FAX_INK_DARK },
    signatureName: { fontSize: 9, bold: true, color: FAX_INK_DARK },
    signatureMeta: { fontSize: 8, color: '#555555' },
    disclaimer: { fontSize: 7, italics: true, color: '#7A7A7A' },
    footerSmall: { fontSize: 7, color: '#7A7A7A' },
  };
}

/** @returns {object} */
export function defaultPageDefinition() {
  return {
    pageSize: 'A4',
    pageMargins: [40, 96, 40, 50],
    defaultStyle: {
      font: 'Roboto',
      fontSize: 9,
      lineHeight: 1.25,
      // characterSpacing on defaultStyle propagates to every text node —
      // the ink-spread look.
      characterSpacing: 0.4,
      color: FAX_INK,
    },
  };
}

/**
 * Doc-level background factory: page tint + scan-line bands + a fixed
 * toner-smudge polygon, merged into one canvas node (pdfmake's
 * background wants a single node). Painted under every page.
 *
 * @param {object} _order — accepted for interface symmetry; the
 *   background is identical across pages so it doesn't read `order`.
 * @returns {Function} pdfmake background callback (page, size) => node
 */
export function pageBackground(_order) {
  return () => ({
    canvas: [
      { type: 'rect', x: 0, y: 0, w: A4_W, h: A4_H, color: FAX_PAGE_TINT },
      ...[150, 300, 460, 620, 770].map((y) => ({
        type: 'line', x1: 0, y1: y, x2: A4_W, y2: y, lineWidth: 0.3, lineColor: FAX_SCAN_LINE,
      })),
      { type: 'polyline', closePath: true, color: FAX_SMUDGE, lineWidth: 0, points: smudgePoints() },
    ],
  });
}

/**
 * 8 vertices of the fixed bottom-left toner-smudge polygon. Fresh array
 * each call (pdfmake mutates canvas arrays during layout).
 * @returns {Array<{x:number,y:number}>}
 */
function smudgePoints() {
  const cx = 60;
  const cy = A4_H - 70;
  const rx = 18;
  const ry = 12;
  const pts = [];
  for (let i = 0; i < 8; i += 1) {
    const th = (Math.PI * 2 * i) / 8;
    pts.push({ x: cx + rx * Math.cos(th), y: cy + ry * Math.sin(th) });
  }
  return pts;
}

/**
 * @param {object} order
 * @returns {string}
 */
function docTitleText(order) {
  return order.docType === 'invoice' ? 'TAX INVOICE' : 'PURCHASE ORDER';
}

/**
 * Washed-out flat-grey table layout reused by every table here.
 * @type {object}
 */
const FAX_TABLE = {
  hLineWidth: () => 0.4,
  vLineWidth: () => 0.4,
  hLineColor: () => FAX_BORDER,
  vLineColor: () => FAX_BORDER,
};

/**
 * Dashed grey rule spanning the printable width.
 * @returns {object}
 */
function dashedRule() {
  return {
    margin: [0, 3, 0, 3],
    canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.8, lineColor: FAX_RULE, dash: { length: 2, space: 1.5 } }],
  };
}

/**
 * @param {object} order
 * @returns {object}
 */
export function headerBlock(order) {
  const v = order.vendor;
  return {
    margin: [0, 0, 0, 4],
    stack: [
      {
        columns: [
          {
            width: 42,
            table: { widths: [38], heights: [38], body: [[{ text: v.logoMonogram, color: '#FFFFFF', bold: true, fontSize: 15, alignment: 'center', margin: [0, 8, 0, 0], fillColor: FAX_ACCENT, border: [false, false, false, false] }]] },
            layout: 'noBorders',
          },
          {
            width: '*',
            margin: [10, 0, 0, 0],
            stack: [
              { text: v.name, style: 'vendorName' },
              { text: `${v.addressLines[0] ?? ''}, ${v.addressLines[1] ?? ''}`, style: 'addressLine' },
              { text: `GSTIN: ${v.gstin}   State: ${v.state} (${v.stateCode})`, style: 'addressLine' },
            ],
          },
          { width: 'auto', text: docTitleText(order), style: 'docTitle', alignment: 'right' },
        ],
      },
      { margin: [0, 4, 0, 0], canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, lineColor: FAX_RULE, dash: { length: 2, space: 1.5 } }] },
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
    margin: [0, 4, 0, 2],
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
    margin: [0, 2, 0, 2],
    stack: [
      dashedRule(),
      {
        margin: [0, 3, 0, 3],
        columns: [
          { width: '*', ...card(order.docType === 'invoice' ? 'Seller / Supplier' : 'Vendor / Supplier', v) },
          { width: '*', ...card('Bill To / Ship To', b) },
        ],
      },
      dashedRule(),
    ],
  };
}

/**
 * @param {object} order
 * @returns {object}
 */
export function lineItemsTable(order) {
  const sym = order.currency.symbol;
  const th = (label, align = 'left') => ({ text: label, style: 'tableHeader', fillColor: '#D0D0D0', alignment: align, margin: [4, 3, 4, 3] });
  const body = [[th('#'), th('Description'), th('HSN'), th('Qty'), th('Rate', 'right'), th('GST%', 'center'), th(`Amount (${sym})`, 'right')]];
  order.lines.forEach((line, idx) => {
    const c = (txt, style = 'cell', align) => ({ text: txt, style, alignment: align, margin: [4, 2, 4, 2] });
    body.push([
      c(String(idx + 1)), c(line.description), c(line.hsn), c(`${line.qty} ${line.unit}`),
      c(formatCurrency(line.unitPrice, sym), 'cellRight'), c(`${line.gstSlab}%`, 'cell', 'center'),
      c(formatCurrency(line.amount, sym), 'cellRight'),
    ]);
  });
  return {
    margin: [0, 2, 0, 4],
    table: { headerRows: 1, widths: [16, '*', 48, 'auto', 'auto', 30, 'auto'], body },
    layout: FAX_TABLE,
  };
}

/**
 * @param {object} order
 * @returns {object}
 */
export function taxSummary(order) {
  const sym = order.currency.symbol;
  const intra = order.intraState;
  const th = (label, align = 'right') => ({ text: label, style: 'tableHeader', fillColor: '#D0D0D0', alignment: align, margin: [4, 2, 4, 2] });
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
    margin: [0, 2, 0, 4],
    stack: [
      { text: 'HSN / SAC-wise Tax Summary', style: 'h2', margin: [0, 3, 0, 2] },
      { table: { headerRows: 1, widths: intra ? ['auto', '*', 'auto', '*', 'auto', '*', '*'] : ['auto', '*', 'auto', '*', '*'], body }, layout: FAX_TABLE },
    ],
  };
}

/**
 * @param {object} order
 * @returns {object}
 */
export function totalsBlock(order) {
  const sym = order.currency.symbol;
  const t = order.totals;
  const row = (label, value, grand = false) => [
    { text: label, style: grand ? 'grandLabel' : 'totalsLabel', fillColor: grand ? '#C8C8C8' : null, margin: [6, 3, 6, 3] },
    { text: value, style: grand ? 'grandValue' : 'totalsValue', fillColor: grand ? '#C8C8C8' : null, margin: [6, 3, 6, 3] },
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
      { width: 'auto', table: { widths: ['auto', 'auto'], body: rows }, layout: FAX_TABLE },
    ],
  };
}

/**
 * @param {object} order
 * @returns {object}
 */
export function amountWordsLine(order) {
  return { margin: [0, 2, 0, 4], text: `Amount in words: ${amountInWords(order.totals.grandTotal)}`, style: 'wordsLine' };
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
          { text: `For ${order.vendor.name}`, style: 'signatureMeta', margin: [0, 0, 0, 18] },
          {
            columns: [
              { width: '*', text: '' },
              { width: 200, canvas: [{ type: 'line', x1: 0, y1: 0, x2: 200, y2: 0, lineWidth: 0.6, lineColor: FAX_RULE, dash: { length: 2, space: 1.5 } }] },
            ],
          },
          { text: sig.name, style: 'signatureName', margin: [0, 4, 0, 0] },
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
    margin: [40, 8, 40, 0],
    stack: [
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: FAX_RULE, dash: { length: 2, space: 1.5 } }] },
      {
        margin: [0, 4, 0, 0],
        columns: [
          { width: 'auto', text: `Page ${currentPage} of ${pageCount}`, style: 'footerSmall' },
          { width: '*', text: `${order.docId}`, style: 'footerSmall', alignment: 'center' },
          { width: 'auto', text: 'Synthetic — not a real document', style: 'footerSmall', alignment: 'right' },
        ],
      },
    ],
  });
}
