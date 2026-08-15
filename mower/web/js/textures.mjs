// textures.mjs — procedural CanvasTexture factories.
//
// Everything in this demo is generated at runtime: no image files, no CDN,
// nothing to 404 on a customer's laptop. Each texture is built once and cached
// by key; they are small (256–512 px) so total upload is well under a MB.

import * as THREE from 'three';

const cache = new Map();

// deterministic noise so a reload looks identical
let _s = 1;
const seed = (v) => { _s = (v >>> 0) || 1; };
const rnd = () => {
  _s ^= _s << 13; _s >>>= 0;
  _s ^= _s >>> 17;
  _s ^= _s << 5; _s >>>= 0;
  return _s / 4294967296;
};

function texture(key, w, h, draw, opt = {}) {
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  seed(opt.seed || 12345);
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = opt.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  const wrap = opt.clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  t.wrapS = t.wrapT = wrap;
  t.anisotropy = 8;
  if (opt.repeat) t.repeat.set(opt.repeat[0], opt.repeat[1]);
  t.needsUpdate = true;
  cache.set(key, t);
  return t;
}

/** speckle helper: n dots of jittered colour */
function speckle(g, w, h, n, rMin, rMax, colors, alpha = 1) {
  for (let i = 0; i < n; i++) {
    const x = rnd() * w, y = rnd() * h;
    const r = rMin + rnd() * (rMax - rMin);
    g.globalAlpha = alpha * (0.35 + rnd() * 0.65);
    g.fillStyle = colors[(rnd() * colors.length) | 0];
    g.beginPath();
    g.ellipse(x, y, r, r * (0.6 + rnd() * 0.8), rnd() * 3.14, 0, 6.284);
    g.fill();
  }
  g.globalAlpha = 1;
}

// ── falu red wood panelling ──────────────────────────────────────────────────
// One tile = 1.6 m of wall: ten 16 cm vertical planks, grain streaks, weathering.
export const faluWood = () => texture('falu', 256, 256, (g, w, h) => {
  g.fillStyle = '#9c3b26';
  g.fillRect(0, 0, w, h);
  // broad weathering blotches
  speckle(g, w, h, 90, 8, 34, ['#8e3421', '#a9432c', '#87301d', '#b04a30'], 0.30);
  const planks = 10, pw = w / planks;
  for (let i = 0; i < planks; i++) {
    const x = i * pw;
    // per-plank tone
    g.globalAlpha = 0.20 + rnd() * 0.22;
    g.fillStyle = rnd() > 0.5 ? '#a94430' : '#8a3220';
    g.fillRect(x, 0, pw, h);
    g.globalAlpha = 1;
    // grain streaks
    for (let k = 0; k < 26; k++) {
      g.strokeStyle = rnd() > 0.5 ? 'rgba(70,24,14,0.16)' : 'rgba(196,96,70,0.13)';
      g.lineWidth = 0.6 + rnd() * 1.1;
      const gx = x + 1.5 + rnd() * (pw - 3);
      g.beginPath();
      g.moveTo(gx, 0);
      g.bezierCurveTo(gx + (rnd() - 0.5) * 4, h * 0.35, gx + (rnd() - 0.5) * 4, h * 0.7, gx + (rnd() - 0.5) * 3, h);
      g.stroke();
    }
    // shadowed joint on the left edge, catch-light on the right
    g.fillStyle = 'rgba(48,16,9,0.55)';
    g.fillRect(x, 0, 1.6, h);
    g.fillStyle = 'rgba(226,132,100,0.20)';
    g.fillRect(x + 1.6, 0, 1.1, h);
  }
  speckle(g, w, h, 400, 0.4, 1.5, ['#6d2617', '#c05c40'], 0.35);
});

// ── roof tile ────────────────────────────────────────────────────────────────
// One tile = 1 m of roof: rows of dark concrete pantiles.
export const roofTile = () => texture('roof', 256, 256, (g, w, h) => {
  g.fillStyle = '#5a616b';
  g.fillRect(0, 0, w, h);
  const rows = 6, cols = 8;
  const rh = h / rows, cw = w / cols;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cw + ((r & 1) ? cw * 0.5 : 0) - cw * 0.5;
      const y = r * rh;
      const v = 0.82 + rnd() * 0.36;
      const base = Math.round(92 * v);
      g.fillStyle = `rgb(${base},${base + 4},${base + 9})`;
      g.beginPath();
      g.roundRect ? g.roundRect(x + 1, y + 1, cw - 2, rh - 1.5, 2.5)
                  : g.rect(x + 1, y + 1, cw - 2, rh - 1.5);
      g.fill();
      // top highlight, bottom shade — reads as overlapping pantiles
      g.fillStyle = 'rgba(150,164,180,0.16)';
      g.fillRect(x + 1, y + 1, cw - 2, 1.6);
      g.fillStyle = 'rgba(0,0,0,0.30)';
      g.fillRect(x + 1, y + rh - 3.2, cw - 2, 3.2);
    }
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.fillRect(0, r * rh, w, 1.2);
  }
  speckle(g, w, h, 500, 0.4, 1.4, ['#3b424b', '#8b95a2'], 0.4);
});

