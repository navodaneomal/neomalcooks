import * as THREE from 'three';
import { GLSL_ATMOSPHERE } from '../shaders/common';
import { GLSL_SKY, GLSL_SKY_UNIFORMS } from '../shaders/skyLib';
import { GLSL_INFLUENCE } from '../core/WorldUniforms';
import type { WorldUniforms } from '../core/WorldUniforms';
import type { Sky } from './Sky';
import { GLSL_TERRAIN, POND_WATER_Y, terrainHeight } from './Terrain';
import { POND } from './Landmarks';
import { srgb } from '../core/Colors';

/**
 * THE MIRROR POND (brief §13).
 *
 * The reflection is evaluated analytically: the view ray is mirrored about the
 * water plane and fed straight into the shared sky function, so the pond shows
 * the real clouds, the real stars, the real moon and the real sunset — not a
 * second approximation that would slowly disagree with the sky above it. The
 * surrounding tulips are folded in from the same painted-field colour the
 * ground uses, so the bank reflects the bank.
 *
 * What it deliberately does *not* do is a second scene render. A planar
 * reflection pass would cost a whole extra draw of the world for one small body
 * of water; this costs a handful of instructions and is indistinguishable at
 * the distances the pond is ever seen from.
 *
 * Her reflection is handled by the Dancer, which draws a mirrored, slightly
 * delayed copy of her over this surface — that is where the pond's one piece of
 * real magic lives.
 */

const WATER_VERTEX = /* glsl */ `
precision highp float;
varying vec3 vWorld;
varying vec2 vLocal;
void main() {
  vWorld = position;
  vLocal = position.xz;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

const WATER_FRAGMENT = /* glsl */ `
precision highp float;

${GLSL_SKY_UNIFORMS}

// uWindDir / uWindStrength / uNight / uDream already arrive with the shared
// sky block above; re-declaring them here is a compile error.
uniform vec3  uDeepColor;
uniform vec3  uShallowColor;
uniform vec3  uTulipTint;
uniform vec2  uCentre;
uniform float uRadius;
uniform float uRain;
uniform float uWetness;
uniform float uEnergy;
uniform float uAudioMid;
uniform float uAudioBass;

varying vec3 vWorld;
varying vec2 vLocal;

${GLSL_SKY}
${GLSL_INFLUENCE}
${GLSL_ATMOSPHERE}
${GLSL_TERRAIN}

/**
 * The surface height field: two travelling wave trains, a noise term to break
 * their regularity, a musical term, and expanding rings where rain lands.
 */
float waterHeight(vec2 p, float t) {
  vec2 d1 = normalize(uWindDir + vec2(0.15, 0.0));
  vec2 d2 = normalize(vec2(-uWindDir.y, uWindDir.x) + vec2(0.0, 0.2));
  // Deliberately gentle. It is a mirror pond: ripples steep enough to see as
  // waves scatter the reflection into foam and the water stops reflecting
  // anything at all.
  float amp = 0.006 + uWindStrength * 0.011;

  float h = 0.0;
  h += sin(dot(p, d1) * 1.30 - t * 1.1) * amp;
  h += sin(dot(p, d2) * 2.05 + t * 1.4) * amp * 0.55;
  h += snoise(vec3(p * 0.85, t * 0.35)) * amp * 0.85;
  h += snoise(vec3(p * 2.40, t * 0.55)) * amp * 0.30;
  // The music moves the water too (brief §23).
  h += sin(dot(p, d1) * 3.4 - t * 2.2) * uAudioMid * 0.008;

  // Rain stipples the surface with expanding rings.
  if (uRain > 0.01) {
    vec2 cell = floor(p * 2.6);
    float rnd = hash21(cell);
    float ring = fract(t * 0.9 + rnd * 7.0);
    vec2 c = (cell + 0.5 + vec2(hash21(cell + 3.1), hash21(cell - 5.7)) * 0.6) / 2.6;
    float dr = abs(distance(p, c) - ring * 0.42);
    h += (1.0 - smoothstep(0.0, 0.030, dr)) * (1.0 - ring) * uRain * 0.030;
  }
  return h;
}

/**
 * Central differences of the height field.
 *
 * It has to be the *same* function on both sides of the difference. Comparing
 * the full height against a partial reconstruction of it — which is what a
 * hand-inlined gradient tends to become — leaves a constant bias that reads as
 * hard stripes across the water rather than as ripples.
 */
vec3 waterNormal(vec2 p, float t) {
  float e = 0.03;
  float hL = waterHeight(p - vec2(e, 0.0), t);
  float hR = waterHeight(p + vec2(e, 0.0), t);
  float hD = waterHeight(p - vec2(0.0, e), t);
  float hU = waterHeight(p + vec2(0.0, e), t);
  return normalize(vec3((hL - hR) / (2.0 * e), 1.0, (hD - hU) / (2.0 * e)));
}

