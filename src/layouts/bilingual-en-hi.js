/**
 * Layout: Bilingual English + Hindi (Devanagari).
 *
 * # Purpose
 * A bilingual purchase document where every LABEL appears in both
 * English and Devanagari Hindi (English first, Hindi in parentheses or
 * stacked). Values (amounts, GSTINs, dates, doc IDs) stay in English —
 * exactly how real Indian bilingual commercial documents are printed.
 * Crucially, when the VENDOR carries a Devanagari name (`vendor.nameHi`)
 * it is rendered in the header, which is the whole point of the
 * `bilingual-devanagari` scenario: it stresses DocRithm's Tally
 * fuzzy-match on a non-Latin party name. Drives layout #7 of the
 * pluggable system.
 *
 * # Font-family contract
 * Devanagari text is tagged inline with `font: 'NotoSansDevanagari'`.
 * The renderer vendors the Noto Sans Devanagari TTFs under
 * `assets/fonts/` and registers the family; if missing it falls back to
 * Roboto (Devanagari renders as .notdef boxes) — documented graceful
 * degradation, not handled here.
 *
 * # Layout interface
 * Exports the full shared layout interface (see clean-modern.js). Money
 * goes through shared `format.js` helpers.
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

const DEVA = 'NotoSansDevanagari';

/**
 * English-to-Hindi label dictionary. Lookup is by EXACT English label.
 * Translations follow common Indian commercial-form usage.
 *
 * @type {Readonly<Record<string, string>>}
 */
const EN_HI = Object.freeze({
  'Tax Invoice': 'कर बीजक',
  'Purchase Order': 'क्रय आदेश',
  'Invoice No': 'बीजक संख्या',
  'PO No': 'आदेश संख्या',
  'Invoice Date': 'बीजक तिथि',
  'Order Date': 'आदेश तिथि',
  'Buyer PO Ref': 'क्रेता आदेश संदर्भ',
  'Due Date': 'देय तिथि',
  'Expected By': 'अपेक्षित तिथि',
  'Payment Terms': 'भुगतान शर्तें',
  'Vendor / Supplier': 'विक्रेता / आपूर्तिकर्ता',
  'Seller / Supplier': 'विक्रेता / आपूर्तिकर्ता',
  'Bill To / Ship To': 'बिल / प्रेषण को',
  Description: 'विवरण',
  Qty: 'मात्रा',
  Rate: 'दर',
  Amount: 'राशि',
  Subtotal: 'उप-योग',
  Discount: 'छूट',
  'Taxable Value': 'कर योग्य मूल्य',
  'Round Off': 'राउंड ऑफ',
  'GRAND TOTAL': 'कुल योग',
  'Amount in words': 'राशि शब्दों में',
  'Authorised Signatory': 'अधिकृत हस्ताक्षरकर्ता',
  GSTIN: 'जीएसटीआईएन',
  State: 'राज्य',
});

/**
 * Build a bilingual inline text node: `English (हिन्दी)`. Returns a
 * plain string when no translation exists. The Hindi fragment carries
 * the Devanagari font so it renders correctly even though the default
 * font is Roboto.
 *
 * @param {string} en - English label
 * @param {object} [opts] - { bold, color, fontSize }
 * @returns {object} pdfmake inline-array text node
 */
function bi(en, opts = {}) {
  const hi = EN_HI[en];
  const base = { bold: opts.bold, color: opts.color, fontSize: opts.fontSize };
  if (!hi) return { text: en, ...base };
  return {
    text: [
      { text: en, ...base },
      { text: ' (', ...base },
      { text: hi, font: DEVA, ...base },
      { text: ')', ...base },
    ],
  };
}

/** @returns {Record<string, object>} */
export function commonStyles() {
  return {
    docTitle: { fontSize: 16, bold: true },
    vendorName: { fontSize: 14, bold: true },
    addressLine: { fontSize: 8, color: '#444444', lineHeight: 1.25 },
    sectionLabel: { fontSize: 8, bold: true, color: '#888888' },
    partyName: { fontSize: 10, bold: true },
    fieldLabel: { fontSize: 8, color: '#666666', lineHeight: 1.3 },
    fieldValue: { fontSize: 9, color: '#222222' },
    tableHeader: { fontSize: 8, bold: true, color: 'white', lineHeight: 1.2 },
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
    disclaimer: { fontSize: 7, italics: true, color: '#888888', lineHeight: 1.25 },
    footerSmall: { fontSize: 7, color: '#888888' },
  };
}

/** @returns {object} */
export function defaultPageDefinition() {
  return {
    pageSize: 'A4',
    pageMargins: [40, 110, 40, 58],
    defaultStyle: { font: 'Roboto', fontSize: 9, lineHeight: 1.18, color: '#222222' },
  };
}

