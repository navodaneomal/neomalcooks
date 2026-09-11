import * as THREE from 'three';
import { GLSL_HASH, GLSL_NOISE, GLSL_COLOR, GLSL_ROTATE, GLSL_WIND, GLSL_LIGHTING, GLSL_ATMOSPHERE } from '../shaders/common';
import { GLSL_WAVE } from '../core/WorldUniforms';
import type { WorldUniforms } from '../core/WorldUniforms';
import type { QualitySettings } from '../core/Quality';
import { terrainHeight } from './Terrain';
import { TREE } from './Landmarks';
import { srgb } from '../core/Colors';
import { damp, makeRandom, type Rng } from '../core/MathUtils';

/**
 * THE SECRET TREE (brief §29, §30).
 *
 * Grown, not modelled: a recursive branching system where every limb inherits
 * its parent's direction with a deterministic deviation, so the silhouette
 * reads as something that has stood a long time rather than a fantasy prop.
 * Gravity pulls the outer limbs down, which is most of what distinguishes an
 * ancient tree from a young one.
 *
 * It carries one thing that is not a leaf: a single tulip on a hidden branch —
 * THE FIRST TULIP. Approaching illuminates the tree from the roots outward, and
 * touching that flower rewinds the world.
 */

const TREE_VERTEX = /* glsl */ `
precision highp float;

attribute float aDepth;     // 0 trunk .. 1 outermost twig
attribute float aSeedV;
attribute vec3  aBranchDir;

uniform float uGlow;
uniform float uSway;

varying vec3  vWorld;
varying vec3  vNormal;
varying float vDepth;
varying float vSeed;
varying float vGlowLine;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_ROTATE}
${GLSL_WIND}
${GLSL_WAVE}

void main() {
  vec3 p = position;

  // Thin limbs move; the trunk does not. Sway scales hard with depth.
  float amp = pow(aDepth, 2.2) * (0.12 + uWindStrength * 0.30) * uSway;
  float w = windField(p.xz) + windGust(p.xz) * 1.4;
  vec3 off = vec3(uWindDir.x, 0.0, uWindDir.y) * w * amp;
  off.y += sin(uTime * 1.6 + aSeedV * 6.28) * amp * 0.25;
  p += off;

  vWorld = p;
  vNormal = normalize(normal + off * 0.4);
  vDepth = aDepth;
  vSeed = aSeedV;
  // Light travels up from the roots when the tree wakes: a moving front.
  float front = clamp(uGlow * 1.9 - aDepth, 0.0, 1.0);
  vGlowLine = front * uGlow;

  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const TREE_FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3  uBarkColor;
uniform vec3  uGlowTint;
uniform float uNight;
uniform float uGlow;

varying vec3  vWorld;
varying vec3  vNormal;
varying float vDepth;
varying float vSeed;
varying float vGlowLine;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_COLOR}
${GLSL_LIGHTING}
${GLSL_ATMOSPHERE}

void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 viewDir = normalize(cameraPosition - vWorld);

  // Bark: vertical fissures, deeper on the trunk than on the twigs.
  float fissure = fbm(vec3(vWorld.xz * 6.0, vWorld.y * 1.4), 3);
  float bark = 0.72 + 0.4 * fissure * (1.0 - vDepth * 0.6);
  vec3 albedo = uBarkColor * bark;
  albedo = mix(albedo, albedo * vec3(1.1, 1.05, 0.95), vDepth * 0.4);

  vec3 lit = organicLighting(n, viewDir, albedo, 0.15, 0.4);
  lit += albedo * rimTerm(n, viewDir, 2.6) * 0.2;

  // The light in the grain, travelling outward from the roots.
  float vein = smoothstep(0.55, 1.0, abs(sin(vWorld.y * 3.4 + fissure * 5.0 + vSeed)));
  lit += uGlowTint * vGlowLine * (0.35 + vein * 1.1) * (1.0 + uNight);

  gl_FragColor = vec4(applyAtmosphere(lit, vWorld), 1.0);
}
`;

interface Limb {
  from: THREE.Vector3;
  to: THREE.Vector3;
  r0: number;
  r1: number;
  depth: number;
  dir: THREE.Vector3;
}

