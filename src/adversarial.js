/**
 * Adversarial distortion library — turns a REAL Tally master name into a
 * hard-to-match string as it might plausibly appear on a supplier's
 * document, so we can STRESS-TEST the DocRithm fuzzy resolution harness.
 *
 * # Why this module exists
 * The resolver's whole USP (see docs/RESOLUTION_HARNESS.md in the Wails
 * repo) is mapping a printed *string* onto the exact *Tally master* the
 * accountant would have picked, even when the names diverge. To learn where
 * that harness breaks, the test bench has to feed it the same messiness the
 * pilot saw — packaging noise, branch-suffix churn, OCR confusables,
 * transliteration — AND a deliberately brutal tail (merges, splits,
 * truncations) that *should* defeat it. This file is the catalogue of those
 * mutations, each labelled with what it tests and how hard it should be.
 *
 * # What it produces
 * Every distortion is a pure function `(name, rng, ctx?) => string` paired
 * with metadata describing WHAT matching mechanism it targets, HOW HARD it
 * should be (`difficulty` 1..5), and the resolver outcome we EXPECT
 * (`resolved` | `ambiguous` | `unmatched`). Callers receive:
 *   { text, distortion, tags: string[], difficulty, expectedOutcome }
 * so a downstream bench can assert the resolver's actual State against the
 * expected one and surface regressions.
 *
 * # How the difficulty/outcome targeting is grounded
 * The expected outcomes are derived directly from the documented harness
 * algorithms, NOT guessed:
 *   - Ledgers match on `token_set_ratio` (indel; insertions/deletions
 *     rewarded, NO substitutions) with threshold 75. So adding/dropping a
 *     legal suffix keeps a large shared token subset → still `resolved`.
 *     Substitution-heavy mutations (OCR confusables) hurt indel more →
 *     drift toward `ambiguous`/`unmatched`.
 *   - Stock matches on a hybrid 40% token + 60% cosine blend (threshold
 *     60) over name+parent+aliases+HSN. Packaging/qty noise barely dents
 *     either signal → the headline collapse-to-one-master `resolved` case.
 *   - The ambiguity delta (5 pts) + the workflow-profile branch-suffix
 *     bias (≥30% of ledgers carry a location suffix → a bare query is
 *     downgraded to `ambiguous`) is why branch/numbered-office distortions
 *     are tagged `ambiguous` even when one variant scores 100.
 *   - Token reorder is *free* for `token_set_ratio` (it's a SET), so a pure
 *     reorder stays `resolved`; it only becomes hard once combined with
 *     truncation/initialism that destroys the shared token set.
 *
 * # Determinism
 * All randomness flows through a `createRng` instance (mulberry32, see
 * seedrand.js). Same seed + same master in → same distortion out, every
 * run. No `Math.random`, no `Date.now()`, no wall-clock. This mirrors the
 * determinism contract of the rest of the generator so a failing bench
 * sample is replayable from its seed alone.
 *
 * # Purity
 * No PDF/template/layout imports. This is a string library; the only
 * dependency is the RNG. That keeps it usable from the generator, from a
 * standalone bench, or from a `node -e` one-liner.
 */

/**
 * @typedef {object} DistortionResult
 * @property {string} text             - the distorted string to print/feed.
 * @property {string} distortion       - the distortion's stable id.
 * @property {string[]} tags           - what matching mechanism(s) it targets.
 * @property {number} difficulty       - 1 (easy) .. 5 (brutal).
 * @property {'resolved'|'ambiguous'|'unmatched'} expectedOutcome
 *   - the resolver State the bench should assert against.
 */

/**
 * @typedef {object} StockMaster
 * @property {string} name             - the stock card's display name.
 * @property {string} [parent_group]   - Tally parent group (matched too).
 * @property {string[]} [aliases]      - alias strings (matched too).
 * @property {string} [hsn_code]       - HSN (joined into the token side).
 * @property {string} [base_unit]      - base unit (e.g. "kg", "Nos").
 */

/**
 * @typedef {object} Distortion
 * @property {string} id               - stable identifier (also `distortion`).
 * @property {'ledger'|'stock'|'both'} target - which master kind it applies to.
 * @property {string} description      - what real-world mess it reproduces.
 * @property {string[]} tags           - matching mechanism(s) targeted.
 * @property {number} difficulty       - 1..5 baseline difficulty.
 * @property {'resolved'|'ambiguous'|'unmatched'} expectedOutcome
 * @property {(name: string, rng: object, ctx?: object) => string} apply
 *   - pure transform producing the distorted text.
 */

