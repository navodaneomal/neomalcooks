import * as THREE from 'three';
import { GLSL_SKY, GLSL_SKY_UNIFORMS } from '../shaders/skyLib';
import type { WorldUniforms } from '../core/WorldUniforms';
import type { QualitySettings } from '../core/Quality';
import { srgb } from '../core/Colors';

/**
 * The sky dome: gradient, sun, moon, cloud layers, stars and — very rarely —
 * a rainbow placed where a rainbow actually goes.
 *
 * Rendered on an inverted sphere with depth writing off, so it costs one
 * fullscreen-ish draw and never interferes with the world's depth buffer.
 */

const SKY_VERTEX = /* glsl */ `
precision highp float;
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  // Keep the dome locked to the camera and pinned at the far plane.
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w * 0.999999;
}
`;

const SKY_FRAGMENT = /* glsl */ `
precision highp float;

${GLSL_SKY_UNIFORMS}

varying vec3 vDir;

${GLSL_SKY}

void main() {
  gl_FragColor = vec4(skyRadiance(normalize(vDir)), 1.0);
}
`;

export class Sky {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly uniforms: Record<string, THREE.IUniform>;

  constructor(worldUniforms: WorldUniforms, settings: QualitySettings) {
    this.uniforms = {
      uTime: worldUniforms.wind.uTime,
      uWindDir: worldUniforms.wind.uWindDir,
      uWindStrength: worldUniforms.wind.uWindStrength,
      uSunDir: worldUniforms.lighting.uSunDir,
      uSunIntensity: worldUniforms.lighting.uSunIntensity,
      uNight: worldUniforms.mood.uNight,
      uWonder: worldUniforms.mood.uWonder,
      uDream: worldUniforms.mood.uDream,
      uDetail: worldUniforms.quality.uDetail,

      uMoonDir: { value: new THREE.Vector3(-0.4, 0.6, -0.5).normalize() },
      uZenith: { value: srgb(0x2f5f97) },
      uHorizon: { value: srgb(0xbcd0e0) },
      uNadir: { value: srgb(0x6b6f68) },
      uSunTint: { value: srgb(0xffe3b8) },
      uMoonBright: { value: 0 },
      uStarIntensity: { value: 0 },
      uCloudCover: { value: 0.32 },
      uCloudSharp: { value: 0.5 },
      uRainbow: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });

    const detail = settings.tier === 'performance' ? 2 : 3;
    const geo = new THREE.IcosahedronGeometry(1, detail);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'Sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    // Scaled to sit comfortably inside the far plane at every quality tier.
    this.mesh.scale.setScalar(Math.max(settings.viewDistance * 0.42, 400));
  }

  /** Keep the dome centred on the camera so it can never be walked out of. */
  update(camera: THREE.Camera): void {
    this.mesh.position.copy(camera.position);
    this.mesh.updateMatrix();
    this.mesh.updateMatrixWorld();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