const FOLIAGE_VERTEX = /* glsl */ `
precision highp float;

attribute vec2 aCorner;
attribute vec4 aInst;      // xyz position, w size
attribute vec4 aInstB;     // depth along the branch, blossom flag, seed, sway

uniform float uGlow;
uniform float uSway;

varying vec3  vWorld;
varying vec3  vNormal;
varying vec2  vUv;
varying float vBlossom;
varying float vSeed;
varying float vGlowLine;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_WIND}

void main() {
  vec3 centre = aInst.xyz;
  float size = aInst.w;
  float blossom = aInstB.y;
  float seed = aInstB.z;

  // Clusters ride the same sway as the twigs that carry them.
  float amp = (0.10 + uWindStrength * 0.26) * uSway * aInstB.w;
  float w = windField(centre.xz) + windGust(centre.xz) * 1.4;
  centre += vec3(uWindDir.x, 0.0, uWindDir.y) * w * amp;
  centre.y += sin(uTime * 1.9 + seed * 6.28) * amp * 0.35;

  vec3 toCam = normalize(cameraPosition - centre);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
  vec3 up = cross(toCam, right);
  // Tilt each cluster differently so the canopy is not a wall of stickers.
  float tilt = seed * 6.28318;
  vec2 r = vec2(cos(tilt), sin(tilt));
  vec2 c = vec2(aCorner.x * r.x - aCorner.y * r.y, aCorner.x * r.y + aCorner.y * r.x);

  vWorld = centre + (right * c.x + up * c.y) * size;
  vNormal = toCam;
  vUv = aCorner * 0.5 + 0.5;
  vBlossom = blossom;
  vSeed = seed;
  vGlowLine = clamp(uGlow * 1.9 - aInstB.x, 0.0, 1.0) * uGlow;

  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

const FOLIAGE_FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3  uLeafColor;
uniform vec3  uBlossomColor;
uniform vec3  uGlowTint;
uniform float uNight;
uniform float uGlow;

varying vec3  vWorld;
varying vec3  vNormal;
varying vec2  vUv;
varying float vBlossom;
varying float vSeed;
varying float vGlowLine;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_COLOR}
${GLSL_LIGHTING}
${GLSL_ATMOSPHERE}

void main() {
  vec2 q = vUv * 2.0 - 1.0;
  float r = length(q);

  if (vBlossom > 0.5) {
    // A tiny tulip: a soft cup, brightest at its throat.
    if (r > 1.0) discard;
    float cup = 1.0 - smoothstep(0.35, 1.0, r);
    vec3 col = mix(uBlossomColor, uBlossomColor * 1.5 + vec3(0.1), cup);
    col += uGlowTint * (0.35 + vGlowLine * 1.6) * cup * (1.0 + uNight * 1.4);
    gl_FragColor = vec4(applyAtmosphere(col, vWorld), cup * 0.95);
    return;
  }

  // A cluster of small leaves: several overlapping lobes, cut out by noise so
  // the silhouette is broken rather than a disc.
  float mask = 1.0 - smoothstep(0.55, 1.0, r);
  float breakup = fbm(vec3(q * 3.2 + vSeed * 17.0, 0.0), 3) * 0.5 + 0.5;
  mask *= smoothstep(0.30, 0.62, breakup);
  if (mask < 0.22) discard;

  vec3 n = normalize(vNormal + vec3(q * 0.7, 0.0));
  vec3 viewDir = normalize(cameraPosition - vWorld);
  vec3 albedo = uLeafColor * (0.72 + 0.55 * breakup);
  vec3 lit = organicLighting(n, viewDir, albedo, 0.9, 0.7);
  lit += uGlowTint * vGlowLine * 0.35;

  gl_FragColor = vec4(applyAtmosphere(lit, vWorld), smoothstep(0.22, 0.5, mask));
}
`;

export class SecretTree {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  readonly foliageMaterial: THREE.ShaderMaterial;
  /** World position of the hidden flower — THE FIRST TULIP. */
  readonly firstTulipPos = new THREE.Vector3();
  /** 0..1 how awake the tree is. */
  glow = 0;

  private mesh: THREE.Mesh;
  private foliage: THREE.Mesh;
  private rng: Rng;
  private targetGlow = 0;

