import * as THREE from 'three';
import { HERO_VERTEX, HERO_BODY_FRAGMENT, HERO_GLOW_FRAGMENT } from '../shaders/heroTulip';
import { buildHeroTulipGeometry, type HeroLod } from './HeroTulipGeometry';
import type { WorldUniforms } from '../core/WorldUniforms';
import type { QualitySettings } from '../core/Quality';
import { srgb } from '../core/Colors';
import { terrainHeight } from './Terrain';
import { clamp01, damp } from '../core/MathUtils';

/**
 * The luminous tulips — the flower from the reference, as a real object.
 *
 * There are only ever a handful, so each one can afford to be expensive: the
 * first tulip of the genesis sequence, the one hidden on the tree, and the rare
 * magical flowers the brief scatters through the field. They share one
 * instanced draw and are drawn twice — a body pass that owns depth, and an
 * additive pass that lays the light over it.
 */

export interface HeroSlot {
  active: boolean;
  x: number;
  z: number;
  y: number;
  rotY: number;
  scale: number;
  /** 0 = tight bud, 1 = fully open, above 1 = splayed for the climax. */
  open: number;
  openTarget: number;
  /** How much light it carries. */
  glow: number;
  glowTarget: number;
  /** 0..1 how much of it exists — used to grow the first tulip from nothing. */
  reveal: number;
  revealTarget: number;
  hueShift: number;
  core: number;
  seed: number;
}

export class HeroTulip {
  readonly group = new THREE.Group();
  readonly bodyMaterial: THREE.ShaderMaterial;
  readonly glowMaterial: THREE.ShaderMaterial;
  readonly slots: HeroSlot[] = [];

  private bodyMesh: THREE.Mesh;
  private glowMesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private base: THREE.BufferGeometry;
  private instA: Float32Array;
  private instB: Float32Array;
  private instC: Float32Array;
  private attrA: THREE.InstancedBufferAttribute;
  private attrB: THREE.InstancedBufferAttribute;
  private attrC: THREE.InstancedBufferAttribute;
  private bounds = new THREE.Sphere(new THREE.Vector3(), 1);

  constructor(uniforms: WorldUniforms, settings: QualitySettings, capacity = 24) {
    const lod: HeroLod = settings.tier === 'performance' ? 'mid' : 'high';
    this.base = buildHeroTulipGeometry(lod);

    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = this.base.getIndex();
    this.geo.setAttribute('position', this.base.getAttribute('position'));
    this.geo.setAttribute('normal', this.base.getAttribute('normal'));
    this.geo.setAttribute('aFlags', this.base.getAttribute('aFlags'));
    this.geo.setAttribute('aShape', this.base.getAttribute('aShape'));

    this.instA = new Float32Array(capacity * 4);
    this.instB = new Float32Array(capacity * 4);
    this.instC = new Float32Array(capacity * 4);
    this.attrA = new THREE.InstancedBufferAttribute(this.instA, 4);
    this.attrB = new THREE.InstancedBufferAttribute(this.instB, 4);
    this.attrC = new THREE.InstancedBufferAttribute(this.instC, 4);
    for (const a of [this.attrA, this.attrB, this.attrC]) a.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aInstA', this.attrA);
    this.geo.setAttribute('aInstB', this.attrB);
    this.geo.setAttribute('aInstC', this.attrC);
    this.geo.instanceCount = 0;
    this.geo.boundingSphere = this.bounds;

    for (let i = 0; i < capacity; i++) {
      this.slots.push({
        active: false, x: 0, z: 0, y: 0, rotY: 0, scale: 1,
        open: 0, openTarget: 0, glow: 0, glowTarget: 0,
        reveal: 0, revealTarget: 0, hueShift: 0, core: 0, seed: Math.random() * 1000,
      });
    }

    // Palette read straight off the reference: gold at the throat, rose at the
    // point, white-hot core, gold rim.
    const shared = {
      uThroat: { value: srgb(0xffbe72) },
      uMid: { value: srgb(0xf58cb2) },
      uTip: { value: srgb(0xcf5590) },
      uRim: { value: srgb(0xffc270) },
      uCoreColor: { value: srgb(0xfff0d2) },
      uLeafColor: { value: srgb(0x6b7f56) },
      uIridescence: { value: settings.tier === 'performance' ? 0.25 : 0.55 },
      uSparkle: { value: settings.tier === 'performance' ? 0.0 : 1.0 },
      uOpenBias: { value: 0 },
      uReveal: { value: 1 },
    };

    this.bodyMaterial = new THREE.ShaderMaterial({
      vertexShader: HERO_VERTEX,
      fragmentShader: HERO_BODY_FRAGMENT,
      uniforms: uniforms.organic({ ...shared }),
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: true,
      depthTest: true,
    });

    this.glowMaterial = new THREE.ShaderMaterial({
      vertexShader: HERO_VERTEX,
      fragmentShader: HERO_GLOW_FRAGMENT,
      // The two passes must agree on every shared value or the light would
      // drift off the body it belongs to.
      uniforms: uniforms.organic({
        ...shared,
        uThroat: shared.uThroat, uMid: shared.uMid, uTip: shared.uTip,
        uRim: shared.uRim, uCoreColor: shared.uCoreColor,
        uLeafColor: shared.uLeafColor,
        uIridescence: shared.uIridescence, uSparkle: shared.uSparkle,
        uOpenBias: shared.uOpenBias, uReveal: shared.uReveal,
      }),
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });

    this.bodyMesh = new THREE.Mesh(this.geo, this.bodyMaterial);
    this.bodyMesh.name = 'HeroTulipBody';
    this.bodyMesh.frustumCulled = false;
    this.bodyMesh.renderOrder = 10;

    this.glowMesh = new THREE.Mesh(this.geo, this.glowMaterial);
    this.glowMesh.name = 'HeroTulipGlow';
    this.glowMesh.frustumCulled = false;
    this.glowMesh.renderOrder = 11;

    this.group.add(this.bodyMesh, this.glowMesh);
    this.group.name = 'HeroTulips';
  }

