import * as THREE from 'three';
import type { WorldUniforms } from '../core/WorldUniforms';
import type { QualitySettings } from '../core/Quality';
import { terrainHeight } from './Terrain';
import { srgb } from '../core/Colors';
import { bus } from '../core/Bus';
import { clamp01, damp, makeRandom, type Rng, TAU } from '../core/MathUtils';

/**
 * Fireflies, and the constellations they occasionally make (brief §18).
 *
 * Simulated on the CPU because the interesting part is not the drifting — it is
 * the moment when a hundred independent wanderers quietly agree on a shape,
 * hold it for a few seconds, and then forget it again. Each fly keeps its own
 * wander target and a slot in whatever formation is currently being attempted,
 * and a single blend value decides how much it cares about the formation
 * versus its own business. Ramping that blend up and back down is the whole
 * effect; nothing teleports, so the shape assembles and dissolves.
 */

type ShapeName = 'tulip' | 'spiral' | 'butterfly' | 'constellation' | 'bloom';

const SHAPES: ShapeName[] = ['tulip', 'spiral', 'butterfly', 'constellation', 'bloom'];

interface Fly {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  home: THREE.Vector3;
  slot: THREE.Vector3;
  phase: number;
  rate: number;
  bright: number;
  seed: number;
}

const FF_VERTEX = /* glsl */ `
precision highp float;
attribute float aBright;
uniform float uPixelRatio;
uniform float uNight;
varying float vBright;
void main() {
  vBright = aBright;
  vec4 mv = viewMatrix * modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uPixelRatio * (1.6 + aBright * 4.0) * (34.0 / max(-mv.z, 0.6)), 1.0, 26.0);
}
`;

const FF_FRAGMENT = /* glsl */ `
precision highp float;
uniform vec3 uColor;
varying float vBright;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  // A hot core inside a soft halo.
  float core = 1.0 - smoothstep(0.0, 0.045, r2);
  float halo = 1.0 - smoothstep(0.0, 0.25, r2);
  float a = vBright * (core * 0.85 + halo * halo * 0.5);
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor * (0.7 + core * 1.5), a);
}
`;

export class Fireflies {
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;

  private flies: Fly[] = [];
  private positions: Float32Array;
  private brights: Float32Array;
  private posAttr: THREE.BufferAttribute;
  private brightAttr: THREE.BufferAttribute;
  private rng: Rng;

  /** 0..1 how present they are — driven by night. */
  presence = 0;
  /** 0..1 how strongly the current formation is being held. */
  private formation = 0;
  private formationTarget = 0;
  private cooldown = 40;
  private holding = 0;
  private centre = new THREE.Vector3();
  private shape: ShapeName = 'tulip';

  private focus = new THREE.Vector3();

