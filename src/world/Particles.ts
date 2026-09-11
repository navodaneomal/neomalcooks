import * as THREE from 'three';
import { GLSL_HASH, GLSL_NOISE, GLSL_WIND, GLSL_ATMOSPHERE, GLSL_LIGHTING } from '../shaders/common';
import { GLSL_INFLUENCE, GLSL_WAVE } from '../core/WorldUniforms';
import type { WorldUniforms } from '../core/WorldUniforms';
import type { QualitySettings } from '../core/Quality';
import { GLSL_TERRAIN } from './Terrain';
import { srgb } from '../core/Colors';
import { makeRandom } from '../core/MathUtils';

/**
 * Air.
 *
 * Three systems, all simulated entirely in the vertex shader from a per-particle
 * seed and the clock, and all wrapped around the camera the way the grass is.
 * That means pollen, petals and rain cost one draw call each and no CPU work at
 * all, and they exist wherever the viewer happens to be rather than only near
 * the origin.
 *
 * Because the motion is a closed-form function of time rather than an
 * integration, particles can be scrubbed, paused, or reversed for the rewind
 * without any state to unwind.
 */

/** Shared preamble: everything the three systems need to place a particle. */
const PARTICLE_COMMON = /* glsl */ `
uniform vec3  uCamPos;
uniform vec3  uBox;        // half-extents of the wrap volume
uniform float uAmount;     // 0..1 global visibility
uniform vec3  uHerPos;     // her position, for the petals she trails
uniform float uHerWind;    // how strongly she is stirring the air

/** Wrap a world position into the box centred on the camera. */
vec3 wrapToCamera(vec3 p) {
  vec3 rel = p - uCamPos;
  rel = mod(rel + uBox, uBox * 2.0) - uBox;
  return uCamPos + rel;
}

/** Slow curling air current — what makes drift read as air, not as fall. */
vec3 airCurrent(vec3 p, float t) {
  float s = 0.045;
  return vec3(
    snoise(vec3(p.xz * s, t * 0.07)),
    snoise(vec3(p.zx * s + 11.3, t * 0.05)) * 0.55,
    snoise(vec3(p.xy * s - 7.1, t * 0.065))
  );
}
`;

// ---------------------------------------------------------------------------
// Pollen / motes
// ---------------------------------------------------------------------------

const MOTE_VERTEX = /* glsl */ `
precision highp float;

attribute vec3 aSeed;      // 0..1 per particle
attribute float aKind;     // 0 pollen, 1 dust, 2 spark

uniform float uPixelRatio;
uniform float uSizeScale;
uniform float uNight;
uniform float uWonder;
uniform float uDream;
uniform float uMagic;

varying float vAlpha;
varying vec3  vTint;
varying float vKind;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_WIND}
${GLSL_INFLUENCE}
${GLSL_WAVE}
${GLSL_TERRAIN}
${PARTICLE_COMMON}

void main() {
  float t = uTime;
  float seedF = aSeed.x * 613.0 + aSeed.y * 271.0 + aSeed.z * 97.0;

  // Home position, drifting downwind forever; the wrap keeps it in view.
  vec3 base = (aSeed * 2.0 - 1.0) * uBox;
  float speed = 0.35 + aSeed.z * 0.9;
  base.x += uWindDir.x * t * speed * uWindStrength;
  base.z += uWindDir.y * t * speed * uWindStrength;
  base.y += sin(t * (0.13 + aSeed.y * 0.2) + seedF) * 0.9;

  vec3 p = wrapToCamera(base);
  p += airCurrent(p, t) * (0.7 + aSeed.x * 1.4);

  // Particles gather around whatever is moving (brief §02, §06).
  vec2 push = influencePush(p.xz);
  float pull = influenceAt(p.xz);
  p.xz -= push * 0.9;
  // And rise toward her when she raises her hands.
  p.y += pull * uHerWind * 2.2;

  // Stay in the layer of air just above the flowers.
  float ground = terrainHeight(p.xz);
  float layer = 0.15 + aSeed.y * 3.4 + uDream * 3.0;
  p.y = ground + layer + fract(p.y * 0.13) * 0.8;

  float dist = distance(p, uCamPos);

  // --- Look -----------------------------------------------------------------
  float size = mix(0.8, 2.0, aSeed.x) * uSizeScale;
  float alpha = uAmount * (0.10 + 0.20 * aSeed.z);

  if (aKind > 1.5) {
    // Sparks: rarer, brighter, and only really present during a moment.
    float excite = max(uWonder, bloomWaveAt(p.xz));
    alpha *= excite * 2.4;
    size *= 1.7 + excite;
    vTint = vec3(1.0, 0.86, 0.62);
  } else if (aKind > 0.5) {
    vTint = mix(vec3(0.86, 0.88, 0.94), vec3(0.62, 0.68, 0.9), uNight);
    alpha *= 0.7;
  } else {
    // Pollen glows warm, and more at night.
    vTint = mix(vec3(1.0, 0.93, 0.74), vec3(0.95, 0.82, 0.68), uNight);
    alpha *= 1.0 + uNight * 0.25 + pull * 1.0;
  }

  // Fade at both ends: nothing pops in at the wrap edge or crowds the lens.
  alpha *= 1.0 - smoothstep(uBox.x * 0.55, uBox.x * 0.95, dist);
  alpha *= smoothstep(0.6, 3.0, dist);

  vAlpha = clamp(alpha, 0.0, 1.0);
  vKind = aKind;

  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  // Perspective-correct point size, clamped so nothing becomes a screen-filling
  // square when it drifts past the lens.
  // Capped hard: a mote that drifts close to the lens must stay a speck, not
  // become a screen-filling disc.
  gl_PointSize = clamp(size * uPixelRatio * (16.0 / max(-mv.z, 1.0)), 1.0, 11.0);
}
`;

