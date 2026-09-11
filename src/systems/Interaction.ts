import * as THREE from 'three';
import type { Engine } from '../core/Engine';
import type { CameraDirector } from './CameraDirector';
import type { TulipField } from '../world/TulipField';
import type { Pond } from '../world/Pond';
import type { AudioEngine } from './Audio';
import type { Memory } from './Memory';
import { terrainHeight } from '../world/Terrain';
import { bus } from '../core/Bus';
import { clamp01 } from '../core/MathUtils';

/**
 * Everything the visitor can actually do (brief §35, §48, §51, §52).
 *
 * Pointer, touch and keyboard all funnel into the same small set of intents, so
 * a tap and a click are genuinely the same event and neither platform is a
 * port of the other. Gestures the brief asks for on mobile — long press, swipe
 * up, pinch, double tap — are recognised here rather than bolted on.
 *
 * Ground picking is done by marching the view ray against the height field
 * rather than raycasting the terrain mesh: the mesh is a coarse displaced disc,
 * so a mesh hit would be metres away from where the ground visually is.
 */

export interface PlantedSeed {
  x: number;
  z: number;
  hue: number;
  /** Seconds since it was planted, so it can grow while you watch. */
  age: number;
}

export class Interaction {
  /** Seeds planted this session plus any restored from memory. */
  readonly seeds: PlantedSeed[] = [];
  /** World point currently under the cursor, or null if it misses the ground. */
  readonly hover = new THREE.Vector3();
  hasHover = false;

  /** Raised briefly when the visitor does something, feeding the Heart. */
  activity = 0;
  /** Set true while a long press is being held. */
  private pressing = false;
  private pressTime = 0;
  private pressPoint = new THREE.Vector2();
  private lastTapTime = 0;
  private lastTapPos = new THREE.Vector2();
  private moved = false;
  private pointerDown = false;
  private lastPointer = new THREE.Vector2();
  private pinchDist = 0;
  private activePointers = new Map<number, THREE.Vector2>();

  /** True while the "don't touch anything" beat owns the screen. */
  suspended = false;

  private engine: Engine;
  private camera: CameraDirector;
  private field: TulipField;
  private pond: Pond;
  private audio: AudioEngine;
  private memory: Memory;
  private ray = new THREE.Ray();
  private ndc = new THREE.Vector2();
  private tmp = new THREE.Vector3();

  /** Set by the events system when a shooting star is currently visible. */
  shootingStarWindow = 0;

  constructor(
    engine: Engine, camera: CameraDirector, field: TulipField,
    pond: Pond, audio: AudioEngine, memory: Memory,
  ) {
    this.engine = engine;
    this.camera = camera;
    this.field = field;
    this.pond = pond;
    this.audio = audio;
    this.memory = memory;

    // Restore whatever was planted on previous visits. They keep growing.
    for (const p of memory.data.planted) {
      const ageDays = (Date.now() - p.planted) / 86400000;
      this.seeds.push({ x: p.x, z: p.z, hue: p.hue, age: 60 + ageDays * 120 });
    }

    this.bind();
  }

  private bind(): void {
    const el = this.engine.canvas;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKey);
    // Right-click has no meaning here and the context menu breaks immersion.
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // -----------------------------------------------------------------------
  // Ground picking
  // -----------------------------------------------------------------------

