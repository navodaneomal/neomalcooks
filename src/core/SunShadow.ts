import * as THREE from 'three';
import type { Quality } from './Quality';

/**
 * A single sun shadow, for the things whose lack of one is actually noticeable.
 *
 * Shadowing a hundred thousand instanced flowers is not affordable on the
 * hardware this has to run on, and would buy very little: a field of tulips
 * self-shadows into an even darkening that the ground shader already
 * approximates. What *is* glaring is a person standing in that field with
 * nothing beneath her — she reads as pasted on until she has a shadow.
 *
 * So: one camera-fitted orthographic map, a small curated caster list selected
 * by render layer, and every ground-level surface in the world sampling it.
 * The box is snapped to the texel grid, without which the shadow crawls and
 * shimmers as the camera moves — the single most common mistake in a fitted
 * shadow map, and the most visible.
 */

/** Objects on this layer are rendered into the shadow map. */
export const SHADOW_LAYER = 2;

export class SunShadow {
  readonly target: THREE.WebGLRenderTarget;
  readonly camera = new THREE.OrthographicCamera(-8, 8, 8, -8, 0.5, 60);
  /** World -> shadow-map UV + depth. */
  readonly matrix = new THREE.Matrix4();
  /** True when the shadow pass should run this frame. */
  enabled: boolean;
  /** True when the current tier can afford a shadow pass at all. */
  available: boolean;
  /** The settings-panel preference, ANDed with `available` to get `enabled`. */
  private wanted = true;

  private depthMaterial = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    side: THREE.DoubleSide,
  });
  private size: number;
  private extent: number;
  private centre = new THREE.Vector3();
  private sunDir = new THREE.Vector3(0, 1, 0);
  private up = new THREE.Vector3(0, 1, 0);
  private tmp = new THREE.Vector3();
  private bias = new THREE.Matrix4().set(
    0.5, 0, 0, 0.5,
    0, 0.5, 0, 0.5,
    0, 0, 0.5, 0.5,
    0, 0, 0, 1,
  );

  constructor(quality: Quality) {
    const tier = quality.settings.tier;
    this.available = tier !== 'performance';
    this.enabled = this.available;
    this.size = SunShadow.sizeFor(tier);
    this.extent = 11;

    this.target = new THREE.WebGLRenderTarget(this.size, this.size, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.target.texture.generateMipmaps = false;
  }

  /** Point the map at a subject (her), along the current key light. */
  fit(subject: THREE.Vector3, sunDir: THREE.Vector3): void {
    this.sunDir.copy(sunDir);
    // A light at or below the horizon casts nothing useful; clamp it up so the
    // shadow shortens into the body rather than stretching to infinity.
    if (this.sunDir.y < 0.18) {
      this.sunDir.y = 0.18;
      this.sunDir.normalize();
    }

    const e = this.extent;
    this.camera.left = -e;
    this.camera.right = e;
    this.camera.top = e;
    this.camera.bottom = -e;
    this.camera.near = 0.5;
    this.camera.far = 60;

    // Snap the centre to whole texels *in the light's own basis*. Without this
    // the sampled depth shifts by a fraction of a texel every frame and the
    // shadow edge crawls.
    const texelWorld = (e * 2) / this.size;
    this.up.set(0, 1, 0);
    if (Math.abs(this.sunDir.y) > 0.99) this.up.set(0, 0, 1);
    const right = this.tmp.crossVectors(this.sunDir, this.up).normalize();
    const upVec = new THREE.Vector3().crossVectors(right, this.sunDir).normalize();

    const dr = Math.round(subject.dot(right) / texelWorld) * texelWorld;
    const du = Math.round(subject.dot(upVec) / texelWorld) * texelWorld;
    const df = subject.dot(this.sunDir);
    this.centre.copy(right).multiplyScalar(dr)
      .addScaledVector(upVec, du)
      .addScaledVector(this.sunDir, df);

    this.camera.position.copy(this.centre).addScaledVector(this.sunDir, 22);
    this.camera.up.copy(upVec);
    this.camera.lookAt(this.centre);
    this.camera.updateMatrixWorld(true);
    this.camera.updateProjectionMatrix();

    this.matrix.copy(this.bias)
      .multiply(this.camera.projectionMatrix)
      .multiply(this.camera.matrixWorldInverse);
  }

  /** Render the casters. Restores the renderer's target before returning. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
    if (!this.enabled) return;

    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevMask = this.camera.layers.mask;

    this.camera.layers.set(SHADOW_LAYER);
    scene.overrideMaterial = this.depthMaterial;

    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0xffffff, 1);   // white == farthest
    renderer.clear(true, true, false);
    renderer.render(scene, this.camera);

    scene.overrideMaterial = prevOverride;
    this.camera.layers.mask = prevMask;
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(0x000000, 1);
  }

  /**
   * Re-read the tier. The tier can change long after construction — the player
   * picks one by hand, or the frame-time watchdog steps down on a slow device —
   * and a shadow pass that ignored that would either never appear on a machine
   * that grew into it, or keep costing a full extra scene render on one that
   * could no longer afford it.
   */
  applyTier(quality: Quality): void {
    const tier = quality.settings.tier;
    this.available = tier !== 'performance';
    this.enabled = this.available && this.wanted;

    const size = SunShadow.sizeFor(tier);
    if (this.available && size !== this.size) {
      this.size = size;
      this.target.setSize(size, size);
    }
  }

  /** The settings-panel toggle. Remembered across tier changes. */
  setEnabled(v: boolean): void {
    this.wanted = v;
    this.enabled = this.available && v;
  }

  private static sizeFor(tier: string): number {
    return tier === 'cinematic' ? 1024 : 768;
  }

  dispose(): void {
    this.target.dispose();
    this.depthMaterial.dispose();
  }
}

