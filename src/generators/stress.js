/**
 * Resolution-stress document planner.
 *
 * # Purpose
 * Generates purchase orders / invoices whose party + line-item names are
 * ADVERSARIAL variants of REAL Tally masters (loaded from a master
 * export), together with a ground-truth record mapping every shown
 * reference back to the master it SHOULD resolve to and the expected
 * resolver outcome. This is the input bench for stress-testing — and
 * trying to break — DocRithm's Tally resolution harness (see
 * docs/RESOLUTION_HARNESS.md).
 *
 * Where the normal generator (generators/orders.js) varies vendors,
 * layouts and GST scenarios, this generator instead holds the *document
 * chrome* boring and concentrates all the difficulty in the **strings a
 * human typed for the party and each line item** — exactly the gap the
 * resolver must close: turn what the document SAYS into the Tally master
 * the accountant WOULD have picked.
 *
 * # What it does NOT own
 * - It does not invent distortions itself. Every distorted string comes
 *   from src/adversarial.js (`distortLedger` / `distortStock`), built in
 *   parallel; this module only decides WHICH master to distort, at WHICH
 *   difficulty, and records the ground truth.
 * - It does not render. It produces order objects in the exact shape the
 *   existing render pipeline (render.js + templates/*) consumes, so the
 *   distorted strings ride in the party-name / line-description fields
 *   the templates already print, and a parallel ground-truth array used
 *   to emit out/stress-manifest.json.
 *
 * # Difficulty mix (the "try to break it" contract)
 * Difficulty is driven by a per-document `level` (0..3 → easy/medium/
 * hard/brutal) fed to the adversarial engine. The population is weighted
 * so roughly 60% of documents are solvable (easy/medium) with a
 * deliberate brutal tail meant to defeat the harness. On top of the
 * random population we inject a few CROSS-CUTTING cases that target
 * specific harness behaviours:
 *   - packaging-variant collapse: the SAME stock master shown four
 *     different ways across four documents (should all collapse to one
 *     card).
 *   - branch-collapse: a BARE ledger name whose company carries branch
 *     variants (should go ambiguous, not silently auto-pick a branch).
 *
 * # Determinism
 * All randomness flows through the caller-supplied seeded `rng`. Same
 * masters + same seed + same count → identical plan and identical
 * manifest. No Math.random, no Date.now (dates derive from `now`).
 */

import { createRng } from '../seedrand.js';
import { distortLedger, distortStock } from '../adversarial.js';
import { buildDocIds } from './orders.js';

// 12 months of trailing history, in milliseconds (mirrors orders.js so
// stress docs carry believable, in-range dates).
const TWELVE_MONTHS_MS = 12 * 30 * 24 * 60 * 60 * 1000;

// Net-payment-term options (days); Net 30 dominates Indian B2B.
const PAYMENT_TERM_DAYS = [15, 30, 30, 30, 45, 60];

// INR is the only currency in stress mode — currency is not the variable
// under test here; the party/line strings are.
const CURRENCY_INR = Object.freeze({ code: 'INR', symbol: '₹' });

// A single synthetic accent colour + GSTIN shell for the party chrome.
// The party NAME is the adversarial variant; the rest of the block is
// deliberately constant so the document looks like a real letterhead
// without leaking which master it maps to.
const STRESS_ACCENT = '#1F2933';
const SYNTH_GSTIN = '27ZZZZZ0000Z1Z5';

// Difficulty-band weights. `level` is the 1..5 integer fed to the
// adversarial engine (1=easy … 5=brutal), matching src/adversarial.js.
// Weights make ~60% of documents solvable (levels 1+2) with a hard
// middle (3) and a deliberate brutal tail (4+5) engineered to break the
// resolver. `name` is a human band label recorded on the doc + summary;
// the per-reference numeric difficulty is taken from the adversarial
// result itself (each distortion carries its own).
const DIFFICULTY_BANDS = Object.freeze([
  { level: 1, name: 'easy', weight: 35 },
  { level: 2, name: 'medium', weight: 25 },
  { level: 3, name: 'hard', weight: 22 },
  { level: 4, name: 'brutal', weight: 13 },
  { level: 5, name: 'brutal', weight: 5 },
]);

/**
 * Two-digit zero-pad helper (avoids a date library, per CLAUDE.md).
 *
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Slugify a free-text name into a filesystem-safe fragment. Used for the
 * synthetic party `slug` the renderer encodes into the filename.
 *
 * @param {string} s
 * @returns {string}
 */
function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'party';
}

/**
 * Validate a parsed masters object and throw a clear, actionable error
 * when it is missing or empty. The error tells the user to run the
 * master-export tool (the file is produced separately).
 *
 * @param {?object} masters - parsed tally-masters.json (or null)
 * @param {string} mastersPath - path it was loaded from (for the message)
 * @returns {object} the validated masters object
 */
