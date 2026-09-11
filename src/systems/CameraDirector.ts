import * as THREE from 'three';
import type { Engine } from '../core/Engine';
import type { Dancer } from './Dancer';
import type { Heart } from './Heart';
import { terrainHeight } from '../world/Terrain';
import { clamp, clamp01, damp, easeInOutCubic, easeOutCubic, lerp, makeRandom, type Rng } from '../core/MathUtils';

/**
 * The camera as a character (brief §27).
 *
 * Not an orbit control with a scene attached. The director holds a list of
 * *shots* — each one a composition with its own framing, length and movement —
 * and cuts or glides between them. Shots know how to find their own subject, so
 * "low among the tulips" or "tracking her" stay correct wherever she has walked
 * to.
 *
 * The viewer is never locked out. Their drag, pinch and scroll are applied as an
 * offset on top of whatever the director is composing, and that offset eases
 * back to zero when they stop — so you can always look around, and the film
 * always resumes.
 */

export type ShotName =
  | 'genesis' | 'firstTulip' | 'awaken' | 'lowAngle' | 'wide' | 'tracking'
  | 'follow' | 'closeUp' | 'orbit' | 'overhead' | 'ascend' | 'extremeWide'
  | 'pond' | 'tree' | 'freeLook' | 'toward';

interface Shot {
  name: ShotName;
  /** Seconds this shot runs before the director picks another. -1 = holds. */
  duration: number;
  /** Seconds to glide in from the previous shot. 0 = a cut. */
  blendIn: number;
  /** Depth-of-field strength this shot wants, 0..1. */
  dof: number;
  /** Letterbox amount this shot wants, 0..1. */
  letterbox: number;
  /** How much the viewer may push the camera around during it. */
  freedom: number;
}

const SHOTS: Record<ShotName, Shot> = {
  genesis:     { name: 'genesis',     duration: -1, blendIn: 0,   dof: 0.9, letterbox: 1,    freedom: 0 },
  firstTulip:  { name: 'firstTulip',  duration: -1, blendIn: 2.5, dof: 0.85, letterbox: 1,   freedom: 0.1 },
  awaken:      { name: 'awaken',      duration: -1, blendIn: 3.5, dof: 0.25, letterbox: 0.8, freedom: 0.2 },
  lowAngle:    { name: 'lowAngle',    duration: 16, blendIn: 3.0, dof: 0.55, letterbox: 0.25, freedom: 0.6 },
  wide:        { name: 'wide',        duration: 18, blendIn: 3.5, dof: 0.1,  letterbox: 0.2, freedom: 0.8 },
  tracking:    { name: 'tracking',    duration: 22, blendIn: 3.0, dof: 0.30, letterbox: 0.3, freedom: 0.7 },
  follow:      { name: 'follow',      duration: -1, blendIn: 2.5, dof: 0.25, letterbox: 0.4, freedom: 0.5 },
  closeUp:     { name: 'closeUp',     duration: 11, blendIn: 2.6, dof: 0.95, letterbox: 0.4, freedom: 0.4 },
  orbit:       { name: 'orbit',       duration: 20, blendIn: 3.2, dof: 0.2,  letterbox: 0.2, freedom: 0.8 },
  overhead:    { name: 'overhead',    duration: -1, blendIn: 3.0, dof: 0.1,  letterbox: 0.7, freedom: 0.2 },
  ascend:      { name: 'ascend',      duration: -1, blendIn: 2.0, dof: 0,    letterbox: 0.9, freedom: 0.1 },
  extremeWide: { name: 'extremeWide', duration: -1, blendIn: 3.0, dof: 0,    letterbox: 1,   freedom: 0.1 },
  pond:        { name: 'pond',        duration: 20, blendIn: 3.4, dof: 0.4,  letterbox: 0.3, freedom: 0.7 },
  tree:        { name: 'tree',        duration: 22, blendIn: 3.4, dof: 0.35, letterbox: 0.35, freedom: 0.6 },
  freeLook:    { name: 'freeLook',    duration: -1, blendIn: 2.0, dof: 0.15, letterbox: 0,   freedom: 1 },
  toward:      { name: 'toward',      duration: -1, blendIn: 2.4, dof: 0.5,  letterbox: 0.4, freedom: 0.3 },
};

