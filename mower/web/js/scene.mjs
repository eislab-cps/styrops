// scene.mjs — renderer, camera, sky, light rig and the static garden.
//
// ============================================================================
// COORDINATE CONVENTION — chosen once, used in EVERY module of this app:
//
//     model / API space : metres, origin bottom-left, +x east, +y north,
//                         theta in radians CCW from +x  (pkg/model.Pose)
//     three.js space    : X = model.x
//                         Y = up (height above ground)
//                         Z = -model.y
//     inverse (raycast) : model.x = three.x,  model.y = -three.z
//     heading           : object3d.rotation.y = model theta, provided the mesh
//                         is authored with local +X pointing "forward".
//
// Helpers toThree()/toModel() below are the only place this is spelled out as
// code; everything else goes through them or repeats the two-line form inline.
// ============================================================================
//
// Look: late-afternoon Nordic summer. Warm sun from the west-south-west so
// everything casts a long soft shadow, cool sky bounce from the hemisphere
// light, and haze on the horizon that the fog colour matches exactly.
//
// The property is a DIORAMA: the plot polygon is the only sharp ground, with a
// soil face at its rim. Beyond it is backdrop — a shoulder falling away into
// rolling pasture, a treeline, and atmosphere — all of it soft on purpose.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { GrassField } from './grass.mjs';
import { RobotView } from './robot.mjs';
import { ObstacleLayer, contactDecal, setFoliageBudget, makeTree } from './obstacles.mjs';
import { faluWood, roofTile, gravel, paintedWhite, glowSprite, pineBand } from './textures.mjs';
import { heightAt } from './terrain.mjs';
import { PHOTO, tiled } from './assets.mjs';

export const toThree = (x, y, h = 0, out = new THREE.Vector3()) => out.set(x, h, -y);
export const toModel = (v) => ({ x: v.x, y: -v.z });

// Sun direction (scene → sun): 30° elevation, west-south-west.
//
// It used to sit at 21°, which is prettier in principle — long shadows, warm
// rake — but a horizontal lawn only collects sin(21°) = 0.36 of it, so the
// grass ended up lit mostly by the blue sky term and came out grey-teal. 30°
// still throws a long shadow and actually puts warm light on the turf.
const SUN_DIR = new THREE.Vector3(-0.780, 0.500, 0.378).normalize();

const WEATHER = {
  sunny:  { top: 0x2e6cb4, bot: 0xa8cae8, haze: 0xe8d8bc, fog: 0xd2c6b0, sun: 3.55, sunCol: 0xffe2b4, hemiSky: 0xc2d2e0, hemiGnd: 0x6e7a4e, hemi: 0.55, rain: 0, wind: 0.055 },
  // Overcast is still DAYLIGHT — a bright diffuse sky, not dusk. Presets were
  // originally tuned against a mock that always reported "sunny"; keep every
  // condition clearly daytime, differing in warmth/softness, not brightness.
  cloudy: { top: 0x5c7ba3, bot: 0xd0dce6, haze: 0xe8ecea, fog: 0xd6dcda, sun: 3.20, sunCol: 0xf6f0e4, hemiSky: 0xd8e0e6, hemiGnd: 0x77824f, hemi: 1.20, rain: 0, wind: 0.085 },
  rain:   { top: 0x3a4a5c, bot: 0x8494a2, haze: 0x9aa4ac, fog: 0x8a949c, sun: 1.70, sunCol: 0xdde4ea, hemiSky: 0xaebac4, hemiGnd: 0x55603a, hemi: 1.05, rain: 900, wind: 0.125 },
  storm:  { top: 0x2a3644, bot: 0x66727e, haze: 0x76808a, fog: 0x6a747e, sun: 1.20, sunCol: 0xc8d1da, hemiSky: 0x8d99a5, hemiGnd: 0x474f30, hemi: 0.95, rain: 1600, wind: 0.145 },
};

/**
 * Software rasterizers (SwiftShader, llvmpipe) and very weak integrated GPUs
 * cannot carry the full shell count and soft shadow taps. Detect them once and
 * run a reduced tier rather than letting a live demo crawl.
 *
 * The shell count is the knob that matters: it multiplies both geometry and,
 * far more importantly on a software raster, overdraw.
 */
function detectTier(renderer) {
  // ?tier=high|low forces the choice — needed to review the full-fat look on a
  // machine that only has a software rasterizer.
  try {
    const forced = new URLSearchParams(location.search).get('tier');
    if (forced === 'high' || forced === 'low') return forced;
  } catch { /* no location (tests) — fall through to detection */ }
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || '').toLowerCase();
    if (/swiftshader|llvmpipe|softwarerasterizer|software rasterizer|microsoft basic/.test(name)) return 'low';
  } catch { /* extension unavailable — assume a real GPU */ }
  return 'high';
}

const TIER = {
  high: { shells: 36, fiberSize: 1024, shellCell: 0.80, foliage: 190, hillSeg: 128, trees: 620 },
  low:  { shells: 10, fiberSize: 512,  shellCell: 1.70, foliage: 60,  hillSeg: 64,  trees: 240 },
};

// ── polygon → terrain-following mesh ────────────────────────────────────────

/**
 * Fill a THREE.Shape with triangles that follow heightAt(). ShapeGeometry gives
 * the exact outline but only corner vertices, so a path laid over relief would
 * cut straight through the lawn. Splitting every triangle until its longest
 * edge is under `res` fixes that, and because the displacement is a pure
 * function of (x, y) the midpoints of a shared edge agree from both sides —
 * duplicated vertices, but no cracks.
 *
 * The shape is authored in MODEL x/y; the result is in three-space with uv in
 * metres, so callers set texture.repeat to 1/tileMetres.
 */
