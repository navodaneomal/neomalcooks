import * as THREE from 'three';
import type { WorldUniforms } from '../core/WorldUniforms';
import type { Sky } from '../world/Sky';
import type { Heart } from './Heart';
import { bus } from '../core/Bus';
import { clamp01, damp, lerp, makeRandom, type Rng } from '../core/MathUtils';

/**
 * Procedural weather (brief §16, §17).
 *
 * The hard requirement is that it must never *switch*. So the engine holds a
 * current state and a target state and crossfades between their parameter sets
 * over tens of seconds, with cloud cover deliberately leading rainfall — the
 * sky thickens, the wind gets up, and only then does the first drop fall. The
 * rain itself ramps in over its own separate, slower curve so there is a real
 * "first raindrop, then another, then rain" beat rather than a switch labelled
 * rain.
 */

export type WeatherName =
  | 'clear' | 'breeze' | 'cloudy' | 'lightRain' | 'mist' | 'meteor';

interface WeatherParams {
  wind: number;
  cloudCover: number;
  cloudSharp: number;
  rain: number;
  fogScale: number;
  /** How much this state agitates the garden's heart. */
  agitation: number;
  /** Relative likelihood of being chosen next. */
  weight: number;
  /** Seconds this state tends to last. */
  duration: [number, number];
}

const STATES: Record<WeatherName, WeatherParams> = {
  clear:     { wind: 0.42, cloudCover: 0.14, cloudSharp: 0.75, rain: 0, fogScale: 0.85, agitation: 0.05, weight: 0.30, duration: [110, 260] },
  breeze:    { wind: 1.05, cloudCover: 0.30, cloudSharp: 0.6,  rain: 0, fogScale: 0.95, agitation: 0.28, weight: 0.28, duration: [90, 200] },
  cloudy:    { wind: 0.72, cloudCover: 0.68, cloudSharp: 0.35, rain: 0, fogScale: 1.25, agitation: 0.16, weight: 0.18, duration: [80, 170] },
  lightRain: { wind: 0.86, cloudCover: 0.90, cloudSharp: 0.18, rain: 1, fogScale: 1.75, agitation: 0.42, weight: 0.12, duration: [70, 140] },
  mist:      { wind: 0.20, cloudCover: 0.46, cloudSharp: 0.2,  rain: 0, fogScale: 2.60, agitation: 0.04, weight: 0.08, duration: [70, 150] },
  meteor:    { wind: 0.34, cloudCover: 0.05, cloudSharp: 0.9,  rain: 0, fogScale: 0.7,  agitation: 0.12, weight: 0.04, duration: [55, 95] },
};

/** States it is meteorologically sensible to move to next. */
const TRANSITIONS: Record<WeatherName, WeatherName[]> = {
  clear:     ['breeze', 'cloudy', 'mist', 'meteor'],
  breeze:    ['clear', 'cloudy', 'breeze'],
  cloudy:    ['lightRain', 'breeze', 'clear', 'mist'],
  lightRain: ['cloudy', 'mist'],
  mist:      ['clear', 'cloudy'],
  meteor:    ['clear', 'breeze'],
};

/** Snapshot of the live values, so a mid-transition change starts from the
 *  sky as it actually looks rather than from where the last change began. */
function snapshot(w: Weather): WeatherParams {
  return {
    wind: w.wind, cloudCover: w.cloudCover, cloudSharp: w.cloudSharp,
    rain: w.rain, fogScale: w.fogScale, agitation: w.agitationNow,
    weight: 0, duration: [0, 0],
  };
}

export class Weather {
  state: WeatherName = 'breeze';
  target: WeatherName = 'breeze';
  /** Interpolating between parameter sets, not names: a change can begin from
   *  a half-finished transition without snapping. */
  private from: WeatherParams = { ...STATES.breeze };
  private to: WeatherParams = { ...STATES.breeze };
  /** 0..1 crossfade from `from` to `to`. */
  private blend = 1;
  private hold = 40;
  private rng: Rng;

  /** Current interpolated values, read by everyone else. */
  wind = 0.6;
  cloudCover = 0.3;
  cloudSharp = 0.6;
  /** 0..1 how hard it is raining right now. */
  rain = 0;
  fogScale = 1;
  /** Ground wetness: rises with rain, drains away slowly afterwards. */
  wetness = 0;
  /** 0..1 rainbow visibility — only in the window just after rain stops. */
  rainbow = 0;
  /** True while a meteor shower is possible. */
  get meteorsPossible(): boolean {
    return this.state === 'meteor' || this.target === 'meteor';
  }

  private uniforms: WorldUniforms;
  private sky: Sky;
  private heart: Heart;
  private gustPhase = 0;
  private rainbowWindow = 0;
  private wasRaining = false;

  constructor(uniforms: WorldUniforms, sky: Sky, heart: Heart, seed = 4242) {
    this.uniforms = uniforms;
    this.sky = sky;
    this.heart = heart;
    this.rng = makeRandom(seed);
    // Start somewhere gentle rather than always the same weather.
    this.state = this.rng() < 0.5 ? 'clear' : 'breeze';
    this.target = this.state;
    this.agitationNow = STATES[this.state].agitation;
    this.hold = this.durationOf(this.state);
    this.applyImmediate();
  }

  private durationOf(name: WeatherName): number {
    const [a, b] = STATES[name].duration;
    return lerp(a, b, this.rng());
  }

  private pickNext(): WeatherName {
    const options = TRANSITIONS[this.state];
    const weights = options.map((o) => STATES[o].weight);
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.rng() * total;
    for (let i = 0; i < options.length; i++) {
      r -= weights[i];
      if (r <= 0) return options[i];
    }
    return options[options.length - 1];
  }

