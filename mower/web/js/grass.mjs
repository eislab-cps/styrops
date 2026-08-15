// grass.mjs — the lawn, as shell-textured fur.
//
// COORDINATE CONVENTION (identical in every module of this app):
//   model / API space : metres, origin bottom-left, +x east, +y north
//   three.js space    : X = model.x,  Y = up (height),  Z = -model.y
//   inverse           : model.x = three.x,  model.y = -three.z
//
// The grid is model.GrassGrid: row-major, index = iy*cols + ix, heights in mm,
// -1 meaning "not lawn" (house / path / outside).
//
// ── how the fibers work ─────────────────────────────────────────────────────
//
// The lawn is drawn twice.
//
// LAYER 0 — the base turf. An INDEXED (cols+1)x(rows+1) height field carrying
//   the photographic grass albedo. Four cells share each node, so colour and
//   height are averaged there and the GPU interpolates across the quad: the
//   cell grid dissolves instead of reading as a checkerboard. Non-lawn cells
//   are left out of the index buffer. This is what you see through the gaps
//   between blades, so it is tinted down toward thatch.
//
// LAYER 1 — the shells. The SAME surface, re-rendered N times, each shell
//   offset a little further up. A fragment on shell k survives only if the
//   blade at that texel is tall enough to still be there:
//
//       k/N  <  fiberHeight(worldUV) * grassLength(lawnUV)
//
//   fiberHeight comes from a 1024² map where one texel ≈ one blade (see
//   assets.fiberTexture), and grassLength from a DataTexture rebuilt out of the
//   grass grid whenever WS diffs land. So the geometry never changes when the
//   robot mows — the height texture does, and the fibers get shorter.
//
//   Everything is `discard` + depth-write, no blending: no sorting, no
//   transparency artefacts, and the shells shadow-receive like solid geometry.
//   All N shells are ONE instanced draw call.
//
// Cut grass is short and dense (only the lowest shells survive), long grass is
// shaggy (blades reach the top shells), and the root-to-tip gradient plus the
// travelling gust field is what sells it as fur rather than stacked decals.

import * as THREE from 'three';
import { heightAt, WIND, GUST_GLSL } from './terrain.mjs';
import { PHOTO, fiberTexture } from './assets.mjs';

const CUT_MM = 16;             // short end of the colour ramp
const TALL_MM = 88;            // shaggy end — also the fiber-length reference
// The base turf must stay strictly BELOW every shell. It used to be displaced
// upward by the grass height, which pushed it through the bottom third of the
// fiber stack: those shells were buried, the grey base showed between the
// survivors, and the lawn read as wet slate. The fibers carry the height now,
// so the base only needs enough relief to stop it looking like glass.
const BASE_DROP = 0.022;       // metres the base sits under the shell origin
const STRIPE_M = 1.45;         // mow band width in metres
const STRIPE_AMT = 0.26;       // mow band contrast — a striped lawn is the look
const FIBER_M = 0.165;         // physical height of a full-length blade
const FIBER_TILE = 1.10;       // metres per repeat of the fiber map
const ALBEDO_TILE = 3.40;      // metres per repeat of the grass photo

