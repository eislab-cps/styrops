// obstacles.mjs — garden props, one Object3D per model.Obstacle.
//
// COORDINATE CONVENTION (see scene.mjs): three.x = model.x, three.z = -model.y.
//
// The layer reconciles against the obstacle list carried by model.World, which
// arrives on load (GET /api/world) and again on every WS "world" frame.
// Everything is procedural: noise-displaced primitives, shared geometry and
// material caches, and a baked radial contact shadow under each prop so nothing
// looks like it is hovering.

import * as THREE from 'three';
import { contactShadow, rockFace, barkFallback, leafClumpFallback } from './textures.mjs';
import { heightAt, WIND, GUST_GLSL } from './terrain.mjs';
import { PHOTO } from './assets.mjs';

const TYPES = ['rock', 'tree', 'trampoline', 'toy', 'flowerbed', 'hedgehog'];
export const OBSTACLE_TYPES = TYPES;

export const TYPE_LABEL = {
  rock: 'Rock', tree: 'Tree', trampoline: 'Trampoline',
  toy: 'Toy', flowerbed: 'Flowerbed', hedgehog: 'Hedgehog',
};

function seedOf(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let a = seed || 1;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// shared geometry / material caches — props are numerous, allocations are not
const G = {};
const M = {};
const geo = (k, make) => G[k] || (G[k] = make());
const mat = (k, make) => M[k] || (M[k] = make());
// Standard (not Lambert) so every prop picks up scene.environment — the sky
// PMREM probe is most of what makes these read as objects in real light.
const lam = (color, o = {}) => new THREE.MeshStandardMaterial(
  Object.assign({ color, roughness: 0.88, metalness: 0.0 }, o));

/** Canopy cards per tree. scene.mjs lowers this on the software-raster tier. */
let FOLIAGE = 190;
export const setFoliageBudget = (n) => { FOLIAGE = Math.max(18, n | 0); };

/** Push every vertex of a geometry out along its normal by fbm-ish noise. */
function jitter(g, amount, rnd) {
  const p = g.attributes.position;
  const n = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const d = 1 + (rnd() - 0.5) * amount;
    p.setXYZ(i, p.getX(i) * d, p.getY(i) * d, p.getZ(i) * d);
  }
  p.needsUpdate = true;
  if (n) g.computeVertexNormals();
  return g;
}

// ── contact shadow decal ─────────────────────────────────────────────────────
// Cheap stand-in for SSAO. Takes MODEL coordinates and returns a mesh already
// placed in three-space.
export function contactDecal(mx, my, radius, y = 0.05, opacity = 0.75) {
  const m = new THREE.Mesh(
    geo('decal', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)),
    mat('decal', () => new THREE.MeshBasicMaterial({
      map: contactShadow(), transparent: true, depthWrite: false,
      color: 0x000000, opacity: 0.75, toneMapped: false,
    }))
  );
  if (opacity !== 0.75) {
    m.material = m.material.clone();
    m.material.opacity = opacity;
  }
  m.scale.set(radius * 2, 1, radius * 2);
  // the ground is not flat — sit the blob on it, not on y = 0
  m.position.set(mx, heightAt(mx, my) + y, -my);
  m.renderOrder = 2;
  return m;
}

// ── props ────────────────────────────────────────────────────────────────────

function buildRock(r, rnd) {
  const g = new THREE.Group();
  const geom = jitter(new THREE.IcosahedronGeometry(1, 1), 0.34, rnd);
  const m = new THREE.Mesh(geom, mat('rockmat', () => new THREE.MeshLambertMaterial({
    map: rockFace(), flatShading: true,
  })));
  m.scale.set(r * (0.95 + rnd() * 0.3), r * (0.66 + rnd() * 0.3), r * (0.95 + rnd() * 0.3));
  m.rotation.set(rnd() * 3, rnd() * 6, rnd() * 3);
  m.position.y = r * 0.44;
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);
  // a couple of chips at the base
  for (let i = 0; i < 2; i++) {
    const c = new THREE.Mesh(geo('chip', () => new THREE.IcosahedronGeometry(1, 0)),
      mat('rockmat2', () => lam(0x8a837a, { flatShading: true })));
    const a = rnd() * 6.28, s = r * (0.14 + rnd() * 0.12);
    c.scale.set(s, s * 0.6, s);
    c.position.set(Math.cos(a) * r * 0.95, s * 0.4, Math.sin(a) * r * 0.95);
    c.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
    c.castShadow = true;
    g.add(c);
  }
  return g;
}

