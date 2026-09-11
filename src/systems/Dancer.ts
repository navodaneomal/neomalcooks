import * as THREE from 'three';
import { GLSL_HASH, GLSL_NOISE, GLSL_COLOR, GLSL_LIGHTING, GLSL_ATMOSPHERE } from '../shaders/common';
import type { WorldUniforms } from '../core/WorldUniforms';
import type { QualitySettings } from '../core/Quality';
import type { TulipField } from '../world/TulipField';
import { terrainHeight } from '../world/Terrain';
import { srgb } from '../core/Colors';
import { bus } from '../core/Bus';
import {
  J, type Pose, newPose, evaluatePose, blendPose, addVariation,
  type DanceState, DANCE_FLOW, stateEnergy,
} from './Dance';
import { clamp01, damp, dampAngle, lerp, makeRandom, type Rng, smoothstep, TAU } from '../core/MathUtils';

/**
 * Her.
 *
 * A deliberate art direction: she is not a character model. There is no rigged
 * mesh to download, no texture that could fail to load, and — more to the point
 * — a procedurally-built realistic human would land squarely in the uncanny
 * valley the brief spends a page warning against ("no cheap 3D models").
 *
 * So she is a figure of light and cloth: a real skeleton posed by the dance
 * system, wrapped in tapered luminous volumes, wearing a dress and hair that
 * are genuinely simulated — verlet chains that answer to gravity, to the same
 * wind the tulips answer to, and to her own motion. Nothing about her is rigid,
 * which is exactly what §26 asks for, and what she reads as is a presence
 * rather than a failed person.
 *
 * She is also the garden's anchor. Every frame she writes influence points into
 * the shared uniforms, and the field bends, blooms and brightens around her
 * without any system needing to know she exists.
 */

// --- Skeleton -------------------------------------------------------------

const enum B {
  Root, SpineLow, SpineMid, Chest, Neck, Head,
  ShoulderL, ElbowL, HandL,
  ShoulderR, ElbowR, HandR,
  HipL, KneeL, AnkleL, ToeL,
  HipR, KneeR, AnkleR, ToeR,
  COUNT,
}

/**
 * Parent index and rest offset, in her local space.
 *
 * The rest pose has her *standing*, arms down at her sides — not in a T-pose.
 * That matters more than it sounds: every joint angle the dance system produces
 * is measured from this pose, so if the rest pose is a T then "arms relaxed"
 * has to be spelled out as a large rotation on every single frame of every
 * single state, and the moment one of them is wrong she stands there like a
 * scarecrow. Resting at rest keeps the whole pose vocabulary honest.
 */
const SKELETON: { parent: number; offset: [number, number, number] }[] = [
  { parent: -1,          offset: [0, 0.92, 0] },      // Root (pelvis)
  { parent: B.Root,      offset: [0, 0.10, 0] },
  { parent: B.SpineLow,  offset: [0, 0.12, 0] },
  { parent: B.SpineMid,  offset: [0, 0.13, 0] },      // Chest
  { parent: B.Chest,     offset: [0, 0.14, 0] },      // Neck
  { parent: B.Neck,      offset: [0, 0.10, 0] },      // Head

  { parent: B.Chest,     offset: [0.142, 0.072, 0] },   // Shoulder L
  { parent: B.ShoulderL, offset: [0.042, -0.255, 0] },  // Elbow L
  { parent: B.ElbowL,    offset: [0.018, -0.245, 0] },  // Hand L

  { parent: B.Chest,     offset: [-0.142, 0.072, 0] },
  { parent: B.ShoulderR, offset: [-0.042, -0.255, 0] },
  { parent: B.ElbowR,    offset: [-0.018, -0.245, 0] },

  { parent: B.Root,      offset: [0.082, -0.055, 0] },  // Hip L
  { parent: B.HipL,      offset: [0, -0.415, 0] },      // Knee L
  { parent: B.KneeL,     offset: [0, -0.40, 0] },       // Ankle L
  { parent: B.AnkleL,    offset: [0, -0.035, 0.105] },  // Toe L

  { parent: B.Root,      offset: [-0.082, -0.055, 0] },
  { parent: B.HipR,      offset: [0, -0.415, 0] },
  { parent: B.KneeR,     offset: [0, -0.40, 0] },
  { parent: B.AnkleR,    offset: [0, -0.035, 0.105] },
];

/**
 * Which bones are drawn as tubes, how their radius tapers, and whether the
 * surface is skin or cloth. Marking the torso as cloth is what gives her a
 * bodice without modelling one: the dress shader already knows how to light
 * fabric, so the top half simply *is* fabric.
 */
const CLOTHED_BONES = new Set([0, 1, 2, 5, 8]);

const BONES: [number, number, number, number][] = [
  // from, to, radius at from, radius at to
  [B.Root, B.SpineLow, 0.098, 0.082],
  [B.SpineLow, B.SpineMid, 0.082, 0.086],
  [B.SpineMid, B.Chest, 0.086, 0.098],
  [B.Chest, B.Neck, 0.062, 0.034],
  [B.Neck, B.Head, 0.034, 0.046],

  [B.Chest, B.ShoulderL, 0.062, 0.042],
  [B.ShoulderL, B.ElbowL, 0.042, 0.028],
  [B.ElbowL, B.HandL, 0.028, 0.018],
  [B.Chest, B.ShoulderR, 0.062, 0.042],
  [B.ShoulderR, B.ElbowR, 0.042, 0.028],
  [B.ElbowR, B.HandR, 0.028, 0.018],

  [B.Root, B.HipL, 0.084, 0.062],
  [B.HipL, B.KneeL, 0.062, 0.040],
  [B.KneeL, B.AnkleL, 0.040, 0.026],
  [B.AnkleL, B.ToeL, 0.026, 0.018],
  [B.Root, B.HipR, 0.084, 0.062],
  [B.HipR, B.KneeR, 0.062, 0.040],
  [B.KneeR, B.AnkleR, 0.040, 0.026],
  [B.AnkleR, B.ToeR, 0.026, 0.018],
];

