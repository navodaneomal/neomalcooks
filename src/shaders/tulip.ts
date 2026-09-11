import { GLSL_HASH, GLSL_NOISE, GLSL_COLOR, GLSL_ROTATE, GLSL_WIND, GLSL_LIGHTING, GLSL_ATMOSPHERE } from './common';
import { GLSL_INFLUENCE, GLSL_WAVE } from '../core/WorldUniforms';
import { GLSL_SHADOW } from '../core/SunShadow';
import { GLSL_TULIP_CONST } from '../world/TulipGeometry';
import { HUE_COUNT } from '../world/Palette';

/**
 * The tulip vertex shader.
 *
 * Everything about a flower's pose — how far it has opened, how the wind has
 * bent it, whether she has just walked past, whether a bloom wave is crossing
 * it right now — is derived here from a handful of shared uniforms plus that
 * instance's own attributes. Nothing is animated on the CPU.
 */

export const TULIP_VERTEX = /* glsl */ `
precision highp float;

attribute vec4 aFlags;   // part, u, azimuth, attachHeight
attribute vec4 aShape;   // ring, v, lengthScale, widthScale
attribute vec4 aInstA;   // worldX, worldY, worldZ, rotY
attribute vec4 aInstB;   // scale, headWidth, phase, seed
attribute vec4 aInstC;   // bloomBase, kind, hueIndex, glow
attribute vec4 aInstD;   // tiltX, tiltZ, lean, bloomPhase

uniform vec3  uPaletteBase[${HUE_COUNT}];
uniform vec3  uPaletteTip[${HUE_COUNT}];
uniform vec3  uLeafColor;
uniform float uSpawnRadius;
uniform float uSpawnWidth;
uniform vec2  uSpawnOrigin;
uniform float uOpenBias;
uniform float uMagic;

uniform float uCalm;
uniform float uWonder;
uniform float uNight;
uniform float uWetness;
uniform float uDream;
uniform float uReverse;
uniform float uAudioBass;
uniform float uAudioMid;
uniform float uAudioHigh;
uniform float uAudioVoice;
uniform float uDetail;

varying vec3  vWorld;
varying vec3  vNormal;
varying vec3  vColor;
varying float vPart;
varying float vU;
varying float vV;
varying float vGlow;
varying float vBloom;
varying float vTranslucency;
varying float vSeed;
varying float vKind;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_COLOR}
${GLSL_ROTATE}
${GLSL_WIND}
${GLSL_INFLUENCE}
${GLSL_WAVE}
${GLSL_TULIP_CONST}

/**
 * How open this flower is, 0 (tight bud) to 1 (fully splayed).
 * Every term here is something the brief asks the garden to respond to.
 */
float bloomAmount(vec2 wp, float base, float phase, float seed) {
  float b = base + uOpenBias;

  // Each tulip breathes on its own slow cycle, so the field is never uniform.
  b += 0.11 * sin(uTime * 0.055 + phase * 6.28318) * (0.4 + 0.6 * uCalm);

  // Tulips genuinely close at night and in the rain. So do these.
  b -= uNight * 0.30;
  b -= uWetness * 0.15;

  // Music opens the cup; her voice opens it more.
  b += uAudioMid * 0.14 + uAudioVoice * 0.20;

  // Her footsteps, the user's touch, a planted seed.
  b += influenceAt(wp) * 0.6;

  // A bloom wave crossing the field.
  b += bloomWaveAt(wp);

  // The rewind closes everything back to the first bud.
  b = mix(b, -0.15, uReverse);

  return clamp(b, 0.0, 1.0);
}

void main() {
  float part   = aFlags.x;
  float u      = aFlags.y;
  float az     = aFlags.z;
  float attach = aFlags.w;

  float ring   = aShape.x;
  float v      = aShape.y;

  vec3  basePos   = aInstA.xyz;
  float rotY      = aInstA.w;
  float scale     = aInstB.x;
  float headWidth = aInstB.y;
  float phase     = aInstB.z;
  float seed      = aInstB.w;
  float bloomBase = aInstC.x;
  float kind      = aInstC.y;
  float hueIdx    = aInstC.z;
  float glow      = aInstC.w;
  vec2  tilt      = aInstD.xy;
  float lean      = aInstD.z;
  float bPhase    = aInstD.w;

  vec2 wp = basePos.xz;

  // --- Does this tulip exist yet? -------------------------------------------
  // The awakening is a radius sweeping outward from the first tulip. A jitter
  // per instance stops the front from reading as a perfect circle.
  float jitter = (hash11(seed * 37.1) - 0.5) * uSpawnWidth * 1.6;
  float spawn = clamp(
    (uSpawnRadius - distance(wp, uSpawnOrigin) + jitter) / max(uSpawnWidth, 0.001),
    0.0, 1.0);
  spawn = smoothstep(0.0, 1.0, spawn);
  // Young tulips push up out of the soil rather than fading in.
  float growth = spawn * spawn * (3.0 - 2.0 * spawn);
  scale *= growth;

  float bloom = bloomAmount(wp, bloomBase, phase, seed) * spawn;

  // --- Wind ------------------------------------------------------------------
  // Bending is accumulated as a *vector* in the ground plane, then split into a
  // direction and a curvature. Doing it this way lets the wind, the flower's own
  // permanent lean and the recoil from whatever is moving nearby all combine
  // naturally instead of fighting over one scalar.
  float stiffness = 0.62 + 0.75 * hash11(seed * 11.3);
  float w = windField(wp);
  float gust = windGust(wp);

  float windMag = (w * 0.13 + gust * 0.26) * uWindStrength * stiffness;
  windMag += uAudioBass * 0.055 * stiffness;

  vec2 bendVec = uWindDir * windMag;
  // Every tulip carries a slight permanent lean of its own.
  bendVec += vec2(cos(rotY), sin(rotY)) * lean;
  // And recoils a little from whatever is moving near it.
  bendVec += influencePush(wp) * 0.55;

  float bendMag = length(bendVec);
  vec2 bendDir = bendMag > 1e-5 ? bendVec / bendMag : vec2(1.0, 0.0);

  // Taller flowers bend further for the same wind.
  float kStem = bendMag * (0.8 + scale * 0.9);
  // Ground slope leans the whole plant.
  vec2 slopeDir = tilt;

  vec3 local;
  vec3 nrm = normal;

  // --- Pose ------------------------------------------------------------------
  // Stem parameter this vertex is attached at: the stem's own u, or the
  // attachment height for a leaf or petal.
  float hs = (part < 0.5) ? u : attach;
  float s = hs;                       // canonical stem length is exactly 1.0
  float phiS = kStem * s;

  float yC, dC;
  if (abs(kStem) < 1e-4) {
    yC = s;
    dC = 0.5 * kStem * s * s;
  } else {
    yC = sin(phiS) / kStem;
    dC = (1.0 - cos(phiS)) / kStem;
  }

  vec3 bendAxis = vec3(bendDir.y, 0.0, -bendDir.x);
  mat3 stemRot = rotateAxis(bendAxis, phiS);
  vec3 stemPos = vec3(bendDir.x * dC, yC, bendDir.y * dC);

  if (part < 0.5) {
    // ---- Stem ----
    local = stemPos + stemRot * vec3(position.x, 0.0, position.z);
    nrm = stemRot * normal;
  } else {
    // ---- Leaf or petal: bend the strip, then place it on the stem ----
    float len = (part < 1.5) ? LEAF_LENGTH : PETAL_LENGTH;
    float arc = position.y;             // canonical arclength from the base
    float k, bulge, baseR;

    if (part < 1.5) {
      // Leaves arch outward and down, and flutter in gusts.
      k = 1.55 + 0.9 * hash11(seed * 5.7 + ring) + gust * 0.5 * uWindStrength;
      k += sin(uTime * 1.7 + phase * 6.28 + ring * 2.1) * 0.10 * uWindStrength;
      bulge = 0.0;
      baseR = 0.008;
    } else {
      // Petals: curvature *is* the bloom. A bud curves inward with a bulge at
      // the shoulder (the egg silhouette); an open flower curves outward.
      // Curvature x petal arclength gives the tip's angle from vertical:
      // a bud sits at about -32 degrees (tips converging over the cup) and a
      // fully open tulip at about +70, which is where a real one stops.
      float openK = 5.00 + 1.50 * uWonder * uMagic;
      k = mix(-2.33, openK, bloom);
      // Inner whorl stays a touch more upright, as it does on a real tulip.
      k *= mix(1.0, 0.86, ring);
      bulge = mix(0.036, 0.011, bloom);

      // High frequencies live in the petals (brief §21).
      float flutter = sin(uTime * 4.1 + phase * 6.28 + az * 2.0) * uAudioHigh * 0.5;
      flutter += sin(uTime * 2.3 + seed * 9.1) * gust * uWindStrength * 0.35;
      k += flutter * 0.9;

      baseR = PETAL_BASE_RADIUS;
    }

    float phi = k * arc;
    float yy, zz;
    if (abs(k) < 1e-4) {
      yy = arc;
      zz = 0.5 * k * arc * arc;
    } else {
      yy = sin(phi) / k;
      zz = (1.0 - cos(phi)) / k;
    }

    float cp = cos(phi);
    float sp = sin(phi);

    // Offset across the strip's own thickness/cup direction, carried along the
    // rotated frame so the channelling survives the bend.
    float zoff = position.z;
    vec3 el = vec3(position.x, yy - zoff * sp, zz + zoff * cp);
    el.z += bulge * sin(3.14159265 * (arc / max(len, 0.001)));
    el.z += baseR;

    // Petal width variation per flower.
    if (part > 1.5) el.x *= headWidth;

    // Rotate the strip's normal by the same bend, then by its azimuth.
    vec3 en = vec3(normal.x, normal.y * cp - normal.z * sp, normal.y * sp + normal.z * cp);

    mat3 azRot = mat3(
      cos(az), 0.0, -sin(az),
      0.0,     1.0, 0.0,
      sin(az), 0.0, cos(az)
    );
    el = azRot * el;
    en = azRot * en;

    local = stemPos + stemRot * el;
    nrm = stemRot * en;
  }

  // --- Instance placement ----------------------------------------------------
  local *= scale;

  // Slope lean: tulips growing on a hillside are not perfectly vertical.
  mat3 slopeRot = rotateAxis(normalize(vec3(slopeDir.y, 0.0, -slopeDir.x) + vec3(0.0, 1e-5, 0.0)),
                             length(slopeDir) * 0.55);
  local = slopeRot * local;
  nrm = slopeRot * nrm;

  mat3 yaw = mat3(
    cos(rotY), 0.0, -sin(rotY),
    0.0,       1.0, 0.0,
    sin(rotY), 0.0, cos(rotY)
  );
  local = yaw * local;
  nrm = normalize(yaw * nrm);

  vec3 world = basePos + local;

  // Dream mode lifts the whole field very slightly off the ground.
  world.y += uDream * (0.35 + 1.4 * hash11(seed * 3.3)) * smoothstep(0.0, 1.0, bloom);

  // --- Colour ----------------------------------------------------------------
  int hi = int(clamp(hueIdx, 0.0, ${(HUE_COUNT - 1).toFixed(1)}));
  vec3 cBase = uPaletteBase[0];
  vec3 cTip  = uPaletteTip[0];
  for (int i = 0; i < ${HUE_COUNT}; i++) {
    if (i == hi) { cBase = uPaletteBase[i]; cTip = uPaletteTip[i]; }
  }

  vec3 col;
  float translucency;
  if (part < 1.5) {
    // Stem and leaves, with a little per-plant variation so the greens breathe.
    float gv = hash11(seed * 17.7);
    col = uLeafColor * (0.82 + 0.36 * gv);
    col *= (0.72 + 0.42 * u);
    translucency = 0.45;
  } else {
    // The throat is deep, the tip is pale: that gradient is most of what makes
    // a tulip look like a tulip.
    float g = pow(clamp(u, 0.0, 1.0), 0.78);
    col = mix(cBase, cTip, g);
    // A whisper of paler edge where the petal curls.
    col = mix(col, cTip, pow(abs(v), 3.0) * 0.35);
    // Slight per-flower value shift, never a hue shift — that would break the
    // palette discipline the brief asks for.
    col *= 0.88 + 0.26 * hash11(seed * 23.1);
    // Ancient tulips (kind 3) have gone slightly papery with age.
    float ancient = step(2.5, kind) * (1.0 - step(3.5, kind));
    col = mix(col, mix(col, vec3(luma(col)) * vec3(1.04, 0.99, 0.95), 0.32), ancient);
    translucency = 0.95;
  }

  // Rain darkens and saturates wet tissue.
  col *= mix(1.0, 0.86, uWetness);

  vWorld = world;
  vNormal = nrm;
  vColor = col;
  vPart = part;
  vU = u;
  vV = v;
  vBloom = bloom;
  vTranslucency = translucency;
  vSeed = seed;
  vKind = kind;

  // Magical tulips and freshly-touched flowers carry their own light.
  float localExcite = influenceAt(wp);
  // Kept deliberately small. Glow is additive and the night grade is already
  // lifted, so a wave that reads as "bright" by day goes pure white after dark.
  vGlow = glow * uMagic
        + localExcite * 0.22
        + bloomWaveAt(wp) * 0.30
        + uAudioVoice * glow * 0.6
        + smoothstep(0.55, 1.0, bPhase) * uWonder * 0.12;

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

export const TULIP_FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3  uGlowTint;
uniform float uNight;
uniform float uWetness;
uniform float uDream;
uniform float uMagic;
uniform float uDetail;

varying vec3  vWorld;
varying vec3  vNormal;
varying vec3  vColor;
varying float vPart;
varying float vU;
varying float vV;
varying float vGlow;
varying float vBloom;
varying float vTranslucency;
varying float vSeed;
varying float vKind;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_COLOR}
${GLSL_LIGHTING}
${GLSL_ATMOSPHERE}
${GLSL_SHADOW}

void main() {
  vec3 viewDir = normalize(cameraPosition - vWorld);
  vec3 n = normalize(vNormal);
  // Petals and leaves are single-sided strips; light them from whichever face
  // the camera is actually seeing.
  if (!gl_FrontFacing) n = -n;

  vec3 albedo = vColor;

  // --- Petal veins ------------------------------------------------------------
  if (vPart > 1.5 && uDetail > 0.15) {
    // Veins fan from the base toward the tip, converging slightly.
    float fan = vV * (1.0 - vU * 0.35);
    float veins = sin(fan * 26.0 + vSeed * 3.0);
    veins = smoothstep(0.72, 1.0, abs(veins));
    albedo *= 1.0 - veins * 0.10 * (1.0 - vU * 0.5);

    // Magical tulips light their veins from inside.
    albedo += uGlowTint * veins * vGlow * 0.30 * uMagic;
  }

  float shade = sunShadow(vWorld);
  vec3 lit = organicLighting(n, viewDir, albedo, vTranslucency, 0.55);
  lit -= albedo * uSunColor * uSunIntensity * clamp(dot(n, uSunDir), 0.0, 1.0)
       * (1.0 - shade) * 0.90;
  lit *= mix(1.0, 0.88, 1.0 - shade);

  // --- Rim ---------------------------------------------------------------------
  float rim = rimTerm(n, viewDir, 2.4);
  lit += albedo * rim * (0.16 + 0.30 * vTranslucency) * (1.0 - uNight * 0.35);

  // --- Wet specular -------------------------------------------------------------
  if (uWetness > 0.01) {
    vec3 h = normalize(viewDir + uSunDir);
    float spec = pow(clamp(dot(n, h), 0.0, 1.0), 62.0);
    lit += uSunColor * spec * uWetness * 0.85;
    // Dew beads catching the light.
    float beads = smoothstep(0.86, 1.0, hash21(vec2(vU * 41.0 + vSeed, vV * 37.0)));
    lit += uSunColor * beads * uWetness * 0.5 * rim;
  }

  // --- Inner glow ---------------------------------------------------------------
  lit += uGlowTint * vGlow * (0.35 + 0.65 * vU) * (1.0 + uNight * 0.45);

  // Moonlight catches the tops of the tulips (brief §45).
  lit += uSunColor * uNight * pow(clamp(n.y, 0.0, 1.0), 3.0) * 0.22 * vBloom;

  // Dream mode desaturates and lifts the field toward its own light.
  if (uDream > 0.001) {
    float l = luma(lit);
    lit = mix(lit, mix(vec3(l), lit, 0.55) + vec3(0.03, 0.02, 0.05), uDream * 0.6);
  }

  float dist = distance(cameraPosition, vWorld);
  vec3 finalColor = applyAtmosphere(lit, vWorld);

  gl_FragColor = vec4(finalColor, 1.0);
}
`;
