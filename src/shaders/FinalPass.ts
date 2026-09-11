import * as THREE from 'three';

/**
 * The single grading pass that turns a correct render into a cinematic frame.
 *
 * Everything the brief asks for at the lens level happens here in one pass:
 * depth of field, filmic tone mapping, vignette, grain, a whisper of chromatic
 * aberration, the letterbox for cinematic beats, the dream-mode bloom-lift, the
 * "world rewinds" inversion and the fades. Doing it in one pass rather than a
 * stack of them keeps the cost to a single fullscreen draw.
 */

export const FinalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },

    uNear: { value: 0.1 },
    uFar: { value: 1000 },

    // Depth of field
    uDofStrength: { value: 0 },     // 0 disables the taps entirely; raised only for close-ups
    uFocusDistance: { value: 24 },
    uFocusRange: { value: 40 },
    uMaxBlur: { value: 1.15 },

    uExposure: { value: 1.0 },
    uContrast: { value: 1.02 },
    uSaturation: { value: 1.04 },
    uLift: { value: new THREE.Color(0, 0, 0) },
    uTint: { value: new THREE.Color(1, 1, 1) },

    uVignette: { value: 0.34 },
    uGrain: { value: 0.028 },
    uAberration: { value: 0.42 },

    uLetterbox: { value: 0 },       // 0..1 -> bar height as fraction of height
    uFadeAmount: { value: 0 },
    uFadeColor: { value: new THREE.Color(0, 0, 0) },

    uDream: { value: 0 },
    uReverse: { value: 0 },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2  uResolution;
    uniform float uTime;

    uniform float uNear;
    uniform float uFar;

    uniform float uDofStrength;
    uniform float uFocusDistance;
    uniform float uFocusRange;
    uniform float uMaxBlur;

    uniform float uExposure;
    uniform float uContrast;
    uniform float uSaturation;
    uniform vec3  uLift;
    uniform vec3  uTint;

    uniform float uVignette;
    uniform float uGrain;
    uniform float uAberration;

    uniform float uLetterbox;
    uniform float uFadeAmount;
    uniform vec3  uFadeColor;

    uniform float uDream;
    uniform float uReverse;

    varying vec2 vUv;

    // 8-tap ring: even angular coverage with a stable, cheap pattern.
    // Declared as a global and filled in main() because GLSL ES 1.00 — which is
    // what three.js emits for a plain ShaderMaterial — has no array constructors.
    vec2 gTaps[8];
    void initTaps() {
      gTaps[0] = vec2( 0.0000,  1.0000);
      gTaps[1] = vec2( 0.7071,  0.7071);
      gTaps[2] = vec2( 1.0000,  0.0000);
      gTaps[3] = vec2( 0.7071, -0.7071);
      gTaps[4] = vec2( 0.0000, -1.0000);
      gTaps[5] = vec2(-0.7071, -0.7071);
      gTaps[6] = vec2(-1.0000,  0.0000);
      gTaps[7] = vec2(-0.7071,  0.7071);
    }

    float perspectiveDepthToViewZ(float invClipZ, float near, float far) {
      return (near * far) / ((far - near) * invClipZ - far);
    }

    float linearDepthAt(vec2 uv) {
      float d = texture2D(tDepth, uv).x;
      // Far plane / sky: treat as maximally distant so it blurs like a backdrop.
      if (d >= 0.9999) return uFar;
      return -perspectiveDepthToViewZ(d, uNear, uFar);
    }

    float circleOfConfusion(float dist) {
      float coc = (dist - uFocusDistance) / max(uFocusRange, 0.001);
      return clamp(abs(coc), 0.0, 1.0);
    }

    vec3 sampleScene(vec2 uv) {
      return texture2D(tDiffuse, uv).rgb;
    }

    // ACES filmic approximation (Narkowicz) — keeps highlights from going chalky.
    vec3 acesFilm(vec3 x) {
      const float a = 2.51;
      const float b = 0.03;
      const float c = 2.43;
      const float d = 0.59;
      const float e = 0.14;
      return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
    }

    vec3 linearToSRGB(vec3 c) {
      return mix(c * 12.92,
                 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
                 step(vec3(0.0031308), c));
    }

    float grainNoise(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      initTaps();
      vec2 uv = vUv;
      vec2 texel = 1.0 / uResolution;
      vec2 fromCenter = uv - 0.5;
      float r2 = dot(fromCenter, fromCenter);

      // --- Depth of field -------------------------------------------------
      float coc = 0.0;
      vec3 color;
      if (uDofStrength > 0.001) {
        float dist = linearDepthAt(uv);
        coc = circleOfConfusion(dist) * uDofStrength;
        if (coc > 0.004) {
          float radius = coc * uMaxBlur;
          vec3 sum = sampleScene(uv);
          float weight = 1.0;
          for (int i = 0; i < 8; i++) {
            // Two rings of taps for a rounder bokeh at large radii.
            vec2 o1 = gTaps[i] * radius * texel * 4.0;
            vec2 o2 = gTaps[i] * radius * texel * 8.0;
            sum += sampleScene(uv + o1);
            sum += sampleScene(uv + o2);
            weight += 2.0;
          }
          color = sum / weight;
        } else {
          color = sampleScene(uv);
        }
      } else {
        color = sampleScene(uv);
      }

      // --- Chromatic aberration -------------------------------------------
      // Only at the edges, and scaled by blur so it reads as glass, not glitch.
      float ab = uAberration * (0.0008 + coc * 0.0026) * r2 * 4.0;
      if (ab > 0.00002) {
        vec2 dir = normalize(fromCenter + 1e-6);
        color.r = sampleScene(uv + dir * ab).r;
        color.b = sampleScene(uv - dir * ab).b;
      }

      // --- Dream mode: lifted, softened, gently desaturated -----------------
      if (uDream > 0.001) {
        vec3 soft = vec3(0.0);
        for (int i = 0; i < 8; i++) {
          soft += sampleScene(uv + gTaps[i] * texel * 9.0);
        }
        soft /= 8.0;
        color = mix(color, max(color, soft * 1.08), uDream * 0.65);
      }

      // --- The rewind: a cold, silvered inversion of the light --------------
      if (uReverse > 0.001) {
        float l = dot(color, vec3(0.2126, 0.7152, 0.0722));
        vec3 silver = mix(color, vec3(l) * vec3(0.82, 0.88, 1.06), 0.8);
        color = mix(color, silver, uReverse);
      }

      // --- Grade ------------------------------------------------------------
      color *= uExposure;
      color = acesFilm(color);
      color = (color - 0.5) * uContrast + 0.5;
      float l = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(l), color, uSaturation);
      color = color * uTint + uLift;
      color = max(color, vec3(0.0));

      // --- Vignette ---------------------------------------------------------
      float vig = 1.0 - uVignette * smoothstep(0.12, 0.78, r2 * 2.0);
      color *= vig;

      // --- Grain ------------------------------------------------------------
      float g = grainNoise(uv * uResolution * 0.5 + fract(uTime) * 91.7) - 0.5;
      color += g * uGrain * (1.0 - l * 0.55);

      color = linearToSRGB(color);

      // --- Letterbox --------------------------------------------------------
      float bar = uLetterbox * 0.115;
      if (bar > 0.0001) {
        float inBar = step(uv.y, bar) + step(1.0 - bar, uv.y);
        color = mix(color, vec3(0.0), clamp(inBar, 0.0, 1.0));
      }

      // --- Fade -------------------------------------------------------------
      color = mix(color, uFadeColor, clamp(uFadeAmount, 0.0, 1.0));

      gl_FragColor = vec4(color, 1.0);
    }
  `,
};