// ---------------------------------------------------------------------------
// Small pure helpers (no RNG side effects beyond what's passed in).
// ---------------------------------------------------------------------------

/**
 * Collapse runs of whitespace to single spaces and trim the ends. Used to
 * keep generated strings tidy before optionally re-roughening them.
 *
 * @param {string} s
 * @returns {string}
 */
function tidy(s) {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Split a name into word tokens on whitespace, dropping empties. Mirrors
 * the *spirit* of the harness Tokenize (which also splits on punctuation)
 * but here we only need word-level granularity for reorder/initialism work.
 *
 * @param {string} s
 * @returns {string[]}
 */
function words(s) {
  return tidy(s).split(' ').filter(Boolean);
}

/**
 * Title-case a single word (first letter up, rest down). ASCII-oriented;
 * non-Latin scripts pass through largely unchanged.
 *
 * @param {string} w
 * @returns {string}
 */
function titleWord(w) {
  if (w.length === 0) return w;
  return w[0].toUpperCase() + w.slice(1).toLowerCase();
}

/**
 * Escape a string for safe interpolation into a RegExp. Inlined to avoid a
 * dependency (CLAUDE.md forbids gratuitous packages).
 *
 * @param {string} s
 * @returns {string}
 */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Common legal-suffix vocabulary used by add/drop/swap distortions.
 */
const LEGAL_SUFFIXES = [
  'Pvt Ltd',
  'Limited',
  'Ltd',
  '& Co',
  'Enterprises',
  'Traders',
  'Industries',
  'Corporation',
  '(Demo)',
];

// Suffixes recognised for STRIPPING (superset of LEGAL_SUFFIXES — includes
// dotted/LLP variants the masters carry on the page).
const STRIPPABLE_SUFFIXES = [...LEGAL_SUFFIXES, 'Pvt. Ltd.', 'Pvt Ltd.', 'Ltd.', 'LLP'];

// Abbreviation <-> expansion pairs. Applied in either direction so the
// distorted string says one form while the master holds the other.
const ABBREV_PAIRS = [
  ['Ltd.', 'Limited'],
  ['Pvt.', 'Private'],
  ['Mfg.', 'Manufacturing'],
  ['Mfg', 'Manufacturing'],
  ['Co.', 'Company'],
  ['Inds.', 'Industries'],
  ['Corp.', 'Corporation'],
  ['Bros.', 'Brothers'],
  ['Ent.', 'Enterprises'],
];

// Packaging / quantity noise fragments appended to a stock name. These are
// exactly the kinds of strings the pilot saw riding alongside one collapsed
// master card (the `Fortune wheat 50kg × 50` family).
const PACK_NOISE = [
  '50kg',
  '25 kg',
  'x 50',
  'X 100',
  'Box of 12',
  'Pack of 6',
  'MRP 140',
  'MRP 250',
  '1 Ltr',
  '500 ml',
  'Carton (24 pcs)',
  '12 x 1kg',
  'Bag 50 Kg',
];

// City / branch suffixes for the canonical hard ledger case (J.P.Impex).
const BRANCH_CITIES = [
  'Mumbai',
  'Delhi',
  'Pune',
  'Chennai',
  'Kolkata',
  'Bengaluru',
  'Surat',
  'Ahmedabad',
];

// OCR-confusable single-character substitution table. Each maps a glyph to a
// visually similar one a noisy scan / OCR pass commonly emits. These
// introduce *substitutions*, which is exactly what indel does NOT reward.
const OCR_CONFUSABLES = [
  ['O', '0'],
  ['o', '0'],
  ['l', '1'],
  ['I', '1'],
  ['S', '5'],
  ['s', '5'],
  ['B', '8'],
  ['g', '9'],
  ['Z', '2'],
];

// A tiny, hand-curated Latin -> Devanagari transliteration map for the
// common roots in Indian B2B party/product names. Intentionally lossy — the
// point is to render a non-Latin variant the Latin token matcher cannot
// align at all, not to be a real transliterator.
const DEVANAGARI_WORDS = {
  bharat: 'भारत',
  udyog: 'उद्योग',
  enterprises: 'एंटरप्राइज़ेज़',
  traders: 'ट्रेडर्स',
  industries: 'इंडस्ट्रीज़',
  ganga: 'गंगा',
  overseas: 'ओवरसीज़',
  brothers: 'ब्रदर्स',
  steel: 'स्टील',
  chemicals: 'केमिकल्स',
  sugar: 'शक्कर',
  wheat: 'गेहूं',
  oil: 'तेल',
  fortune: 'फॉर्च्यून',
  apex: 'एपेक्स',
  sunrise: 'सनराइज़',
};

/**
 * Drop a recognised trailing legal/branch suffix from a name, else return
 * it unchanged. Shared by `legal-suffix-drop` and `legal-suffix-swap`.
 *
 * @param {string} name
 * @returns {string}
 */
function dropLegalSuffix(name) {
  let out = name;
  for (const suf of STRIPPABLE_SUFFIXES) {
    const re = new RegExp(`\\s*${escapeRe(suf)}\\s*$`, 'i');
    if (re.test(out)) {
      out = out.replace(re, '');
      break;
    }
  }
  return tidy(out);
}

/**
 * Apply up to `count` OCR confusable substitutions at RNG-chosen positions.
 * Bounded so the string stays recognisable to a human reviewer.
 *
 * @param {string} s
 * @param {object} rng - createRng instance.
 * @param {number} count - max substitutions to attempt.
 * @returns {string}
 */
function applyOcrConfusables(s, rng, count) {
  const chars = s.split('');
  // Indices whose char has at least one confusable mapping.
  const candidates = [];
  for (let i = 0; i < chars.length; i += 1) {
    if (OCR_CONFUSABLES.some(([from]) => from === chars[i])) candidates.push(i);
  }
  // Flip up to `count` distinct candidate positions, RNG-ordered.
  const want = Math.min(count, candidates.length);
  for (let n = 0; n < want; n += 1) {
    const pickIdx = rng.int(0, candidates.length - 1);
    const charIdx = candidates.splice(pickIdx, 1)[0];
    const map = OCR_CONFUSABLES.find(([from]) => from === chars[charIdx]);
    if (map) chars[charIdx] = map[1];
  }
  return chars.join('');
}

/**
 * Best-effort word-by-word transliteration into Devanagari using the small
 * curated map. Unknown words are lowercased and passed through, so the
 * result is a realistic mixed/garbled non-Latin rendering, not a clean one.
 *
 * @param {string} s
 * @returns {string}
 */
function toDevanagari(s) {
  return words(s)
    .map((w) => DEVANAGARI_WORDS[w.toLowerCase()] ?? w.toLowerCase())
    .join(' ');
}

// ---------------------------------------------------------------------------
// The distortion catalogue.
//
// Ordering note: the registry order is STABLE. `pickDistortion` /
// `chooseDistortion` select by RNG over a filtered view, so adding/removing
// entries shifts the stream — append new distortions at the end to preserve
// behaviour under old seeds where it matters.
// ---------------------------------------------------------------------------

/**
 * The full distortion registry. Each entry is self-describing (target,
 * tags, baseline difficulty, expected resolver outcome) plus a pure `apply`
 * transform. Frozen so callers can't mutate the catalogue.
 *
 * @type {ReadonlyArray<Distortion>}
 */
export const DISTORTIONS = Object.freeze([
  // ----- LEGAL-SUFFIX CHURN (ledger) -----------------------------------
  {
    id: 'legal-suffix-add',
    target: 'ledger',
    description: 'Append a legal/business suffix the master omits (Pvt Ltd, & Co, Enterprises).',
    tags: ['ledger', 'token_set_ratio', 'legal-suffix'],
    difficulty: 1,
    // Indel rewards the shared subset; the extra suffix token is cheap → resolved.
    expectedOutcome: 'resolved',
    apply(name, rng) {
      return tidy(`${name} ${rng.pick(LEGAL_SUFFIXES)}`);
    },
  },
  {
    id: 'legal-suffix-drop',
    target: 'ledger',
    description: 'Strip a trailing legal suffix the master carries (Pvt Ltd / Limited / & Co / (Demo)).',
    tags: ['ledger', 'token_set_ratio', 'legal-suffix'],
    difficulty: 1,
    expectedOutcome: 'resolved',
    apply(name) {
      return dropLegalSuffix(name);
    },
  },
  {
    id: 'legal-suffix-swap',
    target: 'ledger',
    description: 'Replace one legal suffix with a different one (Pvt Ltd → Enterprises).',
    tags: ['ledger', 'token_set_ratio', 'legal-suffix'],
    difficulty: 2,
    // Drops one shared token AND adds a foreign one — borderline, but the
    // base name usually still clears 75; flagged ambiguous to be honest.
    expectedOutcome: 'ambiguous',
    apply(name, rng) {
      return tidy(`${dropLegalSuffix(name)} ${rng.pick(LEGAL_SUFFIXES)}`);
    },
  },

  // ----- ABBREVIATION / EXPANSION (both) -------------------------------
  {
    id: 'abbrev-expand',
    target: 'both',
    description: 'Expand or contract an abbreviation (LTD.↔Limited, MFG↔Manufacturing, Bros.↔Brothers).',
    tags: ['ledger', 'stock', 'token_set_ratio', 'abbreviation'],
    difficulty: 2,
    // Indel rewards the long shared substring (limit/limited) → usually resolved.
    expectedOutcome: 'resolved',
    apply(name, rng) {
      let out = name;
      // Try forward (abbrev→full) then reverse (full→abbrev); first hit wins.
      const order = rng.bool(0.5) ? ABBREV_PAIRS : ABBREV_PAIRS.map(([a, b]) => [b, a]);
      for (const [from, to] of order) {
        const re = new RegExp(escapeRe(from), 'i');
        if (re.test(out)) {
          out = out.replace(re, to);
          break;
        }
      }
      // If nothing matched, inject a plausible abbreviation/expansion pair so
      // the distortion is never a silent no-op.
      if (out === name) {
        const [from, to] = rng.pick(ABBREV_PAIRS);
        out = `${name} ${rng.bool(0.5) ? from : to}`;
      }
      return tidy(out);
    },
  },

  // ----- CASING / PUNCTUATION / WHITESPACE NOISE (both) ----------------
  {
    id: 'case-punct-noise',
    target: 'both',
    description: 'Casing churn + punctuation/whitespace noise (ALLCAPS, stray dots/hyphens, double spaces).',
    tags: ['ledger', 'stock', 'normalize', 'casing', 'punctuation'],
    difficulty: 1,
    // Normalize() lowercases + collapses whitespace before matching, so this
    // is essentially neutralised → resolved.
    expectedOutcome: 'resolved',
    apply(name, rng) {
      let out = name;
      // Random casing transform.
      const mode = rng.int(0, 2);
      if (mode === 0) out = out.toUpperCase();
      else if (mode === 1) out = out.toLowerCase();
      else out = words(out).map(titleWord).join(' ');
      // Inject double spaces / a stray dot or hyphen between two words.
      const ws = out.split(' ');
      if (ws.length > 1) {
        const at = rng.int(0, ws.length - 2);
        const glue = rng.pick(['  ', ' . ', ' - ', '.', '-']);
        out = `${ws.slice(0, at + 1).join(' ')}${glue}${ws.slice(at + 1).join(' ')}`;
      }
      return out; // intentionally NOT tidied — the noise is the point.
    },
  },

  // ----- TOKEN REORDER / PARTIAL / INITIALS (ledger) -------------------
  {
    id: 'token-reorder',
    target: 'ledger',
    description: 'Reorder name tokens ("A J Brothers" → "Brothers A J").',
    tags: ['ledger', 'token_set_ratio', 'reorder'],
    difficulty: 1,
    // token_set_ratio is order-insensitive (it compares SETS) → resolved.
    expectedOutcome: 'resolved',
    apply(name, rng) {
      const ws = words(name);
      // Fisher-Yates shuffle on a copy, RNG-driven for reproducibility.
      for (let i = ws.length - 1; i > 0; i -= 1) {
        const j = rng.int(0, i);
        const t = ws[i];
        ws[i] = ws[j];
        ws[j] = t;
      }
      return ws.join(' ');
    },
  },
  {
    id: 'partial-name',
    target: 'ledger',
    description: 'Keep only a leading fragment of the name (drop the tail tokens).',
    tags: ['ledger', 'token_set_ratio', 'truncation', 'partial'],
    difficulty: 3,
    // Shrinking the token set shrinks the shared subset; often still clears
    // 75 on a 2-word name but lands near other candidates → ambiguous.
    expectedOutcome: 'ambiguous',
    apply(name) {
      const ws = words(name);
      if (ws.length <= 1) return name;
      const keep = Math.max(1, Math.ceil(ws.length / 2));
      return ws.slice(0, keep).join(' ');
    },
  },
  {
    id: 'initialism',
    target: 'ledger',
    description: 'Collapse leading words to initials ("A J Brothers" → "AJ Bros").',
    tags: ['ledger', 'token_set_ratio', 'initialism'],
    difficulty: 4,
    // Initials destroy the shared token subset (single chars vs full words) →
    // indel score collapses far below 75 → unmatched.
    expectedOutcome: 'unmatched',
    apply(name) {
      const ws = words(name);
      if (ws.length < 2) return name;
      // First (n-1) words → initials, last word abbreviated to 4 chars.
      const initials = ws
        .slice(0, -1)
        .map((w) => w[0].toUpperCase())
        .join('');
      const last = ws[ws.length - 1];
      const lastAbbr = last.length > 4 ? last.slice(0, 4) : last;
      return `${initials} ${titleWord(lastAbbr)}`;
    },
  },

  // ----- BRANCH / LOCATION / NUMBERED OFFICE (ledger) ------------------
  {
    id: 'branch-suffix-add',
    target: 'ledger',
    description: 'Add a city/branch suffix to a bare name ("X" → "X - Mumbai").',
    tags: ['ledger', 'token_set_ratio', 'branch-suffix', 'workflow-bias'],
    difficulty: 3,
    // The query now carries a suffix; if the master set has multiple branch
    // ledgers the top-2 fall within the ambiguity delta → ambiguous.
    expectedOutcome: 'ambiguous',
    apply(name, rng) {
      return `${name} - ${rng.pick(BRANCH_CITIES)}`;
    },
  },
  {
    id: 'branch-suffix-strip',
    target: 'ledger',
    description: 'Strip an existing branch suffix, leaving the bare base ("X - Delhi (2)" → "X").',
    tags: ['ledger', 'token_set_ratio', 'branch-suffix', 'workflow-bias'],
    difficulty: 4,
    // The canonical J.P.Impex case: bare query + many suffix-bearing
    // candidates + ≥30% suffix prevalence → profile bias forces ambiguous.
    expectedOutcome: 'ambiguous',
    apply(name) {
      // Remove a trailing " - <City>" plus any " (n)" / " - n" office number.
      return tidy(
        name
          .replace(/\s*[-–]\s*[A-Za-z][A-Za-z ]*\s*(\(\d+\))?\s*$/, '')
          .replace(/\s*\(\d+\)\s*$/, '')
          .replace(/\s*[-–]\s*\d+\s*$/, ''),
      );
    },
  },
  {
    id: 'numbered-office',
    target: 'ledger',
    description: 'Append a numbered-office suffix ("ABC Corp" → "ABC Corp - 2" / "… Mumbai 1").',
    tags: ['ledger', 'token_set_ratio', 'numbered-office', 'workflow-bias'],
    difficulty: 4,
    // Numbered offices under one city share a base name; the digit alone
    // can't disambiguate within the delta → ambiguous.
    expectedOutcome: 'ambiguous',
    apply(name, rng) {
      const n = rng.int(1, 3);
      const style = rng.int(0, 2);
      if (style === 0) return `${name} - ${n}`;
      if (style === 1) return `${name} - ${rng.pick(BRANCH_CITIES)} ${n}`;
      return `${name} (${n})`;
    },
  },

  // ----- OCR-CONFUSABLE SUBSTITUTIONS (both) ---------------------------
  {
    id: 'ocr-confusables',
    target: 'both',
    description: 'Glyph substitutions a noisy scan emits (O↔0, l↔1↔I, S↔5, B↔8, rn↔m).',
    tags: ['ledger', 'stock', 'token_set_ratio', 'ocr', 'substitution'],
    difficulty: 3,
    // Substitutions are exactly what indel does NOT reward; a few flips push
    // the score toward / below threshold → ambiguous.
    expectedOutcome: 'ambiguous',
    apply(name, rng) {
      // First the multi-char rn↔m swap (a classic OCR error), then the
      // single-char confusables.
      let out = rng.bool(0.5) ? name.replace(/m/g, 'rn') : name.replace(/rn/g, 'm');
      out = applyOcrConfusables(out, rng, rng.int(2, 4));
      return out;
    },
  },

  // ----- PACKAGING / QUANTITY NOISE (stock) ----------------------------
  {
    id: 'pack-qty-noise',
    target: 'stock',
    description: 'Append packaging/quantity noise to a stock name (50kg, x 50, Box of 12, MRP 140).',
    tags: ['stock', 'hybrid', 'cosine', 'packaging', 'collapse-to-one'],
    difficulty: 1,
    // The headline case: shared "fortune wheat" token subset + same product
    // family cosine → the blend clears 60 easily → resolved onto ONE card.
    expectedOutcome: 'resolved',
    apply(name, rng) {
      // 1..2 noise fragments, optionally with a separator the pilot used.
      const n = rng.int(1, 2);
      let out = name;
      for (let i = 0; i < n; i += 1) {
        const sep = rng.pick([' ', ' - ', ' × ', ' x ']);
        out = `${out}${sep}${rng.pick(PACK_NOISE)}`;
      }
      return tidy(out);
    },
  },
  {
    id: 'alias-only-name',
    target: 'stock',
    description: 'Use the product name that lives only in the alias/parent, not the card name (Liquid Chlorine → Solvent).',
    tags: ['stock', 'hybrid', 'cosine', 'alias', 'parent'],
    difficulty: 2,
    // The card name doesn't contain the product; matching relies on the
    // alias/parent being folded into the token side + cosine family → resolved.
    expectedOutcome: 'resolved',
    apply(name, rng, ctx) {
      // Prefer an alias; else compose product-ish text near the parent.
      const aliases = ctx && Array.isArray(ctx.aliases) ? ctx.aliases : [];
      if (aliases.length > 0) {
        const alias = rng.pick(aliases);
        // Optionally ride packaging noise alongside the alias.
        return rng.bool(0.5) ? `${alias} ${rng.pick(PACK_NOISE)}` : alias;
      }
      const parent = ctx && ctx.parent_group ? ctx.parent_group : name;
      return `${parent} ${rng.pick(PACK_NOISE)}`;
    },
  },
  {
    id: 'extra-descriptive-words',
    target: 'both',
    description: 'Bury the name in extra descriptive words (grade, colour, brand qualifiers).',
    tags: ['stock', 'ledger', 'hybrid', 'token_set_ratio', 'descriptive-noise'],
    difficulty: 3,
    // Dilutes the shared token subset and drifts the embedding; usually still
    // matches but near neighbours → ambiguous.
    expectedOutcome: 'ambiguous',
    apply(name, rng) {
      const pre = rng.pick(['Premium', 'Industrial Grade', 'Food Grade', 'Super', 'Genuine', 'Imported']);
      const post = rng.pick(['White', 'Heavy Duty', 'Assorted', 'Refined', 'Grade A', 'OEM']);
      return tidy(`${pre} ${name} ${post}`);
    },
  },

  // ----- DEVANAGARI / TRANSLITERATION (both) ---------------------------
  {
    id: 'devanagari',
    target: 'both',
    description: 'Render the name in Devanagari / a transliteration the Latin token matcher cannot align.',
    tags: ['ledger', 'stock', 'token_set_ratio', 'cosine', 'transliteration', 'non-latin'],
    difficulty: 5,
    // Zero shared Latin tokens; a multilingual embedding *might* rescue some
    // stock cases, but for ledgers (token-only) this is unmatched.
    expectedOutcome: 'unmatched',
    apply(name) {
      return toDevanagari(name);
    },
  },

  // ----- BRUTAL TAIL: MERGE / SPLIT / TRUNCATION (both) ----------------
  {
    id: 'merge-two-masters',
    target: 'both',
    description: 'Concatenate this master with a second one (two products/parties on one line).',
    tags: ['stock', 'ledger', 'token_set_ratio', 'cosine', 'merge', 'brutal'],
    difficulty: 5,
    // The combined string straddles two cards; neither subset dominates and
    // the cosine is pulled between families → unmatched (or a wrong-ish tie).
    expectedOutcome: 'unmatched',
    apply(name, rng, ctx) {
      const other =
        ctx && ctx.otherName ? ctx.otherName : rng.pick(['Solvent', 'Steel Rod', 'Sugar M-30', 'Acme Traders']);
      const join = rng.pick([' + ', ' & ', ' / ', ', ']);
      return tidy(`${name}${join}${other}`);
    },
  },
  {
    id: 'split-one-master',
    target: 'both',
    description: 'Emit only a non-leading fragment of a multi-word master (split the name, keep the tail).',
    tags: ['stock', 'ledger', 'token_set_ratio', 'split', 'truncation', 'brutal'],
    difficulty: 4,
    // Keeping only the tail token(s) often shares too little with the master
    // and collides with unrelated cards → unmatched.
    expectedOutcome: 'unmatched',
    apply(name) {
      const ws = words(name);
      if (ws.length <= 1) return name;
      // Keep the trailing half only (the "split" — the leading half went elsewhere).
      const start = Math.floor(ws.length / 2);
      return ws.slice(start).join(' ');
    },
  },
  {
    id: 'hard-truncation',
    target: 'both',
    description: 'Truncate the name mid-word to a few characters (column clip / OCR cut-off).',
    tags: ['stock', 'ledger', 'token_set_ratio', 'truncation', 'brutal'],
    difficulty: 5,
    // A mid-word clip leaves a stub that shares almost nothing under indel →
    // unmatched.
    expectedOutcome: 'unmatched',
    apply(name, rng) {
      const compact = tidy(name);
      const cut = rng.int(3, Math.max(4, Math.min(8, compact.length)));
      return compact.slice(0, cut);
    },
  },
]);

// ---------------------------------------------------------------------------
// Level → difficulty-band bias.
//
// `level` (1=easy .. 5=brutal) shifts which difficulties are FAVOURED, but
// never hard-excludes a band — a level-1 run can still occasionally surface
// a hard distortion (real documents are messy), it's just rare. The bias is
// a triangular weight peaked at the level.
// ---------------------------------------------------------------------------

/**
 * Weight a distortion's difficulty relative to a requested `level`. Peaks at
 * `difficulty === level` and decays linearly with distance, with a floor of
 * 1 so no band is ever fully impossible.
 *
 * @param {number} difficulty - the distortion's difficulty (1..5).
 * @param {number} level - requested level (1..5).
 * @returns {number} a positive weight.
 */
function levelWeight(difficulty, level) {
  const distance = Math.abs(difficulty - level);
  // Peak 5 at distance 0, minus 1 per step, floored at 1 (never zero).
  return Math.max(1, 5 - distance);
}

/**
 * Choose one distortion from a target-filtered view of the registry,
 * weighted toward `level`. Internal core shared by the two public `distort*`
 * helpers.
 *
 * @param {object} rng - createRng instance.
 * @param {object} opts
 * @param {'ledger'|'stock'} opts.target - which masters this applies to.
 * @param {number} [opts.level] - 1..5 difficulty bias (default 3, clamped).
 * @returns {Distortion}
 */
function chooseDistortion(rng, { target, level = 3 }) {
  // Clamp level into the valid 1..5 band so callers can't skew the weights.
  const lvl = Math.max(1, Math.min(5, Math.round(level)));
  // A distortion applies if its target is the requested kind or 'both'.
  const eligible = DISTORTIONS.filter((d) => d.target === target || d.target === 'both');
  return rng.weighted(eligible, (d) => levelWeight(d.difficulty, lvl));
}

/**
 * Run a chosen distortion and shape its result into the caller contract.
 * Centralised so both public helpers return an identical shape and so the
 * `expectedOutcome`/`difficulty` always come from the catalogue, not the
 * call site (single source of truth).
 *
 * @param {Distortion} dist
 * @param {string} name - the master name to distort.
 * @param {object} rng - createRng instance.
 * @param {object} [ctx] - extra context (aliases, parent, otherName, …).
 * @returns {DistortionResult}
 */
function shapeResult(dist, name, rng, ctx) {
  const text = dist.apply(name, rng, ctx);
  return {
    text,
    distortion: dist.id,
    tags: dist.tags.slice(),
    difficulty: dist.difficulty,
    expectedOutcome: dist.expectedOutcome,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Distort a REAL ledger (party) master name into a hard-to-match string,
 * tagged with what it tests and how hard it should be.
 *
 * The chosen distortion is biased toward the requested `level` but every
 * field (`text`, `difficulty`, `expectedOutcome`, `tags`) is sourced from
 * the catalogue so the bench can assert the resolver's real State against
 * the expected one.
 *
 * @example
 *   const rng = createRng(7);
 *   distortLedger('J.P.Impex - Mumbai', rng, { level: 4 });
 *   // → { text: 'J.P.Impex', distortion: 'branch-suffix-strip',
 *   //     tags: [...], difficulty: 4, expectedOutcome: 'ambiguous' }
 *
 * @param {string} masterName - the true Tally ledger name.
 * @param {object} rng - createRng instance (deterministic).
 * @param {object} [options]
 * @param {number} [options.level] - 1 (easy) .. 5 (brutal); default 3.
 * @returns {DistortionResult}
 */
export function distortLedger(masterName, rng, { level } = {}) {
  if (typeof masterName !== 'string') {
    throw new TypeError('distortLedger: masterName must be a string');
  }
  const dist = chooseDistortion(rng, { target: 'ledger', level });
  return shapeResult(dist, masterName, rng, {});
}

/**
 * Distort a REAL stock master into a hard-to-match line-item string. Unlike
 * ledgers, stock matching is hybrid (token + embedding) over
 * name+parent+aliases+HSN, so the distortion is fed the whole master object
 * as context — `alias-only-name` and `merge-two-masters` use it.
 *
 * @example
 *   const rng = createRng(7);
 *   distortStock(
 *     { name: 'Fortune wheat', parent_group: 'Flour', aliases: ['Fortune Atta'], hsn_code: '1101', base_unit: 'kg' },
 *     rng, { level: 1 },
 *   );
 *   // → { text: 'Fortune wheat 50kg × 50', distortion: 'pack-qty-noise',
 *   //     tags: [...], difficulty: 1, expectedOutcome: 'resolved' }
 *
 * @param {StockMaster} masterObj - the true Tally stock master.
 * @param {object} rng - createRng instance (deterministic).
 * @param {object} [options]
 * @param {number} [options.level] - 1 (easy) .. 5 (brutal); default 3.
 * @returns {DistortionResult}
 */
export function distortStock(masterObj, rng, { level } = {}) {
  if (!masterObj || typeof masterObj.name !== 'string') {
    throw new TypeError('distortStock: masterObj must be an object with a string `name`');
  }
  const dist = chooseDistortion(rng, { target: 'stock', level });
  // Thread the master's alias/parent/hsn so context-aware distortions work.
  const ctx = {
    aliases: masterObj.aliases,
    parent_group: masterObj.parent_group,
    hsn_code: masterObj.hsn_code,
    base_unit: masterObj.base_unit,
  };
  return shapeResult(dist, masterObj.name, rng, ctx);
}

/**
 * Pick a distortion descriptor (NOT yet applied to a name) constrained to a
 * difficulty band. Lets a caller request "give me something hard" and then
 * apply it to whatever master they like. Returns the raw catalogue entry.
 *
 * @example
 *   const d = pickDistortion(createRng(1), { minDifficulty: 4, maxDifficulty: 5 });
 *   const out = d.apply('A J Brothers', createRng(1));
 *
 * @param {object} rng - createRng instance.
 * @param {object} [band]
 * @param {number} [band.minDifficulty] - inclusive lower bound (default 1).
 * @param {number} [band.maxDifficulty] - inclusive upper bound (default 5).
 * @param {'ledger'|'stock'|'both'} [band.target] - optional target filter.
 * @returns {Distortion}
 */
export function pickDistortion(rng, { minDifficulty = 1, maxDifficulty = 5, target } = {}) {
  const lo = Math.min(minDifficulty, maxDifficulty);
  const hi = Math.max(minDifficulty, maxDifficulty);
  const pool = DISTORTIONS.filter((d) => {
    const inBand = d.difficulty >= lo && d.difficulty <= hi;
    const matchesTarget = !target || d.target === target || d.target === 'both';
    return inBand && matchesTarget;
  });
  if (pool.length === 0) {
    throw new RangeError(
      `pickDistortion: no distortion in difficulty band [${lo}, ${hi}]` +
        (target ? ` for target '${target}'` : ''),
    );
  }
  return rng.pick(pool);
}
