// assets.mjs — the vendored CC0 photo textures, plus the generated maps that
// are too big or too specific to ship as files.
//
// The photo set lives in web/vendor/textures/ and is embedded in the binary
// exactly like three.js is: no CDN, no runtime download from anywhere but us.
// Sources are ambientCG (CC0): Grass004 (lawn), Grass001 (rough pasture),
// Bark012, Ground054, and LeafSet004 composited into the canopy card atlas.
//
// EVERY lookup is allowed to fail. If a file is missing the loader resolves to
// null and the caller falls back to the procedural texture it used before, so a
// half-deployed build renders a slightly plainer garden instead of a black
// screen. Callers must therefore always write `PHOTO.x || proceduralX()`.

import * as THREE from 'three';

const BASE = 'vendor/textures/';

const FILES = {
  grassColor:  ['grass_color.jpg',  1],
  grassNormal: ['grass_normal.jpg', 0],
  grassRough:  ['grass_rough.jpg',  0],
  hillColor:   ['hill_color.jpg',   1],
  barkColor:   ['bark_color.jpg',   1],
  barkNormal:  ['bark_normal.jpg',  0],
  soilColor:   ['soil_color.jpg',   1],
  soilNormal:  ['soil_normal.jpg',  0],
  leafClump:   ['leafclump.png',    1],
};

/** Filled in by loadPhotoTextures(). A missing key means "use the fallback". */
export const PHOTO = {};

/** Which files actually arrived — reported in the boot log for diagnosis. */
export const PHOTO_STATUS = { loaded: [], missing: [] };

/**
 * Load every photo texture. Never rejects. Call once, before the first world
 * is built, so downstream code sees a stable set rather than textures popping
 * in halfway through construction.
 */
export function loadPhotoTextures(maxAnisotropy = 8) {
  const loader = new THREE.TextureLoader();
  const jobs = Object.entries(FILES).map(([key, [file, srgb]]) => new Promise((resolve) => {
    loader.load(
      BASE + file,
      (t) => {
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = maxAnisotropy;
        t.needsUpdate = true;
        PHOTO[key] = t;
        PHOTO_STATUS.loaded.push(file);
        resolve();
      },
      undefined,
      () => { PHOTO_STATUS.missing.push(file); resolve(); }
    );
  }));
  return Promise.all(jobs).then(() => PHOTO);
}

/** A repeat-wrapped clone, so two users can tile the same photo differently. */
export function tiled(tex, rx, ry) {
  if (!tex) return null;
  const t = tex.clone();
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry === undefined ? rx : ry);
  t.needsUpdate = true;
  return t;
}

// ── the fiber map ────────────────────────────────────────────────────────────
// One texel ≈ one blade of grass. The shell shader tests `k/N < R * length` to
// decide whether a blade is still standing at that shell, so R is effectively
// each blade's own height as a fraction of the local grass length: varying it
// per texel is what stops the lawn looking like N stacked sheets.
//
// Blades are CLUMPED, not independent — real turf grows in tufts — so a coarse
// smooth field modulates the per-texel random. Roughly 12% of texels are bare
// so the soil/base turf shows through and the lawn reads as grass rather than
// felt.
let _fiber = null;

export function fiberTexture(size = 1024) {
  if (_fiber && _fiber.image.width === size) return _fiber;

  const hash = (x, y) => {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };

  // coarse clump field, bilinearly upsampled
  const C = 48;
  const cf = new Float32Array(C * C);
  for (let i = 0; i < C * C; i++) cf[i] = hash(i % C, (i / C) | 0);
  const clumpAt = (u, v) => {
    const fx = u * C, fy = v * C;
    const x0 = Math.floor(fx) % C, y0 = Math.floor(fy) % C;
    const x1 = (x0 + 1) % C, y1 = (y0 + 1) % C;
    let tx = fx - Math.floor(fx), ty = fy - Math.floor(fy);
    tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    const a = cf[y0 * C + x0], b = cf[y0 * C + x1];
    const c = cf[y1 * C + x0], d = cf[y1 * C + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };

  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const r = hash(x + 7, y + 13);
      const clump = clumpAt(x / size, y / size);
      // pow() biases toward shorter blades; the clump field lifts whole tufts
      let n = Math.pow(r, 0.85) * (0.42 + 0.80 * clump);
      if (r < 0.12) n = 0;                       // bare ground between tufts
      data[o] = Math.min(255, n * 255) | 0;                       // blade height
      data[o + 1] = (hash(x + 101, y + 57) * 255) | 0;            // hue jitter
      data[o + 2] = (hash(x + 211, y + 307) * 255) | 0;           // lateral lean
      data[o + 3] = 255;
    }
  }

  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  _fiber = t;
  return t;
}
