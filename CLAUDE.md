# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## What this is

`docrithm-pdf-gen` is a synthetic Indian B2B **purchase-order / tax-invoice** PDF generator.
It stress-tests the downstream **DocRithm** document-processing app (OCR, field extraction,
GST/tax parsing, Tally matching, dedup). It emits realistic POs and invoices across 7 visual
layouts and multiple fictitious vendors/buyers, with deliberate edge-case scenarios baked in
as weighted RNG buckets and recorded as ground truth in `out/manifest.json`. It is a sibling
of `lab-pdf-gen` and mirrors its architecture. It is a pure data generator — never runs in
production.

## Package manager: pnpm only

Node ESM project (`"type": "module"`). Use **`pnpm` exclusively** — never `npm`, `yarn`, or
`bun`. The lockfile is `pnpm-lock.yaml`.

## Commands

```bash
pnpm install
pnpm run generate:smoke   # 30 PDFs, seed 42 — quick end-to-end sanity check
pnpm run generate -- --count 200 --seed 7 --types invoice --out-dir ./out
pnpm run generate -- --help
pnpm run lint             # node --check over every src/**/*.js (the compile gate)
```

There is no unit-test suite or linter beyond `node --check`. The de facto correctness test is
the **determinism check**: re-running with the same `--seed` AND `--now` must produce
byte-identical PDFs and an identical `manifest.json`.

```bash
node src/index.js --count 30 --seed 42 --now 2026-05-29T12:00:00Z --out-dir ./out-a
node src/index.js --count 30 --seed 42 --now 2026-05-29T12:00:00Z --out-dir ./out-b
diff <(ls out-a) <(ls out-b)         # identical filenames
shasum out-a/<file> out-b/<file>     # identical bytes
diff out-a/manifest.json out-b/manifest.json
```

## Architecture: type vs. layout are orthogonal

- **Document type** (`src/templates/purchase-order.js`, `purchase-invoice.js`) owns *what the
  document says*. A PO omits the amount-in-words line, bank details, and payment declaration
  that an invoice carries.
- **Layout** (`src/layouts/<layout>.js`) owns *how it looks*. Layouts are PO/invoice-agnostic;
  they operate on the generic `order` shape through a uniform interface. The canonical contract
  is the docstring of `src/layouts/clean-modern.js` — copy it verbatim into any new layout.
  Interface: `formatDate`, `formatDateTime`, `commonStyles`, `defaultPageDefinition`,
  `headerBlock`, `metaBlock`, `partiesBlock`, `lineItemsTable`, `taxSummary`, `totalsBlock`,
  `amountWordsLine`, `signatureBlock`, `pageFooter`, plus the **optional** `pageBackground`
  (used by `letterhead-formal` and `faxed-scan`; templates wire it into the doc-level
  `background` only when present).
- **Data layer**: `src/generators/orders.js` (`planOrders` → `fillOrder`), `src/vendors.js`
  (vendor + buyer pools, state-pairing pickers for forced tax scenarios), `data/catalog.json`
  (line-item products with HSN + GST slab).
- **Shared formatting**: `src/format.js` — date/money (Indian lakh grouping, hand-rolled to
  avoid ICU-version drift), amount-in-words, signatory + bank pools, disclaimer.
- **Render**: `src/render.js` — PdfPrinter + font registration, batched 8-wide streaming
  write, docType dispatch, deterministic CreationDate, filename + manifest construction.

## Determinism rules (non-negotiable)

- No `Math.random` — all randomness flows through `src/seedrand.js` (mulberry32), seeded by
  `--seed`.
- No `Date.now()` inside generation — thread the single `--now` anchor everywhere. `Date.now`
  is allowed ONLY in the CLI progress-throttle (cosmetic, doesn't affect output bytes).
- `layoutKey`, the scenario, the vendor/buyer pairing, and the doc IDs are all decided ONCE at
  plan time and never re-rolled at render time.
- The PDF `CreationDate` is pinned to the order date so the embedded timestamp and `/ID`
  trailer are stable across runs.

## Two-pass tax computation (the core arithmetic)

`fillOrder` mirrors the computed-analyte resolver in `lab-pdf-gen/analytes.js`:
1. **Pass 1** (per line): sample qty + unit price, compute line amount.
2. **Pass 2** (document): subtotal → discount → taxable (apportioned pro-rata per line) →
   per-(HSN, slab) tax: **CGST+SGST** when `vendor.stateCode === buyer.stateCode`
   (intra-state) else **IGST** (inter-state) → round-off → grand total.

Every division is guarded against zero (e.g. an all-free document) so a degenerate sample can
never put NaN/Infinity into a printed invoice.

## Code standards (per global CLAUDE.md)

- Every file starts with a file-level doc header (purpose, role, design decisions).
- Every exported function has a JSDoc docstring.
- Inline comments explain **why**, not just what.
- Run `pnpm run lint` before committing; keep the determinism check green.
