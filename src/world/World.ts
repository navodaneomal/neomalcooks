import * as THREE from 'three';
import type { Engine } from '../core/Engine';
import type { Quality, TierName } from '../core/Quality';
import { WorldUniforms } from '../core/WorldUniforms';
import { Sky } from './Sky';
import { Ground } from './Ground';
import { TulipField } from './TulipField';
import { GrassField } from './GrassField';
import { MoteField, PetalDrift, Rain } from './Particles';
import { Pond } from './Pond';
import { SecretTree } from './SecretTree';
import { Wildlife } from './Wildlife';
import { Fireflies } from './Fireflies';
import { Meteors } from './Meteors';
import { paletteUniformArrays } from './Palette';
import { bus } from '../core/Bus';

/**
 * Owns every piece of the scene and the shared uniform graph.
 *
 * Density-dependent pieces are rebuilt when the quality tier changes, which is
 * what makes the settings panel's quality control a real control rather than a
 * label. Anything the narrative needs to reach into the shaders — how far the
 * world has been brought into existence, how open the flowers are — goes
 * through here so no other system has to know a shader exists.
 */
export class World {
  readonly uniforms = new WorldUniforms();
  /**
   * Persistent root. Things that are *not* rebuilt on a quality change — the
   * dancer, above all — attach here and survive.
   */
  readonly group = new THREE.Group();
  /**
   * Everything the world rebuilds when the tier changes. Kept as its own child
   * so a rebuild can empty it without taking anything else with it: clearing
   * the root instead silently deletes whatever else had been attached, which
   * is exactly the kind of bug that only shows up when someone touches the
   * quality setting.
   */
  private content = new THREE.Group();

  sky!: Sky;
  ground!: Ground;
  tulips!: TulipField;
  grass!: GrassField;
  motes!: MoteField;
  petals!: PetalDrift;
  rain!: Rain;
  pond!: Pond;
  tree!: SecretTree;
  wildlife!: Wildlife;
  fireflies!: Fireflies;
  meteors!: Meteors;

  private engine: Engine;
  private quality: Quality;
  /** One seed for the whole world, so a rebuild reproduces the same garden. */
  private seed = 20240501;

  constructor(engine: Engine, quality: Quality) {
    this.engine = engine;
    this.quality = quality;
    this.group.name = 'World';
    this.content.name = 'WorldContent';
    this.group.add(this.content);
    engine.scene.add(this.group);
    this.build();
  }

  private build(): void {
    const s = this.quality.settings;
    const palette = paletteUniformArrays();

    this.sky = new Sky(this.uniforms, s);
    this.ground = new Ground(this.uniforms, s);
    this.tulips = new TulipField(this.uniforms, s, this.seed);
    this.grass = new GrassField(this.uniforms, s, this.seed ^ 0x5eed);
    this.motes = new MoteField(this.uniforms, s, this.seed ^ 0x11);
    this.petals = new PetalDrift(this.uniforms, s, palette.tip, this.seed ^ 0x22);
    this.rain = new Rain(this.uniforms, s, this.seed ^ 0x33);
    this.pond = new Pond(this.uniforms, this.sky);
    this.tree = new SecretTree(this.uniforms, s, this.seed ^ 0x44);
    this.wildlife = new Wildlife(this.uniforms, s, this.tulips, this.seed ^ 0x55);
    this.fireflies = new Fireflies(this.uniforms, s, this.seed ^ 0x66);
    this.meteors = new Meteors(this.uniforms, s.tier === 'performance' ? 4 : 7, this.seed ^ 0x77);

    this.content.add(
      this.sky.mesh, this.ground.mesh, this.tulips.group, this.grass.mesh,
      this.pond.mesh, this.tree.group, this.wildlife.mesh,
      this.motes.points, this.petals.mesh, this.rain.mesh,
      this.fireflies.points, this.meteors.mesh,
    );

    this.uniforms.quality.uDetail.value = s.detail;
    this.uniforms.quality.uViewFar.value = s.viewDistance;
    this.applyOpenBias();
    this.applySpawn();
  }

