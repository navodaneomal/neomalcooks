import * as THREE from 'three';
import { GLSL_TERRAIN } from './Terrain';
import { GLSL_HASH, GLSL_NOISE, GLSL_COLOR, GLSL_WIND, GLSL_LIGHTING, GLSL_ATMOSPHERE } from '../shaders/common';
import { GLSL_INFLUENCE, GLSL_WAVE } from '../core/WorldUniforms';
import type { WorldUniforms } from '../core/WorldUniforms';
import type { QualitySettings } from '../core/Quality';
import { paletteUniformArrays, HUE_COUNT } from './Palette';
import { srgb } from '../core/Colors';

/**
 * The ground, and the trick that makes the field endless.
 *
 * Geometry tulips only exist within `fieldRadius` — past that they would be
 * sub-pixel and cost everything for nothing. So the terrain shader *paints* the
 * continuation: beyond the geometry it mixes the same tulip palette into the
 * ground with the same density motif and the same wind field driving the
 * shading. The handover is a distance blend, and because both halves answer to
 * one wind function the painted field ripples in step with the real one.
 *
 * The mesh is a radial disc whose rings space out quadratically, so the metre
 * in front of the camera gets real resolution and the kilometre at the horizon
 * costs almost nothing.
 */

const GROUND_VERTEX = /* glsl */ `
precision highp float;

uniform float uNight;
uniform float uWetness;
uniform float uDream;

varying vec3 vWorld;
varying vec3 vNormal;
varying float vDist;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_TERRAIN}

void main() {
  vec3 p = position;
  vec2 xz = p.xz;
  float h = terrainHeight(xz);
  p.y = h;

  vWorld = p;
  vNormal = terrainNormal(xz, 0.85);
  vDist = distance(cameraPosition, p);

  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const GROUND_FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3  uPaletteBase[${HUE_COUNT}];
uniform vec3  uPaletteTip[${HUE_COUNT}];
uniform vec3  uSoilColor;
uniform vec3  uGrassColor;
uniform float uFieldRadius;
uniform float uSpawnRadius;
uniform vec2  uSpawnOrigin;
uniform float uNight;
uniform float uWetness;
uniform float uDream;
uniform float uWonder;
uniform float uMagic;
uniform float uAudioLevel;

varying vec3 vWorld;
varying vec3 vNormal;
varying float vDist;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_COLOR}
${GLSL_WIND}
${GLSL_INFLUENCE}
${GLSL_WAVE}
${GLSL_LIGHTING}
${GLSL_ATMOSPHERE}

/**
 * The same rosette motif the CPU uses to place tulips (see TulipField).
 * Keeping them in agreement is what makes the painted far field look like a
 * continuation of the real one rather than a different field behind it.
 */
float tulipMotif(vec2 p) {
  float best = 0.0;
  for (int i = 0; i < 2; i++) {
    float R = (i == 0) ? 158.0 : 58.0;
    float rot = (i == 0) ? 0.0 : 0.5235988;
    float r = length(p) / R;
    float th = atan(p.y, p.x) + rot;
    float lobe = 0.70 + 0.30 * cos(6.0 * th);
    float v = 1.0 - smoothstep(0.66, 1.0, r / max(lobe, 0.15));
    if (i == 1) v *= 0.92;
    best = max(best, v);
  }
  return best;
}

/** How thick the painted tulip cover is at a ground position. */
float paintedDensity(vec2 p) {
  float r = length(p);
  // Well past the geometry field the sea thins out into meadow and hills.
  float reach = 1.0 - smoothstep(uFieldRadius * 2.6, uFieldRadius * 7.5, r);
  float motif = 0.55 + 0.65 * tulipMotif(p);
  float clumps = 0.5 + 0.5 * fbm(vec3(p * 0.021, 0.0), 3);
  return clamp(reach * motif * clumps, 0.0, 1.0);
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 viewDir = normalize(cameraPosition - vWorld);
  vec2 p = vWorld.xz;

  // --- Soil and meadow ------------------------------------------------------
  // Layered at three scales: fine grain you only see underfoot, metre-scale
  // patchiness, and broad drifts across the field. A single noise octave here
  // is the difference between ground and a green plane.
  float grain    = fbm(vec3(p * 2.4, 0.0), 3) * 0.5 + 0.5;
  float patchy   = fbm(vec3(p * 0.22, 5.0), 3) * 0.5 + 0.5;
  float drifts   = fbm(vec3(p * 0.045, 11.0), 3) * 0.5 + 0.5;

  vec3 soil = uSoilColor * (0.70 + 0.55 * grain);
  // Earth is never one brown: warm where it is dry, cooler where it is not.
  soil = mix(soil, soil * vec3(1.14, 0.98, 0.86), smoothstep(0.5, 0.95, patchy));

  vec3 meadow = uGrassColor * (0.62 + 0.62 * drifts);
  meadow = mix(meadow, meadow * vec3(0.88, 1.05, 0.82), smoothstep(0.35, 0.8, patchy));

  // Bare earth shows through wherever the cover thins, not only on slopes.
  float bare = smoothstep(0.62, 0.90, 1.0 - patchy * 0.7 - drifts * 0.4);
  float slope = 1.0 - clamp(n.y, 0.0, 1.0);
  bare = max(bare, smoothstep(0.10, 0.38, slope) * 0.9);
  vec3 base = mix(meadow, soil, clamp(bare, 0.0, 1.0));

  // Planted ground carries faint rows. Barely legible on the ground, and part
  // of what makes the aerial reveal read as a cultivated field.
  float rows = sin(dot(p, vec2(0.9063, 0.4226)) * 1.35) * 0.5 + 0.5;
  base *= 0.94 + 0.12 * rows * smoothstep(0.2, 0.6, drifts);

  // Contact shade: the ground under a dense stand of flowers is in shadow.
  // Cheap, and it stops the tulips reading as stickers on a lawn.
  float shade = fbm(vec3(p * 1.1, 21.0), 2) * 0.5 + 0.5;
  base *= mix(1.0, 0.66, shade * 0.8);

  // --- Blade-scale texture --------------------------------------------------
  // No instance budget can reach real grass density, so the ground itself has
  // to read as grass rather than as a surface with grass standing on it. These
  // are streaks of noise stretched along a slowly-turning local lie, which is
  // what a lawn looks like from standing height. Faded out with distance so it
  // never aliases into a shimmer.
  float near = clamp(1.0 - vDist / 26.0, 0.0, 1.0);
  if (near > 0.01) {
    float lie = fbm(vec3(p * 0.075, 3.0), 2) * 3.14159;
    vec2 bd = vec2(cos(lie), sin(lie));
    vec2 bp = vec2(dot(p, bd) * 58.0, dot(p, vec2(-bd.y, bd.x)) * 8.0);
    float blades = snoise(vec3(bp, 0.0)) * 0.5 + 0.5;
    // A second, finer pass breaks up the regularity of the first.
    blades = blades * 0.72 + (snoise(vec3(bp * 2.7 + 31.0, 0.0)) * 0.5 + 0.5) * 0.28;
    base *= mix(1.0, 0.62 + 0.78 * blades, near);
  }

  // --- The painted tulip sea ------------------------------------------------
  float density = paintedDensity(p);
  // Do not compete with the real flowers standing in front of the camera —
  // but *do* take over wherever they are too far away to resolve. Keying the
  // second term on camera distance rather than world position is what makes the
  // aerial reveal work: from three hundred metres up the whole field is painted,
  // while at eye level the ground under your feet stays bare for the geometry.
  float handover = max(
    smoothstep(uFieldRadius * 0.55, uFieldRadius * 1.35, length(p)),
    smoothstep(55.0, 165.0, vDist));
  // And do not paint anything the awakening has not reached yet.
  float awake = smoothstep(-6.0, 10.0, uSpawnRadius - distance(p, uSpawnOrigin));
  float cover = density * handover * awake;

  if (cover > 0.001) {
    // Pick a hue per clump so the painted field has the same colour variety as
    // the geometry one, rather than being a flat wash of pink.
    float clumpId = floor(hash21(floor(p * 0.35)) * 1000.0);
    float sel = hash11(clumpId * 0.017);
    int hi = int(clamp(floor(sel * float(${HUE_COUNT})), 0.0, ${(HUE_COUNT - 1).toFixed(1)}));
    vec3 cB = uPaletteBase[0];
    vec3 cT = uPaletteTip[0];
    for (int i = 0; i < ${HUE_COUNT}; i++) {
      if (i == hi) { cB = uPaletteBase[i]; cT = uPaletteTip[i]; }
    }
    // Weight the wash toward pink the way the real palette is weighted.
    vec3 pinkish = mix(uPaletteBase[0], uPaletteTip[1], 0.45);
    vec3 flowerCol = mix(pinkish, mix(cB, cT, 0.55), 0.55);

    // Wind moving across the painted field, in step with the real one.
    float w = windField(p) * 0.5 + 0.5;
    float ripple = 0.72 + 0.5 * w;
    // Individual flower speckle, fading out with distance so it never aliases.
    float speckle = fbm(vec3(p * 2.2, 0.0), 2) * 0.5 + 0.5;
    speckle = mix(1.0, 0.68 + 0.6 * speckle, clamp(1.0 - vDist / 120.0, 0.0, 1.0));

    vec3 painted = flowerCol * ripple * speckle;
    // A bloom wave lights the painted field too.
    painted += vec3(1.0, 0.85, 0.72) * bloomWaveAt(p) * 0.5;
    base = mix(base, painted, cover * 0.92);
  }

  // Trodden ground brightens very slightly where something is moving.
  base += vec3(0.05, 0.045, 0.05) * influenceAt(p) * 0.5;

  base *= mix(1.0, 0.78, uWetness);

  vec3 lit = organicLighting(n, viewDir, base, 0.12, 0.35);

  // Wet ground turns specular and reflective.
  if (uWetness > 0.01) {
    vec3 h = normalize(viewDir + uSunDir);
    lit += uSunColor * pow(clamp(dot(n, h), 0.0, 1.0), 44.0) * uWetness * 0.5;
  }

  lit += vec3(1.0, 0.86, 0.7) * bloomWaveAt(p) * 0.18;

  if (uDream > 0.001) {
    float l = luma(lit);
    lit = mix(lit, mix(vec3(l), lit, 0.5) + vec3(0.04, 0.03, 0.06), uDream * 0.55);
  }

  vec3 finalColor = applyAtmosphere(lit, vWorld);
  gl_FragColor = vec4(finalColor, 1.0);
}
`;

