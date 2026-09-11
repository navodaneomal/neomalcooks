import { bus } from '../core/Bus';
import type { Weather } from './Weather';
import type { Meteors } from '../world/Meteors';
import type { Heart } from './Heart';
import type { DayCycle } from './DayCycle';
import type { Memory } from './Memory';
import { makeRandom, type Rng } from '../core/MathUtils';

/**
 * Rare events (brief §47).
 *
 * Each event carries its own probability, cooldown and set of conditions, and
 * the scheduler only *considers* one every few seconds. The result is that
 * events genuinely cannot be predicted: they will not fire twice in a row, they
 * will not fire when the world is wrong for them, and there is no interval you
 * could learn.
 *
 * Nothing here fires on a fixed timer, and nothing announces itself.
 */

interface RareEvent {
  id: string;
  /** Chance of firing each time it is considered. */
  chance: number;
  /** Minimum seconds before it may fire again. */
  cooldown: number;
  /** Whether the world is currently right for it. */
  when: (ctx: EventContext) => boolean;
  run: (ctx: EventContext) => void;
  /** Seconds remaining before it can fire again. */
  timer?: number;
}

interface EventContext {
  weather: Weather;
  meteors: Meteors;
  heart: Heart;
  day: DayCycle;
  memory: Memory;
  rng: Rng;
}

const EVENTS: RareEvent[] = [
  {
    id: 'meteor-shower',
    chance: 0.16, cooldown: 220,
    when: (c) => c.day.night > 0.6 && c.weather.cloudCover < 0.4,
    run: (c) => {
      // A shower, not a single streak: several over the next few seconds.
      const n = 4 + Math.floor(c.rng() * 7);
      for (let i = 0; i < n; i++) {
        window.setTimeout(() => c.meteors.launch(1 + c.rng() * 0.6), i * (280 + c.rng() * 900));
      }
    },
  },
  {
    id: 'single-star',
    chance: 0.30, cooldown: 42,
    when: (c) => c.day.night > 0.45 && c.weather.cloudCover < 0.62,
    run: (c) => c.meteors.launch(0.85 + c.rng() * 0.4),
  },
  {
    id: 'wind-wave',
    chance: 0.22, cooldown: 95,
    when: (c) => c.weather.rain < 0.2,
    run: () => bus.emit('garden:bloom', { x: 0, z: 0, radius: 260, power: 0.30 }),
  },
  {
    id: 'butterfly-swarm',
    chance: 0.09, cooldown: 300,
    when: (c) => c.day.night < 0.3 && c.weather.rain < 0.15,
    run: () => bus.emit('event:rare', { id: 'butterfly-swarm' }),
  },
  {
    id: 'golden-sunrise',
    chance: 0.12, cooldown: 420,
    when: (c) => {
      const h = c.day.dayT * 24;
      return h > 4.5 && h < 8 && c.weather.cloudCover < 0.5;
    },
    run: (c) => {
      c.memory.discover('golden', 'The Golden Tulip Garden');
      bus.emit('event:rare', { id: 'golden-sunrise' });
    },
  },
  {
    id: 'petal-spiral',
    chance: 0.18, cooldown: 150,
    when: (c) => c.heart.energy > 0.35,
    run: () => bus.emit('event:rare', { id: 'petal-spiral' }),
  },
  {
    id: 'mass-bloom',
    chance: 0.05, cooldown: 520,
    when: (c) => c.heart.energy > 0.5 && c.heart.wonder < 0.3,
    run: () => bus.emit('garden:bloom', { x: 0, z: 0, radius: 340, power: 0.8 }),
  },
  {
    id: 'glowing-rain',
    chance: 0.14, cooldown: 380,
    when: (c) => c.weather.rain > 0.4 && c.day.night > 0.4,
    run: () => bus.emit('event:rare', { id: 'glowing-rain' }),
  },
];

export class Events {
  private ctx: EventContext;
  private consider = 0;
  /** The last event to fire, so the same one never repeats immediately. */
  private lastId = '';

  constructor(weather: Weather, meteors: Meteors, heart: Heart, day: DayCycle, memory: Memory, seed = 31337) {
    this.ctx = { weather, meteors, heart, day, memory, rng: makeRandom(seed) };
    // Stagger the initial cooldowns so nothing is available in the first moments.
    for (const e of EVENTS) e.timer = 25 + this.ctx.rng() * e.cooldown * 0.6;
  }

  update(dt: number): void {
    for (const e of EVENTS) {
      if (e.timer !== undefined && e.timer > 0) e.timer -= dt;
    }

    this.consider -= dt;
    if (this.consider > 0) return;
    // Consider at an irregular interval, so even the *attempts* are unpredictable.
    this.consider = 5 + this.ctx.rng() * 9;

    // Shuffle the order each time so ties are not always broken the same way.
    const order = EVENTS.slice().sort(() => this.ctx.rng() - 0.5);
    for (const e of order) {
      if ((e.timer ?? 0) > 0) continue;
      if (e.id === this.lastId) continue;
      if (!e.when(this.ctx)) continue;
      if (this.ctx.rng() > e.chance) continue;
      e.timer = e.cooldown;
      this.lastId = e.id;
      e.run(this.ctx);
      bus.emit('event:rare', { id: e.id });
      return;   // At most one event per consideration.
    }
  }
}
