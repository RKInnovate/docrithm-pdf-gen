/**
 * Purchase-Invoice / Tax-Invoice document template.
 *
 * # Purpose
 * Composes a fully-filled order whose `docType === 'invoice'` into a
 * pdfmake docDefinition. A tax invoice is the SELLER's demand for
 * payment and is the legally-significant GST document; relative to a
 * purchase order it ADDS the invoice-specific bits — the "amount in
 * words" line (a statutory requirement on Indian invoices), bank /
 * payment details for remittance, and a declaration line. It shares the
 * same line-item table, HSN tax summary and totals as the PO.
 *
 * # Role in the pipeline
 * Called by src/render.js (dispatched on docType) after the generator
 * has produced a populated order. Returns a docDefinition pdfmake
 * serialises to bytes.
 *
 * # Design decisions
 * - Bank details are deterministic per docId (shared `bankFor`) so a
 *   re-run prints the same account — preserving byte-determinism.
 * - The layout is resolved from `order.layoutKey`, assigned at planning
 *   time and never re-rolled.
 */

import { layoutFor } from '../layouts/index.js';
import { bankFor } from '../format.js';

/**
 * Build the pdfmake docDefinition for a tax invoice.
 *
 * @param {object} order — fully populated order from `fillOrder`
 * @returns {object} pdfmake docDefinition
 */
export function buildDocDefinition(order) {
  const layout = layoutFor(order.layoutKey);
  const bank = bankFor(order.docId);

  // Optional full-bleed page background painted beneath all content
  // (formal letterhead band, faxed-scan tint). See purchase-order.js.
  const background = layout.pageBackground ? layout.pageBackground(order) : undefined;

  return {
    ...layout.defaultPageDefinition(),
    ...(background ? { background } : {}),
    header: () => ({ margin: [40, 18, 40, 0], stack: [layout.headerBlock(order)] }),
    footer: layout.pageFooter(order),
    content: [
      layout.metaBlock(order),
      layout.partiesBlock(order),
      layout.lineItemsTable(order),
      layout.taxSummary(order),
      layout.totalsBlock(order),
      // Statutory amount-in-words line (invoice only).
      layout.amountWordsLine(order),
      // Bank / payment details for remittance (invoice only — a PO has
      // no payment instruction).
      {
        margin: [0, 6, 0, 0],
        columns: [
          {
            width: '*',
            stack: [
              { text: 'Bank / Payment Details', style: 'h2', margin: [0, 0, 0, 3] },
              { text: `Bank: ${bank.bank}`, style: 'fieldValue' },
              { text: `A/c No: ${bank.account}`, style: 'fieldValue' },
              { text: `IFSC: ${bank.ifsc}   Branch: ${bank.branch}`, style: 'fieldValue' },
            ],
          },
          {
            width: '*',
            stack: [
              { text: 'Declaration', style: 'h2', margin: [0, 0, 0, 3] },
              {
                text:
                  'We declare that this invoice shows the actual price of the '
                  + 'goods described and that all particulars are true and correct.',
                style: 'fieldValue',
              },
            ],
          },
        ],
      },
      layout.signatureBlock(order),
    ],
    styles: layout.commonStyles(),
  };
}