/**
 * Receiver side. `sunShadow(worldPos)` returns 1 in full light, 0 in full
 * shadow, with a four-tap blur and a slope-independent bias.
 */
export const GLSL_SHADOW = /* glsl */ `
uniform sampler2D uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uShadowEnabled;
uniform float uShadowTexel;
uniform float uShadowStrength;

const float ShadowUnpackDownscale = 255.0 / 256.0;
const vec3  ShadowPackFactors = vec3(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0);

float unpackShadowDepth(const in vec4 v) {
  return dot(v, ShadowUnpackDownscale / vec4(ShadowPackFactors, 1.0));
}

float sunShadow(vec3 worldPos) {
  if (uShadowEnabled < 0.5) return 1.0;

  vec4 sc = uShadowMatrix * vec4(worldPos, 1.0);
  vec3 p = sc.xyz / sc.w;
  // Outside the fitted box there is simply no information; treat as lit rather
  // than guessing, so the world does not gain a hard rectangle of darkness.
  if (p.x < 0.001 || p.x > 0.999 || p.y < 0.001 || p.y > 0.999 || p.z > 0.999) return 1.0;

  float bias = 0.0016;
  float d = p.z - bias;

  // Four taps on a rotated square: enough to soften the edge without the
  // banding a straight 2x2 leaves on a low-resolution map.
  float t = uShadowTexel;
  float s = 0.0;
  s += step(d, unpackShadowDepth(texture2D(uShadowMap, p.xy + vec2(-0.7,  0.3) * t)));
  s += step(d, unpackShadowDepth(texture2D(uShadowMap, p.xy + vec2( 0.3,  0.7) * t)));
  s += step(d, unpackShadowDepth(texture2D(uShadowMap, p.xy + vec2( 0.7, -0.3) * t)));
  s += step(d, unpackShadowDepth(texture2D(uShadowMap, p.xy + vec2(-0.3, -0.7) * t)));
  s *= 0.25;

  // Fade the shadow out toward the edge of the box so it ends without a seam.
  vec2 edge = abs(p.xy - 0.5) * 2.0;
  float fade = 1.0 - smoothstep(0.78, 0.99, max(edge.x, edge.y));

  return mix(1.0, mix(1.0, s, fade), uShadowStrength);
}
`;