  constructor(uniforms: WorldUniforms, settings: QualitySettings, seed = 1889) {
    this.rng = makeRandom(seed);
    const baseY = terrainHeight(TREE.x, TREE.z);
    const origin = new THREE.Vector3(TREE.x, baseY, TREE.z);

    const limbs: Limb[] = [];
    const maxDepth = settings.tier === 'performance' ? 5 : settings.tier === 'beautiful' ? 6 : 7;
    this.grow(limbs, origin, new THREE.Vector3(0, 1, 0), 5.6, 0.62, 0, maxDepth);

    const geo = this.buildGeometry(limbs, settings.tier === 'performance' ? 4 : 6);

    this.material = new THREE.ShaderMaterial({
      vertexShader: TREE_VERTEX,
      fragmentShader: TREE_FRAGMENT,
      uniforms: uniforms.organic({
        uBarkColor: { value: srgb(0x6b5c4c) },
        uGlowTint: { value: srgb(0xffcf8a) },
        uGlow: { value: 0 },
        uSway: { value: 1 },
      }),
      side: THREE.FrontSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'SecretTree';
    this.mesh.matrixAutoUpdate = false;
    this.group.add(this.mesh);
    this.group.name = 'SecretTreeGroup';

    // --- Foliage ------------------------------------------------------------
    this.foliageMaterial = new THREE.ShaderMaterial({
      vertexShader: FOLIAGE_VERTEX,
      fragmentShader: FOLIAGE_FRAGMENT,
      uniforms: uniforms.organic({
        uLeafColor: { value: srgb(0x5a6b45) },
        uBlossomColor: { value: srgb(0xe6a8bd) },
        uGlowTint: { value: srgb(0xffcf8a) },
        uGlow: { value: 0 },
        uSway: { value: 1 },
      }),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.foliage = new THREE.Mesh(
      this.buildFoliage(limbs, settings.tier === 'performance' ? 2 : 4),
      this.foliageMaterial,
    );
    this.foliage.name = 'SecretTreeFoliage';
    this.foliage.frustumCulled = true;
    this.foliage.matrixAutoUpdate = false;
    this.foliage.renderOrder = 3;
    this.group.add(this.foliage);

    // The hidden flower hangs from a low branch on the far side, where you
    // would only find it by walking around the trunk.
    const candidates = limbs.filter((l) => l.depth >= 2 && l.depth <= 3 && l.to.y - baseY > 3.4);
    const chosen = candidates.length
      ? candidates[Math.floor(this.rng() * candidates.length)]
      : limbs[limbs.length - 1];
    this.firstTulipPos.copy(chosen.to);
  }

  /**
   * Recursive growth. Each limb splits into two or three children whose
   * directions deviate from the parent and are pulled toward the ground with
   * depth — the droop of age.
   */
  private grow(
    out: Limb[], from: THREE.Vector3, dir: THREE.Vector3,
    length: number, radius: number, depth: number, maxDepth: number,
  ): void {
    if (depth > maxDepth || radius < 0.012) return;

    const to = from.clone().addScaledVector(dir, length);
    out.push({ from: from.clone(), to, r0: radius, r1: radius * 0.72, depth: depth / maxDepth, dir: dir.clone() });

    const children = depth === 0 ? 3 : this.rng() < 0.72 ? 2 : 3;
    for (let i = 0; i < children; i++) {
      const child = dir.clone();
      // Spread around the parent, biased so siblings do not overlap.
      const az = (i / children) * Math.PI * 2 + this.rng() * 1.1 + depth * 0.7;
      const spread = 0.42 + this.rng() * 0.45 + depth * 0.05;
      const side = new THREE.Vector3(Math.cos(az), 0, Math.sin(az))
        .sub(dir.clone().multiplyScalar(dir.dot(new THREE.Vector3(Math.cos(az), 0, Math.sin(az)))))
        .normalize();
      child.addScaledVector(side, spread);
      // Gravity: the further out, the more it hangs.
      child.y -= depth * 0.16 + this.rng() * 0.08;
      child.normalize();

      this.grow(
        out, to, child,
        length * (0.66 + this.rng() * 0.16),
        radius * (0.62 + this.rng() * 0.13),
        depth + 1, maxDepth,
      );
    }
  }

  private buildGeometry(limbs: Limb[], sides: number): THREE.BufferGeometry {
    const pos: number[] = [];
    const nrm: number[] = [];
    const depthA: number[] = [];
    const seedA: number[] = [];
    const dirA: number[] = [];
    const idx: number[] = [];

    const up = new THREE.Vector3();
    const right = new THREE.Vector3();
    const tmp = new THREE.Vector3();

    for (const l of limbs) {
      const base = pos.length / 3;
      const axis = tmp.copy(l.to).sub(l.from).normalize();
      // Any vector not parallel to the axis gives a stable frame.
      up.set(0, 1, 0);
      if (Math.abs(axis.dot(up)) > 0.94) up.set(1, 0, 0);
      right.crossVectors(axis, up).normalize();
      up.crossVectors(right, axis).normalize();

      const seed = this.rng();
      for (let ring = 0; ring < 2; ring++) {
        const p = ring === 0 ? l.from : l.to;
        const r = ring === 0 ? l.r0 : l.r1;
        for (let j = 0; j <= sides; j++) {
          const a = (j / sides) * Math.PI * 2;
          const nx = right.x * Math.cos(a) + up.x * Math.sin(a);
          const ny = right.y * Math.cos(a) + up.y * Math.sin(a);
          const nz = right.z * Math.cos(a) + up.z * Math.sin(a);
          pos.push(p.x + nx * r, p.y + ny * r, p.z + nz * r);
          nrm.push(nx, ny, nz);
          depthA.push(l.depth);
          seedA.push(seed);
          dirA.push(l.dir.x, l.dir.y, l.dir.z);
        }
      }
      const row = sides + 1;
      for (let j = 0; j < sides; j++) {
        const a = base + j;
        const b = a + 1;
        const c = a + row;
        const d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('aDepth', new THREE.Float32BufferAttribute(depthA, 1));
    geo.setAttribute('aSeedV', new THREE.Float32BufferAttribute(seedA, 1));
    geo.setAttribute('aBranchDir', new THREE.Float32BufferAttribute(dirA, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    // The sway displaces vertices, so pad the culling bounds.
    if (geo.boundingSphere) geo.boundingSphere.radius += 2;
    return geo;
  }

  /**
   * Leaf clusters on the outer limbs, plus a scattering of tiny tulip blossoms
   * — the brief's "branches contain tiny glowing tulip blossoms". Billboards
   * rather than modelled leaves: at the distances the tree is ever seen from,
   * a cluster reads better than geometry and costs a fraction as much.
   */
  private buildFoliage(limbs: Limb[], perLimb: number): THREE.BufferGeometry {
    const corners: number[] = [];
    const inst: number[] = [];
    const instB: number[] = [];
    const idx: number[] = [];

    const tips = limbs.filter((l) => l.depth > 0.45);
    let n = 0;
    const dir = new THREE.Vector3();
    for (const l of tips) {
      const count = Math.max(1, Math.round(perLimb * (l.depth * 1.4)));
      for (let i = 0; i < count; i++) {
        // Spread along the outer part of the limb, offset off its axis.
        const t = 0.35 + this.rng() * 0.75;
        dir.copy(l.to).sub(l.from);
        const px = l.from.x + dir.x * t + (this.rng() - 0.5) * 0.55;
        const py = l.from.y + dir.y * t + (this.rng() - 0.5) * 0.45;
        const pz = l.from.z + dir.z * t + (this.rng() - 0.5) * 0.55;

        // Blossoms are rare, and rarer on the inner limbs.
        const blossom = this.rng() < 0.055 * l.depth ? 1 : 0;
        const size = blossom ? 0.10 + this.rng() * 0.07 : 0.34 + this.rng() * 0.34;

        inst.push(px, py, pz, size);
        instB.push(l.depth, blossom, this.rng(), 0.4 + l.depth * 0.9);
        n++;
      }
    }

    const geo = new THREE.InstancedBufferGeometry();
    corners.push(-1, -1, 1, -1, -1, 1, 1, 1);
    idx.push(0, 1, 2, 2, 1, 3);
    geo.setAttribute('aCorner', new THREE.Float32BufferAttribute(corners, 2));
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    geo.setIndex(idx);
    geo.setAttribute('aInst', new THREE.InstancedBufferAttribute(new Float32Array(inst), 4));
    geo.setAttribute('aInstB', new THREE.InstancedBufferAttribute(new Float32Array(instB), 4));
    geo.instanceCount = n;

    // Bounds cover the canopy plus the sway headroom.
    let cx = 0, cy = 0, cz = 0, maxR = 0;
    for (let i = 0; i < n; i++) { cx += inst[i * 4]; cy += inst[i * 4 + 1]; cz += inst[i * 4 + 2]; }
    if (n > 0) { cx /= n; cy /= n; cz /= n; }
    for (let i = 0; i < n; i++) {
      maxR = Math.max(maxR, Math.hypot(inst[i * 4] - cx, inst[i * 4 + 1] - cy, inst[i * 4 + 2] - cz));
    }
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), maxR + 2.5);
    return geo;
  }

  /** Called with the distance of whoever is nearest; the tree lights up. */
  setProximity(distance: number): void {
    this.targetGlow = distance < 26 ? 1 - Math.max(0, (distance - 6) / 20) : 0;
  }

  update(dt: number): void {
    // Slow to wake, slower to sleep: it should feel reluctant.
    this.glow = damp(this.glow, this.targetGlow, this.targetGlow > this.glow ? 0.45 : 0.25, dt);
    this.material.uniforms.uGlow.value = this.glow;
    this.foliageMaterial.uniforms.uGlow.value = this.glow;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.foliage.geometry.dispose();
    this.foliageMaterial.dispose();
  }
}