// --- Shader ---------------------------------------------------------------

const HER_VERTEX = /* glsl */ `
precision highp float;

attribute float aPart;   // 0 body, 1 dress, 2 hair
attribute float aFlow;   // 0 at the anchor .. 1 at the free end
attribute float aSideV;

varying vec3  vWorld;
varying vec3  vNormal;
varying float vPart;
varying float vFlow;
varying float vSideV;

void main() {
  vWorld = position;
  vNormal = normal;
  vPart = aPart;
  vFlow = aFlow;
  vSideV = aSideV;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

const HER_FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3  uSkin;
uniform vec3  uDressA;
uniform vec3  uDressB;
uniform vec3  uHair;
uniform vec3  uGlowTint;
uniform float uGlow;
uniform float uNight;
uniform float uWetness;
uniform float uReveal;

varying vec3  vWorld;
varying vec3  vNormal;
varying float vPart;
varying float vFlow;
varying float vSideV;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_COLOR}
${GLSL_LIGHTING}
${GLSL_ATMOSPHERE}

void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 viewDir = normalize(cameraPosition - vWorld);

  vec3 albedo;
  float translucency;
  float alpha = 1.0;

  if (vPart > 2.5) {
    // Bodice: the same cloth as the skirt, but close-fitting and opaque.
    albedo = mix(uDressA, uDressB, 0.55);
    translucency = 0.42;
  } else if (vPart < 0.5) {
    albedo = uSkin;
    translucency = 0.5;
  } else if (vPart < 1.5) {
    // The dress lightens toward the hem and thins out where it flies.
    albedo = mix(uDressA, uDressB, pow(vFlow, 0.75));
    translucency = 0.72;
    alpha = mix(0.97, 0.66, pow(vFlow, 1.8));
  } else {
    // Hair is not translucent fabric; letting it glow turned her blonde.
    albedo = uHair * (0.82 + 0.30 * vFlow);
    translucency = 0.22;
    alpha = mix(1.0, 0.72, pow(vFlow, 2.2));
  }

  albedo *= mix(1.0, 0.88, uWetness);

  vec3 lit = organicLighting(n, viewDir, albedo, translucency, 0.7);

  // She is lit from within — softly, and more at night. This is what lets her
  // read as a presence in a dark field without turning her into a lamp.
  float rim = rimTerm(n, viewDir, 2.2);
  lit += uGlowTint * uGlow * (0.30 + rim * 1.5) * (1.0 + uNight * 1.4);
  lit += albedo * rim * 0.35;

  // Cloth catches a sheen along the direction of flow.
  if ((vPart > 0.5 && vPart < 1.5) || vPart > 2.5) {
    float sheen = pow(clamp(1.0 - abs(dot(n, viewDir)), 0.0, 1.0), 4.0);
    lit += uDressB * sheen * 0.5;
  }

  gl_FragColor = vec4(applyAtmosphere(lit, vWorld), alpha * uReveal);
}
`;

// --- Cloth ----------------------------------------------------------------

interface ClothPoint {
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  pinned: boolean;
}

interface Strand {
  points: ClothPoint[];
  restLength: number;
  /** Bone the strand hangs from, and the local offset of its anchor. */
  anchorBone: number;
  anchorLocal: THREE.Vector3;
}

export class Dancer {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;

  /** Her world position (at her feet). */
  readonly position = new THREE.Vector3(0, 0, 0);
  /** Which way she is facing, radians. */
  facing = 0;
  /** Current dance state and how much of it is blended in. */
  state: DanceState = 'rest';
  private nextState: DanceState = 'rest';
  private blend = 1;
  private stateTimer = 6;

  /** 0..1 how much she is moving — read by the Heart and the camera. */
  motion = 0;
  /** 0..1 how strongly her personal wind is stirring the air (brief §07). */
  herWind = 0;
  /** Set by the narrative director; when set she walks toward it. */
  walkTarget: THREE.Vector3 | null = null;
  /** 0..1 fade-in; she does not exist until the world has woken up. */
  reveal = 0;
  revealTarget = 0;
  /** Raised when she is singing, so the field can answer her voice. */
  singing = 0;

  private joints: THREE.Vector3[] = [];
  private jointWorld: THREE.Vector3[] = [];
  private poseA: Pose = newPose();
  private poseB: Pose = newPose();
  private pose: Pose = newPose();
  private quats: THREE.Quaternion[] = [];
  private mats: THREE.Matrix4[] = [];

  private dress: Strand[] = [];
  private hair: Strand[] = [];

  private positions!: Float32Array;
  private normals!: Float32Array;
  private posAttr!: THREE.BufferAttribute;
  private nrmAttr!: THREE.BufferAttribute;
  private mesh!: THREE.Mesh;