  /**
   * March the view ray against the height field. Coarse steps until the ray
   * passes below the ground, then a short binary refine — accurate to a few
   * centimetres and far cheaper than a mesh raycast.
   */
  private pickGround(clientX: number, clientY: number, out: THREE.Vector3): boolean {
    const rect = this.engine.canvas.getBoundingClientRect();
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const cam = this.engine.camera;
    this.tmp.set(this.ndc.x, this.ndc.y, 0.5).unproject(cam);
    this.ray.origin.copy(cam.position);
    this.ray.direction.copy(this.tmp).sub(cam.position).normalize();

    // Looking up: nothing to hit.
    if (this.ray.direction.y > -0.001 && cam.position.y > terrainHeight(cam.position.x, cam.position.z)) {
      return false;
    }

    const maxDist = 320;
    let prevT = 0;
    let prevAbove = true;
    const step = 0.6;
    for (let t = step; t < maxDist; t += Math.max(step, t * 0.045)) {
      out.copy(this.ray.origin).addScaledVector(this.ray.direction, t);
      const above = out.y > terrainHeight(out.x, out.z);
      if (!above && prevAbove) {
        // Refine between prevT and t.
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 14; i++) {
          const mid = (lo + hi) * 0.5;
          out.copy(this.ray.origin).addScaledVector(this.ray.direction, mid);
          if (out.y > terrainHeight(out.x, out.z)) lo = mid;
          else hi = mid;
        }
        out.copy(this.ray.origin).addScaledVector(this.ray.direction, (lo + hi) * 0.5);
        out.y = terrainHeight(out.x, out.z);
        return true;
      }
      prevAbove = above;
      prevT = t;
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Pointer
  // -----------------------------------------------------------------------

  private onDown = (e: PointerEvent): void => {
    if (this.suspended) return;
    this.activePointers.set(e.pointerId, new THREE.Vector2(e.clientX, e.clientY));
    if (this.activePointers.size === 2) {
      const [a, b] = Array.from(this.activePointers.values());
      this.pinchDist = a.distanceTo(b);
      return;
    }
    this.pointerDown = true;
    this.moved = false;
    this.pressing = true;
    this.pressTime = 0;
    this.pressPoint.set(e.clientX, e.clientY);
    this.lastPointer.set(e.clientX, e.clientY);
    void this.audio.unlock();
  };

  private onMove = (e: PointerEvent): void => {
    if (this.suspended) return;
    const p = this.activePointers.get(e.pointerId);
    if (p) p.set(e.clientX, e.clientY);

    // --- Pinch to zoom ------------------------------------------------------
    if (this.activePointers.size === 2) {
      const [a, b] = Array.from(this.activePointers.values());
      const d = a.distanceTo(b);
      if (this.pinchDist > 0) this.camera.dolly((this.pinchDist - d) * 0.05);
      this.pinchDist = d;
      this.pressing = false;
      return;
    }

    if (this.pointerDown) {
      const dx = e.clientX - this.lastPointer.x;
      const dy = e.clientY - this.lastPointer.y;
      this.lastPointer.set(e.clientX, e.clientY);
      if (Math.hypot(e.clientX - this.pressPoint.x, e.clientY - this.pressPoint.y) > 9) {
        this.moved = true;
        this.pressing = false;
      }
      if (this.moved) {
        this.camera.look(-dx * 0.0042, -dy * 0.0030);
      }
    } else {
      // Hover: a tulip under the cursor leans toward it (easter egg 1).
      this.hasHover = this.pickGround(e.clientX, e.clientY, this.hover);
    }
  };

  private onUp = (e: PointerEvent): void => {
    this.activePointers.delete(e.pointerId);
    if (this.activePointers.size < 2) this.pinchDist = 0;
    if (!this.pointerDown || this.suspended) {
      this.pointerDown = false;
      this.pressing = false;
      return;
    }
    this.pointerDown = false;

    const wasLongPress = this.pressing && this.pressTime > 0.5;
    this.pressing = false;

    if (this.moved) {
      // A quick upward flick raises the camera (brief §51).
      const dy = e.clientY - this.pressPoint.y;
      const dx = e.clientX - this.pressPoint.x;
      if (dy < -110 && Math.abs(dx) < 90) this.camera.dolly(-4.5);
      return;
    }

    if (wasLongPress) {
      // Already handled continuously while held.
      return;
    }

    // --- Tap / click ---------------------------------------------------------
    const now = performance.now();
    // 400ms rather than the 300-ish a mouse double-click uses: a double *tap*
    // on a touchscreen is genuinely slower, and on a struggling device the
    // second tap can be delayed by a long frame.
    const isDouble = now - this.lastTapTime < 400 &&
      this.lastTapPos.distanceTo(this.pressPoint) < 44;
    this.lastTapTime = now;
    this.lastTapPos.copy(this.pressPoint);

    if (this.pickGround(e.clientX, e.clientY, this.tmp)) {
      if (isDouble) this.burst(this.tmp, 6.5, 0.9);
      else this.tap(this.tmp);
    } else if (this.shootingStarWindow > 0) {
      // Catching a shooting star (brief §19) — a rare, real secret.
      this.shootingStarWindow = 0;
      bus.emit('event:rare', { id: 'caught-star' });
      bus.emit('garden:bloom', { x: 0, z: 0, radius: 420, power: 1 });
      this.memory.discover('star', 'A Star, Caught');
      this.activity = 1;
    }
  };

  private onWheel = (e: WheelEvent): void => {
    if (this.suspended) return;
    e.preventDefault();
    this.camera.dolly(Math.sign(e.deltaY) * 1.4);
  };

  private onKey = (e: KeyboardEvent): void => {
    // Only the keys the experience actually uses; everything else passes through
    // to the browser so keyboard navigation of the settings panel still works.
    switch (e.key) {
      case 'ArrowLeft': this.camera.look(0.12, 0); break;
      case 'ArrowRight': this.camera.look(-0.12, 0); break;
      case 'ArrowUp': this.camera.look(0, 0.08); break;
      case 'ArrowDown': this.camera.look(0, -0.08); break;
      case '+': case '=': this.camera.dolly(-1.5); break;
      case '-': case '_': this.camera.dolly(1.5); break;
      default: return;
    }
    e.preventDefault();
  };

  // -----------------------------------------------------------------------
  // Intents
  // -----------------------------------------------------------------------

  /** A tap on the ground: touch a flower, or plant one where there is none. */
  private tap(p: THREE.Vector3): void {
    this.activity = 1;

    if (this.pond.contains(p.x, p.z)) {
      // Ripples, and nothing else. The water is not a button.
      bus.emit('garden:bloom', { x: p.x, z: p.z, radius: 3.5, power: 0.2 });
      return;
    }

    const rec = this.field.nearest(p.x, p.z, 0.55);
    if (rec) {
      // Touching a tulip lights it (brief §06) and may reveal a message.
      bus.emit('garden:bloom', { x: rec.x, z: rec.z, radius: 1.9, power: 0.75 });
      this.memory.addTouch();
      // A hidden melody, rarely (brief §48, egg 6).
      if (Math.random() < 0.16) this.audio.phrase(Math.floor(Math.random() * 5));
      bus.emit('garden:message', { text: '', x: rec.x, y: rec.y + rec.scale, z: rec.z });
      return;
    }

    this.plant(p.x, p.z);
  }

  /** Plant a tulip the visitor made (brief §35). It persists between visits. */
  plant(x: number, z: number): void {
    if (this.pond.contains(x, z)) return;
    const hue = Math.floor(Math.random() * 10);
    this.seeds.push({ x, z, hue, age: 0 });
    this.memory.plant({ x, z, hue, planted: Date.now() });
    this.memory.addBloom();
    bus.emit('garden:plant', { x, z });
    bus.emit('garden:bloom', { x, z, radius: 2.6, power: 0.5 });
    this.activity = 1;
  }

  /** A ripple of blooming outward from a point. */
  private burst(p: THREE.Vector3, radius: number, power: number): void {
    bus.emit('garden:bloom', { x: p.x, z: p.z, radius, power });
    this.memory.addBloom();
    this.activity = 1;
  }

  update(dt: number): void {
    this.activity = Math.max(0, this.activity - dt * 0.9);
    this.shootingStarWindow = Math.max(0, this.shootingStarWindow - dt);

    for (const s of this.seeds) s.age += dt;

    if (this.pressing) {
      this.pressTime += dt;
      // A long press sends a slow ripple through the tulips (brief §51).
      if (this.pressTime > 0.5) {
        if (this.pickGround(this.pressPoint.x, this.pressPoint.y, this.tmp)) {
          const r = clamp01((this.pressTime - 0.5) / 1.6) * 14;
          bus.emit('garden:bloom', { x: this.tmp.x, z: this.tmp.z, radius: r, power: 0.55 });
        }
        this.activity = 1;
      }
    }
  }

  /** Ground positions of the visitor's own tulips, for the field to bloom. */
  forEachSeed(fn: (x: number, z: number, growth: number) => void): void {
    for (const s of this.seeds) {
      // A seed takes about half a minute to become a flower.
      fn(s.x, s.z, clamp01(s.age / 28));
    }
  }

  dispose(): void {
    const el = this.engine.canvas;
    el.removeEventListener('pointerdown', this.onDown);
    el.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
    el.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKey);
  }
}