// ── trees ────────────────────────────────────────────────────────────────────
//
// A tree is two meshes and two draw calls: one merged bark geometry for the
// whole branching skeleton, and one merged sheet of alpha-tested leaf-clump
// cards for the canopy.
//
// The canopy is deliberately NOT a solid volume. Cards sit at branch tips with
// random orientation, so the silhouette is ragged and daylight comes through
// the gaps — that airiness is most of what separates a tree from a lollipop at
// demo camera distance. Because the cards carry ordinary baked UVs into the
// clump atlas, three's own depth material picks up map + alphaTest and the
// canopy casts a dappled shadow rather than a solid blob.

const BARK_TILE = 0.55;                  // metres per repeat of the bark photo

const emptyMesh = () => ({ pos: [], nrm: [], uv: [], col: [], sway: [], idx: [] });

/**
 * Append one tapered, closed tube from a to b. Returns the running distance
 * along the limb so the bark texture keeps flowing across segment joints.
 */
function emitTube(o, ax, ay, az, bx, by, bz, r0, r1, sides, v0) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const L = Math.hypot(dx, dy, dz);
  if (L < 1e-5) return v0;
  const ux = dx / L, uy = dy / L, uz = dz / L;

  // perpendicular frame; cross(u, +Y) degenerates on a vertical limb (the trunk)
  let px = -uz, py = 0, pz = ux;
  if (Math.hypot(px, pz) < 1e-4) { px = 1; py = 0; pz = 0; }
  const pl = Math.hypot(px, py, pz);
  px /= pl; py /= pl; pz /= pl;
  const qx = uy * pz - uz * py, qy = uz * px - ux * pz, qz = ux * py - uy * px;

  const base = o.pos.length / 3;
  const uSpan = (6.2832 * r0) / BARK_TILE;
  for (let ring = 0; ring < 2; ring++) {
    const cx = ring ? bx : ax, cy = ring ? by : ay, cz = ring ? bz : az;
    const rr = ring ? r1 : r0;
    const v = (v0 + (ring ? L : 0)) / BARK_TILE;
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * 6.2832;
      const c = Math.cos(a), s = Math.sin(a);
      const nx = px * c + qx * s, ny = py * c + qy * s, nz = pz * c + qz * s;
      o.pos.push(cx + nx * rr, cy + ny * rr, cz + nz * rr);
      o.nrm.push(nx, ny, nz);
      o.uv.push((i / sides) * uSpan, v);
    }
  }
  const stride = sides + 1;
  for (let i = 0; i < sides; i++) {
    const a0 = base + i, a1 = a0 + 1, b0 = base + stride + i, b1 = b0 + 1;
    o.idx.push(a0, b0, b1, a0, b1, a1);
  }
  return v0 + L;
}

function toGeometry(o, withColor) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(o.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(o.nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(o.uv, 2));
  if (withColor) {
    g.setAttribute('color', new THREE.Float32BufferAttribute(o.col, 3));
    g.setAttribute('aSway', new THREE.Float32BufferAttribute(o.sway, 1));
  }
  g.setIndex(o.idx);
  return g;
}

/** Shared, lazily built materials — one per app, not one per tree. */
const barkMaterial = () => mat('barkmat', () => {
  const m = new THREE.MeshStandardMaterial({
    map: PHOTO.barkColor || barkFallback(),
    color: 0x9d8e73,                     // neutralise the photo's olive cast
    roughness: 0.96, metalness: 0.0,
  });
  if (PHOTO.barkNormal) {
    m.normalMap = PHOTO.barkNormal;
    m.normalScale = new THREE.Vector2(1.1, 1.1);
  }
  return m;
});