  private tubeSides: number;
  private dressWidth = 0.045;
  private hairWidth = 0.020;
  private bodyVertCount = 0;
  private rng: Rng;
  private seed: number;
  private clock = 0;
  private spinRate = 0;
  /** Re-pointed after a quality rebuild; the old field is disposed. */
  private field: TulipField;
  private uniforms: WorldUniforms;

  /** A short history of her pose, so the pond can show her a moment late. */
  private history: { pos: THREE.Vector3; facing: number; pose: Pose }[] = [];
  private historyGap = 0;

  // --- The reflection ------------------------------------------------------
  /** Mirrored copy of her drawn in the pond. */
  reflection!: THREE.Mesh;
  private reflMaterial!: THREE.ShaderMaterial;
  private reflPositions!: Float32Array;
  private reflNormals!: Float32Array;
  private reflPosAttr!: THREE.BufferAttribute;
  private reflNrmAttr!: THREE.BufferAttribute;
  /** Ring buffer of past vertex positions, for the lagging reflection. */
  private vertexHistory: Float32Array[] = [];
  private vertexHead = 0;
  private vertexFilled = 0;
  /** Seconds remaining in a "the reflection is still dancing" moment. */
  private lagTimer = 0;
  private lagCooldown = 60;

  /** Footstep bookkeeping, for blooming flowers behind her. */
  private lastStepPos = new THREE.Vector3();
  private stepPhase = 0;

  constructor(uniforms: WorldUniforms, settings: QualitySettings, field: TulipField, seed = 5) {
    this.uniforms = uniforms;
    this.field = field;
    this.rng = makeRandom(seed);
    this.seed = this.rng() * 100;
    this.tubeSides = settings.tier === 'performance' ? 5 : settings.tier === 'beautiful' ? 6 : 8;

    for (let i = 0; i < B.COUNT; i++) {
      this.joints.push(new THREE.Vector3());
      this.jointWorld.push(new THREE.Vector3());
      this.quats.push(new THREE.Quaternion());
      this.mats.push(new THREE.Matrix4());
    }

    const dressStrands = settings.tier === 'performance' ? 14 : settings.tier === 'beautiful' ? 20 : 28;
    const dressSegs = settings.tier === 'performance' ? 6 : 8;
    const hairStrands = settings.tier === 'performance' ? 12 : 22;
    const hairSegs = settings.tier === 'performance' ? 6 : 9;

    this.buildCloth(dressStrands, dressSegs, hairStrands, hairSegs);
    this.buildGeometry(dressStrands, dressSegs, hairStrands, hairSegs);

    this.material = new THREE.ShaderMaterial({
      vertexShader: HER_VERTEX,
      fragmentShader: HER_FRAGMENT,
      uniforms: uniforms.organic({
        uSkin: { value: srgb(0xdcae97) },
        uDressA: { value: srgb(0xd9cdd4) },
        uDressB: { value: srgb(0xfaf2f0) },
        uHair: { value: srgb(0x3d2820) },
        uGlowTint: { value: srgb(0xffd9b0) },
        uGlow: { value: 0.16 },
        uReveal: { value: 0 },
      }),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: true,
    });

    this.mesh.material = this.material;
    this.group.add(this.mesh);
    this.group.name = 'Dancer';

    this.buildReflection();

    // Start her somewhere in the heart of the garden.
    this.position.set(0, terrainHeight(0, 0), 0);
    this.lastStepPos.copy(this.position);
    evaluatePose(this.poseA, 'rest', 0, this.seed);
    evaluatePose(this.poseB, 'rest', 0, this.seed);
  }

  // -----------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------

  private buildCloth(dn: number, ds: number, hn: number, hs: number): void {
    // Dress: strands hanging from a ring at the hips, long enough to reach
    // most of the way to the ground so it can actually flow.
    // A ribbon's half-width times two, times the number of strands, has to come
    // out near the circumference it is wrapping. Overshoot it and the skirt
    // fuses into a solid box instead of hanging in folds.
    this.dressWidth = (TAU * 0.15) * 0.70 / dn;
    for (let i = 0; i < dn; i++) {
      const a = (i / dn) * TAU;
      const r = 0.15;
      const anchor = new THREE.Vector3(Math.cos(a) * r, 0.02, Math.sin(a) * r * 0.82);
      const pts: ClothPoint[] = [];
      const seg = 0.088;
      for (let j = 0; j <= ds; j++) {
        // Seeded hanging from where the anchor will actually be, so the first
        // frame is already settled rather than snapping up from the origin.
        const p = new THREE.Vector3(anchor.x, 0.92 + anchor.y - j * seg, anchor.z);
        pts.push({ pos: p.clone(), prev: p.clone(), pinned: j === 0 });
      }
      this.dress.push({ points: pts, restLength: seg, anchorBone: B.Root, anchorLocal: anchor });
    }

    // Hair: strands from the back and sides of the head, falling past the
    // shoulders so the wind has something to do with it.
    this.hairWidth = (TAU * 0.072) * 0.62 / hn;
    for (let i = 0; i < hn; i++) {
      const a = Math.PI * 0.18 + (i / Math.max(hn - 1, 1)) * Math.PI * 1.64;
      const r = 0.075;
      const anchor = new THREE.Vector3(Math.cos(a) * r, 0.052, Math.sin(a) * r * 0.92);
      const pts: ClothPoint[] = [];
      const seg = 0.072;
      for (let j = 0; j <= hs; j++) {
        const p = new THREE.Vector3(anchor.x, 1.56 + anchor.y - j * seg, anchor.z);
        pts.push({ pos: p.clone(), prev: p.clone(), pinned: j === 0 });
      }
      this.hair.push({ points: pts, restLength: seg, anchorBone: B.Head, anchorLocal: anchor });
    }
  }

