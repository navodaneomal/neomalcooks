import { bus } from '../core/Bus';

/**
 * The garden remembers (brief §14, §35, §36).
 *
 * Everything is kept in one versioned localStorage record. The rule the brief
 * sets is that memory must never be *announced* — no "welcome back" — so
 * nothing here writes to the screen. It only changes what exists: an extra
 * tulip that was not there before, a path that has appeared, a garden that has
 * quietly grown since the last visit.
 *
 * Storage can throw (private windows, disabled site data, a full quota), so
 * every access is guarded and the experience is fully playable with no
 * persistence at all.
 */

const KEY = 'tulip-garden/v1';

export interface PlantedTulip {
  x: number;
  z: number;
  hue: number;
  /** Epoch ms when it was planted, so it can keep growing between visits. */
  planted: number;
}

export interface GardenMemory {
  version: 1;
  visits: number;
  firstVisit: number;
  lastVisit: number;
  /** Total seconds spent in the garden across all visits. */
  timeSpent: number;
  /** Ids of secret places found. */
  discovered: string[];
  /** Poetic messages already revealed, so they are not repeated. */
  messagesSeen: number[];
  bloomsCreated: number;
  tulipsTouched: number;
  planted: PlantedTulip[];
  /** True once the full narrative has been seen at least once. */
  sawEnding: boolean;
  /** User preferences, kept alongside so one clear resets everything. */
  prefs: {
    muted: boolean;
    volume: number;
    reducedMotion: boolean | null;
    tier: string | null;
    hour: number | null;
  };
}

function blank(): GardenMemory {
  const now = Date.now();
  return {
    version: 1,
    visits: 0,
    firstVisit: now,
    lastVisit: now,
    timeSpent: 0,
    discovered: [],
    messagesSeen: [],
    bloomsCreated: 0,
    tulipsTouched: 0,
    planted: [],
    sawEnding: false,
    prefs: { muted: false, volume: 0.7, reducedMotion: null, tier: null, hour: null },
  };
}

export class Memory {
  data: GardenMemory;
  /** True when storage is unavailable — the world still works, it just forgets. */
  readonly ephemeral: boolean;

  private sessionStart = performance.now();
  private dirty = false;
  private saveTimer = 0;

  constructor() {
    let loaded: GardenMemory | null = null;
    let ok = true;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<GardenMemory>;
        if (parsed && parsed.version === 1) {
          loaded = { ...blank(), ...parsed, prefs: { ...blank().prefs, ...(parsed.prefs ?? {}) } };
        }
      }
      // Probe writability up front rather than discovering it at save time.
      localStorage.setItem(`${KEY}/probe`, '1');
      localStorage.removeItem(`${KEY}/probe`);
    } catch {
      ok = false;
    }
    this.ephemeral = !ok;
    this.data = loaded ?? blank();
    this.data.visits += 1;
    this.data.lastVisit = Date.now();
    this.dirty = true;
  }

  /** Days since the previous visit, or 0 on a first visit. */
  get daysSinceLastVisit(): number {
    if (this.data.visits <= 1) return 0;
    return Math.max(0, (Date.now() - this.data.lastVisit) / 86400000);
  }

  get isFirstVisit(): boolean {
    return this.data.visits <= 1;
  }

  has(id: string): boolean {
    return this.data.discovered.includes(id);
  }

  /** Record a discovery. Returns false if it was already known. */
  discover(id: string, label: string): boolean {
    if (this.has(id)) return false;
    this.data.discovered.push(id);
    this.touch();
    bus.emit('garden:discovery', { id, label });
    return true;
  }

  plant(t: PlantedTulip): void {
    // A reasonable ceiling: enough that a regular visitor's garden really grows,
    // small enough that the record never becomes a burden to parse.
    if (this.data.planted.length >= 240) this.data.planted.shift();
    this.data.planted.push(t);
    this.touch();
  }

  markMessage(i: number): void {
    if (!this.data.messagesSeen.includes(i)) {
      this.data.messagesSeen.push(i);
      this.touch();
    }
  }

  addBloom(n = 1): void {
    this.data.bloomsCreated += n;
    this.touch();
  }

  addTouch(): void {
    this.data.tulipsTouched += 1;
    this.touch();
  }

  setPref<K extends keyof GardenMemory['prefs']>(key: K, value: GardenMemory['prefs'][K]): void {
    this.data.prefs[key] = value;
    this.touch();
  }

  touch(): void {
    this.dirty = true;
  }

  /**
   * How grown the garden is, 0..1, from visits and discoveries. Drives how much
   * extra there is to find — the brief's "visit 1 -> one tulip, visit 5 -> a
   * hidden garden" progression.
   */
  get growth(): number {
    const v = Math.min(1, (this.data.visits - 1) / 6);
    const d = Math.min(1, this.data.discovered.length / 7);
    return Math.min(1, v * 0.6 + d * 0.4);
  }

  update(dt: number): void {
    this.saveTimer += dt;
    // Batch writes: localStorage is synchronous and can stall the frame.
    if (this.saveTimer > 5 && this.dirty) {
      this.saveTimer = 0;
      this.save();
    }
  }

  save(): void {
    if (this.ephemeral) return;
    this.data.timeSpent += (performance.now() - this.sessionStart) / 1000;
    this.sessionStart = performance.now();
    this.dirty = false;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // Quota or a locked-down browser: forget silently rather than break.
    }
  }

  forget(): void {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* nothing to do */
    }
    this.data = blank();
    this.data.visits = 1;
  }
}
