/**
 * Small, dependency-free math helpers shared across every engine.
 * Kept deliberately allocation-free: these run thousands of times per frame.
 */

export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const clamp01 = (v: number): number => clamp(v, 0, 1);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const inverseLerp = (a: number, b: number, v: number): number =>
  a === b ? 0 : (v - a) / (b - a);

export const remap = (v: number, a: number, b: number, c: number, d: number): number =>
  lerp(c, d, clamp01(inverseLerp(a, b, v)));

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01(inverseLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
};

export const smootherstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01(inverseLerp(edge0, edge1, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/**
 * Framerate-independent exponential approach.
 * `lambda` is roughly "how many e-foldings per second" — higher is snappier.
 */
export const damp = (a: number, b: number, lambda: number, dt: number): number =>
  lerp(a, b, 1 - Math.exp(-lambda * dt));

export const dampAngle = (a: number, b: number, lambda: number, dt: number): number => {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * (1 - Math.exp(-lambda * dt));
};

export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t: number): number => t * t * t;
export const easeOutQuint = (t: number): number => 1 - Math.pow(1 - t, 5);
export const easeInOutSine = (t: number): number => -(Math.cos(Math.PI * t) - 1) / 2;

/** Rises 0 -> 1 -> 0 over t in [0,1]. Useful for one-shot pulses. */
export const pulse = (t: number): number => Math.sin(clamp01(t) * Math.PI);

/** Deterministic PRNG (mulberry32). Same seed always yields the same world. */
export function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

export const randRange = (rng: Rng, lo: number, hi: number): number => lo + rng() * (hi - lo);
export const randInt = (rng: Rng, lo: number, hi: number): number =>
  Math.floor(lo + rng() * (hi - lo + 1));
export const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length) % arr.length];
/** Returns true with probability p. */
export const chance = (rng: Rng, p: number): boolean => rng() < p;

/** 2D hash in [0,1) — matches the `hash21` used in the shaders closely enough for placement. */
export function hash21(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}
