import { lerp, TAU } from '../core/MathUtils';
import { noise2 } from '../core/Noise';

/**
 * The dance (brief §25).
 *
 * A pose is 28 joint angles. Each dance state is a *function of time* that
 * fills those angles, and blending between states is a straight interpolation
 * of the angles — which means limb lengths are preserved for free and any two
 * states can cross-fade into each other without an authored transition.
 *
 * The brief's requirement is that it must never read as one looping animation.
 * Two things do that work: every state is built from several sinusoids whose
 * periods are deliberately not integer ratios of each other, so the visible
 * cycle takes a long time to repeat; and a slow noise field perturbs the
 * angles continuously, so no two passes through the same state are identical.
 */

export const enum J {
  RootY, RootSway, RootYaw, RootPitch, RootRoll,
  SpinePitch, SpineYaw, SpineRoll,
  ChestPitch, ChestYaw, ChestRoll,
  HeadPitch, HeadYaw, HeadRoll,
  ShoulderLPitch, ShoulderLYaw, ShoulderLRoll, ElbowL,
  ShoulderRPitch, ShoulderRYaw, ShoulderRRoll, ElbowR,
  HipLPitch, HipLYaw, KneeL,
  HipRPitch, HipRYaw, KneeR,
  COUNT,
}

export type Pose = Float32Array;

export const newPose = (): Pose => new Float32Array(J.COUNT);

export type DanceState =
  | 'rest' | 'sway' | 'walk' | 'spin' | 'turn'
  | 'reach' | 'sing' | 'look' | 'play' | 'sit' | 'skyward';

/** Every state, in the order the director tends to move through them. */
export const DANCE_STATES: DanceState[] = [
  'rest', 'sway', 'walk', 'spin', 'turn', 'reach', 'sing', 'look', 'play', 'sit', 'skyward',
];

const D = Math.PI / 180;

/**
 * Fill `p` with the pose for `state` at time `t`.
 *
 * Angle conventions (fixed by Dancer.solveSkeleton):
 *   shoulder roll  + lifts the arm outward — 0 at the side, 90 horizontal,
 *                    150 overhead. The right arm's values are the negatives.
 *   shoulder pitch + swings the arm forward.
 *   elbow          + bends the forearm forward.
 *   hip pitch      + swings the leg forward; knee + bends the shin back.
 */
