/**
 * PDF rendering pipeline — turns fully-populated order objects into
 * pdfmake docDefinitions, then into on-disk `.pdf` files under the
 * configured output directory.
 *
 * # Purpose
 * This module sits between the data layer (generators/orders.js
 * produces the structured order) and the output layer (the `out/`
 * folder the DocRithm harness ingests). It is the only place that knows
 * about pdfmake's `PdfPrinter` lifecycle, font registration, and how to
 * dispatch an order to the correct document template (PO vs invoice).
 *
 * # Design decisions (ported from lab-pdf-gen)
 *
 * - **One `PdfPrinter` for the whole run.** Font registration is the
 *   expensive part of construction; PdfPrinter is safe to reuse across
 *   documents.
 *
 * - **Server-side fonts via `require.resolve` / VFS decode.** pdfmake
 *   ships Roboto inside `build/vfs_fonts.js` as base64; we decode it
 *   once into Buffers (valid pdfmake font sources) so the layout is
 *   independent of node_modules hoisting. Noto Sans Devanagari TTFs are
 *   vendored under `assets/fonts/` for the bilingual layout.
 *
 * - **Streaming write, batched 8-wide.** Each PDF is piped to a
 *   WriteStream; renders run in fixed batches of 8 so layout CPU
 *   overlaps disk I/O without starving the event loop.
 *
 * - **Pinned PDF CreationDate for byte-determinism.** `renderOne` sets
 *   `docDefinition.info.creationDate` to the order date. Without it
 *   pdfkit defaults CreationDate to `new Date()` at serialise time and
 *   derives the PDF `/ID` trailer as an MD5 over the info dict — so the
 *   bytes and identifier would differ every run even with `--seed` +
 *   `--now` fixed. The order date is a pure function of those inputs.
 *
 * - **Stable, reversible filename.** See `makeFilename`:
 *   `<vendor-slug>_<doctype>_<docid>_<seed>[_<scenarioTag>].pdf`.
 */

import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

import PdfPrinter from 'pdfmake';

import { buildDocDefinition as buildPurchaseOrder } from './templates/purchase-order.js';
import { buildDocDefinition as buildPurchaseInvoice } from './templates/purchase-invoice.js';
import {
  detectRasterizer,
  docToBuffer,
  pdfToImageOnlyPdf,
  DEFAULT_IMAGE_DPI,
} from './rasterize.js';

// `createRequire` gives us a CommonJS-style `require` inside ESM; used
// only for `require.resolve` / loading pdfmake's VFS, the reliable way
// to locate sibling-package files regardless of node_modules layout.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Absolute path to the bundled product catalogue. Resolved once.
const CATALOG_PATH = path.resolve(__dirname, '..', 'data', 'catalog.json');

// Maximum concurrent renders. 8 wide overlaps disk I/O with layout CPU
// without saturating the single-threaded pdfmake engine's event loop.
const RENDER_CONCURRENCY = 8;

// pdfmake VFS keys for the bundled Roboto family (stable across 0.2.x).
const ROBOTO_FILES = {
  normal: 'Roboto-Regular.ttf',
  bold: 'Roboto-Medium.ttf',
  italics: 'Roboto-Italic.ttf',
  bolditalics: 'Roboto-MediumItalic.ttf',
};

// On-disk directory of the vendored TTFs: the ligature-stripped Roboto
// family (see resolveRobotoFonts) plus Noto Sans Devanagari for the
// bilingual layout. Committed so a fresh clone renders without network
// access and with a clean text layer.
const FONT_DIR = path.resolve(__dirname, '..', 'assets', 'fonts');

/**
 * Resolve the four Roboto font sources, in a shape suitable for
 * `new PdfPrinter({ Roboto: ... })`.
 *
 * We prefer the vendored Roboto TTFs in assets/fonts/, which have had
 * their GSUB table removed. Why: pdfmake's bundled Roboto carries a
 * `liga` (fi/fl/ff…) ligature table — it renders those ligatures
 * correctly on the page but emits a broken ToUnicode mapping for the
 * ligature glyphs, so the PDF *text layer* reads "Ofce"/"Refned" even
 * though the page shows "Office"/"Refined". That corrupts copy-paste,
 * pdftotext, and any text-layer consumer. Stripping GSUB means every
 * glyph maps 1:1 to its codepoint, so the text layer matches the page.
 * (Regenerate the stripped TTFs with scripts/strip-roboto-ligatures.sh.)
 *
 * Falls back to pdfmake's base64 VFS Roboto when the vendored files are
 * absent — that path renders fine but reintroduces the text-layer quirk,
 * so we warn rather than fail.
 *
 * @returns {{normal:Buffer|string,bold:Buffer|string,italics:Buffer|string,bolditalics:Buffer|string}}
 */