  /** Force a state, used by the rare-event system and the settings panel. */
  request(name: WeatherName): void {
    if (this.target === name) return;
    bus.emit('weather:change', { from: this.target, to: name });
    this.from = snapshot(this);
    this.state = this.target;
    this.target = name;
    this.to = STATES[name];
    this.blend = 0;
    this.hold = this.durationOf(name);
  }

  private applyImmediate(): void {
    const p = STATES[this.state];
    this.from = { ...p };
    this.to = { ...p };
    this.wind = p.wind;
    this.cloudCover = p.cloudCover;
    this.cloudSharp = p.cloudSharp;
    this.fogScale = p.fogScale;
  }

  update(dt: number, baseFog: number): void {
    // --- Schedule ------------------------------------------------------------
    this.hold -= dt;
    if (this.hold <= 0 && this.blend >= 1) {
      const next = this.pickNext();
      bus.emit('weather:change', { from: this.target, to: next });
      this.from = snapshot(this);
      this.state = this.target;
      this.target = next;
      this.to = STATES[next];
      this.blend = 0;
      this.hold = this.durationOf(next);
    }

    // --- Crossfade -----------------------------------------------------------
    // Deliberately slow. Clouds gather; they do not appear.
    if (this.blend < 1) this.blend = Math.min(1, this.blend + dt / 38);
    const a = this.from;
    const b = this.to;
    // Smootherstep so the beginning and end of a change are imperceptible.
    const t = this.blend * this.blend * this.blend * (this.blend * (this.blend * 6 - 15) + 10);

    this.cloudCover = lerp(a.cloudCover, b.cloudCover, t);
    this.cloudSharp = lerp(a.cloudSharp, b.cloudSharp, t);
    this.fogScale = lerp(a.fogScale, b.fogScale, t);

    // Wind leads the rain: it gets up while the cloud is still thickening.
    const windTarget = lerp(a.wind, b.wind, clamp01(t * 1.45));
    this.wind = damp(this.wind, windTarget + this.heart.windBoost, 0.5, dt);

    // --- Rain, on its own slower ramp ---------------------------------------
    // Rain cannot begin until the cloud deck is genuinely heavy, which is what
    // produces the "clouds gather, wind rises, then the first drop" sequence.
    const rainWanted = lerp(a.rain, b.rain, t) * clamp01((this.cloudCover - 0.62) / 0.24);
    this.rain = damp(this.rain, rainWanted, rainWanted > this.rain ? 0.30 : 0.55, dt);

    // --- Wetness: soaks fast, dries slowly ----------------------------------
    const dryRate = 0.020 * (1 - this.cloudCover * 0.5);
    if (this.rain > 0.02) this.wetness = clamp01(this.wetness + dt * this.rain * 0.09);
    else this.wetness = Math.max(0, this.wetness - dt * dryRate);

    // --- Rainbow: only just after rain, and only rarely ----------------------
    const raining = this.rain > 0.12;
    if (this.wasRaining && !raining) {
      // A real chance, not a certainty — the brief asks for "very rarely".
      this.rainbowWindow = this.rng() < 0.3 ? 26 : 0;
    }
    this.wasRaining = raining;
    if (this.rainbowWindow > 0) {
      this.rainbowWindow -= dt;
      // Needs sun on wet air: fade in as the cloud breaks.
      const sunny = clamp01(1 - this.cloudCover * 1.5);
      this.rainbow = damp(this.rainbow, sunny * clamp01(this.wetness * 2), 0.5, dt);
      if (this.rainbowWindow <= 0) bus.emit('event:rare', { id: 'rainbow' });
    } else {
      this.rainbow = damp(this.rainbow, 0, 0.35, dt);
    }

    // --- Gusts ---------------------------------------------------------------
    this.gustPhase += dt * (0.12 + this.wind * 0.20);

    // --- Publish -------------------------------------------------------------
    const u = this.uniforms;
    u.wind.uWindStrength.value = this.wind;
    u.wind.uGustPhase.value = this.gustPhase;
    u.mood.uWetness.value = this.wetness;
    u.atmosphere.uFogDensity.value = baseFog * this.fogScale;

    // Wind slowly changes direction; a field where the wind never turns feels
    // mechanical after a minute.
    const dir = u.wind.uWindDir.value as THREE.Vector2;
    const drift = Math.sin(this.gustPhase * 0.21) * 0.28 + Math.sin(this.gustPhase * 0.073 + 1.3) * 0.4;
    const ang = drift;
    dir.set(Math.cos(ang), Math.sin(ang)).normalize();

    this.sky.uniforms.uCloudCover.value = this.cloudCover;
    this.sky.uniforms.uCloudSharp.value = this.cloudSharp;
    this.sky.uniforms.uRainbow.value = this.rainbow;

    this.agitationNow = lerp(a.agitation, b.agitation, t);
    this.heart.weatherAgitation = this.agitationNow + this.rain * 0.3;
  }

  /** Interpolated agitation, exposed so a snapshot can capture it. */
  agitationNow = 0;

  label(): string {
    const names: Record<WeatherName, string> = {
      clear: 'clear', breeze: 'a gentle breeze', cloudy: 'clouding over',
      lightRain: 'light rain', mist: 'mist', meteor: 'clear and starlit',
    };
    if (this.rain > 0.15) return 'rain';
    if (this.blend < 0.85) return `${names[this.state]} \u2192 ${names[this.target]}`;
    return names[this.target];
  }
}
