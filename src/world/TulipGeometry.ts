import * as THREE from 'three';

/**
 * Procedural tulip.
 *
 * The mesh is authored in a *canonical* space and given up entirely to the
 * vertex shader for posing:
 *
 *   - the stem runs from y=0 to y=1 and is bent as a cantilever by the wind;
 *   - each leaf and petal is authored at the origin growing along +Y, carrying
 *     its own azimuth as an attribute rather than being pre-rotated;
 *   - petals open by *bending* — the strip is rolled around an arc whose
 *     curvature the shader chooses per frame — so a bud and a full bloom are
 *     the same triangles at different curvatures.
 *
 * That last point is the whole trick. Because opening is a curvature parameter
 * and not a keyframe, a hundred thousand tulips can each be at their own point
 * in their own bloom, reacting to wind, music, her footsteps and a passing
 * bloom wave, without the CPU touching a single vertex.
 *
 * Attribute layout (per vertex):
 *   position  canonical local position
 *   normal    canonical normal
 *   aFlags    (part, u, azimuth, attachHeight)
 *              part: 0 = stem, 1 = leaf, 2 = petal
 *              u: parameter along that element, 0 at its base
 *   aShape    (ring, v, lengthScale, widthScale)
 *              ring: 0 outer / 1 inner petal, or leaf index
 *              v: -1..1 across the width
 */

export type TulipLod = 'high' | 'mid' | 'low';

interface LodSpec {
  petalCount: number;
  petalSegU: number;
  petalSegV: number;
  stemSides: number;
  stemRings: number;
  leafCount: number;
  leafSegU: number;
  leafSegV: number;
}

function lodSpec(lod: TulipLod, petalSegments: number): LodSpec {
  switch (lod) {
    case 'high':
      return {
        petalCount: 6,
        petalSegU: Math.max(4, petalSegments),
        petalSegV: 2,
        stemSides: 5,
        stemRings: 4,
        leafCount: 2,
        leafSegU: 4,
        leafSegV: 2,
      };
    case 'mid':
      return {
        petalCount: 6,
        petalSegU: 3,
        petalSegV: 1,
        stemSides: 4,
        stemRings: 2,
        leafCount: 1,
        leafSegU: 2,
        leafSegV: 1,
      };
    case 'low':
    default:
      return {
        petalCount: 3,
        petalSegU: 2,
        petalSegV: 1,
        stemSides: 3,
        stemRings: 1,
        leafCount: 0,
        leafSegU: 0,
        leafSegV: 0,
      };
  }
}

/**
 * Canonical proportions, in units where the stem is exactly 1.0 tall.
 * Exported because the vertex shader needs the same numbers to pose the mesh —
 * TULIP_CONST is injected into the GLSL so the two can never drift apart.
 */
const PETAL_LENGTH = 0.245;
const PETAL_HALF_WIDTH = 0.085;
const PETAL_BASE_RADIUS = 0.014;
const PETAL_CUP = 0.62;
const LEAF_LENGTH = 0.46;
const LEAF_HALF_WIDTH = 0.055;
const STEM_BASE_RADIUS = 0.0105;
const STEM_TOP_RADIUS = 0.0072;

export const TULIP = {
  petalLength: PETAL_LENGTH,
  petalHalfWidth: PETAL_HALF_WIDTH,
  petalBaseRadius: PETAL_BASE_RADIUS,
  petalCup: PETAL_CUP,
  leafLength: LEAF_LENGTH,
  leafHalfWidth: LEAF_HALF_WIDTH,
  stemBaseRadius: STEM_BASE_RADIUS,
  stemTopRadius: STEM_TOP_RADIUS,
} as const;

/** GLSL constants mirroring TULIP, injected into the tulip vertex shader. */
export const GLSL_TULIP_CONST = /* glsl */ `
const float PETAL_LENGTH = ${PETAL_LENGTH};
const float PETAL_BASE_RADIUS = ${PETAL_BASE_RADIUS};
const float LEAF_LENGTH = ${LEAF_LENGTH};
`;

/** Tulip petal outline: narrow base, broad shoulders, blunt rounded tip. */
function petalWidth(u: number): number {
  return Math.pow(Math.sin(Math.PI * Math.pow(u, 1.25)), 0.55);
}

/** Leaf outline: lance-shaped, widest low, drawn to a point. */
function leafWidth(u: number): number {
  return Math.pow(Math.sin(Math.PI * Math.pow(u, 0.92)), 0.8);
}

class MeshBuilder {
  pos: number[] = [];
  flags: number[] = [];
  shape: number[] = [];
  idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  vert(
    x: number, y: number, z: number,
    part: number, u: number, az: number, attach: number,
    ring: number, v: number, lenScale: number, widthScale: number,
  ): void {
    this.pos.push(x, y, z);
    this.flags.push(part, u, az, attach);
    this.shape.push(ring, v, lenScale, widthScale);
  }

