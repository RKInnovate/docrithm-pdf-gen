/**
 * Layout: Clean Modern.
 *
 * # Purpose
 * The "default" reference layout — a modern corporate procurement look:
 * accent-coloured vendor monogram, a right-aligned document title block,
 * two-column party panel (vendor / bill-to + ship-to), a full-width
 * line-item table with a coloured header and zebra striping, an
 * HSN-wise tax summary, a totals box, and an authorised-signatory
 * block. Drives layout #1 of the pluggable layout system.
 *
 * # Role in the pipeline
 *   generators/* ──▶ order shell (with .layoutKey) ──▶ doc template
 *                                                        │
 *                                                        └─uses─▶ layouts/<layoutKey>.js (this is one of 7)
 *                                                                  │
 *                                                                  └─emits─▶ pdfmake docDefinition
 *
 * # Layout interface (every layout MUST export these — copy verbatim)
 *   formatDate(d)             → string
 *   formatDateTime(d)         → string
 *   commonStyles()            → pdfmake styles object
 *   defaultPageDefinition()   → partial docDefinition (pageSize, margins, defaultStyle)
 *   headerBlock(order)        → content node — vendor letterhead + doc title
 *   partiesBlock(order)       → content node — vendor + bill-to/ship-to
 *   lineItemsTable(order)     → content node — line-item grid
 *   totalsBlock(order)        → content node — subtotal/discount/tax/grand total
 *   taxSummary(order)         → content node — HSN-wise tax breakup table
 *   signatureBlock(order)     → content node — authorised-signatory block
 *   pageFooter(order)         → (page, total) => content node
 *
 * Document templates (purchase-order.js / purchase-invoice.js) compose
 * these nodes; the layout has zero knowledge of PO-vs-invoice — it
 * operates on the generic order shape ({vendor, buyer, docType, docId,
 * poNumber, orderDate, dueDate, lines, taxType, hsnSummary, totals,
 * currency, ...}).
 *
 * # Design decisions (this layout)
 * - Accent colour is read from `order.vendor.accentColor`; it drives the
 *   monogram fill, vendor-name colour, header rule, table header fill,
 *   and the grand-total row.
 * - Money is formatted via the shared `formatCurrency` so every layout
 *   prints identical numbers for the same order.
 * - Default font is 'Roboto' (pdfmake built-in, registered by the
 *   renderer). We never reference a font pdfmake doesn't ship.
 */

import {
  formatDate,
  formatDateTime,
  formatCurrency,
  amountInWords,
  signatoryFor,
  DISCLAIMER,
} from '../format.js';

// Re-export the shared date formatters so this module satisfies the
// full layout interface (templates may call layout.formatDate directly).
export { formatDate, formatDateTime };

/**
 * pdfmake `styles` object used by the document templates that compose
 * this layout. Centralised so a tweak touches one place.
 *
 * @returns {Record<string, object>}
 */
