/**
 * Tiny typed event bus. The engines never import each other directly — the
 * weather doesn't know the audio exists, the dancer doesn't know about the
 * tulips — they just announce what happened and whoever cares reacts. Keeps the
 * module graph acyclic and makes new features cheap to bolt on.
 */

export type WorldEvents = {
  'loader:progress': { step: string; t: number };
  'loader:done': void;
  'act:change': { act: string };
  'garden:bloom': { x: number; z: number; radius: number; power: number };
  'garden:discovery': { id: string; label: string };
  'garden:plant': { x: number; z: number };
  'garden:message': { text: string; x: number; y: number; z: number };
  'weather:change': { from: string; to: string };
  'event:rare': { id: string };
  'audio:ready': void;
  'audio:blocked': void;
  'quality:change': { tier: string };
  'ui:toggle': { visible: boolean };
  'she:state': { state: string };
};

type Handler<T> = (payload: T) => void;

export class Bus {
  private map = new Map<string, Set<Handler<any>>>();

  on<K extends keyof WorldEvents>(key: K, fn: Handler<WorldEvents[K]>): () => void {
    let set = this.map.get(key as string);
    if (!set) {
      set = new Set();
      this.map.set(key as string, set);
    }
    set.add(fn);
    return () => this.off(key, fn);
  }

  once<K extends keyof WorldEvents>(key: K, fn: Handler<WorldEvents[K]>): void {
    const off = this.on(key, (p) => {
      off();
      fn(p);
    });
  }

  off<K extends keyof WorldEvents>(key: K, fn: Handler<WorldEvents[K]>): void {
    this.map.get(key as string)?.delete(fn);
  }

  emit<K extends keyof WorldEvents>(
    key: K,
    ...args: WorldEvents[K] extends void ? [] : [WorldEvents[K]]
  ): void {
    const set = this.map.get(key as string);
    if (!set) return;
    // Copy so a handler can unsubscribe itself without disturbing iteration.
    for (const fn of Array.from(set)) {
      try {
        fn(args[0]);
      } catch (err) {
        // One bad listener must never take down the frame loop.
        console.warn(`[bus] handler for "${String(key)}" threw`, err);
      }
    }
  }
}

export const bus = new Bus();
