import { GLSL_HASH, GLSL_NOISE, GLSL_COLOR, GLSL_ROTATE, GLSL_WIND, GLSL_LIGHTING, GLSL_ATMOSPHERE } from './common';
import { GLSL_HERO_CONST } from '../world/HeroTulipGeometry';

/**
 * The hero tulip's shader.
 *
 * Everything the reference bloom does, and each one is a separate term:
 *   - tepals you can see *through*, lit from behind
 *   - lengthwise ribs that are both raised and lit from inside
 *   - an incandescent throat that whites out at the centre
 *   - a gold rim wherever a tepal turns away from the eye
 *   - spectral flashes at grazing angles, the way thin translucent tissue
 *     actually behaves
 *   - a scatter of sparkle along the outer margins
 *
 * Drawn twice: a body pass that owns the depth buffer and gives the flower a
 * solid silhouette, and an additive pass that lays the light on top. Additive
 * is order-independent, which matters when eighteen overlapping tepals would
 * otherwise need sorting, and it is also the honest model for an object that is
 * supposed to be made of light.
 */

const SHARED = /* glsl */ `
attribute vec4 aFlags;   // part, u, azimuth, attachHeight
attribute vec4 aShape;   // whorl, v, lengthScale, widthScale
attribute vec4 aInstA;   // worldX, worldY, worldZ, rotY
attribute vec4 aInstB;   // scale, open, glow, seed
attribute vec4 aInstC;   // hueShift, coreBright, wither, reserved

uniform float uOpenBias;
uniform float uReveal;       // 0..1 how much of the flower exists yet
uniform float uNight;
uniform float uEnergy;
uniform float uAudioVoice;
uniform float uAudioHigh;

varying vec3  vWorld;
varying vec3  vNormal;
varying vec2  vUV;          // u along the tepal, v across
varying float vPart;
varying float vWhorl;
varying float vOpen;
varying float vGlow;
varying float vSeed;
varying float vHue;
varying float vCore;
varying float vRibHeight;
`;

/** Pose: the arc bend shared with the field tulip, plus the lily reflex. */
const POSE = /* glsl */ `
${GLSL_HERO_CONST}

/**
 * Reflex curl. The main bend is a circular arc, which is exact and cheap but
 * has constant curvature; a lily-flowered tepal curves harder as it approaches
 * the point. Adding the extra curl as a displacement along the local frame,
 * rather than by varying the curvature, keeps the closed form intact and stays
 * continuous everywhere.
 */
vec3 tepalReflex(float u, float len, float amount) {
  float t = smoothstep(0.42, 1.0, u);
  t = t * t;
  // Outward and *up*. A reflexed tepal arches back on itself, so on an open
  // flower the point lifts; curling it down instead flattens the whole bloom
  // into a disc, which is what it was doing.
  return vec3(0.0, amount * t * len * 0.34, amount * t * len * 0.98);
}

void poseHero(
  float part, float u, float az, float attach, float whorl,
  vec3 position, vec3 normal, float open, float seed, float scale,
  vec2 windDir, float windMag, float time,
  out vec3 outLocal, out vec3 outNormal
) {
  // ---- Stem bend (cantilever arc) ----
  float kStem = windMag;
  float hs = (part < 0.5) ? u : attach;
  float phiS = kStem * hs;
  float yC, dC;
  if (abs(kStem) < 1e-4) { yC = hs; dC = 0.5 * kStem * hs * hs; }
  else { yC = sin(phiS) / kStem; dC = (1.0 - cos(phiS)) / kStem; }

  vec3 bendAxis = vec3(windDir.y, 0.0, -windDir.x);
  mat3 stemRot = rotateAxis(bendAxis, phiS);
  vec3 stemPos = vec3(windDir.x * dC, yC, windDir.y * dC);

  if (part < 0.5) {
    outLocal = stemPos + stemRot * vec3(position.x, 0.0, position.z);
    outNormal = stemRot * normal;
    return;
  }

  if (part > 3.5) {
    // Receptacle: rides on the stem top, unbent.
    outLocal = stemPos + stemRot * position;
    outNormal = stemRot * normal;
    return;
  }

  float len, k, baseR, reflex;
  if (part < 1.5) {
    // Leaf
    len = H_LEAF_LENGTH;
    k = 1.55 + 0.9 * hash11(seed * 5.7 + whorl);
    baseR = 0.009;
    reflex = 0.0;
  } else if (part > 2.5) {
    // Stamen: barely moves, leans out slightly as the flower opens.
    len = H_STAMEN_LEN;
    k = 0.35 + open * 0.9;
    baseR = 0.0;
    reflex = 0.0;
  } else {
    // Tepal. Curvature is the bloom, exactly as in the field tulip; the outer
    // whorl opens furthest and the inner stays upright, which is what gives the
    // open flower its layered depth.
    float whorlOpen = open * mix(1.05, 0.62, whorl * 0.5);
    k = mix(-2.05, 3.25, clamp(whorlOpen, 0.0, 1.0));
    baseR = H_TEPAL_BASE_R;
    len = H_TEPAL_LENGTH;
    // The reflex only appears once the flower is genuinely open.
    reflex = smoothstep(0.35, 1.0, open) * 0.58;
    // High frequencies shiver the tips (brief §21).
    k += sin(time * 3.7 + seed * 6.28 + az * 2.0) * uAudioHigh * 0.55;
  }

  float arc = position.y;
  float phi = k * arc;
  float yy, zz;
  if (abs(k) < 1e-4) { yy = arc; zz = 0.5 * k * arc * arc; }
  else { yy = sin(phi) / k; zz = (1.0 - cos(phi)) / k; }

  float cp = cos(phi), sp = sin(phi);
  float zoff = position.z;
  vec3 el = vec3(position.x, yy - zoff * sp, zz + zoff * cp);
  el.z += baseR;
  if (part > 1.5 && part < 2.5) el += tepalReflex(u, len, reflex);

  vec3 en = vec3(normal.x, normal.y * cp - normal.z * sp, normal.y * sp + normal.z * cp);

  mat3 azRot = mat3(cos(az), 0.0, -sin(az), 0.0, 1.0, 0.0, sin(az), 0.0, cos(az));
  el = azRot * el;
  en = azRot * en;

  outLocal = stemPos + stemRot * el;
  outNormal = stemRot * en;
}
`;