// ── gravel path ──────────────────────────────────────────────────────────────
export const gravel = () => texture('gravel', 256, 256, (g, w, h) => {
  g.fillStyle = '#b3ad9f';
  g.fillRect(0, 0, w, h);
  speckle(g, w, h, 260, 3, 9, ['#9d9689', '#c6c0b2', '#8d867a', '#d3cec2'], 0.5);
  speckle(g, w, h, 1600, 0.6, 2.4, ['#6f695f', '#e0dbd0', '#8a8377', '#c9c3b6'], 0.75);
  // faint wheel-worn darkening
  g.fillStyle = 'rgba(90,84,74,0.10)';
  g.fillRect(0, 0, w, h);
});

// ── white painted trim (corner boards, window frames) ────────────────────────
export const paintedWhite = () => texture('whitepaint', 64, 64, (g, w, h) => {
  g.fillStyle = '#f2ece0';
  g.fillRect(0, 0, w, h);
  speckle(g, w, h, 120, 0.6, 2.2, ['#e2dccd', '#fbf7ee', '#d8d1c1'], 0.4);
});

// ── contact shadow decal (soft radial alpha) ─────────────────────────────────
// Stand-in for SSAO: a cheap grounding blob under every solid object.
export const contactShadow = () => texture('contact', 128, 128, (g, w, h) => {
  const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  grd.addColorStop(0.00, 'rgba(0,0,0,0.62)');
  grd.addColorStop(0.42, 'rgba(0,0,0,0.34)');
  grd.addColorStop(0.72, 'rgba(0,0,0,0.10)');
  grd.addColorStop(1.00, 'rgba(0,0,0,0.00)');
  g.fillStyle = grd;
  g.fillRect(0, 0, w, h);
}, { clamp: true });

// ── soft glow sprite ─────────────────────────────────────────────────────────
// A SpriteMaterial with no map draws a SOLID square — which is what the LED and
// dock "glows" were doing. This radial falloff is what makes them read as light.
export const glowSprite = () => texture('glow', 128, 128, (g, w, h) => {
  const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  grd.addColorStop(0.00, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, 'rgba(255,255,255,0.72)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.22)');
  grd.addColorStop(0.75, 'rgba(255,255,255,0.05)');
  grd.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, w, h);
}, { clamp: true });

// ── bark fallback ────────────────────────────────────────────────────────────
// Only used when vendor/textures/bark_color.jpg is missing. Vertical striation
// with deep fissures — the one bark cue you cannot do without.
export const barkFallback = () => texture('barkfb', 256, 256, (g, w, h) => {
  g.fillStyle = '#5b4a35';
  g.fillRect(0, 0, w, h);
  for (let k = 0; k < 150; k++) {
    const x = rnd() * w;
    g.strokeStyle = rnd() > 0.5 ? 'rgba(32,24,15,0.42)' : 'rgba(150,131,102,0.26)';
    g.lineWidth = 0.7 + rnd() * 3.2;
    g.beginPath();
    g.moveTo(x, 0);
    g.bezierCurveTo(x + (rnd() - 0.5) * 9, h * 0.33, x + (rnd() - 0.5) * 9, h * 0.66,
      x + (rnd() - 0.5) * 7, h);
    g.stroke();
  }
  speckle(g, w, h, 500, 0.5, 2.4, ['#3a2e20', '#7d6a4e', '#8f7c5c'], 0.35);
});