const leafMaterial = () => mat('leafmat', () => {
  const m = new THREE.MeshStandardMaterial({
    map: PHOTO.leafClump || leafClumpFallback(),
    alphaTest: 0.45, side: THREE.DoubleSide, vertexColors: true,
    roughness: 0.80, metalness: 0.0,
  });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = WIND.uTime;
    sh.uniforms.uWind = WIND.uWind;
    sh.vertexShader = `attribute float aSway;\n${GUST_GLSL}` + sh.vertexShader
      .replace('#include <begin_vertex>', /* glsl */`
        vec3 transformed = vec3( position );
        // Same gust field as the lawn, run at roughly half speed: a canopy has
        // mass, so it answers a gust later and more slowly than grass does.
        vec3 wp = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
        vec2 gg = gustField( vec2( wp.x, -wp.z ), uTime * 0.55 );
        float s = aSway * aSway;
        transformed.x += gg.x * uWind * s * 3.2;
        transformed.z -= gg.y * uWind * s * 3.2;
      `);
  };
  m.customProgramCacheKey = () => 'leafcard';
  return m;
});

function buildTree(r, rnd) {
  const g = new THREE.Group();
  const H = 2.4 + r * 2.2;                     // trunk height
  const canopyR = Math.max(0.85, r * 1.45);
  const trunkR = 0.055 + r * 0.075;

  const bark = emptyMesh();
  const spots = [];                            // where canopy cards may sit

  /**
   * Grow one limb, recursively. Segments let a limb curve; primaries and
   * secondaries also droop under their own weight, which is the single cue
   * that stops a branch skeleton looking like scaffolding.
   */
  function grow(x, y, z, dx, dy, dz, len, r0, r1, depth) {
    const segs = depth === 0 ? 5 : depth === 1 ? 4 : 3;
    const sides = depth === 0 ? 8 : depth === 1 ? 6 : 5;
    const droop = depth === 0 ? 0.02 : depth === 1 ? 0.30 : 0.62;
    const wander = depth === 0 ? 0.055 : 0.16;
    let cx = x, cy = y, cz = z;
    let ux = dx, uy = dy, uz = dz;
    let v = 0;
    const sl = len / segs;

    for (let s = 0; s < segs; s++) {
      const nxp = cx + ux * sl, nyp = cy + uy * sl, nzp = cz + uz * sl;
      const ra = r0 + (r1 - r0) * (s / segs);
      const rb = r0 + (r1 - r0) * ((s + 1) / segs);
      v = emitTube(bark, cx, cy, cz, nxp, nyp, nzp, ra, rb, sides, v);
      cx = nxp; cy = nyp; cz = nzp;

      // children hang off the segment joints, never off the very base
      if (depth < 2 && s >= (depth === 0 ? 1 : 0)) {
        const kids = depth === 0 ? 1 : (s === segs - 1 ? 2 : 1);
        for (let k = 0; k < kids; k++) {
          // golden-angle azimuth keeps successive branches from stacking up
          const az = (spots.length + k) * 2.399 + rnd() * 0.9;
          const out = depth === 0 ? 0.80 + rnd() * 0.38 : 0.62 + rnd() * 0.42;
          let ppx = -uz, ppy = 0, ppz = ux;
          if (Math.hypot(ppx, ppz) < 1e-4) { ppx = 1; ppz = 0; }
          const pl = Math.hypot(ppx, ppy, ppz);
          ppx /= pl; ppy /= pl; ppz /= pl;
          const qqx = uy * ppz - uz * ppy, qqy = uz * ppx - ux * ppz, qqz = ux * ppy - uy * ppx;
          const ca = Math.cos(az), sa = Math.sin(az);
          const co = Math.cos(out), so = Math.sin(out);
          let bx = ux * co + (ppx * ca + qqx * sa) * so;
          let by = uy * co + (ppy * ca + qqy * sa) * so;
          let bz = uz * co + (ppz * ca + qqz * sa) * so;
          const bl = Math.hypot(bx, by, bz);
          bx /= bl; by /= bl; bz /= bl;
          const clen = len * (depth === 0 ? 0.40 + rnd() * 0.22 : 0.46 + rnd() * 0.24);
          grow(cx, cy, cz, bx, by, bz, clen, rb * 0.62, rb * 0.26, depth + 1);
        }
      }

      // bend for the next segment
      uy -= droop / segs;
      ux += (rnd() - 0.5) * wander;
      uz += (rnd() - 0.5) * wander;
      const L = Math.hypot(ux, uy, uz);
      ux /= L; uy /= L; uz /= L;
    }

    if (depth >= 1) {
      // leaf clusters gather at and just behind the twig tips
      // Tight clusters. Loose ones drift off the twigs and the canopy stops
      // reading as something the branches are holding up.
      spots.push({ x: cx, y: cy, z: cz, r: canopyR * (depth === 2 ? 0.24 : 0.30) });
      if (depth === 2) {
        spots.push({
          x: (cx + x) * 0.5, y: (cy + y) * 0.5, z: (cz + z) * 0.5,
          r: canopyR * 0.20,
        });
      }
    }
  }

  grow(0, 0, 0, (rnd() - 0.5) * 0.10, 1, (rnd() - 0.5) * 0.10,
    H, trunkR, trunkR * 0.30, 0);

  const trunk = new THREE.Mesh(toGeometry(bark, false), barkMaterial());
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  g.add(trunk);

  // ---- canopy ------------------------------------------------------------
  if (spots.length) {
    const leaf = emptyMesh();
    let cyAvg = 0;
    for (const s of spots) cyAvg += s.y;
    cyAvg /= spots.length;

    for (let i = 0; i < FOLIAGE; i++) {
      const sp = spots[(rnd() * spots.length) | 0];
      // a point inside the cluster sphere
      const th = rnd() * 6.2832, ph = Math.acos(2 * rnd() - 1);
      const rr = sp.r * Math.cbrt(rnd());
      const cx = sp.x + Math.sin(ph) * Math.cos(th) * rr;
      const cy = sp.y + Math.cos(ph) * rr * 0.85;
      const cz = sp.z + Math.sin(ph) * Math.sin(th) * rr;

      // outward from the canopy core, mixed with a random tilt
      let ox = cx, oy = cy - cyAvg, oz = cz;
      const ol = Math.hypot(ox, oy, oz) || 1;
      ox /= ol; oy /= ol; oz /= ol;
      const rx = rnd() * 2 - 1, ry = rnd() * 2 - 1, rz = rnd() * 2 - 1;
      const rl = Math.hypot(rx, ry, rz) || 1;
      let nx = ox * 0.55 + (rx / rl) * 0.45;
      let ny = oy * 0.55 + (ry / rl) * 0.45;
      let nz = oz * 0.55 + (rz / rl) * 0.45;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;

      // card plane basis, with a random roll so the atlas tile is never level
      let tx = -nz, ty = 0, tz = nx;
      if (Math.hypot(tx, tz) < 1e-4) { tx = 1; tz = 0; }
      const tl = Math.hypot(tx, ty, tz);
      tx /= tl; ty /= tl; tz /= tl;
      const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
      const roll = rnd() * 6.2832, cr = Math.cos(roll), sr = Math.sin(roll);
      const ax = tx * cr + bx * sr, ay = ty * cr + by * sr, az = tz * cr + bz * sr;
      const ex = -tx * sr + bx * cr, ey = -ty * sr + by * cr, ez = -tz * sr + bz * cr;

      // A card is one spray of leaves, not half the crown: at 0.4x canopy the
      // individual leaves came out hand-sized and the tree read as a cartoon.
      const size = canopyR * (0.24 + rnd() * 0.20);
      const hw = size * 0.5, hh = size * (0.42 + rnd() * 0.16);

      // vertex normal is mostly world-up, tilted outward: the same trick the
      // grass uses, so cards light as a soft mass instead of flashing facets
      let vnx = ox * 0.5, vny = 1.0, vnz = oz * 0.5;
      const vnl = Math.hypot(vnx, vny, vnz);
      vnx /= vnl; vny /= vnl; vnz /= vnl;

      // deeper inside the canopy = shadier
      const depth01 = 1 - Math.min(1, (Math.hypot(cx, cz) / canopyR) * 0.6 +
        Math.max(0, cy - cyAvg) / (canopyR * 1.6));
      const shade = 0.74 + 0.42 * (1 - depth01);
      const cr0 = shade * (0.86 + rnd() * 0.26);
      const cg0 = shade * (0.92 + rnd() * 0.20);
      const cb0 = shade * (0.76 + rnd() * 0.24);

      const tile = (rnd() * 4) | 0;
      const u0 = (tile % 2) * 0.5 + 0.004, v0 = ((tile / 2) | 0) * 0.5 + 0.004;
      const u1 = u0 + 0.492, v1 = v0 + 0.492;

      const sway = Math.min(1, Math.max(0, (cy - H * 0.32) / (H * 0.75)));
      const base = leaf.pos.length / 3;
      const corners = [[-1, -1, u0, v0], [1, -1, u1, v0], [1, 1, u1, v1], [-1, 1, u0, v1]];
      for (const [sx, sy, uu, vv] of corners) {
        leaf.pos.push(
          cx + ax * hw * sx + ex * hh * sy,
          cy + ay * hw * sx + ey * hh * sy,
          cz + az * hw * sx + ez * hh * sy
        );
        leaf.nrm.push(vnx, vny, vnz);
        leaf.uv.push(uu, vv);
        leaf.col.push(cr0, cg0, cb0);
        leaf.sway.push(sway);
      }
      leaf.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    const canopy = new THREE.Mesh(toGeometry(leaf, true), leafMaterial());
    canopy.castShadow = true;
    canopy.receiveShadow = true;
    g.add(canopy);
  }
  return g;
}

function buildTrampoline(r, rnd) {
  const g = new THREE.Group();
  const H = 0.68;
  const navy = mat('navy', () => lam(0x1c2f6e));
  const ring = new THREE.Mesh(geo('tramp-ring', () => new THREE.TorusGeometry(1, 0.055, 8, 42)), navy);
  ring.scale.setScalar(r);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = H;
  ring.castShadow = true;
  g.add(ring);

  // padded rim
  const pad = new THREE.Mesh(geo('tramp-pad', () => new THREE.TorusGeometry(1, 0.10, 8, 42)),
    mat('padblue', () => lam(0x2a49a8)));
  pad.scale.setScalar(r * 0.94);
  pad.rotation.x = Math.PI / 2;
  pad.position.y = H - 0.02;
  g.add(pad);

  const bed = new THREE.Mesh(
    geo('disc', () => new THREE.CircleGeometry(1, 34).rotateX(-Math.PI / 2)),
    mat('tramp-bed', () => lam(0x121727, { side: THREE.DoubleSide }))
  );
  bed.scale.setScalar(r * 0.84);
  bed.position.y = H - 0.03;
  bed.receiveShadow = true;
  g.add(bed);

  // safety-net hint: 6 poles + a translucent cylinder
  const poleMat = mat('navy2', () => lam(0x35509c));
  const poleGeo = geo('tramp-pole', () => new THREE.CylinderGeometry(0.032, 0.032, 1, 6));
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    const p = new THREE.Mesh(poleGeo, poleMat);
    p.scale.y = 1.55;
    p.position.set(Math.cos(a) * r * 0.93, H + 0.77, Math.sin(a) * r * 0.93);
    p.castShadow = true;
    g.add(p);
  }
  const net = new THREE.Mesh(
    geo('tramp-net', () => new THREE.CylinderGeometry(1, 1, 1, 24, 1, true)),
    mat('netmat', () => new THREE.MeshLambertMaterial({
      color: 0xaebcd4, transparent: true, opacity: 0.16,
      side: THREE.DoubleSide, depthWrite: false,
    }))
  );
  net.scale.set(r * 0.93, 1.5, r * 0.93);
  net.position.y = H + 0.75;
  g.add(net);

  const legGeo = geo('leg', () => new THREE.CylinderGeometry(0.04, 0.04, 1, 6));
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + i * Math.PI / 2;
    const l = new THREE.Mesh(legGeo, poleMat);
    l.scale.y = H;
    l.position.set(Math.cos(a) * r * 0.80, H / 2, Math.sin(a) * r * 0.80);
    l.castShadow = true;
    g.add(l);
  }
  return g;
}

