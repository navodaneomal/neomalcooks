import * as THREE from 'three';
import type { Engine } from '../core/Engine';
import type { World } from '../world/World';
import type { Dancer } from '../systems/Dancer';
import type { CameraDirector } from '../systems/CameraDirector';
import type { Heart } from '../systems/Heart';
import type { Memory } from '../systems/Memory';
import type { AudioEngine } from '../systems/Audio';
import type { Interaction } from '../systems/Interaction';
import type { SecretTree } from '../world/SecretTree';
import type { Overlay } from '../ui/Overlay';
import { wait } from '../ui/Overlay';
import { GENESIS, AWAKEN, REVEAL, FINAL_LINES, SECRET_ENDING_LINES } from './CodePoem';
import { LANDMARKS, TREE, POND } from '../world/Landmarks';
import { bus } from '../core/Bus';
import { clamp01, easeInOutCubic, easeOutCubic, lerp } from '../core/MathUtils';

/**
 * The film (brief §08, §09, §28-§31, §37-§42).
 *
 * Written as one long async sequence rather than a state machine, because the
 * brief's arc really is linear: code, first tulip, the field waking, her, the
 * long middle where you are simply left alone, then the bloom, the reveal, and
 * the loop back to the beginning.
 *
 * Two things interrupt it. Idling for long enough enters DREAM MODE and returns
 * seamlessly. And the middle act — deliberately the longest by far — hands the
 * whole experience over to the visitor and only ends when it is ready to.
 *
 * Every await is guarded by a generation counter so a replay can cancel a
 * sequence mid-flight without leaving two directors fighting over the camera.
 */

export type Act =
  | 'genesis' | 'awakening' | 'living' | 'follow' | 'tree'
  | 'massBloom' | 'worldReveal' | 'codeReveal' | 'fourthWall' | 'secretEnding';

export class Director {
  act: Act = 'genesis';
  /** Incremented on replay; every await checks it and bails if it changed. */
  private generation = 0;
  /** 0..1 how far the awakening has spread, in world units. */
  private spawnRadius = -1;
  private spawnTarget = -1;
  private spawnSpeed = 0;

  /** Seconds since the visitor last did anything. */
  idle = 0;
  /** 0..1 dream-mode blend. */
  dream = 0;
  private dreaming = false;
  /** 0..1 the rewind effect. */
  reverse = 0;

  private engine: Engine;
  private world: World;
  private dancer: Dancer;
  private camera: CameraDirector;
  private heart: Heart;
  private memory: Memory;
  private audio: AudioEngine;
  private interaction: Interaction;
  private tree: SecretTree;
  private ui: Overlay;
  private tmp = new THREE.Vector3();

  constructor(
    engine: Engine, world: World, dancer: Dancer, camera: CameraDirector,
    heart: Heart, memory: Memory, audio: AudioEngine, interaction: Interaction,
    tree: SecretTree, ui: Overlay,
  ) {
    this.engine = engine;
    this.world = world;
    this.dancer = dancer;
    this.camera = camera;
    this.heart = heart;
    this.memory = memory;
    this.audio = audio;
    this.interaction = interaction;
    this.tree = tree;
    this.ui = ui;
  }

  /** Await that resolves false if the sequence has been superseded. */
  private async hold(ms: number): Promise<boolean> {
    const g = this.generation;
    await wait(ms);
    return g === this.generation;
  }

  private setAct(act: Act): void {
    this.act = act;
    bus.emit('act:change', { act });
  }

  /** Animate the awakening front outward. */
  private spread(to: number, seconds: number): void {
    this.spawnTarget = to;
    this.spawnSpeed = seconds > 0 ? Math.abs(to - this.spawnRadius) / seconds : Infinity;
  }

  // -----------------------------------------------------------------------
  // The sequence
  // -----------------------------------------------------------------------