/**
 * @param {object} order
 * @returns {string}
 */
function docTitleEn(order) {
  return order.docType === 'invoice' ? 'Tax Invoice' : 'Purchase Order';
}

/**
 * Vendor letterhead. When the vendor carries a Devanagari name
 * (`nameHi`) it is printed on its own line below the English name — the
 * Tally fuzzy-match stress target.
 * @param {object} order
 * @returns {object}
 */
export function headerBlock(order) {
  const v = order.vendor;
  const accent = v.accentColor;
  const nameStack = [{ text: v.name, style: 'vendorName', color: accent }];
  if (v.nameHi) {
    nameStack.push({ text: v.nameHi, font: DEVA, style: 'vendorName', color: accent, fontSize: 13 });
  }
  return {
    margin: [0, 0, 0, 6],
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
              ...nameStack,
              { text: `${v.addressLines[0] ?? ''}, ${v.addressLines[1] ?? ''}`, style: 'addressLine' },
              { text: `GSTIN: ${v.gstin}   State: ${v.state} (${v.stateCode})`, style: 'addressLine' },
            ],
          },
          {
            width: 'auto',
            alignment: 'right',
            stack: [
              { text: docTitleEn(order).toUpperCase(), style: 'docTitle', color: accent },
              { text: EN_HI[docTitleEn(order)] ?? '', font: DEVA, style: 'docTitle', color: accent, fontSize: 12, alignment: 'right' },
            ],
          },
        ],
      },
      { margin: [0, 6, 0, 0], canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1.5, lineColor: accent }] },
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
    margin: [0, 6, 0, 4],
    columns: rows.map(([k, val]) => ({
      width: '*',
      stack: [
        { ...bi(k), style: 'fieldLabel' },
        { text: val, style: 'fieldValue', bold: true },
      ],
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
  const card = (title, party) => {
    const stack = [
      { ...bi(title), style: 'sectionLabel', margin: [0, 0, 0, 3] },
      { text: party.name, style: 'partyName' },
    ];
    if (party.nameHi) stack.push({ text: party.nameHi, font: DEVA, style: 'partyName' });
    stack.push(
      { text: `${party.addressLines[0] ?? ''}, ${party.addressLines[1] ?? ''}`, style: 'addressLine' },
      { text: `GSTIN: ${party.gstin}   State: ${party.state} (${party.stateCode})`, style: 'addressLine' },
    );
    return { stack };
  };
  return {
    margin: [0, 2, 0, 6],
    columns: [
      { width: '*', ...card(order.docType === 'invoice' ? 'Seller / Supplier' : 'Vendor / Supplier', v) },
      { width: '*', ...card('Bill To / Ship To', b) },
    ],
  };
}

/**
 * Bilingual table header cell: English on line 1, Hindi on line 2.
 * @param {string} en
 * @param {string} accent
 * @param {string} align
 * @returns {object}
 */
function th(en, accent, align = 'left') {
  const hi = EN_HI[en];
  return {
    stack: hi
      ? [
          { text: en, bold: true, color: 'white', alignment: align },
          { text: hi, font: DEVA, bold: true, color: 'white', alignment: align, fontSize: 7 },
        ]
      : [{ text: en, bold: true, color: 'white', alignment: align }],
    fillColor: accent,
    style: 'tableHeader',
    margin: [4, 3, 4, 3],
  };
}

/**
 * @param {object} order
 * @returns {object}
 */
export function lineItemsTable(order) {
  const accent = order.vendor.accentColor;
  const sym = order.currency.symbol;
  const header = [th('#', accent), th('Description', accent), th('HSN', accent), th('Qty', accent), th('Rate', accent, 'right'), th('GST%', accent, 'center'), th('Amount', accent, 'right')];
  const body = [header];
  order.lines.forEach((line, idx) => {
    const stripe = idx % 2 === 1 ? '#F5F5F5' : null;
    const c = (txt, style = 'cell', align) => ({ text: txt, style, alignment: align, fillColor: stripe, margin: [4, 2, 4, 2] });
    body.push([
      c(String(idx + 1)), c(line.description), c(line.hsn), c(`${line.qty} ${line.unit}`),
      c(formatCurrency(line.unitPrice, sym), 'cellRight'), c(`${line.gstSlab}%`, 'cell', 'center'),
      c(formatCurrency(line.amount, sym), 'cellRight'),
    ]);
  });
  return {
    margin: [0, 2, 0, 6],
    table: { headerRows: 1, widths: [16, '*', 48, 'auto', 'auto', 30, 'auto'], body },
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
  const thp = (label, align = 'right') => ({ text: label, style: 'tableHeader', fillColor: accent, alignment: align, margin: [4, 3, 4, 3] });
  const header = intra
    ? [thp('HSN/SAC', 'left'), thp('Taxable'), thp('CGST%', 'center'), thp('CGST'), thp('SGST%', 'center'), thp('SGST'), thp('Total Tax')]
    : [thp('HSN/SAC', 'left'), thp('Taxable'), thp('IGST%', 'center'), thp('IGST'), thp('Total Tax')];
  const body = [header];
  for (const g of order.hsnSummary) {
    const c = (txt, align = 'right') => ({ text: txt, style: 'cell', alignment: align, margin: [4, 2, 4, 2] });
    body.push(intra
      ? [c(g.hsn, 'left'), c(formatCurrency(g.taxable, sym)), c(`${g.cgstRate}%`, 'center'), c(formatCurrency(g.cgst, sym)), c(`${g.sgstRate}%`, 'center'), c(formatCurrency(g.sgst, sym)), c(formatCurrency(g.totalTax, sym))]
      : [c(g.hsn, 'left'), c(formatCurrency(g.taxable, sym)), c(`${g.igstRate}%`, 'center'), c(formatCurrency(g.igst, sym)), c(formatCurrency(g.totalTax, sym))]);
  }
  return {
    margin: [0, 2, 0, 6],
    stack: [
      { text: [{ text: 'HSN / SAC-wise Tax Summary  ' }, { text: '(कर सारांश)', font: DEVA }], style: 'h2', margin: [0, 4, 0, 3] },
      { table: { headerRows: 1, widths: intra ? ['auto', '*', 'auto', '*', 'auto', '*', '*'] : ['auto', '*', 'auto', '*', '*'], body }, layout: 'lightHorizontalLines' },
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
    { ...bi(label, grand ? { bold: true, color: 'white' } : {}), style: grand ? 'grandLabel' : 'totalsLabel', alignment: 'right', fillColor: grand ? accent : null, margin: [6, 3, 6, 3], border: [false, false, false, false] },
    { text: value, style: grand ? 'grandValue' : 'totalsValue', fillColor: grand ? accent : null, margin: [6, 3, 6, 3], border: [false, false, false, false] },
  ];
  const rows = [row('Subtotal', formatCurrency(t.subtotal, sym))];
  if (t.discount > 0) rows.push(row('Discount', `- ${formatCurrency(t.discount, sym)} (${t.discountPct}%)`));
  rows.push(row('Taxable Value', formatCurrency(t.taxableTotal, sym)));
  if (order.intraState) {
    rows.push([{ text: 'CGST', style: 'totalsLabel', margin: [6, 3, 6, 3], border: [false, false, false, false] }, { text: formatCurrency(t.cgst, sym), style: 'totalsValue', margin: [6, 3, 6, 3], border: [false, false, false, false] }]);
    rows.push([{ text: 'SGST', style: 'totalsLabel', margin: [6, 3, 6, 3], border: [false, false, false, false] }, { text: formatCurrency(t.sgst, sym), style: 'totalsValue', margin: [6, 3, 6, 3], border: [false, false, false, false] }]);
  } else {
    rows.push([{ text: 'IGST', style: 'totalsLabel', margin: [6, 3, 6, 3], border: [false, false, false, false] }, { text: formatCurrency(t.igst, sym), style: 'totalsValue', margin: [6, 3, 6, 3], border: [false, false, false, false] }]);
  }
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
  return {
    margin: [0, 2, 0, 6],
    text: [
      { text: 'Amount in words ' },
      { text: '(राशि शब्दों में)', font: DEVA },
      { text: `: ${amountInWords(order.totals.grandTotal)}` },
    ],
    style: 'wordsLine',
  };
}

/**
 * @param {object} order
 * @returns {object}
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
          { ...bi('Authorised Signatory'), style: 'signatureMeta', alignment: 'right' },
        ],
      },
      { margin: [0, 12, 0, 0], text: DISCLAIMER, style: 'disclaimer' },
      {
        text: 'अस्वीकरण: यह दस्तावेज़ docrithm-pdf-gen द्वारा निर्मित सिंथेटिक परीक्षण डेटा है। '
          + 'यह किसी वास्तविक क्रय या लेन-देन का प्रतिनिधित्व नहीं करता।',
        font: DEVA,
        style: 'disclaimer',
        margin: [0, 2, 0, 0],
      },
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
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: '#CCCCCC' }] },
      {
        margin: [0, 4, 0, 0],
        columns: [
          { width: 'auto', text: [{ text: 'Page ' }, { text: 'पृष्ठ', font: DEVA }, { text: ` ${currentPage}/${pageCount}` }], style: 'footerSmall' },
          { width: '*', text: `${order.docId}`, style: 'footerSmall', alignment: 'center' },
          { width: 'auto', text: [{ text: 'Synthetic ' }, { text: '(सिंथेटिक)', font: DEVA }], style: 'footerSmall', alignment: 'right' },
        ],
      },
    ],
  });
}
