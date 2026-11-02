// The gallery's region masks (M6c T6, ADR 0043): which pixels of each cell show the body's glass
// face, its rim, its limbs and its mouth, so the look metrics (`tests/e2e/look-metrics.ts`) read
// regions rather than whole cells. Each creature is drawn again, posed as on the sheet, with a
// fragment shader that writes its part classes instead of its look, into a target read back once.

import * as THREE from 'three';
import { MOUTH_PART_ID } from '../render/creature-mouth';

/** A cell's room (the caption band excluded) in whole sheet pixels, and its masks over it. */
export interface CellMasks {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Row-major bitsets over the room (bit `i % 8` of byte `i >> 3`), base64. */
  face: string;
  rim: string;
  limbs: string;
  mouth: string;
}

/**
 * Face pixels lie this many pixels inside the body's outline (the rim's band and its bloom are not
 * face), the rim band is this many pixels wide, and the mouth's disc is read this far inside it.
 */
export const FACE_INSET = 3;
export const RIM_BAND = 2;
export const MOUTH_INSET = 3;
/** Face and mouth pixels lie this far from any limb, fine part, shell or glint: their light and bloom. */
export const GLOW_CLEAR = 3;

/**
 * The classes, two passes of four channels, max-blended so each channel is the union of what drew
 * there. `uv.x` at or above 2 tags a pearl or fringe part (kind 1); the mouth's feature is part 31
 * (`MOUTH_PART_ID`).
 */
const MASK_FRAGMENT = /* glsl */ `
flat varying float vPart;
varying vec2 vUv;
uniform float uMaskPass;
void main() {
  float part = floor(vPart + 0.5);
  int kind = int(mod(part, 16.0) + 0.5);
  bool mouth = floor(part / 16.0 + 0.01) == MOUTH_PART_ID;
  bool tagged = vUv.x >= 2.0;
  vec4 a = vec4(
    float(kind == 0 || kind == 2),
    float(kind == 3),
    float(kind == 1 && !tagged && !mouth),
    float(kind >= 7 && kind <= 13));
  vec4 b = vec4(
    float(mouth),
    float(!mouth && (kind == 5 || kind == 6 || kind == 15 || (kind == 1 && tagged))),
    float(kind == 4),
    float(kind == 14));
  gl_FragColor = uMaskPass < 0.5 ? a : b;
}
`;

/** Pass A's channels, then pass B's, as bits of one byte per pixel. */
const HULL = 1;
const MOUTH = 2;
const LIMB = 4;
const ORGAN = 8;
const MOUTH_PART = 16;
const FINE = 32;
const SHELL = 64;
const GLINT = 128;

/** Draws `meshes` (as `camera` sees them) as part classes: one byte of class bits per pixel, top row first. */
export function renderClasses(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  meshes: readonly THREE.Mesh[],
  width: number,
  height: number,
): Uint8Array {
  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.UnsignedByteType,
    depthBuffer: false,
  });
  const pass = { value: 0 };
  const originals = meshes.map((mesh) => mesh.material as THREE.ShaderMaterial);
  const masks = originals.map(
    (m) =>
      new THREE.ShaderMaterial({
        vertexShader: m.vertexShader,
        fragmentShader: MASK_FRAGMENT,
        // The view's own uniform objects, so the pose is the sheet's.
        uniforms: { ...m.uniforms, uMaskPass: pass },
        defines: { ...m.defines, MOUTH_PART_ID: `${MOUTH_PART_ID}.0` },
        side: m.side,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendEquation: THREE.MaxEquation,
        blendEquationAlpha: THREE.MaxEquation,
      }),
  );
  const out = new Uint8Array(width * height);
  const rgba = new Uint8Array(width * height * 4);
  const clear = new THREE.Color();
  renderer.getClearColor(clear);
  const clearAlpha = renderer.getClearAlpha();
  meshes.forEach((mesh, i) => {
    mesh.material = masks[i] as THREE.ShaderMaterial;
  });
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  for (const [p, bits] of [
    [0, [HULL, MOUTH, LIMB, ORGAN]],
    [1, [MOUTH_PART, FINE, SHELL, GLINT]],
  ] as const) {
    pass.value = p;
    renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, rgba);
    for (let y = 0; y < height; y++) {
      // The target's first row is the bottom of the picture.
      const row = (height - 1 - y) * width;
      for (let x = 0; x < width; x++) {
        const i = (row + x) * 4;
        let v = out[y * width + x] as number;
        for (let c = 0; c < 4; c++) if ((rgba[i + c] as number) > 127) v |= bits[c] as number;
        out[y * width + x] = v;
      }
    }
  }
  renderer.setRenderTarget(null);
  renderer.setClearColor(clear, clearAlpha);
  meshes.forEach((mesh, i) => {
    mesh.material = originals[i] as THREE.ShaderMaterial;
  });
  for (const m of masks) m.dispose();
  target.dispose();
  return out;
}

