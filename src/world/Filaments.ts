import * as THREE from 'three';
import { GLSL_HASH, GLSL_NOISE } from '../shaders/common';
import type { WorldUniforms } from '../core/WorldUniforms';
import { srgb } from '../core/Colors';
import { clamp01, damp, makeRandom } from '../core/MathUtils';

/**
 * The filaments (brief §08).
 *
 * The reference opens with threads of light drawing themselves through the air
 * in botanical arcs — braided strands that rise, weave over the top and curl
 * away at the ends, forming a cage around the flower before the flower exists.
 *
 * Each strand is a parametric curve evaluated in the vertex shader rather than
 * baked, so the whole cage can breathe, drift and be drawn on continuously from
 * one uniform. A bright head travels along the curve and the drawn part trails
 * behind it, which is what makes it read as being written rather than revealed.
 */

const FILAMENT_VERTEX = /* glsl */ `
precision highp float;

attribute vec3 aStrand;    // s along the curve, side (-1/+1), strand index
attribute vec4 aParams;    // azimuth, radius, height, phase

uniform vec3  uCentre;
uniform float uTime;
uniform float uHead;       // 0..1 how far the drawing has got
uniform float uAmount;     // global visibility
uniform float uWidth;
uniform float uBraid;
uniform float uSettle;     // 0 while drawing, 1 once the cage is complete

varying float vAlpha;
varying float vEdge;
varying float vHeat;

${GLSL_HASH}
${GLSL_NOISE}

/**
 * One strand: a dome arc from one side, over the top, down to the other, with
 * a braid twisting around it and the twist flaring at both ends into a curl.
 */
vec3 strandPoint(float s, vec4 p, float t) {
  float az = p.x, R = p.y, H = p.z, phase = p.w;
  vec3 dir = vec3(cos(az), 0.0, sin(az));
  float a = 3.14159265 * s;

  vec3 base = uCentre + dir * (R * cos(a)) + vec3(0.0, H * sin(a), 0.0);

  // Frame along the arc: tangent, and a binormal to braid around.
  vec3 tangent = normalize(vec3(-dir.x * sin(a), cos(a) * H / max(R, 0.001), -dir.z * sin(a)));
  vec3 bino = normalize(cross(tangent, vec3(0.0, 1.0, 0.0)) + vec3(0.0001, 0.0, 0.0));
  vec3 nrm = normalize(cross(bino, tangent));

  // Braid: a helix about the arc. Flaring at the ends turns the last stretch
  // into the curling tendrils the reference finishes each strand with.
  float ends = pow(abs(s * 2.0 - 1.0), 3.0);
  float amp = (0.045 + ends * 0.30) * R * uBraid;
  float turns = 3.0 + phase * 2.0;
  float ang = s * TAU_C * turns + phase * 6.28318 + t * 0.25;
  vec3 pos = base + bino * (cos(ang) * amp) + nrm * (sin(ang) * amp);

  // A slow drift so the cage is never rigid.
  pos += vec3(
    snoise(vec3(s * 2.1, phase * 9.0, t * 0.12)),
    snoise(vec3(s * 2.3 + 11.0, phase * 9.0, t * 0.10)) * 0.6,
    snoise(vec3(s * 1.9 - 7.0, phase * 9.0, t * 0.11))
  ) * R * 0.035;

  return pos;
}

void main() {
  float s = aStrand.x;
  float side = aStrand.y;
  float phase = aParams.w;

  // Each strand starts a little after the last, so the cage weaves itself
  // rather than appearing all at once.
  float delay = phase * 0.35;
  float head = clamp((uHead - delay) / max(1.0 - delay, 0.001), 0.0, 1.0);

  vec3 p = strandPoint(s, aParams, uTime);
  vec3 pNext = strandPoint(min(s + 0.004, 1.0), aParams, uTime);
  vec3 tangent = normalize(pNext - p + vec3(0.0, 1e-5, 0.0));
  vec3 toCam = normalize(cameraPosition - p);
  vec3 across = normalize(cross(tangent, toCam));

  // Taper to nothing at both ends so a strand has no blunt cut.
  float taper = pow(sin(3.14159265 * s), 0.42);
  // The drawing head is thicker and hotter.
  // Squared by multiplication, not pow(): GLSL leaves pow() undefined for a
  // negative base, and behind the drawing head this base is negative for most
  // of the strand. The NaN that produces propagates into gl_Position and the
  // whole ribbon silently vanishes.
  float dHead = (s - head) * 26.0;
  float atHead = exp(-dHead * dHead);
  float w = uWidth * (taper * (0.55 + 0.45 * uSettle) + atHead * 1.6);

  vec3 world = p + across * (side * w);

  // Visible only behind the head; fades in over a short lead-in.
  float drawn = 1.0 - smoothstep(head - 0.01, head + 0.045, s);
  float a = drawn * taper * uAmount;
  // Once settled the trail dims back to a steady thread.
  a *= mix(0.35 + atHead * 1.8, 0.55, uSettle);

  vAlpha = clamp(a, 0.0, 1.0);
  // Pass the *signed* side across. Taking abs() here makes the varying 1 at
  // both edges, so it interpolates to a constant and the across-ribbon
  // gradient — which is the entire colour term — collapses to zero.
  vEdge = side;
  vHeat = clamp(atHead * (1.0 - uSettle) + 0.18, 0.0, 1.6);

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const FILAMENT_FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform vec3 uHeadColor;

varying float vAlpha;
varying float vEdge;
varying float vHeat;

void main() {
  if (vAlpha < 0.004) discard;
  // Soft across the ribbon: a hot core inside a glow.
  float e = abs(vEdge);
  float core = 1.0 - smoothstep(0.0, 0.35, e);
  float halo = 1.0 - smoothstep(0.0, 1.0, e);
  vec3 col = mix(uColor, uHeadColor, clamp(vHeat, 0.0, 1.0));
  col *= core * 1.9 + halo * halo * 0.7;
  gl_FragColor = vec4(col * (0.6 + vHeat), vAlpha * (core * 0.8 + halo * 0.45));
}
`;

