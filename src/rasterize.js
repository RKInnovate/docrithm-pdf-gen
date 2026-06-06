/**
 * PDF → image-only PDF rasterizer.
 *
 * # Purpose
 * Some real-world purchase documents arrive as *scans* — the file is a
 * wrapper around a bitmap, with NO extractable text layer. A consumer
 * like DocRithm cannot `pypdf`/`pdftotext` those; it must fall back to
 * OCR. To exercise that path in the stress set, this module takes a
 * normally-rendered (vector, text-bearing) PDF buffer and re-emits an
 * equivalent PDF whose every page is a single full-bleed raster image —
 * i.e. the text layer is gone and OCR is forced.
 *
 * # How
 * 1. Write the vector PDF to a temp file.
 * 2. Rasterize each page to a PNG with a self-contained CLI rasterizer
 *    (poppler's `pdftoppm`/`pdftocairo` — chosen because they embed their
 *    own renderer and need no ghostscript, unlike ImageMagick's PDF
 *    delegate).
 * 3. Re-wrap the PNGs into a new PDF via the shared pdfmake printer: one
 *    page per image, page size derived from the PNG's pixel dimensions at
 *    the render DPI, zero margins → the image fills the page edge-to-edge.
 *    The wrapper carries no text, so the result has no text layer.
 *
 * # Determinism
 * Same input bytes + same DPI → same PNGs → same wrapper PDF (CreationDate
 * is pinned by the caller). Temp-file paths do not affect output bytes.
 *
 * # Graceful degradation
 * If no rasterizer is on PATH, `detectRasterizer()` returns null and the
 * caller falls back to emitting the normal vector PDF (with a warning) —
 * generation never hard-fails just because poppler is absent.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Default rasterization resolution. 150 DPI looks like a typical office
// scan: large enough for OCR to succeed, small enough that an 80-doc set
// stays a few MB. Tunable by the caller.
export const DEFAULT_IMAGE_DPI = 150;

// Self-contained PDF rasterizers, in preference order. Both ship their
// own rendering engine (poppler) — no ghostscript dependency. We probe
// with a cheap flag and treat ENOENT (not on PATH) as "absent".
const CANDIDATES = [
  { cmd: 'pdftoppm', probe: ['-h'] },
  { cmd: 'pdftocairo', probe: ['-h'] },
];

let cachedTool; // undefined = not probed yet; null = none found; else descriptor

/**
 * Detect an available self-contained PDF rasterizer once per process.
 *
 * @returns {?{cmd:string}} descriptor for the chosen tool, or null if none
 */
export function detectRasterizer() {
  if (cachedTool !== undefined) return cachedTool;
  for (const cand of CANDIDATES) {
    // `-h` exits non-zero on some builds, so success is "it ran at all"
    // (no spawn error), not exit code 0.
    const res = spawnSync(cand.cmd, cand.probe, { stdio: 'ignore' });
    if (!res.error) {
      cachedTool = { cmd: cand.cmd };
      return cachedTool;
    }
  }
  cachedTool = null;
  return cachedTool;
}

/**
 * Read a PNG's pixel dimensions straight from its IHDR chunk — avoids a
 * decoding dependency. PNG = 8-byte signature, then the IHDR chunk whose
 * width/height are big-endian uint32 at byte offsets 16 and 20.
 *
 * @param {Buffer} buf - PNG file contents
 * @returns {{w:number,h:number}}
 */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452 /* 'IHDR' */) {
    throw new Error('rasterize: not a valid PNG (no IHDR)');
  }
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/**
 * Render a pdfmake docDefinition to a single in-memory Buffer (rather
 * than streaming to disk). Used both to capture the vector PDF before
 * rasterizing and to capture the final image-only wrapper.
 *
 * @param {import('pdfmake')} printer - configured PdfPrinter
 * @param {object} docDefinition
 * @returns {Promise<Buffer>}
 */
export function docToBuffer(printer, docDefinition) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const pdfDoc = printer.createPdfKitDocument(docDefinition);
    pdfDoc.on('data', (c) => chunks.push(c));
    pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
    pdfDoc.on('error', reject);
    pdfDoc.end();
  });
}

/**
 * Convert a vector PDF buffer into an image-only PDF buffer (no text
 * layer), forcing any downstream consumer to OCR it.
 *
 * @param {Buffer} vectorPdf - a normally-rendered, text-bearing PDF
 * @param {object} args
 * @param {import('pdfmake')} args.printer - shared PdfPrinter for the wrapper
 * @param {{cmd:string}} args.rasterizer - descriptor from detectRasterizer()
 * @param {number} [args.dpi=DEFAULT_IMAGE_DPI] - rasterization resolution
 * @param {Date} args.creationDate - pinned CreationDate for determinism
 * @param {string} args.tmpTag - unique fragment for the temp dir (avoids
 *   collisions when renders run concurrently)
 * @returns {Promise<Buffer>} the image-only PDF
 */
export async function pdfToImageOnlyPdf(vectorPdf, {
  printer,
  rasterizer,
  dpi = DEFAULT_IMAGE_DPI,
  creationDate,
  tmpTag,
}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `drpg-img-${tmpTag}-`));
  try {
    const inPath = path.join(workDir, 'in.pdf');
    fs.writeFileSync(inPath, vectorPdf);

    // Both poppler tools share the same CLI shape:
    //   <cmd> -png -r <dpi> <input.pdf> <out-prefix>
    // emitting <out-prefix>-N.png (N zero-padded to the page-count width).
    const prefix = path.join(workDir, 'page');
    const res = spawnSync(
      rasterizer.cmd,
      ['-png', '-r', String(dpi), inPath, prefix],
      { stdio: 'ignore' },
    );
    if (res.status !== 0) {
      throw new Error(
        `rasterize: ${rasterizer.cmd} exited ${res.status ?? '(signal)'} `
          + `while rasterizing PDF`,
      );
    }

    // Collect + numerically sort the emitted pages (page-1.png, page-2.png…).
    const pngs = fs
      .readdirSync(workDir)
      .filter((f) => f.startsWith('page') && f.endsWith('.png'))
      .map((f) => ({
        f,
        n: Number((f.match(/-(\d+)\.png$/) ?? [])[1] ?? 0),
      }))
      .sort((a, b) => a.n - b.n);
    if (pngs.length === 0) {
      throw new Error('rasterize: rasterizer produced no PNG pages');
    }

    // Wrap each PNG full-bleed. Page size in PDF points = px * 72 / dpi so
    // the bitmap maps back to its original physical size.
    const ptPerPx = 72 / dpi;
    const content = pngs.map((p, i) => {
      const buf = fs.readFileSync(path.join(workDir, p.f));
      const { w } = pngSize(buf);
      return {
        image: `data:image/png;base64,${buf.toString('base64')}`,
        width: w * ptPerPx,
        ...(i > 0 ? { pageBreak: 'before' } : {}),
      };
    });
    // Page size from the first page's bitmap (all pages of one layout share
    // a size). pdfmake applies pageSize doc-wide.
    const first = pngSize(fs.readFileSync(path.join(workDir, pngs[0].f)));

    const docDefinition = {
      pageSize: { width: first.w * ptPerPx, height: first.h * ptPerPx },
      pageMargins: [0, 0, 0, 0],
      content,
      info: { creationDate },
      // No text is drawn, but pdfmake still requires a registered default
      // font to construct the document.
      defaultStyle: { font: 'Roboto' },
    };

    return await docToBuffer(printer, docDefinition);
  } finally {
    // Best-effort temp cleanup; never let cleanup mask a render error.
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