function buildToy(r, rnd) {
  const g = new THREE.Group();
  const b = new THREE.Mesh(
    geo('ball', () => new THREE.SphereGeometry(1, 22, 16)),
    mat('toy', () => lam(0xe33232))
  );
  b.scale.setScalar(r);
  b.position.y = r * 0.97;
  b.castShadow = true;
  g.add(b);
  // white panel patches so it reads as a football
  const patch = geo('patch', () => new THREE.CircleGeometry(0.42, 6));
  const pm = mat('patchmat', () => lam(0xf2f2f2, { side: THREE.DoubleSide }));
  for (let i = 0; i < 5; i++) {
    const p = new THREE.Mesh(patch, pm);
    const a = rnd() * 6.28, e = (rnd() - 0.4) * 2.2;
    const dir = new THREE.Vector3(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e));
    p.position.copy(dir).multiplyScalar(r * 1.005).add(new THREE.Vector3(0, r * 0.97, 0));
    p.lookAt(p.position.clone().add(dir));
    p.scale.setScalar(r);
    g.add(p);
  }
  return g;
}

function buildFlowerbed(r, rnd) {
  const g = new THREE.Group();
  const soil = new THREE.Mesh(
    geo('soil', () => new THREE.CylinderGeometry(1, 0.96, 1, 26)),
    mat('soil', () => lam(0x3d2b1c))
  );
  soil.scale.set(r, 0.16, r);
  soil.position.y = 0.08;
  soil.receiveShadow = true; soil.castShadow = true;
  g.add(soil);

  // stone edging
  const edge = new THREE.Mesh(geo('bedring', () => new THREE.TorusGeometry(1, 0.055, 6, 28)),
    mat('stone', () => lam(0x9a9488, { flatShading: true })));
  edge.scale.setScalar(r);
  edge.rotation.x = Math.PI / 2;
  edge.position.y = 0.1;
  g.add(edge);

  // instanced flowers: a stem quad plus a coloured head
  const petals = [0xff5fa2, 0xffd23f, 0xa06cff, 0xff7a45, 0xf4f4f4, 0xff3b6b];
  const count = Math.max(10, Math.round(r * r * 26));
  const heads = new THREE.InstancedMesh(
    geo('flowerhead', () => new THREE.CircleGeometry(0.5, 6)),
    mat('flowermat', () => new THREE.MeshLambertMaterial({ side: THREE.DoubleSide })),
    count
  );
  const stems = new THREE.InstancedMesh(
    geo('stem', () => new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0)),
    mat('stemmat', () => new THREE.MeshLambertMaterial({ color: 0x3f7a3d, side: THREE.DoubleSide })),
    count
  );
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const a = rnd() * 6.28, d = Math.sqrt(rnd()) * r * 0.82;
    const hgt = 0.16 + rnd() * 0.18;
    pos.set(Math.cos(a) * d, 0.15, Math.sin(a) * d);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.28);
    scl.set(0.02, hgt, 1);
    m4.compose(pos, q, scl);
    stems.setMatrixAt(i, m4);
    pos.y = 0.15 + hgt;
    scl.set(0.09 + rnd() * 0.05, 0.09 + rnd() * 0.05, 1);
    m4.compose(pos, q, scl);
    heads.setMatrixAt(i, m4);
    heads.setColorAt(i, col.setHex(petals[(rnd() * petals.length) | 0]));
  }
  heads.instanceMatrix.needsUpdate = true;
  stems.instanceMatrix.needsUpdate = true;
  if (heads.instanceColor) heads.instanceColor.needsUpdate = true;
  g.add(stems, heads);
  return g;
}

