import * as THREE from 'three';
import { GLSL_HASH, GLSL_NOISE, GLSL_COLOR, GLSL_ROTATE, GLSL_WIND, GLSL_LIGHTING, GLSL_ATMOSPHERE } from '../shaders/common';
import { GLSL_INFLUENCE, GLSL_WAVE } from '../core/WorldUniforms';
import type { WorldUniforms } from '../core/WorldUniforms';
import type { QualitySettings } from '../core/Quality';
import { GLSL_TERRAIN } from './Terrain';
import { srgb } from '../core/Colors';
import { makeRandom } from '../core/MathUtils';

/**
 * Grass that follows the camera.
 *
 * Blades are laid out once in a square tile and then *wrapped* around the
 * camera in the vertex shader, so a fixed budget of instances always lands
 * wherever the viewer actually is — she can walk to the far side of the world
 * and the grass is already there. The wrap arithmetic leaves each blade
 * stationary in world space until it crosses the tile edge, and blades fade to
 * nothing before they reach it, so the jump is never visible.
 *
 * Everything else about a blade — height, width, lean, colour, phase — is
 * hashed from its final world position rather than stored, which keeps the
 * instance data down to two floats and means a blade looks the same every time
 * you walk past it.
 */

const GRASS_VERTEX = /* glsl */ `
precision highp float;

attribute vec2 aTile;    // position within the wrap tile
attribute vec2 aBlade;   // u along the blade, v across it

uniform vec2  uCamXZ;
uniform float uHalfTile;
uniform float uFadeStart;
uniform float uFadeEnd;
uniform vec3  uGrassA;
uniform vec3  uGrassB;
uniform vec3  uGrassDry;
uniform float uDream;
uniform float uWetness;
uniform float uReverse;
uniform float uAudioBass;
uniform float uSpawnRadius;
uniform vec2  uSpawnOrigin;

varying vec3  vWorld;
varying vec3  vNormal;
varying vec3  vColor;
varying float vU;
varying float vFade;
varying float vGlow;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_ROTATE}
${GLSL_WIND}
${GLSL_INFLUENCE}
${GLSL_WAVE}
${GLSL_TERRAIN}

void main() {
  float u = aBlade.x;
  float v = aBlade.y;

  // --- Wrap the tile around the camera -------------------------------------
  // world stays fixed as the camera moves; a blade only jumps when it crosses
  // the tile edge, which is well past the fade-out.
  vec2 rel = aTile - uCamXZ;
  float T = uHalfTile * 2.0;
  rel = mod(rel + uHalfTile, T) - uHalfTile;
  vec2 world2 = uCamXZ + rel;

  // --- Identity, hashed from where it ended up ------------------------------
  float h1 = hash21(floor(world2 * 7.3));
  float h2 = hash21(floor(world2 * 7.3) + 31.7);
  float h3 = hash21(floor(world2 * 7.3) - 17.1);

  float groundY = terrainHeight(world2);

  float height = mix(0.13, 0.36, h1 * h1);
  // A real grass blade is 2-5mm across. The instance budget cannot approach
  // real density, so the blades have to at least be the right *size* — wide
  // ribbons read as reeds and give the whole field away.
  float width  = mix(0.0012, 0.0026, h2);
  float az     = h3 * 6.28318;

  // --- Visibility -----------------------------------------------------------
  float edge = max(abs(rel.x), abs(rel.y));
  // Fade out before the wrap boundary so the jump can never be seen.
  float tileFade = 1.0 - smoothstep(uHalfTile * 0.72, uHalfTile * 0.97, edge);
  float distFade = 1.0 - smoothstep(uFadeStart, uFadeEnd, length(rel));
  float awake = smoothstep(-4.0, 8.0, uSpawnRadius - distance(world2, uSpawnOrigin));
  // Nothing grows in the pond.
  float dry = step(POND_WATER_Y + 0.05, groundY);
  float fade = tileFade * distFade * awake * dry * (1.0 - uReverse);

  height *= fade;

  // --- Wind -----------------------------------------------------------------
  float w = windField(world2);
  float gust = windGust(world2);
  float bendMag = (w * 0.30 + gust * 0.55) * uWindStrength * (0.7 + 0.6 * h2);
  bendMag += uAudioBass * 0.10;
  // Blades are far floppier than stems, and always carry some droop.
  bendMag += 0.55 + h1 * 0.5;

  vec2 bendVec = uWindDir * bendMag + vec2(cos(az), sin(az)) * 0.22;
  bendVec += influencePush(world2) * 2.2;   // grass bends aside around movement
  float k = length(bendVec);
  vec2 bendDir = k > 1e-5 ? bendVec / k : vec2(1.0, 0.0);

  // --- Pose the blade as a bending strip -------------------------------------
  float s = u;
  float phi = k * s;
  float yy, dd;
  if (abs(k) < 1e-4) { yy = s; dd = 0.5 * k * s * s; }
  else { yy = sin(phi) / k; dd = (1.0 - cos(phi)) / k; }

  // Taper to a point, with a slight fold so the blade is not a flat ribbon.
  float halfW = width * pow(1.0 - u, 0.78);
  vec3 across = vec3(-bendDir.y, 0.0, bendDir.x);
  vec3 pos = vec3(bendDir.x * dd, yy, bendDir.y * dd) * height;
  pos += across * (v * halfW);
  // Curl the blade's cross-section slightly toward the ground.
  pos.y -= abs(v) * halfW * 0.55;

  vec3 world = vec3(world2.x, groundY, world2.y) + pos;
  world.y += uDream * 0.12 * h1;

  // The blade's normal: the strip's tangent crossed with its width axis.
  vec3 tangent = normalize(vec3(bendDir.x * sin(phi), cos(phi), bendDir.y * sin(phi)));
  vNormal = normalize(cross(across, tangent));
  // Always show the lit side rather than a randomly-backfacing blade.
  if (vNormal.y < 0.0) vNormal = -vNormal;

  // --- Colour ------------------------------------------------------------------
  float tint = fbm(vec3(world2 * 0.045, 0.0), 3) * 0.5 + 0.5;
  vec3 col = mix(uGrassA, uGrassB, tint);
  // A minority of blades have gone dry — that variation is most of what stops
  // a grass field reading as a green carpet.
  col = mix(col, uGrassDry, smoothstep(0.88, 1.0, h2) * 0.55);
  col *= 0.68 + 0.5 * u;                       // darker at the base
  col *= mix(1.0, 0.82, uWetness);

  vColor = col;
  vWorld = world;
  vU = u;
  vFade = fade;
  vGlow = bloomWaveAt(world2) * 0.5 + influenceAt(world2) * 0.25;

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const GRASS_FRAGMENT = /* glsl */ `
precision highp float;