  async run(): Promise<void> {
    const g = ++this.generation;
    const alive = (): boolean => g === this.generation;

    // ---- 01 GENESIS -------------------------------------------------------
    this.setAct('genesis');
    this.spawnRadius = -2;
    this.spawnTarget = -2;
    this.world.setSpawn(0, 0, -2, 1.2);
    this.dancer.revealTarget = 0;
    this.camera.scripted = true;
    this.camera.cut('genesis', true);
    this.engine.post.uFadeAmount.value = 1;
    this.ui.clearCode();
    this.ui.showCode(true);
    this.ui.setCursorVisible(true);

    if (!(await this.hold(900))) return;

    // The code writes itself, one line at a time, before anything exists.
    for (let i = 0; i < GENESIS.length; i++) {
      if (!alive()) return;
      this.ui.addCodeLine(GENESIS[i]);
      // Blank lines and comments land quickly; instructions take a beat.
      const line = GENESIS[i];
      const isPause = line.length === 0 || line[0][0] === 'comment';
      if (!(await this.hold(isPause ? 620 : 300 + Math.random() * 260))) return;

      // Light begins to leak in as the roots go down.
      if (i === 8) this.engine.post.uFadeAmount.value = 0.82;
      if (i === 14) {
        this.engine.post.uFadeAmount.value = 0.55;
        this.ui.showCode(false);   // the code slides aside; the world is arriving
        this.camera.cut('firstTulip');
      }
      if (i === 15) this.spread(0.55, 3.0);      // the stem
      if (i === 16) this.spread(0.9, 2.0);       // the leaves
      if (i === 18) {
        this.engine.post.uFadeAmount.value = 0.28;
        this.spread(1.4, 2.5);
      }
      // "// silence"
      if (i === 20 && !(await this.hold(1600))) return;
      // The three petals.
      if (i >= 22 && i <= 24) {
        this.world.openBias = (i - 21) * 0.3;
        if (!(await this.hold(500))) return;
      }
      if (i === 25) {
        this.world.openBias = 1;
        this.engine.post.uFadeAmount.value = 0.1;
      }
    }

    if (!alive()) return;
    this.engine.post.uFadeAmount.value = 0;
    // A pulse travels through the ground, and the world wakes up.
    bus.emit('garden:bloom', { x: 0, z: 0, radius: 6, power: 1 });
    this.heart.spark(1);
    if (!(await this.hold(1800))) return;

    // ---- 02 THE TULIP GARDEN WAKES UP -------------------------------------
    this.setAct('awakening');
    this.ui.clearCode();
    this.ui.showCode(false);
    this.camera.cut('awaken');
    this.world.openBias = 0.15;

    // Ten, then a hundred, then a thousand — in layers, watched, not spawned.
    const stages: [number, number, number][] = [
      [3.5, 2.6, 0], [9, 3.0, 1], [22, 3.4, 2], [55, 4.0, 3],
      [120, 5.0, 4], [260, 6.5, 5], [640, 8.0, -1],
    ];
    for (const [radius, secs, codeLine] of stages) {
      if (!alive()) return;
      this.spread(radius, secs);
      if (codeLine >= 0 && codeLine < AWAKEN.length) this.ui.addCodeLine(AWAKEN[codeLine]);
      bus.emit('garden:bloom', { x: 0, z: 0, radius: radius * 1.15, power: 0.5 });
      if (!(await this.hold(secs * 1000 * 0.75))) return;
    }

    for (let i = 6; i < AWAKEN.length; i++) {
      if (!alive()) return;
      this.ui.addCodeLine(AWAKEN[i]);
      if (!(await this.hold(700))) return;
    }

    if (!(await this.hold(1500))) return;
    this.ui.hideCode();
    this.ui.setCursorVisible(false);

    // She arrives once there is a world for her to be in.
    this.dancer.revealTarget = 1;
    this.dancer.setState('rest', true);
    if (!(await this.hold(2600))) return;
    this.dancer.setState('sway');

    // ---- 03 LIVING --------------------------------------------------------
    // The long middle. The camera director takes over, the visitor is left
    // alone, and nothing pushes them anywhere.
    this.setAct('living');
    this.camera.scripted = false;
    this.camera.cut('wide');
    this.world.openBias = 0;

    // Repeat visitors have already met the field; give them less preamble.
    const visits = this.memory.data.visits;
    const livingSeconds = visits <= 1 ? 210 : Math.max(120, 210 - visits * 16);
    if (!(await this.hold(livingSeconds * 1000))) return;

    // ---- 04 FOLLOW HER ----------------------------------------------------
    // No instruction, no marker. She simply starts walking, the tulips ahead
    // of her brighten, and the camera falls in behind.
    this.setAct('follow');
    this.camera.scripted = true;
    this.camera.cut('follow');
    this.dancer.walkTarget = new THREE.Vector3(TREE.x, 0, TREE.z);
    this.dancer.setState('walk');

    // She walks a long way; the world lights her path as she goes.
    for (let i = 0; i < 40; i++) {
      if (!alive()) return;
      const d = this.dancer.position.distanceTo(this.dancer.walkTarget!);
      if (d < 14) break;
      // Petals and light run ahead of her in the direction she is going.
      const ahead = this.tmp.set(
        this.dancer.position.x + Math.sin(this.dancer.facing) * 9,
        0,
        this.dancer.position.z + Math.cos(this.dancer.facing) * 9,
      );
      bus.emit('garden:bloom', { x: ahead.x, z: ahead.z, radius: 7, power: 0.4 });
      if (!(await this.hold(1400))) return;
    }

    // ---- 05 THE SECRET TREE -----------------------------------------------
    this.setAct('tree');
    this.camera.focusPoint = new THREE.Vector3(TREE.x, 0, TREE.z);
    this.camera.cut('tree');
    this.dancer.walkTarget = null;
    this.dancer.setState('look');
    this.memory.discover('tree', 'The Tree That Was Always There');
    if (!(await this.hold(9000))) return;

    this.dancer.setState('skyward');
    if (!(await this.hold(6000))) return;

    // ---- 06 THE MASS TULIP BLOOM ------------------------------------------
    this.setAct('massBloom');
    this.camera.focusPoint = null;
    this.dancer.walkTarget = null;
    this.dancer.setState('rest', false);
    this.camera.cut('lowAngle');

    // Everything stops. The wind, the music, the field.
    this.stillness = 1;
    if (!(await this.hold(3400))) return;

    this.dancer.setState('skyward');
    if (!(await this.hold(2600))) return;

    // One tiny tulip opens beside her.
    bus.emit('garden:bloom', {
      x: this.dancer.position.x + 0.8, z: this.dancer.position.z + 0.4,
      radius: 1.1, power: 1,
    });
    if (!(await this.hold(1500))) return;

    // Then the wave crosses the whole world.
    this.stillness = 0;
    this.camera.scripted = true;
    this.camera.cut('overhead');
    this.massBloomFrom.set(this.dancer.position.x, this.dancer.position.z);
    this.massBloom = 0.0001;
    this.camera.impulse(0.8);
    this.heart.spark(1);
    this.audio.phrase(0);
    if (!(await this.hold(6000))) return;

    // ---- 07 THE WORLD REVEAL ----------------------------------------------
    this.setAct('worldReveal');
    this.camera.cut('ascend');
    this.camera.ascent = 0;
    const ascendMs = 17000;
    const t0 = performance.now();
    while (performance.now() - t0 < ascendMs) {
      if (!alive()) return;
      this.camera.ascent = easeInOutCubic(clamp01((performance.now() - t0) / ascendMs));
      if (!(await this.hold(60))) return;
    }
    this.camera.ascent = 1;
    if (!(await this.hold(3200))) return;

    // ---- 08 THE CODE REVEAL -----------------------------------------------
    this.setAct('codeReveal');
    this.camera.cut('extremeWide');
    this.ui.clearCode();
    this.ui.showCode(true);
    this.ui.setCursorVisible(true);

    // The world turns back into the program that wrote it.
    for (let i = 0; i < REVEAL.length; i++) {
      if (!alive()) return;
      this.ui.addCodeLine(REVEAL[i]);
      this.dissolve = clamp01((i + 1) / REVEAL.length);
      if (!(await this.hold(REVEAL[i].length === 0 ? 500 : 900))) return;
    }
    if (!(await this.hold(1200))) return;

    this.engine.post.uFadeAmount.value = 1;
    this.ui.hideCode();
    if (!(await this.hold(1400))) return;

    // Two lines. Nothing else. The restraint is the point.
    await this.ui.title(FINAL_LINES[0], 2600, 'mono');
    if (!alive()) return;
    await this.ui.title(FINAL_LINES[1], 3200, 'mono soft');
    if (!alive()) return;

    // ---- 09 / 10 THE ENDING -----------------------------------------------
    const earned = this.memory.data.discovered.length;
    if (earned >= 4) {
      this.setAct('secretEnding');
      this.memory.data.sawEnding = true;
      this.memory.touch();
      await this.secretEnding();
      if (!alive()) return;
    }

    this.setAct('fourthWall');
    this.ui.setBlackout(true);
    if (!(await this.hold(1400))) return;
    await this.ui.fourthWall();
    if (!alive()) return;

    // And it begins again.
    this.ui.setBlackout(false);
    this.memory.save();
    void this.run();
  }

