# docrithm-pdf-gen

Synthetic, multi-layout **purchase-order (PO)** and **purchase-invoice / tax-invoice (PI)**
PDF generator for stress-testing the **DocRithm** document-processing app.

It emits realistic Indian B2B procurement documents — GSTIN, HSN/SAC codes, CGST/SGST/IGST,
₹ amounts, Net-30 terms, authorised-signatory blocks — across multiple fictitious vendors,
buyers and visual layouts, with deliberate edge-case scenarios baked in as **ground truth**
(written to `out/manifest.json`) so extraction output can be diffed against truth.

It is a sibling of `lab-pdf-gen` and shares its architecture (seeded RNG, plan→fill→render
pipeline, pluggable layouts, byte-level determinism).

## Package manager: pnpm only

Node ESM project (`"type": "module"`). Use **`pnpm` exclusively** — never `npm`, `yarn`, or
`bun`. Lockfile is `pnpm-lock.yaml`.

## Quick start

```bash
pnpm install
pnpm run generate:smoke              # 30 PDFs, seed 42 — quick sanity check
pnpm run generate -- --count 200 --seed 7 --types invoice
pnpm run generate -- --help         # full CLI flag reference
pnpm run lint                        # node --check over every src/**/*.js
```

## CLI

```
Usage: docrithm-pdf-gen [options]

  --count N            Number of PDFs to emit (default 60)
  --seed N             Deterministic RNG seed (default 42)
  --now TIMESTAMP      Anchor for all document dates: epoch ms or an ISO-8601
                       string (default: current wall-clock). Pin --now with
                       --seed for byte-identical reruns.
  --out-dir PATH       Output directory (default ./out)
  --types po,invoice   Document types to emit (default po,invoice)
  --layouts a,b,c      Restrict to these layouts (default: all)
  --image-ratio R      (--stress) fraction 0..1 of docs emitted as image-only
                       scans — no text layer, forces OCR (default 0.15)
  -h, --help           Show this help and exit
```

## Output naming

```
out/<vendor-slug>_<doctype>_<docid>_s<seed>-<seq>[_<scenarioTag>].pdf
```

Deterministic and reversible. The `<seq>` keeps filenames unique even when two invoices
deliberately share a `docId` (the duplicate-invoice-number scenario). The first non-`normal`
scenario tag is appended so a failing sample is identifiable from its name alone.

## `out/manifest.json` (ground truth)

Every generated PDF gets a manifest row with its expected fields:

```jsonc
{
  "file": "apex-supplies-demo_invoice_INV-2026-27-00028_s42-28.pdf",
  "docType": "invoice",
  "docId": "INV/2026-27/00028",
  "vendor": "apex-supplies-demo",
  "buyer": "nova-manufacturing-demo",
  "layoutKey": "clean-modern",
  "scenarioTags": ["normal"],
  "seed": 42,
  "seq": 28,
  "expected": {
    "poNumber": "PO-2026-1234",   // null under the missing-po-number scenario
    "orderDate": "2026-01-12T...", // null under the missing-date scenario
    "grandTotal": 123456,
    "lineItemCount": 5,
    "taxType": "CGST+SGST",        // or "IGST"
    "gstin": "27AAACA1234A1Z5",
    "buyerGstin": "29GGHIJ6789G1Z7",
    "currency": "INR"              // or USD / EUR
  }
}
```

## Architecture (content vs. presentation are orthogonal)

- **Document type** = `src/templates/<type>.js` (`purchase-order.js`, `purchase-invoice.js`).
  Owns *what the document says* — a PO omits the amount-in-words, bank details and payment
  declaration that an invoice carries.
- **Layout** = `src/layouts/<layout>.js`. Owns *how it looks*. Layouts know nothing about
  PO-vs-invoice; they operate on the generic `order` shape via a uniform interface
  (`headerBlock`, `metaBlock`, `partiesBlock`, `lineItemsTable`, `taxSummary`, `totalsBlock`,
  `amountWordsLine`, `signatureBlock`, `pageFooter`, plus the optional `pageBackground`).
- **Data** = `src/generators/orders.js` (plan→fill) + `src/vendors.js` + `data/catalog.json`.

### Layouts