  private buildGeometry(dn: number, ds: number, hn: number, hs: number): void {
    const sides = this.tubeSides;
    const pos: number[] = [];
    const nrm: number[] = [];
    const part: number[] = [];
    const flow: number[] = [];
    const sideV: number[] = [];
    const idx: number[] = [];

    // --- Body: one tube per bone -------------------------------------------
    for (let b = 0; b < BONES.length; b++) {
      const base = pos.length / 3;
      const partId = CLOTHED_BONES.has(b) ? 3 : 0;
      for (let ring = 0; ring < 2; ring++) {
        for (let j = 0; j <= sides; j++) {
          pos.push(0, 0, 0);
          nrm.push(0, 1, 0);
          part.push(partId);
          flow.push(ring);
          sideV.push(j / sides);
        }
      }
      const row = sides + 1;
      for (let j = 0; j < sides; j++) {
        const a = base + j, bI = a + 1, c = a + row, d = c + 1;
        idx.push(a, bI, c, bI, d, c);
      }
    }
    // The head is an ovoid built from rings around the head joint.
    const headRings = 5;
    {
      const base = pos.length / 3;
      for (let r = 0; r <= headRings; r++) {
        for (let j = 0; j <= sides; j++) {
          pos.push(0, 0, 0);
          nrm.push(0, 1, 0);
          part.push(0);
          flow.push(r / headRings);
          sideV.push(j / sides);
        }
      }
      const row = sides + 1;
      for (let r = 0; r < headRings; r++) {
        for (let j = 0; j < sides; j++) {
          const a = base + r * row + j, bI = a + 1, c = a + row, d = c + 1;
          idx.push(a, bI, c, bI, d, c);
        }
      }
    }
    this.bodyVertCount = pos.length / 3;

    // --- Dress and hair: ribbon strips --------------------------------------
    const addStrips = (count: number, segs: number, partId: number, width: number): void => {
      for (let s = 0; s < count; s++) {
        const base = pos.length / 3;
        for (let j = 0; j <= segs; j++) {
          for (let k = 0; k < 2; k++) {
            pos.push(0, 0, 0);
            nrm.push(0, 1, 0);
            part.push(partId);
            flow.push(j / segs);
            sideV.push(k === 0 ? -width : width);
          }
        }
        for (let j = 0; j < segs; j++) {
          const a = base + j * 2, bI = a + 1, c = a + 2, d = a + 3;
          idx.push(a, bI, c, bI, d, c);
        }
      }
    };
    addStrips(dn, ds, 1, 1);
    addStrips(hn, hs, 2, 1);

    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(pos);
    this.normals = new Float32Array(nrm);
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.nrmAttr = new THREE.BufferAttribute(this.normals, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.nrmAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('normal', this.nrmAttr);
    geo.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
    geo.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 1));
    geo.setAttribute('aSideV', new THREE.Float32BufferAttribute(sideV, 1));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3);

    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
    this.mesh.name = 'Her';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  // -----------------------------------------------------------------------
  // Frame
  // -----------------------------------------------------------------------

  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private tmpE = new THREE.Euler();
  private rootMatrix = new THREE.Matrix4();
  private localMatrix = new THREE.Matrix4();
  private unitScale = new THREE.Vector3(1, 1, 1);
  private upAxis = new THREE.Vector3(0, 1, 0);

  update(dt: number, windDir: THREE.Vector2, windStrength: number): void {
    this.clock += dt;
    this.reveal = damp(this.reveal, this.revealTarget, 0.8, dt);
    this.material.uniforms.uReveal.value = this.reveal;
    this.mesh.visible = this.reveal > 0.01;
    if (this.reveal < 0.01) return;

    this.chooseState(dt);
    this.updatePose(dt);
    this.updateRoot(dt);
    this.solveSkeleton();
    this.simulateCloth(dt, windDir, windStrength);
    this.writeGeometry();
    this.recordHistory(dt);
    this.writeInfluence();
  }

  /** Move between dance states on a schedule that is never quite regular. */
  private chooseState(dt: number): void {
    this.stateTimer -= dt;

    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / 1.35);
      if (this.blend >= 1) {
        this.state = this.nextState;
        bus.emit('she:state', { state: this.state });
      }
    } else if (this.stateTimer <= 0) {
      // Walking toward a target overrides her own choices.
      if (this.walkTarget && this.position.distanceTo(this.walkTarget) > 1.6) {
        this.nextState = 'walk';
      } else {
        const options = DANCE_FLOW[this.state];
        this.nextState = options[Math.floor(this.rng() * options.length)];
      }
      this.blend = 0;
      this.stateTimer = 5 + this.rng() * 11;
      if (this.nextState === 'spin') this.spinRate = (this.rng() < 0.5 ? -1 : 1) * (1.5 + this.rng());
    }

    // Reaching only makes sense with a flower to reach for.
    if (this.nextState === 'reach' && !this.field.nearest(this.position.x, this.position.z, 2.5)) {
      this.nextState = 'look';
    }
  }

  private updatePose(dt: number): void {
    const from = this.state;
    const to = this.blend < 1 ? this.nextState : this.state;
    evaluatePose(this.poseA, from, this.clock, this.seed);
    evaluatePose(this.poseB, to, this.clock, this.seed);
    // Smoothstep the crossfade so neither end of a transition has a corner.
    const t = smoothstep(0, 1, this.blend);
    blendPose(this.pose, this.poseA, this.poseB, t);
    addVariation(this.pose, this.clock, this.seed, 0.035);

    const active = this.blend < 1 ? this.nextState : this.state;
    const target = stateEnergy(active);
    this.motion = damp(this.motion, target, 1.6, dt);
    this.singing = damp(this.singing, active === 'sing' ? 1 : active === 'skyward' ? 0.5 : 0, 1.2, dt);
    // The air around her thickens with her movement, and stays stirred briefly
    // after she stops.
    this.herWind = damp(this.herWind, clamp01(this.motion * 1.2), this.motion > this.herWind ? 2.4 : 0.55, dt);
  }

  private updateRoot(dt: number): void {
    const active = this.blend < 1 ? this.nextState : this.state;

    if (active === 'spin') {
      this.facing += this.spinRate * dt * TAU * 0.42;
    } else if (active === 'walk') {
      let desired = this.facing;
      if (this.walkTarget) {
        this.tmpA.copy(this.walkTarget).sub(this.position);
        if (this.tmpA.lengthSq() > 0.25) desired = Math.atan2(this.tmpA.x, this.tmpA.z);
      } else {
        // Wander, but stay inside the garden's heart.
        const r = Math.hypot(this.position.x, this.position.z);
        if (r > 46) desired = Math.atan2(-this.position.x, -this.position.z);
        else desired = this.facing + Math.sin(this.clock * 0.19 + this.seed) * 0.5;
      }
      this.facing = dampAngle(this.facing, desired, 1.6, dt);

      const speed = 0.95;
      this.position.x += Math.sin(this.facing) * speed * dt;
      this.position.z += Math.cos(this.facing) * speed * dt;

      // Footsteps: a bloom behind her every time a foot lands (brief §06).
      this.stepPhase += dt * 2.4;
      if (this.stepPhase > Math.PI) {
        this.stepPhase -= Math.PI;
        if (this.position.distanceTo(this.lastStepPos) > 0.35) {
          this.lastStepPos.copy(this.position);
          bus.emit('garden:bloom', {
            x: this.position.x, z: this.position.z, radius: 1.5, power: 0.32,
          });
        }
      }
    } else {
      this.facing = dampAngle(this.facing, this.facing + Math.sin(this.clock * 0.11) * 0.2, 0.6, dt);
    }

    this.position.y = terrainHeight(this.position.x, this.position.z);
  }

  /**
   * Forward kinematics: 28 angles become 20 world joint positions.
   *
   * The sign conventions are fixed here, once, so the dance states can be
   * written in plain terms:
   *   shoulder roll  + lifts the arm outward (either arm — the right's values
   *                    are simply negative)
   *   shoulder pitch + swings the arm forward
   *   elbow          + bends the forearm forward
   *   hip pitch      + swings the leg forward
   *   knee           + bends the shin backward, the way a knee actually goes
   */
  private solveSkeleton(): void {
    const p = this.pose;
    const rot = (i: number, x: number, y: number, z: number): void => {
      this.tmpE.set(x, y, z, 'YXZ');
      this.quats[i].setFromEuler(this.tmpE);
    };

    rot(B.Root, p[J.RootPitch], p[J.RootYaw], p[J.RootRoll]);
    rot(B.SpineLow, p[J.SpinePitch], p[J.SpineYaw], p[J.SpineRoll]);
    rot(B.SpineMid, p[J.SpinePitch] * 0.6, p[J.SpineYaw] * 0.6, p[J.SpineRoll] * 0.6);
    rot(B.Chest, p[J.ChestPitch], p[J.ChestYaw], p[J.ChestRoll]);
    rot(B.Neck, p[J.HeadPitch] * 0.35, p[J.HeadYaw] * 0.35, p[J.HeadRoll] * 0.35);
    rot(B.Head, p[J.HeadPitch] * 0.65, p[J.HeadYaw] * 0.65, p[J.HeadRoll] * 0.65);

    rot(B.ShoulderL, -p[J.ShoulderLPitch], p[J.ShoulderLYaw], p[J.ShoulderLRoll]);
    rot(B.ElbowL, -p[J.ElbowL], 0, 0);
    rot(B.HandL, 0, 0, 0);
    rot(B.ShoulderR, -p[J.ShoulderRPitch], p[J.ShoulderRYaw], p[J.ShoulderRRoll]);
    rot(B.ElbowR, -p[J.ElbowR], 0, 0);
    rot(B.HandR, 0, 0, 0);

    rot(B.HipL, -p[J.HipLPitch], p[J.HipLYaw], 0);
    rot(B.KneeL, p[J.KneeL], 0, 0);
    rot(B.AnkleL, -p[J.KneeL] * 0.35, 0, 0);
    rot(B.ToeL, 0, 0, 0);
    rot(B.HipR, -p[J.HipRPitch], p[J.HipRYaw], 0);
    rot(B.KneeR, p[J.KneeR], 0, 0);
    rot(B.AnkleR, -p[J.KneeR] * 0.35, 0, 0);
    rot(B.ToeR, 0, 0, 0);

    // Her whole body sits under one root transform: position, facing, and the
    // pose's own sway and bob.
    this.tmpQ.setFromAxisAngle(this.upAxis, this.facing);
    this.tmpA.set(
      this.position.x + Math.cos(this.facing) * p[J.RootSway],
      this.position.y + p[J.RootY],
      this.position.z - Math.sin(this.facing) * p[J.RootSway],
    );
    this.rootMatrix.compose(this.tmpA, this.tmpQ, this.unitScale);

    for (let i = 0; i < B.COUNT; i++) {
      const s = SKELETON[i];
      this.tmpB.set(s.offset[0], s.offset[1], s.offset[2]);
      this.localMatrix.compose(this.tmpB, this.quats[i], this.unitScale);
      const parent = s.parent < 0 ? this.rootMatrix : this.mats[s.parent];
      this.mats[i].multiplyMatrices(parent, this.localMatrix);
      this.jointWorld[i].setFromMatrixPosition(this.mats[i]);
    }
  }

  // --- Cloth --------------------------------------------------------------

  private simulateCloth(dt: number, windDir: THREE.Vector2, windStrength: number): void {
    // Fixed substep keeps verlet stable regardless of frame rate.
    const h = Math.min(dt, 1 / 45);
    const gravity = -7.5 * h * h;
    const windX = windDir.x * windStrength;
    const windZ = windDir.y * windStrength;

    const run = (strands: Strand[], boneIndex: number, stiffness: number, drag: number, windScale: number): void => {
      for (const strand of strands) {
        // Anchor rides with the bone it hangs from.
        const m = this.mats[boneIndex];
        const anchor = this.tmpA.copy(strand.anchorLocal).applyMatrix4(m);
        strand.points[0].pos.copy(anchor);
        strand.points[0].prev.copy(anchor);

        for (let i = 1; i < strand.points.length; i++) {
          const pt = strand.points[i];
          const t = i / (strand.points.length - 1);
          // Verlet: velocity is implicit in the gap between pos and prev.
          const vx = (pt.pos.x - pt.prev.x) * drag;
          const vy = (pt.pos.y - pt.prev.y) * drag;
          const vz = (pt.pos.z - pt.prev.z) * drag;
          pt.prev.copy(pt.pos);

          // Wind bites harder at the free end, and flutters.
          const flutter = Math.sin(this.clock * 5.5 + i * 1.7 + this.seed) * 0.4;
          const w = windScale * t * h * h * (1 + flutter);
          pt.pos.x += vx + windX * w * 6.5;
          pt.pos.z += vz + windZ * w * 6.5;
          pt.pos.y += vy + gravity;
          // Her own movement pushes the cloth out behind her.
          pt.pos.x += (this.herWind * t * h * h) * Math.sin(this.facing) * -22;
          pt.pos.z += (this.herWind * t * h * h) * Math.cos(this.facing) * -22;
        }

        // Distance constraints, run from the anchor outward.
        for (let iter = 0; iter < 7; iter++) {
          for (let i = 1; i < strand.points.length; i++) {
            const a = strand.points[i - 1];
            const b = strand.points[i];
            this.tmpB.copy(b.pos).sub(a.pos);
            const d = this.tmpB.length();
            if (d < 1e-5) continue;
            const diff = (d - strand.restLength) / d;
            // The anchor never moves; everything else is pulled to it.
            const move = a.pinned ? 1 : 0.5;
            if (!a.pinned) a.pos.addScaledVector(this.tmpB, diff * 0.5 * stiffness);
            b.pos.addScaledVector(this.tmpB, -diff * move * stiffness);
          }
        }

        // Keep cloth outside her body and above the ground.
        for (let i = 1; i < strand.points.length; i++) {
          const pt = strand.points[i];
          const hipY = this.jointWorld[B.Root].y;
          if (pt.pos.y < hipY) {
            // Approximate the legs as a capsule and push the skirt off them.
            const dx = pt.pos.x - this.jointWorld[B.Root].x;
            const dz = pt.pos.z - this.jointWorld[B.Root].z;
            const r = Math.hypot(dx, dz);
            const minR = 0.10 + 0.055 * clamp01((hipY - pt.pos.y) / 0.6);
            if (r < minR && r > 1e-4) {
              pt.pos.x += (dx / r) * (minR - r);
              pt.pos.z += (dz / r) * (minR - r);
            }
          }
          const ground = terrainHeight(pt.pos.x, pt.pos.z) + 0.012;
          if (pt.pos.y < ground) {
            pt.pos.y = ground;
            // A little friction where the hem drags.
            pt.prev.x = lerp(pt.prev.x, pt.pos.x, 0.4);
            pt.prev.z = lerp(pt.prev.z, pt.pos.z, 0.4);
          }
        }
      }
    };

    run(this.dress, B.Root, 1.0, 0.968, 1.0);
    run(this.hair, B.Head, 0.92, 0.955, 0.55);
  }

  // --- Geometry write ------------------------------------------------------

  private writeGeometry(): void {
    const P = this.positions;
    const N = this.normals;
    const sides = this.tubeSides;
    let v = 0;

    const up = new THREE.Vector3();
    const right = new THREE.Vector3();
    const axis = new THREE.Vector3();

    // Bones as tapered tubes.
    for (const [fromI, toI, r0, r1] of BONES) {
      const a = this.jointWorld[fromI];
      const b = this.jointWorld[toI];
      axis.copy(b).sub(a);
      const len = axis.length();
      if (len < 1e-5) axis.set(0, 1, 0);
      else axis.multiplyScalar(1 / len);
      up.set(0, 1, 0);
      if (Math.abs(axis.dot(up)) > 0.94) up.set(1, 0, 0);
      right.crossVectors(axis, up).normalize();
      up.crossVectors(right, axis).normalize();

      for (let ring = 0; ring < 2; ring++) {
        const c = ring === 0 ? a : b;
        const r = ring === 0 ? r0 : r1;
        for (let j = 0; j <= sides; j++) {
          const ang = (j / sides) * TAU;
          const nx = right.x * Math.cos(ang) + up.x * Math.sin(ang);
          const ny = right.y * Math.cos(ang) + up.y * Math.sin(ang);
          const nz = right.z * Math.cos(ang) + up.z * Math.sin(ang);
          const o = v * 3;
          P[o] = c.x + nx * r;
          P[o + 1] = c.y + ny * r;
          P[o + 2] = c.z + nz * r;
          N[o] = nx; N[o + 1] = ny; N[o + 2] = nz;
          v++;
        }
      }
    }

    // Head: an ovoid around the head joint, tilted with the neck.
    {
      const head = this.jointWorld[B.Head];
      const neck = this.jointWorld[B.Neck];
      axis.copy(head).sub(neck).normalize();
      up.set(0, 1, 0);
      if (Math.abs(axis.dot(up)) > 0.94) up.set(1, 0, 0);
      right.crossVectors(axis, up).normalize();
      up.crossVectors(right, axis).normalize();
      const rings = 5;
      for (let r = 0; r <= rings; r++) {
        const t = r / rings;
        const along = lerp(-0.045, 0.115, t);
        const rad = Math.sin(Math.PI * (0.14 + t * 0.78)) * 0.088;
        for (let j = 0; j <= sides; j++) {
          const ang = (j / sides) * TAU;
          const nx = right.x * Math.cos(ang) + up.x * Math.sin(ang);
          const ny = right.y * Math.cos(ang) + up.y * Math.sin(ang);
          const nz = right.z * Math.cos(ang) + up.z * Math.sin(ang);
          const o = v * 3;
          P[o] = head.x + axis.x * along + nx * rad;
          P[o + 1] = head.y + axis.y * along + ny * rad;
          P[o + 2] = head.z + axis.z * along + nz * rad;
          N[o] = nx; N[o + 1] = ny; N[o + 2] = nz;
          v++;
        }
      }
    }

    // Cloth ribbons: each segment gets a width axis facing the camera-ish.
    const writeStrands = (strands: Strand[], width: number): void => {
      for (const s of strands) {
        const n = s.points.length;
        for (let i = 0; i < n; i++) {
          const cur = s.points[i].pos;
          const nxt = s.points[Math.min(i + 1, n - 1)].pos;
          const prv = s.points[Math.max(i - 1, 0)].pos;
          axis.copy(nxt).sub(prv);
          if (axis.lengthSq() < 1e-8) axis.set(0, -1, 0);
          axis.normalize();
          // Width axis: tangential around her, so ribbons form a skirt.
          right.set(cur.x - this.position.x, 0, cur.z - this.position.z);
          if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
          right.normalize();
          up.crossVectors(axis, right).normalize();
          const w = width * (0.55 + 0.65 * (i / (n - 1)));
          for (let k = 0; k < 2; k++) {
            const sgn = k === 0 ? -1 : 1;
            const o = v * 3;
            P[o] = cur.x + up.x * w * sgn;
            P[o + 1] = cur.y + up.y * w * sgn;
            P[o + 2] = cur.z + up.z * w * sgn;
            N[o] = right.x; N[o + 1] = right.y; N[o + 2] = right.z;
            v++;
          }
        }
      }
    };
    // Widths chosen so the ribbons *meet* rather than overlap: a skirt of
    // twenty strands around a 0.9m waist needs about 45mm each, not 170mm.
    writeStrands(this.dress, this.dressWidth);
    writeStrands(this.hair, this.hairWidth);

    this.posAttr.needsUpdate = true;
    this.nrmAttr.needsUpdate = true;
    void this.bodyVertCount;

    const bs = this.mesh.geometry.boundingSphere;
    if (bs) bs.center.copy(this.position).setY(this.position.y + 0.9);
  }

  // --- Memory of herself ---------------------------------------------------

  private recordHistory(dt: number): void {
    this.historyGap += dt;
    if (this.historyGap < 1 / 20) return;
    this.historyGap = 0;
    const pose = newPose();
    pose.set(this.pose);
    this.history.push({ pos: this.position.clone(), facing: this.facing, pose });
    // About two seconds of her, which is all the pond ever needs.
    if (this.history.length > 44) this.history.shift();
  }

  /** Her pose roughly `seconds` ago, for the pond's lagging reflection. */
  poseAgo(seconds: number): { pos: THREE.Vector3; facing: number; pose: Pose } | null {
    const steps = Math.round(seconds * 20);
    const i = this.history.length - 1 - steps;
    return i >= 0 ? this.history[i] : null;
  }

  // --- Her effect on the garden -------------------------------------------

  private writeInfluence(): void {
    const u = this.uniforms;
    // Two points: a tight one at her feet, and a wider, softer one that is her
    // presence rather than her body.
    u.addInfluence(this.position.x, this.position.z, 2.2, 0.55 + this.motion * 0.55);
    u.addInfluence(this.position.x, this.position.z, 7.5 + this.herWind * 7, this.herWind * 0.42);

    // When she raises her hands, the particles answer.
    const handY = Math.max(this.jointWorld[B.HandL].y, this.jointWorld[B.HandR].y);
    const raised = clamp01((handY - this.position.y - 1.35) / 0.45);
    this.handsRaised = raised;
    this.material.uniforms.uGlow.value = 0.14 + this.singing * 0.22 + raised * 0.12;
  }

  handsRaised = 0;

  /** World position of her head — the camera likes to look here. */
  headPosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.jointWorld[B.Head]);
  }

  /** Roughly her centre of mass, for framing. */
  centre(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.jointWorld[B.Chest]);
  }

  /** True when she is looking up (brief §06 — the light shifts upward). */
  get lookingUp(): number {
    return clamp01(-this.pose[J.HeadPitch] / 0.6);
  }

  /** Point her at the rebuilt tulip field after a quality change. */
  setField(field: TulipField): void {
    this.field = field;
  }

  setState(state: DanceState, immediate = false): void {
    this.nextState = state;
    this.blend = immediate ? 1 : 0;
    if (immediate) this.state = state;
    this.stateTimer = 6 + this.rng() * 6;
  }

  // -----------------------------------------------------------------------
  // The reflection (brief §13)
  // -----------------------------------------------------------------------

  /**
   * A mirrored copy of her, drawn into the pond.
   *
   * It normally copies the live vertex positions exactly. Very rarely it stops
   * copying and reads from a ring buffer of past frames instead — so for about
   * a second the reflection carries on dancing after she has stopped, and then
   * quietly catches up. That is the pond's one piece of real magic, and it is
   * built as an actual delay rather than a separate animation, which is why it
   * resynchronises perfectly.
   */
  private buildReflection(): void {
    const src = this.mesh.geometry;
    const n = (src.getAttribute('position') as THREE.BufferAttribute).count;

    this.reflPositions = new Float32Array(n * 3);
    this.reflNormals = new Float32Array(n * 3);
    this.reflPosAttr = new THREE.BufferAttribute(this.reflPositions, 3);
    this.reflNrmAttr = new THREE.BufferAttribute(this.reflNormals, 3);
    this.reflPosAttr.setUsage(THREE.DynamicDrawUsage);
    this.reflNrmAttr.setUsage(THREE.DynamicDrawUsage);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', this.reflPosAttr);
    geo.setAttribute('normal', this.reflNrmAttr);
    geo.setAttribute('aPart', src.getAttribute('aPart'));
    geo.setAttribute('aFlow', src.getAttribute('aFlow'));
    geo.setAttribute('aSideV', src.getAttribute('aSideV'));
    geo.setIndex(src.getIndex());
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3);

    this.reflMaterial = this.material.clone();
    this.reflMaterial.uniforms = { ...this.material.uniforms };
    // Its own reveal, so it can fade independently of her.
    this.reflMaterial.uniforms.uReveal = { value: 0 };
    this.reflMaterial.depthWrite = false;
    this.reflMaterial.side = THREE.DoubleSide;

    this.reflection = new THREE.Mesh(geo, this.reflMaterial);
    this.reflection.name = 'HerReflection';
    this.reflection.frustumCulled = false;
    this.reflection.visible = false;
    // Under the water surface, so the pond's own alpha blends over it.
    this.reflection.renderOrder = 2;

    // Two seconds of vertex history at 60fps is more than the lag ever needs.
    for (let i = 0; i < 40; i++) this.vertexHistory.push(new Float32Array(n * 3));
  }

  /**
   * Update the reflection. `waterY` is the pond surface; `near` is how visible
   * she should be in it, 0 when she is nowhere near the water.
   */
  updateReflection(dt: number, waterY: number, near: number): void {
    const visible = near > 0.01 && this.reveal > 0.05;
    this.reflection.visible = visible;
    this.reflMaterial.uniforms.uReveal.value = near * this.reveal * 0.55;
    if (!visible) return;

    // Record this frame.
    const slot = this.vertexHistory[this.vertexHead];
    slot.set(this.positions);
    this.vertexHead = (this.vertexHead + 1) % this.vertexHistory.length;
    this.vertexFilled = Math.min(this.vertexFilled + 1, this.vertexHistory.length);

    // Decide whether the reflection is currently out of step.
    this.lagCooldown -= dt;
    if (this.lagTimer > 0) {
      this.lagTimer -= dt;
    } else if (this.lagCooldown <= 0) {
      this.lagCooldown = 90 + this.rng() * 210;
      // Rare enough that most visits never see it.
      if (this.rng() < 0.35) this.lagTimer = 0.9 + this.rng() * 0.7;
    }

    // Read the live frame, or one from about a second ago.
    let source = this.positions;
    if (this.lagTimer > 0 && this.vertexFilled >= this.vertexHistory.length) {
      const back = Math.round(this.vertexHistory.length * 0.85);
      const i = (this.vertexHead - back + this.vertexHistory.length * 2) % this.vertexHistory.length;
      source = this.vertexHistory[i];
    }

    // Mirror about the water plane.
    const P = this.reflPositions;
    const N = this.reflNormals;
    const live = this.normals;
    const two = waterY * 2;
    for (let i = 0; i < P.length; i += 3) {
      P[i] = source[i];
      P[i + 1] = two - source[i + 1];
      P[i + 2] = source[i + 2];
      N[i] = live[i];
      N[i + 1] = -live[i + 1];
      N[i + 2] = live[i + 2];
    }
    this.reflPosAttr.needsUpdate = true;
    this.reflNrmAttr.needsUpdate = true;

    const bs = this.reflection.geometry.boundingSphere;
    if (bs) bs.center.set(this.position.x, two - (this.position.y + 0.9), this.position.z);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.reflection.geometry.dispose();
    this.reflMaterial.dispose();
    this.material.dispose();
  }
}