export const HERO_VERTEX = /* glsl */ `
precision highp float;

${SHARED}

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_ROTATE}
${GLSL_WIND}
${POSE}

void main() {
  float part   = aFlags.x;
  float u      = aFlags.y;
  float az     = aFlags.z;
  float attach = aFlags.w;
  float whorl  = aShape.x;
  float v      = aShape.y;

  vec3  basePos = aInstA.xyz;
  float rotY    = aInstA.w;
  float scale   = aInstB.x;
  float open    = clamp(aInstB.y + uOpenBias, 0.0, 1.25);
  float glow    = aInstB.z;
  float seed    = aInstB.w;

  vec2 wp = basePos.xz;
  float stiffness = 0.7 + 0.5 * hash11(seed * 11.3);
  float windMag = (windField(wp) * 0.10 + windGust(wp) * 0.18) * uWindStrength * stiffness;
  vec2 bendVec = uWindDir * windMag;
  float bendMag = length(bendVec);
  vec2 bendDir = bendMag > 1e-5 ? bendVec / bendMag : vec2(1.0, 0.0);

  vec3 local, nrm;
  poseHero(part, u, az, attach, whorl, position, normal, open, seed, scale,
           bendDir, bendMag * (0.8 + scale * 0.9), uTime, local, nrm);

  local *= scale;

  mat3 yaw = mat3(cos(rotY), 0.0, -sin(rotY), 0.0, 1.0, 0.0, sin(rotY), 0.0, cos(rotY));
  local = yaw * local;
  nrm = normalize(yaw * nrm);

  // The reveal grows the flower from the ground up rather than fading it in.
  float grow = smoothstep(0.0, 1.0, uReveal);
  local *= grow;

  vWorld = basePos + local;
  vNormal = nrm;
  vUV = vec2(u, v);
  vPart = part;
  vWhorl = whorl;
  vOpen = open;
  vSeed = seed;
  vHue = aInstC.x;
  vCore = aInstC.y;
  vGlow = glow * grow;

  // Ribs stand slightly proud of the tepal surface, so they catch light along
  // their length. Cheap displacement, and it is what makes the ribs read as
  // structure rather than as a painted-on stripe.
  float ribs = abs(sin(v * 3.14159265 * 2.5));
  vRibHeight = pow(ribs, 1.7);
  if (part > 1.5 && part < 2.5) {
    vWorld += nrm * vRibHeight * 0.0035 * scale * grow;
  }

  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

/** Shared colour logic: one description of the flower, two passes over it. */
const HERO_SHADING = /* glsl */ `
uniform vec3  uThroat;
uniform vec3  uMid;
uniform vec3  uTip;
uniform vec3  uRim;
uniform vec3  uCoreColor;
uniform vec3  uLeafColor;
uniform float uIridescence;
uniform float uSparkle;

