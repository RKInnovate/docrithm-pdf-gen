/**
 * Order / invoice shell planner + two-pass line-item filler.
 *
 * # Purpose
 * Produces the party + scheduling + scenario skeleton for every PO /
 * invoice the generator will emit (`planOrders`), then fills each
 * skeleton with line items and a fully-computed tax breakdown
 * (`fillOrder`). The planning pass owns the *population shape*
 * (doc-type mix, vendor/buyer pairing, which scenario each document
 * exercises, the visual layout); the fill pass owns the *arithmetic*
 * (quantities, prices, discount, CGST/SGST/IGST, round-off, total).
 *
 * # Why a separate planning pass (mirrors lab-pdf-gen/patients.js)
 * Splitting plan→fill lets us reason about scenario coverage as a
 * weighted population without tangling it into per-line arithmetic.
 * The scenario each document exercises is decided ONCE at plan time,
 * recorded in `scenarioTags`, and never re-rolled — so the on-disk
 * filename (which encodes the tag) is reproducible and a failing
 * sample is replayable from its name alone.
 *
 * # Why two passes inside fillOrder
 * Indian GST totals form a dependency chain: per-line amount →
 * subtotal → discount → taxable value → per-slab CGST+SGST (intra)
 * OR IGST (inter) → round-off → grand total. Sampling the raw inputs
 * first (pass 1) and then deriving every computed money field in a
 * clean second pass (pass 2) keeps the formula order explicit and
 * correct, exactly like the computed-analyte resolver in
 * lab-pdf-gen/analytes.js. Every division is guarded so a degenerate
 * sample can never put NaN/Infinity into a printed invoice.
 *
 * # Determinism
 * All randomness flows through a `createRng` instance supplied by the
 * caller. Same seed in → same shells out, in the same order, with the
 * same doc IDs, amounts and layout choices. Dates derive from the
 * `now` anchor the caller threads in (the CLI's `--now`), so pin BOTH
 * `--seed` and `--now` for byte-identical reruns. No `Math.random`,
 * no `Date.now()` anywhere in this module.
 */

import { pickVendor, pickBuyer, pickBuyerSameState, pickBuyerOtherState } from '../vendors.js';
import { pickLayout, LAYOUT_KEYS } from '../layouts/index.js';

// 12 months of trailing history, in milliseconds. Order dates are
// sampled back from the `now` anchor across this window so the
// documents look like a year of realistic procurement traffic.
const TWELVE_MONTHS_MS = 12 * 30 * 24 * 60 * 60 * 1000;

// Net-payment-term options (days). Net 30 dominates Indian B2B.
const PAYMENT_TERM_DAYS = [15, 30, 30, 30, 45, 60];

// Currency symbols. The vast majority of documents are INR (₹); a few
// edge-case documents print $/€ to stress multi-currency extraction.
const CURRENCY_INR = { code: 'INR', symbol: '₹' }; // ₹
const CURRENCY_USD = { code: 'USD', symbol: '$' };
const CURRENCY_EUR = { code: 'EUR', symbol: '€' }; // €

/**
 * Scenario buckets. Weights mirror the bucket-weighting philosophy of
 * lab-pdf-gen/analytes.js: a dominant "clean" bucket (~60%) with edge
 * cases sprinkled in. Each bucket's `tag` is recorded on the shell and
 * encoded into the output filename. `apply(shell, ctx)` mutates the
 * shell at PLAN time to set up the scenario (forcing a tax type,
 * marking overflow, dropping a field, etc.); the heavy lifting that
 * needs sampled amounts happens later in fillOrder, gated on the tag.
 *
 * Order is stable for reproducibility — do not reorder without
 * accepting that every downstream RNG draw shifts.
 *
 * @type {ReadonlyArray<{tag:string, weight:number, apply:Function}>}
 */
