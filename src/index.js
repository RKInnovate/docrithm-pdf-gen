#!/usr/bin/env node
/**
 * CLI entry point — `docrithm-pdf-gen`.
 *
 * # Purpose
 * Wire the pipeline stages together:
 *   1. Argument parsing + validation.
 *   2. RNG seeding + catalogue load.
 *   3. Order/invoice planning (`planOrders`).
 *   4. Per-document line-item + tax fill (`fillOrder`).
 *   5. PDF rendering to disk + manifest emission (`renderAll`).
 *
 * # Why a hand-rolled arg parser
 * The CLI surface is small (six flags + help); pulling in commander /
 * yargs is unjustified. Hand-rolling also gives full control over the
 * validation error messages, which are the only part users actually see.
 *
 * # Output style
 * Plain text, one line per step, no emojis. Progress is rate-limited
 * (every 50 docs OR 5 seconds). The run ends with four ASCII summary
 * tables (byType, byVendor, byLayout, byScenario) and writes a
 * `manifest.json` indexing every file with its ground-truth fields.
 *
 * # Exit codes
 *   0 — success
 *   1 — bad CLI input or render failure
 */

import fs from 'fs/promises';
import path from 'path';
import process from 'process';

import { createRng } from './seedrand.js';
import { planOrders, fillOrder } from './generators/orders.js';
import { planStress, validateMasters, summariseTruths } from './generators/stress.js';
import { loadCatalog, renderAll } from './render.js';
import { LAYOUT_KEYS } from './layouts/index.js';

// All known document types — default --types value and validation set.
const ALL_TYPES = ['po', 'invoice'];

// Default path to the Tally master export consumed by --stress.
const DEFAULT_MASTERS = 'data/tally-masters.json';

// Defaults. Centralised so --help and the parser stay in sync.
const DEFAULTS = Object.freeze({
  count: 60,
  seed: 42,
  outDir: './out',
  types: ALL_TYPES.slice(),
  layouts: null, // null → all layouts eligible
  stress: false,
  masters: DEFAULT_MASTERS,
});

const PROGRESS_EVERY_DOCS = 50;
const PROGRESS_EVERY_MS = 5_000;

/**
 * Render the usage block. Mirrors README.md flag list.
 *
 * @returns {string} multi-line usage text, no trailing newline
 */
function helpText() {
  return [
    'Usage: docrithm-pdf-gen [options]',
    '',
    'Generate synthetic Indian B2B purchase-order / tax-invoice PDFs into a',
    'flat output directory, plus a manifest.json of ground-truth fields.',
    '',
    'Options:',
    `  --count N            Number of PDFs to emit (default ${DEFAULTS.count})`,
    `  --seed N             Deterministic RNG seed (default ${DEFAULTS.seed})`,
    `  --now TIMESTAMP      Anchor for all document dates: epoch ms or an`,
    `                       ISO-8601 string (default: current wall-clock).`,
    `                       Pin --now with --seed for byte-identical reruns.`,
    `  --out-dir PATH       Output directory (default ${DEFAULTS.outDir})`,
    `  --types po,invoice   Document types to emit (default ${DEFAULTS.types.join(',')})`,
    `  --layouts a,b,c      Restrict to these layouts (default: all)`,
    `                       Known: ${LAYOUT_KEYS.join(', ')}`,
    '  --stress             Resolution-stress mode: emit PO/invoice PDFs whose',
    '                       party + line-item names are ADVERSARIAL variants of',
    '                       real Tally masters, plus a ground-truth',
    '                       out/stress-manifest.json. Reuses --count --seed',
    '                       --out-dir --types --now.',
    `  --masters PATH       Tally master export for --stress (default ${DEFAULT_MASTERS})`,
    '  -h, --help           Show this help and exit',
    '',
    'Examples:',
    '  docrithm-pdf-gen --count 200 --seed 7 --types invoice --out-dir ./out',
    '  docrithm-pdf-gen --stress --masters data/tally-masters.sample.json \\',
    '                   --count 12 --seed 7 --out-dir ./out-stress',
  ].join('\n');
}

/**
 * Print `msg` to stderr and exit with code 1.
 *
 * @param {string} msg
 * @returns {never}
 */
function fail(msg) {
  process.stderr.write(`docrithm-pdf-gen: ${msg}\n`);
  process.exit(1);
}

