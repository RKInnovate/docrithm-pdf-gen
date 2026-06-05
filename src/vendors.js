/**
 * Fictitious vendor (supplier) and buyer (purchaser) brandings used as
 * the letterhead / "from" / "bill-to" chrome on generated purchase
 * documents.
 *
 * # Why a pool (not one party)
 * DocRithm's extraction + Tally-matching pipeline keys off the printed
 * party identity (name, GSTIN, state). Varying the vendor and buyer
 * across documents exercises (a) the dedup/hash path with materially
 * different bytes, (b) the GSTIN/state-code parsing path, and (c) the
 * intra-state (CGST+SGST) vs inter-state (IGST) tax branch — which is
 * driven purely by whether the vendor's state code matches the buyer's.
 *
 * # Why these specific names
 * Every name carries an unmistakably synthetic suffix ("Demo",
 * "Synthetic", "Test", "Sandbox") so a reviewer skimming a generated
 * PDF can tell at a glance it is NOT a real procurement document and
 * must never enter a real ledger or Tally company.
 *
 * # GSTIN format (15 chars, load-bearing)
 * A real Indian GSTIN is: `SS PPPPPPPPPP E Z C` where
 *   SS         — 2-digit state code (must match `stateCode`)
 *   PPPPPPPPPP — 10-char PAN of the entity
 *   E          — 1-digit entity/registration number
 *   Z          — literal 'Z' (reserved, almost always Z)
 *   C          — 1 checksum char
 * We hand-craft valid-shaped GSTINs whose leading two digits agree
 * with the party's `stateCode`, because the intra/inter-state tax
 * decision and the printed state line both read off that field — a
 * mismatch would make the ground-truth `taxType` in the manifest wrong.
 *
 * # Field semantics
 *   slug          — filesystem-safe, used in generated filenames
 *   name          — top-of-page banner / party name
 *   addressLines  — multi-line postal address block
 *   gstin         — 15-char GSTIN (first 2 digits === stateCode)
 *   state         — human-readable state name
 *   stateCode     — 2-digit GST state code (drives intra/inter-state)
 *   phone, email  — printed in the party block / footer
 *   accentColor   — hex string driving header chrome + table head
 *   logoMonogram  — 2-3 letter abbreviation rendered as a square tile
 *                   (we ship no raster logos to keep the generator
 *                   self-contained)
 *   nameHi        — OPTIONAL Devanagari rendering of the name, used by
 *                   the bilingual-en-hi layout to stress Tally's
 *                   fuzzy-match on non-Latin party names
 */

/**
 * Vendor (supplier) pool. Each vendor's GSTIN begins with its own
 * 2-digit `stateCode` so the printed state line, the GSTIN, and the
 * intra/inter-state tax branch all agree.
 *
 * @type {ReadonlyArray<object>}
 */
