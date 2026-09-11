/**
 * Shared GLSL building blocks.
 *
 * Every material in the world imports from here so that wind, noise and colour
 * behave identically across tulips, grass, water, petals and cloth. Written in
 * GLSL ES 1.00 style (attribute/varying) because that is what three.js emits for
 * a plain ShaderMaterial.
 */

/** Cheap hashes. */
export const GLSL_HASH = /* glsl */ `
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
`;

/** Simplex noise (Ashima Arts / Stefan Gustavson), the GPU twin of core/Noise.ts. */
export const GLSL_NOISE = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

float fbm(vec3 p, int octaves) {
  float amp = 0.5;
  float sum = 0.0;
  float norm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += amp * snoise(p);
    norm += amp;
    p *= 2.0;
    amp *= 0.5;
  }
  return sum / max(norm, 0.0001);
}
`;

/**
 * The wind field.
 *
 * Two travelling sine waves give the large, readable "breath" that crosses the
 * field, and a slow noise term breaks up the regularity so it never reads as a
 * loop. `uWindStrength` is driven by the weather engine; `uHeartEnergy` lets the
 * garden's mood push the air around without the weather changing at all.
 */
export const GLSL_WIND = /* glsl */ `
uniform float uTime;
uniform vec2  uWindDir;
uniform float uWindStrength;
uniform float uGustPhase;

float windField(vec2 p) {
  float along = dot(p, uWindDir);
  float w  = sin(along * 0.075 - uTime * 1.15) * 0.5;
  w += sin(along * 0.031 - uTime * 0.62 + 1.7) * 0.35;
  w += sin(dot(p, vec2(-uWindDir.y, uWindDir.x)) * 0.043 + uTime * 0.41) * 0.22;
  w += snoise(vec3(p * 0.018, uTime * 0.11)) * 0.8;
  return w;
}

/** Sharp, travelling gust fronts layered on top of the base breeze. */
float windGust(vec2 p) {
  float along = dot(p, uWindDir);
  float front = sin(along * 0.012 - uTime * 0.33 + uGustPhase);
  return pow(max(front, 0.0), 3.0);
}
`;

export const GLSL_COLOR = /* glsl */ `
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

export const GLSL_ROTATE = /* glsl */ `
/**
 * Right-handed rotation about an axis by an angle (Rodrigues), written in
 * GLSL's column-major constructor order.
 *
 * Note: the snippet most commonly pasted around for this actually yields the
 * transpose — a rotation by *minus* the angle. Everything in this project
 * derives its bend axes with right-hand rules, so it has to be the real thing.
 */
mat3 rotateAxis(vec3 axis, float angle) {
  float s = sin(angle);
  float c = cos(angle);
  float t = 1.0 - c;
  return mat3(
    // column 0
    t * axis.x * axis.x + c,
    t * axis.x * axis.y + s * axis.z,
    t * axis.x * axis.z - s * axis.y,
    // column 1
    t * axis.x * axis.y - s * axis.z,
    t * axis.y * axis.y + c,
    t * axis.y * axis.z + s * axis.x,
    // column 2
    t * axis.x * axis.z + s * axis.y,
    t * axis.y * axis.z - s * axis.x,
    t * axis.z * axis.z + c
  );
}
mat2 rot2(float a) {
  float s = sin(a), c = cos(a);
  return mat2(c, -s, s, c);
}
`;

/**
 * Atmospheric perspective.
 *
 * Fog density falls off exponentially with height, and the optical depth is the
 * closed-form integral of that density along the ray from the camera to the
 * surface. That matters: the naive "distance x density" version has no idea how
 * high the camera is, so looking down at the field from three hundred metres up
 * buries the whole world in haze. Integrating along the ray means a high camera
 * genuinely looks through thinner air, and the aerial reveal reads.
 */
export const GLSL_ATMOSPHERE = /* glsl */ `
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform float uFogHeight;

float fogOpticalDepth(vec3 camPos, vec3 worldPos) {
  vec3 delta = worldPos - camPos;
  float dist = length(delta);
  if (dist < 0.001) return 0.0;
  float H = max(uFogHeight, 0.001);
  float ec = exp(-camPos.y / H);
  float dy = delta.y;
  // Near-horizontal rays: the integral degenerates to constant density.
  if (abs(dy) < 0.05) return uFogDensity * dist * ec;
  float ep = exp(-worldPos.y / H);
  return uFogDensity * dist * H * (ec - ep) / dy;
}

vec3 applyAtmosphere(vec3 color, vec3 worldPos) {
  float od = max(fogOpticalDepth(cameraPosition, worldPos), 0.0);
  return mix(color, uFogColor, clamp(1.0 - exp(-od), 0.0, 1.0));
}
`;

/**
 * Lighting shared by every organic surface: one key light (sun or moon), a sky
 * dome ambient, a bounce term from the ground, plus wrapped diffuse and
 * translucency so light reads as passing *through* petals and blades rather
 * than bouncing off them.
 */
export const GLSL_LIGHTING = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uSunIntensity;

vec3 organicLighting(vec3 normal, vec3 viewDir, vec3 albedo, float translucency, float wrap) {
  float ndl = dot(normal, uSunDir);
  float diff = clamp((ndl + wrap) / (1.0 + wrap), 0.0, 1.0);

  // Light bleeding through a thin surface: strongest when looking toward the sun.
  float back = clamp(dot(-normal, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
  float vdl = clamp(dot(viewDir, -uSunDir), 0.0, 1.0);
  float sss = pow(vdl, 3.0) * back * translucency;

  float hemi = clamp(normal.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 ambient = mix(uGroundColor, uSkyColor, hemi);

  vec3 lit = albedo * (ambient + uSunColor * diff * uSunIntensity);
  lit += uSunColor * albedo * sss * uSunIntensity * 1.6;
  return lit;
}

/** Grazing-angle rim light — what makes a silhouette separate from the sky. */
float rimTerm(vec3 normal, vec3 viewDir, float power) {
  return pow(clamp(1.0 - abs(dot(normal, viewDir)), 0.0, 1.0), power);
}
`;

/** Everything an organic surface shader needs, in dependency order. */
export const GLSL_LIB =
  GLSL_HASH + GLSL_NOISE + GLSL_COLOR + GLSL_ROTATE;