function terrainFill(shape, res, lift) {
  const src = new THREE.ShapeGeometry(shape).toNonIndexed();
  let tri = Array.from(src.attributes.position.array);
  src.dispose();

  for (let pass = 0; pass < 7; pass++) {
    let split = false;
    const out = [];
    for (let i = 0; i < tri.length; i += 9) {
      const ax = tri[i], ay = tri[i + 1];
      const bx = tri[i + 3], by = tri[i + 4];
      const cx = tri[i + 6], cy = tri[i + 7];
      const e = Math.max(Math.hypot(bx - ax, by - ay),
        Math.hypot(cx - bx, cy - by), Math.hypot(ax - cx, ay - cy));
      if (e <= res) { out.push(ax, ay, 0, bx, by, 0, cx, cy, 0); continue; }
      split = true;
      const m0x = (ax + bx) / 2, m0y = (ay + by) / 2;
      const m1x = (bx + cx) / 2, m1y = (by + cy) / 2;
      const m2x = (cx + ax) / 2, m2y = (cy + ay) / 2;
      out.push(ax, ay, 0, m0x, m0y, 0, m2x, m2y, 0);
      out.push(m0x, m0y, 0, bx, by, 0, m1x, m1y, 0);
      out.push(m2x, m2y, 0, m1x, m1y, 0, cx, cy, 0);
      out.push(m0x, m0y, 0, m1x, m1y, 0, m2x, m2y, 0);
    }
    tri = out;
    if (!split) break;
  }

  const n = tri.length / 3;
  const P = new Float32Array(n * 3);
  const UV = new Float32Array(n * 2);
  // ShapeGeometry winds CCW in XY; (x, y) → (x, h, -y) mirrors that, so emit
  // each triangle reversed to keep the face normal pointing up.
  const ORDER = [0, 2, 1];
  for (let t = 0; t < n / 3; t++) {
    for (let k = 0; k < 3; k++) {
      const s = (t * 3 + ORDER[k]) * 3;
      const d = (t * 3 + k) * 3, du = (t * 3 + k) * 2;
      const mx = tri[s], my = tri[s + 1];
      P[d] = mx; P[d + 1] = heightAt(mx, my) + lift; P[d + 2] = -my;
      UV[du] = mx; UV[du + 1] = my;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
  g.computeVertexNormals();
  return g;
}

/**
 * Walk a closed model polygon inserting points every `step` metres, so a line
 * laid on it can follow the relief instead of chording across it.
 */
function resample(poly, step) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/** Rectangle Shape in model coordinates. */
function rectShape(x0, y0, x1, y1) {
  const s = new THREE.Shape();
  s.moveTo(x0, y0); s.lineTo(x1, y0); s.lineTo(x1, y1); s.lineTo(x0, y1);
  s.closePath();
  return s;
}

// ── the landscape the property sits in ──────────────────────────────────────
// Long-wavelength value noise, used only for the hills beyond the fence. It is
// deliberately NOT heightAt(): the garden's relief is gentle and the country
// around it is not.
function hillNoise(x, z) {
  const h2 = (a, b) => {
    let h = Math.imul(a, 374761393) + Math.imul(b, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const vn = (u, v) => {
    const xi = Math.floor(u), yi = Math.floor(v);
    const xf = u - xi, yf = v - yi;
    const su = xf * xf * (3 - 2 * xf), sv = yf * yf * (3 - 2 * yf);
    const a = h2(xi, yi), b = h2(xi + 1, yi), c = h2(xi, yi + 1), d = h2(xi + 1, yi + 1);
    return (a * (1 - su) + b * su) * (1 - sv) + (c * (1 - su) + d * su) * sv;
  };
  return vn(x / 105, z / 105) * 0.62 + vn(x / 41, z / 41) * 0.26 + vn(x / 17, z / 17) * 0.12;
}

/**
 * The lens. Everything here is a CAMERA artefact rather than a scene property,
 * and that is the point: individually none of it is noticeable, together it is
 * most of what separates a render from a photograph.
 *
 *   - chromatic aberration, radial and tiny, only at the frame edge
 *   - film grain, animated, scaled DOWN in the highlights like real film
 *   - vignette
 *   - grade: warm lift in the shadows, gentle S-curve, whites pulled off 1.0
 *
 * Runs after OutputPass, i.e. in display space, which is where a real camera
 * and a real film stock would apply them.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAberration: { value: 0.0016 },
    uGrain: { value: 0.030 },
    uVignette: { value: 0.34 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAberration;
    uniform float uGrain;
    uniform float uVignette;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);

      // lateral chromatic aberration: zero in the centre, grows with r^2
      vec2 off = c * r2 * uAberration * 4.0;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;

      // grade: warm shadow lift, S-curve, and whites that stop short of 1.0
      col += vec3(0.016, 0.010, 0.002) * (1.0 - smoothstep(0.0, 0.45, col));
      col = clamp(col, 0.0, 1.0);
      col = col * col * (3.0 - 2.0 * col) * 0.30 + col * 0.70;   // gentle S
      col *= 0.985;

      // vignette
      col *= 1.0 - uVignette * smoothstep(0.18, 0.78, r2);

      // grain, suppressed where the image is already bright
      float g = hash(vUv * vec2(1024.0, 1024.0) + fract(uTime) * 91.7) - 0.5;
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col += g * uGrain * (1.0 - lum * 0.75);

      gl_FragColor = vec4(col, 1.0);
    }`,
};

const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Underside of the diorama: how far the property's soil face drops. */
const BASE_BOTTOM = -2.4;

/**
 * The country outside the fence. The garden sits on a shoulder that falls away
 * on every side, so the property reads as a hilltop plot with a view rather
 * than a rectangle floating on nothing — and everything past the drop is soft,
 * hazy and clearly backdrop, which keeps the eye on the lawn.
 */
/**
 * The land outside the plot, and it ROLLS. One continuous function drives the
 * hills, the road, and every neighbour's building pad, so nothing can disagree
 * about where the ground is.
 *
 * Three terms:
 *   fall — the terrace cut. The garden is a flat shelf carved into a hillside,
 *          so the ground drops away just past the property line.
 *   mid  — how much authority the hill field has. It ramps in FAST (22→80 m):
 *          if the relief only arrives at 200 m the mid-ground is a green table
 *          and the whole thing reads as a flat plane with props on it.
 *   peak — positive swells are held back until ~45 m so the land dips around
 *          the plot before it climbs, and the villa never ends up behind a hill.
 *
 * Plus an explicit valley running toward the lake, so one side clearly falls.
 */
function landscapeY(x, z, cx, cz) {
  const dx = x - cx, dz = z - cz;
  const d = Math.hypot(dx, dz);
  const fall = smoothstep(14, 42, d);
  const mid = smoothstep(22, 80, d);

  let h = -9 + 38 * hillNoise(x, z);
  if (h > 0) h *= smoothstep(45, 130, d);

  // a valley draining toward the lake (which sits up-sun)
  const vx = dx * SUN_DIR.x + dz * SUN_DIR.z;         // distance along the sun axis
  const vy = dx * SUN_DIR.z - dz * SUN_DIR.x;         // across it
  h -= 13 * Math.exp(-(vy * vy) / 5200) * smoothstep(40, 150, vx);

  return -1.9 - 2.6 * fall + mid * h;
}

export class Scene3D {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: 'high-performance', stencil: false,
    });
    this.tier = detectTier(this.renderer);
    const low = this.tier === 'low';
    this.cfg = TIER[this.tier];
    setFoliageBudget(this.cfg.foliage);
    // Software rasterizers are fill-rate bound, and shell texturing is nothing
    // but overdraw, so the low tier also renders at a reduced backing-store
    // resolution and lets the browser upscale.
    this.renderer.setPixelRatio(low ? 0.6 : Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = low ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.35;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x9aa3a8, 90, 520);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.35, 900);
    this.camera.position.set(24, 18, 30);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.rotateSpeed = 0.62;
    this.controls.panSpeed = 0.7;
    this.controls.zoomSpeed = 0.9;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 2.2;
    this.controls.maxDistance = 120;
    this.controls.minPolarAngle = 0.10;
    this.controls.maxPolarAngle = 1.46;      // never below the horizon

    this.buildSky();
    this.buildLights();
    this.buildComposer();

    this.statics = new THREE.Group();
    this.statics.name = 'statics';
    this.scene.add(this.statics);

    this.backdrop = new THREE.Group();
    this.backdrop.name = 'backdrop';
    this.scene.add(this.backdrop);

    this.grass = null;
    this.robot = new RobotView(this.scene);
    this.obstacles = new ObstacleLayer(this.scene);

    this.rain = null;
    this.wireGroup = null;
    this.zoneOutlines = new Map();
    this.wireHidden = true; // wire overlay off by default — toggle in the HUD

    this.wx = WEATHER.cloudy;
    this.wxTarget = WEATHER.cloudy;
    this.updateEnvironment(WEATHER.cloudy);

    this.ray = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._hit = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._c = new THREE.Color();

    this.tween = null;
    this.clock = new THREE.Clock();
    this.world = null;
    this.frameHooks = [];
    this.afterHooks = [];

    this.onResize = this.onResize.bind(this);
    window.addEventListener('resize', this.onResize);
    this.onResize();
  }

  // ── sky ───────────────────────────────────────────────────────────────────
  buildSky() {
    this.skyUniforms = {
      uTop: { value: new THREE.Color(0x3b4753) },
      uBot: { value: new THREE.Color(0x93a1ad) },
      uHaze: { value: new THREE.Color(0xb6bcc0) },
      uSun: { value: SUN_DIR.clone() },
      uSunCol: { value: new THREE.Color(0xffd9a0) },
      uSunAmt: { value: 0.6 },
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(620, 40, 24),
      new THREE.ShaderMaterial({
        uniforms: this.skyUniforms,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        vertexShader: /* glsl */`
          varying vec3 vDir;
          void main() {
            vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */`
          uniform vec3 uTop; uniform vec3 uBot; uniform vec3 uHaze;
          uniform vec3 uSun; uniform vec3 uSunCol; uniform float uSunAmt;
          varying vec3 vDir;
          void main() {
            vec3 d = normalize(vDir);
            float h = clamp(d.y * 1.06 + 0.05, 0.0, 1.0);
            vec3 col = mix(uBot, uTop, pow(h, 0.60));

            // Atmospheric haze thickening toward the horizon. Kept tight and
            // partial: at 0.55 over a slow falloff it bleached the entire lower
            // sky, and with a low hero camera that IS the whole sky.
            float haze = exp(-max(d.y, 0.0) * 11.0);
            col = mix(col, uHaze, haze * 0.42);

            float s = max(dot(d, normalize(uSun)), 0.0);
            // sun disc + tiered glow
            float disc = smoothstep(0.9987, 0.99945, s);
            col += uSunCol * disc * 2.6 * uSunAmt;
            col += uSunCol * (pow(s, 260.0) * 0.55 + pow(s, 14.0) * 0.17 + pow(s, 3.0) * 0.055) * uSunAmt;

            gl_FragColor = vec4(col, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      })
    );
    sky.frustumCulled = false;
    sky.renderOrder = -1;
    this.scene.add(sky);
    this.sky = sky;
  }

  // ── the lens ──────────────────────────────────────────────────────────────
  /**
   * Post stack. Order matters: scene → ambient occlusion → bloom → depth of
   * field → tone map → grade/grain/vignette to screen.
   *
   * SSAO, bloom and bokeh each want several full-screen passes, which a
   * software rasterizer cannot afford on top of 36 shells of overdraw. The low
   * tier therefore keeps only the cheap end — tone map plus the grade — so the
   * picture still has the same LOOK, just without the optics.
   */
  buildComposer() {
    const w = window.innerWidth, h = window.innerHeight;
    const composer = new EffectComposer(this.renderer);
    composer.setSize(w, h);
    composer.addPass(new RenderPass(this.scene, this.camera));

    if (this.tier === 'high') {
      const ssao = new SSAOPass(this.scene, this.camera, w, h);
      ssao.kernelRadius = 0.5;          // metres — contact scale, not room scale
      ssao.minDistance = 0.0008;
      ssao.maxDistance = 0.12;
      composer.addPass(ssao);
      this.ssaoPass = ssao;

      const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.34, 0.62, 0.92);
      composer.addPass(bloom);         // threshold 0.92: sun glints, LED, windows
      this.bloomPass = bloom;

      // Gentle. At aperture 2.2e-4 / maxblur 6e-3 the backdrop turned into
      // smeared streaks — the garden must stay the sharp thing and the hills
      // must stay READABLE, just softer. This is a long lens at f/8, not f/1.4.
      const bokeh = new BokehPass(this.scene, this.camera, {
        focus: 45, aperture: 0.000055, maxblur: 0.0022,
      });
      composer.addPass(bokeh);
      this.bokehPass = bokeh;
    }

    composer.addPass(new OutputPass());

    const grade = new ShaderPass(GradeShader);
    composer.addPass(grade);
    this.gradePass = grade;

    this.composer = composer;
  }

  // ── image-based ambient ───────────────────────────────────────────────────
  /**
   * Prefilter the sky into a PMREM probe and hang it on scene.environment, so
   * every MeshStandardMaterial in the garden picks up real directional ambient
   * — bright warm from the sun side, cool blue from the zenith, dark green
   * bounce from below — instead of one flat hemisphere term. This is most of
   * the difference between "3D shapes" and "objects photographed outdoors".
   *
   * Rebuilt only when the weather target changes: PMREM costs a handful of
   * render passes and must never run inside the animation loop.
   */
  updateEnvironment(w) {
    if (!this.pmrem) this.pmrem = new THREE.PMREMGenerator(this.renderer);
    const probe = new THREE.Scene();
    // A stripped copy of the sky: same gradient, but written LINEAR — PMREM
    // captures into a half-float target, so tone mapping here would bake the
    // curve in twice.
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(12, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, fog: false,
        uniforms: {
          uTop: { value: new THREE.Color(w.top) },
          uBot: { value: new THREE.Color(w.bot) },
          uHaze: { value: new THREE.Color(w.haze) },
          uGnd: { value: new THREE.Color(w.hemiGnd) },
          uSun: { value: SUN_DIR.clone() },
          uSunCol: { value: new THREE.Color(w.sunCol) },
          uSunAmt: { value: w.rain ? 0.10 : 1 },
        },
        vertexShader: /* glsl */`
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */`
          uniform vec3 uTop; uniform vec3 uBot; uniform vec3 uHaze; uniform vec3 uGnd;
          uniform vec3 uSun; uniform vec3 uSunCol; uniform float uSunAmt;
          varying vec3 vDir;
          void main() {
            vec3 d = normalize(vDir);
            vec3 col = mix(uBot, uTop, pow(clamp(d.y * 1.06 + 0.05, 0.0, 1.0), 0.60));
            col = mix(col, uHaze, exp(-max(d.y, 0.0) * 6.5) * 0.55);
            float s = max(dot(d, normalize(uSun)), 0.0);
            col += uSunCol * (pow(s, 220.0) * 3.2 + pow(s, 12.0) * 0.30) * uSunAmt;
            // below the horizon: the green bounce a lawn actually throws up
            col = mix(col, uGnd * 0.55, smoothstep(0.0, -0.35, d.y));
            gl_FragColor = vec4(col, 1.0);
          }`,
      })
    );
    probe.add(mesh);
    const rt = this.pmrem.fromScene(probe, 0.02, 1, 40);
    if (this.envRT) this.envRT.dispose();
    this.envRT = rt;
    this.scene.environment = rt.texture;
    mesh.geometry.dispose();
    mesh.material.dispose();
  }

  // ── lights ────────────────────────────────────────────────────────────────
  buildLights() {
    this.hemi = new THREE.HemisphereLight(0xa9b8c6, 0x424c2c, 0.85);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xffd9a0, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(this.tier === 'low' ? 1024 : 2048, this.tier === 'low' ? 1024 : 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.radius = this.tier === 'low' ? 1.5 : 3.0;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // cool sky-side fill so shadowed faces don't go dead flat
    this.fill = new THREE.DirectionalLight(0x9dc0ff, 0.20);
    this.fill.position.set(28, 16, -26);
    this.scene.add(this.fill);
  }

  // ── world statics ─────────────────────────────────────────────────────────
  setWorld(world) {
    this.world = world;
    const W = world.width || 40, H = world.height || 28;
    const maxDim = Math.max(W, H);

    for (let i = this.statics.children.length - 1; i >= 0; i--) {
      const c = this.statics.children[i];
      this.statics.remove(c);
      c.traverse?.((n) => { if (n.isMesh || n.isLine) n.geometry?.dispose?.(); });
    }
    this.zoneOutlines.clear();

    // ---- the diorama: the property IS the ground ---------------------------
    // No meadow ring any more. The world rectangle is a slab of earth with a
    // crisp soil face at the rim, like a scale-model base; everything past it
    // belongs to the backdrop and is soft and hazy on purpose.
    this.buildBase(W, H, world.lawn);
    this.buildBackdrop(W, H, maxDim);

    // ---- gravel paths (with a sunken dark rim) -----------------------------
    for (const poly of world.paths || []) {
      const shp = polyShape(poly);
      if (!shp) continue;

      const rim = new THREE.Mesh(
        terrainFill(shp, 1.0, 0.010),
        new THREE.MeshStandardMaterial({ color: 0x453b2c, roughness: 1.0, side: THREE.DoubleSide })
      );
      // widen the rim about the polygon centroid so it peeks out as a shadowed lip
      let cx = 0, cy = 0;
      for (const p of poly) { cx += p.x; cy += p.y; }
      cx /= poly.length; cy /= poly.length;
      rim.position.set(cx * -0.035, 0, cy * 0.035);
      rim.scale.set(1.035, 1, 1.035);
      rim.receiveShadow = true;
      this.statics.add(rim);

      const gMat = new THREE.MeshStandardMaterial({
        map: tiled(PHOTO.soilColor, 1) || gravel(), roughness: 0.95, side: THREE.DoubleSide,
        color: 0xcfc9bb,
      });
      if (PHOTO.soilNormal) {
        gMat.normalMap = tiled(PHOTO.soilNormal, 1);
        gMat.normalScale = new THREE.Vector2(0.8, 0.8);
      }
      // uv from terrainFill is in metres; one repeat per 1.6 m of path
      gMat.map.repeat.set(1 / 1.6, 1 / 1.6);
      if (gMat.normalMap) gMat.normalMap.repeat.set(1 / 1.6, 1 / 1.6);
      const m = new THREE.Mesh(terrainFill(shp, 0.8, 0.020), gMat);
      m.receiveShadow = true;
      this.statics.add(m);
    }

    // ---- house, dock, fence, wire -----------------------------------------
    if (world.house && world.house.length >= 3) {
      // The front door must sit where the gravel path meets the house: use
      // the path vertex closest to the house centroid as a door hint.
      let doorHint = null;
      if (world.paths && world.paths.length) {
        let hx = 0, hy = 0;
        for (const p of world.house) { hx += p.x; hy += p.y; }
        hx /= world.house.length; hy /= world.house.length;
        let best = Infinity;
        for (const path of world.paths) {
          for (const v of path) {
            const d = (v.x - hx) * (v.x - hx) + (v.y - hy) * (v.y - hy);
            if (d < best) { best = d; doorHint = v; }
          }
        }
      }
      this.buildHouse(world.house, doorHint);
    }
    if (world.dock && world.dock.pos) this.buildDock(world.dock, world.house);
    this.buildWire(world.guide_wire || []);

    for (const z of world.zones || []) {
      if (!z.area || z.area.length < 3) continue;
      const pts = resample(z.area, 1.2).map(
        (p) => new THREE.Vector3(p.x, heightAt(p.x, p.y) + 0.10, -p.y));
      const line = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0xff8a3d, transparent: true, opacity: 0.85, toneMapped: false })
      );
      line.visible = false;
      this.statics.add(line);
      this.zoneOutlines.set(z.id, line);
      this.zoneOutlines.set(z.name, line);
    }

    // ---- sun rig sized to the garden --------------------------------------
    const cx = W / 2, cz = -H / 2;
    this.sun.position.copy(SUN_DIR).multiplyScalar(maxDim * 1.6).add(new THREE.Vector3(cx, 0, cz));
    this.sun.target.position.set(cx, 0, cz);
    const d = maxDim * 0.62;
    const sc = this.sun.shadow.camera;
    sc.left = -d; sc.right = d; sc.top = d; sc.bottom = -d;
    sc.near = maxDim * 0.4; sc.far = maxDim * 3.4;
    sc.updateProjectionMatrix();
    // A 21° sun grazes horizontal surfaces, so depth changes a lot across one
    // shadow texel. Scale the bias to the texel or small props self-shadow.
    const texel = (2 * d) / this.sun.shadow.mapSize.x;
    this.sun.shadow.normalBias = Math.max(0.025, texel * 2.4);
    this.sun.shadow.bias = -texel * 0.02;

    // The garden must stay crisp; everything past the fence dissolves. Near is
    // just beyond the property, far is out at the treeline, so the backdrop is
    // 70-90% fog by the time you see it.
    this.scene.fog.near = maxDim * 1.25;
    // 320 fogged the treeline to 80% and it flattened into pale triangles;
    // 400 leaves it a readable silhouette while still clearly far away.
    this.scene.fog.far = 400;
    this.controls.maxDistance = maxDim * 2.6;

    this.obstacles.sync(world.obstacles || []);

    if (!this.framed) {
      this.framed = true;
      // The hero framing, and it is a composition, not a fit-to-bounds.
      //
      // Elevation is the whole game here. At 22 degrees the horizon lands on
      // the top edge of the frame and the hills swallow the sky; at ~15 the
      // horizon sits about a third down, which is what puts lawn in the
      // foreground, villa mid-frame, and hills + treeline + sky behind it.
      // 0.27 / hypot(0.46, 0.98) = tan(14 deg).
      const off = new THREE.Vector3(0.46, 0.27, 0.98).normalize().multiplyScalar(maxDim * 1.28);
      const right = new THREE.Vector3(off.z, 0, -off.x).normalize();
      const tgt = new THREE.Vector3(cx, 3.2, cz).addScaledVector(right, maxDim * 0.15);
      this.controls.target.copy(tgt);
      this.camera.position.copy(tgt).add(off);
      this.controls.update();
    }
  }

  // ── the diorama base ──────────────────────────────────────────────────────
  /**
   * The slab the property stands on: a terrain-following top surface of bare
   * earth (only ever seen where the lawn is not — under the house, beside the
   * paths, and as a border at the property line) plus a vertical soil face
   * around the rim.
   *
   * The rim is the whole point. A crisp few-centimetre band of dark earth
   * along the edge is what makes the garden read as a deliberate object rather
   * than a patch of ground that happens to stop.
   *
   * The outline is whatever the API says the plot is: world.lawn[0] if it is
   * given (so an organic, curved boundary renders as one), otherwise the world
   * rectangle. It is pushed out slightly from the centroid so a path or a
   * house wall that runs right up to the property line still has slab under it.
   */
  buildBase(W, H, lawn) {
    const soilMat = (extraDark) => {
      const m = new THREE.MeshStandardMaterial({
        map: tiled(PHOTO.soilColor, 1 / 2.2) || null,
        color: extraDark ? 0x574d3f : 0x6e6250,
        roughness: 1.0, metalness: 0.0,
        vertexColors: extraDark,
      });
      if (!m.map) m.color.setHex(extraDark ? 0x4a4136 : 0x6b5f4c);
      if (PHOTO.soilNormal) {
        m.normalMap = tiled(PHOTO.soilNormal, 1 / 2.2);
        m.normalScale = new THREE.Vector2(1.0, 1.0);
      }
      return m;
    };

    // plot outline: the API's lawn polygon if there is one, else the world rect
    let poly = (lawn && lawn[0] && lawn[0].length >= 3)
      ? lawn[0]
      : [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
    let px = 0, py = 0;
    for (const p of poly) { px += p.x; py += p.y; }
    px /= poly.length; py /= poly.length;
    const GROW = 1.05;
    poly = poly.map((p) => ({ x: px + (p.x - px) * GROW, y: py + (p.y - py) * GROW }));

    const shape = polyShape(poly);
    if (!shape) return;
    const top = new THREE.Mesh(terrainFill(shape, 1.3, -0.02), soilMat(false));
    top.receiveShadow = true;
    top.name = 'base';
    this.statics.add(top);

    // ---- rim: a ribbon around the perimeter, top on the terrain ------------
    const ring = resample(poly, 0.9).map((p) => [p.x, p.y]);
    const n = ring.length;
    const P = new Float32Array(n * 6 * 3);
    const UV = new Float32Array(n * 6 * 2);
    const C = new Float32Array(n * 6 * 3);
    let o = 0, uo = 0, co = 0, run = 0;
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      // +0.14 m: the rim tucks up OVER the base/turf edge — a butt joint
      // between the two differently-tessellated meshes leaks sky as a white
      // sliver along the boundary
      const ay = heightAt(a[0], a[1]) + 0.14, by = heightAt(b[0], b[1]) + 0.14;
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const u0 = run / 2.2, u1 = (run + seg) / 2.2;
      run += seg;
      const v0 = 0, v1 = (Math.max(ay, by) - BASE_BOTTOM) / 2.2;
      // two triangles, wound so the face looks outward
      const quad = [
        [a[0], ay, a[1], u0, v1, 1], [b[0], by, b[1], u1, v1, 1],
        [b[0], BASE_BOTTOM, b[1], u1, v0, 0],
        [a[0], ay, a[1], u0, v1, 1], [b[0], BASE_BOTTOM, b[1], u1, v0, 0],
        [a[0], BASE_BOTTOM, a[1], u0, v0, 0],
      ];
      for (const [x, y, z, u, v, k] of quad) {
        P[o++] = x; P[o++] = y; P[o++] = -z;
        UV[uo++] = u; UV[uo++] = v;
        // dark right under the lip (the grass overhangs it), lighter below
        const s = 0.55 + 0.55 * (1 - k);
        C[co++] = s; C[co++] = s * 0.97; C[co++] = s * 0.90;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
    g.setAttribute('color', new THREE.BufferAttribute(C, 3));
    g.computeVertexNormals();
    const skirt = new THREE.Mesh(g, soilMat(true));
    skirt.material.side = THREE.DoubleSide;
    skirt.receiveShadow = true;
    skirt.castShadow = true;
    skirt.name = 'base-rim';
    this.statics.add(skirt);
  }

  // ── the view from the property ────────────────────────────────────────────
  /**
   * Everything past the fence: the shoulder falling away, rolling pasture, a
   * lake catching the low sun, and a pine treeline on the horizon. All of it
   * is cheap and heavily fogged — it exists to give the garden somewhere to
   * be, and must never compete with it for sharpness.
   */
  buildBackdrop(W, H, maxDim) {
    for (let i = this.backdrop.children.length - 1; i >= 0; i--) {
      const c = this.backdrop.children[i];
      this.backdrop.remove(c);
      // groups now (villas, trees), so walk them
      c.traverse?.((n) => { if (n.isMesh) n.geometry?.dispose?.(); });
    }
    const cx = W / 2, cz = -H / 2;
    const seg = this.cfg.hillSeg;

    // ---- rolling ground ----------------------------------------------------
    const hills = new THREE.RingGeometry(12, 400, seg, 30, 0, Math.PI * 2);
    hills.rotateX(-Math.PI / 2);
    const hp = hills.attributes.position;
    const huv = hills.attributes.uv;
    for (let i = 0; i < hp.count; i++) {
      const x = hp.getX(i) + cx, z = hp.getZ(i) + cz;
      hp.setXYZ(i, x, landscapeY(x, z, cx, cz), z);
      huv.setXY(i, x / 26, z / 26);
    }
    hills.computeVertexNormals();
    const hillMat = new THREE.MeshLambertMaterial({
      map: tiled(PHOTO.hillColor, 1) || null,
      color: PHOTO.hillColor ? 0xbcc8ac : 0x7e8c62,
    });
    const hillMesh = new THREE.Mesh(hills, hillMat);
    hillMesh.receiveShadow = false;
    hillMesh.name = 'hills';
    this.backdrop.add(hillMesh);

    // ---- lake, off toward the sun so it throws a highlight -----------------
    const lakeX = cx + SUN_DIR.x * 210, lakeZ = cz + SUN_DIR.z * 210;
    const lakeY = landscapeY(lakeX, lakeZ, cx, cz) + 1.2;
    const lake = new THREE.Mesh(
      new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xbcd2e4, toneMapped: true, fog: true })
    );
    lake.scale.set(78, 1, 42);
    lake.position.set(lakeX, lakeY, lakeZ);
    lake.name = 'lake';
    this.backdrop.add(lake);
    this.lakeMat = lake.material;

    // ---- pine treeline -----------------------------------------------------
    // Three concentric bands of alpha-cut silhouette, each planted on the same
    // landscapeY as everything else so the forest follows the hills instead of
    // hovering over them. Layering them at different radii and tones is what
    // gives the treeline depth; a single band reads as a sticker.
    const tex = pineBand();
    // Band HEIGHT sets the tree aspect once the tile is mapped: 24 m tall over
    // a 78 m tile with 16 trees is a 1:5 spike. These are 1:3, which is what a
    // spruce actually looks like.
    const bands = [
      [255, 15, 0xa9b3ad, 78],
      [205, 13, 0x74857a, 66],
      [162, 11, 0x46584c, 56],
    ];
    for (const [radius, height, tint, tile] of bands) {
      this.backdrop.add(this.treelineBand(cx, cz, radius, height, tile, tex, tint));
    }

    this.buildNeighbourhood(W, H, cx, cz);

    // ---- haze wall ---------------------------------------------------------
    // A ring of atmosphere standing between the treeline and the sky: dense at
    // the horizon, gone by the time you look up. It is what turns "distant
    // geometry" into "distance".
    // It has to stay LOW. At 90 m tall its rim sat ~10 degrees above the
    // horizon, which from the hero camera is the entire top of the frame — the
    // sky vanished behind a wall of haze. 52 m puts the rim just above the
    // treeline, where it belongs.
    this.hazeUniforms = {
      uColor: { value: new THREE.Color(0xb6bcc0) },
      uBottom: { value: -20 },
      uTop: { value: 20 },
    };
    const haze = new THREE.Mesh(
      new THREE.CylinderGeometry(300, 300, 52, 48, 1, true),
      new THREE.ShaderMaterial({
        uniforms: this.hazeUniforms,
        side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
        vertexShader: /* glsl */`
          varying float vY;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vY = wp.y;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */`
          uniform vec3 uColor; uniform float uBottom; uniform float uTop;
          varying float vY;
          void main() {
            float t = clamp((vY - uBottom) / (uTop - uBottom), 0.0, 1.0);
            gl_FragColor = vec4(uColor, (1.0 - t) * (1.0 - t) * 0.72);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      })
    );
    haze.position.set(cx, 0, cz);
    haze.renderOrder = 1;
    haze.name = 'haze';
    this.backdrop.add(haze);
    void maxDim;
  }

  /**
   * A ring of vertical cards carrying the treeline silhouette. Built by hand
   * rather than as a cylinder so each segment's BASE can sit on the terrain —
   * a fixed-height cylinder would float over every rise.
   */
  treelineBand(cx, cz, radius, height, tileM, tex, tint) {
    const segs = 110;
    const P = new Float32Array(segs * 6 * 3);
    const UV = new Float32Array(segs * 6 * 2);
    let o = 0, uo = 0, run = 0;
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1) / segs) * Math.PI * 2;
      const x0 = cx + Math.cos(a0) * radius, z0 = cz + Math.sin(a0) * radius;
      const x1 = cx + Math.cos(a1) * radius, z1 = cz + Math.sin(a1) * radius;
      const y0 = landscapeY(x0, z0, cx, cz), y1 = landscapeY(x1, z1, cx, cz);
      const seg = Math.hypot(x1 - x0, z1 - z0);
      const u0 = run / tileM, u1 = (run + seg) / tileM;
      run += seg;
      // 3 m of skirt below the ground keeps the base buried on a slope
      const quad = [
        [x0, y0 - 3, z0, u0, 0], [x1, y1 - 3, z1, u1, 0], [x1, y1 + height, z1, u1, 1],
        [x0, y0 - 3, z0, u0, 0], [x1, y1 + height, z1, u1, 1], [x0, y0 + height, z0, u0, 1],
      ];
      for (const [x, y, z, u, v] of quad) {
        P[o++] = x; P[o++] = y; P[o++] = z;
        UV[uo++] = u; UV[uo++] = v;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
    const map = tex.clone();
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.ClampToEdgeWrapping;
    map.needsUpdate = true;
    // Basic, not Lambert: at this distance a forest is a flat silhouette that
    // the fog tints. Lighting it individually is what made the cones read as
    // shiny party hats.
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      map, color: tint, alphaTest: 0.5, side: THREE.DoubleSide, fog: true,
    }));
    m.frustumCulled = false;
    m.name = 'treeline';
    return m;
  }

  // ── the neighbourhood ─────────────────────────────────────────────────────
  /**
   * Decor only, and deliberately outside the mower's world: a lane running
   * past the plot, a handful of neighbouring villas at DIFFERENT elevations on
   * the slopes, and trees between them. Everything is placed with landscapeY,
   * so the houses step up and down the hillside the way real ones do.
   *
   * Kept simple on purpose — box, gable, four lit windows. It has to read as a
   * neighbourhood at 60-120 m through haze, not survive a close-up.
   */
  buildNeighbourhood(W, H, cx, cz) {
    const rnd = (() => { let a = 0x9e3779b9; return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }; })();

    // ---- the lane ----------------------------------------------------------
    // A ribbon running east-west past the far (north) side of the plot, which
    // is the side the hero camera actually looks at. It follows the ground, so
    // it climbs and dips with the hillside instead of floating.
    const laneZ = -(H + 20);                // three-space z, i.e. north of the plot
    const half = 2.6;
    const N = 90, span = 260;
    const P = [], UV = [];
    for (let i = 0; i < N; i++) {
      const xa = cx - span / 2 + (span * i) / N;
      const xb = cx - span / 2 + (span * (i + 1)) / N;
      const za = laneZ, zb = laneZ;
      const corner = (x, z) => [x, landscapeY(x, z, cx, cz) + 0.06, z];
      const a0 = corner(xa, za - half), a1 = corner(xa, za + half);
      const b0 = corner(xb, zb - half), b1 = corner(xb, zb + half);
      const u0 = i * 0.5, u1 = (i + 1) * 0.5;
      for (const [p, u, v] of [[a0, u0, 0], [b0, u1, 0], [b1, u1, 1],
        [a0, u0, 0], [b1, u1, 1], [a1, u0, 1]]) {
        P.push(p[0], p[1], p[2]); UV.push(u, v);
      }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    lg.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
    lg.computeVertexNormals();
    const laneMap = tiled(PHOTO.soilColor, 1) || gravel();
    const lane = new THREE.Mesh(lg, new THREE.MeshLambertMaterial({
      map: laneMap, color: 0x6d6a63,
    }));
    lane.name = 'lane';
    this.backdrop.add(lane);

    // ---- neighbouring villas ----------------------------------------------
    // model x/y, footprint, yaw, wall colour — two to the west, three beyond
    // the lane to the south, all well outside the property.
    // model x/y, footprint, yaw, wall colour. Placed WEST and NORTH — the two
    // sides the hero camera (south-east, low) actually sees. Anything to the
    // south sits behind the lens and costs triangles for nothing.
    const PLOTS = [
      [-30, 9, 9.5, 7.0, 0.35, 0x9c3b26],
      [-25, 27, 8.0, 6.5, -0.50, 0xe6dcc6],
      [-2, 46, 10.0, 7.5, 0.12, 0xc8a03c],
      [24, 50, 8.5, 6.5, -0.28, 0x9c3b26],
      [52, 41, 9.0, 7.0, 0.62, 0xdcd2bc],
    ];
    for (const [mx, my, bw, bd, yaw, col] of PLOTS) {
      const x = mx, z = -my;
      const y = landscapeY(x, z, cx, cz);
      const g = this.neighbourVilla(bw, bd, col, rnd);
      g.position.set(x, y, z);
      g.rotation.y = yaw;
      this.backdrop.add(g);

      // a flattened building pad, so the house is not half-buried on a slope
      const pad = new THREE.Mesh(
        new THREE.CylinderGeometry(Math.max(bw, bd) * 0.85, Math.max(bw, bd) * 0.95, 1.2, 14),
        new THREE.MeshLambertMaterial({ color: 0x6f7a52 })
      );
      pad.position.set(x, y - 0.55, z);
      this.backdrop.add(pad);

      // a couple of trees per plot
      for (let k = 0; k < 2; k++) {
        const tx = x + (rnd() - 0.5) * bw * 2.6;
        const tz = z + (rnd() - 0.5) * bd * 2.6;
        const t = makeTree(0.9 + rnd() * 0.6, rnd);
        t.position.set(tx, landscapeY(tx, tz, cx, cz), tz);
        t.rotation.y = rnd() * 6.28;
        this.backdrop.add(t);
      }
    }

    // ---- mailbox where the plot's path meets the lane ----------------------
    const mbx = cx + 6, mbz = laneZ + half + 1.2;
    const mb = new THREE.Group();
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 1.1, 6),
      new THREE.MeshLambertMaterial({ color: 0x5b4a35 })
    );
    post.position.y = 0.55;
    mb.add(post);
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.24, 0.42),
      new THREE.MeshLambertMaterial({ color: 0x2f4a3c })
    );
    box.position.y = 1.18;
    mb.add(box);
    mb.position.set(mbx, landscapeY(mbx, mbz, cx, cz), mbz);
    this.backdrop.add(mb);
  }

  /** Box + gable + four lit windows. Two draw calls, ~40 triangles. */
  neighbourVilla(bw, bd, wallCol, rnd) {
    const g = new THREE.Group();
    const wallH = 3.2 + rnd() * 1.4;
    const rise = 1.6 + rnd() * 1.1;

    const walls = new THREE.Mesh(
      new THREE.BoxGeometry(bw, wallH, bd),
      new THREE.MeshLambertMaterial({ color: wallCol })
    );
    walls.position.y = wallH / 2;
    walls.castShadow = false;
    g.add(walls);

    // gable roof: two slopes plus two end triangles, built by hand
    const hx = bw / 2 + 0.3, hz = bd / 2 + 0.3, y0 = wallH, y1 = wallH + rise;
    const V = [];
    const push = (...p) => V.push(...p);
    // slopes
    push(-hx, y0, -hz, hx, y0, -hz, hx, y1, 0);
    push(-hx, y0, -hz, hx, y1, 0, -hx, y1, 0);
    push(hx, y0, hz, -hx, y0, hz, -hx, y1, 0);
    push(hx, y0, hz, -hx, y1, 0, hx, y1, 0);
    // ends
    push(-hx, y0, -hz, -hx, y1, 0, -hx, y0, hz);
    push(hx, y0, hz, hx, y1, 0, hx, y0, -hz);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(V, 3));
    rg.computeVertexNormals();
    const roof = new THREE.Mesh(rg, new THREE.MeshLambertMaterial({
      color: 0x4a515c, side: THREE.DoubleSide,
    }));
    g.add(roof);

    // four lit windows on the two long faces — the cue that says "lived in"
    const lit = new THREE.MeshBasicMaterial({ color: 0xffcf87, toneMapped: false });
    for (let i = 0; i < 4; i++) {
      const wq = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1.0), lit);
      const side = i < 2 ? 1 : -1;
      wq.position.set((i % 2 ? -1 : 1) * bw * 0.24, wallH * 0.55, side * (bd / 2 + 0.02));
      if (side < 0) wq.rotation.y = Math.PI;
      g.add(wq);
    }
    return g;
  }

  // ── Swedish villa ─────────────────────────────────────────────────────────
  buildHouse(poly, doorHint) {
    // World centroid + terrain height come from the footprint as given.
    const wc = { x: 0, y: 0 };
    for (const p of poly) { wc.x += p.x; wc.y += p.y; }
    wc.x /= poly.length; wc.y /= poly.length;
    let g0 = 0;
    for (const p of poly) g0 += heightAt(p.x, p.y);
    g0 /= poly.length;

    // A rotated rectangular footprint would fail the axis-aligned rectish
    // test below and lose its gable roof. De-rotate a quad into a local
    // frame (longest edge = local X), build everything axis-aligned, then
    // yaw the finished assembly back into place.
    let yaw = 0;
    if (poly.length === 4) {
      let bi = 0, bl = -1;
      for (let i = 0; i < 4; i++) {
        const a = poly[i], b = poly[(i + 1) % 4];
        const l = Math.hypot(b.x - a.x, b.y - a.y);
        if (l > bl) { bl = l; bi = i; }
      }
      const a = poly[bi], b = poly[(bi + 1) % 4];
      yaw = Math.atan2(b.y - a.y, b.x - a.x);
      const cos = Math.cos(-yaw), sin = Math.sin(-yaw);
      poly = poly.map(p => ({
        x: (p.x - wc.x) * cos - (p.y - wc.y) * sin,
        y: (p.x - wc.x) * sin + (p.y - wc.y) * cos,
      }));
      if (doorHint) {
        doorHint = {
          x: (doorHint.x - wc.x) * cos - (doorHint.y - wc.y) * sin,
          y: (doorHint.x - wc.x) * sin + (doorHint.y - wc.y) * cos,
        };
      }
    }

    const shp = polyShape(poly);
    if (!shp) return;
    const wallH = 3.9, plinthH = 0.42;
    const white = new THREE.MeshStandardMaterial({ map: paintedWhite(), roughness: 0.72 });

    // The house is assembled at y = 0 and then dropped onto the terrain as one
    // group; addStatic() routes every part into it, including the helpers.
    // For a de-rotated quad the group carries the world position + yaw
    // (model θ CCW maps to rotation.y = θ under the x,-y convention).
    const hg = new THREE.Group();
    if (yaw !== 0) {
      hg.position.set(wc.x, g0, -wc.y);
      hg.rotation.y = yaw;
    } else {
      hg.position.y = g0;
    }
    this._target = hg;

    // plinth (grey concrete foundation) — buried deep enough that the relief
    // under the footprint can never open a gap beneath a wall
    const BURY = 0.9;
    const plinth = new THREE.Mesh(
      new THREE.ExtrudeGeometry(polyShape(poly), { depth: plinthH + BURY, bevelEnabled: false, curveSegments: 2 })
        .rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x8b8880, roughness: 0.95 })
    );
    plinth.scale.set(1.03, 1, 1.03);
    plinth.position.set(...centroidOffset(poly, 1.03));
    plinth.position.y = -BURY;
    plinth.castShadow = true; plinth.receiveShadow = true;
    this.addStatic(plinth);

    // falu-red panelled walls
    const wood = faluWood();
    wood.repeat.set(1 / 1.6, 1 / 1.6);
    const wallGeo = new THREE.ExtrudeGeometry(shp, { depth: wallH, bevelEnabled: false, curveSegments: 2 })
      .rotateX(-Math.PI / 2);
    const walls = new THREE.Mesh(wallGeo, new THREE.MeshStandardMaterial({ map: wood, roughness: 0.88 }));
    walls.position.y = plinthH;
    walls.castShadow = true; walls.receiveShadow = true;
    this.addStatic(walls);

    const top = plinthH + wallH;

    // white corner boards at every footprint vertex — one instanced draw call
    const corners = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.24, wallH, 0.24), white, poly.length);
    const cm4 = new THREE.Matrix4();
    poly.forEach((p, i) => {
      cm4.makeTranslation(p.x, plinthH + wallH / 2, -p.y);
      corners.setMatrixAt(i, cm4);
    });
    corners.instanceMatrix.needsUpdate = true;
    corners.castShadow = true;
    this.addStatic(corners);

    // bbox / rectangularity test
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, area2 = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x);
      minY = Math.min(minY, a.y); maxY = Math.max(maxY, a.y);
      area2 += a.x * b.y - b.x * a.y;
    }
    const bw = maxX - minX, bh = maxY - minY;
    const rectish = poly.length <= 6 && Math.abs(area2 / 2) / Math.max(1e-6, bw * bh) > 0.86;

    const tile = roofTile();
    tile.repeat.set(1, 1);
    const roofMat = new THREE.MeshStandardMaterial({ map: tile, side: THREE.DoubleSide });

    let ridgeY = top + 0.6, ridgeAxisX = bw >= bh, eaveA = null, eaveB = null;

    if (rectish) {
      const ov = 0.42;                       // eave overhang
      const rise = Math.min(bw, bh) * 0.32 + 0.55;
      ridgeY = top + rise;
      const x0 = minX - ov, x1 = maxX + ov, y0 = minY - ov, y1 = maxY + ov;
      const P = [], UV = [];
      const push = (x, h, y, u, v) => { P.push(x, h, -y); UV.push(u, v); };

      if (ridgeAxisX) {
        const ym = (y0 + y1) / 2;
        const slope = Math.hypot((y1 - y0) / 2, rise + ov * 0.3);
        quadUV(push, [x0, top, y0], [x1, top, y0], [x1, ridgeY, ym], [x0, ridgeY, ym], x1 - x0, slope);
        quadUV(push, [x1, top, y1], [x0, top, y1], [x0, ridgeY, ym], [x1, ridgeY, ym], x1 - x0, slope);
        eaveA = [x0, top, y0, x1, top, y0];
        eaveB = [x0, top, y1, x1, top, y1];
        // gables, in wall colour rather than tile
        this.addGable([[x0, top, y0], [x0, ridgeY, ym], [x0, top, y1]], wood);
        this.addGable([[x1, top, y1], [x1, ridgeY, ym], [x1, top, y0]], wood);
      } else {
        const xm = (x0 + x1) / 2;
        const slope = Math.hypot((x1 - x0) / 2, rise + ov * 0.3);
        quadUV(push, [x0, top, y0], [xm, ridgeY, y0], [xm, ridgeY, y1], [x0, top, y1], y1 - y0, slope);
        quadUV(push, [x1, top, y1], [xm, ridgeY, y1], [xm, ridgeY, y0], [x1, top, y0], y1 - y0, slope);
        eaveA = [x0, top, y0, x0, top, y1];
        eaveB = [x1, top, y0, x1, top, y1];
        this.addGable([[x0, top, y0], [xm, ridgeY, y0], [x1, top, y0]], wood);
        this.addGable([[x1, top, y1], [xm, ridgeY, y1], [x0, top, y1]], wood);
      }

      const rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      rg.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
      rg.computeVertexNormals();
      const roof = new THREE.Mesh(rg, roofMat);
      roof.castShadow = true; roof.receiveShadow = true;
      this.addStatic(roof);

      // ridge cap
      const ridgeLen = ridgeAxisX ? (x1 - x0) : (y1 - y0);
      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(ridgeAxisX ? ridgeLen : 0.30, 0.16, ridgeAxisX ? 0.30 : ridgeLen),
        new THREE.MeshStandardMaterial({ color: 0x2b3037 })
      );
      cap.position.set(
        ridgeAxisX ? (x0 + x1) / 2 : (x0 + x1) / 2,
        ridgeY + 0.05,
        ridgeAxisX ? -(y0 + y1) / 2 : -(y0 + y1) / 2
      );
      cap.castShadow = true;
      this.addStatic(cap);

      // gutters + one downpipe per eave end
      const gutMat = new THREE.MeshStandardMaterial({ color: 0xd8d4c8 });
      for (const e of [eaveA, eaveB]) {
        const len = Math.hypot(e[3] - e[0], e[5] - e[2]);
        const horiz = Math.abs(e[3] - e[0]) > Math.abs(e[5] - e[2]);
        const g = new THREE.Mesh(
          new THREE.BoxGeometry(horiz ? len : 0.13, 0.13, horiz ? 0.13 : len), gutMat);
        g.position.set((e[0] + e[3]) / 2, top - 0.03, -(e[2] + e[5]) / 2);
        this.addStatic(g);
        const dp = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, top - 0.1, 7), gutMat);
        dp.position.set(e[0] + (horiz ? 0.35 : 0), (top - 0.1) / 2, -(e[2] + (horiz ? 0 : 0.35)));
        this.addStatic(dp);
      }

      // chimney: white-plastered, dark cap, set near one gable
      const chX = ridgeAxisX ? minX + bw * 0.28 : (minX + maxX) / 2;
      const chY = ridgeAxisX ? (minY + maxY) / 2 : minY + bh * 0.28;
      const ch = new THREE.Mesh(new THREE.BoxGeometry(0.62, 1.5, 0.62), white);
      ch.position.set(chX, ridgeY + 0.55, -chY);
      ch.castShadow = true;
      this.addStatic(ch);
      const chCap = new THREE.Mesh(
        new THREE.BoxGeometry(0.78, 0.13, 0.78),
        new THREE.MeshStandardMaterial({ color: 0x24282e })
      );
      chCap.position.set(chX, ridgeY + 1.36, -chY);
      chCap.castShadow = true;
      this.addStatic(chCap);
    } else {
      const slab = new THREE.Mesh(
        new THREE.ExtrudeGeometry(polyShape(poly), { depth: 0.34, bevelEnabled: false, curveSegments: 2 })
          .rotateX(-Math.PI / 2),
        roofMat
      );
      slab.scale.set(1.05, 1, 1.05);
      slab.position.set(...centroidOffset(poly, 1.05, top));
      slab.castShadow = true;
      this.addStatic(slab);
    }

    // ---- windows and the front door ---------------------------------------
    let cx = 0, cy = 0;
    for (const p of poly) { cx += p.x; cy += p.y; }
    cx /= poly.length; cy /= poly.length;

    const wins = [];
    // Door placement: where the gravel path meets the house (doorHint,
    // projected onto the nearest wall). Fallback: middle of the longest edge.
    let doorEdge = 0, doorT = 0.5, best = -1;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      if (l > best) { best = l; doorEdge = i; }
    }
    if (doorHint) {
      let bd = Infinity;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const ex = b.x - a.x, ey = b.y - a.y;
        const len2 = ex * ex + ey * ey;
        if (len2 < 4) continue; // wall too short for a door
        let t = ((doorHint.x - a.x) * ex + (doorHint.y - a.y) * ey) / len2;
        t = Math.max(0.15, Math.min(0.85, t));
        const px = a.x + ex * t, py = a.y + ey * t;
        const d = (doorHint.x - px) ** 2 + (doorHint.y - py) ** 2;
        if (d < bd) { bd = d; doorEdge = i; doorT = t; }
      }
    }

    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const ex = b.x - a.x, ey = b.y - a.y;
      const len = Math.hypot(ex, ey);
      if (len < 2.0) continue;
      let ox = (a.x + b.x) / 2 - cx, oy = (a.y + b.y) / 2 - cy;
      const ol = Math.hypot(ox, oy) || 1;
      ox /= ol; oy /= ol;
      const yaw = Math.atan2(ox, -oy);        // plane +Z faces (ox, 0, -oy)

      const n = Math.min(3, Math.floor(len / 2.6));
      for (let k = 0; k < n; k++) {
        const t = (k + 1) / (n + 1);
        if (i === doorEdge && Math.abs(t - doorT) < 0.16) continue; // window would collide with the door
        wins.push([a.x + ex * t + ox * 0.06, plinthH + 1.85, a.y + ey * t + oy * 0.06, yaw]);
      }
      if (i === doorEdge) {
        const t = doorT;
        this.addDoor(a.x + ex * t + ox * 0.06, plinthH, a.y + ey * t + oy * 0.06, yaw, ox, oy);
      }
    }

    this.addWindows(wins);

    this._target = null;
    this.statics.add(hg);
    // decal lives in statics (not the yawed group) → world centroid
    this.statics.add(contactDecal(wc.x, wc.y, Math.max(bw, bh) * 0.55, 0.05, 0.45));
  }

  /**
   * Add to whatever assembly is currently open. buildHouse() opens a group so
   * the whole villa — walls, roof, gutters, windows, door, step — can be
   * dropped onto the terrain in one move; everything else goes straight into
   * the statics group.
   */
  addStatic(obj) { (this._target || this.statics).add(obj); }

  /**
   * All windows share five sub-parts, so each part becomes ONE InstancedMesh:
   * a wall of eight windows costs 5 draw calls instead of 48.
   */
  addWindows(list) {
    if (!list.length) return;
    const white = new THREE.MeshStandardMaterial({ map: paintedWhite() });
    const glassMat = new THREE.MeshBasicMaterial({ color: 0xffcf87, toneMapped: false });
    const parts = [
      [new THREE.BoxGeometry(1.16, 1.38, 0.10), white, 0, 0, 0],
      [new THREE.PlaneGeometry(0.98, 1.20), glassMat, 0, 0, 0.055],
      [new THREE.BoxGeometry(0.075, 1.22, 0.055), white, 0, 0, 0.07],
      [new THREE.BoxGeometry(1.0, 0.075, 0.055), white, 0, 0.16, 0.07],
      [new THREE.BoxGeometry(1.30, 0.09, 0.20), white, 0, -0.72, 0.045],
    ];
    const m4 = new THREE.Matrix4(), off = new THREE.Matrix4();
    const q = new THREE.Quaternion(), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    for (const [g, m, dx, dy, dz] of parts) {
      const im = new THREE.InstancedMesh(g, m, list.length);
      for (let i = 0; i < list.length; i++) {
        const [x, y, z, yaw] = list[i];
        q.setFromAxisAngle(up, yaw);
        pos.set(dx, dy, dz).applyQuaternion(q).add(new THREE.Vector3(x, y, -z));
        m4.compose(pos, q, one);
        im.setMatrixAt(i, m4);
      }
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = m === white;
      this.addStatic(im);
    }
    void off;
  }

  addGable(tri3, woodTex) {
    const P = [], UV = [];
    for (const [x, h, y] of tri3) { P.push(x, h, -y); UV.push(x / 1.6, h / 1.6); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: woodTex, side: THREE.DoubleSide }));
    m.castShadow = true;
    this.addStatic(m);
  }

  addWindow(x, y, z, yaw) {
    const g = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ map: paintedWhite() });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.16, 1.38, 0.10), white);
    g.add(frame);
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(0.98, 1.20),
      new THREE.MeshBasicMaterial({ color: 0xffcf87, toneMapped: false })
    );
    glass.position.z = 0.055;
    g.add(glass);
    // Swedish divided panes: one vertical + one horizontal mullion
    const mv = new THREE.Mesh(new THREE.BoxGeometry(0.075, 1.22, 0.055), white);
    mv.position.z = 0.07; g.add(mv);
    const mh = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.075, 0.055), white);
    mh.position.set(0, 0.16, 0.07); g.add(mh);
    // sill
    const sill = new THREE.Mesh(new THREE.BoxGeometry(1.30, 0.09, 0.20), white);
    sill.position.set(0, -0.72, 0.045); g.add(sill);

    g.position.set(x, y, -z);
    g.rotation.y = yaw;
    this.addStatic(g);
  }

  addDoor(x, y, z, yaw, ox, oy) {
    const g = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ map: paintedWhite() });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.24, 2.30, 0.10), white);
    frame.position.y = 1.15;
    g.add(frame);
    const leaf = new THREE.Mesh(
      new THREE.BoxGeometry(1.00, 2.06, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x2f4a3c })
    );
    leaf.position.set(0, 1.06, 0.045);
    g.add(leaf);
    const lite = new THREE.Mesh(
      new THREE.PlaneGeometry(0.62, 0.34),
      new THREE.MeshBasicMaterial({ color: 0xffcf87, toneMapped: false })
    );
    lite.position.set(0, 1.78, 0.095);
    g.add(lite);
    const knob = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xc8a24a })
    );
    knob.position.set(0.36, 1.02, 0.10);
    g.add(knob);
    g.position.set(x, y, -z);
    g.rotation.y = yaw;
    this.addStatic(g);

    // step slab just outside the door
    const step = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 0.20, 0.8),
      new THREE.MeshStandardMaterial({ color: 0x9a978e })
    );
    step.position.set(x + ox * 0.45, y - 0.10, -(z + oy * 0.45));
    step.rotation.y = yaw;
    step.castShadow = true; step.receiveShadow = true;
    this.addStatic(step);
  }

  // ── Husqvarna charging station ────────────────────────────────────────────
  buildDock(dock, housePoly) {
    const g = new THREE.Group();
    const plastic = new THREE.MeshStandardMaterial({ color: 0x22262b });
    const orange = new THREE.MeshStandardMaterial({ color: 0xff6600 });

    const base = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.05, 0.70), plastic);
    base.position.set(-0.12, 0.025, 0);
    base.receiveShadow = true;
    g.add(base);

    // ramp lip so it reads as a drive-on plate
    const lip = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.02, 0.70), plastic);
    lip.position.set(0.44, 0.012, 0);
    g.add(lip);

    // guide rails
    for (const z of [-0.28, 0.28]) {
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.07, 0.05), plastic);
      r.position.set(-0.10, 0.085, z);
      r.castShadow = true;
      g.add(r);
    }

    // pylon: dark shell with an orange face
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.52, 0.62), plastic);
    pylon.position.set(-0.52, 0.30, 0);
    pylon.castShadow = true;
    g.add(pylon);
    const face = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.44, 0.52), orange);
    face.position.set(-0.42, 0.31, 0);
    g.add(face);

    // status LED strip
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(0.035, 0.055, 0.34),
      new THREE.MeshBasicMaterial({ color: 0x7dfcff, toneMapped: false })
    );
    strip.position.set(-0.385, 0.44, 0);
    g.add(strip);
    this.dockStrip = strip;

    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowSprite(),
      color: 0x7dfcff, transparent: true, opacity: 0.4, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    glow.scale.setScalar(0.85);
    glow.position.set(-0.37, 0.44, 0);
    g.add(glow);
    this.dockGlow = glow;

    g.position.set(dock.pos.x, heightAt(dock.pos.x, dock.pos.y), -dock.pos.y);
    // dock.heading is the robot's APPROACH direction — the station's open
    // mouth faces the opposite way, hence the extra half turn
    g.rotation.y = (dock.heading || 0) + Math.PI;
    this.statics.add(g);
    this.statics.add(contactDecal(dock.pos.x, dock.pos.y, 1.0, 0.05, 0.5));

    // power cable snaking toward the house
    if (housePoly && housePoly.length) {
      let hx = 0, hy = 0;
      for (const p of housePoly) { hx += p.x; hy += p.y; }
      hx /= housePoly.length; hy /= housePoly.length;
      const a = new THREE.Vector3(dock.pos.x, 0, -dock.pos.y);
      const b = new THREE.Vector3(hx, 0, -hy);
      const dir = b.clone().sub(a);
      const pts = [];
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        const p = a.clone().addScaledVector(dir, t * 0.72);
        p.x += Math.sin(t * 7) * 0.16;
        p.z += Math.cos(t * 5.5) * 0.16;
        p.y = heightAt(p.x, -p.z) + 0.04;
        pts.push(p);
      }
      const cable = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 22, 0.022, 5, false),
        new THREE.MeshStandardMaterial({ color: 0x1a1c20 })
      );
      this.statics.add(cable);
    }
  }

  buildWire(pts) {
    if (!pts.length) { this.wireGroup = null; return; }
    // resampled so the wire hugs the relief instead of cutting through it
    const v = resample(pts, 1.0).map(
      (p) => new THREE.Vector3(p.x, heightAt(p.x, p.y) + 0.11, -p.y));
    const geom = new THREE.BufferGeometry().setFromPoints(v);
    const grp = new THREE.Group();
    const core = new THREE.LineLoop(geom, new THREE.LineBasicMaterial({
      color: 0x64e3ff, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    grp.add(core);
    grp.renderOrder = 2;
    this.statics.add(grp);
    this.wireGroup = grp;
    this.wireCore = core;
    if (this.wireHidden) grp.visible = false;
  }

  setGrass(grid) {
    if (!this.grass) {
      this.grass = new GrassField(this.scene, grid, this.cfg);
      // the toggle can be flipped before the first /api/grass lands
      if (this.heatOn) this.grass.setHeat(true);
    } else {
      this.grass.applyFull(grid);
    }
  }

  // ── weather ───────────────────────────────────────────────────────────────
  setWeather(condition) {
    const w = WEATHER[condition] || WEATHER.cloudy;
    if (this.wxTarget !== w || !this.envRT) {
      // PMREM is several render passes; it must not run inside the loop, and
      // it only ever needs to change when the target sky does.
      this.wxTarget = w;
      this.updateEnvironment(w);
    }
    this.ensureRain(w.rain);
    if (this.grass) this.grass.setWind(w.wind);
  }

  ensureRain(count) {
    if (!count) { if (this.rain) this.rain.visible = false; return; }
    if (!this.rain) {
      const N = 1800;
      const pos = new Float32Array(N * 2 * 3);
      this.rainVel = new Float32Array(N);
      this.rainN = N;
      for (let i = 0; i < N; i++) this.seedDrop(pos, i, true);
      const g = new THREE.BufferGeometry();
      this.rainAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('position', this.rainAttr);
      this.rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
        color: 0xa8c8e8, transparent: true, opacity: 0.30, depthWrite: false, toneMapped: false,
      }));
      this.rain.frustumCulled = false;
      this.scene.add(this.rain);
    }
    this.rain.visible = true;
    this.rain.geometry.setDrawRange(0, Math.min(this.rainN, count) * 2);
    this.rain.material.opacity = count > 1200 ? 0.42 : 0.28;
  }

  seedDrop(pos, i, initial) {
    const c = this.controls ? this.controls.target : { x: 0, z: 0 };
    const o = i * 6;
    const x = c.x + (Math.random() - 0.5) * 70;
    const z = c.z + (Math.random() - 0.5) * 70;
    const y = initial ? Math.random() * 26 : 22 + Math.random() * 6;
    const len = 0.5 + Math.random() * 0.9;
    pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
    pos[o + 3] = x + 0.06; pos[o + 4] = y - len; pos[o + 5] = z;
    this.rainVel[i] = 16 + Math.random() * 14;
  }

  stepRain(dt) {
    if (!this.rain || !this.rain.visible) return;
    const pos = this.rainAttr.array;
    const n = Math.min(this.rainN, this.rain.geometry.drawRange.count / 2);
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      const d = this.rainVel[i] * dt;
      pos[o + 1] -= d; pos[o + 4] -= d;
      if (pos[o + 4] < 0) this.seedDrop(pos, i, false);
    }
    this.rainAttr.needsUpdate = true;
  }

  // ── view toggles ──────────────────────────────────────────────────────────
  setViewToggle(name, on) {
    if (name === 'wire') {
      this.wireHidden = !on;
      if (this.wireGroup) this.wireGroup.visible = on;
    } else if (name === 'trail') {
      this.robot.setVisibility({ trail: on });
    } else if (name === 'ghost') {
      this.robot.setVisibility({ ghost: on });
    } else if (name === 'heat') {
      this.heatOn = on;
      this.grass?.setHeat(on);
    }
  }

  highlightZone(key) {
    for (const line of this.zoneOutlines.values()) line.visible = false;
    const l = key && this.zoneOutlines.get(key);
    if (l) l.visible = true;
  }

  // ── picking ───────────────────────────────────────────────────────────────
  setRayFromEvent(ev) {
    const r = this.rect;
    this.ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    this.ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    this.ray.setFromCamera(this.ndc, this.camera);
  }

  /** Screen point → model (x, y) metres on the ground plane, or null. */
  screenToGround(ev) {
    this.setRayFromEvent(ev);
    const hit = this.ray.ray.intersectPlane(this.groundPlane, this._hit);
    if (!hit) return null;
    return toModel(hit);
  }

  screenToGroundVec(ev) {
    this.setRayFromEvent(ev);
    return this.ray.ray.intersectPlane(this.groundPlane, this._hit) ? this._hit.clone() : null;
  }

  pickObstacle(ev) {
    this.setRayFromEvent(ev);
    return this.obstacles.pick(this.ray);
  }

  /**
   * Did this click land on the mower itself? The headlight beam and the LED
   * glow sprite are additive, depth-write-off decoration that reaches ~1.7 m
   * ahead of the chassis — hitting them is not "clicking the robot", so they
   * are skipped and only solid body geometry counts.
   */
  pickRobot(ev) {
    if (!this.robot || !this.robot.hasPose) return false;
    this.setRayFromEvent(ev);
    const hits = this.ray.intersectObject(this.robot.group, true);
    for (const h of hits) {
      const o = h.object;
      if (o === this.robot.beam || o === this.robot.ledGlow || o === this.robot.decal) continue;
      if (!o.isMesh) continue;
      return true;
    }
    return false;
  }

  /** three-space point → CSS pixels. Uses the cached canvas rect (fullscreen). */
  project(vec3) {
    this._v.copy(vec3).project(this.camera);
    const r = this.rect;
    return {
      x: r.left + (this._v.x * 0.5 + 0.5) * r.width,
      y: r.top + (-this._v.y * 0.5 + 0.5) * r.height,
      visible: this._v.z < 1,
    };
  }

  focusOn(target, pullIn = 0.65) {
    const from = this.controls.target.clone();
    const camFrom = this.camera.position.clone();
    const offset = camFrom.clone().sub(from);
    const newDist = THREE.MathUtils.clamp(
      offset.length() * pullIn, this.controls.minDistance + 1, this.controls.maxDistance);
    offset.setLength(newDist);
    this.tween = {
      t: 0, dur: 0.65, from, to: target.clone(),
      camFrom, camTo: target.clone().add(offset),
    };
  }

  onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.ssaoPass?.setSize(w, h);
    this.bloomPass?.setSize(w, h);
    this.rect = this.canvas.getBoundingClientRect();
  }

  onFrame(fn) { this.frameHooks.push(fn); }

  /**
   * Runs once the composer has finished painting the frame — the place for a
   * second, scissored render pass (MOA CAM). A hook here owns the renderer
   * state it touches and must hand it back: viewport, scissor, render target.
   */
  onAfterFrame(fn) { this.afterHooks.push(fn); }

  start() {
    const tmp = new THREE.Color();
    this.renderer.setAnimationLoop(() => {
      const dt = Math.min(this.clock.getDelta(), 0.1);
      const now = performance.now();

      if (this.tween) {
        const tw = this.tween;
        tw.t += dt;
        const k = Math.min(1, tw.t / tw.dur);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        this.controls.target.lerpVectors(tw.from, tw.to, e);
        this.camera.position.lerpVectors(tw.camFrom, tw.camTo, e);
        if (k >= 1) this.tween = null;
      }

      // weather easing
      const a = 1 - Math.exp(-0.9 * dt);
      const t = this.wxTarget;
      this.skyUniforms.uTop.value.lerp(tmp.setHex(t.top), a);
      this.skyUniforms.uBot.value.lerp(tmp.setHex(t.bot), a);
      this.skyUniforms.uHaze.value.lerp(tmp.setHex(t.haze), a);
      this.skyUniforms.uSunCol.value.lerp(tmp.setHex(t.sunCol), a);
      const sunAmt = t.rain ? 0.10 : 1;
      this.skyUniforms.uSunAmt.value += (sunAmt - this.skyUniforms.uSunAmt.value) * a;
      this.sun.intensity += (t.sun - this.sun.intensity) * a;
      this.sun.color.lerp(tmp.setHex(t.sunCol), a);
      this.hemi.intensity += (t.hemi - this.hemi.intensity) * a;
      this.hemi.color.lerp(tmp.setHex(t.hemiSky), a);
      this.hemi.groundColor.lerp(tmp.setHex(t.hemiGnd), a);
      this.scene.fog.color.lerp(tmp.setHex(t.fog), a);
      // the haze wall and the lake are part of the sky, not the ground
      if (this.hazeUniforms) this.hazeUniforms.uColor.value.lerp(tmp.setHex(t.haze), a);
      if (this.lakeMat) {
        this.lakeMat.color.lerp(tmp.setHex(t.bot), a * 0.6);
        this.lakeMat.color.lerp(tmp.setHex(t.sunCol), a * 0.22);
      }

      this.stepRain(dt);

      if (this.dockGlow) {
        this.dockGlow.material.opacity = 0.26 + 0.22 * (0.5 + 0.5 * Math.sin(now * 0.0022));
      }
      if (this.wireCore) {
        this.wireCore.material.opacity = 0.5 + 0.22 * (0.5 + 0.5 * Math.sin(now * 0.0015));
      }

      this.grass?.update(dt);
      this.robot.update(dt);
      this.obstacles.update(dt);
      this.controls.update();

      for (let i = 0; i < this.frameHooks.length; i++) this.frameHooks[i](dt);

      // ---- the lens ------------------------------------------------------
      if (this.gradePass) this.gradePass.uniforms.uTime.value += dt;
      if (this.bokehPass) {
        // Focus rides the robot when it is on screen, the orbit target
        // otherwise: a photograph is focused on its SUBJECT, and the subject
        // here is the mower.
        const t = this.robot.hasPose
          ? this.robot.worldPos(this._v)
          : this._v.copy(this.controls.target);
        const want = this.camera.position.distanceTo(t);
        const u = this.bokehPass.materialBokeh.uniforms;
        u.focus.value += (want - u.focus.value) * (1 - Math.exp(-3 * dt));
      }
      this.composer.render(dt);

      // extra viewport passes, painted over the finished frame
      for (let i = 0; i < this.afterHooks.length; i++) this.afterHooks[i](dt);
    });
  }
}

// ── geometry helpers ─────────────────────────────────────────────────────────

/** model.Polygon → THREE.Shape (shape.x = model.x, shape.y = model.y). */
function polyShape(poly) {
  if (!poly || poly.length < 3) return null;
  let area2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    area2 += a.x * b.y - b.x * a.y;
  }
  const pts = area2 < 0 ? poly.slice().reverse() : poly;
  const s = new THREE.Shape();
  s.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i].x, pts[i].y);
  s.closePath();
  return s;
}

/** Position that keeps a uniformly scaled extrusion centred on the footprint. */
function centroidOffset(poly, scale, y = 0) {
  let cx = 0, cy = 0;
  for (const p of poly) { cx += p.x; cy += p.y; }
  cx /= poly.length; cy /= poly.length;
  return [cx * (1 - scale), y, -cy * (1 - scale)];
}

// Roof helpers. push(x, height, y, u, v) takes MODEL x/y plus a height and
// emits three-space vertices with metre-scaled UVs. Roof material is
// DoubleSide, so winding is a non-issue.
function quadUV(push, a, b, c, d, uLen, vLen) {
  push(...a, 0, 0); push(...b, uLen, 0); push(...c, uLen, vLen);
  push(...a, 0, 0); push(...c, uLen, vLen); push(...d, 0, vLen);
}