export const VENDORS = Object.freeze([
  {
    slug: 'apex-supplies-demo',
    name: 'Apex Industrial Supplies (Demo) Pvt. Ltd.',
    addressLines: [
      'Plot 47, MIDC Industrial Area, Phase II',
      'Andheri East, Mumbai 400093',
    ],
    gstin: '27AAACA1234A1Z5',
    state: 'Maharashtra',
    stateCode: '27',
    phone: '+91 22 4000 1100',
    email: 'sales@apex-supplies-demo.example',
    accentColor: '#0F4C81',
    logoMonogram: 'AS',
  },
  {
    slug: 'sunrise-traders-synth',
    name: 'Sunrise Traders (Synthetic)',
    addressLines: [
      '14, Gandhi Market, Ring Road',
      'Surat 395002',
    ],
    gstin: '24BBDCS5678B1Z2',
    state: 'Gujarat',
    stateCode: '24',
    phone: '+91 261 200 2200',
    email: 'orders@sunrise-traders-synth.example',
    accentColor: '#C62828',
    logoMonogram: 'ST',
  },
  {
    // Devanagari-named vendor — exercises Tally fuzzy-match on a
    // non-Latin supplier name when rendered via the bilingual layout.
    slug: 'bharat-udyog-test',
    name: 'Bharat Udyog Test Enterprises',
    nameHi: 'भारत उद्योग टेस्ट एंटरप्राइज़ेज़',
    addressLines: [
      '88, Naraina Industrial Area, Phase I',
      'New Delhi 110028',
    ],
    gstin: '07CCEPB9012C1Z8',
    state: 'Delhi',
    stateCode: '07',
    phone: '+91 11 4500 3300',
    email: 'info@bharat-udyog-test.example',
    accentColor: '#2E7D32',
    logoMonogram: 'BU',
  },
  {
    slug: 'coastal-distributors-sandbox',
    name: 'Coastal Distributors (Sandbox) LLP',
    addressLines: [
      '3rd Floor, Marine Plaza, MG Road',
      'Kochi 682016',
    ],
    gstin: '32DDEFC3456D1Z1',
    state: 'Kerala',
    stateCode: '32',
    phone: '+91 484 220 4400',
    email: 'accounts@coastal-distributors-sandbox.example',
    accentColor: '#6A1B9A',
    logoMonogram: 'CD',
  },
  {
    slug: 'deccan-hardware-demo',
    name: 'Deccan Hardware & Tools (Demo)',
    addressLines: [
      'Survey 21, Jeedimetla Industrial Estate',
      'Hyderabad 500055',
    ],
    gstin: '36EEFGD7890E1Z9',
    state: 'Telangana',
    stateCode: '36',
    phone: '+91 40 2300 5500',
    email: 'sales@deccan-hardware-demo.example',
    accentColor: '#00695C',
    logoMonogram: 'DH',
  },
  {
    // Second Devanagari-named vendor for bilingual coverage variety.
    slug: 'ganga-overseas-synth',
    name: 'Ganga Overseas (Synthetic) Pvt. Ltd.',
    nameHi: 'गंगा ओवरसीज़ सिंथेटिक प्रा. लि.',
    addressLines: [
      '5, Civil Lines, Hazratganj',
      'Lucknow 226001',
    ],
    gstin: '09FFGHG2345F1Z3',
    state: 'Uttar Pradesh',
    stateCode: '09',
    phone: '+91 522 400 6600',
    email: 'contact@ganga-overseas-synth.example',
    accentColor: '#E65100',
    logoMonogram: 'GO',
  },
]);

/**
 * Buyer (purchaser / bill-to) pool. Same field shape as a vendor (the
 * party block renders both uniformly). The buyer's `stateCode` is what
 * the tax engine compares against the vendor's to decide CGST+SGST
 * (intra-state) vs IGST (inter-state).
 *
 * @type {ReadonlyArray<object>}
 */
export const BUYERS = Object.freeze([
  {
    slug: 'nova-manufacturing-demo',
    name: 'Nova Manufacturing (Demo) Pvt. Ltd.',
    addressLines: [
      'Unit 9, Electronics City, Phase I',
      'Bengaluru 560100',
    ],
    gstin: '29GGHIJ6789G1Z7',
    state: 'Karnataka',
    stateCode: '29',
    phone: '+91 80 6700 7700',
    email: 'purchase@nova-manufacturing-demo.example',
    accentColor: '#1565C0',
    logoMonogram: 'NM',
  },
  {
    slug: 'pinnacle-retail-synth',
    name: 'Pinnacle Retail (Synthetic) Ltd.',
    addressLines: [
      '2nd Floor, City Centre Mall, FC Road',
      'Pune 411004',
    ],
    gstin: '27HHIJK0123H1Z4',
    state: 'Maharashtra',
    stateCode: '27',
    phone: '+91 20 6600 8800',
    email: 'procurement@pinnacle-retail-synth.example',
    accentColor: '#AD1457',
    logoMonogram: 'PR',
  },
  {
    slug: 'orbit-infra-test',
    name: 'Orbit Infraprojects (Test) Pvt. Ltd.',
    addressLines: [
      'Tower B, Cyber Greens, DLF Phase III',
      'Gurugram 122002',
    ],
    gstin: '06IIJKL4567I1Z0',
    state: 'Haryana',
    stateCode: '06',
    phone: '+91 124 450 9900',
    email: 'buying@orbit-infra-test.example',
    accentColor: '#4527A0',
    logoMonogram: 'OI',
  },
  {
    slug: 'meridian-foods-sandbox',
    name: 'Meridian Foods (Sandbox) Pvt. Ltd.',
    addressLines: [
      'Plot 12, Food Park, GIDC Estate',
      'Ahmedabad 382213',
    ],
    gstin: '24JJKLM8901J1Z6',
    state: 'Gujarat',
    stateCode: '24',
    phone: '+91 79 4800 1010',
    email: 'orders@meridian-foods-sandbox.example',
    accentColor: '#37474F',
    logoMonogram: 'MF',
  },
  {
    slug: 'zenith-textiles-demo',
    name: 'Zenith Textiles (Demo) Pvt. Ltd.',
    addressLines: [
      '21, Anna Salai, T. Nagar',
      'Chennai 600017',
    ],
    gstin: '33KKLMN2345K1Z2',
    state: 'Tamil Nadu',
    stateCode: '33',
    phone: '+91 44 2820 1212',
    email: 'purchase@zenith-textiles-demo.example',
    accentColor: '#5D4037',
    logoMonogram: 'ZT',
  },
]);