/** `mask` grown by `steps` pixels (8-connected). */
function dilate(mask: Uint8Array, w: number, h: number, steps: number): Uint8Array {
  let cur = mask;
  for (let s = 0; s < steps; s++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let any = 0;
        for (let dy = -1; dy <= 1 && !any; dy++) {
          for (let dx = -1; dx <= 1 && !any; dx++) {
            const [u, v] = [x + dx, y + dy];
            if (u >= 0 && v >= 0 && u < w && v < h) any = cur[v * w + u] as number;
          }
        }
        next[y * w + x] = any;
      }
    }
    cur = next;
  }
  return cur;
}

/** `mask` shrunk by `steps` pixels (8-connected): a pixel stays while every neighbour is set. */
function erode(mask: Uint8Array, w: number, h: number, steps: number): Uint8Array {
  let cur = mask;
  for (let s = 0; s < steps; s++) {
    const next = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let all = 1;
        for (let dy = -1; dy <= 1 && all; dy++) {
          for (let dx = -1; dx <= 1 && all; dx++) all = cur[(y + dy) * w + x + dx] as number;
        }
        next[y * w + x] = all;
      }
    }
    cur = next;
  }
  return cur;
}

function toBase64(mask: Uint8Array): string {
  const bytes = new Uint8Array((mask.length + 7) >> 3);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) bytes[i >> 3] = (bytes[i >> 3] as number) | (1 << (i & 7));
  }
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

/**
 * One cell's masks from the class bytes of the whole sheet (`sheetWidth` wide):
 * - face: the body's own glass, `FACE_INSET` inside its outline, clear of every organ (and a pixel
 *   round it) and the mouth, and `GLOW_CLEAR` from every limb, fine part, shell and glint;
 * - rim: the outline's outer `RIM_BAND` pixels where nothing else draws over the body;
 * - limbs: the outer `RIM_BAND` pixels of the limbs off the body, clear of everything else (pearl
 *   tips and fringe excluded): a thin limb whole, a paddle its edge, as the rim is the body's;
 * - mouth: the mouth's disc on the body, `MOUTH_INSET` inside the outline, as clear as the face.
 */
export function cellMasks(
  classes: Uint8Array,
  sheetWidth: number,
  room: { x: number; y: number; w: number; h: number },
): CellMasks {
  const x0 = Math.ceil(room.x);
  const y0 = Math.ceil(room.y);
  const w = Math.floor(room.x + room.w) - x0;
  const h = Math.floor(room.y + room.h) - y0;
  const at = (x: number, y: number): number => classes[(y0 + y) * sheetWidth + x0 + x] as number;
  const OVER = LIMB | MOUTH_PART | FINE | SHELL | GLINT;
  const hull = new Uint8Array(w * h);
  const organ = new Uint8Array(w * h);
  const over = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = at(x, y);
      hull[y * w + x] = v & (HULL | MOUTH) ? 1 : 0;
      organ[y * w + x] = v & ORGAN ? 1 : 0;
      over[y * w + x] = v & OVER ? 1 : 0;
    }
  }
  // An organ's lit wall spills a pixel; a bright part seen through the glass, and its bloom, more.
  const nearOrgan = dilate(organ, w, h, 1);
  const nearOver = dilate(over, w, h, GLOW_CLEAR);
  const faceIn = erode(hull, w, h, FACE_INSET);
  const mouthIn = erode(hull, w, h, MOUTH_INSET);
  const rimIn = erode(hull, w, h, RIM_BAND);
  const face = new Uint8Array(w * h);
  const rim = new Uint8Array(w * h);
  const limb = new Uint8Array(w * h);
  const mouth = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = at(x, y);
      const glass = !nearOver[i] && !nearOrgan[i];
      face[i] = faceIn[i] && v & HULL && !(v & MOUTH) && glass ? 1 : 0;
      rim[i] = hull[i] && !rimIn[i] && !over[i] && !nearOrgan[i] ? 1 : 0;
      limb[i] = v & LIMB && !hull[i] && !(v & (ORGAN | MOUTH_PART | FINE | SHELL | GLINT)) ? 1 : 0;
      mouth[i] = mouthIn[i] && v & MOUTH && glass ? 1 : 0;
    }
  }
  // A limb's edge, as the body's rim is the body's: a thin limb is all edge, a paddle its outline.
  const limbIn = erode(limb, w, h, RIM_BAND);
  const limbs = limb.map((v, i) => (v && !limbIn[i] ? 1 : 0));
  return {
    x: x0,
    y: y0,
    w,
    h,
    face: toBase64(face),
    rim: toBase64(rim),
    limbs: toBase64(limbs),
    mouth: toBase64(mouth),
  };
}