/** Ribs, as both a lighting feature and a glow. */
float ribTerm(vec2 uv, out float ridge) {
  float ribs = abs(sin(uv.y * 3.14159265 * 2.5));
  ridge = pow(ribs, 1.7);
  // A stronger midrib down the centre of the tepal.
  float mid = 1.0 - smoothstep(0.0, 0.16, abs(uv.y));
  return max(ridge, mid * 0.9);
}

/** The petal's own colour, before any lighting. */
vec3 tepalAlbedo(vec2 uv, float hue, float whorl) {
  // Throat to tip. The reference runs warm gold at the base into rose at the
  // point, which is most of why it reads as lit from inside.
  float g = pow(clamp(uv.x, 0.0, 1.0), 0.72);
  vec3 col = mix(uThroat, uMid, smoothstep(0.0, 0.45, g));
  col = mix(col, uTip, smoothstep(0.40, 1.0, g));
  // Inner whorls sit in their own shadow and run a shade deeper.
  col *= mix(1.0, 0.86, whorl * 0.5);
  // Per-flower hue drift, kept small so the palette stays disciplined.
  if (abs(hue) > 0.001) {
    vec3 h = rgb2hsv(col);
    h.x = fract(h.x + hue);
    col = hsv2rgb(h);
  }
  return col;
}

/**
 * Thin-film style spectral shift at grazing angles. Real translucent tissue
 * does this, and it is the blue and violet catching the edges of the reference
 * bloom.
 */
vec3 iridescence(float grazing, float u, float seed) {
  float band = fract(0.55 + grazing * 0.85 + u * 0.22 + seed * 0.11);
  return hsv2rgb(vec3(band, 0.62, 1.0));
}
`;

export const HERO_BODY_FRAGMENT = /* glsl */ `
precision highp float;

uniform float uNight;
uniform float uWetness;
uniform float uReveal;

varying vec3  vWorld;
varying vec3  vNormal;
varying vec2  vUV;
varying float vPart;
varying float vWhorl;
varying float vOpen;
varying float vGlow;
varying float vSeed;
varying float vHue;
varying float vCore;
varying float vRibHeight;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_COLOR}
${GLSL_LIGHTING}
${GLSL_ATMOSPHERE}
${HERO_SHADING}

void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 viewDir = normalize(cameraPosition - vWorld);

  vec3 albedo;
  float translucency;
  float alpha = 1.0;

  if (vPart < 0.5) {
    albedo = uLeafColor * (0.62 + 0.5 * vUV.x);
    translucency = 0.4;
  } else if (vPart < 1.5) {
    albedo = uLeafColor * (0.75 + 0.45 * vUV.x);
    translucency = 0.75;
  } else if (vPart > 3.5) {
    albedo = mix(uThroat, uLeafColor, 0.35);
    translucency = 0.5;
  } else if (vPart > 2.5) {
    // Stamens: pale filaments, gold anthers at the tip.
    float anther = smoothstep(0.66, 0.80, vUV.x);
    albedo = mix(vec3(0.92, 0.88, 0.78), uRim * 1.25, anther);
    translucency = 0.6;
  } else {
    float ridge;
    float rib = ribTerm(vUV, ridge);
    albedo = tepalAlbedo(vUV, vHue, vWhorl);
    // Ribs are paler tissue, not just brighter lighting.
    albedo = mix(albedo, albedo * 1.16 + vec3(0.03, 0.02, 0.025), rib * 0.34);
    translucency = 1.0;
    // Tepals thin toward the point, and a lily tepal is genuinely see-through
    // near the tip.
    alpha = mix(0.96, 0.62, pow(clamp(vUV.x, 0.0, 1.0), 2.2));
  }

  vec3 lit = organicLighting(n, viewDir, albedo, translucency, 0.6);

  float grazing = 1.0 - abs(dot(n, viewDir));
  if (vPart > 1.5 && vPart < 2.5) {
    // Gold rim wherever the tepal turns away.
    lit += uRim * pow(grazing, 3.2) * (0.18 + 0.22 * vGlow);
    // Spectral flash tints the tissue rather than adding to it, so it can
    // never bleach the petal.
    lit = mix(lit, lit * iridescence(grazing, vUV.x, vSeed) * 1.6,
              pow(grazing, 4.0) * uIridescence * 0.5);
  }

  gl_FragColor = vec4(applyAtmosphere(lit, vWorld), alpha * smoothstep(0.02, 0.35, uReveal));
}
`;

export const HERO_GLOW_FRAGMENT = /* glsl */ `
precision highp float;