uniform float uNight;
uniform float uWetness;
uniform vec3  uGlowTint;

varying vec3  vWorld;
varying vec3  vNormal;
varying vec3  vColor;
varying float vU;
varying float vFade;
varying float vGlow;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_COLOR}
${GLSL_LIGHTING}
${GLSL_ATMOSPHERE}

void main() {
  if (vFade < 0.01) discard;

  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 viewDir = normalize(cameraPosition - vWorld);

  vec3 lit = organicLighting(n, viewDir, vColor, 0.75, 0.6);
  lit += vColor * rimTerm(n, viewDir, 3.0) * 0.22;
  lit += uGlowTint * vGlow * 0.6;
  lit += uSunColor * uNight * pow(clamp(n.y, 0.0, 1.0), 4.0) * 0.10;

  gl_FragColor = vec4(applyAtmosphere(lit, vWorld), 1.0);
}
`;

export class GrassField {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private halfTile: number;

  constructor(uniforms: WorldUniforms, settings: QualitySettings, seed = 8812) {
    const rng = makeRandom(seed);
    const count = settings.grassCount;
    this.halfTile = settings.grassRadius;

    // --- Blade geometry (shared by every instance) --------------------------
    const segs = settings.tier === 'performance' ? 2 : settings.tier === 'beautiful' ? 3 : 4;
    const bladeUV: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      bladeUV.push(u, -1, u, 1);
    }
    for (let i = 0; i < segs; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('aBlade', new THREE.Float32BufferAttribute(bladeUV, 2));
    // `position` is required by three's shader prefix even though this shader
    // never reads it; a zero-filled attribute is the cheapest way to satisfy it.
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(bladeUV.length / 2 * 3), 3));
    geo.setIndex(idx);

    // --- Instance placement: uniform over the tile, as the wrap requires -----
    const tile = new Float32Array(count * 2);
    const R = this.halfTile;
    for (let i = 0; i < count; i++) {
      tile[i * 2] = (rng() * 2 - 1) * R;
      tile[i * 2 + 1] = (rng() * 2 - 1) * R;
    }
    geo.setAttribute('aTile', new THREE.InstancedBufferAttribute(tile, 2));
    geo.instanceCount = count;

    this.material = new THREE.ShaderMaterial({
      vertexShader: GRASS_VERTEX,
      fragmentShader: GRASS_FRAGMENT,
      uniforms: uniforms.organic({
        uCamXZ: { value: new THREE.Vector2(0, 0) },
        uHalfTile: { value: R },
        uFadeStart: { value: R * 0.55 },
        uFadeEnd: { value: R * 0.92 },
        uGrassA: { value: srgb(0x5f7347) },
        uGrassB: { value: srgb(0x778a54) },
        uGrassDry: { value: srgb(0x7d7d5e) },
        uGlowTint: { value: srgb(0xffd9a8) },
        uSpawnRadius: { value: -1 },
        uSpawnOrigin: { value: new THREE.Vector2(0, 0) },
      }),
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'GrassField';
    // The tile is defined relative to the camera, so it is always in view.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 1;
  }

  update(camera: THREE.Camera): void {
    const p = camera.position;
    (this.material.uniforms.uCamXZ.value as THREE.Vector2).set(p.x, p.z);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