function resolveRobotoFonts() {
  const local = {
    normal: path.join(FONT_DIR, ROBOTO_FILES.normal),
    bold: path.join(FONT_DIR, ROBOTO_FILES.bold),
    italics: path.join(FONT_DIR, ROBOTO_FILES.italics),
    bolditalics: path.join(FONT_DIR, ROBOTO_FILES.bolditalics),
  };
  // PdfPrinter accepts file-path strings as font sources.
  if (Object.values(local).every((p) => fs.existsSync(p))) {
    return local;
  }
  console.warn(
    'docrithm-pdf-gen: vendored ligature-stripped Roboto not found in '
      + `${FONT_DIR}; falling back to pdfmake's bundled Roboto. The page `
      + 'will render correctly but the text layer will drop fi/fl. Run '
      + 'scripts/strip-roboto-ligatures.sh to restore a clean text layer.',
  );

  let vfs;
  try {
    vfs = require('pdfmake/build/vfs_fonts.js');
  } catch (err) {
    let pdfmakeVersion = 'unknown';
    try {
      pdfmakeVersion = require('pdfmake/package.json').version;
    } catch {
      /* ignore */
    }
    throw new Error(
      `docrithm-pdf-gen: cannot load pdfmake's bundled Roboto fonts `
        + `(pdfmake@${pdfmakeVersion}). Tried raw TTF resolution and `
        + `pdfmake/build/vfs_fonts.js — both failed. Reinstall pdfmake. `
        + `Original: ${err.message}`,
    );
  }

  // pdfmake 0.2.x ships vfs_fonts as either a bare map or `{ pdfMake: { vfs } }`.
  const map = vfs && vfs.pdfMake && vfs.pdfMake.vfs ? vfs.pdfMake.vfs : vfs;
  const missing = Object.values(ROBOTO_FILES).filter((f) => !(f in map));
  if (missing.length > 0) {
    throw new Error(
      `docrithm-pdf-gen: pdfmake VFS missing Roboto entries: ${missing.join(', ')}. `
        + `Pin pdfmake to a version that ships Roboto in vfs_fonts.js.`,
    );
  }

  return {
    normal: Buffer.from(map[ROBOTO_FILES.normal], 'base64'),
    bold: Buffer.from(map[ROBOTO_FILES.bold], 'base64'),
    italics: Buffer.from(map[ROBOTO_FILES.italics], 'base64'),
    bolditalics: Buffer.from(map[ROBOTO_FILES.bolditalics], 'base64'),
  };
}

/**
 * Resolve the Noto Sans Devanagari font sources for the bilingual
 * layout. Returns `null` (with a one-line warning) if the TTFs aren't
 * on disk — the bilingual layout then falls back to Roboto, rendering
 * Devanagari as tofu boxes. Noto Devanagari ships no italics, so we
 * alias italics→regular and bolditalics→bold.
 *
 * @returns {?{normal:string,bold:string,italics:string,bolditalics:string}}
 */
function resolveDevanagariFonts() {
  const regular = path.join(FONT_DIR, 'NotoSansDevanagari-Regular.ttf');
  const bold = path.join(FONT_DIR, 'NotoSansDevanagari-Bold.ttf');
  try {
    fs.accessSync(regular);
    fs.accessSync(bold);
    return { normal: regular, bold, italics: regular, bolditalics: bold };
  } catch {
    console.warn(
      `docrithm-pdf-gen: NotoSansDevanagari TTFs not found in ${FONT_DIR}. `
        + `Bilingual layout will fall back to Roboto (Devanagari glyphs appear as boxes).`,
    );
    return null;
  }
}

// Resolve fonts lazily so module import doesn't fail if pdfmake isn't
// installed yet (e.g. linters that import this file).
let cachedFontDescriptors = null;
function getFontDescriptors() {
  if (!cachedFontDescriptors) {
    const fonts = { Roboto: resolveRobotoFonts() };
    const dev = resolveDevanagariFonts();
    if (dev) fonts.NotoSansDevanagari = dev;
    cachedFontDescriptors = fonts;
  }
  return cachedFontDescriptors;
}

/**
 * Synchronously load the product catalogue used by the generators and
 * templates. Small (~6 KB), loaded once at CLI startup.
 *
 * @returns {object} parsed catalog.json (`_meta` + `items`)
 */
export function loadCatalog() {
  return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
}

