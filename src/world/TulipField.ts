import * as THREE from 'three';
import { TULIP_VERTEX, TULIP_FRAGMENT } from '../shaders/tulip';
import { buildTulipGeometry, triangleCount, type TulipLod } from './TulipGeometry';
import { terrainHeight, terrainNormal, POND_WATER_Y } from './Terrain';
import { LANDMARKS, POND } from './Landmarks';
import { GARDEN_PALETTES, HUE_INDEX, paletteUniformArrays, sampleHueIndex, LEAF_GREENS } from './Palette';
import type { WorldUniforms } from '../core/WorldUniforms';
import type { QualitySettings } from '../core/Quality';
import { makeRandom, clamp01, smoothstep, type Rng } from '../core/MathUtils';
import { srgb } from '../core/Colors';

/**
 * The endless sea of tulips.
 *
 * Instances live in flat Float32Arrays, bucketed into square chunks. Each chunk
 * is one draw call and one frustum-cull test, and swaps between three levels of
 * detail by distance — the mesh keeps its instance buffers and only the base
 * geometry pointer changes, so LOD costs nothing at runtime.
 */

/** Populations from the brief §03. */
export const enum TulipKind {
  Young = 0,
  Growing = 1,
  Mature = 2,
  Ancient = 3,
  Magical = 4,
}

export interface TulipRecord {
  x: number;
  z: number;
  y: number;
  scale: number;
  kind: TulipKind;
  hue: number;
  /** Index into the flat instance arrays. */
  index: number;
  chunk: number;
}

interface Chunk {
  cx: number;
  cz: number;
  center: THREE.Vector3;
  radius: number;
  count: number;
  mesh: THREE.Mesh;
  geos: Record<TulipLod, THREE.InstancedBufferGeometry>;
  lod: TulipLod;
  /** Byte offsets into the chunk's own instance arrays. */
  arrays: { a: THREE.InstancedBufferAttribute; b: THREE.InstancedBufferAttribute; c: THREE.InstancedBufferAttribute; d: THREE.InstancedBufferAttribute };
}

/**
 * Seen from high above, the field is not uniform: two nested six-lobed rosettes
 * bias both density and colour. It reads as texture at ground level and only
 * resolves into "a tulip inside a tulip" from the air, which is exactly the
 * restraint the brief asks for.
 */
export function tulipMotif(x: number, z: number): number {
  const motif = (R: number, rot: number): number => {
    const r = Math.hypot(x, z) / R;
    const th = Math.atan2(z, x) + rot;
    const lobe = 0.70 + 0.30 * Math.cos(6 * th);
    return 1 - smoothstep(0.66, 1.0, r / Math.max(lobe, 0.15));
  };
  return Math.max(motif(158, 0), motif(58, Math.PI / 6) * 0.92);
}

export class TulipField {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  readonly records: TulipRecord[] = [];
  readonly count: number;

  /** Flat instance data, shared with the per-chunk attributes by slicing. */
  private chunks: Chunk[] = [];
  private chunkOf = new Map<number, Chunk>();
  private baseGeos: Record<TulipLod, THREE.BufferGeometry>;
  private settings: QualitySettings;
  private tmpV = new THREE.Vector3();

  /** Spatial hash for "which tulip is nearest this point" queries. */
  private grid = new Map<number, number[]>();
  private gridCell = 4;

  constructor(uniforms: WorldUniforms, settings: QualitySettings, seed = 20240501) {
    this.settings = settings;
    const rng = makeRandom(seed);

    this.baseGeos = {
      high: buildTulipGeometry('high', settings.petalSegments),
      mid: buildTulipGeometry('mid', settings.petalSegments),
      low: buildTulipGeometry('low', settings.petalSegments),
    };

    const placed = this.place(rng, settings);
    this.count = placed.count;

    const palette = paletteUniformArrays();
    this.material = new THREE.ShaderMaterial({
      vertexShader: TULIP_VERTEX,
      fragmentShader: TULIP_FRAGMENT,
      uniforms: uniforms.organic({
        uPaletteBase: { value: palette.base },
        uPaletteTip: { value: palette.tip },
        uLeafColor: { value: srgb(LEAF_GREENS[0]) },
        uGlowTint: { value: srgb(0xffd9a8) },
        uSpawnRadius: { value: -1 },
        uSpawnWidth: { value: 14 },
        uSpawnOrigin: { value: new THREE.Vector2(0, 0) },
        uOpenBias: { value: 0 },
        uMagic: { value: 1 },
      }),
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
      depthTest: true,
    });

    this.buildChunks(placed);
    this.group.name = 'TulipField';
  }

  // -------------------------------------------------------------------------
  // Placement
  // -------------------------------------------------------------------------

