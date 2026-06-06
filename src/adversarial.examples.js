/**
 * Demo + lightweight self-check for the adversarial distortion library.
 *
 * # Purpose
 * Two jobs in one runnable file:
 *   1. Print a readable sample of distortions over a known master pair so a
 *      human can eyeball the catalogue behaviour (`node src/adversarial.examples.js`).
 *   2. Assert the library's load-bearing invariants so a regression fails
 *      loudly. This is the module's tiny test gate — it has no framework
 *      dependency (CLAUDE.md keeps the dependency surface minimal) and exits
 *      non-zero on any failed assertion so CI / `node` can detect it.
 *
 * # Determinism check
 * The same seed must reproduce byte-identical output. The self-check runs
 * each public entry point twice with a fresh RNG of the same seed and
 * asserts equality — the determinism contract the whole generator relies on.
 *
 * Run: `node src/adversarial.examples.js`
 */

import { createRng } from './seedrand.js';
import { DISTORTIONS, distortLedger, distortStock, pickDistortion } from './adversarial.js';

// A known ledger + stock master to distort. Chosen to echo the canonical
// harness cases (a branch-suffixed party; an alias-bearing stock card).
const SAMPLE_LEDGER = 'A J Brothers Trading Pvt Ltd';
const SAMPLE_STOCK = Object.freeze({
  name: 'Fortune wheat',
  parent_group: 'Solvent',
  aliases: ['Fortune Atta', 'LCl', 'Liquid Chlorine'],
  hsn_code: '1101',
  base_unit: 'kg',
});

/**
 * Pretty-print one DistortionResult on a single line.
 *
 * @param {import('./adversarial.js').DistortionResult} r
 * @returns {string}
 */
function fmt(r) {
  return (
    `${String(r.difficulty)}  ${r.expectedOutcome.padEnd(9)}  ` +
    `${r.distortion.padEnd(22)}  → "${r.text}"`
  );
}

/**
 * Print 10 example outputs over the sample masters (mixed ledger/stock,
 * sweeping the level band) so a human can sanity-check the catalogue.
 *
 * @returns {void}
 */
function printExamples() {
  const rng = createRng(20260606);
  console.log(`\nSample ledger: "${SAMPLE_LEDGER}"`);
  console.log(`Sample stock:  "${SAMPLE_STOCK.name}" (aliases: ${SAMPLE_STOCK.aliases.join(', ')})\n`);
  console.log('diff outcome     distortion               text');
  console.log('---- ---------    -----------------------  ----');
  for (let i = 0; i < 5; i += 1) {
    const level = ((i * 2) % 5) + 1; // sweep levels 1,3,5,2,4
    console.log(`L  ${fmt(distortLedger(SAMPLE_LEDGER, rng, { level }))}`);
  }
  for (let i = 0; i < 5; i += 1) {
    const level = ((i * 2) % 5) + 1;
    console.log(`S  ${fmt(distortStock(SAMPLE_STOCK, rng, { level }))}`);
  }
}

/**
 * Minimal assertion helper — throws (and the process exits non-zero) on a
 * falsey condition so the self-check can gate without a test framework.
 *
 * @param {boolean} cond
 * @param {string} msg
 * @returns {void}
 */
function assert(cond, msg) {
  if (!cond) throw new Error(`SELF-CHECK FAILED: ${msg}`);
}

/**
 * Run the invariant self-check. Validates shape, determinism, catalogue
 * integrity, and the difficulty-band contract of `pickDistortion`.
 *
 * @returns {void}
 */
function selfCheck() {
  const OUTCOMES = new Set(['resolved', 'ambiguous', 'unmatched']);

  // 1. Every catalogue entry is well-formed.
  for (const d of DISTORTIONS) {
    assert(typeof d.id === 'string' && d.id.length > 0, `distortion missing id`);
    assert(['ledger', 'stock', 'both'].includes(d.target), `${d.id}: bad target`);
    assert(d.difficulty >= 1 && d.difficulty <= 5, `${d.id}: difficulty out of 1..5`);
    assert(OUTCOMES.has(d.expectedOutcome), `${d.id}: bad expectedOutcome`);
    assert(Array.isArray(d.tags) && d.tags.length > 0, `${d.id}: tags must be non-empty`);
    assert(typeof d.apply === 'function', `${d.id}: apply must be a function`);
  }

  // 2. Result shape from both public helpers.
  for (const r of [
    distortLedger(SAMPLE_LEDGER, createRng(1), { level: 3 }),
    distortStock(SAMPLE_STOCK, createRng(1), { level: 3 }),
  ]) {
    assert(typeof r.text === 'string' && r.text.length > 0, 'result.text must be non-empty');
    assert(typeof r.distortion === 'string', 'result.distortion must be a string');
    assert(Array.isArray(r.tags), 'result.tags must be an array');
    assert(r.difficulty >= 1 && r.difficulty <= 5, 'result.difficulty out of band');
    assert(OUTCOMES.has(r.expectedOutcome), 'result.expectedOutcome invalid');
  }

  // 3. Determinism: same seed → identical result.
  const a = distortLedger(SAMPLE_LEDGER, createRng(99), { level: 5 });
  const b = distortLedger(SAMPLE_LEDGER, createRng(99), { level: 5 });
  assert(JSON.stringify(a) === JSON.stringify(b), 'distortLedger not deterministic');
  const sa = distortStock(SAMPLE_STOCK, createRng(99), { level: 2 });
  const sb = distortStock(SAMPLE_STOCK, createRng(99), { level: 2 });
  assert(JSON.stringify(sa) === JSON.stringify(sb), 'distortStock not deterministic');

  // 4. pickDistortion respects the difficulty band and target filter.
  for (let s = 0; s < 50; s += 1) {
    const d = pickDistortion(createRng(s), { minDifficulty: 4, maxDifficulty: 5, target: 'ledger' });
    assert(d.difficulty >= 4 && d.difficulty <= 5, `pickDistortion band violated (${d.id})`);
    assert(d.target === 'ledger' || d.target === 'both', `pickDistortion target violated (${d.id})`);
  }

  // 5. Headline case: a level-1 stock distortion should be solvable
  //    (resolved) the large majority of the time (packaging collapse).
  let resolvedEasy = 0;
  for (let s = 0; s < 100; s += 1) {
    if (distortStock(SAMPLE_STOCK, createRng(s), { level: 1 }).expectedOutcome === 'resolved') resolvedEasy += 1;
  }
  assert(resolvedEasy >= 60, `expected mostly-resolved at level 1, got ${resolvedEasy}/100`);

  console.log('\nSELF-CHECK PASSED: catalogue + determinism + band contract OK');
}

printExamples();
selfCheck();