// ── deterministic noise (no allocation in any hot path) ─────────────────────
function hash2(x, y) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function fbm(x, y) {
  let s = 0, amp = 0.5, f = 1;
  for (let o = 0; o < 4; o++) { s += vnoise(x * f, y * f) * amp; amp *= 0.5; f *= 2.07; }
  return s * 1.0667 - 0.5333;    // ≈ [-0.5, 0.5]
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ── analytical height colormap (the "Heat" view) ────────────────────────────
// Short = vivid green, mid = amber, tall = red, over HEAT_LO..HEAT_HI mm — the
// same range the legend chip is labelled with. Shared verbatim by the base turf
// and the shells so a fragment reads the same colour whichever layer wins.
const HEAT_LO = 20, HEAT_HI = 90;
const HEAT_GLSL = /* glsl */`
  uniform float uHeat;                    // 0 = normal look, 1 = heightmap
  vec3 gHeatCol = vec3( 0.0 );            // set in <color_fragment>, read below
  vec3 heatRamp( float mm ) {
    float t = clamp( ( mm - ${HEAT_LO.toFixed(1)} ) /
                     ${(HEAT_HI - HEAT_LO).toFixed(1)}, 0.0, 1.0 );
    vec3 lo  = vec3( 0.10, 0.86, 0.33 );  // freshly cut
    vec3 mid = vec3( 1.00, 0.74, 0.10 );  // getting long
    vec3 hi  = vec3( 0.95, 0.15, 0.10 );  // overgrown
    return t < 0.5 ? mix( lo, mid, t * 2.0 ) : mix( mid, hi, ( t - 0.5 ) * 2.0 );
  }
`;

export class GrassField {
  /** tier: { shells, fiberSize, shellCell } — see scene.detectTier(). */
  constructor(parent, grid, tier = {}) {
    this.parent = parent;
    this.shells = tier.shells || 36;
    this.fiberSize = tier.fiberSize || 1024;
    this.shellCell = tier.shellCell || 0.8;
    this.mesh = null;
    this.shellMesh = null;
    this.texAge = 0;
    this.texDirty = false;
    // One flag, shared by both lawn materials — see setHeat().
    this.heatUni = { value: 0 };

    // Base-turf tint. These MULTIPLY the grass photo, so they sit around 1.0 —
    // fresh cut turf is a touch brighter and cooler, meadow-length grass drier
    // and more yellow.
    this.cCut = [1.08, 1.14, 0.92];
    this.cMid = [1.00, 1.00, 0.86];
    this.cTall = [0.88, 0.90, 0.62];

    this.build(grid);
  }

  build(grid) {
    this.dispose();

    const cols = this.cols = grid.cols | 0;
    const rows = this.rows = grid.rows | 0;
    const cell = this.cell = grid.cell || 0.25;
    const nCells = cols * rows;
    const nw = this.nw = cols + 1, nh = this.nh = rows + 1;
    const nNodes = nw * nh;
    this.spanX = cols * cell;
    this.spanY = rows * cell;

    this.h = new Float32Array(nCells).fill(-1);
    this.stamp = new Uint32Array(nNodes);
    this.gen = 0;
    this.nLo = -1; this.nHi = -1;

    // ---- the grass-length / shading texture the shells sample ---------------
    // R = blade length as a fraction of TALL_MM (0 = not lawn)
    // G = patch fbm + mow stripe, remapped to 0..1
    // B/A = spare
    this.texData = new Uint8Array(nCells * 4);
    this.heightTex = new THREE.DataTexture(this.texData, cols, rows, THREE.RGBAFormat);
    this.heightTex.magFilter = THREE.LinearFilter;
    this.heightTex.minFilter = THREE.LinearFilter;
    this.heightTex.generateMipmaps = false;
    this.heightTex.wrapS = this.heightTex.wrapT = THREE.ClampToEdgeWrapping;
    this.heightTex.needsUpdate = true;

    // ---- base turf ---------------------------------------------------------
    const pos = new Float32Array(nNodes * 3);
    const col = new Float32Array(nNodes * 3);
    const nrm = new Float32Array(nNodes * 3);
    const uv = new Float32Array(nNodes * 2);
    // Node-averaged blade length in mm (-1 = no lawn around this node). The
    // base turf has no lawn-space UV — its UVs tile the grass photo — so the
    // heat view reads the length off a vertex attribute rather than the
    // height texture the shells sample.
    const len = new Float32Array(nNodes).fill(-1);
    const noise = this.noise = new Float32Array(nNodes);

    for (let ny = 0; ny < nh; ny++) {
      for (let nx = 0; nx < nw; nx++) {
        const n = ny * nw + nx;
        const wx = nx * cell, wy = ny * cell;
        pos[n * 3] = wx;
        pos[n * 3 + 2] = -wy;                       // model y → three -z
        uv[n * 2] = wx / ALBEDO_TILE;
        uv[n * 2 + 1] = wy / ALBEDO_TILE;
        // two scales: broad patchiness + fine mottling
        noise[n] = fbm(wx * 0.25, wy * 0.25) * 0.58 + fbm(wx * 1.35, wy * 1.35) * 0.42;
      }
    }
    // normals perturbed by the noise gradient → soft undulating shading
    for (let ny = 0; ny < nh; ny++) {
      for (let nx = 0; nx < nw; nx++) {
        const n = ny * nw + nx;
        const l = noise[ny * nw + Math.max(0, nx - 1)];
        const r = noise[ny * nw + Math.min(nw - 1, nx + 1)];
        const d = noise[Math.max(0, ny - 1) * nw + nx];
        const u = noise[Math.min(nh - 1, ny + 1) * nw + nx];
        const gx = (r - l) * 0.9, gz = (u - d) * 0.9;
        const inv = 1 / Math.hypot(gx, 1, gz);
        nrm[n * 3] = -gx * inv; nrm[n * 3 + 1] = inv; nrm[n * 3 + 2] = gz * inv;
      }
    }

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
    this.lenAttr = new THREE.BufferAttribute(len, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setAttribute('aLen', this.lenAttr);
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(this.spanX / 2, 0, -this.spanY / 2),
      Math.hypot(this.spanX, this.spanY) * 0.6 + 2
    );
    this.geo = geo;

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, dithering: true, roughness: 0.92, metalness: 0.0,
      // The shells above are Lambert and get no environment probe. Letting the
      // base take a full one made the gaps between blades a different, bluer
      // material than the blades themselves — which is precisely what turned
      // the lawn grey-teal. Keep it to a hint.
      envMapIntensity: 0.25,
    });
    if (PHOTO.grassColor) mat.map = PHOTO.grassColor;
    if (PHOTO.grassNormal) {
      mat.normalMap = PHOTO.grassNormal;
      mat.normalScale = new THREE.Vector2(0.55, 0.55);
    }
    if (PHOTO.grassRough) mat.roughnessMap = PHOTO.grassRough;

    // Heat view: swap the photographic albedo for the colormap, keeping just
    // enough of the original luminance that the turf still reads as a lit
    // surface instead of a flat sticker.
    const heatUni = this.heatUni;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uHeat = heatUni;
      shader.vertexShader = 'attribute float aLen;\nvarying float vLen;\n' +
        shader.vertexShader.replace('#include <begin_vertex>',
          '#include <begin_vertex>\n  vLen = aLen;');
      shader.fragmentShader = 'varying float vLen;\n' + HEAT_GLSL +
        shader.fragmentShader.replace('#include <color_fragment>', /* glsl */`
          #include <color_fragment>
          if ( uHeat > 0.001 && vLen >= 0.0 ) {
            float lum = clamp( dot( diffuseColor.rgb, vec3( 0.32, 0.52, 0.16 ) ) * 2.6, 0.42, 1.15 );
            gHeatCol = heatRamp( vLen ) * lum;
            diffuseColor.rgb = mix( diffuseColor.rgb, gHeatCol * 0.34, uHeat );
          }
        `).replace('#include <emissivemap_fragment>', /* glsl */`
          #include <emissivemap_fragment>
          totalEmissiveRadiance += gHeatCol * 0.62 * uHeat;
        `);
    };
    mat.customProgramCacheKey = () => 'turfheat';

    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = 'turf';
    this.mesh = mesh;
    this.parent.add(mesh);

    this.buildShells();
    this.applyFull(grid, true);
  }

  // ── shells ────────────────────────────────────────────────────────────────
  /**
   * One coarse copy of the lawn surface, drawn `shells` times. The mesh only
   * has to carry the SHAPE of the ground — every millimetre of grass detail is
   * decided per fragment from the height texture — so it can be far coarser
   * than the grass grid without losing mowing resolution.
   */
  buildShells() {
    const N = this.shells;
    const nx = Math.max(2, Math.ceil(this.spanX / this.shellCell));
    const ny = Math.max(2, Math.ceil(this.spanY / this.shellCell));
    const vw = nx + 1, vh = ny + 1;

    const pos = new Float32Array(vw * vh * 3);
    const uv = new Float32Array(vw * vh * 2);
    const nrm = new Float32Array(vw * vh * 3);
    for (let j = 0; j < vh; j++) {
      for (let i = 0; i < vw; i++) {
        const k = j * vw + i;
        const wx = (i / nx) * this.spanX;
        const wy = (j / ny) * this.spanY;
        pos[k * 3] = wx;
        pos[k * 3 + 1] = heightAt(wx, wy);
        pos[k * 3 + 2] = -wy;
        nrm[k * 3 + 1] = 1;
        uv[k * 2] = (i / nx);
        uv[k * 2 + 1] = (j / ny);
      }
    }
    const idx = new Uint32Array(nx * ny * 6);
    let o = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * vw + i, b = a + 1, c = a + vw, d = c + 1;
        idx[o++] = a; idx[o++] = b; idx[o++] = d;
        idx[o++] = a; idx[o++] = d; idx[o++] = c;
      }
    }

    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const shellIdx = new Float32Array(N);
    for (let k = 0; k < N; k++) shellIdx[k] = (k + 1) / N;
    g.setAttribute('aShell', new THREE.InstancedBufferAttribute(shellIdx, 1));
    g.instanceCount = N;
    g.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(this.spanX / 2, 0, -this.spanY / 2),
      Math.hypot(this.spanX, this.spanY) * 0.6 + 2
    );
    this.shellGeo = g;
    this.shellTris = nx * ny * 2 * N;

    const uni = this.shellUniforms = {
      uTime: WIND.uTime,
      uWind: WIND.uWind,
      uHeight: { value: this.heightTex },
      uFiber: { value: fiberTexture(this.fiberSize) },
      uAlbedo: { value: PHOTO.grassColor || null },
      uHasAlbedo: { value: PHOTO.grassColor ? 1 : 0 },
      uFiberScale: { value: 1 / FIBER_TILE },
      uAlbedoScale: { value: 1 / ALBEDO_TILE },
      uFiberH: { value: FIBER_M },
      // The whole property is within ~65 m of the hero camera, so the fade has
      // to start beyond it: fading at 22 m turned the lawn into a flat sheet in
      // exactly the shot that has to sell the fibers.
      uFadeNear: { value: 48 },
      uFadeFar: { value: 130 },
      uHeat: this.heatUni,
      uTallMM: { value: TALL_MM },
    };

    const mat = new THREE.MeshLambertMaterial({ dithering: true });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uni);

      shader.vertexShader = /* glsl */`
        attribute float aShell;
        uniform float uFiberH;
        uniform float uFadeNear;
        uniform float uFadeFar;
        varying float vShell;
        varying vec2 vLawnUV;
        varying vec2 vWXZ;
        varying vec2 vLean;
        varying float vFade;
        ${GUST_GLSL}
      ` + shader.vertexShader.replace('#include <begin_vertex>', /* glsl */`
        vec3 transformed = vec3( position );
        vShell = aShell;
        vLawnUV = uv;
        vWXZ = vec2( position.x, -position.z );      // world xz → model x,y

        float d = -( modelViewMatrix * vec4( position, 1.0 ) ).z;
        vFade = smoothstep( uFadeNear, uFadeFar, d );

        // Blades bend, they do not shear: the offset grows with the SQUARE of
        // the shell index so the stack curves over instead of leaning like a
        // stack of plates.
        vec2 g = gustField( vWXZ, uTime );
        float bend = aShell * aShell;
        vLean = g * bend;
        transformed.y += aShell * uFiberH;
        transformed.x += g.x * uWind * bend * 0.75;
        transformed.z -= g.y * uWind * bend * 0.75;
      `);

      shader.fragmentShader = /* glsl */`
        uniform sampler2D uHeight;
        uniform sampler2D uFiber;
        uniform sampler2D uAlbedo;
        uniform float uHasAlbedo;
        uniform float uFiberScale;
        uniform float uAlbedoScale;
        uniform float uTallMM;
        varying float vShell;
        varying vec2 vLawnUV;
        varying vec2 vWXZ;
        varying vec2 vLean;
        varying float vFade;
        ${HEAT_GLSL}
      ` + shader.fragmentShader
        .replace('#include <clipping_planes_fragment>', /* glsl */`
          #include <clipping_planes_fragment>

          vec4 hs = texture2D( uHeight, vLawnUV );
          if ( hs.r < 0.02 ) discard;                 // house, path, off-lawn

          // Grass far from the camera is laid down rather than drawn at full
          // height: fewer surviving shells means far less alpha-test shimmer,
          // and a distant lawn genuinely does read as a flat sheet.
          float lenN = hs.r * mix( 1.0, 0.38, vFade );

          vec4 fb = texture2D( uFiber, vWXZ * uFiberScale );
          float reach = fb.r * lenN;
          if ( vShell > reach ) discard;              // this blade ended lower
          float along = clamp( vShell / max( reach, 1e-4 ), 0.0, 1.0 );
        `)
        .replace('#include <color_fragment>', /* glsl */`
          vec3 alb = mix( vec3( 0.34, 0.46, 0.20 ),
                          texture2D( uAlbedo, vWXZ * uAlbedoScale ).rgb, uHasAlbedo );
          float shade = 0.5 + hs.g;                   // patch fbm + mow stripes
          float jit = 0.88 + 0.24 * fb.g;
          // Deep in the sward it is dark; the tips catch the sun and dry out.
          // The tip gain has to stay near 1: push it to 1.3 and the highlights
          // clip, and a lawn of clipped tips reads as grey speckle, not grass.
          vec3 root = alb * 0.46;
          vec3 tip = alb * 1.10 + vec3( 0.030, 0.042, 0.004 );
          vec3 natural = mix( root, tip, pow( along, 0.72 ) ) * shade * jit;
          // hs.r is the blade length normalised over TALL_MM — the same number
          // writeHeightTex() encoded from the grass grid, so the heat view is
          // reading the live mown state, not a second copy of it.
          // A full-strength sun blows a lit ramp out to white — a "vivid green"
          // that reads as pale straw. Anchor it instead: most of the colour is
          // carried as emission (see <emissivemap_fragment> below), and only a
          // third of it is lit, which keeps the shading without the wash-out.
          gHeatCol = heatRamp( hs.r * uTallMM ) * ( 0.62 + 0.45 * pow( along, 0.7 ) );
          diffuseColor.rgb *= mix( natural, gHeatCol * 0.34, uHeat );
        `)
        .replace('#include <emissivemap_fragment>', /* glsl */`
          #include <emissivemap_fragment>
          totalEmissiveRadiance += gHeatCol * 0.62 * uHeat;
        `)
        .replace('#include <normal_fragment_begin>', /* glsl */`
          #include <normal_fragment_begin>
          // Blades are thin: shading them by their own facet normal flickers.
          // Light them off the blade AXIS instead — mostly up, tilted by the
          // gust, so a passing wave visibly changes which way the lawn shines.
          vec3 bladeN = normalize( vec3( vLean.x * 1.6, 2.4, -vLean.y * 1.6 ) );
          normal = normalize( ( viewMatrix * vec4( bladeN, 0.0 ) ).xyz );
          nonPerturbedNormal = normal;
        `);
    };
    mat.customProgramCacheKey = () => 'grassshell';

    const m = new THREE.Mesh(g, mat);
    m.castShadow = false;
    m.receiveShadow = true;
    m.frustumCulled = false;
    m.name = 'grass-shells';
    this.shellMesh = m;
    this.parent.add(m);
  }

  /**
   * Index buffer holds lawn cells plus a one-cell FRINGE of non-lawn cells
   * that touch lawn. Without the fringe the turf stops at the last in-lawn
   * cell center and a sliver of sky shows through between the turf edge and
   * the diorama rim / path polygons (it read as white "snow" lines). Fringe
   * faces blend from grass color to the dark thatch of no-lawn nodes and
   * seal the mesh against whatever borders it.
   */
  rebuildIndex() {
    const { cols, rows, nw, h } = this;
    const keep = (ci, ix, iy) => {
      if (h[ci] >= 0) return true;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = iy + dy;
        if (yy < 0 || yy >= rows) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = ix + dx;
          if (xx < 0 || xx >= cols) continue;
          if (h[yy * cols + xx] >= 0) return true;
        }
      }
      return false;
    };

    let kept = 0;
    for (let iy = 0; iy < rows; iy++)
      for (let ix = 0; ix < cols; ix++)
        if (keep(iy * cols + ix, ix, iy)) kept++;

    const idx = new Uint32Array(kept * 6);
    let o = 0;
    for (let iy = 0; iy < rows; iy++) {
      for (let ix = 0; ix < cols; ix++) {
        const ci = iy * cols + ix;
        if (!keep(ci, ix, iy)) continue;
        const n00 = iy * nw + ix, n10 = n00 + 1;
        const n01 = n00 + nw, n11 = n01 + 1;
        // winding chosen so the face normal is +Y (see the convention above)
        idx[o++] = n00; idx[o++] = n10; idx[o++] = n11;
        idx[o++] = n00; idx[o++] = n11; idx[o++] = n01;
      }
    }
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.index.needsUpdate = true;
    this.turfTris = kept * 2;
  }

  /** Full snapshot (initial load, reset, reconnect). */
  applyFull(grid, initial) {
    const h = grid.heights || [];
    const n = this.cols * this.rows;
    let maskChanged = !!initial;
    for (let i = 0; i < n; i++) {
      const v = h[i] === undefined ? -1 : h[i];
      if ((v < 0) !== (this.h[i] < 0)) maskChanged = true;
      this.h[i] = v;
    }
    if (maskChanged) this.rebuildIndex();

    for (let ny = 0; ny < this.nh; ny++) {
      for (let nx = 0; nx < this.nw; nx++) this.writeNode(nx, ny);
    }
    this.nLo = 0; this.nHi = this.nw * this.nh - 1;
    this.flush();
    this.writeHeightTex();
  }

  /** WS "grass" diff: cells = [[index, height_mm], ...] */
  applyDiff(cells) {
    if (!this.mesh || !cells || !cells.length) return;
    const n = this.cols * this.rows;
    const gen = ++this.gen;
    let maskChanged = false;

    for (let k = 0; k < cells.length; k++) {
      const c = cells[k];
      const i = c[0] | 0;
      if (i < 0 || i >= n) continue;
      const v = c[1];
      if ((v < 0) !== (this.h[i] < 0)) maskChanged = true;
      this.h[i] = v;
    }
    if (maskChanged) { this.rebuildIndex(); this.applyFull({ heights: this.h }); return; }

    for (let k = 0; k < cells.length; k++) {
      const i = cells[k][0] | 0;
      if (i < 0 || i >= n) continue;
      const ix = i % this.cols, iy = (i / this.cols) | 0;
      // one cell touches the four nodes at its corners; stamp de-dupes the
      // overlap between neighbouring cells in the same diff
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const nx = ix + dx, ny = iy + dy;
          const ni = ny * this.nw + nx;
          if (this.stamp[ni] === gen) continue;
          this.stamp[ni] = gen;
          this.writeNode(nx, ny);
        }
      }
    }
    this.flush();
    // The fibers follow the same data, but through a texture that is cheap
    // enough to rewrite whole — see update().
    this.texDirty = true;
  }

  /**
   * Rebuild the grass-length texture from the grid. 160x112 RGBA is 72 KB, so
   * a full rewrite costs less than tracking dirty rectangles would; update()
   * throttles it to 2 Hz, which is the rate the diffs arrive at anyway.
   */
  writeHeightTex() {
    const { cols, rows, cell, h, texData } = this;
    for (let iy = 0; iy < rows; iy++) {
      // mow stripes run along model rows; the band is only visible on short
      // grass, which is exactly how a striped lawn works
      const s = Math.tanh(Math.sin((iy * cell) * Math.PI / STRIPE_M) * 2.4);
      for (let ix = 0; ix < cols; ix++) {
        const i = iy * cols + ix;
        const o = i * 4;
        const hm = h[i];
        if (hm < 0) { texData[o] = 0; texData[o + 1] = 128; continue; }
        const t = clamp01((hm - CUT_MM) / (TALL_MM - CUT_MM));
        texData[o] = (clamp01(hm / TALL_MM) * 255) | 0;
        const nz = this.noise[Math.min(this.nh - 1, iy) * this.nw + Math.min(this.nw - 1, ix)];
        const mul = 1 + nz * 0.30 + s * (1 - t) * STRIPE_AMT;
        // encoded over [0.5, 1.5] so a strong stripe does not clip
        texData[o + 1] = (clamp01(mul - 0.5) * 255) | 0;
      }
    }
    this.heightTex.needsUpdate = true;
    this.texDirty = false;
    this.texAge = 0;
  }

  /** Node colour/height = average of the (up to 4) lawn cells around it. */
  writeNode(nx, ny) {
    const { cols, rows, nw, h } = this;
    let sum = 0, cnt = 0;
    for (let dy = 0; dy <= 1; dy++) {
      const iy = ny - 1 + dy;
      if (iy < 0 || iy >= rows) continue;
      for (let dx = 0; dx <= 1; dx++) {
        const ix = nx - 1 + dx;
        if (ix < 0 || ix >= cols) continue;
        const v = h[iy * cols + ix];
        if (v >= 0) { sum += v; cnt++; }
      }
    }
    const ni = ny * nw + nx;
    const p = this.posAttr.array, c = this.colAttr.array, o = ni * 3;
    const L = this.lenAttr.array;
    const gy = heightAt(nx * this.cell, ny * this.cell);

    if (!cnt) {                                  // node has no lawn around it
      p[o + 1] = gy - BASE_DROP;
      c[o] = 0.20; c[o + 1] = 0.22; c[o + 2] = 0.14;
      L[ni] = -1;
    } else {
      const hm = sum / cnt;
      L[ni] = hm;
      const t = clamp01((hm - CUT_MM) / (TALL_MM - CUT_MM));
      let r, g, b;
      if (t < 0.5) {
        const u = t * 2;
        r = this.cCut[0] + (this.cMid[0] - this.cCut[0]) * u;
        g = this.cCut[1] + (this.cMid[1] - this.cCut[1]) * u;
        b = this.cCut[2] + (this.cMid[2] - this.cCut[2]) * u;
      } else {
        const u = (t - 0.5) * 2;
        r = this.cMid[0] + (this.cTall[0] - this.cMid[0]) * u;
        g = this.cMid[1] + (this.cTall[1] - this.cMid[1]) * u;
        b = this.cMid[2] + (this.cTall[2] - this.cMid[2]) * u;
      }
      const nz = this.noise[ni];
      const s = Math.tanh(Math.sin((ny * this.cell) * Math.PI / STRIPE_M) * 2.4);
      // 0.46 matches the shell shader's root tint: the base is what shows
      // BETWEEN blades, so it has to sit in exactly their shade or the gaps
      // read as a different material.
      const mul = 0.46 * (1 + nz * 0.30 + s * (1 - t) * STRIPE_AMT);
      c[o] = r * mul; c[o + 1] = g * mul; c[o + 2] = b * mul;
      p[o + 1] = gy - BASE_DROP + nz * 0.006;
    }

    if (this.nLo < 0 || ni < this.nLo) this.nLo = ni;
    if (ni > this.nHi) this.nHi = ni;
  }

  /** Upload only the touched spans. three clears the ranges after the draw. */
  flush() {
    if (this.nLo >= 0) {
      const start = this.nLo * 3, count = (this.nHi - this.nLo + 1) * 3;
      this.posAttr.addUpdateRange(start, count);
      this.colAttr.addUpdateRange(start, count);
      this.lenAttr.addUpdateRange(this.nLo, this.nHi - this.nLo + 1);
      this.posAttr.needsUpdate = true;
      this.colAttr.needsUpdate = true;
      this.lenAttr.needsUpdate = true;
      this.nLo = -1; this.nHi = -1;
    }
  }

  /** Per-frame: advance the wind phase, and push the fiber lengths at 2 Hz. */
  update(dt) {
    WIND.uTime.value += dt;
    if (this.texDirty) {
      this.texAge += dt;
      if (this.texAge > 0.45) this.writeHeightTex();
    }
  }

  setWind(amount) {
    // The gust field already swings between a lull and a hard gust, so the
    // weather only sets the ceiling. Clamped: past this the lawn lies flat and
    // the shells start to separate visibly.
    WIND.uWind.value = Math.min(0.145, amount);
  }

  /**
   * "Heat" view toggle. Both lawn materials read the same uniform object, so
   * this is a single write — no recompile, no geometry churn, and the normal
   * look comes back exactly as it was.
   */
  setHeat(on) { this.heatUni.value = on ? 1 : 0; }

  /** Reported by the perf probe. */
  stats() {
    return { shells: this.shells, shellTris: this.shellTris, turfTris: this.turfTris };
  }

  dispose() {
    if (this.mesh) {
      this.parent.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.mesh = null;
    }
    if (this.shellMesh) {
      this.parent.remove(this.shellMesh);
      this.shellMesh.geometry.dispose();
      this.shellMesh.material.dispose();
      this.shellMesh = null;
    }
    if (this.heightTex) { this.heightTex.dispose(); this.heightTex = null; }
  }
}
