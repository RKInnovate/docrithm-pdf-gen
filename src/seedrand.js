/**
 * Deterministic pseudo-random number generator (mulberry32).
 *
 * Why a hand-rolled RNG instead of `Math.random`:
 *   The generator must be reproducible — re-running with the same
 *   `--seed` value has to produce the same vendor/buyer set, the same
 *   layout choices, the same line items and amounts, and therefore the
 *   same filenames + byte content. `Math.random` is not seedable in
 *   Node, and pulling in a 4 KB dependency for a 9-line algorithm
 *   adds supply-chain surface for no gain.
 *
 * Why mulberry32:
 *   Period of 2^32, passes BigCrush on a 64-bit composition, fast,
 *   tiny, and fits in a closure. We're not generating crypto —
 *   we're generating invoice line items — so cryptographic strength
 *   is not a requirement.
 *
 * Distribution helpers (rng.float, rng.int, rng.pick, rng.weighted,
 * rng.bool) are attached to the returned function so callers don't
 * have to re-derive them at every call site. This module is a verbatim
 * port of the sibling lab-pdf-gen generator's RNG so the determinism
 * guarantees are identical across both test benches.
 */

/**
 * Build a seeded RNG.
 *
 * @param {number} seed - 32-bit unsigned integer seed. Same seed →
 *   same stream. Default `Date.now()` only fires when the caller
 *   explicitly passes nothing; the CLI always provides one.
 * @returns {{
 *   next: () => number,
 *   float: (min: number, max: number) => number,
 *   int: (min: number, max: number) => number,
 *   pick: <T>(arr: T[]) => T,
 *   weighted: <T>(items: T[], weightFn: (item: T) => number) => T,
 *   bool: (probTrue: number) => boolean,
 * }}
 */
export function createRng(seed = Date.now()) {
  // mulberry32 internal state. Re-seed safely by coercing to u32.
  let state = (seed | 0) >>> 0;

  // `next` returns a float in [0, 1). Same shape as Math.random.
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,

    /**
     * Uniform float in [min, max].
     * Used for unit-price sampling — never with min > max.
     */
    float(min, max) {
      return min + next() * (max - min);
    },

    /**
     * Uniform integer in [min, max] (both inclusive).
     */
    int(min, max) {
      return Math.floor(min + next() * (max - min + 1));
    },

    /**
     * Pick a uniformly random element from a non-empty array.
     */
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },

    /**
     * Weighted pick. `weightFn` must return a non-negative number
     * for each item; items with weight 0 will not be selected.
     */
    weighted(items, weightFn) {
      const total = items.reduce((acc, it) => acc + weightFn(it), 0);
      let r = next() * total;
      for (const it of items) {
        r -= weightFn(it);
        if (r <= 0) return it;
      }
      // Fallback for floating-point drift on the last item.
      return items[items.length - 1];
    },

    /**
     * Bernoulli trial — true with probability `probTrue`.
     */
    bool(probTrue) {
      return next() < probTrue;
    },
  };
}