function buildHedgehog(r, rnd) {
  const g = new THREE.Group();
  const s = Math.max(0.13, r);
  const body = new THREE.Mesh(
    jitter(new THREE.IcosahedronGeometry(1, 1), 0.22, rnd),
    mat('hh', () => lam(0x6b4a30, { flatShading: true }))
  );
  body.scale.set(s, s * 0.74, s * 0.88);
  body.position.y = s * 0.66;
  body.castShadow = true;
  g.add(body);

  const snout = new THREE.Mesh(
    geo('hh-snout', () => new THREE.ConeGeometry(0.5, 1, 9).rotateZ(-Math.PI / 2)),
    mat('hh-dark', () => lam(0x3d2a1b))
  );
  snout.scale.set(s * 0.75, s * 0.55, s * 0.55);
  snout.position.set(s * 0.88, s * 0.58, 0);
  g.add(snout);
  const nose = new THREE.Mesh(geo('hh-nose', () => new THREE.SphereGeometry(1, 7, 6)),
    mat('black', () => lam(0x14100c)));
  nose.scale.setScalar(s * 0.10);
  nose.position.set(s * 1.22, s * 0.58, 0);
  g.add(nose);

  const spike = geo('spike', () => new THREE.ConeGeometry(0.085, 0.36, 5));
  const spikeMat = mat('spike', () => lam(0x3a2a1c, { flatShading: true }));
  for (let i = 0; i < 22; i++) {
    const a = rnd() * Math.PI * 2, e = 0.15 + rnd() * 1.05;
    const sp = new THREE.Mesh(spike, spikeMat);
    sp.scale.setScalar(s * (1.8 + rnd() * 0.8));
    sp.position.set(
      Math.cos(a) * s * 0.72 * Math.cos(e),
      s * 0.66 + Math.sin(e) * s * 0.68,
      Math.sin(a) * s * 0.78 * Math.cos(e)
    );
    sp.rotation.set(Math.sin(a) * 0.95, 0, -Math.cos(a) * 0.95);
    g.add(sp);
  }
  return g;
}