/** Shots the director may choose from during free exploration. */
const AMBIENT_SHOTS: ShotName[] = ['lowAngle', 'wide', 'tracking', 'closeUp', 'orbit'];

export class CameraDirector {
  shot: Shot = SHOTS.genesis;
  private prevPos = new THREE.Vector3();
  private prevTarget = new THREE.Vector3();
  private blend = 1;
  private shotTime = 0;
  private shotSeed = 0;

  /** Where the director wants the camera, before viewer input. */
  private basePos = new THREE.Vector3(0, 1.4, 9);
  private baseTarget = new THREE.Vector3(0, 0.6, 0);
  /** The smoothed result, which is what the camera actually uses. */
  private curPos = new THREE.Vector3(0, 1.4, 9);
  private curTarget = new THREE.Vector3(0, 0.6, 0);

  /** Viewer offset: yaw, pitch and dolly around the composed shot. */
  userYaw = 0;
  userPitch = 0;
  userDolly = 0;
  /** Seconds since the viewer last touched anything. */
  idle = 0;

  /** A point of interest the narrative can aim shots at. */
  focusPoint: THREE.Vector3 | null = null;
  /**
   * Supplied by the assembly: finds a flower worth framing near a position.
   * The close-up shot is about a *tulip* — without this it would frame whoever
   * happens to be nearest at half a metre, which on a person is not a close-up,
   * it is an accident.
   */
  findFlower: ((x: number, z: number) => THREE.Vector3 | null) | null = null;
  private closeUpSubject = new THREE.Vector3();
  /** Set true while the narrative owns the camera entirely. */
  scripted = false;
  /** Ascent progress for the reveal, 0..1, driven by the director. */
  ascent = 0;

  private engine: Engine;
  private dancer: Dancer;
  private heart: Heart;
  private rng: Rng;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private reduced: boolean;
  private shake = 0;

  constructor(engine: Engine, dancer: Dancer, heart: Heart, reducedMotion: boolean, seed = 77) {
    this.engine = engine;
    this.dancer = dancer;
    this.heart = heart;
    this.rng = makeRandom(seed);
    this.reduced = reducedMotion;
    this.prevPos.copy(this.basePos);
    this.prevTarget.copy(this.baseTarget);
  }

  setReducedMotion(v: boolean): void {
    this.reduced = v;
  }

  /** Cut or glide to a named shot. */
  cut(name: ShotName, immediate = false): void {
    const next = SHOTS[name];
    if (this.shot.name === name && !immediate) return;

    // A close-up needs a subject. Find one now, near whatever the camera is
    // already looking at, and fall back to a different shot if there is none.
    if (name === 'closeUp' && !this.focusPoint) {
      const found = this.findFlower?.(this.curTarget.x, this.curTarget.z) ?? null;
      if (!found) {
        this.cut('lowAngle', immediate);
        return;
      }
      this.closeUpSubject.copy(found);
    }
    this.prevPos.copy(this.curPos);
    this.prevTarget.copy(this.curTarget);
    this.shot = next;
    this.blend = immediate || next.blendIn <= 0 ? 1 : 0;
    this.shotTime = 0;
    this.shotSeed = this.rng() * 100;
  }

  /** Nudge from the viewer. Deltas are in radians / world units. */
  look(dYaw: number, dPitch: number): void {
    const f = this.shot.freedom;
    if (f <= 0) return;
    this.userYaw += dYaw * f;
    this.userPitch = clamp(this.userPitch + dPitch * f, -0.85, 1.05);
    this.idle = 0;
  }

  dolly(delta: number): void {
    const f = this.shot.freedom;
    if (f <= 0) return;
    this.userDolly = clamp(this.userDolly + delta * f, -6, 22);
    this.idle = 0;
  }

