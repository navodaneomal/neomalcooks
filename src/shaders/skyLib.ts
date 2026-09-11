import { GLSL_HASH, GLSL_NOISE, GLSL_COLOR } from '../shaders/common';

/**
 * The sky, as a function.
 *
 * Extracted so the sky dome and the pond can share one implementation: the
 * water reflects the real gradient, the real clouds, the real stars and the
 * real moon by evaluating this along the reflected view ray, rather than
 * carrying a second approximation that would drift out of agreement with it.
 */
export const GLSL_SKY_UNIFORMS = /* glsl */ `
uniform float uTime;
uniform vec3  uSunDir;
uniform vec3  uMoonDir;
uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uNadir;
uniform vec3  uSunTint;
uniform float uSunIntensity;
uniform float uNight;
uniform float uMoonBright;
uniform float uStarIntensity;
uniform float uCloudCover;
uniform float uCloudSharp;
uniform vec2  uWindDir;
uniform float uWindStrength;
uniform float uRainbow;
uniform float uWonder;
uniform float uDream;
uniform float uDetail;

`;

export const GLSL_SKY = GLSL_HASH + GLSL_NOISE + GLSL_COLOR + /* glsl */ `




/**
 * Procedural stars.
 *
 * The direction is projected onto a cube face to get a stable 2D parameterisation,
 * then cut into cells; each cell may hold one star whose position, brightness,
 * colour and twinkle rate come from hashes of the cell id. Two layers at
 * different scales give the depth a single layer never has.
 *
 * (Cutting *3D* space into cells instead is the obvious-looking approach and is
 * wrong: the visible sky is a 2D surface through that volume, so almost every
 * cell's star sits off the surface and the sky comes out nearly empty.)
 */
vec3 cubeFaceUV(vec3 dir, out float face) {
  vec3 a = abs(dir);
  vec2 uv;
  if (a.x >= a.y && a.x >= a.z) {
    uv = dir.zy / a.x; face = dir.x > 0.0 ? 0.0 : 1.0;
  } else if (a.y >= a.z) {
    uv = dir.xz / a.y; face = dir.y > 0.0 ? 2.0 : 3.0;
  } else {
    uv = dir.xy / a.z; face = dir.z > 0.0 ? 4.0 : 5.0;
  }
  return vec3(uv, 0.0);
}

float starLayer(vec3 dir, float scale, float density, float twinkleRate, out vec3 tint) {
  tint = vec3(1.0);
  float face;
  vec2 uv = cubeFaceUV(dir, face).xy * scale;
  vec2 cell = floor(uv);
  vec2 f = uv - cell;

  vec2 id = cell + face * 137.13;
  float h0 = hash21(id);
  if (h0 > density) return 0.0;

  float h1 = hash21(id + 19.7);
  float h2 = hash21(id * 1.31 + 71.3);
  float h3 = hash21(id * 0.77 - 41.1);

  vec2 starPos = vec2(0.15 + h1 * 0.7, 0.15 + h2 * 0.7);
  float d = length(f - starPos);

  float mag = h3;
  float size = mix(0.020, 0.075, mag * mag);
  float core = 1.0 - smoothstep(0.0, size, d);
  core *= core;
  // A faint halo so the brightest stars bleed slightly, as they do to the eye.
  core += (1.0 - smoothstep(0.0, size * 2.6, d)) * 0.09 * mag;

  // Some twinkle quickly, some barely at all.
  float tw = 0.62 + 0.38 * sin(uTime * twinkleRate * (0.4 + h2 * 2.2) + h1 * 62.8);
  tw = mix(1.0, tw, step(0.3, h3));

  // Mostly white, a few warm, a few blue: real stellar colour distribution.
  float ct = h1;
  vec3 warm = vec3(1.0, 0.82, 0.66);
  vec3 cool = vec3(0.76, 0.85, 1.0);
  tint = mix(vec3(1.0), ct < 0.5 ? warm : cool, smoothstep(0.5, 0.95, abs(ct - 0.5) * 2.0) * 0.8);

  return core * tw * (0.35 + 0.95 * mag);
}

/** Two cloud decks, driven by the same wind that moves the tulips. */
float clouds(vec3 dir, float cover, float sharp) {
  if (dir.y <= 0.005) return 0.0;
  // Project onto a plane above the viewer: the classic cheap cloud dome.
  // Clamped: at a grazing angle dir.xz/dir.y explodes and the cloud noise
  // degenerates into a bright high-frequency field — which the pond then
  // reflects as a sheet of white.
  vec2 uv = dir.xz / max(dir.y, 0.14);
  vec2 drift = uWindDir * uTime * (0.0055 + uWindStrength * 0.010);

  float low = fbm(vec3(uv * 0.10 + drift, uTime * 0.010), 5) * 0.5 + 0.5;
  float high = fbm(vec3(uv * 0.035 - drift * 0.45, uTime * 0.004 + 30.0), 4) * 0.5 + 0.5;

  float c = mix(high, low, 0.62);
  // cover 0 -> clear sky, 1 -> overcast.
  float t = mix(0.86, 0.24, clamp(cover, 0.0, 1.0));
  float shape = smoothstep(t, t + mix(0.30, 0.06, sharp), c);

  // Fade the deck out toward the horizon so it never forms a hard ring.
  return shape * smoothstep(0.0, 0.16, dir.y);
}


vec3 skyRadiance(vec3 dir) {
  dir = normalize(dir);
  float up = clamp(dir.y, -1.0, 1.0);

  // --- Gradient --------------------------------------------------------------
  float t = pow(clamp(up * 0.5 + 0.5, 0.0, 1.0), 0.9);
  vec3 sky = mix(uNadir, uHorizon, smoothstep(0.0, 0.5, t));
  sky = mix(sky, uZenith, smoothstep(0.42, 1.0, t));

  float sunDot = dot(dir, uSunDir);
  float moonDot = dot(dir, uMoonDir);

  // --- Sun scattering ---------------------------------------------------------
  // A broad Mie-like forward lobe plus a tight disc.
  float mie = pow(clamp(sunDot * 0.5 + 0.5, 0.0, 1.0), 9.0);
  sky += uSunTint * mie * 0.55 * uSunIntensity;
  float horizonGlow = pow(clamp(sunDot, 0.0, 1.0), 3.5) * (1.0 - abs(up)) ;
  sky += uSunTint * horizonGlow * 0.8 * uSunIntensity;

  // --- Stars ------------------------------------------------------------------
  if (uStarIntensity > 0.002) {
    vec3 t1, t2;
    float s1 = starLayer(dir, 62.0, 0.30, 2.4, t1);
    float s2 = starLayer(dir, 138.0, 0.20, 3.6, t2) * 0.62;
    // Stars sit behind the atmosphere: they fade toward the horizon.
    float alt = smoothstep(-0.02, 0.28, up);
    // Clouds occlude them.
    sky += (t1 * s1 + t2 * s2) * uStarIntensity * alt * 1.25;
  }

  // --- Moon --------------------------------------------------------------------
  if (uMoonBright > 0.002) {
    float md = acos(clamp(moonDot, -1.0, 1.0));
    float disc = 1.0 - smoothstep(0.021, 0.026, md);
    // Maria: faint darker patches so it is not a flat white circle.
    vec3 mp = normalize(dir - uMoonDir * moonDot + uMoonDir * 0.001);
    float mottle = fbm(vec3(mp * 34.0), 3) * 0.5 + 0.5;
    vec3 moonCol = mix(vec3(0.92, 0.93, 0.98), vec3(0.72, 0.74, 0.82), mottle * 0.55);
    sky = mix(sky, moonCol * (0.9 + uMoonBright * 0.9), disc);
    // Halo.
    sky += vec3(0.72, 0.78, 0.95) * pow(clamp(moonDot, 0.0, 1.0), 220.0) * uMoonBright * 1.6;
    sky += vec3(0.55, 0.62, 0.85) * pow(clamp(moonDot, 0.0, 1.0), 12.0) * uMoonBright * 0.16;
  }

  // --- Sun disc -----------------------------------------------------------------
  if (uSunIntensity > 0.02) {
    float sd = acos(clamp(sunDot, -1.0, 1.0));
    float disc = 1.0 - smoothstep(0.019, 0.030, sd);
    sky = mix(sky, uSunTint * 2.6, disc * clamp(uSunIntensity, 0.0, 1.0));
  }

  // --- Clouds --------------------------------------------------------------------
  float cl = clouds(dir, uCloudCover, uCloudSharp);
  if (cl > 0.001) {
    // Light the deck from the sun so cloud edges catch fire at sunset.
    float lit = pow(clamp(sunDot * 0.5 + 0.5, 0.0, 1.0), 2.4);
    vec3 cloudBright = mix(vec3(0.92, 0.92, 0.96), uSunTint * 1.5, lit * 0.75);
    vec3 cloudDark = mix(vec3(0.34, 0.36, 0.44), vec3(0.20, 0.19, 0.26), uNight);
    vec3 cloudCol = mix(cloudDark, cloudBright, 0.35 + 0.65 * lit);
    cloudCol *= mix(1.0, 0.42, uNight);
    sky = mix(sky, cloudCol, clamp(cl, 0.0, 1.0) * 0.95);
  }

  // --- Rainbow --------------------------------------------------------------------
  // Placed correctly: a 42-degree arc about the antisolar point, with the
  // fainter secondary bow at 51 degrees and reversed.
  if (uRainbow > 0.001 && up > -0.02) {
    float anti = dot(dir, -uSunDir);
    float ang = degrees(acos(clamp(anti, -1.0, 1.0)));
    float primary = 1.0 - smoothstep(0.0, 2.1, abs(ang - 41.0));
    float secondary = (1.0 - smoothstep(0.0, 3.0, abs(ang - 52.0))) * 0.28;
    float band = clamp((ang - 39.0) / 4.0, 0.0, 1.0);
    vec3 bowCol = hsv2rgb(vec3(0.78 - band * 0.78, 0.72, 1.0));
    vec3 bow2 = hsv2rgb(vec3(clamp((ang - 50.0) / 5.0, 0.0, 1.0) * 0.78, 0.62, 1.0));
    float fade = smoothstep(-0.02, 0.22, up);
    sky += (bowCol * primary + bow2 * secondary) * uRainbow * fade * 0.42;
  }

  if (uDream > 0.001) {
    float l = luma(sky);
    sky = mix(sky, mix(vec3(l), sky, 0.6) + vec3(0.05, 0.035, 0.08), uDream * 0.5);
  }

  return sky;
}

`;