/**
 * Pick a vendor branding for a document. Picked once at planning time
 * and stored on the order shell so the same document always renders the
 * same supplier across re-runs.
 *
 * @param {ReturnType<import('./seedrand.js').createRng>} rng
 * @returns {(typeof VENDORS)[number]}
 */
export function pickVendor(rng) {
  return rng.pick(VENDORS);
}

/**
 * Pick a buyer branding for a document. Picked once at planning time.
 * The caller is responsible for any vendor!==buyer or state-code
 * arrangement needed to force a particular tax scenario.
 *
 * @param {ReturnType<import('./seedrand.js').createRng>} rng
 * @returns {(typeof BUYERS)[number]}
 */
export function pickBuyer(rng) {
  return rng.pick(BUYERS);
}

/**
 * Pick a buyer whose `stateCode` matches the supplied vendor — used to
 * deterministically force an INTRA-state (CGST+SGST) scenario. Falls
 * back to a plain pick when no same-state buyer exists in the pool, so
 * the caller never deadlocks on an impossible constraint.
 *
 * @param {ReturnType<import('./seedrand.js').createRng>} rng
 * @param {object} vendor
 * @returns {(typeof BUYERS)[number]}
 */
export function pickBuyerSameState(rng, vendor) {
  const sameState = BUYERS.filter((b) => b.stateCode === vendor.stateCode);
  if (sameState.length > 0) return rng.pick(sameState);
  // No pool buyer shares the vendor's state — synthesise one so the
  // intra-state (CGST+SGST) branch is GUARANTEED, not best-effort. We
  // clone an arbitrary buyer and rewrite its state, stateCode, and the
  // GSTIN's leading 2 digits so the printed identity is internally
  // consistent with the forced state. Same-RNG pick keeps it
  // reproducible.
  const base = rng.pick(BUYERS);
  return {
    ...base,
    state: vendor.state,
    stateCode: vendor.stateCode,
    // GSTIN's first two chars are the state code; rewrite them to match.
    gstin: `${vendor.stateCode}${base.gstin.slice(2)}`,
  };
}

/**
 * Pick a buyer whose `stateCode` differs from the supplied vendor —
 * used to deterministically force an INTER-state (IGST) scenario. Falls
 * back to a plain pick when every buyer happens to share the vendor's
 * state.
 *
 * @param {ReturnType<import('./seedrand.js').createRng>} rng
 * @param {object} vendor
 * @returns {(typeof BUYERS)[number]}
 */
export function pickBuyerOtherState(rng, vendor) {
  const otherState = BUYERS.filter((b) => b.stateCode !== vendor.stateCode);
  return otherState.length > 0 ? rng.pick(otherState) : rng.pick(BUYERS);
}