export function validateMasters(masters, mastersPath) {
  if (!masters || typeof masters !== 'object') {
    throw new Error(
      `no Tally masters found at '${mastersPath}'. Run the master-export `
        + `tool to produce it, or pass --masters data/tally-masters.sample.json `
        + `to use the bundled fixture.`,
    );
  }
  const ledgers = Array.isArray(masters.ledgers) ? masters.ledgers : [];
  const stock = Array.isArray(masters.stock) ? masters.stock : [];
  if (ledgers.length === 0 || stock.length === 0) {
    throw new Error(
      `Tally masters at '${mastersPath}' are empty (ledgers=${ledgers.length}, `
        + `stock=${stock.length}). Re-run the master-export tool against a `
        + `company that has ledgers AND stock items, or use `
        + `data/tally-masters.sample.json.`,
    );
  }
  return masters;
}

/**
 * Group ledgers by their base name (everything before a ` - branch` or
 * ` (city)` suffix). Lets the planner detect masters that carry branch
 * variants — the canonical "bare name → ambiguous" case.
 *
 * @param {Array<{name:string}>} ledgers
 * @returns {Map<string, Array<object>>} base name → ledgers sharing it
 */
function groupLedgersByBase(ledgers) {
  const byBase = new Map();
  for (const led of ledgers) {
    const base = led.name.replace(/\s*[-(].*$/, '').trim().toLowerCase();
    const arr = byBase.get(base) ?? [];
    arr.push(led);
    byBase.set(base, arr);
  }
  return byBase;
}

/**
 * Build the constant party chrome (address / GSTIN / accent) around an
 * adversarial party NAME. The name is the only field carrying the
 * distortion; the rest mirrors the vendor object shape the layouts read
 * (name, addressLines, gstin, state, stateCode, accentColor,
 * logoMonogram, slug).
 *
 * @param {string} shownName - the adversarial (distorted) party text
 * @param {string} company - the Tally company name (for the address block)
 * @returns {object} a vendor-shaped party object
 */
function partyChrome(shownName, company) {
  return {
    slug: slugify(shownName),
    name: shownName,
    addressLines: [`C/o ${company}`, 'Resolution-Stress Test Document'],
    gstin: SYNTH_GSTIN,
    state: 'Maharashtra',
    stateCode: '27',
    phone: '+91 22 0000 0000',
    email: 'stress@docrithm.example',
    accentColor: STRESS_ACCENT,
    logoMonogram: (shownName.replace(/[^A-Za-z]/g, '').slice(0, 2) || 'ST').toUpperCase(),
  };
}

/**
 * Build one renderable line item from a distorted stock string. Shape
 * matches what buildLineItem (orders.js) emits and the layouts read
 * (code, description, hsn, unit, qty, unitPrice, gstSlab, amount). The
 * adversarial text goes in `description` — the field the templates print
 * and the resolver consumes.
 *
 * @param {object} args
 * @param {object} args.master - the source stock master
 * @param {string} args.shown - distorted description text
 * @param {ReturnType<import('../seedrand.js').createRng>} args.rng
 * @returns {object} a renderable line item
 */
function buildStressLine({ master, shown, rng }) {
  const qty = rng.int(1, 200);
  const unitPrice = Math.round(rng.float(20, 2000) * 100) / 100;
  const amount = Math.round(qty * unitPrice * 100) / 100;
  return {
    code: slugify(master.name),
    description: shown,
    hsn: master.hsn_code ?? '',
    unit: master.base_unit ?? 'Nos',
    qty,
    unitPrice,
    gstSlab: 18,
    amount,
  };
}

/**
 * Compute the minimal money rollup the templates' totals/tax blocks
 * need. Stress mode keeps tax trivial (single 18% slab, intra-state) —
 * the arithmetic is not what's under test, the party/line strings are.
 *
 * @param {Array<object>} lines
 * @returns {{taxType:string, intraState:boolean, hsnSummary:Array, totals:object}}
 */
function rollupTotals(lines) {
  const round2 = (v) => Math.round(v * 100) / 100;
  const subtotal = round2(lines.reduce((a, l) => a + l.amount, 0));
  const taxableTotal = subtotal;
  // Group by (hsn, slab) for the HSN-wise summary table.
  const groups = new Map();
  for (const l of lines) {
    const key = `${l.hsn}|${l.gstSlab}`;
    const acc = groups.get(key) ?? { hsn: l.hsn, gstSlab: l.gstSlab, taxable: 0 };
    acc.taxable = round2(acc.taxable + l.amount);
    groups.set(key, acc);
  }
  let totalCgst = 0;
  let totalSgst = 0;
  const hsnSummary = [];
  for (const g of groups.values()) {
    const cgst = round2((g.taxable * (g.gstSlab / 2)) / 100);
    const sgst = cgst;
    totalCgst = round2(totalCgst + cgst);
    totalSgst = round2(totalSgst + sgst);
    hsnSummary.push({
      hsn: g.hsn,
      gstSlab: g.gstSlab,
      taxable: g.taxable,
      cgstRate: g.gstSlab / 2,
      cgst,
      sgstRate: g.gstSlab / 2,
      sgst,
      igstRate: 0,
      igst: 0,
      totalTax: round2(cgst + sgst),
    });
  }
  hsnSummary.sort((a, b) => (a.hsn === b.hsn ? a.gstSlab - b.gstSlab : a.hsn.localeCompare(b.hsn)));
  const totalTax = round2(totalCgst + totalSgst);
  const preRound = round2(taxableTotal + totalTax);
  const grandTotal = Math.round(preRound);
  const roundOff = round2(grandTotal - preRound);
  return {
    taxType: 'CGST+SGST',
    intraState: true,
    hsnSummary,
    totals: {
      subtotal,
      discountPct: 0,
      discount: 0,
      taxableTotal,
      cgst: totalCgst,
      sgst: totalSgst,
      igst: 0,
      totalTax,
      roundOff,
      grandTotal,
      lineItemCount: lines.length,
    },
  };
}

/**
 * Find the master object whose adversarial output a distortion came
 * from, recording the ground-truth reference fields for the manifest.
 *
 * @param {object} args
 * @param {object} args.master - source ledger/stock master
 * @param {string} args.kind - 'ledger' | 'stock'
 * @param {object} args.dist - adversarial result {text,distortion,tags,difficulty,expectedOutcome}
 * @returns {object} ground-truth reference row
 */
function groundTruthRef({ master, kind, dist }) {
  const base = {
    shown: dist.text,
    intendedMaster: master.name,
    parentGroup: master.parent_group ?? null,
    distortion: dist.distortion,
    tags: Array.isArray(dist.tags) ? dist.tags.slice() : [],
    difficulty: dist.difficulty,
    expectedOutcome: dist.expectedOutcome,
  };
  if (kind === 'stock') base.hsn = master.hsn_code ?? null;
  return base;
}

/**
 * Plan one resolution-stress document: pick a party ledger + several
 * stock items, distort each at the document's difficulty level, and
 * assemble both the renderable order and its ground-truth record.
 *
 * @param {object} args
 * @param {ReturnType<import('../seedrand.js').createRng>} args.rng
 * @param {object} args.masters - validated masters
 * @param {'po'|'invoice'} args.docType
 * @param {Date} args.now
 * @param {number} args.sequence - monotonic counter across the run
 * @param {object} args.forced - optional forced pieces for cross-cutting cases:
 *   { ledger, stockMasters[], level } any of which may be omitted
 * @returns {{order:object, truth:object}}
 */
function planStressDoc({ rng, masters, docType, now, sequence, forced = {} }) {
  // Difficulty: forced level for cross-cutting cases, else weighted band.
  const band =
    forced.level != null
      ? DIFFICULTY_BANDS.find((b) => b.level === forced.level) ?? DIFFICULTY_BANDS[0]
      : rng.weighted(DIFFICULTY_BANDS, (b) => b.weight);

  // -- Party (ledger) --
  const ledger = forced.ledger ?? rng.pick(masters.ledgers);
  const partyDist = distortLedger(ledger.name, rng, { level: band.level });
  const party = partyChrome(partyDist.text, masters.company);

  // -- Line items (stock) --
  const stockMasters =
    forced.stockMasters
    ?? (() => {
      // 2..5 distinct stock masters (capped by availability).
      const want = Math.min(rng.int(2, 5), masters.stock.length);
      const pool = masters.stock.slice();
      for (let i = pool.length - 1; i > 0; i -= 1) {
        const j = rng.int(0, i);
        const t = pool[i];
        pool[i] = pool[j];
        pool[j] = t;
      }
      return pool.slice(0, want);
    })();

  const lines = [];
  const lineTruth = [];
  for (const sm of stockMasters) {
    const d = distortStock(sm, rng, { level: band.level });
    lines.push(buildStressLine({ master: sm, shown: d.text, rng }));
    lineTruth.push(groundTruthRef({ master: sm, kind: 'stock', dist: d }));
  }

  // Dates + ids (reuse the orders.js id builder for a consistent docId).
  const offsetMs = rng.int(0, TWELVE_MONTHS_MS);
  const orderDate = new Date(now.getTime() - offsetMs);
  const termDays = rng.pick(PAYMENT_TERM_DAYS);
  const dueDate = new Date(orderDate.getTime() + termDays * 24 * 60 * 60 * 1000);
  const { docId, poNumber } = buildDocIds(rng, docType, orderDate, sequence);

  const money = rollupTotals(lines);

  // Renderable order — same shape fillOrder() returns so render.js and
  // the templates consume it unchanged. The party doubles as both vendor
  // (letterhead) and is also set as buyer so the parties block renders
  // without a second pool; buyer is irrelevant to resolution stress.
  const order = {
    vendor: party,
    buyer: { ...party, slug: `${party.slug}-bill`, name: `${masters.company} (Bill To)` },
    docType,
    docId,
    poNumber,
    orderDate,
    dueDate,
    termDays,
    layoutKey: 'clean-modern',
    currency: CURRENCY_INR,
    scenarioTags: ['resolution-stress', band.name],
    forceLineItems: null,
    injectZeroLine: false,
    forceLongDescriptions: false,
    suppressOrderDate: false,
    lines,
    ...money,
  };

  const truth = {
    docType,
    difficulty: band.name,
    party: groundTruthRef({ master: ledger, kind: 'ledger', dist: partyDist }),
    lineItems: lineTruth,
  };

  return { order, truth };
}

/**
 * Plan a full resolution-stress run.
 *
 * Produces `count` documents: a weighted-difficulty random population
 * PLUS injected cross-cutting cases (packaging-variant collapse,
 * bare-name branch collapse) that target specific harness behaviours.
 * The injected cases are counted toward `count` (they replace the first
 * few random docs) so the caller always gets exactly `count` documents.
 *
 * @param {object} args
 * @param {ReturnType<import('../seedrand.js').createRng>} args.rng
 * @param {object} args.masters - validated masters
 * @param {number} args.count - number of documents to plan
 * @param {Date} args.now - date anchor (all dates measured back from it)
 * @param {Array<'po'|'invoice'>} args.types - allowed doc types
 * @returns {{orders:object[], truths:object[]}}
 */
export function planStress({ rng, masters, count, now, types }) {
  const orders = [];
  const truths = [];
  let sequence = 0;

  const pushDoc = (forced) => {
    sequence += 1;
    const docType = rng.pick(types);
    const { order, truth } = planStressDoc({ rng, masters, docType, now, sequence, forced });
    orders.push(order);
    truths.push(truth);
  };

  // -- Cross-cutting case 1: packaging-variant collapse --
  // The SAME stock master shown across up to 4 docs (each forced to a
  // single line built from that one master). The harness should collapse
  // all variants onto the single card. Forced to medium so it stays in
  // the "should be solvable" band — this is a correctness case, not a
  // break case.
  const collapseMaster = masters.stock.find((s) => (s.aliases?.length ?? 0) > 0) ?? masters.stock[0];
  const collapseDocs = Math.min(4, count);
  for (let k = 0; k < collapseDocs; k += 1) {
    pushDoc({ stockMasters: [collapseMaster], level: 1 });
  }

  // -- Cross-cutting case 2: bare-name branch collapse --
  // A ledger whose base name has branch variants, shown bare (suffix
  // dropped). Should go ambiguous, not silently auto-pick a branch.
  // Forced to hard so the distortion drops the suffix.
  const byBase = groupLedgersByBase(masters.ledgers);
  let branchLedger = null;
  for (const arr of byBase.values()) {
    if (arr.length > 1) {
      branchLedger = arr[0];
      break;
    }
  }
  // Even a single-branch master with a suffix exercises the bare-name
  // case (the harness's branch-suffix profile bias can still fire).
  if (!branchLedger) {
    branchLedger = masters.ledgers.find((l) => /[-(]/.test(l.name)) ?? null;
  }
  if (branchLedger && orders.length < count) {
    pushDoc({ ledger: branchLedger, level: 2 });
  }

  // -- Remaining documents: weighted-difficulty random population --
  while (orders.length < count) {
    pushDoc();
  }

  return { orders, truths };
}

/**
 * Summarise a set of ground-truth records into counts by expected
 * outcome and by difficulty — written into the manifest so a reviewer
 * can see the population shape at a glance.
 *
 * @param {object[]} truths - ground-truth records from planStress
 * @returns {{byExpectedOutcome:Record<string,number>, byDifficulty:Record<string,number>}}
 */
export function summariseTruths(truths) {
  const byExpectedOutcome = Object.create(null);
  const byDifficulty = Object.create(null);
  const bump = (map, key) => {
    if (!key) return;
    map[key] = (map[key] ?? 0) + 1;
  };
  for (const t of truths) {
    bump(byDifficulty, t.difficulty);
    bump(byExpectedOutcome, t.party.expectedOutcome);
    for (const li of t.lineItems) {
      bump(byExpectedOutcome, li.expectedOutcome);
    }
  }
  return { byExpectedOutcome, byDifficulty };
}

// Re-export createRng so a caller can spin a child RNG if needed without
// reaching into seedrand directly (kept for symmetry with orders.js).
export { createRng };
