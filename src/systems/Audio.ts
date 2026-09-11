import type { WorldUniforms } from '../core/WorldUniforms';
import type { Heart } from './Heart';
import { bus } from '../core/Bus';
import { clamp01, damp, makeRandom, type Rng } from '../core/MathUtils';

/**
 * The audio engine (brief §21-§24).
 *
 * Two halves that meet at one analyser:
 *
 *  - A generator that synthesises the garden's own soundscape from scratch —
 *    wind, grass, a slow harmonic pad, bell-like notes on a pentatonic scale,
 *    the occasional distant bird. Nothing is sampled, so there are no assets to
 *    load, nothing to fail on a slow connection, and the music is different
 *    every visit.
 *  - An analyser on the master bus that the rest of the world reads.
 *
 * Putting the analyser on the *master* bus rather than on an imported track is
 * the important decision: it means the garden reacts to its own music exactly
 * as it would to hers. Drop a track in and the same machinery drives the same
 * tulips — nothing special-cases the "no audio" path, so it cannot break.
 *
 * Browsers will not start an AudioContext without a gesture. Everything here is
 * built to be silent-but-correct until that gesture arrives, and the visuals
 * never depend on audio existing.
 */

export type AudioBands = {
  bass: number;
  mid: number;
  high: number;
  voice: number;
  level: number;
  peak: number;
};

/** A minor pentatonic, which is hard to make sound wrong. */
const SCALE = [0, 3, 5, 7, 10];
const ROOT = 220; // A3