  /** The alternate ending, for a visitor who found enough (brief §42). */
  private async secretEnding(): Promise<void> {
    const g = this.generation;
    this.engine.post.uFadeAmount.value = 0;
    this.dissolve = 0;
    this.camera.scripted = true;
    this.camera.cut('toward', true);
    this.camera.focusPoint = this.dancer.position.clone();
    this.dancer.setState('walk', true);
    this.stillness = 1;

    if (g !== this.generation) return;
    await wait(5200);
    if (g !== this.generation) return;

    this.dancer.setState('reach');
    await wait(3000);
    if (g !== this.generation) return;

    // The tulip becomes light, and the light comes toward you.
    bus.emit('garden:bloom', {
      x: this.dancer.position.x, z: this.dancer.position.z, radius: 24, power: 1,
    });
    this.heart.spark(1);
    await wait(1800);
    if (g !== this.generation) return;

    (this.engine.post.uFadeColor.value as THREE.Color).setRGB(1, 0.96, 0.93);
    const t0 = performance.now();
    while (performance.now() - t0 < 2600) {
      if (g !== this.generation) return;
      this.engine.post.uFadeAmount.value = easeOutCubic(clamp01((performance.now() - t0) / 2600));
      await wait(50);
    }
    this.engine.post.uFadeAmount.value = 1;

    await this.ui.title(SECRET_ENDING_LINES[0], 3000, 'soft');
    if (g !== this.generation) return;
    await this.ui.title(SECRET_ENDING_LINES[1], 3400, 'soft');
    if (g !== this.generation) return;

    (this.engine.post.uFadeColor.value as THREE.Color).setRGB(0, 0, 0);
    this.engine.post.uFadeAmount.value = 1;
    this.stillness = 0;
  }

