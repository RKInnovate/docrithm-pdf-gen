/**
 * Shared formatting + small shared data used across layouts.
 *
 * # Purpose
 * Layouts make their own visual choices (colours, borders, spacing) but
 * share a handful of pure, presentation-neutral helpers: date
 * formatting, Indian-grouped money formatting, amount-in-words, and the
 * fictitious authorised-signatory pool. Centralising these here keeps
 * the formatting identical across every layout (so the SAME order
 * renders the same numbers regardless of layout) and avoids copy-paste
 * drift, while leaving each layout free to style the output.
 *
 * # Determinism
 * Every function here is pure (input → output, no clock, no RNG, no
 * locale dependency). `formatMoney` deliberately hand-rolls the Indian
 * lakh/crore digit grouping instead of `toLocaleString('en-IN')`
 * because `Intl` output can vary with the host ICU build — which would
 * break the "same seed ⇒ same bytes" contract across CI vs developer
 * machines.
 */

const MONTH_ABBREV = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Two-digit zero-pad helper. Inlined everywhere to avoid a date library
 * (forbidden by CLAUDE.md).
 *
 * @param {number} n
 * @returns {string}
 */
export function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Format a Date as `26-May-2026`. Locale-independent (hand-built) so
 * the output is identical across Linux CI and developer macOS — a
 * prerequisite for byte-deterministic PDFs.
 *
 * @param {Date} d
 * @returns {string}
 */
export function formatDate(d) {
  return `${pad2(d.getDate())}-${MONTH_ABBREV[d.getMonth()]}-${d.getFullYear()}`;
}

/**
 * Format a Date as `26-May-2026  14:30 IST`. The literal `IST` suffix
 * is appropriate — all synthetic parties are Indian; the host TZ is
 * ignored.
 *
 * @param {Date} d
 * @returns {string}
 */
export function formatDateTime(d) {
  return `${formatDate(d)}  ${pad2(d.getHours())}:${pad2(d.getMinutes())} IST`;
}

/**
 * Format a non-negative number with Indian digit grouping (lakh/crore
 * system: 12,34,567.89) to exactly 2 decimal places. Negative inputs
 * (possible for a negative round-off) keep their leading minus.
 *
 * Algorithm: split into integer + fraction, group the integer part as
 * `last-3` then `2-2-2…` from the right. Hand-rolled because
 * `Intl.NumberFormat('en-IN')` is ICU-version-dependent.
 *
 * @param {number} value - amount in rupees
 * @returns {string} e.g. `12,34,567.89`
 */
export function formatMoney(value) {
  const negative = value < 0;
  const abs = Math.abs(value);
  // toFixed(2) gives us a clean 2-dp string with no float noise.
  const fixed = abs.toFixed(2);
  const [intPart, fracPart] = fixed.split('.');

  // Indian grouping: the last 3 digits form one group, then groups of 2.
  let grouped;
  if (intPart.length <= 3) {
    grouped = intPart;
  } else {
    const last3 = intPart.slice(-3);
    const rest = intPart.slice(0, -3);
    // Insert a comma every 2 digits from the right of `rest`.
    const restGrouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    grouped = `${restGrouped},${last3}`;
  }
  return `${negative ? '-' : ''}${grouped}.${fracPart}`;
}

/**
 * Prefix a money string with a currency symbol. Kept tiny + separate so
 * layouts can choose to put the symbol inline or in a column header.
 *
 * @param {number} value
 * @param {string} symbol - e.g. '₹', '$', '€'
 * @returns {string}
 */
export function formatCurrency(value, symbol) {
  return `${symbol} ${formatMoney(value)}`;
}

// Indian number-system scale words used by amountInWords.
const ONES = [
  'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight',
  'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen',
  'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = [
  '', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy',
  'Eighty', 'Ninety',
];

/**
 * Convert a 0..99 integer to words. Internal helper for amountInWords.
 *
 * @param {number} n - 0..99
 * @returns {string}
 */
function twoDigitsToWords(n) {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o === 0 ? TENS[t] : `${TENS[t]} ${ONES[o]}`;
}

/**
 * Convert a 0..999 integer to words. Internal helper for amountInWords.
 *
 * @param {number} n - 0..999
 * @returns {string}
 */
function threeDigitsToWords(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts = [];
  if (h > 0) parts.push(`${ONES[h]} Hundred`);
  if (rest > 0) parts.push(twoDigitsToWords(rest));
  return parts.join(' ');
}

/**
 * Render a rupee amount as words in the Indian numbering system
 * (Crore / Lakh / Thousand / Hundred), with paise. Real Indian
 * invoices print an "Amount in words" line (e.g. "Rupees One Lakh
 * Twenty Three Thousand … Only") — DocRithm's extraction may key off
 * it, so we generate a faithful one. Pure function, deterministic.
 *
 * @param {number} value - amount in rupees (>= 0 expected)
 * @returns {string} e.g. "Rupees One Lakh Twenty Three Thousand Only"
 */
