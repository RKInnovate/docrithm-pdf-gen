/**
 * Layout registry — 7 visual layouts for the synthetic PO/invoice generator.
 *
 * # Purpose
 * Each order shell carries a `layoutKey` string (assigned by the order
 * planner) naming the visual layout the document template should
 * compose with. This module is the only place where layout module
 * paths are wired up; document templates and the renderer go through
 * `layoutFor(key)` rather than importing layouts directly, so adding
 * or removing a layout only touches this file.
 *
 * # The 7 layouts
 *   clean-modern        — modern corporate look (default reference)
 *   classic-bordered    — full black grid, serif headings, ALL-CAPS
 *   compact-dense       — dot-leader rows, tight spacing
 *   letterhead-formal   — large letterhead band, borderless items
 *   landscape-wide      — A4 landscape, wide line-item table
 *   faxed-scan          — grey low-contrast photocopy / fax artefacts
 *   bilingual-en-hi     — English + Devanagari (Hindi) bilingual labels
 *
 * # Layout interface
 * Every layout module MUST export the same named functions, with the
 * same signatures, so document templates can compose them
 * interchangeably. The canonical contract lives in the docstring of
 * `./clean-modern.js`; copy it verbatim into any new layout you add.
 * The functions are:
 *   formatDate(d)             → string
 *   formatDateTime(d)         → string
 *   commonStyles()            → pdfmake styles object
 *   defaultPageDefinition()   → partial docDefinition
 *   headerBlock(order)        → content node — vendor letterhead + doc title
 *   partiesBlock(order)       → content node — vendor + bill-to/ship-to
 *   lineItemsTable(order)     → content node — line-item grid
 *   totalsBlock(order)        → content node — subtotal/discount/tax/total
 *   taxSummary(order)         → content node — HSN-wise tax breakup table
 *   signatureBlock(order)     → content node — authorised-signatory block
 *   pageFooter(order)         → (page, total) => content node
 *
 * # Selection
 * `pickLayout(rng)` returns a uniformly random layoutKey. Use it at
 * planning time (inside `generators/orders.js`) so a given document has
 * a stable layoutKey for its entire lifetime — never re-pick at render
 * time, or the same document could render different bytes per run.
 */

import * as cleanModern from './clean-modern.js';
import * as classicBordered from './classic-bordered.js';
import * as compactDense from './compact-dense.js';
import * as letterheadFormal from './letterhead-formal.js';
import * as landscapeWide from './landscape-wide.js';
import * as faxedScan from './faxed-scan.js';
import * as bilingualEnHi from './bilingual-en-hi.js';

/**
 * Registry — `Object.freeze` prevents accidental mutation at runtime.
 * Insertion order is the iteration order used by `LAYOUT_KEYS`.
 *
 * @type {Readonly<Record<string, object>>}
 */
export const LAYOUTS = Object.freeze({
  'clean-modern': cleanModern,
  'classic-bordered': classicBordered,
  'compact-dense': compactDense,
  'letterhead-formal': letterheadFormal,
  'landscape-wide': landscapeWide,
  'faxed-scan': faxedScan,
  'bilingual-en-hi': bilingualEnHi,
});

/**
 * Stable ordered list of layout keys. Generators, the CLI filter, and
 * tests can pick from this directly; the order is the insertion order.
 *
 * @type {ReadonlyArray<string>}
 */
export const LAYOUT_KEYS = Object.freeze(Object.keys(LAYOUTS));

/**
 * Pick one layout key uniformly at random from the registry.
 *
 * Call this at planning time and stash the result on the shell — never
 * re-roll at render time, otherwise the same document can render
 * different bytes on re-run, breaking the deterministic-per-seed
 * contract.
 *
 * @param {import('../seedrand.js').Rng} rng — seeded RNG instance
 * @returns {string} a key present in LAYOUTS
 */
export function pickLayout(rng) {
  return rng.pick(LAYOUT_KEYS);
}

/**
 * Resolve a layout module by key, with a clear error when the key is
 * unknown. Document templates and the renderer use this single dispatch
 * point to avoid scattering layout-import paths through the codebase.
 *
 * @param {string} key — one of the keys in LAYOUTS
 * @returns {object} the layout module (with all interface exports)
 * @throws {Error} if `key` is not a registered layout
 */
export function layoutFor(key) {
  const layout = LAYOUTS[key];
  if (!layout) {
    throw new Error(
      `docrithm-pdf-gen: unknown layoutKey '${key}'. ` +
        `Known: ${LAYOUT_KEYS.join(', ')}`,
    );
  }
  return layout;
}