export function commonStyles() {
  return {
    docTitle: { fontSize: 20, bold: true },
    vendorName: { fontSize: 15, bold: true },
    tagline: { fontSize: 8, italics: true, color: '#666666' },
    addressLine: { fontSize: 8, color: '#444444' },
    sectionLabel: { fontSize: 8, bold: true, color: '#888888', characterSpacing: 0.5 },
    partyName: { fontSize: 10, bold: true, color: '#222222' },
    fieldLabel: { fontSize: 8, color: '#666666' },
    fieldValue: { fontSize: 9, color: '#222222' },
    tableHeader: { fontSize: 8.5, bold: true, color: 'white' },
    cell: { fontSize: 8.5, color: '#222222' },
    cellRight: { fontSize: 8.5, color: '#222222', alignment: 'right' },
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

/**
 * Base page definition merged into every document template via spread.
 * Header/footer are NOT set here — templates plug those in because
 * they're closures over the order's vendor data.
 *
 * @returns {object} partial pdfmake docDefinition
 */
export function defaultPageDefinition() {
  return {
    pageSize: 'A4',
    // [left, top, right, bottom]. Generous top for the header band.
    pageMargins: [40, 110, 40, 55],
    defaultStyle: { font: 'Roboto', fontSize: 9, lineHeight: 1.15, color: '#222222' },
  };
}

/**
 * Document-type title shown top-right ("PURCHASE ORDER" / "TAX
 * INVOICE"). Tax invoice is the legally-correct heading for a GST
 * invoice in India.
 *
 * @param {object} order
 * @returns {string}
 */
function docTitleText(order) {
  return order.docType === 'invoice' ? 'TAX INVOICE' : 'PURCHASE ORDER';
}

/**
 * Build the vendor letterhead + document title band.
 *
 * @param {object} order
 * @returns {object} pdfmake content node
 */
export function headerBlock(order) {
  const v = order.vendor;
  const accent = v.accentColor;
  return {
    margin: [0, 0, 0, 6],
    stack: [
      {
        columns: [
          // Accent monogram tile (single-cell borderless table — pdfmake
          // has no border-radius primitive).
          {
            width: 42,
            table: {
              widths: [38],
              heights: [38],
              body: [[{
                text: v.logoMonogram,
                color: 'white',
                bold: true,
                fontSize: 15,
                alignment: 'center',
                margin: [0, 8, 0, 0],
                fillColor: accent,
                border: [false, false, false, false],
              }]],
            },
            layout: 'noBorders',
          },
          {
            width: '*',
            margin: [10, 0, 0, 0],
            stack: [
              { text: v.name, style: 'vendorName', color: accent },
              { text: v.addressLines[0] ?? '', style: 'addressLine' },
              { text: v.addressLines[1] ?? '', style: 'addressLine' },
              { text: `GSTIN: ${v.gstin}   State: ${v.state} (${v.stateCode})`, style: 'addressLine' },
              { text: `${v.phone}   ${v.email}`, style: 'addressLine' },
            ],
          },
          {
            width: 'auto',
            alignment: 'right',
            stack: [{ text: docTitleText(order), style: 'docTitle', color: accent }],
          },
        ],
      },
      {
        margin: [0, 6, 0, 0],
        canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1.5, lineColor: accent }],
      },
    ],
  };
}

/**
 * Build the meta strip (doc no / dates / PO ref / payment terms) above
 * the party panel. Honours the missing-PO-number and missing-date
 * scenarios by conditionally omitting rows.
 *
 * @param {object} order
 * @returns {object} pdfmake content node
 */
export function metaBlock(order) {
  const rows = [];
  const docLabel = order.docType === 'invoice' ? 'Invoice No' : 'PO No';
  rows.push([`${docLabel}:`, order.docId]);
  // Missing-date scenario suppresses the order date entirely.
  if (!order.suppressOrderDate) {
    const dateLabel = order.docType === 'invoice' ? 'Invoice Date' : 'Order Date';
    rows.push([`${dateLabel}:`, formatDate(order.orderDate)]);
  }
  // PO reference printed on invoices; omitted when the PO number is
  // missing (missing-po-number scenario sets it null).
  if (order.docType === 'invoice' && order.poNumber) {
    rows.push(['Buyer PO Ref:', order.poNumber]);
  }
  rows.push([order.docType === 'invoice' ? 'Due Date:' : 'Expected By:', formatDate(order.dueDate)]);
  rows.push(['Payment Terms:', `Net ${order.termDays}`]);

  return {
    margin: [0, 6, 0, 4],
    columns: rows.map(([k, val]) => ({
      width: '*',
      stack: [
        { text: k, style: 'fieldLabel' },
        { text: val, style: 'fieldValue', bold: true },
      ],
    })),
  };
}

/**
 * Build the two-column party panel: vendor (Supplier / From) on the
 * left, buyer (Bill To + Ship To) on the right.
 *
 * @param {object} order
 * @returns {object} pdfmake content node
 */
