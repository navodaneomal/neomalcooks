import * as THREE from 'three';
import { srgb } from '../core/Colors';

/**
 * The tulip palette (brief §04).
 *
 * Pink is the dominant identity, so the weights below are heavily skewed toward
 * the three pinks. Everything else exists to keep the field from reading as one
 * flat colour: ivory and champagne lift it, lavender cools it, crimson and gold
 * appear rarely enough to feel like punctuation. Nothing here is a primary
 * colour and nothing is fully saturated — that is what keeps a hundred thousand
 * flowers looking cinematic rather than like confetti.
 *
 * Each entry carries a deep base (the throat of the cup) and a lighter tip; the
 * gradient between them across the petal is most of what sells a real tulip.
 */

export interface TulipHue {
  readonly name: string;
  readonly base: number;
  readonly tip: number;
  readonly weight: number;
}

export const TULIP_HUES: readonly TulipHue[] = [
  { name: 'soft pink',    base: 0xd6607f, tip: 0xf7b3c6, weight: 0.185 },
  { name: 'blush',        base: 0xe0899f, tip: 0xfad2dc, weight: 0.170 },
  { name: 'pale pink',    base: 0xecb2c2, tip: 0xfdeaf0, weight: 0.150 },
  { name: 'ivory',        base: 0xe6dcc6, tip: 0xfbf6ea, weight: 0.090 },
  { name: 'white',        base: 0xdfe0e4, tip: 0xffffff, weight: 0.075 },
  { name: 'champagne',    base: 0xdcc39a, tip: 0xf6e6c8, weight: 0.065 },
  { name: 'lavender',     base: 0xb9a4d2, tip: 0xe4d8f2, weight: 0.070 },
  { name: 'muted purple', base: 0x8d74ab, tip: 0xc0aad6, weight: 0.055 },
  { name: 'deep crimson', base: 0x8e1f3c, tip: 0xd05070, weight: 0.090 },
  { name: 'subtle gold',  base: 0xc79a45, tip: 0xf0d68e, weight: 0.050 },
];

export const HUE_COUNT = TULIP_HUES.length;

/** Index lookups for the pockets of the world that force a palette. */
export const HUE_INDEX = {
  softPink: 0, blush: 1, palePink: 2, ivory: 3, white: 4,
  champagne: 5, lavender: 6, mutedPurple: 7, crimson: 8, gold: 9,
} as const;

export const GARDEN_PALETTES: Record<string, readonly number[]> = {
  // The white garden is deliberately *only* whites and ivories — its silence
  // is the point.
  white: [HUE_INDEX.white, HUE_INDEX.white, HUE_INDEX.ivory, HUE_INDEX.palePink],
  moonlit: [HUE_INDEX.palePink, HUE_INDEX.lavender, HUE_INDEX.white, HUE_INDEX.mutedPurple],
  golden: [HUE_INDEX.gold, HUE_INDEX.champagne, HUE_INDEX.ivory, HUE_INDEX.gold],
  ancient: [HUE_INDEX.crimson, HUE_INDEX.mutedPurple, HUE_INDEX.crimson, HUE_INDEX.lavender],
  jewel: [HUE_INDEX.softPink, HUE_INDEX.crimson, HUE_INDEX.blush, HUE_INDEX.softPink],
};

/** Cumulative weights for O(log n) weighted sampling. */
const CUMULATIVE: number[] = (() => {
  const out: number[] = [];
  let acc = 0;
  for (const h of TULIP_HUES) {
    acc += h.weight;
    out.push(acc);
  }
  // Guard against the weights not summing to exactly 1.
  const total = out[out.length - 1];
  return out.map((v) => v / total);
})();

export function sampleHueIndex(r: number): number {
  for (let i = 0; i < CUMULATIVE.length; i++) {
    if (r <= CUMULATIVE[i]) return i;
  }
  return CUMULATIVE.length - 1;
}

/** Flat Float32Arrays for the shader's palette uniform. */
export function paletteUniformArrays(): { base: THREE.Color[]; tip: THREE.Color[] } {
  return {
    base: TULIP_HUES.map((h) => srgb(h.base)),
    tip: TULIP_HUES.map((h) => srgb(h.tip)),
  };
}

/** Foliage greens — muted and slightly blue, never a cartoon green. */
export const LEAF_GREENS: readonly number[] = [
  0x5c7350, 0x67805a, 0x556b4e, 0x71865f, 0x4e6448,
];