  private place(rng: Rng, settings: QualitySettings) {
    const R = settings.fieldRadius;
    const target = settings.tulipCount;

    const xs: number[] = [];
    const zs: number[] = [];
    const hueForced: number[] = [];
    const kindHint: number[] = [];

    /** Density falls off from the heart of the garden, shaped by the motif. */
    const densityAt = (x: number, z: number): number => {
      const r = Math.hypot(x, z);
      if (r > R) return 0;
      const falloff = Math.exp(-r / (R * 0.46));
      const edge = 1 - smoothstep(R * 0.82, R, r);
      const motif = 0.72 + 0.5 * tulipMotif(x, z);
      return falloff * edge * motif;
    };

    // Rejection-sample a jittered grid. The grid guarantees even coverage; the
    // jitter and rejection give the natural clumping a real field has.
    const cell = 0.62;
    const cells = Math.ceil((R * 2) / cell);
    const maxAttempts = target * 7;
    let attempts = 0;

    while (xs.length < target && attempts < maxAttempts) {
      attempts++;
      const gx = Math.floor(rng() * cells);
      const gz = Math.floor(rng() * cells);
      const x = -R + (gx + rng()) * cell;
      const z = -R + (gz + rng()) * cell;
      const d = densityAt(x, z);
      if (d <= 0 || rng() > d) continue;
      // Nothing grows in the pond.
      if (terrainHeight(x, z) < POND_WATER_Y + 0.15) continue;
      xs.push(x);
      zs.push(z);
      hueForced.push(-1);
      kindHint.push(-1);
    }

    // --- Secret gardens: dense pockets with their own palettes ---------------
    for (const lm of LANDMARKS) {
      if (!lm.palette) continue;
      const pal = GARDEN_PALETTES[lm.palette];
      if (!pal) continue;
      const n = Math.round((lm.radius * lm.radius * 0.34) * (target / 118000) * 3.2) + 60;
      for (let i = 0; i < n; i++) {
        // Sample uniformly over the disc, denser toward the middle.
        const a = rng() * Math.PI * 2;
        const rr = Math.pow(rng(), 0.62) * lm.radius;
        const x = lm.x + Math.cos(a) * rr;
        const z = lm.z + Math.sin(a) * rr;
        if (terrainHeight(x, z) < POND_WATER_Y + 0.15) continue;
        // Keep the tree's own footprint clear.
        if (lm.id === 'tree' && rr < 4.2) continue;
        xs.push(x);
        zs.push(z);
        hueForced.push(pal[Math.floor(rng() * pal.length)]);
        kindHint.push(lm.palette === 'ancient' ? TulipKind.Ancient : -1);
      }
    }

    // A ring of tulips around the pond rim so the water sits *in* the garden.
    const rimCount = Math.round(260 * (target / 118000) + 90);
    for (let i = 0; i < rimCount; i++) {
      const a = rng() * Math.PI * 2;
      const rr = POND.radius + 1.5 + Math.pow(rng(), 0.7) * POND.rim * 1.7;
      const x = POND.x + Math.cos(a) * rr;
      const z = POND.z + Math.sin(a) * rr;
      if (terrainHeight(x, z) < POND_WATER_Y + 0.1) continue;
      xs.push(x);
      zs.push(z);
      hueForced.push(-1);
      kindHint.push(-1);
    }

    const count = xs.length;
    const instA = new Float32Array(count * 4);
    const instB = new Float32Array(count * 4);
    const instC = new Float32Array(count * 4);
    const instD = new Float32Array(count * 4);

    for (let i = 0; i < count; i++) {
      const x = xs[i];
      const z = zs[i];
      const y = terrainHeight(x, z);

      // --- Population ------------------------------------------------------
      let kind: TulipKind;
      const roll = rng();
      if (kindHint[i] >= 0) {
        kind = kindHint[i] as TulipKind;
      } else if (roll < 0.0009) kind = TulipKind.Magical;
      else if (roll < 0.006) kind = TulipKind.Ancient;
      else if (roll < 0.20) kind = TulipKind.Young;
      else if (roll < 0.46) kind = TulipKind.Growing;
      else kind = TulipKind.Mature;

      let scale: number;
      let bloomBase: number;
      let glow = 0;
      switch (kind) {
        case TulipKind.Young:
          scale = 0.19 + rng() * 0.14;
          bloomBase = 0.02 + rng() * 0.10;
          break;
        case TulipKind.Growing:
          scale = 0.32 + rng() * 0.16;
          bloomBase = 0.22 + rng() * 0.26;
          break;
        case TulipKind.Ancient:
          scale = 0.82 + rng() * 0.55;
          bloomBase = 0.55 + rng() * 0.35;
          glow = 0.05 + rng() * 0.06;
          break;
        case TulipKind.Magical:
          scale = 0.58 + rng() * 0.42;
          bloomBase = 0.5 + rng() * 0.45;
          glow = 0.45 + rng() * 0.55;
          break;
        case TulipKind.Mature:
        default:
          scale = 0.44 + rng() * 0.22;
          bloomBase = 0.5 + rng() * 0.4;
          break;
      }
      // Tulips at the edge of the field are a little shorter — atmosphere and
      // scale falloff together sell the distance.
      scale *= 0.9 + 0.2 * clamp01(1 - Math.hypot(x, z) / (R * 1.2));

      // --- Colour -----------------------------------------------------------
      let hue: number;
      if (hueForced[i] >= 0) {
        hue = hueForced[i];
      } else {
        hue = sampleHueIndex(rng());
        // The motif nudges colour as well as density: inside the rosette the
        // field runs a shade deeper.
        if (tulipMotif(x, z) > 0.55 && rng() < 0.3) {
          hue = rng() < 0.6 ? HUE_INDEX.softPink : HUE_INDEX.crimson;
        }
      }

      const n = terrainNormal(x, z);
      const o = i * 4;

      instA[o] = x;
      instA[o + 1] = y;
      instA[o + 2] = z;
      instA[o + 3] = rng() * Math.PI * 2;

      instB[o] = scale;
      instB[o + 1] = 0.85 + rng() * 0.34;
      instB[o + 2] = rng();
      instB[o + 3] = rng() * 1000;

      instC[o] = bloomBase;
      instC[o + 1] = kind;
      instC[o + 2] = hue;
      instC[o + 3] = glow;

      instD[o] = n.x;
      instD[o + 1] = n.z;
      instD[o + 2] = (rng() - 0.5) * 0.09;
      instD[o + 3] = rng();

      this.records.push({ x, z, y, scale, kind, hue, index: i, chunk: -1 });
    }

    return { count, instA, instB, instC, instD };
  }