| key                | look                                              |
|--------------------|---------------------------------------------------|
| `clean-modern`     | modern corporate, accent colour, zebra table (ref)|
| `classic-bordered` | full black grid, ALL-CAPS, no colour              |
| `compact-dense`    | tiny fonts, dot-leader rows, tight margins        |
| `letterhead-formal`| full-bleed accent band, borderless gridless table |
| `landscape-wide`   | A4 landscape, per-line tax columns                |
| `faxed-scan`       | grey tint, scan lines, smudge, dashed rules (OCR) |
| `bilingual-en-hi`  | English + Devanagari labels & vendor names        |

## Scenario coverage

Weighted RNG buckets (the `normal` bucket dominates at ~60%), recorded in `scenarioTags` and
encoded into the filename:

`normal`, `igst-interstate`, `cgst-sgst-intrastate`, `multipage-overflow` (40+ items),
`foreign-currency` (₹→$/€), `zero-value-line`, `long-strings`, `missing-po-number`,
`missing-date`, `bilingual-devanagari` (Tally fuzzy-match stress), `faxed-scan`,
`landscape`, and `dup-invoice-number` (two invoices sharing a number, applied cross-document).

## Resolution-stress mode (`--stress`)

Generates documents whose party + line-item names are **adversarial variants of
REAL Tally masters**, to stress-test (and try to break) DocRithm's resolution
harness. Each shown name is a distorted form of a known master; the harness must
still map it back.

```bash
# 1. Export the real masters from the connected Tally (run with the app CLOSED —
#    DuckDB single-writer lock). Tool lives in the DocRithm-wails repo:
#      (cd ../DocRithm-wails && go run ./cmd/dump-masters)   # → data/tally-masters.json
# 2. Generate the stress set:
node src/index.js --stress --masters data/tally-masters.json --count 80 --seed 7 --out-dir ./out-stress
#    (a bundled data/tally-masters.sample.json works without a live Tally)
```

### Layout spread + image-only scans

Stress docs now also vary **visual layout** (previously all `clean-modern`): the
layout is derived deterministically from the *intended* ledger master, so each
fictitious vendor consistently prints on its own template while the set spreads
across all 7 layouts — exercising extraction (OCR, table shapes, bilingual labels)
on top of the name distortions. Each doc's `layoutKey` is recorded in the manifest.

A fraction (`--image-ratio`, default **0.15**) are emitted as **image-only PDFs**:
the page is rasterized to a 150-DPI bitmap with **no text layer**, so `pypdf` /
`pdftotext` extract nothing and the consumer is forced down its **OCR** path. These
are tagged `image-only-ocr` and marked `"rendering": "image"` in the manifest.
Rasterization uses poppler's `pdftoppm`/`pdftocairo` (self-contained, no ghostscript);
if neither is on PATH the run degrades gracefully to vector PDFs with a warning
(`brew install poppler` to enable). Reruns stay byte-identical.

The distortion catalog lives in `src/adversarial.js` (packaging/qty noise,
legal-suffix churn, token reorder/initials, OCR-confusables, branch/numbered-office
suffixes, Devanagari/transliteration, merge/split/truncate, …), each tagged with a
`difficulty` (1=easy … 5=brutal) and an `expectedOutcome` (`resolved` /
`ambiguous` / `unmatched`). The run writes `out-stress/stress-manifest.json` — the
ground truth: for every doc, each reference's `shown` text, `intendedMaster`,
`distortion`, `difficulty`, and `expectedOutcome` — so a resolver bench can diff
the harness's actual output against what it *should* have done.

## Determinism

Pure: no `Math.random`, no `Date.now()` inside generation. Thread a single `--now` anchor
and the seeded RNG everywhere. Pin **both** `--seed` and `--now` for byte-identical reruns
(verified: same filenames, same SHA-256, same `manifest.json`). The PDF `CreationDate` is
pinned to the order date so even the embedded timestamp + `/ID` trailer are stable.

## Fonts

Roboto comes from pdfmake's bundled VFS. Noto Sans Devanagari (for `bilingual-en-hi`) is
vendored under `assets/fonts/` so a fresh clone renders Hindi without network access.

---

All data is **synthetic**. No real purchase, vendor, buyer, GSTIN, or transaction is
represented. Never enter these documents into any ledger or accounting system.
