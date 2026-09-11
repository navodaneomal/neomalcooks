import * as THREE from 'three';
import type { WorldUniforms } from '../core/WorldUniforms';
import type { Sky } from '../world/Sky';
import { clamp01, damp, lerp, smoothstep, TAU } from '../core/MathUtils';
import { mixSrgb, setSrgb } from '../core/Colors';

/**
 * Real time of day (brief §15).
 *
 * The world takes its hour from the visitor's own clock, so opening it at
 * 7am and at 11pm are genuinely different experiences. Everything downstream —
 * sun and moon direction, the sky gradient, fog, key light colour, how far the
 * tulips close, how bright the stars are — is derived from one continuous
 * `dayT` in [0,1) rather than from discrete "modes", so dusk actually arrives
 * gradually instead of switching.
 */

interface SkyStop {
  /** Sun elevation (the y of the normalised sun direction) this stop describes. */
  elev: number;
  zenith: number;
  horizon: number;
  nadir: number;
  sun: number;
  sunIntensity: number;
  fog: number;
  fogDensity: number;
  ambientSky: number;
  ambientGround: number;
  /**
   * Grading exposure for this hour. Night is lifted the way a cinematographer
   * opens up the aperture rather than by faking brighter moonlight — the
   * physical relationships in the shading stay intact, the image just gets
   * printed lighter.
   */
  exposure: number;
}

/**
 * Keyed on sun elevation rather than clock time, so the transitions stay
 * correct however the narrative pushes time around.
 */
const STOPS: readonly SkyStop[] = [
  { // deep night
    elev: -0.60, zenith: 0x05070f, horizon: 0x0d1424, nadir: 0x080a10,
    sun: 0x5a6fa8, sunIntensity: 0.10, fog: 0x0c1220, fogDensity: 0.0044,
    ambientSky: 0x39497a, ambientGround: 0x11141f, exposure: 1.72,
  },
  { // night
    elev: -0.22, zenith: 0x0a1024, horizon: 0x1b2440, nadir: 0x0c1020,
    sun: 0x7f92c8, sunIntensity: 0.18, fog: 0x161f36, fogDensity: 0.0042,
    ambientSky: 0x415288, ambientGround: 0x151826, exposure: 1.54,
  },
  { // civil twilight
    elev: -0.06, zenith: 0x27406e, horizon: 0x8c6f80, nadir: 0x3b3448,
    sun: 0xd98a72, sunIntensity: 0.42, fog: 0x6d6076, fogDensity: 0.0050,
    ambientSky: 0x4a5478, ambientGround: 0x211c24, exposure: 1.24,
  },
  { // golden hour
    elev: 0.09, zenith: 0x3f6ea3, horizon: 0xf0a877, nadir: 0x6b5648,
    sun: 0xffb571, sunIntensity: 1.15, fog: 0xd9a487, fogDensity: 0.0046,
    ambientSky: 0x7d90b4, ambientGround: 0x3a2f26, exposure: 1.06,
  },
  { // warm morning / late afternoon
    elev: 0.34, zenith: 0x3778bd, horizon: 0xcfd8dc, nadir: 0x7b7468,
    sun: 0xffe0b0, sunIntensity: 1.55, fog: 0xbcc6cc, fogDensity: 0.0036,
    ambientSky: 0x93aecb, ambientGround: 0x453a2c, exposure: 1.0,
  },
  { // midday
    elev: 0.85, zenith: 0x2f6fc4, horizon: 0xdfe7ec, nadir: 0x8b8878,
    sun: 0xfff4e0, sunIntensity: 1.85, fog: 0xd2dbe2, fogDensity: 0.0030,
    ambientSky: 0xa8c2dc, ambientGround: 0x4f4436, exposure: 0.94,
  },
];

/** Blend two palette hexes into a linear working colour. */
const lerpHex = (a: number, b: number, t: number, out: THREE.Color): THREE.Color =>
  mixSrgb(a, b, t, out);