export class Ground {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  constructor(uniforms: WorldUniforms, settings: QualitySettings) {
    const palette = paletteUniformArrays();

    const rings = settings.tier === 'performance' ? 78 : settings.tier === 'beautiful' ? 108 : 140;
    const radials = settings.tier === 'performance' ? 96 : settings.tier === 'beautiful' ? 128 : 168;
    const maxR = 1900;

    const geo = this.buildDisc(rings, radials, maxR);

    this.material = new THREE.ShaderMaterial({
      vertexShader: GROUND_VERTEX,
      fragmentShader: GROUND_FRAGMENT,
      uniforms: uniforms.organic({
        uPaletteBase: { value: palette.base },
        uPaletteTip: { value: palette.tip },
        uSoilColor: { value: srgb(0x5d4a38) },
        uGrassColor: { value: srgb(0x4a5530) },
        uFieldRadius: { value: settings.fieldRadius },
        uSpawnRadius: { value: -1 },
        uSpawnOrigin: { value: new THREE.Vector2(0, 0) },
        uMagic: { value: 1 },
      }),
      side: THREE.FrontSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'Ground';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 0;
  }

  /**
   * Radial disc with quadratically-spaced rings: fine detail underfoot, coarse
   * at the horizon, and no seams because it is one continuous fan.
   */
  private buildDisc(rings: number, radials: number, maxR: number): THREE.BufferGeometry {
    const verts: number[] = [];
    const idx: number[] = [];

    // Centre vertex.
    verts.push(0, 0, 0);

    for (let i = 1; i <= rings; i++) {
      const t = i / rings;
      const r = Math.pow(t, 2.35) * maxR;
      for (let j = 0; j < radials; j++) {
        const a = (j / radials) * Math.PI * 2;
        verts.push(Math.cos(a) * r, 0, Math.sin(a) * r);
      }
    }

    // Fan from the centre to the first ring. Wound so the faces point *up*:
    // with FrontSide culling, the obvious ordering points them at the bedrock.
    for (let j = 0; j < radials; j++) {
      const a = 1 + j;
      const b = 1 + ((j + 1) % radials);
      idx.push(0, b, a);
    }

    // Quad strips between rings.
    for (let i = 0; i < rings - 1; i++) {
      const r0 = 1 + i * radials;
      const r1 = 1 + (i + 1) * radials;
      for (let j = 0; j < radials; j++) {
        const jn = (j + 1) % radials;
        const a = r0 + j;
        const b = r0 + jn;
        const c = r1 + j;
        const d = r1 + jn;
        idx.push(a, b, c, b, d, c);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx);
    // Displacement happens in the vertex shader, so the CPU-side bounds must be
    // stated explicitly and generously.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), maxR * 1.5);
    return geo;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
