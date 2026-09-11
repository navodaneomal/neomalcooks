import * as THREE from 'three';
import { GLSL_HASH, GLSL_NOISE, GLSL_ATMOSPHERE, GLSL_LIGHTING } from '../shaders/common';
import type { WorldUniforms } from '../core/WorldUniforms';
import type { QualitySettings } from '../core/Quality';
import type { TulipField } from './TulipField';
import { terrainHeight } from './Terrain';
import { srgb } from '../core/Colors';
import { bus } from '../core/Bus';
import { clamp01, damp, lerp, makeRandom, type Rng, TAU } from '../core/MathUtils';
import { landmarkById } from './Landmarks';

/**
 * The hidden ecosystem (brief §10, §11).
 *
 * Small counts, so these are simulated on the CPU where a real behaviour state
 * machine is worth having. The brief is explicit that they must be sparse and
 * unpredictable — minutes can pass without seeing one, and then a butterfly
 * lands on a tulip, stays, and leaves. So nothing here is on a fixed schedule:
 * every creature independently decides when to be present at all, and a
 * creature that is "away" is genuinely not drawn.
 *
 * One butterfly is different. It is faintly luminous, it appears rarely, and if
 * you follow it, it goes somewhere.
 */

type FlyerKind = 0 | 1 | 2 | 3; // butterfly, bee, dragonfly, bird

type FlyerState = 'away' | 'wander' | 'approach' | 'landed' | 'leave' | 'cross';

interface Flyer {
  kind: FlyerKind;
  state: FlyerState;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  target: THREE.Vector3;
  heading: number;
  flap: number;
  flapRate: number;
  scale: number;
  color: THREE.Color;
  glow: number;
  timer: number;
  seed: number;
  /** The rare luminous one that leads somewhere. */
  guide: boolean;
}

const FLYER_VERTEX = /* glsl */ `
precision highp float;

attribute vec3 aWing;      // x across, y along, z = wing side (-1/+1)
attribute vec4 aInstPos;   // xyz world, w heading
attribute vec4 aInstB;     // flap angle, scale, glow, kind
attribute vec3 aInstColor;

varying vec3  vColor;
varying vec3  vWorld;
varying vec3  vNormal;
varying float vGlow;
varying float vKind;
varying vec2  vWingUv;

void main() {
  float heading = aInstPos.w;
  float flap = aInstB.x;
  float scale = aInstB.y;

  vec3 p = aWing;
  float side = p.z;

  // Fold each wing about the body axis. Birds get a shallower, slower arc than
  // an insect, which is most of what distinguishes them at a distance.
  float ang = flap * (aInstB.w > 2.5 ? 0.55 : 1.0);
  float c = cos(ang * side);
  float s = sin(ang * side);
  vec3 v = vec3(p.x * c, abs(p.x) * s, p.y);

  // Yaw into the direction of travel.
  float ch = cos(heading), sh = sin(heading);
  vec3 world = vec3(v.x * ch - v.z * sh, v.y, v.x * sh + v.z * ch) * scale + aInstPos.xyz;

  vColor = aInstColor;
  vWorld = world;
  vNormal = normalize(vec3(-s * side, c, 0.0));
  vGlow = aInstB.z;
  vKind = aInstB.w;
  vWingUv = vec2(abs(p.x), p.y * 0.5 + 0.5);

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const FLYER_FRAGMENT = /* glsl */ `
precision highp float;

uniform float uNight;
uniform vec3  uGlowTint;

varying vec3  vColor;
varying vec3  vWorld;
varying vec3  vNormal;
varying float vGlow;
varying float vKind;
varying vec2  vWingUv;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_LIGHTING}
${GLSL_ATMOSPHERE}