export function evaluatePose(p: Pose, state: DanceState, t: number, seed: number): void {
  p.fill(0);

  // A shared breath under everything: even standing still, she is alive.
  const breath = Math.sin(t * 0.9 + seed) * 0.5 + Math.sin(t * 0.61 + seed * 2.3) * 0.5;
  p[J.RootY] = breath * 0.006;
  p[J.SpinePitch] = breath * 1.2 * D;
  p[J.ChestPitch] = breath * 1.6 * D;

  // Arms never hang perfectly flat against the body.
  p[J.ShoulderLRoll] = 7 * D;
  p[J.ShoulderRRoll] = -7 * D;
  p[J.ElbowL] = 10 * D;
  p[J.ElbowR] = 10 * D;

  switch (state) {
    case 'rest': {
      const w = Math.sin(t * 0.34 + seed);
      p[J.RootSway] = w * 0.014;
      p[J.RootRoll] = w * 1.6 * D;
      p[J.ShoulderLRoll] = 9 * D + w * 2 * D;
      p[J.ShoulderRRoll] = -9 * D + w * 2 * D;
      p[J.ElbowL] = 14 * D + Math.sin(t * 0.5) * 3 * D;
      p[J.ElbowR] = 14 * D + Math.sin(t * 0.5 + 1) * 3 * D;
      p[J.HeadYaw] = Math.sin(t * 0.21 + seed) * 8 * D;
      p[J.HeadPitch] = Math.sin(t * 0.17) * 3 * D;
      p[J.KneeL] = 4 * D;
      p[J.KneeR] = 4 * D;
      break;
    }

    case 'sway': {
      // Weight shifting hip to hip, the torso answering a beat late. That lag
      // between hips and shoulders is what reads as dancing rather than rocking.
      const w = Math.sin(t * 1.15 + seed);
      const w2 = Math.sin(t * 1.15 + seed - 0.55);
      p[J.RootSway] = w * 0.05;
      p[J.RootRoll] = w * 5 * D;
      p[J.RootYaw] = w2 * 7 * D;
      p[J.SpineRoll] = -w2 * 5 * D;
      p[J.ChestRoll] = -w2 * 6 * D;
      p[J.ChestYaw] = w2 * 5 * D;
      p[J.HeadRoll] = w2 * 5 * D;
      p[J.HeadYaw] = -w2 * 6 * D;
      p[J.ShoulderLRoll] = (34 + w * 20) * D;
      p[J.ShoulderRRoll] = -(34 - w * 20) * D;
      p[J.ShoulderLPitch] = Math.sin(t * 1.15 + 0.8) * 16 * D;
      p[J.ShoulderRPitch] = Math.sin(t * 1.15 + 2.3) * 16 * D;
      p[J.ElbowL] = 40 * D + Math.sin(t * 1.15 + 1.2) * 16 * D;
      p[J.ElbowR] = 40 * D + Math.sin(t * 1.15 + 2.9) * 16 * D;
      p[J.KneeL] = 6 * D + Math.max(0, w) * 14 * D;
      p[J.KneeR] = 6 * D + Math.max(0, -w) * 14 * D;
      break;
    }

    case 'walk': {
      const c = t * 2.4 + seed;
      const step = Math.sin(c);
      p[J.RootY] = Math.abs(Math.sin(c)) * 0.022 - 0.011;
      p[J.RootSway] = Math.sin(c * 0.5) * 0.026;
      p[J.RootRoll] = Math.sin(c * 0.5) * 3 * D;
      p[J.RootYaw] = -Math.sin(c) * 5 * D;
      p[J.ChestYaw] = Math.sin(c) * 7 * D;
      p[J.HipLPitch] = step * 26 * D;
      p[J.HipRPitch] = -step * 26 * D;
      // Knees bend on the recovery half of the stride only.
      p[J.KneeL] = Math.max(0, -step) * 48 * D + 5 * D;
      p[J.KneeR] = Math.max(0, step) * 48 * D + 5 * D;
      // Contralateral: the arm swings opposite the leg on the same side.
      p[J.ShoulderLPitch] = -step * 22 * D;
      p[J.ShoulderRPitch] = step * 22 * D;
      p[J.ShoulderLRoll] = 11 * D;
      p[J.ShoulderRRoll] = -11 * D;
      p[J.ElbowL] = 24 * D + Math.max(0, step) * 18 * D;
      p[J.ElbowR] = 24 * D + Math.max(0, -step) * 18 * D;
      p[J.HeadYaw] = Math.sin(t * 0.4) * 6 * D;
      break;
    }

    case 'spin': {
      // The turn itself is applied to her facing; here the body leans into it
      // and the arms trail behind the rotation.
      p[J.RootRoll] = 7 * D;
      p[J.SpineRoll] = 5 * D;
      p[J.ChestYaw] = -12 * D;
      p[J.ShoulderLRoll] = (92 + Math.sin(t * 3.1) * 8) * D;
      p[J.ShoulderRRoll] = -(78 + Math.sin(t * 3.1 + 2) * 8) * D;
      p[J.ShoulderLPitch] = 14 * D;
      p[J.ShoulderRPitch] = -10 * D;
      p[J.ElbowL] = 18 * D;
      p[J.ElbowR] = 30 * D;
      p[J.HeadYaw] = -18 * D;
      p[J.HeadPitch] = -6 * D;
      p[J.KneeL] = 12 * D;
      p[J.KneeR] = 26 * D;
      p[J.HipRPitch] = -16 * D;
      break;
    }

    case 'turn': {
      const s = Math.sin(t * 0.8 + seed);
      p[J.RootYaw] = s * 16 * D;
      p[J.ChestYaw] = s * 10 * D;
      p[J.HeadYaw] = s * 16 * D;
      p[J.ShoulderLRoll] = (26 + s * 10) * D;
      p[J.ShoulderRRoll] = -(26 - s * 10) * D;
      p[J.ElbowL] = 32 * D;
      p[J.ElbowR] = 32 * D;
      p[J.KneeL] = 6 * D;
      p[J.KneeR] = 6 * D;
      break;
    }

    case 'reach': {
      // Reaching down and out toward a flower, the whole body committing to it.
      const r = Math.sin(t * 0.7 + seed) * 0.5 + 0.5;
      p[J.RootPitch] = 13 * D * r;
      p[J.SpinePitch] = 15 * D * r;
      p[J.ChestPitch] = 11 * D * r;
      p[J.ChestYaw] = -14 * D * r;
      p[J.HeadPitch] = 24 * D * r;
      p[J.HeadYaw] = -10 * D * r;
      // The reaching arm swings forward and straightens.
      p[J.ShoulderRPitch] = 46 * D * r;
      p[J.ShoulderRRoll] = -(16 + 14 * r) * D;
      p[J.ElbowR] = 26 * D * (1 - r * 0.8);
      p[J.ShoulderLRoll] = -(0) + (30 + 12 * r) * D;
      p[J.ShoulderLPitch] = -20 * D * r;
      p[J.ElbowL] = 34 * D;
      p[J.KneeL] = 20 * D * r;
      p[J.KneeR] = 11 * D * r;
      break;
    }

    case 'sing': {
      const s = Math.sin(t * 0.85 + seed);
      p[J.HeadPitch] = -16 * D + s * 5 * D;
      p[J.ChestPitch] = -8 * D;
      p[J.SpinePitch] = -5 * D;
      // Arms opening outward and a little forward, palms up.
      p[J.ShoulderLRoll] = (66 + s * 14) * D;
      p[J.ShoulderRRoll] = -(66 + s * 14) * D;
      p[J.ShoulderLPitch] = 16 * D;
      p[J.ShoulderRPitch] = 16 * D;
      p[J.ElbowL] = 34 * D;
      p[J.ElbowR] = 34 * D;
      p[J.RootRoll] = s * 3 * D;
      p[J.HeadYaw] = s * 5 * D;
      break;
    }

    case 'skyward': {
      // Looking up, arms lifting overhead. Roll past 90 is what takes an arm
      // above the shoulder at all.
      const s = Math.sin(t * 0.55 + seed);
      p[J.HeadPitch] = -34 * D;
      p[J.ChestPitch] = -14 * D;
      p[J.SpinePitch] = -8 * D;
      p[J.ShoulderLRoll] = (142 + s * 8) * D;
      p[J.ShoulderRRoll] = -(142 + s * 8) * D;
      p[J.ShoulderLPitch] = 6 * D;
      p[J.ShoulderRPitch] = 6 * D;
      p[J.ElbowL] = 16 * D;
      p[J.ElbowR] = 16 * D;
      p[J.RootRoll] = Math.sin(t * 0.5) * 2 * D;
      break;
    }

    case 'look': {
      const s = Math.sin(t * 0.42 + seed);
      const s2 = Math.sin(t * 0.27 + seed * 1.7);
      p[J.HeadYaw] = s * 34 * D;
      p[J.HeadPitch] = s2 * 10 * D;
      p[J.ChestYaw] = s * 12 * D;
      p[J.RootYaw] = s * 6 * D;
      p[J.ShoulderLRoll] = 13 * D;
      p[J.ShoulderRRoll] = -13 * D;
      p[J.ElbowL] = 22 * D;
      p[J.ElbowR] = 22 * D;
      break;
    }

    case 'play': {
      const b = Math.sin(t * 2.9 + seed);
      p[J.RootY] = Math.abs(b) * 0.05;
      p[J.RootYaw] = Math.sin(t * 1.4) * 14 * D;
      p[J.ShoulderLRoll] = (118 + b * 22) * D;
      p[J.ShoulderRRoll] = -(118 - b * 22) * D;
      p[J.ShoulderLPitch] = b * 22 * D;
      p[J.ShoulderRPitch] = -b * 22 * D;
      p[J.ElbowL] = 42 * D;
      p[J.ElbowR] = 42 * D;
      p[J.KneeL] = 16 * D + Math.max(0, b) * 32 * D;
      p[J.KneeR] = 16 * D + Math.max(0, -b) * 32 * D;
      p[J.HeadPitch] = -10 * D;
      break;
    }

    case 'sit': {
      p[J.RootY] = -0.40;
      p[J.RootPitch] = 9 * D;
      p[J.HipLPitch] = 76 * D;
      p[J.HipRPitch] = 64 * D;
      p[J.HipLYaw] = 12 * D;
      p[J.HipRYaw] = -18 * D;
      p[J.KneeL] = 88 * D;
      p[J.KneeR] = 98 * D;
      p[J.SpinePitch] = -6 * D;
      p[J.ChestPitch] = -4 * D;
      // One arm braced behind her, the other resting.
      p[J.ShoulderLPitch] = -42 * D;
      p[J.ShoulderLRoll] = 26 * D;
      p[J.ElbowL] = 12 * D;
      p[J.ShoulderRRoll] = -16 * D;
      p[J.ShoulderRPitch] = 26 * D;
      p[J.ElbowR] = 54 * D;
      p[J.HeadYaw] = Math.sin(t * 0.25 + seed) * 12 * D;
      p[J.HeadPitch] = Math.sin(t * 0.19) * 6 * D + 4 * D;
      break;
    }
  }
}

