import * as THREE from 'three';

/**
 * The nervous system of the world.
 *
 * Rather than push per-object state from the CPU each frame, every material in
 * the garden shares the *same* THREE.IUniform object instances from this store.
 * Writing `world.uniforms.wind.uWindStrength.value = 2` moves every tulip, every
 * blade of grass, her hair and the pond surface in the same gust — with no
 * per-object work at all. This is what lets the field carry hundreds of
 * thousands of flowers while the CPU stays essentially idle.
 */

export const MAX_INFLUENCES = 8;

export type UniformMap = Record<string, THREE.IUniform>;

export class WorldUniforms {
  /** Time + wind. Consumed by shaders/common GLSL_WIND. */
  readonly wind: UniformMap = {
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(1, 0.35).normalize() },
    uWindStrength: { value: 0.55 },
    uGustPhase: { value: 0 },
  };

  /** Key light + hemisphere ambient. Consumed by GLSL_LIGHTING. */
  readonly lighting: UniformMap = {
    uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.55).normalize() },
    uSunColor: { value: new THREE.Color(1.0, 0.86, 0.7) },
    uSkyColor: { value: new THREE.Color(0.34, 0.42, 0.6) },
    uGroundColor: { value: new THREE.Color(0.14, 0.11, 0.1) },
    uSunIntensity: { value: 1.0 },
  };

  /** Height-aware haze. Consumed by GLSL_ATMOSPHERE. */
  readonly atmosphere: UniformMap = {
    uFogColor: { value: new THREE.Color(0.6, 0.66, 0.78) },
    uFogDensity: { value: 0.0065 },
    uFogHeight: { value: 42 },
  };

  /**
   * The garden's emotional state (see systems/Heart) plus the live audio bands.
   * Shaders read these to change how expressive the world is without any
   * geometry changing hands.
   */
  readonly mood: UniformMap = {
    uEnergy: { value: 0 },      // 0 still .. 1 dancing
    uCalm: { value: 1 },        // inverse-ish of energy, eased slower
    uWonder: { value: 0 },      // spikes on discoveries and rare events
    uNight: { value: 0 },       // 0 day .. 1 deep night
    uWetness: { value: 0 },     // rain soaking, decays slowly after
    uDream: { value: 0 },       // idle dream-mode blend
    uReverse: { value: 0 },     // the "world rewinds" effect
    uAudioBass: { value: 0 },
    uAudioMid: { value: 0 },
    uAudioHigh: { value: 0 },
    uAudioVoice: { value: 0 },
    uAudioLevel: { value: 0 },
  };

  /**
   * A blooming wave expanding from a point. Because it is evaluated *in the
   * vertex shader* from four numbers, a wave of a hundred thousand tulips
   * opening in sequence costs the CPU nothing.
   */
  readonly wave: UniformMap = {
    // xy = origin on the ground plane, z = current radius, w = falloff width
    uWave: { value: new THREE.Vector4(0, 0, -1, 12) },
    uWaveStrength: { value: 0 },
    uWave2: { value: new THREE.Vector4(0, 0, -1, 12) },
    uWave2Strength: { value: 0 },
  };

  /**
   * Local influence points — her position, the user's touch, a planted tulip.
   * xy = ground position, z = radius, w = strength.
   */
  readonly influence: UniformMap = {
    uInfluence: {
      value: Array.from({ length: MAX_INFLUENCES }, () => new THREE.Vector4(0, 0, 0, 0)),
    },
    uInfluenceCount: { value: 0 },
  };

  /**
   * The sun shadow. Shared by every receiving surface so the map, the matrix
   * and the strength can never disagree between ground, grass and flowers.
   */
  readonly shadow: UniformMap = {
    uShadowMap: { value: null },
    uShadowMatrix: { value: new THREE.Matrix4() },
    uShadowEnabled: { value: 0 },
    uShadowTexel: { value: 1 / 1024 },
    uShadowStrength: { value: 0.85 },
  };

  /** Global quality/adaptive knobs a shader may want (LOD fades, density). */
  readonly quality: UniformMap = {
    uDetail: { value: 1 },      // 0..1, scales shader-side extra work
    uViewFar: { value: 900 },
  };

  private readonly influenceSlots: THREE.Vector4[] = this.influence.uInfluence
    .value as THREE.Vector4[];

  /** Merge selected groups into a fresh uniforms object for a material. */
  build(...groups: UniformMap[]): UniformMap {
    const out: UniformMap = {};
    for (const g of groups) for (const k in g) out[k] = g[k];
    return out;
  }

  /** Convenience: the set almost every organic surface needs. */
  organic(extra: UniformMap = {}): UniformMap {
    return this.build(
      this.wind,
      this.lighting,
      this.atmosphere,
      this.mood,
      this.wave,
      this.influence,
      this.quality,
      this.shadow,
      extra,
    );
  }

  // --- influence point management ------------------------------------------

  private influenceWrite = 0;

  beginInfluences(): void {
    this.influenceWrite = 0;
  }

  addInfluence(x: number, z: number, radius: number, strength: number): void {
    if (this.influenceWrite >= MAX_INFLUENCES) return;
    this.influenceSlots[this.influenceWrite++].set(x, z, radius, strength);
  }

  endInfluences(): void {
    for (let i = this.influenceWrite; i < MAX_INFLUENCES; i++) {
      this.influenceSlots[i].set(0, 0, 0, 0);
    }
    this.influence.uInfluenceCount.value = this.influenceWrite;
  }
}

/** GLSL for reading the influence array. Include after GLSL_WIND. */
export const GLSL_INFLUENCE = /* glsl */ `
uniform vec4 uInfluence[${MAX_INFLUENCES}];
uniform int  uInfluenceCount;

/** Total local excitement at a ground position, 0..~1. */
float influenceAt(vec2 p) {
  float total = 0.0;
  for (int i = 0; i < ${MAX_INFLUENCES}; i++) {
    if (i >= uInfluenceCount) break;
    vec4 inf = uInfluence[i];
    if (inf.z <= 0.0) continue;
    float d = distance(p, inf.xy);
    total += inf.w * (1.0 - smoothstep(0.0, inf.z, d));
  }
  return total;
}

/** Direction to push away from the nearest influence — grass bending aside. */
vec2 influencePush(vec2 p) {
  vec2 push = vec2(0.0);
  for (int i = 0; i < ${MAX_INFLUENCES}; i++) {
    if (i >= uInfluenceCount) break;
    vec4 inf = uInfluence[i];
    if (inf.z <= 0.0) continue;
    vec2 d = p - inf.xy;
    float len = max(length(d), 0.0001);
    float f = inf.w * (1.0 - smoothstep(0.0, inf.z, len));
    push += (d / len) * f;
  }
  return push;
}
`;

/** GLSL for the expanding bloom waves. */
export const GLSL_WAVE = /* glsl */ `
uniform vec4  uWave;
uniform float uWaveStrength;
uniform vec4  uWave2;
uniform float uWave2Strength;

float waveTerm(vec2 p, vec4 w, float strength) {
  if (strength <= 0.0 || w.z < 0.0) return 0.0;
  float d = distance(p, w.xy);
  // A ring at radius w.z of width w.w; everything already passed stays open.
  float front = 1.0 - smoothstep(w.z - w.w, w.z + w.w * 0.35, d);
  return front * strength;
}

float bloomWaveAt(vec2 p) {
  return clamp(
    waveTerm(p, uWave, uWaveStrength) + waveTerm(p, uWave2, uWave2Strength),
    0.0, 1.0);
}
`;