  constructor(uniforms: WorldUniforms, settings: QualitySettings, seed = 271828) {
    this.rng = makeRandom(seed);
    const n = settings.fireflies;

    this.positions = new Float32Array(n * 3);
    this.brights = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const a = this.rng() * TAU;
      const r = 4 + this.rng() * 30;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const f: Fly = {
        pos: new THREE.Vector3(x, terrainHeight(x, z) + 0.3 + this.rng() * 2.2, z),
        vel: new THREE.Vector3(),
        home: new THREE.Vector3(x, 0, z),
        slot: new THREE.Vector3(),
        phase: this.rng() * TAU,
        rate: 0.6 + this.rng() * 2.4,
        bright: 0,
        seed: this.rng() * 1000,
      };
      this.flies.push(f);
    }

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.brightAttr = new THREE.BufferAttribute(this.brights, 1);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.brightAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aBright', this.brightAttr);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      vertexShader: FF_VERTEX,
      fragmentShader: FF_FRAGMENT,
      uniforms: {
        uPixelRatio: { value: 1 },
        uNight: uniforms.mood.uNight,
        uColor: { value: srgb(0xffe08a) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.name = 'Fireflies';
    this.points.frustumCulled = false;
    this.points.renderOrder = 9;
  }

  /**
   * Where a fly should sit in the current shape. Parameterised on 0..1 so the
   * same code lays out every formation.
   */
  private slotFor(shape: ShapeName, u: number, seed: number, out: THREE.Vector3): void {
    const R = 7.5;
    switch (shape) {
      case 'tulip': {
        // The six-lobed rosette, seen face-on: the garden's own emblem.
        const th = u * TAU;
        const lobe = 0.55 + 0.45 * Math.abs(Math.cos(3 * th));
        const rr = lobe * R * (0.55 + 0.45 * ((seed % 17) / 17));
        out.set(Math.cos(th) * rr, 3.2 + Math.sin(th * 3) * 0.9, Math.sin(th) * rr);
        break;
      }
      case 'spiral': {
        const turns = 2.6;
        const th = u * TAU * turns;
        const rr = u * R;
        out.set(Math.cos(th) * rr, 1.6 + u * 4.5, Math.sin(th) * rr);
        break;
      }
      case 'butterfly': {
        // The classic butterfly curve, laid into the vertical plane.
        const th = u * TAU;
        const r = Math.exp(Math.cos(th)) - 2 * Math.cos(4 * th) + Math.pow(Math.sin(th / 12), 5);
        out.set(Math.sin(th) * r * 1.5, 3.4 + Math.cos(th) * r * 1.2, ((seed % 11) / 11 - 0.5) * 1.2);
        break;
      }
      case 'constellation': {
        // Sparse bright nodes with the rest strung faintly between them: what a
        // constellation actually looks like.
        const nodes = 7;
        const k = Math.floor(u * nodes);
        const frac = u * nodes - k;
        const ax = Math.cos(k * 2.399) * R * 0.9;
        const ay = 2.4 + Math.sin(k * 1.71) * 3.4;
        const bx = Math.cos((k + 1) * 2.399) * R * 0.9;
        const by = 2.4 + Math.sin((k + 1) * 1.71) * 3.4;
        out.set(ax + (bx - ax) * frac, ay + (by - ay) * frac, Math.sin(k * 3.1) * 2.0);
        break;
      }
      case 'bloom':
      default: {
        const th = u * TAU * 5;
        const rr = Math.sqrt(u) * R;
        out.set(Math.cos(th) * rr, 1.2 + Math.sin(u * Math.PI) * 3.6, Math.sin(th) * rr);
        break;
      }
    }
  }

  update(dt: number, camera: THREE.Camera, night: number): void {
    this.focus.copy(camera.position);
    this.presence = damp(this.presence, clamp01((night - 0.25) * 1.8), 0.6, dt);

    // --- Decide whether to attempt a formation ------------------------------
    this.cooldown -= dt;
    if (this.formationTarget <= 0 && this.cooldown <= 0 && this.presence > 0.6) {
      // Uncommon, and never on a predictable beat.
      if (this.rng() < 0.35) {
        this.shape = SHAPES[Math.floor(this.rng() * SHAPES.length)];
        this.formationTarget = 1;
        this.holding = 4.5 + this.rng() * 4;
        const a = this.rng() * TAU;
        const r = 10 + this.rng() * 12;
        this.centre.set(this.focus.x + Math.cos(a) * r, 0, this.focus.z + Math.sin(a) * r);
        this.centre.y = terrainHeight(this.centre.x, this.centre.z);
        for (let i = 0; i < this.flies.length; i++) {
          this.slotFor(this.shape, i / this.flies.length, this.flies[i].seed, this.flies[i].slot);
        }
        bus.emit('event:rare', { id: `firefly-${this.shape}` });
      }
      this.cooldown = 30 + this.rng() * 60;
    }

    if (this.formationTarget > 0) {
      this.holding -= dt;
      if (this.holding <= 0) this.formationTarget = 0;
    }
    // Assemble slowly, dissolve a little faster — like a held breath let go.
    this.formation = damp(this.formation, this.formationTarget,
      this.formationTarget > this.formation ? 0.5 : 0.75, dt);

    // --- Simulate -----------------------------------------------------------
    const t = performance.now() * 0.001;
    const n = this.flies.length;
    for (let i = 0; i < n; i++) {
      const f = this.flies[i];

      // Fireflies stay near the viewer, drifting home when they get too far.
      const dx = f.pos.x - this.focus.x;
      const dz = f.pos.z - this.focus.z;
      if (dx * dx + dz * dz > 46 * 46) {
        const a = this.rng() * TAU;
        const r = 8 + this.rng() * 20;
        f.pos.set(this.focus.x + Math.cos(a) * r, 0, this.focus.z + Math.sin(a) * r);
        f.pos.y = terrainHeight(f.pos.x, f.pos.z) + 0.4 + this.rng() * 2;
      }

      // Wander: a slow lissajous, unique per fly.
      const wx = Math.sin(t * 0.42 + f.seed) * 1.4 + Math.sin(t * 0.17 + f.seed * 2.3) * 2.4;
      const wy = Math.sin(t * 0.63 + f.seed * 1.7) * 0.5;
      const wz = Math.cos(t * 0.37 + f.seed * 1.3) * 1.4 + Math.cos(t * 0.21 + f.seed * 3.1) * 2.4;

      const ground = terrainHeight(f.pos.x, f.pos.z);
      const wanderX = f.pos.x + wx * dt * 2.2;
      const wanderZ = f.pos.z + wz * dt * 2.2;
      let targetY = ground + 0.5 + (1 + Math.sin(t * 0.3 + f.seed)) * 0.9 + wy;

      let tx = wanderX;
      let tz = wanderZ;
      if (this.formation > 0.005) {
        const sx = this.centre.x + f.slot.x;
        const sz = this.centre.z + f.slot.z;
        const sy = this.centre.y + f.slot.y;
        tx = wanderX + (sx - wanderX) * this.formation;
        tz = wanderZ + (sz - wanderZ) * this.formation;
        targetY = targetY + (sy - targetY) * this.formation;
      }

      f.pos.x = damp(f.pos.x, tx, 2.2, dt);
      f.pos.z = damp(f.pos.z, tz, 2.2, dt);
      f.pos.y = damp(f.pos.y, targetY, 1.8, dt);

      // Blink. Fireflies pulse; a steady dot reads as a bug in the render.
      f.phase += dt * f.rate;
      const pulse = Math.pow(Math.max(0, Math.sin(f.phase)), 3.2);
      // In formation they hold steadier so the shape is actually legible.
      f.bright = this.presence * (pulse * (1 - this.formation * 0.55) + this.formation * 0.55);

      this.positions[i * 3] = f.pos.x;
      this.positions[i * 3 + 1] = f.pos.y;
      this.positions[i * 3 + 2] = f.pos.z;
      this.brights[i] = f.bright;
    }

    this.posAttr.needsUpdate = true;
    this.brightAttr.needsUpdate = true;
    this.points.visible = this.presence > 0.01;
  }

  setPixelRatio(pr: number): void {
    this.material.uniforms.uPixelRatio.value = pr;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