export function partiesBlock(order) {
  const v = order.vendor;
  const b = order.buyer;

  /**
   * One bordered party card.
   * @param {string} title
   * @param {object} party
   * @returns {object}
   */
  const card = (title, party) => ({
    stack: [
      { text: title, style: 'sectionLabel', margin: [0, 0, 0, 3] },
      { text: party.name, style: 'partyName' },
      { text: party.addressLines[0] ?? '', style: 'addressLine' },
      { text: party.addressLines[1] ?? '', style: 'addressLine' },
      { text: `GSTIN: ${party.gstin}`, style: 'addressLine' },
      { text: `State: ${party.state} (${party.stateCode})`, style: 'addressLine' },
    ],
  });

  return {
    margin: [0, 2, 0, 6],
    columns: [
      { width: '*', ...card(order.docType === 'invoice' ? 'SELLER / SUPPLIER' : 'VENDOR / SUPPLIER', v) },
      { width: '*', ...card('BILL TO / SHIP TO', b) },
    ],
  };
}

/**
 * Build the line-item table. Columns: # / Description / HSN / Qty /
 * Rate / GST% / Amount.
 *
 * @param {object} order
 * @returns {object} pdfmake content node
 */
export function lineItemsTable(order) {
  const accent = order.vendor.accentColor;
  const sym = order.currency.symbol;

  const th = (label, align = 'left') => ({
    text: label, style: 'tableHeader', fillColor: accent, alignment: align, margin: [4, 4, 4, 4],
  });
  const headerRow = [
    th('#'), th('Description'), th('HSN'), th('Qty'), th('Rate', 'right'),
    th('GST%', 'center'), th(`Amount (${sym})`, 'right'),
  ];

  const body = [headerRow];
  order.lines.forEach((line, idx) => {
    const stripe = idx % 2 === 1 ? '#F5F5F5' : null;
    const bc = (content, extra = {}) => {
      const base = typeof content === 'string' ? { text: content } : content;
      return { ...base, style: base.style ?? 'cell', fillColor: stripe, margin: [4, 3, 4, 3], ...extra };
    };
    body.push([
      bc(String(idx + 1)),
      bc(line.description),
      bc(line.hsn),
      bc(`${line.qty} ${line.unit}`),
      bc({ text: formatCurrency(line.unitPrice, sym), style: 'cellRight' }),
      bc({ text: `${line.gstSlab}%`, alignment: 'center' }),
      bc({ text: formatCurrency(line.amount, sym), style: 'cellRight' }),
    ]);
  });

  return {
    margin: [0, 2, 0, 6],
    table: {
      headerRows: 1,
      widths: [16, '*', 48, 'auto', 'auto', 30, 'auto'],
      body,
    },
    layout: 'lightHorizontalLines',
  };
}

/**
 * Build the HSN-wise tax summary table. Shows per-(HSN, slab) taxable
 * value and the CGST/SGST or IGST split. Columns adapt to the tax type.
 *
 * @param {object} order
 * @returns {object} pdfmake content node
 */
export function taxSummary(order) {
  const accent = order.vendor.accentColor;
  const sym = order.currency.symbol;
  const intra = order.intraState;

  const th = (label, align = 'right') => ({
    text: label, style: 'tableHeader', fillColor: accent, alignment: align, margin: [4, 3, 4, 3],
  });

  const header = intra
    ? [th('HSN/SAC', 'left'), th('Taxable'), th('CGST%', 'center'), th('CGST'), th('SGST%', 'center'), th('SGST'), th('Total Tax')]
    : [th('HSN/SAC', 'left'), th('Taxable'), th('IGST%', 'center'), th('IGST'), th('Total Tax')];

  const body = [header];
  for (const g of order.hsnSummary) {
    const c = (txt, align = 'right') => ({ text: txt, style: 'cell', alignment: align, margin: [4, 2, 4, 2] });
    if (intra) {
      body.push([
        c(g.hsn, 'left'), c(formatCurrency(g.taxable, sym)),
        c(`${g.cgstRate}%`, 'center'), c(formatCurrency(g.cgst, sym)),
        c(`${g.sgstRate}%`, 'center'), c(formatCurrency(g.sgst, sym)),
        c(formatCurrency(g.totalTax, sym)),
      ]);
    } else {
      body.push([
        c(g.hsn, 'left'), c(formatCurrency(g.taxable, sym)),
        c(`${g.igstRate}%`, 'center'), c(formatCurrency(g.igst, sym)),
        c(formatCurrency(g.totalTax, sym)),
      ]);
    }
  }

  return {
    margin: [0, 2, 0, 6],
    stack: [
      { text: 'HSN / SAC-wise Tax Summary', style: 'h2', margin: [0, 4, 0, 3] },
      {
        table: {
          headerRows: 1,
          widths: intra ? ['auto', '*', 'auto', '*', 'auto', '*', '*'] : ['auto', '*', 'auto', '*', '*'],
          body,
        },
        layout: 'lightHorizontalLines',
      },
    ],
  };
}