/**
 * Parse the `--now` flag into a Date. Accepts epoch ms (all-digits) or
 * any Date-parseable string (ISO-8601 recommended). Throws on invalid.
 *
 * @param {string} raw
 * @returns {Date}
 */
function parseNow(raw) {
  const trimmed = raw.trim();
  const d = /^\d+$/.test(trimmed) ? new Date(Number(trimmed)) : new Date(trimmed);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`--now must be epoch ms or an ISO-8601 date (got '${raw}')`);
  }
  return d;
}

/**
 * Load + parse the Tally master export for --stress. Returns the parsed
 * object, or throws an actionable error when the file is missing or
 * unreadable (validateMasters handles the empty-content case).
 *
 * @param {string} mastersPath - resolved absolute path
 * @returns {Promise<object>} parsed masters JSON
 */
async function loadMasters(mastersPath) {
  let raw;
  try {
    raw = await fs.readFile(mastersPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `no Tally masters found at '${mastersPath}'. Run the master-export `
          + `tool to produce data/tally-masters.json, or pass `
          + `--masters data/tally-masters.sample.json to use the bundled fixture.`,
      );
    }
    throw new Error(`cannot read masters at '${mastersPath}': ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`masters at '${mastersPath}' is not valid JSON: ${err.message}`);
  }
}

/**
 * Parse `process.argv.slice(2)` into a flat options object. Throws on
 * syntactic problems; semantic validation is in `validateOptions`.
 *
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
  const opts = {
    count: DEFAULTS.count,
    seed: DEFAULTS.seed,
    outDir: DEFAULTS.outDir,
    types: DEFAULTS.types.slice(),
    layouts: DEFAULTS.layouts,
    now: null,
    stress: DEFAULTS.stress,
    masters: DEFAULTS.masters,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let name = arg;
    let inlineValue = null;
    if (arg.startsWith('--') && arg.includes('=')) {
      const eqIdx = arg.indexOf('=');
      name = arg.slice(0, eqIdx);
      inlineValue = arg.slice(eqIdx + 1);
    }

    const consume = () => {
      if (inlineValue !== null) return inlineValue;
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        throw new Error(`flag '${name}' requires a value`);
      }
      i += 1;
      return v;
    };

    switch (name) {
      case '--':
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--count':
        opts.count = Number(consume());
        break;
      case '--seed':
        opts.seed = Number(consume());
        break;
      case '--now':
        opts.now = parseNow(consume());
        break;
      case '--out-dir':
        opts.outDir = consume();
        break;
      case '--types':
        opts.types = consume().split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--layouts':
        opts.layouts = consume().split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--stress':
        opts.stress = true;
        break;
      case '--masters':
        opts.masters = consume();
        break;
      default:
        throw new Error(`unknown flag '${arg}'`);
    }
  }

  return opts;
}

/**
 * Validate the resolved options. Throws on the first problem.
 *
 * @param {ReturnType<typeof parseArgs>} opts
 */
function validateOptions(opts) {
  if (!Number.isInteger(opts.count) || opts.count <= 0) {
    throw new Error(`--count must be a positive integer (got ${opts.count})`);
  }
  if (!Number.isInteger(opts.seed)) {
    throw new Error(`--seed must be an integer (got ${opts.seed})`);
  }
  if (!Array.isArray(opts.types) || opts.types.length === 0) {
    throw new Error('--types must list at least one of: po, invoice');
  }
  for (const t of opts.types) {
    if (!ALL_TYPES.includes(t)) {
      throw new Error(`--types: unknown type '${t}' (valid: ${ALL_TYPES.join(', ')})`);
    }
  }
  if (opts.layouts !== null) {
    if (!Array.isArray(opts.layouts) || opts.layouts.length === 0) {
      throw new Error('--layouts must list at least one layout');
    }
    for (const l of opts.layouts) {
      if (!LAYOUT_KEYS.includes(l)) {
        throw new Error(`--layouts: unknown layout '${l}' (valid: ${LAYOUT_KEYS.join(', ')})`);
      }
    }
  }
}

/**
 * Format an integer with thousands separators (Western grouping for the
 * counts in the summary tables; the in-PDF money uses Indian grouping).
 *
 * @param {number} n
 * @returns {string}
 */
function formatInt(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Render a small ASCII table from a `label → count` map, sorted by
 * count descending.
 *
 * @param {string} title
 * @param {Record<string, number>} counts
 * @returns {string} multi-line table; no trailing newline
 */
function asciiTable(title, counts) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return `${title}:\n  (none)`;
  const labelWidth = Math.max(...entries.map(([k]) => k.length), 5);
  const countWidth = Math.max(...entries.map(([, v]) => formatInt(v).length), 5);
  const lines = [`${title}:`];
  for (const [label, count] of entries) {
    lines.push(`  ${label.padEnd(labelWidth)}  ${formatInt(count).padStart(countWidth)}`);
  }
  return lines.join('\n');
}

/**
 * Build a throttled progress callback (prints at most every
 * PROGRESS_EVERY_DOCS docs OR PROGRESS_EVERY_MS ms, plus the final one).
 *
 * @returns {(p:{done:number,total:number}) => void}
 */
function makeProgressLogger() {
  let lastDone = 0;
  let lastAt = Date.now();
  return ({ done, total }) => {
    const now = Date.now();
    const isFinal = done >= total;
    if (isFinal || done - lastDone >= PROGRESS_EVERY_DOCS || now - lastAt >= PROGRESS_EVERY_MS) {
      process.stdout.write(`[${done}/${total}] rendered\n`);
      lastDone = done;
      lastAt = now;
    }
  };
}

/**
 * Resolution-stress mode. Loads the Tally master export, plans `count`
 * documents whose party + line-item names are adversarial variants of
 * real masters, renders them through the normal PDF pipeline, and writes
 * a ground-truth `stress-manifest.json` (per-doc intended masters +
 * expected resolver outcomes, plus summary counts).
 *
 * @param {ReturnType<typeof parseArgs>} opts
 * @param {string} outDir - resolved absolute output directory
 * @param {Date} now - date anchor
 * @returns {Promise<void>}
 */
async function runStress(opts, outDir, now) {
  const rng = createRng(opts.seed);
  const mastersPath = path.resolve(process.cwd(), opts.masters);

  // Load + validate the master export (clear errors when missing/empty).
  let masters;
  try {
    masters = validateMasters(await loadMasters(mastersPath), mastersPath);
  } catch (err) {
    fail(err.message);
  }

  process.stdout.write(
    `docrithm-pdf-gen: STRESS seed=${opts.seed} count=${opts.count} `
      + `now=${now.toISOString()} out=${outDir}\n`,
  );
  process.stdout.write(
    `docrithm-pdf-gen: company='${masters.company}' `
      + `ledgers=${masters.ledgers.length} stock=${masters.stock.length} `
      + `types=${opts.types.join(',')}\n`,
  );

  // 1. Plan the adversarial documents + their ground truth.
  const { orders, truths } = planStress({
    rng,
    masters,
    count: opts.count,
    now,
    types: opts.types,
  });
  process.stdout.write(`docrithm-pdf-gen: planned ${orders.length} stress documents\n`);

  // 2. Render through the existing pipeline (distorted strings ride in
  //    the party-name / line-description fields the templates print).
  const startedAt = Date.now();
  const onProgress = makeProgressLogger();
  let stats;
  try {
    stats = await renderAll(orders, outDir, { seed: opts.seed, onProgress });
  } catch (err) {
    fail(`render failed: ${err.message}`);
  }

  // 3. Build the ground-truth stress manifest. Each doc maps its shown
  //    party + line items back to the intended master + expected outcome
  //    so the resolution harness can be scored against truth.
  const docs = stats.manifest.map((row, i) => ({
    file: row.file,
    docType: truths[i].docType,
    party: truths[i].party,
    lineItems: truths[i].lineItems,
  }));
  const summary = summariseTruths(truths);
  const manifestDoc = {
    company: masters.company,
    count: stats.written,
    seed: opts.seed,
    mastersPath,
    now: now.toISOString(),
    description:
      'Ground-truth map for DocRithm resolution-stress docs. For each PDF, '
      + 'every shown party/line reference is mapped to the Tally master it '
      + 'SHOULD resolve to + the expected resolver outcome. Score the harness '
      + 'output against this.',
    docs,
    summary,
  };
  const manifestPath = path.join(outDir, 'stress-manifest.json');
  await fs.writeFile(manifestPath, `${JSON.stringify(manifestDoc, null, 2)}\n`, 'utf8');

  const elapsedSec = (Date.now() - startedAt) / 1000;
  process.stdout.write('\n');
  process.stdout.write(
    `Done. Wrote ${formatInt(stats.written)} PDF(s) + stress-manifest.json to ${outDir}\n`,
  );
  process.stdout.write(`Elapsed: ${elapsedSec.toFixed(1)}s\n\n`);
  process.stdout.write(`${asciiTable('By difficulty', summary.byDifficulty)}\n\n`);
  process.stdout.write(`${asciiTable('By expected outcome', summary.byExpectedOutcome)}\n`);
}

/**
 * Main entry point.
 *
 * @returns {Promise<void>}
 */
async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${helpText()}\n\n`);
    fail(err.message);
  }

  if (opts.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }

  try {
    validateOptions(opts);
  } catch (err) {
    fail(err.message);
  }

  const outDir = path.resolve(process.cwd(), opts.outDir);
  const now = opts.now ?? new Date();

  // Resolution-stress mode is a separate pipeline (adversarial master
  // variants + ground-truth manifest); dispatch and return early.
  if (opts.stress) {
    await runStress(opts, outDir, now);
    return;
  }

  const rng = createRng(opts.seed);
  const catalog = loadCatalog();

  process.stdout.write(
    `docrithm-pdf-gen: seed=${opts.seed} count=${opts.count} now=${now.toISOString()} out=${outDir}\n`,
  );
  process.stdout.write(
    `docrithm-pdf-gen: types=${opts.types.join(',')} layouts=${opts.layouts ? opts.layouts.join(',') : 'all'}\n`,
  );

  // 1. Plan the document shells (party pairing, scenario, layout).
  const shells = planOrders({
    rng,
    count: opts.count,
    now,
    types: opts.types,
    layoutFilter: opts.layouts,
  });
  process.stdout.write(`docrithm-pdf-gen: planned ${shells.length} documents\n`);

  // 2. Fill each shell with line items + computed tax (CPU-cheap;
  //    synchronous before any disk I/O).
  const orders = shells.map((s) => fillOrder(s, rng, catalog));

  // 3. Render to disk with throttled progress, collecting the manifest.
  const startedAt = Date.now();
  const onProgress = makeProgressLogger();
  let stats;
  try {
    stats = await renderAll(orders, outDir, { seed: opts.seed, onProgress });
  } catch (err) {
    fail(`render failed: ${err.message}`);
  }

  // 4. Write the manifest. Pretty-printed for human diffing; it indexes
  //    every PDF with its ground-truth fields for harness comparison.
  const manifestPath = path.join(outDir, 'manifest.json');
  const manifestDoc = {
    _meta: {
      generator: 'docrithm-pdf-gen',
      seed: opts.seed,
      now: now.toISOString(),
      count: stats.written,
      types: opts.types,
      layouts: opts.layouts ?? LAYOUT_KEYS.slice(),
      description:
        'Ground-truth index of every generated PDF. Diff DocRithm '
        + 'extraction output against `expected` per file.',
    },
    files: stats.manifest,
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifestDoc, null, 2)}\n`, 'utf8');

  const elapsedSec = (Date.now() - startedAt) / 1000;
  const throughput = elapsedSec > 0 ? stats.written / elapsedSec : 0;

  // 5. Final summary: four ASCII tables + stats line.
  process.stdout.write('\n');
  process.stdout.write(`Done. Wrote ${formatInt(stats.written)} PDF(s) + manifest.json to ${outDir}\n`);
  process.stdout.write(`Elapsed: ${elapsedSec.toFixed(1)}s  Throughput: ${throughput.toFixed(1)} docs/sec\n\n`);
  process.stdout.write(`${asciiTable('By type', stats.byType)}\n\n`);
  process.stdout.write(`${asciiTable('By vendor', stats.byVendor)}\n\n`);
  process.stdout.write(`${asciiTable('By layout', stats.byLayout)}\n\n`);
  process.stdout.write(`${asciiTable('By scenario', stats.byScenario)}\n`);
}

main().catch((err) => {
  process.stderr.write(`docrithm-pdf-gen: unexpected failure: ${err.stack ?? err}\n`);
  process.exit(1);
});