export class DayCycle {
  /** Position in the day, 0 = midnight, 0.5 = noon. */
  dayT = 0.5;
  /** Minutes of world time that pass per real second. 0 = frozen to real time. */
  timeScale = 0;
  /** 0 day .. 1 night, smooth. */
  night = 0;
  /** True between roughly 1am and 4am — the dreamlike hours. */
  lateNight = 0;
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  readonly moonDir = new THREE.Vector3(0, -1, 0);

  private uniforms: WorldUniforms;
  private sky: Sky;
  private tmpA = new THREE.Color();
  private tmpB = new THREE.Color();
  private tmpC = new THREE.Color();

  /** Narrative override: when >= 0, the world is eased toward this time. */
  forcedT = -1;
  private forceBlend = 0;

  /** Jump straight to an hour, with no easing. Used by the bench. */
  setHourImmediate(hour: number): void {
    this.manualHour = hour;
    this.dayT = (hour / 24) % 1;
    this.forcedT = -1;
    this.apply(1);
  }

  /**
   * Manual hour from the settings panel. The brief makes the hour central to
   * the experience, so letting someone visit the moonlit garden without staying
   * up until midnight is a real feature, not a debug hook. null = follow the
   * visitor's own clock.
   */
  manualHour: number | null = null;

  constructor(uniforms: WorldUniforms, sky: Sky) {
    this.uniforms = uniforms;
    this.sky = sky;
    this.dayT = DayCycle.localDayT();
    this.apply(1);
  }

  static localDayT(): number {
    const now = new Date();
    return (
      (now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600) / 24
    );
  }

  /**
   * Push time toward a target (the golden sunrise event). Ignored while the
   * visitor is holding the clock themselves.
   */
  forceTime(t: number): void {
    if (this.manualHour !== null) return;
    this.forcedT = t;
  }

  releaseTime(): void {
    this.forcedT = -1;
  }

  update(dt: number): void {
    if (this.manualHour !== null) {
      const target = (this.manualHour / 24) % 1;
      let d = target - this.dayT;
      if (d > 0.5) d -= 1;
      if (d < -0.5) d += 1;
      // Ease rather than jump, so scrubbing the hour looks like time passing.
      this.dayT = (this.dayT + d * (1 - Math.exp(-2.2 * dt)) + 1) % 1;
    } else if (this.timeScale > 0) {
      this.dayT = (this.dayT + (dt * this.timeScale) / 1440) % 1;
    } else if (this.forcedT < 0) {
      // Track the wall clock so a long visit really does drift into evening.
      this.dayT = DayCycle.localDayT();
    }

    // A narrative override (the golden sunrise event) must not fight an hour
    // the visitor has set by hand: both branches used to run, and the two
    // would drag the clock back and forth every frame.
    if (this.forcedT >= 0 && this.manualHour === null) {
      this.forceBlend = damp(this.forceBlend, 1, 0.55, dt);
      // Shortest path around the clock, so 23:30 -> 05:00 goes forward.
      let d = this.forcedT - this.dayT;
      if (d > 0.5) d -= 1;
      if (d < -0.5) d += 1;
      this.dayT = (this.dayT + d * (1 - Math.exp(-1.1 * dt)) + 1) % 1;
    } else {
      this.forceBlend = damp(this.forceBlend, 0, 0.5, dt);
    }

    this.apply(dt);
  }