const SCENARIO_BUCKETS = [
  {
    // Plain, well-formed document. The dominant bucket.
    tag: 'normal',
    weight: 60,
    apply() {
      /* no-op: a normal document needs no special setup */
    },
  },
  {
    // Force INTER-state pairing → IGST. (Normal docs may also be
    // inter-state by chance; this bucket guarantees the branch is hit.)
    tag: 'igst-interstate',
    weight: 7,
    apply(shell, { rng }) {
      shell.buyer = pickBuyerOtherState(rng, shell.vendor);
    },
  },
  {
    // Force INTRA-state pairing → CGST+SGST.
    tag: 'cgst-sgst-intrastate',
    weight: 7,
    apply(shell, { rng }) {
      shell.buyer = pickBuyerSameState(rng, shell.vendor);
    },
  },
  {
    // Multi-page overflow: 40+ line items push onto a 2nd/3rd page.
    tag: 'multipage-overflow',
    weight: 5,
    apply(shell) {
      shell.forceLineItems = 42 + (shell.docId.length % 8); // 42..49, stable
    },
  },
  {
    // A non-INR currency symbol (₹ → $ or €) to stress extraction.
    tag: 'foreign-currency',
    weight: 4,
    apply(shell, { rng }) {
      shell.currency = rng.bool(0.5) ? CURRENCY_USD : CURRENCY_EUR;
    },
  },
  {
    // A free / zero-value line (qty>0 but unit price 0, e.g. a sample
    // or promotional item) to stress per-line amount = 0 handling.
    tag: 'zero-value-line',
    weight: 3,
    apply(shell) {
      shell.injectZeroLine = true;
    },
  },
  {
    // Very long vendor + item description strings (column wrap stress).
    tag: 'long-strings',
    weight: 3,
    apply(shell) {
      shell.forceLongDescriptions = true;
    },
  },
  {
    // Missing PO number entirely (extraction must tolerate absence).
    tag: 'missing-po-number',
    weight: 3,
    apply(shell) {
      shell.poNumber = null;
    },
  },
  {
    // Missing order date (extraction must tolerate absence).
    tag: 'missing-date',
    weight: 3,
    apply(shell) {
      shell.suppressOrderDate = true;
    },
  },
  {
    // Bilingual / Devanagari vendor name (Tally fuzzy-match stress).
    // Force the bilingual layout AND a vendor that has a Hindi name.
    tag: 'bilingual-devanagari',
    weight: 2,
    apply(shell, { rng }) {
      shell.layoutKey = 'bilingual-en-hi';
      // Re-pick the vendor from those carrying a Devanagari name so the
      // Hindi rendering actually has content to show.
      const devVendors = shell.vendorPool.filter((v) => v.nameHi);
      if (devVendors.length > 0) shell.vendor = rng.pick(devVendors);
    },
  },
  {
    // Faxed / noisy low-contrast scan look (OCR stress). Force layout.
    tag: 'faxed-scan',
    weight: 2,
    apply(shell) {
      shell.layoutKey = 'faxed-scan';
    },
  },
  {
    // Landscape orientation, wide line-item table. Force layout.
    tag: 'landscape',
    weight: 1,
    apply(shell) {
      shell.layoutKey = 'landscape-wide';
    },
  },
];

/**
 * Long-description filler text appended to vendor name + an item
 * description when the `long-strings` scenario is active. Static so the
 * output stays deterministic.
 */
const LONG_SUFFIX =
  ' — Authorised Channel Partner, Bulk Procurement Division, '
  + 'covering Industrial / Institutional / Government supply with '
  + 'extended warranty, on-site service and consignment-stock options';

/**
 * Two-digit zero-pad helper. Inlined to avoid a date library
 * (forbidden by CLAUDE.md).
 *
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Build the document ID + (optional) PO number pair for one document.
 *
 * Real procurement docs carry a system-generated document number; an
 * invoice additionally references the buyer's PO number. Both derive
 * from the seeded RNG so they are reproducible. The `docId` is always
 * present (it anchors the filename); the PO number is sometimes
 * suppressed later by the `missing-po-number` scenario.
 *
 * @param {ReturnType<import('../seedrand.js').createRng>} rng
 * @param {'po'|'invoice'} docType
 * @param {Date} orderDate
 * @param {number} sequence - monotonic counter across the whole run
 * @returns {{docId:string, poNumber:string}}
 */
export function buildDocIds(rng, docType, orderDate, sequence) {
  const year = orderDate.getFullYear();
  const fy = `${year}-${pad2((year + 1) % 100)}`; // Indian financial-year style, e.g. 2026-27
  const seq = String(sequence).padStart(5, '0');
  // Document number prefix differs by type so a reviewer can tell PO
  // from invoice at a glance even from the ID alone.
  const prefix = docType === 'invoice' ? 'INV' : 'PO';
  const docId = `${prefix}/${fy}/${seq}`;
  // PO number an invoice references (or the PO's own buyer-side ref).
  const poSuffix = String(rng.int(1000, 9999));
  const poNumber = `PO-${year}-${poSuffix}`;
  return { docId, poNumber };
}