// uTime arrives with GLSL_WIND in the vertex stage; the fragment needs its own.
uniform float uTime;
uniform float uNight;
uniform float uReveal;

varying vec3  vWorld;
varying vec3  vNormal;
varying vec2  vUV;
varying float vPart;
varying float vWhorl;
varying float vOpen;
varying float vGlow;
varying float vSeed;
varying float vHue;
varying float vCore;
varying float vRibHeight;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_COLOR}
${GLSL_LIGHTING}
${GLSL_ATMOSPHERE}
${HERO_SHADING}

void main() {
  if (vGlow < 0.004) discard;

  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 viewDir = normalize(cameraPosition - vWorld);
  float grazing = 1.0 - abs(dot(n, viewDir));

  vec3 glow = vec3(0.0);

  if (vPart > 1.5 && vPart < 2.5) {
    float ridge;
    float rib = ribTerm(vUV, ridge);
    vec3 base = tepalAlbedo(vUV, vHue, vWhorl);

    // Light in the ribs, brightest at the throat and running out to the point.
    float along = 1.0 - smoothstep(0.0, 0.92, vUV.x);
    // A floor under the whole tepal, with the ribs as an accent on top of it.
    glow += base * (0.26 + rib * 0.55) * (0.34 + along * 0.95) * 0.9;

    // A pulse travelling out along the ribs — the flower breathing.
    // Multiplication, not pow(): the base here is negative for half the petal
    // and pow() with a negative base is undefined in GLSL.
    float dw = (vUV.x - fract(uTime * 0.16 + vSeed * 0.37)) * 5.5;
    float wave = exp(-dw * dw);
    glow += mix(base, uCoreColor, 0.30) * rib * wave * 0.70;

    // The throat whites out.
    // Tight, so the white stays a core and does not creep up the petal.
    float throat = pow(1.0 - clamp(vUV.x, 0.0, 1.0), 6.0);
    glow += mix(uThroat, uCoreColor, 0.55) * throat * (0.55 + vCore * 1.0);

    // Gold along the very edge of the tepal.
    float edge = smoothstep(0.72, 1.0, abs(vUV.y));
    glow += uRim * edge * (0.16 + 0.24 * along);

    // Rim and spectral flash.
    glow += uRim * pow(grazing, 2.2) * 0.30;
    glow += iridescence(grazing, vUV.x, vSeed) * pow(grazing, 4.0) * 0.16;

    // Sparkle scattered along the outer margins, twinkling independently.
    if (uSparkle > 0.001) {
      vec2 cell = floor(vec2(vUV.x * 26.0, vUV.y * 9.0));
      float h = hash21(cell + vSeed * 31.0);
      float tw = 0.5 + 0.5 * sin(uTime * (2.0 + h * 5.0) + h * 62.8);
      float spark = step(0.93, h) * tw * smoothstep(0.45, 1.0, abs(vUV.y));
      glow += vec3(1.0, 0.94, 0.82) * spark * uSparkle * 1.1;
    }
  } else if (vPart > 2.5 && vPart < 3.5) {
    // The star at the centre.
    float anther = smoothstep(0.6, 0.85, vUV.x);
    glow += uCoreColor * (0.22 + anther * 1.1) * (1.0 + vCore * 0.6);
    glow += uRim * anther * 0.6;
  } else if (vPart > 3.5) {
    glow += uCoreColor * 0.30 * (1.0 + vCore * 0.5);
  } else {
    // Stem and leaves carry the faintest trace of it.
    glow += uThroat * 0.05 * (1.0 - vUV.x * 0.6);
  }

  glow *= vGlow * (0.75 + uNight * 0.5) * smoothstep(0.0, 0.4, uReveal);

  // Additive light still obeys distance: without this a glowing flower stays
  // fully bright through a kilometre of haze.
  float od = max(fogOpticalDepth(cameraPosition, vWorld), 0.0);
  glow *= exp(-od);

  gl_FragColor = vec4(glow, 1.0);
}
`;
