/**
 * Purchase-Order (PO) document template.
 *
 * # Purpose
 * Composes a fully-filled order whose `docType === 'po'` into a pdfmake
 * docDefinition. A purchase order is the BUYER's request to the vendor;
 * relative to a tax invoice it OMITS the invoice-specific bits — there
 * is no "amount in words" legal requirement, no bank-payment details,
 * and the totals are framed as an estimate. It still carries the full
 * line-item table and an HSN-wise tax estimate so DocRithm's extraction
 * sees a realistic, GST-aware PO.
 *
 * # Role in the pipeline
 * Called by src/render.js (dispatched on docType) after the generator
 * has produced a populated order. Returns a docDefinition pdfmake
 * serialises to bytes.
 *
 * # Design decisions
 * - Header repeats on every page via pdfmake's `header` factory so a
 *   multi-page (overflow-scenario) PO keeps its letterhead.
 * - The layout (clean-modern, faxed-scan, …) is resolved from
 *   `order.layoutKey`, assigned at planning time and never re-rolled.
 */

import { layoutFor } from '../layouts/index.js';

/**
 * Build the pdfmake docDefinition for a purchase order.
 *
 * @param {object} order — fully populated order from `fillOrder`
 * @returns {object} pdfmake docDefinition
 */
export function buildDocDefinition(order) {
  const layout = layoutFor(order.layoutKey);

  // Some layouts paint a full-bleed page background (e.g. the formal
  // letterhead band, the faxed-scan tint). They expose it via an
  // optional `pageBackground(order)` factory; wire it into the
  // doc-level `background` so pdfmake paints it beneath all content.
  const background = layout.pageBackground ? layout.pageBackground(order) : undefined;

  return {
    ...layout.defaultPageDefinition(),
    ...(background ? { background } : {}),
    // Repeat the vendor letterhead on every page.
    header: () => ({ margin: [40, 18, 40, 0], stack: [layout.headerBlock(order)] }),
    footer: layout.pageFooter(order),
    content: [
      layout.metaBlock(order),
      layout.partiesBlock(order),
      layout.lineItemsTable(order),
      layout.taxSummary(order),
      layout.totalsBlock(order),
      // Terms note specific to a PO (no bank details / no words line).
      {
        margin: [0, 8, 0, 0],
        stack: [
          { text: 'Terms & Conditions', style: 'h2' },
          {
            margin: [0, 2, 0, 0],
            ul: [
              'Goods to be supplied as per the specifications above.',
              `Payment terms: Net ${order.termDays} from delivery.`,
              'Prices are inclusive of applicable GST as itemised.',
              'This is a purchase order, not a tax invoice.',
            ],
            style: 'fieldValue',
          },
        ],
      },
      layout.signatureBlock(order),
    ],
    styles: layout.commonStyles(),
  };
}