  /** Claim a slot. Returns its index, or -1 if all are taken. */
  spawn(opts: {
    x: number; z: number; y?: number; scale?: number; open?: number;
    glow?: number; hueShift?: number; core?: number; rotY?: number;
    instant?: boolean;
  }): number {
    const i = this.slots.findIndex((s) => !s.active);
    if (i < 0) return -1;
    const s = this.slots[i];
    s.active = true;
    s.x = opts.x;
    s.z = opts.z;
    s.y = opts.y ?? terrainHeight(opts.x, opts.z);
    s.rotY = opts.rotY ?? Math.random() * Math.PI * 2;
    s.scale = opts.scale ?? 1;
    s.openTarget = opts.open ?? 0.85;
    s.glowTarget = opts.glow ?? 0.8;
    s.hueShift = opts.hueShift ?? 0;
    s.core = opts.core ?? 0.5;
    s.revealTarget = 1;
    if (opts.instant) {
      s.open = s.openTarget;
      s.glow = s.glowTarget;
      s.reveal = 1;
    } else {
      s.open = 0;
      s.glow = 0;
      s.reveal = 0;
    }
    return i;
  }

  get(i: number): HeroSlot | null {
    return i >= 0 && i < this.slots.length ? this.slots[i] : null;
  }

  release(i: number): void {
    const s = this.get(i);
    if (s) {
      s.revealTarget = 0;
      s.glowTarget = 0;
      s.openTarget = 0;
    }
  }

  /** Global bias, used by the genesis sequence to open petals one at a time. */
  set openBias(v: number) {
    this.bodyMaterial.uniforms.uOpenBias.value = v;
    this.glowMaterial.uniforms.uOpenBias.value = v;
  }

  update(dt: number): void {
    let n = 0;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let maxY = -Infinity, minY = Infinity;

    for (const s of this.slots) {
      if (!s.active) continue;

      s.reveal = damp(s.reveal, s.revealTarget, 0.9, dt);
      // Opening is slow and deliberate: this flower is meant to be watched.
      s.open = damp(s.open, s.openTarget, 0.55, dt);
      s.glow = damp(s.glow, s.glowTarget, 1.1, dt);

      if (s.revealTarget <= 0 && s.reveal < 0.01) {
        s.active = false;
        continue;
      }

      const o = n * 4;
      this.instA[o] = s.x;
      this.instA[o + 1] = s.y;
      this.instA[o + 2] = s.z;
      this.instA[o + 3] = s.rotY;
      this.instB[o] = s.scale;
      this.instB[o + 1] = s.open;
      this.instB[o + 2] = s.glow;
      this.instB[o + 3] = s.seed;
      this.instC[o] = s.hueShift;
      this.instC[o + 1] = s.core;
      this.instC[o + 2] = 0;
      this.instC[o + 3] = 0;

      const r = s.scale * 0.8;
      minX = Math.min(minX, s.x - r); maxX = Math.max(maxX, s.x + r);
      minZ = Math.min(minZ, s.z - r); maxZ = Math.max(maxZ, s.z + r);
      minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y + s.scale * 1.3);
      n++;
    }

    this.geo.instanceCount = n;
    const visible = n > 0;
    this.bodyMesh.visible = visible;
    this.glowMesh.visible = visible;
    if (!visible) return;

    this.attrA.needsUpdate = true;
    this.attrB.needsUpdate = true;
    this.attrC.needsUpdate = true;

    this.bounds.center.set((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
    this.bounds.radius = Math.max(
      Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.5 + 1, 1);
  }

  /** Brightest active flower, so the camera and the bloom know where to look. */
  brightest(out: THREE.Vector3): number {
    let best = -1;
    let bestSlot: HeroSlot | null = null;
    for (const s of this.slots) {
      if (!s.active) continue;
      const v = s.glow * s.reveal;
      if (v > best) { best = v; bestSlot = s; }
    }
    if (bestSlot) out.set(bestSlot.x, bestSlot.y + bestSlot.scale * 0.85, bestSlot.z);
    return clamp01(best);
  }

  dispose(): void {
    this.geo.dispose();
    this.base.dispose();
    this.bodyMaterial.dispose();
    this.glowMaterial.dispose();
  }
}