/**
 * Pick one scenario bucket by weight.
 *
 * @param {ReturnType<import('../seedrand.js').createRng>} rng
 * @returns {(typeof SCENARIO_BUCKETS)[number]}
 */
function pickScenario(rng) {
  return rng.weighted(SCENARIO_BUCKETS, (b) => b.weight);
}

/**
 * Compose an order date inside the trailing 12 months and a derived
 * due date `termDays` later.
 *
 * @param {ReturnType<import('../seedrand.js').createRng>} rng
 * @param {Date} now
 * @returns {{orderDate:Date, dueDate:Date, termDays:number}}
 */
function randomOrderAndDueDate(rng, now) {
  const offsetMs = rng.int(0, TWELVE_MONTHS_MS);
  const orderDate = new Date(now.getTime() - offsetMs);
  const termDays = rng.pick(PAYMENT_TERM_DAYS);
  const dueDate = new Date(orderDate.getTime() + termDays * 24 * 60 * 60 * 1000);
  return { orderDate, dueDate, termDays };
}

/**
 * Plan the full set of document shells for one generator run.
 *
 * For each document we: pick a doc type from the requested mix, a
 * vendor + buyer, an order/due date, a layout, and a scenario bucket.
 * The scenario's `apply` hook then mutates the shell to set up its
 * edge case (this can override the buyer to force a tax type, override
 * the layout, drop the PO number, etc.). The duplicate-invoice-number
 * scenario is handled across documents in a final pass so two invoices
 * can share a number (dedup stress).
 *
 * @param {object} args
 * @param {ReturnType<import('../seedrand.js').createRng>} args.rng
 * @param {number} args.count - target total document count
 * @param {Date} [args.now] - reference "now"; all dates measured back from it. Defaults to current wall-clock (non-reproducible — pin via CLI --now).
 * @param {Array<'po'|'invoice'>} [args.types] - allowed doc types; defaults to both
 * @param {ReadonlyArray<string>} [args.layoutFilter] - if set, only these layout keys are eligible (scenario layout overrides still win)
 * @returns {Array<object>} document shells (see file header for shape)
 */
export function planOrders({ rng, count, now = new Date(), types = ['po', 'invoice'], layoutFilter = null }) {
  const shells = [];
  const eligibleLayouts =
    layoutFilter && layoutFilter.length > 0 ? layoutFilter : LAYOUT_KEYS;

  for (let i = 0; i < count; i += 1) {
    const sequence = i + 1;

    // Doc type from the requested mix (uniform across whatever the
    // caller allowed). Both PO and invoice share the same planning code.
    const docType = rng.pick(types);

    const vendor = pickVendor(rng);
    // Default buyer is a free pick; scenarios may override to force a
    // same-state or other-state pairing for a deterministic tax branch.
    const buyer = pickBuyer(rng);

    const { orderDate, dueDate, termDays } = randomOrderAndDueDate(rng, now);
    const { docId, poNumber } = buildDocIds(rng, docType, orderDate, sequence);

    // Layout picked from the eligible set; scenario hooks can override.
    const layoutKey = rng.pick(eligibleLayouts);

    const currency = CURRENCY_INR;

    const shell = {
      vendor,
      buyer,
      docType,
      docId,
      poNumber,
      orderDate,
      dueDate,
      termDays,
      layoutKey,
      currency,
      // Carried so the bilingual scenario can re-pick a Devanagari
      // vendor without importing the pool here.
      vendorPool: undefined,
      scenarioTags: [],
      // Scenario flags (consumed in fillOrder / templates):
      forceLineItems: null,
      injectZeroLine: false,
      forceLongDescriptions: false,
      suppressOrderDate: false,
    };

    // Attach the vendor pool reference lazily (imported in vendors.js).
    // We avoid a top-level import cycle by reading it off the module the
    // pickers come from — simplest is to import VENDORS directly.
    shell.vendorPool = VENDOR_POOL;

    // Pick + apply exactly one scenario bucket.
    const scenario = pickScenario(rng);
    scenario.apply(shell, { rng });
    shell.scenarioTags.push(scenario.tag);

    // If the scenario forced a layout not in the eligible set (e.g. the
    // user filtered layouts but a faxed-scan scenario was rolled), we
    // still honour the scenario — coverage of the edge case matters
    // more than the layout filter, which is a convenience knob.

    // Drop the internal pool ref before the shell leaves the planner so
    // the structured-clone across any future worker boundary stays lean
    // and the manifest doesn't accidentally serialise the whole pool.
    delete shell.vendorPool;

    shells.push(shell);
  }

  // -- Cross-document pass: duplicate-looking invoice numbers --
  // Pick a small number of invoice pairs and force the later one to
  // reuse the earlier one's docId, tagging both. This stresses the
  // dedup / duplicate-detection path. Done deterministically off the
  // RNG so the same seed reproduces the same collisions.
  applyDuplicateInvoiceNumbers(shells, rng);

  return shells;
}

