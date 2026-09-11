import { bus } from './Bus';

/**
 * Device capability detection and the three quality tiers from the brief.
 *
 * The beauty means nothing if it cannot run: we pick a sensible tier up front
 * from what the GPU actually reports, then keep watching the frame time and
 * step down if we guessed too high. Stepping *up* is deliberately not automatic
 * — a world that keeps changing its own fidelity is more distracting than one
 * that settles.
 */

export type TierName = 'cinematic' | 'beautiful' | 'performance';

export interface QualitySettings {
  readonly tier: TierName;
  /** Tulips in the main field, before per-ring LOD thinning. */
  tulipCount: number;
  /** Grass blades. */
  grassCount: number;
  /** Radius of the geometry tulip field; the terrain shader carries the rest. */
  fieldRadius: number;
  /** Radius of the instanced grass, which only needs to exist near the camera. */
  grassRadius: number;
  /** Edge length of a field chunk — the unit of frustum culling and LOD. */
  chunkSize: number;
  /** Camera far plane / fog reach. */
  viewDistance: number;
  maxPixelRatio: number;
  bloom: boolean;
  bloomStrength: number;
  shadows: boolean;
  shadowMapSize: number;
  waterReflection: boolean;
  /** Floating pollen / petal particles. */
  ambientParticles: number;
  rainDrops: number;
  starCount: number;
  fireflies: number;
  butterflies: number;
  /** Petal segments on the near-LOD tulip. */
  petalSegments: number;
  /** Extra shader work multiplier, fed to uDetail. */
  detail: number;
  /**
   * Distance at which chunks drop to mid, then to low detail.
   *
   * This scene is vertex-bound rather than fill-bound — a tulip is a lot of
   * trigonometry per vertex and there are a great many of them — so on a weak
   * device pulling these in is worth far more than reducing resolution.
   */
  lodNear: number;
  lodFar: number;
  anisotropy: number;
}

const TIERS: Record<TierName, QualitySettings> = {
  cinematic: {
    tier: 'cinematic',
    tulipCount: 118000,
    grassCount: 150000,
    fieldRadius: 185,
    grassRadius: 30,
    chunkSize: 30,
    viewDistance: 2600,
    maxPixelRatio: 2,
    bloom: true,
    bloomStrength: 0.62,
    shadows: true,
    shadowMapSize: 2048,
    waterReflection: true,
    ambientParticles: 5200,
    rainDrops: 9000,
    starCount: 5200,
    fireflies: 420,
    butterflies: 26,
    petalSegments: 5,
    detail: 1,
    lodNear: 38,
    lodFar: 95,
    anisotropy: 8,
  },
  beautiful: {
    tier: 'beautiful',
    tulipCount: 54000,
    grassCount: 66000,
    fieldRadius: 155,
    grassRadius: 23,
    chunkSize: 30,
    viewDistance: 2200,
    maxPixelRatio: 1.75,
    bloom: true,
    bloomStrength: 0.5,
    shadows: false,
    shadowMapSize: 1024,
    waterReflection: true,
    ambientParticles: 2400,
    rainDrops: 4200,
    starCount: 2800,
    fireflies: 220,
    butterflies: 16,
    petalSegments: 4,
    detail: 0.65,
    lodNear: 28,
    lodFar: 68,
    anisotropy: 4,
  },
  performance: {
    tier: 'performance',
    tulipCount: 19000,
    grassCount: 20000,
    fieldRadius: 125,
    grassRadius: 17,
    chunkSize: 32,
    viewDistance: 1800,
    maxPixelRatio: 1.25,
    bloom: false,
    bloomStrength: 0,
    shadows: false,
    shadowMapSize: 512,
    waterReflection: false,
    ambientParticles: 900,
    rainDrops: 1600,
    starCount: 1300,
    fireflies: 90,
    butterflies: 8,
    petalSegments: 3,
    detail: 0.3,
    lodNear: 16,
    lodFar: 38,
    anisotropy: 1,
  },
};

export interface DeviceProfile {
  isMobile: boolean;
  isTouch: boolean;
  cores: number;
  memoryGB: number;
  renderer: string;
  softwareRenderer: boolean;
  prefersReducedMotion: boolean;
  maxTextureSize: number;
}

export function probeDevice(): DeviceProfile {
  const ua = navigator.userAgent || '';
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const isMobile = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua) ||
    (isTouch && Math.min(screen.width, screen.height) < 820);

  let renderer = '';
  let maxTextureSize = 2048;
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ||
      canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = dbg
        ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '')
        : String(gl.getParameter(gl.RENDERER) ?? '');
      maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      // Release the probe context immediately; browsers cap concurrent contexts.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    /* Probing is best-effort — a missing renderer string just means we guess. */
  }

  const softwareRenderer = /swiftshader|llvmpipe|software|basic render/i.test(renderer);
  const cores = navigator.hardwareConcurrency || 4;
  const memoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const prefersReducedMotion =
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  return { isMobile, isTouch, cores, memoryGB, renderer, softwareRenderer, prefersReducedMotion, maxTextureSize };
}

export function chooseTier(d: DeviceProfile): TierName {
  if (d.softwareRenderer || d.maxTextureSize < 4096) return 'performance';
  if (d.isMobile) {
    // Recent flagship phones handle the middle tier comfortably.
    return d.cores >= 6 && d.memoryGB >= 4 ? 'beautiful' : 'performance';
  }
  if (d.cores >= 8 && d.memoryGB >= 8) return 'cinematic';
  if (d.cores >= 4) return 'beautiful';
  return 'performance';
}

export class Quality {
  readonly device: DeviceProfile;
  settings: QualitySettings;
  /** Set from the settings panel; suppresses camera shake and heavy motion. */
  reducedMotion: boolean;
  /** True while the user has pinned a tier by hand — disables auto step-down. */
  private manual = false;

  private frameAccum = 0;
  private frameCount = 0;
  private strikes = 0;

  constructor() {
    this.device = probeDevice();
    this.settings = { ...TIERS[chooseTier(this.device)] };
    this.reducedMotion = this.device.prefersReducedMotion;
  }

  get tier(): TierName {
    return this.settings.tier;
  }

  setTier(tier: TierName, manual = true): void {
    if (this.settings.tier === tier) return;
    this.settings = { ...TIERS[tier] };
    this.manual = manual;
    this.strikes = 0;
    bus.emit('quality:change', { tier });
  }

  /**
   * Watches a rolling second of frame times. Three consecutive bad seconds drop
   * a tier — enough to ride out a garbage collection or a tab regaining focus
   * without flip-flopping.
   */
  sampleFrame(dt: number): void {
    if (this.manual) return;
    this.frameAccum += dt;
    this.frameCount++;
    if (this.frameAccum < 1) return;

    const avg = this.frameAccum / this.frameCount;
    this.frameAccum = 0;
    this.frameCount = 0;

    // Below ~28fps sustained is where the experience stops feeling cinematic.
    if (avg > 1 / 28) {
      this.strikes++;
      // A device that is *far* over budget was misjudged at startup, not
      // momentarily busy: drop immediately rather than making them wait.
      const desperate = avg > 1 / 12;
      if (this.strikes >= (desperate ? 1 : 3)) {
        this.strikes = 0;
        if (this.settings.tier === 'cinematic') this.setTier('beautiful', false);
        else if (this.settings.tier === 'beautiful') this.setTier('performance', false);
      }
    } else {
      this.strikes = 0;
    }
  }
}

export const TIER_PRESETS = TIERS;