  /**
   * Abandon the film and hand over a fully-grown, fully-lit world.
   *
   * Used by the art-direction bench and by the production checks, which need to
   * look at the garden itself rather than at the sequence that builds it.
   */
  bench(): void {
    this.generation++;
    this.setAct('living');
    this.dissolve = 0;
    this.massBloom = -1;
    this.stillness = 0;
    this.reverse = 0;
    this.dreaming = false;
    this.dream = 0;
    this.spawnRadius = 900;
    this.spawnTarget = 900;
    this.world.setSpawn(0, 0, 900, 26);
    this.world.openBias = 0;
    this.world.uniforms.wave.uWaveStrength.value = 0;
    this.world.uniforms.wave.uWave2Strength.value = 0;
    this.dancer.revealTarget = 1;
    this.dancer.reveal = 1;
    // Park her at the heart of the garden. Left to herself she wanders, which
    // is right for the experience and useless for a fixed reference frame.
    this.dancer.position.set(0, 0, 0);
    this.dancer.walkTarget = null;
    this.dancer.facing = 0.6;
    this.dancer.setState('sway', true);
    this.camera.scripted = false;
    this.camera.focusPoint = null;
    // Leave the camera on a shot the viewer can actually push around. The
    // opening shot is deliberately locked, and bench() must not inherit that.
    this.camera.cut('orbit', true);
    this.engine.post.uFadeAmount.value = 0;
    this.engine.post.uLetterbox.value = 0;
    this.ui.hideCode();
    this.ui.setBlackout(false);
  }

  /** Start again from the first seed. Cancels whatever is in flight. */
  replay(): void {
    this.generation++;
    this.dissolve = 0;
    this.massBloom = -1;
    this.stillness = 0;
    this.dreaming = false;
    this.camera.focusPoint = null;
    (this.engine.post.uFadeColor.value as THREE.Color).setRGB(0, 0, 0);
    this.ui.setBlackout(false);
    void this.run();
  }

  // -----------------------------------------------------------------------
  // Per-frame
  // -----------------------------------------------------------------------

  /** 1 while the world is deliberately held still before the bloom. */
  stillness = 0;
  /** >= 0 while the mass bloom wave is expanding, in world units. */
  massBloom = -1;
  private massBloomFrom = new THREE.Vector2();
  /** 0..1 how far the world has dissolved back into code. */
  dissolve = 0;