  // -------------------------------------------------------------------------
  // Chunking
  // -------------------------------------------------------------------------

  private buildChunks(placed: {
    count: number;
    instA: Float32Array; instB: Float32Array; instC: Float32Array; instD: Float32Array;
  }): void {
    const { count, instA, instB, instC, instD } = placed;
    const cs = this.settings.chunkSize;

    const key = (cx: number, cz: number): number => (cx + 512) * 4096 + (cz + 512);
    const buckets = new Map<number, number[]>();

    for (let i = 0; i < count; i++) {
      const cx = Math.floor(instA[i * 4] / cs);
      const cz = Math.floor(instA[i * 4 + 2] / cs);
      const k = key(cx, cz);
      let arr = buckets.get(k);
      if (!arr) {
        arr = [];
        buckets.set(k, arr);
      }
      arr.push(i);
    }

    for (const [k, list] of buckets) {
      const n = list.length;
      if (n === 0) continue;

      const a = new Float32Array(n * 4);
      const b = new Float32Array(n * 4);
      const c = new Float32Array(n * 4);
      const d = new Float32Array(n * 4);

      let minY = Infinity;
      let maxY = -Infinity;
      let sx = 0;
      let sz = 0;
      let maxScale = 0;

      for (let j = 0; j < n; j++) {
        const i = list[j];
        for (let t = 0; t < 4; t++) {
          a[j * 4 + t] = instA[i * 4 + t];
          b[j * 4 + t] = instB[i * 4 + t];
          c[j * 4 + t] = instC[i * 4 + t];
          d[j * 4 + t] = instD[i * 4 + t];
        }
        const y = instA[i * 4 + 1];
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        sx += instA[i * 4];
        sz += instA[i * 4 + 2];
        maxScale = Math.max(maxScale, instB[i * 4]);
        this.records[i].chunk = this.chunks.length;
      }

      const attrA = new THREE.InstancedBufferAttribute(a, 4);
      const attrB = new THREE.InstancedBufferAttribute(b, 4);
      const attrC = new THREE.InstancedBufferAttribute(c, 4);
      const attrD = new THREE.InstancedBufferAttribute(d, 4);

      const center = new THREE.Vector3(sx / n, (minY + maxY) / 2 + maxScale * 0.6, sz / n);
      // Conservative: half a chunk diagonal, plus the tallest flower, plus the
      // headroom dream mode lifts the field into.
      const radius = Math.SQRT2 * cs * 0.5 + maxScale * 1.5 + (maxY - minY) * 0.5 + 2.5;

      const geos = {} as Record<TulipLod, THREE.InstancedBufferGeometry>;
      for (const lod of ['high', 'mid', 'low'] as TulipLod[]) {
        const base = this.baseGeos[lod];
        const g = new THREE.InstancedBufferGeometry();
        g.index = base.getIndex();
        g.setAttribute('position', base.getAttribute('position'));
        g.setAttribute('normal', base.getAttribute('normal'));
        g.setAttribute('aFlags', base.getAttribute('aFlags'));
        g.setAttribute('aShape', base.getAttribute('aShape'));
        g.setAttribute('aInstA', attrA);
        g.setAttribute('aInstB', attrB);
        g.setAttribute('aInstC', attrC);
        g.setAttribute('aInstD', attrD);
        g.instanceCount = n;
        // Instances carry world positions, so the bounds are world-space too.
        // Setting them by hand also stops three from computing bounds from the
        // single canonical flower sitting at the origin.
        g.boundingSphere = new THREE.Sphere(center.clone(), radius);
        g.boundingBox = new THREE.Box3(
          new THREE.Vector3(center.x - radius, minY - 1, center.z - radius),
          new THREE.Vector3(center.x + radius, maxY + maxScale * 1.6 + 2.5, center.z + radius),
        );
        geos[lod] = g;
      }

      const mesh = new THREE.Mesh(geos.low, this.material);
      mesh.frustumCulled = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.renderOrder = 1;

      const cx = Math.floor(k / 4096) - 512;
      const cz = (k % 4096) - 512;
      const chunk: Chunk = {
        cx, cz, center, radius, count: n, mesh,
        geos, lod: 'low',
        arrays: { a: attrA, b: attrB, c: attrC, d: attrD },
      };
      this.chunks.push(chunk);
      this.chunkOf.set(k, chunk);
      this.group.add(mesh);
    }

    this.buildSpatialGrid();
  }

