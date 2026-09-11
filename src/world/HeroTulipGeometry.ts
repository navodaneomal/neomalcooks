import * as THREE from 'three';

/**
 * The hero tulip's geometry: a lily-flowered tulip.
 *
 * The reference this is built from has pointed, strongly reflexed tepals in
 * layered whorls — which is not the blunt-tipped cup of the field tulips, but
 * it is not an invention either: *Tulipa* 'lily-flowered' cultivars have
 * exactly that silhouette. So the flower can match the reference frame for
 * frame and still be a tulip, which the brief insists on.
 *
 * Three whorls of six rather than a botanical two of three: this is the brief's
 * rare "magical tulip", and the extra layer is what gives the bloom its depth
 * when it opens.
 *
 * Attribute layout mirrors the field tulip so the two shaders can share
 * vocabulary:
 *   aFlags  (part, u, azimuth, attachHeight)
 *            part: 0 stem, 1 leaf, 2 tepal, 3 stamen, 4 receptacle
 *   aShape  (whorl, v, lengthScale, widthScale)
 */

export const HERO = {
  /** Canonical proportions, stem height = 1. */
  tepalLength: 0.40,
  tepalHalfWidth: 0.150,
  tepalBaseRadius: 0.016,
  tepalCup: 0.52,
  leafLength: 0.52,
  leafHalfWidth: 0.062,
  stemBaseRadius: 0.013,
  stemTopRadius: 0.0092,
  stamenLength: 0.15,
} as const;

export const GLSL_HERO_CONST = /* glsl */ `
const float H_TEPAL_LENGTH = ${HERO.tepalLength};
const float H_TEPAL_BASE_R = ${HERO.tepalBaseRadius};
const float H_LEAF_LENGTH  = ${HERO.leafLength};
const float H_STAMEN_LEN   = ${HERO.stamenLength};
`;

/**
 * Lily-flowered outline: widest low, drawn out to a real point.
 * (The field tulip's profile peaks higher and stays broad at 90% — that blunt
 * shoulder is what makes it read as a classic cup rather than this.)
 */
function tepalWidth(u: number): number {
  return Math.pow(Math.sin(Math.PI * Math.pow(u, 0.85)), 0.92);
}

function leafWidth(u: number): number {
  return Math.pow(Math.sin(Math.PI * Math.pow(u, 0.92)), 0.8);
}

class Builder {
  pos: number[] = [];
  flags: number[] = [];
  shape: number[] = [];
  idx: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  vert(
    x: number, y: number, z: number,
    part: number, u: number, az: number, attach: number,
    whorl: number, v: number, lenScale: number, widthScale: number,
  ): void {
    this.pos.push(x, y, z);
    this.flags.push(part, u, az, attach);
    this.shape.push(whorl, v, lenScale, widthScale);
  }

  grid(base: number, segU: number, segV: number): void {
    const row = segV + 1;
    for (let i = 0; i < segU; i++) {
      for (let j = 0; j < segV; j++) {
        const a = base + i * row + j;
        const b = a + 1;
        const c = a + row;
        const d = c + 1;
        this.idx.push(a, c, b, b, c, d);
      }
    }
  }
}

function addTepal(
  mb: Builder, az: number, whorl: number,
  segU: number, segV: number, lenScale: number, widthScale: number,
): void {
  const base = mb.count;
  for (let i = 0; i <= segU; i++) {
    // Bias toward the tip: that is where the reflex curve lives and where a
    // coarse sampling shows as a crease.
    const u = Math.pow(i / segU, 0.88);
    const w = tepalWidth(u) * HERO.tepalHalfWidth * widthScale;
    for (let j = 0; j <= segV; j++) {
      const v = (j / segV) * 2 - 1;
      const x = v * w;
      const y = u * HERO.tepalLength * lenScale;
      // Channelled, easing off toward the point so the tip is flat, not folded.
      const z = -HERO.tepalCup * v * v * w * (1 - u * 0.55);
      mb.vert(x, y, z, 2, u, az, 1, whorl, v, lenScale, widthScale);
    }
  }
  mb.grid(base, segU, segV);
}