/** Blend two poses into `out`. */
export function blendPose(out: Pose, a: Pose, b: Pose, t: number): void {
  for (let i = 0; i < J.COUNT; i++) out[i] = lerp(a[i], b[i], t);
}

/**
 * Continuous, slow, per-joint drift. Small enough to be invisible frame to
 * frame and large enough that the same state never plays the same way twice.
 */
export function addVariation(p: Pose, t: number, seed: number, amount: number): void {
  for (let i = J.SpinePitch; i < J.COUNT; i++) {
    p[i] += noise2(t * 0.13 + i * 7.7, seed + i * 3.1) * amount;
  }
  p[J.RootYaw] += noise2(t * 0.09, seed + 41) * amount * 0.6;
}

/** How much a state is "moving" — feeds the garden's heart. */
export function stateEnergy(state: DanceState): number {
  switch (state) {
    case 'spin': return 1.0;
    case 'play': return 0.9;
    case 'walk': return 0.62;
    case 'sway': return 0.55;
    case 'sing': return 0.45;
    case 'turn': return 0.35;
    case 'reach': return 0.3;
    case 'look': return 0.18;
    case 'skyward': return 0.15;
    case 'rest': return 0.08;
    case 'sit': return 0.05;
    default: return 0.2;
  }
}

/** Plausible next states, so the sequence reads as a train of thought. */
export const DANCE_FLOW: Record<DanceState, DanceState[]> = {
  rest: ['sway', 'look', 'walk', 'sing'],
  sway: ['spin', 'walk', 'sing', 'turn', 'play'],
  walk: ['sway', 'turn', 'reach', 'look', 'walk'],
  spin: ['sway', 'play', 'sing', 'turn'],
  turn: ['walk', 'sway', 'look', 'reach'],
  reach: ['walk', 'sway', 'look', 'sit'],
  sing: ['sway', 'skyward', 'spin', 'rest'],
  look: ['walk', 'reach', 'sway', 'skyward'],
  play: ['spin', 'sway', 'walk', 'sing'],
  sit: ['rest', 'look', 'sing'],
  skyward: ['sing', 'rest', 'sway'],
};

export const FULL_TURN = TAU;