  /**
   * Rebuild the density-dependent world at a new tier.
   *
   * Listeners registered through `onRebuild` are called afterwards so anything
   * holding a reference into the old world (the dancer looks up nearby tulips)
   * can re-point at the new one instead of quietly pointing at freed geometry.
   */
  setTier(tier: TierName): void {
    if (tier === this.quality.tier) return;
    this.content.clear();
    this.disposeParts();

    this.quality.setTier(tier);
    this.engine.applyQuality();
    this.build();

    for (const fn of this.rebuildListeners) fn();
    bus.emit('quality:change', { tier });
  }

  private rebuildListeners: (() => void)[] = [];

  /** Called after every rebuild, so external references can be refreshed. */
  onRebuild(fn: () => void): void {
    this.rebuildListeners.push(fn);
  }

  // --- Narrative hooks ------------------------------------------------------

  private _openBias = 0;

  /**
   * Pushes every flower toward open (or closed, if negative), on top of
   * whatever it would do on its own. The genesis sequence uses it to open the
   * very first tulip petal by petal.
   */
  get openBias(): number {
    return this._openBias;
  }

  set openBias(v: number) {
    this._openBias = v;
    this.applyOpenBias();
  }

  private applyOpenBias(): void {
    const u = this.tulips.material.uniforms.uOpenBias;
    if (u) u.value = this._openBias;
  }

  private spawnRadius = -1;
  private spawnOrigin = new THREE.Vector2(0, 0);
  private spawnWidth = 14;

  /** How far the world has been brought into existence, from `origin`. */
  setSpawn(originX: number, originZ: number, radius: number, width = 14): void {
    this.spawnRadius = radius;
    this.spawnOrigin.set(originX, originZ);
    this.spawnWidth = width;
    this.applySpawn();
  }

  private applySpawn(): void {
    for (const m of [
      this.tulips.material, this.ground.material, this.grass.material,
    ]) {
      const u = m.uniforms;
      if (u.uSpawnRadius) u.uSpawnRadius.value = this.spawnRadius;
      if (u.uSpawnOrigin) (u.uSpawnOrigin.value as THREE.Vector2).copy(this.spawnOrigin);
      if (u.uSpawnWidth) u.uSpawnWidth.value = this.spawnWidth;
    }
    // Nothing lives in a world that does not exist yet.
    const born = this.spawnRadius > 2;
    this.wildlife.mesh.visible = born;
    this.petals.mesh.visible = born;
  }

  get awakening(): number {
    return this.spawnRadius;
  }

  /** Global visibility of the drifting air, dimmed during the quiet beats. */
  setAirAmount(motes: number, petals: number): void {
    this.motes.material.uniforms.uAmount.value = motes;
    this.petals.material.uniforms.uAmount.value = petals;
  }

  /** Where she is, so the petals she trails start at her feet. */
  setHer(pos: THREE.Vector3, wind: number): void {
    for (const m of [this.motes.material, this.petals.material, this.rain.material]) {
      (m.uniforms.uHerPos.value as THREE.Vector3).copy(pos);
      m.uniforms.uHerWind.value = wind;
    }
  }

  update(dt: number, camera: THREE.PerspectiveCamera, ctx: {
    night: number; rain: number; pixelRatio: number;
  }): void {
    this.sky.update(camera);
    this.tulips.update(camera);
    this.grass.update(camera);
    this.motes.update(camera, ctx.pixelRatio);
    this.petals.update(camera);
    this.rain.update(camera, ctx.rain);
    this.pond.update(ctx.rain);
    this.tree.update(dt);
    this.wildlife.night = ctx.night;
    this.wildlife.rain = ctx.rain;
    this.wildlife.update(dt, camera);
    this.fireflies.setPixelRatio(ctx.pixelRatio);
    this.fireflies.update(dt, camera, ctx.night);
    this.meteors.update(dt, camera, ctx.night);
  }

  private disposeParts(): void {
    this.sky.dispose();
    this.ground.dispose();
    this.tulips.dispose();
    this.grass.dispose();
    this.motes.dispose();
    this.petals.dispose();
    this.rain.dispose();
    this.pond.dispose();
    this.tree.dispose();
    this.wildlife.dispose();
    this.fireflies.dispose();
    this.meteors.dispose();
  }

  dispose(): void {
    this.disposeParts();
  }
}
