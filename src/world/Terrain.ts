import * as THREE from 'three';
import { POND } from './Landmarks';

/**
 * The ground.
 *
 * The height field is built from sines and nothing else. That is a deliberate
 * constraint: the CPU (placing tulips, walking her across the field, floating
 * petals) and the GPU (displacing the terrain mesh) must agree on where the
 * ground is to the millimetre, and two implementations of simplex noise never
 * quite do. Sines are exactly reproducible in both languages.
 *
 * The centre of the world is flattened so she has level ground to dance on, and
 * the pond sits in a real basin carved out of the same function — the water
 * plane is not a decal floating over flat ground.
 */

export const TERRAIN_SIZE = 3000;

/** Rolling hills, before the flattening and the pond basin. */
function hills(x: number, z: number): number {
  return (
    2.35 * Math.sin(x * 0.0121 + 0.7) * Math.cos(z * 0.0107 - 1.3) +
    1.35 * Math.sin((x * 0.83 + z * 0.55) * 0.0261 + 2.1) +
    0.62 * Math.sin(x * 0.0533 - 1.1) * Math.sin(z * 0.0487 + 0.4) +
    0.26 * Math.sin((x * 0.6 - z * 0.8) * 0.1105 + 3.3) +
    0.11 * Math.sin(x * 0.212 + 1.9) * Math.cos(z * 0.198 - 0.6)
  );
}

/**
 * Distant land rises far outside the playable field to close the horizon.
 *
 * The rise must be clamped. Left unbounded it reaches a few hundred metres at
 * the edge of the ground disc, and because height fog thins with altitude, a
 * wall that tall correctly computes as barely hazed — you get a hard, saturated
 * green ridge standing in front of the sky. Capped, the far hills stay inside
 * the fog layer and dissolve into it the way distance should.
 */
function distantRelief(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const rise = Math.min(1, Math.max(0, (r - 300) / 900));
  const shape =
    Math.sin(x * 0.0037 + 1.4) * Math.cos(z * 0.0031 - 2.2) * 0.6 +
    Math.sin((x + z) * 0.0021 + 0.3) * 0.4;
  return rise * rise * (22 + shape * 26);
}

export function terrainHeight(x: number, z: number): number {
  let h = hills(x, z);

  // Level the heart of the garden.
  const rc = Math.hypot(x, z);
  const flat = smoothstepF(16, 62, rc);
  h *= flat;

  // Carve the pond basin.
  const pd = Math.hypot(x - POND.x, z - POND.z);
  const basin = 1 - smoothstepF(POND.radius * 0.35, POND.radius + POND.rim, pd);
  h -= basin * POND.depth * 1.55;

  h += distantRelief(x, z);
  return h;
}

function smoothstepF(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Surface normal by central difference — used to tilt tulips onto slopes. */
export function terrainNormal(x: number, z: number, eps = 0.6): THREE.Vector3 {
  const hL = terrainHeight(x - eps, z);
  const hR = terrainHeight(x + eps, z);
  const hD = terrainHeight(x, z - eps);
  const hU = terrainHeight(x, z + eps);
  return new THREE.Vector3(hL - hR, 2 * eps, hD - hU).normalize();
}

/** Water surface height of the pond, in world units. */
export const POND_WATER_Y = -POND.depth * 0.62;

/** True if this ground position is submerged. */
export function isUnderWater(x: number, z: number): boolean {
  return terrainHeight(x, z) < POND_WATER_Y;
}

/**
 * The GLSL twin of the functions above. Any change here must be mirrored in the
 * TypeScript, and vice versa — they are two halves of one contract.
 */
export const GLSL_TERRAIN = /* glsl */ `
float terrainHills(vec2 p) {
  return 2.35 * sin(p.x * 0.0121 + 0.7) * cos(p.y * 0.0107 - 1.3)
       + 1.35 * sin((p.x * 0.83 + p.y * 0.55) * 0.0261 + 2.1)
       + 0.62 * sin(p.x * 0.0533 - 1.1) * sin(p.y * 0.0487 + 0.4)
       + 0.26 * sin((p.x * 0.6 - p.y * 0.8) * 0.1105 + 3.3)
       + 0.11 * sin(p.x * 0.212 + 1.9) * cos(p.y * 0.198 - 0.6);
}

float terrainDistantRelief(vec2 p) {
  float r = length(p);
  float rise = clamp((r - 300.0) / 900.0, 0.0, 1.0);
  float shape = sin(p.x * 0.0037 + 1.4) * cos(p.y * 0.0031 - 2.2) * 0.6
              + sin((p.x + p.y) * 0.0021 + 0.3) * 0.4;
  return rise * rise * (22.0 + shape * 26.0);
}

float terrainHeight(vec2 p) {
  float h = terrainHills(p);
  float rc = length(p);
  h *= smoothstep(16.0, 62.0, rc);

  vec2 pondC = vec2(${POND.x.toFixed(1)}, ${POND.z.toFixed(1)});
  float pd = distance(p, pondC);
  float basin = 1.0 - smoothstep(${(POND.radius * 0.35).toFixed(3)}, ${(POND.radius + POND.rim).toFixed(1)}, pd);
  h -= basin * ${(POND.depth * 1.55).toFixed(4)};

  h += terrainDistantRelief(p);
  return h;
}

vec3 terrainNormal(vec2 p, float eps) {
  float hL = terrainHeight(p - vec2(eps, 0.0));
  float hR = terrainHeight(p + vec2(eps, 0.0));
  float hD = terrainHeight(p - vec2(0.0, eps));
  float hU = terrainHeight(p + vec2(0.0, eps));
  return normalize(vec3(hL - hR, 2.0 * eps, hD - hU));
}

const float POND_WATER_Y = ${POND_WATER_Y.toFixed(4)};
`;