/**
 * Force a couple of invoice documents to share a docId so the
 * downstream dedup path sees duplicate-looking invoice numbers. Tags
 * both members of each colliding pair with `dup-invoice-number`.
 *
 * @param {object[]} shells - planned shells (mutated in place)
 * @param {ReturnType<import('../seedrand.js').createRng>} rng
 * @returns {void}
 */
function applyDuplicateInvoiceNumbers(shells, rng) {
  const invoices = shells.filter((s) => s.docType === 'invoice');
  // Need at least two invoices to make a pair; otherwise skip silently.
  if (invoices.length < 2) return;

  // Number of collisions scales gently with invoice count: ~1 per 25
  // invoices, at least 1, capped so we never collide the whole set.
  const collisions = Math.max(1, Math.floor(invoices.length / 25));
  const maxCollisions = Math.floor(invoices.length / 2);
  const want = Math.min(collisions, maxCollisions);

  for (let k = 0; k < want; k += 1) {
    // Pick a distinct source + target invoice index. We draw via RNG so
    // the choice is reproducible; a tiny retry loop avoids self-pairs.
    const srcIdx = rng.int(0, invoices.length - 1);
    let dstIdx = rng.int(0, invoices.length - 1);
    if (dstIdx === srcIdx) dstIdx = (dstIdx + 1) % invoices.length;
    const src = invoices[srcIdx];
    const dst = invoices[dstIdx];
    // Reuse the source docId on the target. Tag both so the manifest
    // and filename record the deliberate collision.
    dst.docId = src.docId;
    if (!src.scenarioTags.includes('dup-invoice-number')) {
      src.scenarioTags.push('dup-invoice-number');
    }
    if (!dst.scenarioTags.includes('dup-invoice-number')) {
      dst.scenarioTags.push('dup-invoice-number');
    }
  }
}

/**
 * Round a money value to 2 decimal places without trailing
 * floating-point garbage. `Math.round(x * 100) / 100` is accurate
 * enough across the magnitudes we deal with (sub-rupee to lakhs) and
 * avoids a decimal library (forbidden by CLAUDE.md).
 *
 * @param {number} value
 * @returns {number} value rounded to paise (2 dp)
 */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Sample a quantity for one line. Most lines are small counts; a few
 * are larger bulk quantities. Always >= 1 so a normal line is never
 * zero-qty (the zero-value scenario sets price 0, not qty 0).
 *
 * @param {ReturnType<import('../seedrand.js').createRng>} rng
 * @returns {number} integer quantity >= 1
 */
function sampleQuantity(rng) {
  // 70% small (1..20), 25% medium (21..100), 5% bulk (101..500).
  const band = rng.weighted(
    [
      { lo: 1, hi: 20, w: 70 },
      { lo: 21, hi: 100, w: 25 },
      { lo: 101, hi: 500, w: 5 },
    ],
    (b) => b.w,
  );
  return rng.int(band.lo, band.hi);
}

/**
 * Pick a discount percentage tier for the whole document. Most
 * documents carry no discount; the rest fall into common B2B tiers.
 *
 * @param {ReturnType<import('../seedrand.js').createRng>} rng
 * @returns {number} discount percentage (0, 2, 5, 7.5 or 10)
 */