  private apply(dt: number): void {
    // Sun on a tilted circle: due east at sunrise, overhead at noon.
    const a = (this.dayT - 0.25) * TAU;
    this.sunDir.set(Math.cos(a), Math.sin(a), -0.34 * Math.cos(a)).normalize();
    // The moon rides roughly opposite, offset so the two are rarely aligned.
    const m = a + Math.PI * 0.94;
    this.moonDir.set(Math.cos(m) * 0.92, Math.sin(m), -0.34 * Math.cos(m) + 0.22).normalize();

    const elev = this.sunDir.y;
    this.night = 1 - smoothstep(-0.14, 0.12, elev);

    // 1am-4am, peaking at half past two.
    const h = this.dayT * 24;
    this.lateNight = clamp01(1 - Math.abs(h - 2.5) / 1.6) * this.night;

    // --- Interpolate the sky stops ------------------------------------------
    let i = 0;
    while (i < STOPS.length - 2 && elev > STOPS[i + 1].elev) i++;
    const s0 = STOPS[i];
    const s1 = STOPS[i + 1];
    const t = clamp01((elev - s0.elev) / (s1.elev - s0.elev));

    const sky = this.sky.uniforms;
    (sky.uZenith.value as THREE.Color).copy(lerpHex(s0.zenith, s1.zenith, t, this.tmpA));
    (sky.uHorizon.value as THREE.Color).copy(lerpHex(s0.horizon, s1.horizon, t, this.tmpA));
    (sky.uNadir.value as THREE.Color).copy(lerpHex(s0.nadir, s1.nadir, t, this.tmpA));
    (sky.uSunTint.value as THREE.Color).copy(lerpHex(s0.sun, s1.sun, t, this.tmpA));
    (sky.uMoonDir.value as THREE.Vector3).copy(this.moonDir);

    const sunI = lerp(s0.sunIntensity, s1.sunIntensity, t);

    // --- Shared world lighting -----------------------------------------------
    const L = this.uniforms.lighting;
    const A = this.uniforms.atmosphere;

    // At night the key light *is* the moon, so the whole world's key direction
    // swings over to it rather than the sun sinking below the ground.
    const keyDir = L.uSunDir.value as THREE.Vector3;
    const moonUp = clamp01(this.moonDir.y * 4);
    const useMoon = this.night * moonUp;
    keyDir.copy(this.sunDir).lerp(this.moonDir, useMoon).normalize();

    lerpHex(s0.sun, s1.sun, t, this.tmpB);
    // Moonlight is cool and dim.
    setSrgb(this.tmpC, 0x6b85db);
    (L.uSunColor.value as THREE.Color).copy(this.tmpB).lerp(this.tmpC, useMoon * 0.85);
    L.uSunIntensity.value = lerp(sunI, 0.46 * moonUp + 0.06, useMoon);

    (L.uSkyColor.value as THREE.Color).copy(lerpHex(s0.ambientSky, s1.ambientSky, t, this.tmpA));
    (L.uGroundColor.value as THREE.Color).copy(lerpHex(s0.ambientGround, s1.ambientGround, t, this.tmpA));

    (A.uFogColor.value as THREE.Color).copy(lerpHex(s0.fog, s1.fog, t, this.tmpA));
    // Weather adds to this each frame; this is the clear-sky baseline.
    this.baseFogDensity = lerp(s0.fogDensity, s1.fogDensity, t);
    this.exposure = lerp(s0.exposure, s1.exposure, t);

    sky.uSunIntensity.value = sunI;
    sky.uMoonBright.value = clamp01(moonUp * this.night * 1.1);
    sky.uStarIntensity.value = clamp01((this.night - 0.18) * 1.5);

    this.uniforms.mood.uNight.value =
      dt > 0.5 ? this.night : damp(this.uniforms.mood.uNight.value as number, this.night, 2.5, dt);
  }

  /** Clear-sky fog density for this hour; the weather engine scales it. */
  baseFogDensity = 0.006;
  /** Grading exposure for this hour; the engine applies it to the final pass. */
  exposure = 1;

  /** Human-readable label, for the settings panel only. */
  label(): string {
    const h = this.dayT * 24;
    if (h < 4.5) return 'the small hours';
    if (h < 7) return 'first light';
    if (h < 11) return 'morning';
    if (h < 15.5) return 'afternoon';
    if (h < 18.5) return 'golden hour';
    if (h < 20.5) return 'dusk';
    return 'night';
  }
}