// ── leaf-clump card fallback ─────────────────────────────────────────────────
// Only used when vendor/textures/leafclump.png is missing. A 2x2 atlas of
// ragged blobs of leaf-sized speckles, alpha-tested exactly like the photo one.
export const leafClumpFallback = () => texture('leaffb', 512, 512, (g, w, h) => {
  g.clearRect(0, 0, w, h);
  const C = w / 2;
  for (let t = 0; t < 4; t++) {
    const ox = (t % 2) * C, oy = ((t / 2) | 0) * C;
    for (let i = 0; i < 210; i++) {
      // rejection-sample against a lumpy radial density so the outline is ragged
      const x = 0.12 + rnd() * 0.76, y = 0.12 + rnd() * 0.76;
      const r = Math.hypot(x - 0.5, y - 0.5);
      const lobe = 0.30 + 0.10 * Math.sin(Math.atan2(y - 0.5, x - 0.5) * 3.7 + t);
      if (r > lobe * (0.75 + rnd() * 0.55)) continue;
      const k = 1 - r / 0.5;
      const v = 0.42 + 0.62 * k;
      g.globalAlpha = 0.85 + rnd() * 0.15;
      g.fillStyle = `rgb(${Math.round(52 * v + rnd() * 24)},${Math.round(104 * v + rnd() * 30)},${Math.round(34 * v + rnd() * 18)})`;
      g.beginPath();
      const s = C * (0.045 + rnd() * 0.045);
      g.ellipse(ox + x * C, oy + y * C, s, s * (0.55 + rnd() * 0.5), rnd() * 6.28, 0, 6.284);
      g.fill();
    }
  }
  g.globalAlpha = 1;
}, { clamp: true });

// ── distant treeline silhouette ──────────────────────────────────────────────
// Alpha strip of overlapping conifer profiles, tiled around the horizon. At
// 200 m a real forest is a ragged EDGE, not a row of readable trees — which is
// exactly what 3D cones got wrong: they caught light individually and read as
// party hats. A flat alpha silhouette tinted by fog is both cheaper and far
// more convincing.
export const pineBand = () => texture('pineband', 1024, 256, (g, w, h) => {
  g.clearRect(0, 0, w, h);
  const tree = (x, top, halfW, tone) => {
    g.fillStyle = tone;
    g.beginPath();
    g.moveTo(x, h);
    // stepped conifer profile: a few tiers of drooping branches per side
    const tiers = 5 + ((rnd() * 3) | 0);
    for (let i = tiers; i >= 1; i--) {
      const t = i / tiers;
      const y = h - (h - top) * (1 - t);
      const wx = halfW * t * (0.82 + rnd() * 0.36);
      g.lineTo(x - wx, y);
      g.lineTo(x - wx * 0.55, y - (h - top) / tiers * 0.55);
    }
    g.lineTo(x, top);
    for (let i = 1; i <= tiers; i++) {
      const t = i / tiers;
      const y = h - (h - top) * (1 - t);
      const wx = halfW * t * (0.82 + rnd() * 0.36);
      g.lineTo(x + wx * 0.55, y - (h - top) / tiers * 0.55);
      g.lineTo(x + wx, y);
    }
    g.closePath();
    g.fill();
  };
  // back rank first (paler = further), then the front rank over it
  // Tree COUNT per tile sets their aspect ratio once the strip is mapped onto
  // ~60 m of horizon. At 40 per tile they came out 1.5 m wide and 30 m tall —
  // vertical streaks. A dozen per tile gives a believable 1:4 conifer.
  for (const [n, tone, hMin, hMax] of [
    [16, '#5a6a60', 0.40, 0.64], [14, '#3f5148', 0.52, 0.82], [12, '#2b3a33', 0.62, 1.0],
  ]) {
    for (let i = 0; i < n; i++) {
      const x = (i + rnd() * 0.9) * (w / n);
      const th = hMin + rnd() * (hMax - hMin);
      tree(x, h * (1 - th), w / n * (0.34 + rnd() * 0.26), tone);
    }
  }
  // a solid skirt along the bottom so the band never shows daylight under it
  g.fillStyle = '#2b3a33';
  g.fillRect(0, h - 14, w, 14);
});

// ── rock speckle ─────────────────────────────────────────────────────────────
export const rockFace = () => texture('rock', 128, 128, (g, w, h) => {
  g.fillStyle = '#968f86';
  g.fillRect(0, 0, w, h);
  speckle(g, w, h, 140, 4, 16, ['#847d74', '#a9a298', '#767068', '#b8b1a6'], 0.45);
  speckle(g, w, h, 700, 0.5, 2.0, ['#69635b', '#cdc6ba'], 0.5);
  // lichen
  speckle(g, w, h, 30, 3, 9, ['#7f8a5e', '#96a06c'], 0.22);
});
