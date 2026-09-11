import * as THREE from 'three';
import type { WorldUniforms } from '../core/WorldUniforms';
import { srgb } from '../core/Colors';
import { makeRandom, type Rng, TAU } from '../core/MathUtils';

/**
 * Shooting stars (brief §19).
 *
 * A handful of streaks, each with a real trajectory across the dome rather than
 * a screen-space effect, so one can pass behind the moon or be missed entirely
 * because you were looking the other way. Catching one at the right moment is a
 * real secret, so the system exposes whether one is currently visible.
 */

const METEOR_VERTEX = /* glsl */ `
precision highp float;
attribute vec2 aCorner;
attribute vec4 aInst;      // xyz direction on the dome, w progress (<0 = idle)
attribute vec4 aInstB;     // travel direction xyz, w brightness

uniform float uRadius;
uniform vec3  uCamPos;

varying float vAlpha;
varying vec2  vUv;

void main() {
  float prog = aInst.w;
  if (prog < 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // off-screen, no fragments
    vAlpha = 0.0;
    vUv = vec2(0.0);
    return;
  }

  vec3 dir = normalize(aInst.xyz);
  vec3 travel = normalize(aInstB.xyz);
  // Position on the dome, moving along the great circle.
  vec3 p = normalize(dir + travel * (prog * 0.55 - 0.28));
  vec3 centre = uCamPos + p * uRadius;

  vec3 toCam = normalize(uCamPos - centre);
  vec3 along = normalize(travel - toCam * dot(travel, toCam));
  vec3 side = normalize(cross(along, toCam));

  // A long tail behind a small head.
  float len = uRadius * 0.055 * aInstB.w;
  float wid = uRadius * 0.0012;
  vec3 world = centre + along * (aCorner.y * len) + side * (aCorner.x * wid);

  // Fade in and out over the flight so nothing pops.
  float env = sin(clamp(prog, 0.0, 1.0) * 3.14159);
  vAlpha = env * aInstB.w;
  vUv = aCorner * 0.5 + 0.5;

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const METEOR_FRAGMENT = /* glsl */ `
precision highp float;
uniform vec3 uColor;
varying float vAlpha;
varying vec2 vUv;
void main() {
  // Bright at the head (uv.y = 1), fading to nothing along the tail.
  float tail = pow(clamp(vUv.y, 0.0, 1.0), 2.4);
  float across = 1.0 - smoothstep(0.25, 0.5, abs(vUv.x - 0.5));
  float a = vAlpha * tail * across;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor * (0.6 + tail * 2.2), a);
}
`;

interface Meteor {
  dir: THREE.Vector3;
  travel: THREE.Vector3;
  progress: number;
  speed: number;
  brightness: number;
}

export class Meteors {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  /** True while at least one is in flight — the interaction system reads this. */
  active = false;

  private meteors: Meteor[] = [];
  private inst: Float32Array;
  private instB: Float32Array;
  private attr: THREE.InstancedBufferAttribute;
  private attrB: THREE.InstancedBufferAttribute;
  private rng: Rng;

  constructor(uniforms: WorldUniforms, count = 6, seed = 1701) {
    this.rng = makeRandom(seed);

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('aCorner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, -1, 1, 1, 1], 2));
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    geo.setIndex([0, 1, 2, 2, 1, 3]);

    this.inst = new Float32Array(count * 4);
    this.instB = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      this.inst[i * 4 + 3] = -1;
      this.meteors.push({
        dir: new THREE.Vector3(0, 1, 0),
        travel: new THREE.Vector3(1, 0, 0),
        progress: -1,
        speed: 0.4,
        brightness: 1,
      });
    }
    this.attr = new THREE.InstancedBufferAttribute(this.inst, 4);
    this.attrB = new THREE.InstancedBufferAttribute(this.instB, 4);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    this.attrB.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aInst', this.attr);
    geo.setAttribute('aInstB', this.attrB);
    geo.instanceCount = count;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      vertexShader: METEOR_VERTEX,
      fragmentShader: METEOR_FRAGMENT,
      uniforms: {
        uRadius: { value: 600 },
        uCamPos: { value: new THREE.Vector3() },
        uColor: { value: srgb(0xfff0d8) },
        uNight: uniforms.mood.uNight,
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'Meteors';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /** Launch one. `brightness` above 1 makes a fireball. */
  launch(brightness = 1): void {
    const m = this.meteors.find((x) => x.progress < 0);
    if (!m) return;
    // Somewhere in the upper hemisphere, biased away from straight overhead.
    const az = this.rng() * TAU;
    const el = 0.22 + this.rng() * 0.85;
    m.dir.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).normalize();
    // Travel roughly downward across the sky.
    const t = new THREE.Vector3(this.rng() - 0.5, -0.35 - this.rng() * 0.5, this.rng() - 0.5);
    m.travel.copy(t.sub(m.dir.clone().multiplyScalar(t.dot(m.dir)))).normalize();
    m.progress = 0;
    m.speed = 0.45 + this.rng() * 0.55;
    m.brightness = brightness * (0.7 + this.rng() * 0.6);
  }

  update(dt: number, camera: THREE.Camera, night: number): void {
    (this.material.uniforms.uCamPos.value as THREE.Vector3).copy(camera.position);
    this.active = false;
    for (let i = 0; i < this.meteors.length; i++) {
      const m = this.meteors[i];
      if (m.progress >= 0) {
        m.progress += dt * m.speed;
        if (m.progress > 1) m.progress = -1;
        else this.active = true;
      }
      const o = i * 4;
      this.inst[o] = m.dir.x;
      this.inst[o + 1] = m.dir.y;
      this.inst[o + 2] = m.dir.z;
      this.inst[o + 3] = m.progress;
      this.instB[o] = m.travel.x;
      this.instB[o + 1] = m.travel.y;
      this.instB[o + 2] = m.travel.z;
      // Invisible by day, as they are.
      this.instB[o + 3] = m.brightness * night;
    }
    this.attr.needsUpdate = true;
    this.attrB.needsUpdate = true;
    this.mesh.visible = this.active && night > 0.2;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