/** Same generator the garden trees use — scene.mjs plants the neighbourhood. */
export const makeTree = buildTree;

const BUILDERS = {
  rock: buildRock, tree: buildTree, trampoline: buildTrampoline,
  toy: buildToy, flowerbed: buildFlowerbed, hedgehog: buildHedgehog,
};
// how wide the grounding blob should be, relative to the prop radius
const DECAL_SCALE = {
  rock: 1.25, tree: 1.5, trampoline: 1.15, toy: 1.5, flowerbed: 1.12, hedgehog: 1.8,
};

// A wandering obstacle is re-published at up to 2 Hz; easing over 0.5 s means
// the mesh is still catching up when the next position lands, which is what
// turns a sequence of teleports into a walk.
const MOVE_EASE = 0.5;
const WADDLE_HZ = 3.1;          // body rolls per second while walking
const WADDLE_ROLL = 0.13;       // radians
const WADDLE_BOB = 0.018;       // metres
const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

/** Shortest signed angular distance a → b. */
function angDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class ObstacleLayer {
  constructor(parent) {
    this.parent = parent;
    this.root = new THREE.Group();
    this.root.name = 'obstacles';
    parent.add(this.root);
    this.byId = new Map();
    this.selected = null;

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.88, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0xff6600, transparent: true, opacity: 0.9,
        side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
      })
    );
    this.ring.visible = false;
    this.ring.renderOrder = 4;
    parent.add(this.ring);
    this.t = 0;
  }

  /**
   * Reconcile against world.obstacles ([]model.Obstacle).
   *
   * Obstacles MOVE — the sim wanders the hedgehogs, and a `world` frame can
   * land at 2 Hz with new positions. Tearing the prop down and rebuilding it
   * would restart its grow-pop and re-roll its jittered geometry twice a
   * second, so an id that is already on stage is never rebuilt: the new
   * position becomes the target of a short ease (see update()). Only add,
   * remove, or a change of type touches the scene graph.
   */
  sync(list) {
    const seen = new Set();
    for (const o of list || []) {
      seen.add(o.id);
      const have = this.byId.get(o.id);
      if (have && have.data.type === o.type) {
        const dx = o.pos.x - have.tgt.x, dy = o.pos.y - have.tgt.y;
        if (dx * dx + dy * dy > 1e-6) {
          have.from = { x: have.cur.x, y: have.cur.y };
          have.tgt = { x: o.pos.x, y: o.pos.y };
          have.mt = 0;
          have.dur = MOVE_EASE;
          have.heading = Math.atan2(dy, dx);       // model-space bearing
        }
        have.data = o;
        continue;
      }
      if (have) {                                   // type changed — rebuild
        this.root.remove(have.obj);
        this.root.remove(have.decal);
        this.byId.delete(o.id);
      }
      const r = o.radius > 0 ? o.radius : 0.3;
      const make = BUILDERS[o.type] || buildRock;
      const obj = make(r, rng(seedOf(o.id + o.type)));
      obj.position.set(o.pos.x, heightAt(o.pos.x, o.pos.y), -o.pos.y);   // model → three
      // YXZ so the waddle rolls around the body's own forward axis rather than
      // around world X — yaw first, roll inside it
      obj.rotation.order = 'YXZ';
      obj.rotation.y = (seedOf(o.id) % 628) / 100;
      obj.traverse((c) => { c.userData.obstacleId = o.id; });
      obj.scale.setScalar(0.01);
      obj.userData.grow = 0;
      this.root.add(obj);

      const decal = contactDecal(o.pos.x, o.pos.y, r * (DECAL_SCALE[o.type] || 1.3), 0.055, 0.62);
      this.root.add(decal);
      this.byId.set(o.id, {
        obj, decal, data: o,
        cur: { x: o.pos.x, y: o.pos.y },      // where the mesh actually is
        tgt: { x: o.pos.x, y: o.pos.y },      // where the server says it is
        from: { x: o.pos.x, y: o.pos.y },
        mt: 1, dur: MOVE_EASE,                // mt >= dur ⇒ settled
        heading: obj.rotation.y,
        yaw: obj.rotation.y,
        baseY: obj.position.y,
        wob: 0,
      });
    }
    for (const [id, rec] of this.byId) {
      if (seen.has(id)) continue;
      this.root.remove(rec.obj);
      this.root.remove(rec.decal);
      this.byId.delete(id);
      if (this.selected === id) this.select(null);
    }
  }

  get(id) { return this.byId.get(id); }

  select(id) {
    this.selected = id || null;
    const rec = id ? this.byId.get(id) : null;
    if (!rec) { this.ring.visible = false; return null; }
    const r = Math.max(0.35, rec.data.radius || 0.35) * 1.35;
    this.ring.scale.setScalar(r);
    // rec.cur, not rec.data.pos — the mesh may still be easing toward it
    this.ring.position.set(rec.cur.x, heightAt(rec.cur.x, rec.cur.y) + 0.12, -rec.cur.y);
    this.ring.visible = true;
    return rec.data;
  }

  pick(raycaster) {
    const hits = raycaster.intersectObject(this.root, true);
    for (const h of hits) {
      const id = h.object.userData.obstacleId;
      if (id) return id;
    }
    return null;
  }

  posOf(id, out) {
    const rec = this.byId.get(id);
    if (!rec) return null;
    const r = rec.data.radius || 0.3;
    const { x, y } = rec.cur;                 // follow the mesh, not the target
    return out.set(x, heightAt(x, y) + r * 1.5 + 0.3, -y);
  }

  update(dt) {
    this.t += dt;
    if (this.ring.visible) {
      this.ring.material.opacity = 0.72 + 0.28 * Math.sin(this.t * 4);
      this.ring.rotation.y += dt * 0.9;
    }
    for (const rec of this.byId.values()) {
      const o = rec.obj;
      if (o.userData.grow < 1) {
        o.userData.grow = Math.min(1, (o.userData.grow || 0) + dt * 4.5);
        const t = o.userData.grow;
        const s = t < 1 ? 1 + Math.sin(t * Math.PI) * 0.16 - (1 - t) : 1;
        o.scale.setScalar(Math.max(0.01, s));
      }
      this.step(rec, dt);
    }
    if (this.selected) {
      const rec = this.byId.get(this.selected);
      if (rec) {
        this.ring.position.set(rec.cur.x,
          heightAt(rec.cur.x, rec.cur.y) + 0.12, -rec.cur.y);
      }
    }
  }

  /**
   * Ease one obstacle toward its published position. Costs nothing for the
   * stationary majority: a settled record with no waddle left to unwind
   * returns on the first line.
   */
  step(rec, dt) {
    const moving = rec.mt < rec.dur;
    if (!moving && rec.wob <= 0.0001) return;

    if (moving) {
      rec.mt = Math.min(rec.dur, rec.mt + dt);
      const e = easeInOut(rec.mt / rec.dur);
      rec.cur.x = rec.from.x + (rec.tgt.x - rec.from.x) * e;
      rec.cur.y = rec.from.y + (rec.tgt.y - rec.from.y) * e;
      // turn into the direction of travel rather than snapping to it
      rec.yaw += angDelta(rec.yaw, rec.heading) * Math.min(1, dt * 7);
      rec.wob = Math.min(1, rec.wob + dt * 4);
    } else {
      rec.cur.x = rec.tgt.x; rec.cur.y = rec.tgt.y;
      rec.wob = Math.max(0, rec.wob - dt * 3);          // let the waddle die out
    }

    const o = rec.obj;
    const gy = heightAt(rec.cur.x, rec.cur.y);          // the ground is not flat
    // Only the hedgehog waddles; a drifting rock would just look broken.
    const w = rec.data.type === 'hedgehog' ? rec.wob : 0;
    const phase = this.t * WADDLE_HZ * Math.PI * 2;
    o.position.set(rec.cur.x, gy + Math.abs(Math.sin(phase)) * WADDLE_BOB * w, -rec.cur.y);
    o.rotation.y = rec.yaw;
    o.rotation.x = Math.sin(phase) * WADDLE_ROLL * w;

    const d = rec.decal;
    d.position.set(rec.cur.x, gy + 0.055, -rec.cur.y);
  }
}