  /** A shove on the camera — used by the mass bloom and by rare events. */
  impulse(amount: number): void {
    if (this.reduced) return;
    this.shake = Math.min(1, this.shake + amount);
  }

  /**
   * When true the director stops composing entirely and leaves the camera where
   * it is. Used by the art-direction bench to hold a fixed frame.
   */
  manual = false;

  update(dt: number, elapsed: number): void {
    if (this.manual) return;
    this.shotTime += dt;
    this.idle += dt;

    // --- Choose the next shot ------------------------------------------------
    if (!this.scripted && this.shot.duration > 0 && this.shotTime > this.shot.duration) {
      // Never repeat the shot you just used: variety is the point.
      let next = AMBIENT_SHOTS[Math.floor(this.rng() * AMBIENT_SHOTS.length)];
      let guard = 0;
      while (next === this.shot.name && guard++ < 6) {
        next = AMBIENT_SHOTS[Math.floor(this.rng() * AMBIENT_SHOTS.length)];
      }
      this.cut(next);
    }

    this.compose(elapsed);

    // --- Blend from the previous shot ---------------------------------------
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / Math.max(this.shot.blendIn, 0.001));
    }
    const t = easeInOutCubic(this.blend);
    this.tmp.copy(this.prevPos).lerp(this.basePos, t);
    this.tmp2.copy(this.prevTarget).lerp(this.baseTarget, t);

    // A little smoothing on top, so even a hard subject move stays gentle.
    this.curPos.lerp(this.tmp, 1 - Math.exp(-4.5 * dt));
    this.curTarget.lerp(this.tmp2, 1 - Math.exp(-5.5 * dt));

    // --- Viewer offset -------------------------------------------------------
    // Decays back to the composed shot once they stop, but slowly enough that
    // it never feels like the camera is fighting them.
    if (this.idle > 3.5) {
      const k = 1 - Math.exp(-0.45 * dt);
      this.userYaw = lerp(this.userYaw, 0, k);
      this.userPitch = lerp(this.userPitch, 0, k);
      this.userDolly = lerp(this.userDolly, 0, k);
    }

    const cam = this.engine.camera;
    this.tmp.copy(this.curPos).sub(this.curTarget);
    // Portrait frames are narrow. The compositions are written for a wide
    // frame, so on a tall screen the camera pulls back to keep the same
    // *horizontal* extent rather than cropping into the subject.
    const aspectPull = cam.aspect < 1 ? Math.min(1.9, 1 / Math.max(cam.aspect, 0.4)) : 1;
    const radius = Math.max(0.6, this.tmp.length() * aspectPull + this.userDolly);
    let yaw = Math.atan2(this.tmp.x, this.tmp.z) + this.userYaw;
    let pitch = Math.asin(clamp(this.tmp.y / Math.max(this.tmp.length(), 1e-4), -1, 1)) + this.userPitch;
    pitch = clamp(pitch, -0.5, 1.35);

    cam.position.set(
      this.curTarget.x + Math.sin(yaw) * Math.cos(pitch) * radius,
      this.curTarget.y + Math.sin(pitch) * radius,
      this.curTarget.z + Math.cos(yaw) * Math.cos(pitch) * radius,
    );

    // Never let the camera end up underground or inside the flowers.
    const floor = terrainHeight(cam.position.x, cam.position.z) + 0.22;
    if (cam.position.y < floor) cam.position.y = floor;

    // --- Musical breathing ---------------------------------------------------
    // The camera answers the music, but only just: a few centimetres.
    if (!this.reduced) {
      const beat = this.heart.energy * 0.06 + this.heart.wonder * 0.05;
      const b = Math.sin(elapsed * 1.7) * beat;
      cam.position.y += b * 0.5;
      this.curTarget.y += b * 0.1;

      this.shake = damp(this.shake, 0, 1.4, dt);
      if (this.shake > 0.001) {
        const s = this.shake * 0.09;
        cam.position.x += Math.sin(elapsed * 31.7) * s;
        cam.position.y += Math.sin(elapsed * 27.3 + 1.7) * s;
        cam.position.z += Math.sin(elapsed * 23.1 + 3.1) * s;
      }
    }

    cam.lookAt(this.curTarget);

    // --- Lens ----------------------------------------------------------------
    const post = this.engine.post;
    const dofWanted = this.engine.dofAvailable ? this.shot.dof : 0;
    post.uDofStrength.value = damp(post.uDofStrength.value as number, dofWanted, 1.6, dt);
    // Focus on whatever the shot is looking at.
    const focusDist = cam.position.distanceTo(this.curTarget);
    post.uFocusDistance.value = damp(post.uFocusDistance.value as number, focusDist, 2.2, dt);
    post.uFocusRange.value = damp(post.uFocusRange.value as number,
      lerp(30, 4.5, this.shot.dof), 1.5, dt);
    post.uLetterbox.value = damp(post.uLetterbox.value as number,
      this.letterboxWanted, 1.1, dt);
  }

  /** Overridden by the UI's zero-UI / cinematic mode. */
  letterboxOverride: number | null = null;

  private get letterboxWanted(): number {
    return this.letterboxOverride ?? this.shot.letterbox;
  }

  // -----------------------------------------------------------------------
  // Compositions
  // -----------------------------------------------------------------------

  private compose(elapsed: number): void {
    const her = this.tmp2;
    this.dancer.centre(her);
    const t = this.shotTime;
    const s = this.shotSeed;
    const P = this.basePos;
    const T = this.baseTarget;
    const visible = this.dancer.reveal > 0.35;

    switch (this.shot.name) {
      case 'genesis': {
        // Locked on the empty air where the flower is about to be, framed as
        // though it were already there.
        P.set(0.34, 0.86, 1.00);
        T.set(0, 0.70, 0);
        break;
      }

      case 'firstTulip': {
        // Slowly circling the first flower as it grows and opens, rising a
        // little to follow the bloom up the stem.
        const a = elapsed * 0.13;
        const k = clamp01(t / 20);
        const r = lerp(1.45, 0.92, k);
        P.set(Math.sin(a) * r, lerp(0.55, 0.98, k), Math.cos(a) * r);
        T.set(0, lerp(0.32, 0.80, k), 0);
        break;
      }

      case 'awaken': {
        // Pulling back and rising as the field is born.
        const k = easeOutCubic(clamp01(t / 26));
        const a = elapsed * 0.05;
        const r = lerp(1.2, 44, k);
        P.set(Math.sin(a) * r, lerp(0.32, 15, k), Math.cos(a) * r);
        T.set(0, lerp(0.2, 1.4, k), 0);
        break;
      }

      case 'lowAngle': {
        // Down among the stems, looking up through the flowers at the sky.
        const anchor = visible ? her : this.focusPoint ?? this.zero;
        const a = s * 0.6 + elapsed * 0.035;
        const r = 3.4 + Math.sin(t * 0.11) * 0.8;
        P.set(anchor.x + Math.sin(a) * r, terrainHeight(anchor.x, anchor.z) + 0.16, anchor.z + Math.cos(a) * r);
        T.set(anchor.x, terrainHeight(anchor.x, anchor.z) + (visible ? 1.15 : 0.55), anchor.z);
        break;
      }

      case 'wide': {
        const anchor = visible ? her : this.zero;
        const a = s + elapsed * 0.022;
        const r = 26 + Math.sin(t * 0.07) * 5;
        P.set(anchor.x + Math.sin(a) * r, terrainHeight(anchor.x, anchor.z) + 6.5, anchor.z + Math.cos(a) * r);
        T.set(anchor.x, terrainHeight(anchor.x, anchor.z) + 1.2, anchor.z);
        break;
      }

      case 'tracking': {
        // Riding alongside her, slightly behind, at shoulder height.
        const f = this.dancer.facing;
        const side = Math.sin(s * 3.1) > 0 ? 1 : -1;
        const back = 3.6;
        const off = 2.1 * side;
        P.set(
          her.x - Math.sin(f) * back + Math.cos(f) * off,
          terrainHeight(her.x, her.z) + 1.45 + Math.sin(t * 0.4) * 0.08,
          her.z - Math.cos(f) * back - Math.sin(f) * off,
        );
        T.copy(her);
        break;
      }

      case 'follow': {
        // Directly behind her: the shot that makes you want to go with her.
        const f = this.dancer.facing;
        P.set(
          her.x - Math.sin(f) * 4.6,
          terrainHeight(her.x, her.z) + 1.55,
          her.z - Math.cos(f) * 4.6,
        );
        T.copy(her).addScaledVector(this.tmp.set(Math.sin(f), 0, Math.cos(f)), 2.4);
        break;
      }

      case 'closeUp': {
        // A single flower, filling the frame, everything else gone soft.
        const p = this.focusPoint ?? this.closeUpSubject;
        const a = s * 2 + elapsed * 0.08;
        P.set(p.x + Math.sin(a) * 0.62, p.y + 0.14, p.z + Math.cos(a) * 0.62);
        T.copy(p);
        break;
      }

      case 'orbit': {
        const anchor = visible ? her : this.zero;
        const a = s + elapsed * 0.055;
        const r = 8.5 + Math.sin(t * 0.09) * 2.5;
        P.set(anchor.x + Math.sin(a) * r, terrainHeight(anchor.x, anchor.z) + 2.4 + Math.sin(t * 0.13) * 0.8, anchor.z + Math.cos(a) * r);
        T.set(anchor.x, terrainHeight(anchor.x, anchor.z) + 1.0, anchor.z);
        break;
      }

      case 'overhead': {
        const anchor = visible ? her : this.zero;
        P.set(anchor.x + Math.sin(elapsed * 0.05) * 3, terrainHeight(anchor.x, anchor.z) + 26, anchor.z + Math.cos(elapsed * 0.05) * 3);
        T.set(anchor.x, terrainHeight(anchor.x, anchor.z), anchor.z);
        break;
      }

      case 'ascend': {
        // The long rise. Height is exponential so the world opens out steadily
        // rather than all at once at the end.
        const k = clamp01(this.ascent);
        const h = lerp(4, 620, k * k);
        const a = elapsed * 0.026;
        const r = lerp(14, 430, easeInOutCubic(k));
        P.set(Math.sin(a) * r, h, Math.cos(a) * r);
        T.set(0, lerp(1.2, 0, k), 0);
        break;
      }

      case 'extremeWide': {
        P.set(Math.sin(elapsed * 0.014) * 780, 430, Math.cos(elapsed * 0.014) * 780);
        T.set(0, 0, 0);
        break;
      }

      case 'pond':
      case 'tree':
      case 'toward': {
        const p = this.focusPoint ?? this.zero;
        const a = s + elapsed * (this.shot.name === 'toward' ? 0.012 : 0.03);
        const r = this.shot.name === 'tree' ? 18 : 11;
        const h = this.shot.name === 'tree' ? 5.5 : 2.2;
        P.set(p.x + Math.sin(a) * r, terrainHeight(p.x, p.z) + h, p.z + Math.cos(a) * r);
        T.set(p.x, terrainHeight(p.x, p.z) + (this.shot.name === 'tree' ? 5 : 1.0), p.z);
        break;
      }

      case 'freeLook':
      default: {
        const anchor = visible ? her : this.focusPoint ?? this.zero;
        P.set(anchor.x, terrainHeight(anchor.x, anchor.z) + 1.55, anchor.z + 6.5);
        T.set(anchor.x, terrainHeight(anchor.x, anchor.z) + 1.1, anchor.z);
        break;
      }
    }
  }

  private zero = new THREE.Vector3(0, 0, 0);

  /** Where the camera is currently aiming — the interaction system needs it. */
  get target(): THREE.Vector3 {
    return this.curTarget;
  }

  /** Used by the "don't touch anything" beat: hand the frame back. */
  restFrame(): void {
    this.userYaw = 0;
    this.userPitch = 0;
    this.userDolly = 0;
  }
}
