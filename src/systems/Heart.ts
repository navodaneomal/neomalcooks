import type { WorldUniforms } from '../core/WorldUniforms';
import { bus } from '../core/Bus';
import { clamp01, damp } from '../core/MathUtils';

/**
 * THE HEART OF THE TULIP GARDEN (brief §05).
 *
 * An invisible simulation of the garden's mood. Nothing draws it; everything
 * reads it. Four slow-moving values are pushed by music, weather, her dancing,
 * the hour and whatever the visitor has just found, and every shader in the
 * world takes its expressiveness from them.
 *
 * The values deliberately move at different speeds. Energy answers within a
 * second so the field can respond to a beat; calm takes many seconds to return
 * so that stillness has to be *earned*; wonder spikes and decays like a held
 * breath. Getting those time constants right is most of what makes the
 * environment feel like it has moods rather than settings.
 */
export class Heart {
  /** 0 = perfectly still, 1 = the field is dancing. */
  energy = 0;
  /** 0 = agitated, 1 = utterly quiet. Not simply 1 - energy: it lags. */
  calm = 1;
  /** Spikes on discoveries and rare events, then fades. */
  wonder = 0;
  /** Slow-building sense of the world being *awake*. */
  presence = 0;

  /** External drives, written each frame by whoever knows about them. */
  audioLevel = 0;
  audioPeak = 0;
  herMotion = 0;
  interaction = 0;
  weatherAgitation = 0;

  private uniforms: WorldUniforms;
  private wonderDecayTarget = 0;

  constructor(uniforms: WorldUniforms) {
    this.uniforms = uniforms;
    bus.on('garden:discovery', () => this.spark(0.85));
    bus.on('event:rare', () => this.spark(0.6));
    bus.on('garden:bloom', (p) => this.spark(clamp01(p.power) * 0.5));
  }

  /** A moment of wonder. Decays on its own. */
  spark(amount: number): void {
    this.wonderDecayTarget = Math.min(1, this.wonderDecayTarget + amount);
  }

  update(dt: number): void {
    // --- Energy: what is actually happening right now --------------------
    const drive = clamp01(
      this.audioLevel * 0.85 +
      this.audioPeak * 0.5 +
      this.herMotion * 0.7 +
      this.interaction * 0.6 +
      this.weatherAgitation * 0.45,
    );
    // Rises quickly (the field should catch a beat), falls more slowly.
    const rate = drive > this.energy ? 3.4 : 1.15;
    this.energy = damp(this.energy, drive, rate, dt);

    // --- Calm: stillness has to be earned --------------------------------
    // It only climbs when almost nothing is happening, and it climbs slowly.
    const stillness = clamp01(1 - drive * 1.6);
    this.calm = damp(this.calm, stillness, stillness > this.calm ? 0.35 : 2.2, dt);

    // --- Wonder: a held breath -------------------------------------------
    this.wonderDecayTarget = damp(this.wonderDecayTarget, 0, 0.42, dt);
    this.wonder = damp(this.wonder, this.wonderDecayTarget, 2.6, dt);

    // --- Presence: the world waking up over the course of a visit ---------
    this.presence = damp(this.presence, 1, 0.06, dt);

    const m = this.uniforms.mood;
    m.uEnergy.value = this.energy;
    m.uCalm.value = this.calm;
    m.uWonder.value = this.wonder;

    // The heart also breathes on the air itself: an excited garden has more
    // wind in it even when the weather has not changed at all.
    this.windBoost = this.energy * 0.42 + this.wonder * 0.25;

    // Decay the one-frame drives so a system that stops writing stops driving.
    this.interaction = damp(this.interaction, 0, 2.4, dt);
    this.audioPeak = damp(this.audioPeak, 0, 4.0, dt);
  }

  /** Extra wind strength the mood contributes, added by the weather engine. */
  windBoost = 0;

  /** Human-readable mood, for the settings panel's diagnostics only. */
  label(): string {
    if (this.wonder > 0.5) return 'wondering';
    if (this.energy > 0.62) return 'dancing';
    if (this.energy > 0.3) return 'stirring';
    if (this.calm > 0.75) return 'still';
    return 'breathing';
  }
}