function pickDiscountPct(rng) {
  return rng.weighted(
    [
      { pct: 0, w: 55 },
      { pct: 2, w: 15 },
      { pct: 5, w: 15 },
      { pct: 7.5, w: 8 },
      { pct: 10, w: 7 },
    ],
    (t) => t.w,
  ).pct;
}

/**
 * Build one fully-computed line item from a catalogue entry.
 *
 * Pass-1 inputs (sampled): quantity, unit price. Pass-2 computed:
 * line amount = qty × unitPrice (rounded to paise). The zero-value
 * scenario forces unitPrice 0 (a free/sample line) — amount is then
 * 0 and the downstream tax math handles it without a divide-by-zero
 * (taxable value just doesn't grow).
 *
 * @param {object} args
 * @param {object} args.item - catalogue entry
 * @param {ReturnType<import('../seedrand.js').createRng>} args.rng
 * @param {boolean} args.zero - if true, force unit price 0 (free line)
 * @param {boolean} args.longDesc - if true, lengthen the description
 * @returns {object} line item with {code,description,hsn,unit,qty,unitPrice,gstSlab,amount}
 */
function buildLineItem({ item, rng, zero, longDesc }) {
  const qty = sampleQuantity(rng);
  // Unit price sampled within the catalogue band, rounded to paise.
  const unitPrice = zero ? 0 : round2(rng.float(item.priceMin, item.priceMax));
  const amount = round2(qty * unitPrice);
  const description = longDesc ? `${item.description}${LONG_SUFFIX}` : item.description;
  return {
    code: item.code,
    description,
    hsn: item.hsn,
    unit: item.unit,
    qty,
    unitPrice,
    gstSlab: item.gstSlab,
    amount,
  };
}

/**
 * Fill an order shell with line items and a complete, computed tax
 * breakdown. Returns the input shell extended with `lines`, `taxType`,
 * `hsnSummary`, and `totals`.
 *
 * # Two-pass computation (see file header)
 *   Pass 1 (per line, in buildLineItem): sample qty + unit price,
 *     compute line amount.
 *   Pass 2 (here): subtotal = Σ amount; discount = subtotal × pct;
 *     taxable = subtotal − discount, apportioned per line pro-rata so
 *     the per-slab tax is computed on the post-discount taxable base;
 *     for each GST slab present, compute tax (CGST+SGST split for
 *     intra-state, single IGST for inter-state); round-off nudges the
 *     grand total to the nearest rupee; grandTotal = taxable +
 *     totalTax + roundOff.
 *
 * Intra vs inter-state is decided purely by
 * `vendor.stateCode === buyer.stateCode`, which the scenario layer has
 * already arranged for the forced-tax buckets.
 *
 * @param {object} shell - shell from `planOrders`
 * @param {ReturnType<import('../seedrand.js').createRng>} rng
 * @param {object} catalog - parsed catalog.json (has `.items`)
 * @returns {object} the populated order
 */