/**
 * Build the right-aligned totals box: subtotal, discount, taxable,
 * CGST/SGST or IGST, round-off, and the accent-filled grand total.
 * Followed by the amount-in-words line.
 *
 * @param {object} order
 * @returns {object} pdfmake content node
 */
export function totalsBlock(order) {
  const accent = order.vendor.accentColor;
  const sym = order.currency.symbol;
  const t = order.totals;

  const row = (label, value, opts = {}) => [
    { text: label, style: opts.grand ? 'grandLabel' : 'totalsLabel', fillColor: opts.grand ? accent : null, margin: [6, 3, 6, 3], border: [false, false, false, false] },
    { text: value, style: opts.grand ? 'grandValue' : 'totalsValue', fillColor: opts.grand ? accent : null, margin: [6, 3, 6, 3], border: [false, false, false, false] },
  ];

  const rows = [
    row('Subtotal', formatCurrency(t.subtotal, sym)),
  ];
  if (t.discount > 0) rows.push(row(`Discount (${t.discountPct}%)`, `- ${formatCurrency(t.discount, sym)}`));
  rows.push(row('Taxable Value', formatCurrency(t.taxableTotal, sym)));
  if (order.intraState) {
    rows.push(row('CGST', formatCurrency(t.cgst, sym)));
    rows.push(row('SGST', formatCurrency(t.sgst, sym)));
  } else {
    rows.push(row('IGST', formatCurrency(t.igst, sym)));
  }
  if (t.roundOff !== 0) rows.push(row('Round Off', formatCurrency(t.roundOff, sym)));
  rows.push(row('GRAND TOTAL', formatCurrency(t.grandTotal, sym), { grand: true }));

  return {
    margin: [0, 2, 0, 4],
    columns: [
      { width: '*', text: '' },
      {
        width: 'auto',
        table: { widths: ['auto', 'auto'], body: rows },
        layout: 'noBorders',
      },
    ],
  };
}

/**
 * Build the amount-in-words line (composed by templates after totals).
 *
 * @param {object} order
 * @returns {object} pdfmake content node
 */
export function amountWordsLine(order) {
  return {
    margin: [0, 2, 0, 6],
    text: `Amount in words: ${amountInWords(order.totals.grandTotal)}`,
    style: 'wordsLine',
  };
}

/**
 * Build the authorised-signatory block (right-aligned), with the
 * synthetic-data disclaimer below. Signatory is deterministic per docId.
 *
 * @param {object} order
 * @returns {object} pdfmake content node
 */
export function signatureBlock(order) {
  const sig = signatoryFor(order.docId);
  return {
    margin: [0, 12, 0, 0],
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
      { margin: [0, 12, 0, 0], text: DISCLAIMER, style: 'disclaimer' },
    ],
  };
}

/**
 * Build the page footer factory. pdfmake passes (currentPage, pageCount).
 *
 * @param {object} order
 * @returns {(currentPage:number, pageCount:number) => object}
 */
export function pageFooter(order) {
  return (currentPage, pageCount) => ({
    margin: [40, 8, 40, 0],
    stack: [
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: '#CCCCCC' }] },
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