  /** Stitch a (segU+1) x (segV+1) vertex grid starting at `base`. */
  grid(base: number, segU: number, segV: number): void {
    const rowLen = segV + 1;
    for (let i = 0; i < segU; i++) {
      for (let j = 0; j < segV; j++) {
        const a = base + i * rowLen + j;
        const b = a + 1;
        const c = a + rowLen;
        const d = c + 1;
        this.idx.push(a, c, b, b, c, d);
      }
    }
  }
}

function addPetal(
  mb: MeshBuilder,
  az: number,
  ring: number,
  segU: number,
  segV: number,
  lenScale: number,
  widthScale: number,
): void {
  const base = mb.vertexCount;
  for (let i = 0; i <= segU; i++) {
    // Bias samples toward the tip where the silhouette curves most.
    const u = Math.pow(i / segU, 0.9);
    const w = petalWidth(u) * PETAL_HALF_WIDTH * widthScale;
    for (let j = 0; j <= segV; j++) {
      const v = (j / segV) * 2 - 1;
      const x = v * w;
      const y = u * PETAL_LENGTH * lenScale;
      // Channelled cross-section: the edges curl back toward the flower axis.
      const z = -PETAL_CUP * v * v * w;
      mb.vert(x, y, z, 2, u, az, 1, ring, v, lenScale, widthScale);
    }
  }
  mb.grid(base, segU, segV);
}

function addLeaf(
  mb: MeshBuilder,
  az: number,
  index: number,
  attach: number,
  segU: number,
  segV: number,
  lenScale: number,
): void {
  const base = mb.vertexCount;
  for (let i = 0; i <= segU; i++) {
    const u = i / segU;
    const w = leafWidth(u) * LEAF_HALF_WIDTH;
    for (let j = 0; j <= segV; j++) {
      const v = (j / segV) * 2 - 1;
      const x = v * w;
      const y = u * LEAF_LENGTH * lenScale;
      // Tulip leaves are strongly channelled — a V section, not a flat blade.
      const z = -0.85 * Math.abs(v) * w;
      mb.vert(x, y, z, 1, u, az, attach, index, v, lenScale, 1);
    }
  }
  mb.grid(base, segU, segV);
}

function addStem(mb: MeshBuilder, sides: number, rings: number): void {
  const base = mb.vertexCount;
  for (let i = 0; i <= rings; i++) {
    const u = i / rings;
    // Slight swell just under the flower, the way a real stalk thickens.
    const r =
      (STEM_BASE_RADIUS + (STEM_TOP_RADIUS - STEM_BASE_RADIUS) * u) *
      (1 + 0.22 * Math.sin(Math.PI * u) * u);
    for (let j = 0; j <= sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      mb.vert(Math.cos(a) * r, u, Math.sin(a) * r, 0, u, a, u, 0, 0, 1, 1);
    }
  }
  mb.grid(base, rings, sides);
}

export function buildTulipGeometry(lod: TulipLod, petalSegments: number): THREE.BufferGeometry {
  const spec = lodSpec(lod, petalSegments);
  const mb = new MeshBuilder();

  addStem(mb, spec.stemSides, spec.stemRings);

  for (let i = 0; i < spec.leafCount; i++) {
    const az = 0.6 + i * 2.45;
    const attach = 0.05 + i * 0.17;
    addLeaf(mb, az, i, attach, spec.leafSegU, spec.leafSegV, 1 - i * 0.22);
  }

  // Two whorls of three. The inner tepals of a tulip sit slightly shorter and
  // a little more upright than the outer ones; that offset is what stops the
  // cup reading as a plastic six-pointed star.
  const petals = spec.petalCount;
  const rings = petals >= 6 ? 2 : 1;
  const perRing = petals / rings;
  for (let ring = 0; ring < rings; ring++) {
    for (let k = 0; k < perRing; k++) {
      const az = (k / perRing) * Math.PI * 2 + (ring * Math.PI) / perRing;
      const lenScale = ring === 0 ? 1 : 0.93;
      const widthScale = ring === 0 ? 1 : 0.88;
      addPetal(mb, az, ring, spec.petalSegU, spec.petalSegV, lenScale, widthScale);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(mb.pos, 3));
  geo.setAttribute('aFlags', new THREE.Float32BufferAttribute(mb.flags, 4));
  geo.setAttribute('aShape', new THREE.Float32BufferAttribute(mb.shape, 4));
  geo.setIndex(mb.idx);
  geo.computeVertexNormals();
  return geo;
}

/** Triangle count, for the diagnostics readout. */
export function triangleCount(geo: THREE.BufferGeometry): number {
  const idx = geo.getIndex();
  return idx ? idx.count / 3 : 0;
}
