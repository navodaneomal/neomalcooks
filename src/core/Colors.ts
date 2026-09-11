import * as THREE from 'three';

/**
 * One place to turn a designer-facing hex into a shader-ready colour.
 *
 * three.js has colour management on by default, so `new THREE.Color(0xrrggbb)`
 * *already* decodes sRGB into the linear working space. Calling
 * `convertSRGBToLinear()` on top of that decodes it a second time and darkens
 * everything by roughly 5x while pushing saturation up — the classic symptom is
 * a black ground under candy-coloured flowers.
 *
 * Every colour in this project goes through here so that mistake has exactly
 * one place it could ever live.
 */

/** A palette hex (as a designer would write it) as a linear working colour. */
export function srgb(hex: number): THREE.Color {
  return new THREE.Color(hex);
}

/** Same, from 0..1 sRGB components. */
export function srgb3(r: number, g: number, b: number): THREE.Color {
  return new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
}

/** Write an sRGB hex into an existing colour, in place. */
export function setSrgb(target: THREE.Color, hex: number): THREE.Color {
  return target.setHex(hex, THREE.SRGBColorSpace);
}

/** Mix two sRGB hexes and write the linear result into `out`. */
export function mixSrgb(a: number, b: number, t: number, out: THREE.Color): THREE.Color {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  // Interpolating in sRGB (gamma) space is the right choice here: these are
  // art-directed gradients between hand-picked swatches, and blending them the
  // way a designer would in a colour picker keeps the midpoints on the intended
  // hue instead of drifting dark.
  return out.setRGB(
    (ar + (br - ar) * t) / 255,
    (ag + (bg - ag) * t) / 255,
    (ab + (bb - ab) * t) / 255,
    THREE.SRGBColorSpace,
  );
}