export class Filaments {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  /** 0..1 how far the drawing has progressed. */
  head = 0;
  private headTarget = 0;
  private amount = 0;
  private amountTarget = 0;
  private settle = 0;

  constructor(uniforms: WorldUniforms, strands = 18, segments = 72, seed = 424242) {
    const rng = makeRandom(seed);

    const strandAttr: number[] = [];
    const params: number[] = [];
    const idx: number[] = [];

    for (let i = 0; i < strands; i++) {
      const base = strandAttr.length / 3;
      // Azimuths spread with jitter so the cage is woven, not spoked.
      const az = (i / strands) * Math.PI * 2 + (rng() - 0.5) * 0.5;
      const R = 0.85 + rng() * 0.55;
      const H = 1.25 + rng() * 0.7;
      const phase = rng();

      for (let j = 0; j <= segments; j++) {
        const s = j / segments;
        for (const side of [-1, 1]) {
          strandAttr.push(s, side, i);
          params.push(az, R, H, phase);
        }
      }
      for (let j = 0; j < segments; j++) {
        const a = base + j * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('aStrand', new THREE.Float32BufferAttribute(strandAttr, 3));
    geo.setAttribute('aParams', new THREE.Float32BufferAttribute(params, 4));
    geo.setAttribute('position', new THREE.Float32BufferAttribute(
      new Float32Array(strandAttr.length), 3));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 6);

    this.material = new THREE.ShaderMaterial({
      vertexShader: FILAMENT_VERTEX.replace(/TAU_C/g, '6.28318530718'),
      fragmentShader: FILAMENT_FRAGMENT,
      uniforms: {
        uTime: uniforms.wind.uTime,
        uCentre: { value: new THREE.Vector3(0, 0, 0) },
        uHead: { value: 0 },
        uAmount: { value: 0 },
        uWidth: { value: 0.020 },
        uBraid: { value: 1 },
        uSettle: { value: 0 },
        uColor: { value: srgb(0xffb85c) },
        uHeadColor: { value: srgb(0xfff2d0) },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'Filaments';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 12;
  }

  /** Place the cage and begin drawing it. */
  begin(x: number, y: number, z: number, scale = 1): void {
    (this.material.uniforms.uCentre.value as THREE.Vector3).set(x, y, z);
    this.material.uniforms.uWidth.value = 0.020 * scale;
    this.head = 0;
    this.headTarget = 1;
    this.amountTarget = 1;
    this.settle = 0;
    this.mesh.visible = true;
  }

  /** Jump straight to a fully-drawn cage. Used by the bench and on replay. */
  complete(): void {
    this.head = 1;
    this.headTarget = 1;
    this.amount = 1;
    this.amountTarget = 1;
    this.settle = 1;
    this.mesh.visible = true;
    this.material.uniforms.uHead.value = 1;
    this.material.uniforms.uAmount.value = 1;
    this.material.uniforms.uSettle.value = 1;
  }

  /** Let the cage fade away. */
  dismiss(): void {
    this.amountTarget = 0;
  }

  update(dt: number): void {
    if (!this.mesh.visible) return;

    // Drawing is linear — a hand moving at a steady speed — while brightness
    // and settling ease.
    if (this.headTarget > this.head) {
      this.head = Math.min(this.headTarget, this.head + dt * 0.33);
    }
    if (this.head >= 0.999) this.settle = damp(this.settle, 1, 0.4, dt);
    this.amount = damp(this.amount, this.amountTarget, 0.9, dt);

    this.material.uniforms.uHead.value = this.head;
    this.material.uniforms.uAmount.value = this.amount;
    this.material.uniforms.uSettle.value = this.settle;

    if (this.amountTarget <= 0 && this.amount < 0.01) this.mesh.visible = false;
  }

  get visible(): boolean {
    return this.mesh.visible;
  }

  get brightness(): number {
    return clamp01(this.amount);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