  private buildSpatialGrid(): void {
    const cs = this.gridCell;
    for (const rec of this.records) {
      const gx = Math.floor(rec.x / cs);
      const gz = Math.floor(rec.z / cs);
      const k = (gx + 2048) * 8192 + (gz + 2048);
      let arr = this.grid.get(k);
      if (!arr) {
        arr = [];
        this.grid.set(k, arr);
      }
      arr.push(rec.index);
    }
  }

  /** Nearest tulip to a ground position, within `maxDist`. */
  nearest(x: number, z: number, maxDist = 3): TulipRecord | null {
    const cs = this.gridCell;
    const span = Math.ceil(maxDist / cs);
    const gx = Math.floor(x / cs);
    const gz = Math.floor(z / cs);
    let best: TulipRecord | null = null;
    let bestD = maxDist * maxDist;
    for (let dx = -span; dx <= span; dx++) {
      for (let dz = -span; dz <= span; dz++) {
        const arr = this.grid.get((gx + dx + 2048) * 8192 + (gz + dz + 2048));
        if (!arr) continue;
        for (const idx of arr) {
          const rec = this.records[idx];
          const d = (rec.x - x) * (rec.x - x) + (rec.z - z) * (rec.z - z);
          if (d < bestD) {
            bestD = d;
            best = rec;
          }
        }
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Runtime
  // -------------------------------------------------------------------------

  /** Distances at which chunks step down a level of detail. */
  private lodNear = 34;
  private lodFar = 86;

  update(camera: THREE.Camera): void {
    const cam = camera.getWorldPosition(this.tmpV);
    const near = this.lodNear;
    const far = this.lodFar;

    for (let i = 0; i < this.chunks.length; i++) {
      const ch = this.chunks[i];
      const dx = ch.center.x - cam.x;
      const dz = ch.center.z - cam.z;
      const dy = ch.center.y - cam.y;
      const dist = Math.sqrt(dx * dx + dz * dz + dy * dy) - ch.radius;

      const lod: TulipLod = dist < near ? 'high' : dist < far ? 'mid' : 'low';
      if (lod !== ch.lod) {
        ch.lod = lod;
        ch.mesh.geometry = ch.geos[lod];
      }
    }
  }

  /** Live diagnostics for the settings panel. */
  stats(): { tulips: number; chunks: number; tris: Record<TulipLod, number> } {
    return {
      tulips: this.count,
      chunks: this.chunks.length,
      tris: {
        high: triangleCount(this.baseGeos.high),
        mid: triangleCount(this.baseGeos.mid),
        low: triangleCount(this.baseGeos.low),
      },
    };
  }

  /** Chunks currently drawn at each LOD — used by the perf readout. */
  lodCounts(): Record<TulipLod, number> {
    const out = { high: 0, mid: 0, low: 0 };
    for (const c of this.chunks) out[c.lod]++;
    return out;
  }

  dispose(): void {
    for (const c of this.chunks) {
      for (const lod of ['high', 'mid', 'low'] as TulipLod[]) c.geos[lod].dispose();
    }
    for (const lod of ['high', 'mid', 'low'] as TulipLod[]) this.baseGeos[lod].dispose();
    this.material.dispose();
  }
}