  update(dt: number, activity: number): void {
    // --- The awakening front -------------------------------------------------
    if (this.spawnRadius !== this.spawnTarget) {
      const dir = Math.sign(this.spawnTarget - this.spawnRadius);
      this.spawnRadius += dir * this.spawnSpeed * dt;
      if ((dir > 0 && this.spawnRadius > this.spawnTarget) ||
          (dir < 0 && this.spawnRadius < this.spawnTarget)) {
        this.spawnRadius = this.spawnTarget;
      }
      // Widen the front as it spreads so it never looks like a hard circle.
      this.world.setSpawn(0, 0, this.spawnRadius, lerp(1.2, 26, clamp01(this.spawnRadius / 300)));
    }

    // --- The mass bloom ------------------------------------------------------
    if (this.massBloom >= 0) {
      this.massBloom += dt * 95;
      const u = this.world.uniforms.wave;
      (u.uWave.value as THREE.Vector4).set(
        this.massBloomFrom.x, this.massBloomFrom.y, this.massBloom, 44);
      u.uWaveStrength.value = clamp01(1 - this.massBloom / 900);
      if (this.massBloom > 900) {
        this.massBloom = -1;
        u.uWaveStrength.value = 0;
      }
    }

    // --- Dream mode (brief §31) ----------------------------------------------
    this.idle = activity > 0.01 ? 0 : this.idle + dt;
    const wantsDream = this.act === 'living' && this.idle > 95;
    if (wantsDream && !this.dreaming) {
      this.dreaming = true;
      this.camera.cut('orbit');
    } else if (!wantsDream && this.dreaming && this.idle < 2) {
      this.dreaming = false;
    }
    // Enter slowly, leave quickly — waking should be immediate.
    const rate = this.dreaming ? 0.10 : 1.1;
    this.dream += (Number(this.dreaming) - this.dream) * (1 - Math.exp(-rate * dt));
    this.world.uniforms.mood.uDream.value = this.dream;
    this.engine.post.uDream.value = this.dream;

    // --- The rewind ----------------------------------------------------------
    this.world.uniforms.mood.uReverse.value = this.reverse;
    this.engine.post.uReverse.value = this.reverse;

    // --- The world dissolving into code --------------------------------------
    if (this.dissolve > 0) {
      // Fade the world out under the code rather than cutting to it.
      this.engine.post.uFadeAmount.value = Math.max(
        this.engine.post.uFadeAmount.value as number, this.dissolve * 0.92);
    }
  }

  /** Touching THE FIRST TULIP rewinds the world (brief §30). */
  async rewind(): Promise<void> {
    const g = this.generation;
    this.memory.discover('firstTulip', 'The First Tulip');
    const from = this.spawnRadius;
    const t0 = performance.now();
    const ms = 6000;
    while (performance.now() - t0 < ms) {
      if (g !== this.generation) return;
      const k = clamp01((performance.now() - t0) / ms);
      this.reverse = Math.sin(k * Math.PI);
      this.spawnRadius = lerp(from, 1.2, easeInOutCubic(k));
      this.spawnTarget = this.spawnRadius;
      this.world.setSpawn(0, 0, this.spawnRadius, lerp(26, 1.2, k));
      await wait(40);
    }
    if (g !== this.generation) return;
    // And then it grows back.
    this.reverse = 0;
    this.spread(from, 8);
    this.ui.clearCode();
    this.ui.showCode(false);
    for (const line of GENESIS.slice(0, 6)) {
      if (g !== this.generation) return;
      this.ui.addCodeLine(line);
      await wait(420);
    }
    await wait(2200);
    if (g !== this.generation) return;
    this.ui.hideCode();
  }

  /** Called when a landmark is entered, so discoveries are real. */
  checkDiscoveries(x: number, z: number, night: number): void {
    for (const lm of LANDMARKS) {
      if (!lm.secret || this.memory.has(lm.id)) continue;
      if (lm.requires === 'night' && night < 0.6) continue;
      if (Math.hypot(x - lm.x, z - lm.z) > lm.radius) continue;
      this.memory.discover(lm.id, lm.label);
      this.heart.spark(0.8);
    }
    // The pond has its own rim.
    if (!this.memory.has('pond') && Math.hypot(x - POND.x, z - POND.z) < POND.radius + POND.rim) {
      this.memory.discover('pond', 'The Mirror Pond');
    }
  }

  /** Proximity of the visitor to the tree, for its slow illumination. */
  treeDistance(x: number, z: number): number {
    return Math.hypot(x - TREE.x, z - TREE.z);
  }

  get interactionRef(): Interaction {
    return this.interaction;
  }

  get treeRef(): SecretTree {
    return this.tree;
  }
}