/**
 * Build a configured `PdfPrinter`. Call once per run and thread it into
 * every `renderOne` — font registration is the expensive part.
 *
 * @returns {PdfPrinter}
 */
export function createPrinter() {
  return new PdfPrinter(getFontDescriptors());
}

/**
 * Dispatch an order to its document-type template.
 *
 * @param {'po'|'invoice'} docType
 * @returns {(order:object) => object} a `buildDocDefinition` fn
 */
function templateFor(docType) {
  switch (docType) {
    case 'po':
      return buildPurchaseOrder;
    case 'invoice':
      return buildPurchaseInvoice;
    default:
      throw new Error(`docrithm-pdf-gen: unknown docType '${docType}'`);
  }
}

/**
 * Sanitise a filename fragment so a stray meta-char in the data layer
 * can't produce an invalid path. Replaces anything outside
 * `[A-Za-z0-9._-]` with '-'.
 *
 * @param {string} part
 * @returns {string}
 */
function safeFragment(part) {
  return String(part).replace(/[^A-Za-z0-9._-]/g, '-');
}

/**
 * Build the on-disk filename for an order, per the README contract:
 *   `<vendor-slug>_<doctype>_<docid>_<seed>[_<scenarioTag>].pdf`
 *
 * The docId contains slashes (`PO/2026-27/00001`) so it is sanitised to
 * dashes. The first non-`normal` scenario tag (if any) is appended so a
 * failing sample is identifiable + reproducible from its name alone.
 * Two invoices sharing a docId (dup-invoice-number scenario) would
 * collide on disk; we disambiguate with the run-unique `seq` suffix so
 * both files are written while their printed docId stays duplicated.
 *
 * @param {object} order - populated order
 * @param {number} seed - the run seed (encoded for reproducibility)
 * @param {number} seq - run-unique sequence (collision tiebreaker)
 * @returns {string} filename only (no directory component)
 */
export function makeFilename(order, seed, seq) {
  const vendor = safeFragment(order.vendor.slug);
  const docType = safeFragment(order.docType);
  const docId = safeFragment(order.docId);
  // Encode the most interesting (non-normal) scenario tag, if present.
  const edgeTag = order.scenarioTags.find((t) => t !== 'normal');
  const tagPart = edgeTag ? `_${safeFragment(edgeTag)}` : '';
  // `seq` guarantees uniqueness even when docIds deliberately collide.
  return `${vendor}_${docType}_${docId}_s${seed}-${seq}${tagPart}.pdf`;
}

/**
 * Render a single order to disk. Streaming form so layout overlaps disk
 * I/O. Pins CreationDate to the order date for byte-determinism.
 *
 * @param {object} order - populated order from `fillOrder`
 * @param {string} outDir - directory; created recursively if missing
 * @param {PdfPrinter} printer - shared printer
 * @param {number} seed - run seed (for the filename)
 * @param {number} seq - run-unique sequence (for the filename)
 * @param {object} [imageOpts] - image-only rendering controls:
 *   { rasterizer, dpi } — when `order.imageOnly` and a rasterizer is
 *   present, the page is re-emitted as a text-layer-free scan (forces OCR).
 * @returns {Promise<string>} absolute path to the written `.pdf`
 */
export async function renderOne(order, outDir, printer, seed, seq, imageOpts = {}) {
  const buildDocDefinition = templateFor(order.docType);
  const docDefinition = buildDocDefinition(order);

  // Pin CreationDate to the (deterministic) order date — see header.
  docDefinition.info = { ...docDefinition.info, creationDate: order.orderDate };

  const filename = makeFilename(order, seed, seq);
  const fullPath = path.resolve(outDir, filename);

  await fsPromises.mkdir(outDir, { recursive: true });

  // Image-only (scanned) path: render the vector PDF to a buffer, then
  // rasterize + rewrap so the file carries no text layer and the consumer
  // must OCR it. Only when the order opts in AND a rasterizer is available.
  if (order.imageOnly && imageOpts.rasterizer) {
    const vector = await docToBuffer(printer, docDefinition);
    const imagePdf = await pdfToImageOnlyPdf(vector, {
      printer,
      rasterizer: imageOpts.rasterizer,
      dpi: imageOpts.dpi ?? DEFAULT_IMAGE_DPI,
      creationDate: order.orderDate,
      tmpTag: `${seed}-${seq}`,
    });
    await fsPromises.writeFile(fullPath, imagePdf);
    return fullPath;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };
    const pdfDoc = printer.createPdfKitDocument(docDefinition);
    const stream = fs.createWriteStream(fullPath);
    stream.on('finish', () => settle(resolve, fullPath));
    stream.on('error', (err) => settle(reject, err));
    pdfDoc.on('error', (err) => settle(reject, err));
    pdfDoc.pipe(stream);
    pdfDoc.end();
  });
}