function midiToFreq(semitonesAboveRoot: number): number {
  return ROOT * Math.pow(2, semitonesAboveRoot / 12);
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  ready = false;
  blocked = false;
  muted = false;
  volume = 0.7;

  readonly bands: AudioBands = { bass: 0, mid: 0, high: 0, voice: 0, level: 0, peak: 0 };

  /** Name of an imported track, or null when the garden is playing itself. */
  trackName: string | null = null;

  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private freqData = new Uint8Array(new ArrayBuffer(0));
  private ambientGain: GainNode | null = null;

  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private grassGain: GainNode | null = null;
  private padGain: GainNode | null = null;
  private padFilter: BiquadFilterNode | null = null;
  private padOscs: OscillatorNode[] = [];
  private noiseSources: AudioBufferSourceNode[] = [];

  private trackSource: AudioBufferSourceNode | null = null;
  private trackGain: GainNode | null = null;

  private uniforms: WorldUniforms;
  private heart: Heart;
  private rng: Rng = makeRandom(9911);

  private nextNote = 0;
  private nextBird = 0;
  private prevLevel = 0;

  /** Set by the weather engine so the wind you hear matches the wind you see. */
  windStrength = 0.5;
  /** Set by the weather engine; rain adds its own noise bed. */
  rain = 0;
  /** Night thins the birds and thickens the pad. */
  night = 0;

  constructor(uniforms: WorldUniforms, heart: Heart) {
    this.uniforms = uniforms;
    this.heart = heart;
  }

  /**
   * Called from a real user gesture. Safe to call repeatedly.
   */
  async unlock(): Promise<void> {
    if (this.ready) {
      if (this.ctx?.state === 'suspended') {
        try { await this.ctx.resume(); } catch { /* stay silent */ }
      }
      return;
    }
    try {
      const Ctor = window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        this.blocked = true;
        bus.emit('audio:blocked');
        return;
      }
      const ctx = new Ctor();
      this.ctx = ctx;
      if (ctx.state === 'suspended') await ctx.resume();

      this.buildGraph(ctx);
      this.ready = true;
      this.blocked = false;
      bus.emit('audio:ready');
    } catch {
      // A locked-down browser, or no audio device. The world is unaffected.
      this.blocked = true;
      bus.emit('audio:blocked');
    }
  }

  // -------------------------------------------------------------------------
  // Graph
  // -------------------------------------------------------------------------

  private buildGraph(ctx: AudioContext): void {
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : this.volume;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.72;
    analyser.minDecibels = -92;
    analyser.maxDecibels = -18;

    master.connect(analyser);
    analyser.connect(ctx.destination);

    this.master = master;
    this.analyser = analyser;
    this.freqData = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));

    const ambient = ctx.createGain();
    ambient.gain.value = 1;
    ambient.connect(master);
    this.ambientGain = ambient;

    // --- Wind: filtered noise, band centred where wind actually lives -------
    const noiseBuf = this.makeNoiseBuffer(ctx, 6);

    const windSrc = ctx.createBufferSource();
    windSrc.buffer = noiseBuf;
    windSrc.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 420;
    windFilter.Q.value = 0.55;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.0;
    windSrc.connect(windFilter).connect(windGain).connect(ambient);
    windSrc.start();
    this.noiseSources.push(windSrc);
    this.windGain = windGain;
    this.windFilter = windFilter;

    // --- Grass: the bright hiss of a field moving ---------------------------
    const grassSrc = ctx.createBufferSource();
    grassSrc.buffer = noiseBuf;
    grassSrc.loop = true;
    grassSrc.playbackRate.value = 0.83;   // decorrelate from the wind layer
    const grassFilter = ctx.createBiquadFilter();
    grassFilter.type = 'highpass';
    grassFilter.frequency.value = 2600;
    const grassGain = ctx.createGain();
    grassGain.gain.value = 0.0;
    grassSrc.connect(grassFilter).connect(grassGain).connect(ambient);
    grassSrc.start();
    this.noiseSources.push(grassSrc);
    this.grassGain = grassGain;

    // --- Pad: three detuned voices under a slowly breathing filter ----------
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 520;
    padFilter.Q.value = 0.7;
    const padGain = ctx.createGain();
    padGain.gain.value = 0.0;
    padFilter.connect(padGain).connect(ambient);

    for (const [mult, detune] of [[1, -5], [1, 6], [1.5, 2], [2, -3]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = ROOT * 0.5 * mult;
      osc.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = mult >= 1.5 ? 0.14 : 0.3;
      osc.connect(g).connect(padFilter);
      osc.start();
      this.padOscs.push(osc);
    }
    this.padGain = padGain;
    this.padFilter = padFilter;
  }

  /** Pink-ish noise: white noise run through a cheap one-pole cascade. */
  private makeNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const white = this.rng() * 2 - 1;
      // Paul Kellet's economy pink filter — cheap and close enough.
      b0 = 0.99765 * b0 + white * 0.0990460;
      b1 = 0.96300 * b1 + white * 0.2965164;
      b2 = 0.57000 * b2 + white * 1.0526913;
      data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.16;
    }
    return buf;
  }

  // -------------------------------------------------------------------------
  // Voices
  // -------------------------------------------------------------------------

  /**
   * A struck note: an inharmonic partial stack with an exponential tail. The
   * slightly-off overtones (2.01, 3.03) are what make it read as a struck
   * object rather than a synthesiser.
   */
  private strike(freq: number, gain: number, decay: number): void {
    const ctx = this.ctx;
    const dest = this.ambientGain;
    if (!ctx || !dest) return;
    const now = ctx.currentTime;

    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0002), now + 0.012);
    out.gain.exponentialRampToValueAtTime(0.0001, now + decay);
    out.connect(dest);

    for (const [mult, amp] of [[1, 1], [2.01, 0.34], [3.03, 0.14], [4.7, 0.05]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * mult;
      const g = ctx.createGain();
      g.gain.value = amp;
      osc.connect(g).connect(out);
      osc.start(now);
      osc.stop(now + decay + 0.1);
    }
    // Let the graph collect itself once the tail has run out.
    window.setTimeout(() => { try { out.disconnect(); } catch { /* already gone */ } },
      (decay + 0.4) * 1000);
  }

  /** A distant bird: two or three quick descending chirps. */
  private bird(): void {
    const ctx = this.ctx;
    const dest = this.ambientGain;
    if (!ctx || !dest) return;
    const now = ctx.currentTime;
    const base = 1900 + this.rng() * 1500;
    const notes = 2 + Math.floor(this.rng() * 2);

    for (let i = 0; i < notes; i++) {
      const t = now + i * (0.09 + this.rng() * 0.07);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(base * (1 + this.rng() * 0.2), t);
      osc.frequency.exponentialRampToValueAtTime(base * 0.62, t + 0.07);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      osc.connect(g).connect(dest);
      osc.start(t);
      osc.stop(t + 0.14);
    }
  }

  /** Play a short phrase — used when a tulip is touched (brief §48, egg 6). */
  phrase(seedNote = 0): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const n = 3 + Math.floor(this.rng() * 3);
    for (let i = 0; i < n; i++) {
      const step = SCALE[(seedNote + i * 2) % SCALE.length] + 12 * (1 + Math.floor(this.rng() * 2));
      const freq = midiToFreq(step);
      window.setTimeout(() => {
        if (this.ctx === ctx) this.strike(freq, 0.10, 2.6);
      }, i * (150 + this.rng() * 90));
    }
  }

  // -------------------------------------------------------------------------
  // Imported track
  // -------------------------------------------------------------------------

  /**
   * Play a supplied audio file through the same analyser the garden listens to.
   * Everything downstream is unchanged — the field simply has something else to
   * listen to.
   */
  async loadTrack(file: File): Promise<boolean> {
    await this.unlock();
    const ctx = this.ctx;
    if (!ctx || !this.master) return false;
    try {
      const bytes = await file.arrayBuffer();
      const buffer = await ctx.decodeAudioData(bytes);
      this.stopTrack();

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 1;
      src.connect(g).connect(this.master);
      src.start();

      this.trackSource = src;
      this.trackGain = g;
      this.trackName = file.name;
      // Duck the generated soundscape under the supplied one rather than
      // cutting it: the wind should not stop just because a song started.
      if (this.ambientGain) {
        this.ambientGain.gain.setTargetAtTime(0.22, ctx.currentTime, 1.2);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Fade the imported track's own level, independent of master volume. */
  setTrackLevel(v: number): void {
    if (this.trackGain && this.ctx) {
      this.trackGain.gain.setTargetAtTime(clamp01(v), this.ctx.currentTime, 0.2);
    }
  }

  stopTrack(): void {
    if (this.trackGain && this.ctx) {
      // Fade out before stopping so cutting a track never clicks.
      this.trackGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
    }
    if (this.trackSource) {
      const src = this.trackSource;
      const g = this.trackGain;
      window.setTimeout(() => {
        try { src.stop(); } catch { /* already stopped */ }
        try { src.disconnect(); } catch { /* already gone */ }
        try { g?.disconnect(); } catch { /* already gone */ }
      }, 260);
    }
    this.trackSource = null;
    this.trackGain = null;
    this.trackName = null;
    if (this.ambientGain && this.ctx) {
      this.ambientGain.gain.setTargetAtTime(1, this.ctx.currentTime, 1.2);
    }
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.15);
    }
  }

  setVolume(v: number): void {
    this.volume = clamp01(v);
    if (this.master && this.ctx && !this.muted) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.12);
    }
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt: number): void {
    const b = this.bands;

    if (this.ready && this.ctx && this.analyser) {
      this.analyser.getByteFrequencyData(this.freqData);
      const sr = this.ctx.sampleRate;
      const binHz = sr / this.analyser.fftSize;

      const band = (loHz: number, hiHz: number): number => {
        const lo = Math.max(0, Math.floor(loHz / binHz));
        const hi = Math.min(this.freqData.length - 1, Math.ceil(hiHz / binHz));
        let sum = 0;
        for (let i = lo; i <= hi; i++) sum += this.freqData[i];
        return hi >= lo ? sum / ((hi - lo + 1) * 255) : 0;
      };

      // Ranges chosen to map onto the brief's four channels.
      const bass = band(28, 160);
      const mid = band(160, 1800);
      const high = band(1800, 8500);
      // "Voice" is the presence region where a sung line sits, weighted against
      // the rest so a wall of pad does not read as singing.
      const voice = clamp01(band(280, 1400) * 1.35 - band(60, 240) * 0.5);
      const level = clamp01(bass * 0.5 + mid * 0.85 + high * 0.5);

      b.bass = damp(b.bass, bass, 9, dt);
      b.mid = damp(b.mid, mid, 9, dt);
      b.high = damp(b.high, high, 11, dt);
      b.voice = damp(b.voice, voice, 7, dt);
      b.level = damp(b.level, level, 8, dt);
      // A peak is a rise, not a loudness — that is what makes it feel musical.
      const rise = Math.max(0, level - this.prevLevel) * 14;
      this.prevLevel = damp(this.prevLevel, level, 4, dt);
      b.peak = damp(b.peak, clamp01(rise), rise > b.peak ? 16 : 3, dt);
    } else {
      // Silence must still decay smoothly rather than snapping to zero.
      b.bass = damp(b.bass, 0, 2, dt);
      b.mid = damp(b.mid, 0, 2, dt);
      b.high = damp(b.high, 0, 2, dt);
      b.voice = damp(b.voice, 0, 2, dt);
      b.level = damp(b.level, 0, 2, dt);
      b.peak = damp(b.peak, 0, 3, dt);
    }

    // --- Drive the world -----------------------------------------------------
    const m = this.uniforms.mood;
    m.uAudioBass.value = b.bass;
    m.uAudioMid.value = b.mid;
    m.uAudioHigh.value = b.high;
    m.uAudioVoice.value = b.voice;
    m.uAudioLevel.value = b.level;

    this.heart.audioLevel = b.level;
    this.heart.audioPeak = b.peak;

    if (!this.ready || !this.ctx) return;

    // --- Keep the soundscape in step with the weather ------------------------
    const now = this.ctx.currentTime;
    const w = this.windStrength;

    if (this.windGain && this.windFilter) {
      // Rain rides on the wind bed, brighter and louder.
      const target = 0.045 + w * 0.085 + this.rain * 0.22;
      this.windGain.gain.setTargetAtTime(target, now, 0.6);
      this.windFilter.frequency.setTargetAtTime(320 + w * 520 + this.rain * 900, now, 0.9);
      this.windFilter.Q.setTargetAtTime(0.5 + this.rain * 1.6, now, 0.9);
    }
    if (this.grassGain) {
      this.grassGain.gain.setTargetAtTime(0.010 + w * 0.030 + this.rain * 0.05, now, 0.7);
    }
    if (this.padGain && this.padFilter) {
      // The pad swells with the garden's own mood — the heart is audible.
      const heartLift = this.heart.energy * 0.5 + this.heart.wonder * 0.6;
      this.padGain.gain.setTargetAtTime(0.020 + this.night * 0.020 + heartLift * 0.028, now, 1.6);
      this.padFilter.frequency.setTargetAtTime(
        380 + heartLift * 900 + Math.sin(now * 0.07) * 120, now, 1.4);
    }

    // --- Melody: sparse, and sparser when the garden is calm -----------------
    this.nextNote -= dt;
    if (this.nextNote <= 0) {
      const busy = clamp01(this.heart.energy * 0.8 + this.heart.wonder);
      // Between roughly 1.4s (excited) and 9s (still) apart.
      this.nextNote = 9.0 - busy * 7.6 + this.rng() * 2.2;
      const octave = 12 * (1 + Math.floor(this.rng() * 2.4));
      const step = SCALE[Math.floor(this.rng() * SCALE.length)] + octave;
      const gain = (0.045 + busy * 0.075) * (this.rain > 0.3 ? 0.55 : 1);
      this.strike(midiToFreq(step), gain, 3.2 + this.rng() * 2.4);
    }

    // --- Birds: daytime only, and never on a schedule you could predict ------
    this.nextBird -= dt;
    if (this.nextBird <= 0) {
      this.nextBird = 12 + this.rng() * 30;
      if (this.night < 0.35 && this.rain < 0.25 && this.rng() < 0.55) this.bird();
    }
  }

  /** Release everything. Called on teardown. */
  dispose(): void {
    this.stopTrack();
    for (const s of this.noiseSources) { try { s.stop(); } catch { /* already stopped */ } }
    for (const o of this.padOscs) { try { o.stop(); } catch { /* already stopped */ } }
    this.noiseSources = [];
    this.padOscs = [];
    try { void this.ctx?.close(); } catch { /* already closed */ }
    this.ctx = null;
    this.ready = false;
  }
}