export function amountInWords(value) {
  const abs = Math.abs(value);
  const rupees = Math.floor(abs);
  const paise = Math.round((abs - rupees) * 100);

  if (rupees === 0 && paise === 0) return 'Rupees Zero Only';

  // Decompose rupees into crore / lakh / thousand / hundreds.
  const crore = Math.floor(rupees / 10000000);
  const lakh = Math.floor((rupees % 10000000) / 100000);
  const thousand = Math.floor((rupees % 100000) / 1000);
  const belowThousand = rupees % 1000;

  const parts = [];
  if (crore > 0) parts.push(`${threeDigitsToWords(crore)} Crore`);
  if (lakh > 0) parts.push(`${twoDigitsToWords(lakh)} Lakh`);
  if (thousand > 0) parts.push(`${twoDigitsToWords(thousand)} Thousand`);
  if (belowThousand > 0) parts.push(threeDigitsToWords(belowThousand));

  let words = `Rupees ${parts.join(' ')}`;
  if (paise > 0) {
    words += ` and ${twoDigitsToWords(paise)} Paise`;
  }
  return `${words} Only`;
}

/**
 * Fixed pool of fictitious authorised signatories used by every
 * layout's `signatureBlock`. Kept here (not in vendors.js) because the
 * signatory is the vendor's accounts/dispatch officer and is picked
 * deterministically per-document, independent of which vendor brand
 * issued it — same rationale as the verifier pool in lab-pdf-gen.
 *
 * @type {ReadonlyArray<{name:string, designation:string}>}
 */
export const SIGNATORIES = Object.freeze([
  { name: 'R. Sharma', designation: 'Authorised Signatory' },
  { name: 'P. Nair', designation: 'Accounts Manager' },
  { name: 'A. Deshmukh', designation: 'Procurement Officer' },
  { name: 'K. Rao', designation: 'Authorised Signatory' },
  { name: 'S. Iyer', designation: 'Dispatch In-charge' },
  { name: 'V. Menon', designation: 'Finance Controller' },
]);

/**
 * Pick an authorised signatory deterministically from a document's
 * docId so the same document always shows the same signer (re-run
 * stable) while different documents vary. Sum-of-char-codes hash —
 * not cryptographic, just stable.
 *
 * @param {string} docId
 * @returns {(typeof SIGNATORIES)[number]}
 */
export function signatoryFor(docId) {
  let hash = 0;
  for (const ch of String(docId)) {
    hash = (hash + ch.charCodeAt(0)) % 1_000_003;
  }
  return SIGNATORIES[hash % SIGNATORIES.length];
}

/**
 * Fictitious bank-account details printed on INVOICES (POs omit them).
 * Picked deterministically per-document like the signatory so re-runs
 * are stable. Realistic-looking but obviously synthetic.
 *
 * @type {ReadonlyArray<{bank:string, account:string, ifsc:string, branch:string}>}
 */
export const BANK_ACCOUNTS = Object.freeze([
  { bank: 'State Demo Bank', account: '0000 1234 5678 9012', ifsc: 'SDBK0000123', branch: 'Industrial Estate' },
  { bank: 'Synthetic National Bank', account: '5500 9876 5432 1000', ifsc: 'SYNB0005500', branch: 'MG Road' },
  { bank: 'Sandbox Commercial Bank', account: '7700 2233 4455 6677', ifsc: 'SNDB0007700', branch: 'City Centre' },
  { bank: 'Test Cooperative Bank', account: '3300 1100 2200 3300', ifsc: 'TCBK0003300', branch: 'Ring Road' },
]);

/**
 * Pick a bank account deterministically from a docId (invoice only).
 *
 * @param {string} docId
 * @returns {(typeof BANK_ACCOUNTS)[number]}
 */
export function bankFor(docId) {
  let hash = 0;
  for (const ch of String(docId)) {
    hash = (hash * 31 + ch.charCodeAt(0)) % 1_000_003;
  }
  return BANK_ACCOUNTS[hash % BANK_ACCOUNTS.length];
}

/**
 * Synthetic-data disclaimer printed on every document. Centralised so
 * the wording is identical across layouts.
 */
export const DISCLAIMER =
  'DISCLAIMER: This document is synthetic test data generated by '
  + 'docrithm-pdf-gen for the DocRithm document-processing test bench. '
  + 'It does not represent any real purchase, vendor, buyer, or '
  + 'transaction and must not be entered into any ledger or accounting '
  + 'system. All names, GSTINs, HSN codes, and amounts are fictitious.';