void main() {
  // Wing outline: butterflies get a scalloped shape, everything else a blade.
  float x = vWingUv.x;
  float y = vWingUv.y;
  float edge;
  if (vKind < 0.5) {
    // Two lobes, the rear smaller — a butterfly silhouette.
    float fore = 1.0 - smoothstep(0.55, 1.0, length(vec2(x * 0.85, (y - 0.68) * 1.5)));
    float hind = 1.0 - smoothstep(0.45, 0.85, length(vec2(x * 1.1, (y - 0.32) * 1.7)));
    edge = max(fore, hind);
  } else {
    edge = (1.0 - smoothstep(0.5, 1.0, x)) * (1.0 - smoothstep(0.55, 1.0, abs(y - 0.5) * 2.0));
  }
  if (edge < 0.34) discard;

  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 viewDir = normalize(cameraPosition - vWorld);

  vec3 albedo = vColor;
  if (vKind < 0.5) {
    // Faint banding across the wing.
    float band = smoothstep(0.55, 0.95, abs(sin(y * 7.0 + x * 3.0)));
    albedo *= 1.0 - band * 0.28;
    albedo = mix(albedo, albedo * vec3(1.15, 1.02, 0.95), smoothstep(0.6, 1.0, x));
  }

  vec3 lit = organicLighting(n, viewDir, albedo, 0.85, 0.6);
  lit += uGlowTint * vGlow * (1.0 + uNight * 1.6);

  gl_FragColor = vec4(applyAtmosphere(lit, vWorld), smoothstep(0.34, 0.5, edge));
}
`;

const KIND_COLORS: Record<number, number[]> = {
  0: [0xf2e4d4, 0xe8c9d6, 0xd9c4e2, 0xf0d9b6, 0xdfe6ec],  // butterflies
  1: [0xc79a45, 0x8a6a30],                                  // bees
  2: [0x9fc4c8, 0xb8c9a8],                                  // dragonflies
  3: [0x2a2530, 0x38323c],                                  // distant birds
};

export class Wildlife {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  /** World position of the guide butterfly, or null when it is not present. */
  guidePos: THREE.Vector3 | null = null;

  private flyers: Flyer[] = [];
  private instPos: Float32Array;
  private instB: Float32Array;
  private instColor: Float32Array;
  private attrPos: THREE.InstancedBufferAttribute;
  private attrB: THREE.InstancedBufferAttribute;
  private attrColor: THREE.InstancedBufferAttribute;
  private rng: Rng;
  private field: TulipField;
  private tmp = new THREE.Vector3();

  /** Set each frame from outside. */
  night = 0;
  rain = 0;
  /** Where the camera is, so creatures stay near what you can see. */
  private focus = new THREE.Vector3();

  constructor(uniforms: WorldUniforms, settings: QualitySettings, field: TulipField, seed = 616) {
    this.rng = makeRandom(seed);
    this.field = field;

    const butterflies = settings.butterflies;
    const bees = Math.round(butterflies * 0.9);
    const dragonflies = Math.max(2, Math.round(butterflies * 0.35));
    const birds = Math.max(2, Math.round(butterflies * 0.3));
    const total = butterflies + bees + dragonflies + birds;

    const push = (kind: FlyerKind, n: number, guideOne = false): void => {
      for (let i = 0; i < n; i++) {
        const pal = KIND_COLORS[kind];
        this.flyers.push({
          kind,
          state: 'away',
          pos: new THREE.Vector3(),
          vel: new THREE.Vector3(),
          target: new THREE.Vector3(),
          heading: 0,
          flap: 0,
          flapRate: kind === 0 ? 7 : kind === 1 ? 34 : kind === 2 ? 26 : 4.5,
          scale: kind === 0 ? 0.16 : kind === 1 ? 0.05 : kind === 2 ? 0.11 : 0.9,
          color: srgb(pal[Math.floor(this.rng() * pal.length)]),
          glow: 0,
          timer: this.rng() * 30,
          seed: this.rng() * 1000,
          guide: guideOne && i === 0,
        });
      }
    };
    push(0, butterflies, true);
    push(1, bees);
    push(2, dragonflies);
    push(3, birds);

    // The guide is unmistakable once you notice it, and easy to miss if you do not.
    const guide = this.flyers.find((f) => f.guide);
    if (guide) {
      guide.color = srgb(0xfdf2e0);
      guide.scale = 0.21;
    }

    // --- Geometry: two wings, four triangles ------------------------------
    const wings: number[] = [];
    const idx: number[] = [];
    for (const side of [-1, 1]) {
      const base = wings.length / 3;
      // A wing is a quad in the body plane; the shader folds it.
      wings.push(0, -0.9, side, 1, -0.9, side, 0, 0.9, side, 1, 0.9, side);
      idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    }

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('aWing', new THREE.Float32BufferAttribute(wings, 3));
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(wings.length), 3));
    geo.setIndex(idx);

    this.instPos = new Float32Array(total * 4);
    this.instB = new Float32Array(total * 4);
    this.instColor = new Float32Array(total * 3);
    for (let i = 0; i < total; i++) {
      const f = this.flyers[i];
      this.instColor[i * 3] = f.color.r;
      this.instColor[i * 3 + 1] = f.color.g;
      this.instColor[i * 3 + 2] = f.color.b;
      this.instB[i * 4 + 3] = f.kind;
    }

    this.attrPos = new THREE.InstancedBufferAttribute(this.instPos, 4);
    this.attrB = new THREE.InstancedBufferAttribute(this.instB, 4);
    this.attrColor = new THREE.InstancedBufferAttribute(this.instColor, 3);
    this.attrPos.setUsage(THREE.DynamicDrawUsage);
    this.attrB.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aInstPos', this.attrPos);
    geo.setAttribute('aInstB', this.attrB);
    geo.setAttribute('aInstColor', this.attrColor);
    geo.instanceCount = total;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      vertexShader: FLYER_VERTEX,
      fragmentShader: FLYER_FRAGMENT,
      uniforms: uniforms.organic({ uGlowTint: { value: srgb(0xffe9c0) } }),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: true,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'Wildlife';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  private randomNear(out: THREE.Vector3, radius: number, minR = 4): THREE.Vector3 {
    const a = this.rng() * TAU;
    const r = minR + this.rng() * (radius - minR);
    out.set(this.focus.x + Math.cos(a) * r, 0, this.focus.z + Math.sin(a) * r);
    out.y = terrainHeight(out.x, out.z);
    return out;
  }

  update(dt: number, camera: THREE.Camera): void {
    this.focus.copy(camera.position);
    const flyers = this.flyers;

    for (let i = 0; i < flyers.length; i++) {
      const f = flyers[i];
      f.timer -= dt;

      // --- Presence: most of the time, most creatures are simply not here ---
      if (f.state === 'away') {
        if (f.timer <= 0) {
          // Weather and hour genuinely gate who is out.
          const wants =
            f.kind === 3 ? this.night < 0.5 && this.rain < 0.4 :
            f.kind === 1 ? this.night < 0.3 && this.rain < 0.2 :
            f.kind === 0 ? this.night < 0.35 && this.rain < 0.3 :
                           this.night < 0.6 && this.rain < 0.35;
          // The guide is rarer than everything else.
          const p = f.guide ? 0.12 : 0.55;
          if (wants && this.rng() < p) {
            this.spawn(f);
          } else {
            f.timer = 8 + this.rng() * 26;
          }
        }
        this.write(i, f, 0);
        continue;
      }

      this.step(f, dt);
      this.write(i, f, 1);
    }

    this.attrPos.needsUpdate = true;
    this.attrB.needsUpdate = true;
    this.guidePos = null;
    const g = flyers.find((f) => f.guide && f.state !== 'away');
    if (g) this.guidePos = g.pos;
  }

  private spawn(f: Flyer): void {
    const radius = f.kind === 3 ? 140 : 26;
    this.randomNear(f.pos, radius, f.kind === 3 ? 60 : 6);
    f.pos.y += f.kind === 3 ? 22 + this.rng() * 26 : 0.4 + this.rng() * 1.2;
    f.state = f.kind === 3 ? 'cross' : 'wander';
    f.timer = f.kind === 3 ? 22 + this.rng() * 18 : 6 + this.rng() * 14;
    f.heading = this.rng() * TAU;
    f.vel.set(0, 0, 0);
    this.randomNear(f.target, radius);
    if (f.kind === 3) f.target.y = f.pos.y + (this.rng() - 0.5) * 8;
    else f.target.y += 0.5 + this.rng() * 1.4;

    // The guide knows where it is going.
    if (f.guide) {
      const white = landmarkById('white');
      if (white) {
        // It does not fly straight there — it drifts that way, and waits.
        f.target.set(
          lerp(f.pos.x, white.x, 0.22 + this.rng() * 0.2),
          0,
          lerp(f.pos.z, white.z, 0.22 + this.rng() * 0.2),
        );
        f.target.y = terrainHeight(f.target.x, f.target.z) + 1.0;
      }
      f.glow = 0.55;
      bus.emit('event:rare', { id: 'guide-butterfly' });
    }
  }

  private step(f: Flyer, dt: number): void {
    const speed =
      f.kind === 0 ? 1.5 : f.kind === 1 ? 3.4 : f.kind === 2 ? 6.0 : 7.5;

    if (f.state === 'landed') {
      // Sitting on a flower: the wings idle, half-open.
      f.flap = damp(f.flap, 0.35 + Math.sin(f.timer * 1.6) * 0.28, 3, dt);
      if (f.timer <= 0) {
        f.state = 'leave';
        f.timer = 3 + this.rng() * 5;
        this.randomNear(f.target, 24);
        f.target.y += 1.4 + this.rng() * 2.2;
      }
      return;
    }

    // --- Steer toward the target ------------------------------------------
    this.tmp.copy(f.target).sub(f.pos);
    const dist = this.tmp.length();
    if (dist > 0.001) this.tmp.multiplyScalar(1 / dist);

    // Insects do not fly straight. A wandering offset perpendicular to travel,
    // at a rate that suits the creature, is most of what sells the motion.
    const t = performance.now() * 0.001;
    const wobbleRate = f.kind === 0 ? 2.4 : f.kind === 1 ? 5.5 : 3.2;
    const wobbleAmt = f.kind === 0 ? 0.85 : f.kind === 1 ? 0.5 : 0.30;
    this.tmp.x += Math.sin(t * wobbleRate + f.seed) * wobbleAmt;
    this.tmp.z += Math.cos(t * wobbleRate * 0.83 + f.seed * 1.7) * wobbleAmt;
    if (f.kind !== 3) this.tmp.y += Math.sin(t * wobbleRate * 1.6 + f.seed) * wobbleAmt * 0.7;

    f.vel.lerp(this.tmp.multiplyScalar(speed), 1 - Math.exp(-3.2 * dt));
    f.pos.addScaledVector(f.vel, dt);

    // Never fly through the ground.
    const ground = terrainHeight(f.pos.x, f.pos.z);
    const minY = ground + (f.kind === 3 ? 16 : 0.18);
    if (f.pos.y < minY) f.pos.y = damp(f.pos.y, minY + 0.4, 6, dt);

    f.heading = Math.atan2(f.vel.z, f.vel.x);
    f.flap += dt * f.flapRate * (0.8 + Math.min(1, f.vel.length() / speed) * 0.5);

    // --- Decide what to do next -------------------------------------------
    if (f.state === 'cross') {
      // Birds simply pass through and are gone.
      if (f.timer <= 0 || f.pos.distanceTo(this.focus) > 260) this.retire(f);
      return;
    }

    if (dist < 1.2 || f.timer <= 0) {
      if (f.state === 'leave') {
        this.retire(f);
        return;
      }
      // Look for a flower worth visiting.
      const wantsFlower = f.kind === 0 ? this.rng() < 0.55 : f.kind === 1 ? this.rng() < 0.85 : false;
      if (wantsFlower) {
        const rec = this.field.nearest(f.pos.x, f.pos.z, 6);
        if (rec) {
          f.target.set(rec.x, rec.y + rec.scale * 0.95, rec.z);
          f.state = 'approach';
          f.timer = 5;
          return;
        }
      }
      if (f.state === 'approach' && dist < 1.2) {
        // Bees are brief visitors; butterflies stay a while.
        f.state = 'landed';
        f.timer = f.kind === 1 ? 0.6 + this.rng() * 1.2 : 3.5 + this.rng() * 7;
        return;
      }
      this.randomNear(f.target, f.guide ? 34 : 22);
      f.target.y += 0.6 + this.rng() * 1.8;
      f.timer = 5 + this.rng() * 10;
    }
  }

  private retire(f: Flyer): void {
    f.state = 'away';
    // Long, uneven gaps: the brief asks for minutes of nothing.
    f.timer = f.guide ? 90 + this.rng() * 210 : 14 + this.rng() * 70;
    f.glow = 0;
  }

  private write(i: number, f: Flyer, visible: number): void {
    const o = i * 4;
    this.instPos[o] = f.pos.x;
    this.instPos[o + 1] = f.pos.y;
    this.instPos[o + 2] = f.pos.z;
    this.instPos[o + 3] = f.heading;
    this.instB[o] = Math.sin(f.flap) * 1.15;
    // Scale 0 collapses the quad: an absent creature costs no fragments.
    this.instB[o + 1] = f.scale * visible;
    this.instB[o + 2] = f.glow * clamp01(0.35 + this.night);
    this.instB[o + 3] = f.kind;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