export function fillOrder(shell, rng, catalog) {
  const items = catalog.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('docrithm-pdf-gen: catalog.json has no items array');
  }

  // Decide how many line items this document carries. Multipage
  // overflow scenarios force a large count; otherwise sample a typical
  // procurement size.
  const lineCount =
    shell.forceLineItems != null
      ? Math.min(shell.forceLineItems, items.length)
      : rng.int(2, 9);

  // Pick `lineCount` DISTINCT catalogue items. Distinctness keeps the
  // HSN summary meaningful and avoids duplicate rows; we shuffle a copy
  // and slice. Shuffle uses the seeded RNG (Fisher-Yates) so it's
  // reproducible.
  const pool = items.slice();
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  const chosen = pool.slice(0, lineCount);

  // -- Pass 1: build each line (qty, unit price, amount) --
  const longDesc = shell.forceLongDescriptions === true;
  const lines = chosen.map((item, idx) =>
    buildLineItem({
      item,
      rng,
      // Inject a single zero-value line at index 0 when requested.
      zero: shell.injectZeroLine === true && idx === 0,
      // Lengthen the first item's description under the long-strings
      // scenario; lengthening every row would overflow even a clean doc.
      longDesc: longDesc && idx === 0,
    }),
  );

  // Apply the long-description treatment to the vendor name too so the
  // header column-wrap is exercised, not just an item row.
  if (longDesc) {
    shell.vendor = { ...shell.vendor, name: `${shell.vendor.name}${LONG_SUFFIX}` };
  }

  // -- Pass 2: document-level money rollup --
  const subtotal = round2(lines.reduce((acc, l) => acc + l.amount, 0));
  const discountPct = pickDiscountPct(rng);
  const discount = round2((subtotal * discountPct) / 100);
  const taxableTotal = round2(subtotal - discount);

  // Intra-state (same GST state code) ⇒ CGST+SGST; else ⇒ IGST.
  const intraState = shell.vendor.stateCode === shell.buyer.stateCode;
  const taxType = intraState ? 'CGST+SGST' : 'IGST';

  // Build HSN/slab-wise tax summary. We apportion the document discount
  // across lines pro-rata by line amount so each line's taxable value
  // reflects its share of the discount, then group by (hsn, gstSlab).
  // Guard the pro-rata against a zero subtotal (all-free document).
  const hsnGroups = new Map(); // key: `${hsn}|${slab}` → accumulator
  for (const line of lines) {
    // Pro-rata discount share for this line (0 when subtotal is 0).
    const share = subtotal > 0 ? line.amount / subtotal : 0;
    const lineDiscount = round2(discount * share);
    const lineTaxable = round2(line.amount - lineDiscount);

    const key = `${line.hsn}|${line.gstSlab}`;
    const acc = hsnGroups.get(key) ?? {
      hsn: line.hsn,
      gstSlab: line.gstSlab,
      taxable: 0,
    };
    acc.taxable = round2(acc.taxable + lineTaxable);
    hsnGroups.set(key, acc);
  }

  // Compute per-group tax and roll up document totals.
  let totalCgst = 0;
  let totalSgst = 0;
  let totalIgst = 0;
  const hsnSummary = [];
  for (const acc of hsnGroups.values()) {
    const rate = acc.gstSlab; // percentage
    if (intraState) {
      // CGST + SGST each take half the slab.
      const cgst = round2((acc.taxable * (rate / 2)) / 100);
      const sgst = round2((acc.taxable * (rate / 2)) / 100);
      totalCgst = round2(totalCgst + cgst);
      totalSgst = round2(totalSgst + sgst);
      hsnSummary.push({
        hsn: acc.hsn,
        gstSlab: rate,
        taxable: acc.taxable,
        cgstRate: rate / 2,
        cgst,
        sgstRate: rate / 2,
        sgst,
        igstRate: 0,
        igst: 0,
        totalTax: round2(cgst + sgst),
      });
    } else {
      // Full slab as IGST.
      const igst = round2((acc.taxable * rate) / 100);
      totalIgst = round2(totalIgst + igst);
      hsnSummary.push({
        hsn: acc.hsn,
        gstSlab: rate,
        taxable: acc.taxable,
        cgstRate: 0,
        cgst: 0,
        sgstRate: 0,
        sgst: 0,
        igstRate: rate,
        igst,
        totalTax: igst,
      });
    }
  }
  // Sort the summary by HSN then slab for stable, readable output.
  hsnSummary.sort((a, b) =>
    a.hsn === b.hsn ? a.gstSlab - b.gstSlab : a.hsn.localeCompare(b.hsn),
  );

  const totalTax = round2(totalCgst + totalSgst + totalIgst);
  const preRound = round2(taxableTotal + totalTax);
  // Round-off: nudge to the nearest whole rupee (Indian invoices print
  // a signed round-off line). roundOff can be negative or positive.
  const grandTotal = Math.round(preRound);
  const roundOff = round2(grandTotal - preRound);

  const totals = {
    subtotal,
    discountPct,
    discount,
    taxableTotal,
    cgst: totalCgst,
    sgst: totalSgst,
    igst: totalIgst,
    totalTax,
    roundOff,
    grandTotal,
    lineItemCount: lines.length,
  };

  return {
    ...shell,
    lines,
    taxType,
    intraState,
    hsnSummary,
    totals,
  };
}

// Imported at the bottom to keep the scenario `apply` hooks able to
// re-pick a Devanagari vendor without threading the pool through every
// call site. Importing here (not at top) is purely organisational —
// ESM hoists the binding so it's available inside planOrders regardless.
import { VENDORS as VENDOR_POOL } from '../vendors.js';