const MOTE_FRAGMENT = /* glsl */ `
precision highp float;
varying float vAlpha;
varying vec3  vTint;
varying float vKind;

void main() {
  // Round, soft-edged, brighter in the middle.
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float fall = 1.0 - r2 * 4.0;
  float a = vAlpha * fall * fall;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vTint * (0.6 + fall * 0.9), a);
}
`;

export class MoteField {
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;

  constructor(uniforms: WorldUniforms, settings: QualitySettings, seed = 3131) {
    const rng = makeRandom(seed);
    const n = settings.ambientParticles;
    const seeds = new Float32Array(n * 3);
    const kinds = new Float32Array(n);
    const dummy = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      seeds[i * 3] = rng();
      seeds[i * 3 + 1] = rng();
      seeds[i * 3 + 2] = rng();
      const r = rng();
      kinds[i] = r < 0.60 ? 0 : r < 0.90 ? 1 : 2;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(dummy, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    geo.setAttribute('aKind', new THREE.BufferAttribute(kinds, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      vertexShader: MOTE_VERTEX,
      fragmentShader: MOTE_FRAGMENT,
      uniforms: uniforms.organic({
        uCamPos: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(46, 14, 46) },
        uAmount: { value: 1 },
        uHerPos: { value: new THREE.Vector3() },
        uHerWind: { value: 0 },
        uPixelRatio: { value: 1 },
        uSizeScale: { value: 1 },
      }),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.name = 'Motes';
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
  }

  update(camera: THREE.Camera, pixelRatio: number): void {
    (this.material.uniforms.uCamPos.value as THREE.Vector3).copy(camera.position);
    this.material.uniforms.uPixelRatio.value = pixelRatio;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Drifting petals
// ---------------------------------------------------------------------------

const PETAL_VERTEX = /* glsl */ `
precision highp float;

attribute vec2 aCorner;    // -1..1 quad corner
attribute vec4 aSeed;      // x,y,z placement + w variation
attribute vec3 aColor;

uniform float uNight;
uniform float uDream;
uniform float uWonder;

varying vec2  vUv;
varying vec3  vColor;
varying float vAlpha;
varying vec3  vWorld;
varying vec3  vNormal;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_WIND}
${GLSL_INFLUENCE}
${GLSL_WAVE}
${GLSL_TERRAIN}
${PARTICLE_COMMON}

void main() {
  float t = uTime;
  float sd = aSeed.w;

  vec3 base = (aSeed.xyz * 2.0 - 1.0) * uBox;
  float speed = 0.7 + aSeed.z * 1.5;
  base.x += uWindDir.x * t * speed * (0.4 + uWindStrength);
  base.z += uWindDir.y * t * speed * (0.4 + uWindStrength);

  vec3 p = wrapToCamera(base);

  // A third of the petals are the ones she is carrying with her: they start at
  // her feet and are pushed outward, so her movement really does look like it
  // is breathing petals into the field (brief §07).
  float hers = step(0.66, sd);
  if (hers > 0.5) {
    float phase = fract(sd * 13.7 + t * 0.09);
    vec3 outward = normalize(vec3(cos(sd * 41.0), 0.35, sin(sd * 41.0)));
    p = mix(p, uHerPos + outward * phase * (7.0 + uHerWind * 16.0)
                + vec3(0.0, phase * 2.2, 0.0), uHerWind);
  }

  // Falling and fluttering. Petals do not drop, they tumble.
  float fallPhase = fract(sd * 7.3 + t * 0.045 * speed);
  float ground = terrainHeight(p.xz);
  p.y = ground + 0.25 + fallPhase * (5.5 + uDream * 6.0);
  p += airCurrent(p, t) * 1.1;
  p.xz -= influencePush(p.xz) * 1.4;

  // --- Orient the quad ------------------------------------------------------
  float spin = t * (0.9 + sd * 2.2) + sd * 62.8;
  vec3 right = normalize(vec3(cos(spin), sin(spin * 0.7) * 0.8, sin(spin)));
  vec3 up = normalize(cross(right, vec3(sin(spin * 0.4), 1.0, cos(spin * 0.4))));
  float size = mix(0.035, 0.085, fract(sd * 3.1));

  vec3 world = p + (right * aCorner.x + up * aCorner.y) * size;

  float dist = distance(world, uCamPos);
  float a = uAmount;
  a *= 1.0 - smoothstep(uBox.x * 0.5, uBox.x * 0.92, dist);
  a *= smoothstep(0.2, 1.0, dist);
  // Fade out as they settle, so nothing visibly intersects the ground.
  a *= smoothstep(0.0, 0.14, fallPhase);

  vUv = aCorner * 0.5 + 0.5;
  vColor = aColor;
  vAlpha = clamp(a, 0.0, 1.0);
  vWorld = world;
  vNormal = normalize(cross(right, up));

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const PETAL_FRAGMENT = /* glsl */ `
precision highp float;

uniform float uNight;

varying vec2  vUv;
varying vec3  vColor;
varying float vAlpha;
varying vec3  vWorld;
varying vec3  vNormal;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_LIGHTING}
${GLSL_ATMOSPHERE}

void main() {
  // A petal outline rather than a square: narrow base, round shoulders.
  vec2 q = vUv * 2.0 - 1.0;
  float w = pow(max(sin(3.14159 * pow(clamp(vUv.y, 0.0, 1.0), 1.2)), 0.0), 0.6);
  float inside = step(abs(q.x), w);
  if (inside < 0.5) discard;

  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 viewDir = normalize(cameraPosition - vWorld);

  vec3 lit = organicLighting(n, viewDir, vColor, 1.0, 0.7);
  lit += vColor * uNight * 0.25;

  float edge = smoothstep(0.0, 0.22, w - abs(q.x));
  gl_FragColor = vec4(applyAtmosphere(lit, vWorld), vAlpha * edge);
}
`;

export class PetalDrift {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  constructor(uniforms: WorldUniforms, settings: QualitySettings, palette: THREE.Color[], seed = 771) {
    const rng = makeRandom(seed);
    const n = Math.max(60, Math.round(settings.ambientParticles * 0.16));

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('aCorner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, -1, 1, 1, 1], 2));
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    geo.setIndex([0, 1, 2, 2, 1, 3]);

    const seeds = new Float32Array(n * 4);
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      seeds[i * 4] = rng();
      seeds[i * 4 + 1] = rng();
      seeds[i * 4 + 2] = rng();
      seeds[i * 4 + 3] = rng();
      const c = palette[Math.floor(rng() * palette.length)];
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));
    geo.instanceCount = n;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      vertexShader: PETAL_VERTEX,
      fragmentShader: PETAL_FRAGMENT,
      uniforms: uniforms.organic({
        uCamPos: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(34, 8, 34) },
        uAmount: { value: 1 },
        uHerPos: { value: new THREE.Vector3() },
        uHerWind: { value: 0 },
      }),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'Petals';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
  }

  update(camera: THREE.Camera): void {
    (this.material.uniforms.uCamPos.value as THREE.Vector3).copy(camera.position);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Rain
// ---------------------------------------------------------------------------

const RAIN_VERTEX = /* glsl */ `
precision highp float;

attribute vec2 aCorner;
attribute vec3 aSeed;

uniform float uRain;
uniform float uNight;

varying float vAlpha;
varying vec2  vUv;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_WIND}
${GLSL_TERRAIN}
${PARTICLE_COMMON}

void main() {
  float t = uTime;
  vec3 base = (aSeed * 2.0 - 1.0) * uBox;
  // Rain is blown along by the same wind everything else answers to.
  base.x += uWindDir.x * t * 2.4 * uWindStrength;
  base.z += uWindDir.y * t * 2.4 * uWindStrength;
  vec3 p = wrapToCamera(base);

  float ground = terrainHeight(p.xz);
  float speed = 13.0 + aSeed.z * 7.0;
  float top = ground + uBox.y * 1.5;
  float fall = fract(aSeed.y * 17.3 + t * speed / (uBox.y * 3.0));
  p.y = mix(top, ground, fall);

  // Streak: a thin quad stretched along the fall direction, leaned by the wind.
  vec3 dir = normalize(vec3(uWindDir.x * 0.30 * uWindStrength, -1.0,
                            uWindDir.y * 0.30 * uWindStrength));
  vec3 toCam = normalize(uCamPos - p);
  vec3 side = normalize(cross(dir, toCam));

  float len = 0.55 + aSeed.z * 0.65;
  vec3 world = p + dir * (aCorner.y * len * 0.5) + side * (aCorner.x * 0.006);

  float dist = distance(world, uCamPos);
  float a = uRain * (0.30 + aSeed.x * 0.30);
  a *= 1.0 - smoothstep(uBox.x * 0.45, uBox.x * 0.9, dist);
  a *= smoothstep(0.3, 2.0, dist);
  // Fade the last moment before it lands so drops do not clip into the ground.
  a *= 1.0 - smoothstep(0.90, 1.0, fall);

  vAlpha = clamp(a, 0.0, 1.0);
  vUv = aCorner * 0.5 + 0.5;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const RAIN_FRAGMENT = /* glsl */ `
precision highp float;
uniform vec3 uRainTint;
varying float vAlpha;
varying vec2 vUv;
void main() {
  // Soft along the streak, sharp across it.
  float a = vAlpha * smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.7, 1.0, vUv.y));
  if (a < 0.004) discard;
  gl_FragColor = vec4(uRainTint, a);
}
`;

export class Rain {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  constructor(uniforms: WorldUniforms, settings: QualitySettings, seed = 5150) {
    const rng = makeRandom(seed);
    const n = settings.rainDrops;

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('aCorner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, -1, 1, 1, 1], 2));
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    geo.setIndex([0, 1, 2, 2, 1, 3]);

    const seeds = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) seeds[i] = rng();
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
    geo.instanceCount = n;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      vertexShader: RAIN_VERTEX,
      fragmentShader: RAIN_FRAGMENT,
      uniforms: uniforms.organic({
        uCamPos: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(20, 11, 20) },
        uAmount: { value: 1 },
        uHerPos: { value: new THREE.Vector3() },
        uHerWind: { value: 0 },
        uRain: { value: 0 },
        uRainTint: { value: srgb(0xc8d6e6) },
      }),
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'Rain';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 8;
  }

  update(camera: THREE.Camera, rain: number): void {
    (this.material.uniforms.uCamPos.value as THREE.Vector3).copy(camera.position);
    this.material.uniforms.uRain.value = rain;
    // Skip the draw call entirely when it is not raining.
    this.mesh.visible = rain > 0.01;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