function addLeaf(
  mb: Builder, az: number, index: number, attach: number,
  segU: number, segV: number, lenScale: number,
): void {
  const base = mb.count;
  for (let i = 0; i <= segU; i++) {
    const u = i / segU;
    const w = leafWidth(u) * HERO.leafHalfWidth;
    for (let j = 0; j <= segV; j++) {
      const v = (j / segV) * 2 - 1;
      mb.vert(v * w, u * HERO.leafLength * lenScale, -0.85 * Math.abs(v) * w,
        1, u, az, attach, index, v, lenScale, 1);
    }
  }
  mb.grid(base, segU, segV);
}

function addStem(mb: Builder, sides: number, rings: number): void {
  const base = mb.count;
  for (let i = 0; i <= rings; i++) {
    const u = i / rings;
    const r = (HERO.stemBaseRadius + (HERO.stemTopRadius - HERO.stemBaseRadius) * u) *
      (1 + 0.22 * Math.sin(Math.PI * u) * u);
    for (let j = 0; j <= sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      mb.vert(Math.cos(a) * r, u, Math.sin(a) * r, 0, u, a, u, 0, 0, 1, 1);
    }
  }
  mb.grid(base, rings, sides);
}

/** The receptacle: a small dome the tepals spring from, and the flower's core. */
function addReceptacle(mb: Builder, sides: number, rings: number): void {
  const base = mb.count;
  const R = 0.034;
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const phi = t * Math.PI * 0.52;
    const r = Math.sin(phi) * R;
    const y = (1 - Math.cos(phi)) * R * 1.35;
    for (let j = 0; j <= sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      mb.vert(Math.cos(a) * r, y, Math.sin(a) * r, 4, t, a, 1, 0, 0, 1, 1);
    }
  }
  mb.grid(base, rings, sides);
}

/**
 * Stamens. Six filaments with anthers, plus a central pistil — the bright
 * star at the middle of the reference bloom is this, lit from inside.
 */
function addStamens(mb: Builder, count: number, segU: number, sides: number): void {
  for (let k = 0; k <= count; k++) {
    const isPistil = k === count;
    const az = (k / count) * Math.PI * 2;
    const lean = isPistil ? 0 : 0.30;
    const len = isPistil ? HERO.stamenLength * 0.78 : HERO.stamenLength;
    const base = mb.count;
    for (let i = 0; i <= segU; i++) {
      const u = i / segU;
      // Anthers swell at the top; the pistil stays a slim column.
      const swell = isPistil
        ? 1 - u * 0.25
        : 1 + 5.5 * Math.max(0, u - 0.66) * (1 - Math.max(0, u - 0.94) * 8);
      const r = 0.0042 * Math.max(swell, 0.15);
      const out = Math.sin(u * Math.PI * 0.5) * lean * len;
      for (let j = 0; j <= sides; j++) {
        const a = (j / sides) * Math.PI * 2;
        mb.vert(
          Math.cos(a) * r + out,
          u * len,
          Math.sin(a) * r,
          3, u, az, 1, isPistil ? 1 : 0, 0, 1, 1,
        );
      }
    }
    mb.grid(base, segU, sides);
  }
}

export type HeroLod = 'high' | 'mid';

export function buildHeroTulipGeometry(lod: HeroLod): THREE.BufferGeometry {
  const high = lod === 'high';
  const mb = new Builder();

  addStem(mb, high ? 7 : 5, high ? 6 : 3);
  addReceptacle(mb, high ? 12 : 7, high ? 4 : 2);
  addStamens(mb, 6, high ? 5 : 3, high ? 5 : 3);

  for (let i = 0; i < 2; i++) {
    addLeaf(mb, 0.6 + i * 2.45, i, 0.05 + i * 0.17, high ? 6 : 3, high ? 3 : 1, 1 - i * 0.22);
  }

  // Three whorls, each rotated so no tepal hides directly behind another —
  // that offset is what makes the open bloom read as layered rather than flat.
  const segU = high ? 12 : 6;
  const segV = high ? 6 : 2;
  const whorls: [number, number, number][] = [
    // azimuth offset, length scale, width scale
    [0, 1.0, 1.0],
    [Math.PI / 6, 0.90, 0.86],
    [Math.PI / 12, 0.76, 0.70],
  ];
  for (let w = 0; w < whorls.length; w++) {
    const [offset, lenScale, widthScale] = whorls[w];
    for (let k = 0; k < 6; k++) {
      addTepal(mb, (k / 6) * Math.PI * 2 + offset, w, segU, segV, lenScale, widthScale);
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
