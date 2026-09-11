import * as THREE from 'three';

/**
 * FXAA.
 *
 * A field of tulips is close to a worst case for aliasing: a hundred thousand
 * thin stems and pointed petal silhouettes against a bright sky, every one of
 * them a high-contrast sub-pixel edge that crawls as the camera moves. MSAA
 * does not help, because the post stack renders to an offscreen target; and a
 * temporal resolve would fight the dynamic resolution scaling. FXAA is the
 * right tool here: one pass, a dozen samples, no history, and it works on the
 * final graded image where the contrast it needs to find actually lives.
 *
 * This runs last, on sRGB output, which is where luminance-based edge detection
 * is meant to operate.
 */
export const FxaaShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
    uEnabled: { value: 1 },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform float uEnabled;

    varying vec2 vUv;

    // Below this much local contrast there is no edge worth touching.
    const float EDGE_THRESHOLD_MIN = 0.0312;
    const float EDGE_THRESHOLD_MAX = 0.125;
    const float SUBPIXEL_QUALITY  = 0.75;
    const int   SEARCH_STEPS = 10;

    float luma(vec3 c) {
      // Weighted toward green, which is where the eye's acuity is.
      return sqrt(dot(c, vec3(0.299, 0.587, 0.114)));
    }

    void main() {
      vec3 centre = texture2D(tDiffuse, vUv).rgb;
      if (uEnabled < 0.5) { gl_FragColor = vec4(centre, 1.0); return; }

      float lumaC = luma(centre);
      float lumaD = luma(texture2D(tDiffuse, vUv + vec2(0.0, -uTexel.y)).rgb);
      float lumaU = luma(texture2D(tDiffuse, vUv + vec2(0.0,  uTexel.y)).rgb);
      float lumaL = luma(texture2D(tDiffuse, vUv + vec2(-uTexel.x, 0.0)).rgb);
      float lumaR = luma(texture2D(tDiffuse, vUv + vec2( uTexel.x, 0.0)).rgb);

      float lumaMin = min(lumaC, min(min(lumaD, lumaU), min(lumaL, lumaR)));
      float lumaMax = max(lumaC, max(max(lumaD, lumaU), max(lumaL, lumaR)));
      float range = lumaMax - lumaMin;

      // Flat enough to leave alone — which is most of the screen, and most of
      // why this pass is cheap.
      if (range < max(EDGE_THRESHOLD_MIN, lumaMax * EDGE_THRESHOLD_MAX)) {
        gl_FragColor = vec4(centre, 1.0);
        return;
      }

      float lumaDL = luma(texture2D(tDiffuse, vUv + vec2(-uTexel.x, -uTexel.y)).rgb);
      float lumaUR = luma(texture2D(tDiffuse, vUv + vec2( uTexel.x,  uTexel.y)).rgb);
      float lumaUL = luma(texture2D(tDiffuse, vUv + vec2(-uTexel.x,  uTexel.y)).rgb);
      float lumaDR = luma(texture2D(tDiffuse, vUv + vec2( uTexel.x, -uTexel.y)).rgb);

      float lumaDU = lumaD + lumaU;
      float lumaLR = lumaL + lumaR;
      float lumaLCorners = lumaDL + lumaUL;
      float lumaDCorners = lumaDL + lumaDR;
      float lumaRCorners = lumaDR + lumaUR;
      float lumaUCorners = lumaUR + lumaUL;

      // Which way does the edge run? Compare gradients along each axis.
      float edgeH = abs(-2.0 * lumaL + lumaLCorners)
                  + abs(-2.0 * lumaC + lumaDU) * 2.0
                  + abs(-2.0 * lumaR + lumaRCorners);
      float edgeV = abs(-2.0 * lumaU + lumaUCorners)
                  + abs(-2.0 * lumaC + lumaLR) * 2.0
                  + abs(-2.0 * lumaD + lumaDCorners);
      bool isHorizontal = edgeH >= edgeV;

      float luma1 = isHorizontal ? lumaD : lumaL;
      float luma2 = isHorizontal ? lumaU : lumaR;
      float grad1 = luma1 - lumaC;
      float grad2 = luma2 - lumaC;
      bool is1Steepest = abs(grad1) >= abs(grad2);
      float gradScaled = 0.25 * max(abs(grad1), abs(grad2));

      float stepLength = isHorizontal ? uTexel.y : uTexel.x;
      float lumaLocalAvg = 0.0;
      if (is1Steepest) {
        stepLength = -stepLength;
        lumaLocalAvg = 0.5 * (luma1 + lumaC);
      } else {
        lumaLocalAvg = 0.5 * (luma2 + lumaC);
      }

      // Step to the middle of the edge, then walk along it in both directions
      // until the edge ends.
      vec2 currentUv = vUv;
      if (isHorizontal) currentUv.y += stepLength * 0.5;
      else currentUv.x += stepLength * 0.5;

      vec2 offset = isHorizontal ? vec2(uTexel.x, 0.0) : vec2(0.0, uTexel.y);
      vec2 uv1 = currentUv - offset;
      vec2 uv2 = currentUv + offset;

      float lumaEnd1 = luma(texture2D(tDiffuse, uv1).rgb) - lumaLocalAvg;
      float lumaEnd2 = luma(texture2D(tDiffuse, uv2).rgb) - lumaLocalAvg;
      bool reached1 = abs(lumaEnd1) >= gradScaled;
      bool reached2 = abs(lumaEnd2) >= gradScaled;

      if (!reached1) uv1 -= offset;
      if (!reached2) uv2 += offset;

      if (!reached1 || !reached2) {
        for (int i = 2; i < SEARCH_STEPS; i++) {
          if (reached1 && reached2) break;
          // Longer strides further out: the exact end of a long edge matters
          // less than finding it at all.
          float quality = (i < 5) ? 1.0 : (i < 7 ? 1.5 : 2.0);
          if (!reached1) {
            lumaEnd1 = luma(texture2D(tDiffuse, uv1).rgb) - lumaLocalAvg;
            reached1 = abs(lumaEnd1) >= gradScaled;
            if (!reached1) uv1 -= offset * quality;
          }
          if (!reached2) {
            lumaEnd2 = luma(texture2D(tDiffuse, uv2).rgb) - lumaLocalAvg;
            reached2 = abs(lumaEnd2) >= gradScaled;
            if (!reached2) uv2 += offset * quality;
          }
        }
      }

      float dist1 = isHorizontal ? (vUv.x - uv1.x) : (vUv.y - uv1.y);
      float dist2 = isHorizontal ? (uv2.x - vUv.x) : (uv2.y - vUv.y);
      bool isDir1 = dist1 < dist2;
      float distFinal = min(dist1, dist2);
      float edgeLength = dist1 + dist2;
      float pixelOffset = -distFinal / max(edgeLength, 1e-5) + 0.5;

      // Only shift toward the darker side of the edge.
      bool isLumaCSmaller = lumaC < lumaLocalAvg;
      bool correctVariation = ((isDir1 ? lumaEnd1 : lumaEnd2) < 0.0) != isLumaCSmaller;
      float finalOffset = correctVariation ? pixelOffset : 0.0;

      // Sub-pixel term: catches the single-pixel features a pure edge search
      // misses, which on a field of thin stems is most of them.
      float lumaAvg = (1.0 / 12.0) * (2.0 * (lumaDU + lumaLR) + lumaLCorners + lumaRCorners);
      float subPixel1 = clamp(abs(lumaAvg - lumaC) / max(range, 1e-5), 0.0, 1.0);
      float subPixel2 = (-2.0 * subPixel1 + 3.0) * subPixel1 * subPixel1;
      float subPixelOffset = subPixel2 * subPixel2 * SUBPIXEL_QUALITY;
      finalOffset = max(finalOffset, subPixelOffset);

      vec2 finalUv = vUv;
      if (isHorizontal) finalUv.y += finalOffset * stepLength;
      else finalUv.x += finalOffset * stepLength;

      gl_FragColor = vec4(texture2D(tDiffuse, finalUv).rgb, 1.0);
    }
  `,
};