void main() {
  vec2 p = vLocal;
  float rFromCentre = distance(p, uCentre);
  // The pond has a real edge; beyond it there is no water.
  if (rFromCentre > uRadius) discard;

  float t = uTime;
  vec3 n = waterNormal(p, t);
  // Movement near the bank disturbs the surface.
  n.xz += influencePush(p) * 0.08;
  n = normalize(n);

  vec3 viewDir = normalize(cameraPosition - vWorld);
  vec3 refl = reflect(-viewDir, n);
  // A ray that would point into the water instead grazes along the surface.
  refl.y = abs(refl.y) * 0.92 + 0.02;

  vec3 reflected = skyRadiance(refl);

  // The bank reflects the bank: fold the tulip colour in for shallow, grazing
  // rays, which is where the surrounding flowers would actually appear. Scaled
  // by how much light there actually is — at night the bank is not pink, it is
  // barely there, and a constant tint turns the whole pond into milk.
  float graze = 1.0 - clamp(refl.y * 2.6, 0.0, 1.0);
  float bankNear = smoothstep(uRadius * 0.45, uRadius, rFromCentre);
  float daylight = clamp(uSunIntensity * (1.0 - uNight * 0.85), 0.0, 1.6);
  reflected = mix(reflected, uTulipTint * (0.10 + daylight * 0.5),
                  graze * (0.26 + bankNear * 0.34) * (0.25 + daylight * 0.6));

  // --- Body colour ----------------------------------------------------------
  // Depth from the real basin the terrain carves, so the shallows read shallow.
  float bed = terrainHeight(p);
  float depth = clamp((POND_WATER_Y - bed) / 2.2, 0.0, 1.0);
  vec3 body = mix(uShallowColor, uDeepColor, depth);
  body *= (0.20 + uSunIntensity * 0.30) * (1.0 - uNight * 0.70);

  // --- Fresnel --------------------------------------------------------------
  float f = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 4.0);
  f = mix(0.035, 1.0, f);
  vec3 col = mix(body, reflected, f);

  // Sun and moon glint.
  vec3 h = normalize(viewDir + uSunDir);
  col += uSunTint * pow(clamp(dot(n, h), 0.0, 1.0), 620.0) * uSunIntensity * 1.5;
  vec3 hm = normalize(viewDir + uMoonDir);
  col += vec3(0.8, 0.85, 1.0) * pow(clamp(dot(n, hm), 0.0, 1.0), 820.0) * uNight * 1.1;

  // --- Edge -----------------------------------------------------------------
  // Soften where the water meets the bank, and lighten it the way shallow water
  // over pale silt actually looks.
  float edge = 1.0 - smoothstep(uRadius - 1.6, uRadius, rFromCentre);
  col = mix(col * 1.12 + vec3(0.01) * (1.0 - uNight), col, smoothstep(0.0, 0.35, depth));

  float alpha = mix(0.62, 0.97, f) * edge;
  alpha = mix(alpha, 1.0, depth * 0.5);

  gl_FragColor = vec4(applyAtmosphere(col, vWorld), alpha);
}
`;

export class Pond {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly centre = new THREE.Vector2(POND.x, POND.z);
  readonly waterY = POND_WATER_Y;

  constructor(uniforms: WorldUniforms, sky: Sky) {
    const R = POND.radius;
    // A disc with enough tessellation that the analytic normals stay smooth
    // across the surface at a grazing angle.
    const geo = new THREE.CircleGeometry(R, 96);
    geo.rotateX(-Math.PI / 2);
    geo.translate(POND.x, POND_WATER_Y, POND.z);
    geo.computeBoundingSphere();

    const u: Record<string, THREE.IUniform> = {
      // Share every sky uniform by reference so the reflection can never drift.
      ...sky.uniforms,
      uWindDir: uniforms.wind.uWindDir,
      uWindStrength: uniforms.wind.uWindStrength,
      uGustPhase: uniforms.wind.uGustPhase,
      uFogColor: uniforms.atmosphere.uFogColor,
      uFogDensity: uniforms.atmosphere.uFogDensity,
      uFogHeight: uniforms.atmosphere.uFogHeight,
      uInfluence: uniforms.influence.uInfluence,
      uInfluenceCount: uniforms.influence.uInfluenceCount,
      uEnergy: uniforms.mood.uEnergy,
      uWetness: uniforms.mood.uWetness,
      uAudioMid: uniforms.mood.uAudioMid,
      uAudioBass: uniforms.mood.uAudioBass,
      uRain: { value: 0 },
      uDeepColor: { value: srgb(0x1d3444) },
      uShallowColor: { value: srgb(0x4a6b6a) },
      uTulipTint: { value: srgb(0xe8a8bd) },
      uCentre: { value: this.centre },
      uRadius: { value: R },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: WATER_VERTEX,
      fragmentShader: WATER_FRAGMENT,
      uniforms: u,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'Pond';
    this.mesh.renderOrder = 4;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  /** True if a ground position is inside the water. */
  contains(x: number, z: number): boolean {
    return Math.hypot(x - POND.x, z - POND.z) < POND.radius &&
      terrainHeight(x, z) < POND_WATER_Y;
  }

  update(rain: number): void {
    this.material.uniforms.uRain.value = rain;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