/**
 * Render an array of orders concurrently in fixed batches of 8,
 * accumulating per-type / per-vendor / per-layout / per-scenario counts
 * AND a manifest row per file. The manifest indexes every generated PDF
 * with its ground-truth fields so the DocRithm harness output can be
 * diffed against truth.
 *
 * @param {object[]} orders - populated orders
 * @param {string} outDir - directory to write PDFs into
 * @param {object} opts
 * @param {number} opts.seed - run seed (encoded in filenames + manifest)
 * @param {(progress:{done:number,total:number}) => void} [opts.onProgress]
 * @param {number} [opts.imageDpi] - DPI for image-only (scanned) docs
 * @returns {Promise<{written:number, imageWritten:number, byType:object, byVendor:object, byLayout:object, byScenario:object, manifest:object[]}>}
 */
export async function renderAll(orders, outDir, opts) {
  const { seed, onProgress, imageDpi } = opts;
  const printer = createPrinter();

  // Detect a rasterizer once if any order wants image-only output. If none
  // is on PATH, warn a single time and fall back to vector PDFs so the run
  // still completes (the OCR-stress subset just won't be image-backed).
  const wantsImages = orders.some((o) => o.imageOnly);
  const rasterizer = wantsImages ? detectRasterizer() : null;
  if (wantsImages && !rasterizer) {
    console.warn(
      'docrithm-pdf-gen: image-only (scanned) docs were requested but no PDF '
        + 'rasterizer (pdftoppm / pdftocairo from poppler) is on PATH. Those '
        + 'docs will be emitted as normal vector PDFs WITH a text layer — they '
        + 'will NOT force OCR. Install poppler (macOS: brew install poppler) '
        + 'and re-run to get true image-only scans.',
    );
  }
  const imageOpts = { rasterizer, dpi: imageDpi };
  let imageWritten = 0;

  const byType = Object.create(null);
  const byVendor = Object.create(null);
  const byLayout = Object.create(null);
  const byScenario = Object.create(null);
  const manifest = [];
  let written = 0;

  await fsPromises.mkdir(outDir, { recursive: true });

  for (let i = 0; i < orders.length; i += RENDER_CONCURRENCY) {
    const batch = orders.slice(i, i + RENDER_CONCURRENCY);
    // Each order's run-unique seq is its global index (i + local). Used
    // both for the filename collision tiebreaker and manifest ordering.
    // eslint-disable-next-line no-await-in-loop -- batches are sequential by design
    const paths = await Promise.all(
      batch.map((order, k) => renderOne(order, outDir, printer, seed, i + k + 1, imageOpts)),
    );

    batch.forEach((order, k) => {
      const seq = i + k + 1;
      const file = path.basename(paths[k]);
      // Actual rendering kind: image-only only when requested AND a
      // rasterizer was present; otherwise it fell back to vector.
      const rendering = order.imageOnly && rasterizer ? 'image' : 'vector';
      if (rendering === 'image') imageWritten += 1;

      byType[order.docType] = (byType[order.docType] ?? 0) + 1;
      byVendor[order.vendor.slug] = (byVendor[order.vendor.slug] ?? 0) + 1;
      byLayout[order.layoutKey] = (byLayout[order.layoutKey] ?? 0) + 1;
      for (const tag of order.scenarioTags) {
        byScenario[tag] = (byScenario[tag] ?? 0) + 1;
      }

      manifest.push({
        file,
        docType: order.docType,
        docId: order.docId,
        vendor: order.vendor.slug,
        buyer: order.buyer.slug,
        layoutKey: order.layoutKey,
        // 'image' = rasterized scan (no text layer, OCR required);
        // 'vector' = normal text-bearing PDF.
        rendering,
        scenarioTags: order.scenarioTags.slice(),
        seed,
        seq,
        expected: {
          poNumber: order.poNumber, // null under the missing-po-number scenario
          orderDate: order.suppressOrderDate ? null : order.orderDate.toISOString(),
          grandTotal: order.totals.grandTotal,
          lineItemCount: order.totals.lineItemCount,
          taxType: order.taxType,
          gstin: order.vendor.gstin,
          buyerGstin: order.buyer.gstin,
          currency: order.currency.code,
        },
      });
    });

    written += batch.length;
    if (onProgress) onProgress({ done: written, total: orders.length });
  }

  return { written, imageWritten, byType, byVendor, byLayout, byScenario, manifest };
}
