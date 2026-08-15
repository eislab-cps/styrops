// cam.mjs — "MOA CAM": the garden seen from the mower's own eye.
//
// A second PerspectiveCamera is parented to RobotView's group, so it rides the
// SMOOTHED visual pose (position + terrain tilt + heading) that the 3D view
// already interpolates — never the raw status frame, which arrives at the
// telemetry rate and would judder.
//
// PAINTING IT. The main picture goes through the EffectComposer; the feed must
// not (SSAO/bloom/bokeh at 15 Hz for a 300x170 thumbnail is absurd, and the
// composer owns the full-screen buffers). So the frame loop gets a SECOND pass,
// after the composer has painted:
//
//   1. throttled  — render the plain scene into a small render target
//   2. every frame— blit that target into a scissored viewport rectangle that
//                   matches the HTML panel, on top of the finished frame
//
// The blit is what makes throttling possible at all: the composer repaints the
// whole canvas every frame, so a directly-rendered feed would flash at 15 of 60
// frames. Keeping the last feed in a texture and re-stamping it costs two
// triangles.
//
// COLOUR. Rendering into a render target skips tone mapping and the output
// colour-space conversion (three only applies those when drawing to the canvas)
// — exactly like the composer's own RenderPass, which also writes linear
// half-float. The blit material is toneMapped, so ACES + sRGB happen there. The
// feed therefore matches the main view minus the optics.
//
// The dressing (label, LIVE dot, clock, vignette) is HTML on top of the canvas,
// not GL: it stays crisp, costs nothing, and is the same DOM node in both the
// picture-in-picture and the expanded view — it simply moves between them.

import * as THREE from 'three';
import { Modal } from './modal.mjs';
import { fmtClock } from './hud.mjs';

// Mount point, in metres, in the robot's own frame: model +x is forward
// (see the coordinate note at the top of robot.mjs).
const EYE_UP = 0.24;
const EYE_FWD = 0.18;
const PITCH = 6 * Math.PI / 180;      // nose-down, so the lawn fills the frame
const HFOV = 70;                      // HORIZONTAL field of view, degrees
const NEAR = 0.05;

// Panel size and feed rate per render tier. A software rasterizer pays for the
// second scene render in fill rate, so it gets a smaller, slower feed.
const TIER = {
  high: { w: 300, h: 170, fps: 15 },
  low: { w: 240, h: 135, fps: 10 },
};

const MAX_BACKING = 1600;             // cap on the expanded view's backing store

export class MoaCam {
  /** @param scene Scene3D — renderer, scene graph, robot and tier all come from it */
  constructor(scene) {
    this.sc = scene;
    this.cfg = TIER[scene.tier] || TIER.high;
    this.interval = 1000 / this.cfg.fps;

    // ── the lens on the robot ────────────────────────────────────────────────
    this.cam = new THREE.PerspectiveCamera(50, this.cfg.w / this.cfg.h, NEAR, scene.camera.far);
    this.cam.position.set(EYE_FWD, EYE_UP, 0);
    this.cam.rotation.set(0, -Math.PI / 2, 0);   // look along the robot's +x
    this.cam.rotateX(-PITCH);                    // …tipped down a touch
    scene.robot.group.add(this.cam);             // rides the smoothed pose
    this.aspect = 0;

    // The eye sits INSIDE the chassis, and the mowing beam is a cone drawn
    // around it — from in there you see the inside of the shell and a wall of
    // headlight. The mower and its debug overlays are therefore hidden for the
    // feed pass only. Their shadows stay: those were rendered with the frame's
    // shadow maps, which is exactly what a camera bolted to a mower would see.
    this.hideFor = [scene.robot.group, scene.robot.trail, scene.robot.ghost, scene.robot.errLine]
      .filter(Boolean);
    this.wasVisible = new Array(this.hideFor.length).fill(true);

    // ── offscreen feed + the quad that stamps it onto the frame ──────────────
    this.rt = new THREE.WebGLRenderTarget(16, 16, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    });
    this.rt.texture.generateMipmaps = false;

    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadMat = new THREE.MeshBasicMaterial({
      map: this.rt.texture, depthTest: false, depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.quadMat);
    quad.frustumCulled = false;
    this.quadScene.add(quad);

    // ── DOM ──────────────────────────────────────────────────────────────────
    this.pip = document.querySelector('#campip');
    this.frame = document.querySelector('#cam-frame');
    this.stage = document.querySelector('#cam-stage');
    this.dress = document.querySelector('#cam-dress');
    this.timeEl = document.querySelector('#cam-time');
    this.btn = document.querySelector('#btn-cam');

    document.documentElement.style.setProperty('--cam-w', this.cfg.w + 'px');
    document.documentElement.style.setProperty('--cam-h', this.cfg.h + 'px');

    this.on = false;
    this.big = false;
    this.simTime = 0;
    this.lastSec = -1;
    this.tLast = -1e9;
    this.renders = 0;      // scene renders into the feed target (the throttled bit)
    this.blits = 0;        // viewport stamps (once per painted frame)

    // scratch — the viewport rect is recomputed only when the layout can have
    // moved, never per frame
    this._r = { x: 0, y: 0, w: 0, h: 0 };
    this.dirty = true;

    this.modal = new Modal('#cam-modal', {
      onShow: () => {
        this.big = true;
        this.pip.hidden = true;
        this.stage.appendChild(this.dress);
        // The feed is painted on the canvas UNDER the HTML layer, so any panel
        // that overlaps the card would sit on top of it. Fade the chrome out
        // for the duration — the expanded view is a modal anyway.
        document.body.classList.add('cam-big');
        this.relayout();
      },
      onHide: () => {
        this.big = false;
        this.frame.appendChild(this.dress);
        this.pip.hidden = !this.on;
        document.body.classList.remove('cam-big');
        this.relayout();
      },
    });

    this.btn?.addEventListener('click', () => this.toggle());
    this.frame?.addEventListener('click', () => { if (this.on) this.modal.show(); });

    // The mission panel owns the bottom-left corner whenever someone is logged
    // in, and it changes height (heat legend, viewer mode). Sit on top of it,
    // measured rather than guessed.
    this.ctl = document.querySelector('#controls');
    this.relayout = this.relayout.bind(this);
    if (this.ctl && window.ResizeObserver) {
      this.ro = new ResizeObserver(this.relayout);
      this.ro.observe(this.ctl);
    }
    window.addEventListener('resize', this.relayout);
    this.relayout();
  }

  /** Re-measure the corner. Cheap, and only on layout events. */
  relayout() {
    const lift = this.ctl ? this.ctl.offsetHeight : 0;   // 0 while display:none
    this.pip?.style.setProperty('--cam-lift', (lift ? lift + 10 : 0) + 'px');
    this.dirty = true;
    // the panel slides when the mission panel resizes; settle afterwards
    clearTimeout(this._settle);
    this._settle = setTimeout(() => { this.dirty = true; }, 320);
  }

  toggle() { this.setOn(!this.on); }

  setOn(on) {
    this.on = !!on;
    this.btn?.classList.toggle('on', this.on);
    this.btn?.setAttribute('aria-pressed', this.on ? 'true' : 'false');
    if (!this.on && this.big) this.modal.hide();
    this.pip.hidden = !this.on || this.big;
    this.tLast = -1e9;                  // first frame back on is drawn at once
    this.relayout();
  }

  /** model.RobotStatus — only the sim clock is interesting here. */
  setStatus(st) { if (st) this.simTime = st.sim_time || 0; }

  /** The screen rectangle the feed must fill, in CSS pixels, top-left origin. */
  rect() {
    if (this.dirty) {
      const el = this.big ? this.stage : this.frame;
      const b = el.getBoundingClientRect();
      this._r.x = Math.round(b.left);
      this._r.y = Math.round(b.top);
      this._r.w = Math.round(b.width);
      this._r.h = Math.round(b.height);
      this.dirty = false;
    }
    return this._r;
  }

  /**
   * Second pass of the frame. Runs AFTER the composer has painted, from
   * Scene3D.onAfterFrame — never inside the composer's own stack.
   */
  update() {
    if (!this.on && !this.big) return;

    const r = this.rect();
    if (r.w < 8 || r.h < 8) return;

    const sec = Math.floor(this.simTime);
    if (sec !== this.lastSec && this.timeEl) {
      this.lastSec = sec;
      this.timeEl.textContent = fmtClock(sec);
    }

    // Behind someone else's modal (the SLAM map): stop feeding it, but keep
    // stamping the last frame — the composer repaints the whole canvas every
    // frame, so dropping the blit too would leave an empty bezel.
    const occluded = !this.big && document.body.classList.contains('modal-open');

    const now = performance.now();
    // expanded runs at the display rate; the thumbnail is throttled
    if (!occluded && (this.big || now - this.tLast >= this.interval - 1)) {
      this.tLast = now;
      this.renderFeed(r);
    }
    this.blit(r);
  }

  /** Throttled: the plain scene, no composer, into the small target. */
  renderFeed(r) {
    const R = this.sc.renderer;
    const pr = R.getPixelRatio();
    const k = Math.min(1, MAX_BACKING / Math.max(1, r.w * pr));
    const w = Math.max(8, Math.round(r.w * pr * k));
    const h = Math.max(8, Math.round(r.h * pr * k));
    if (w !== this.rt.width || h !== this.rt.height) this.rt.setSize(w, h);

    const asp = r.w / r.h;
    if (asp !== this.aspect) {
      this.aspect = asp;
      this.cam.aspect = asp;
      // three's fov is VERTICAL; hold the horizontal field at HFOV instead, so
      // the framing is the same in the thumbnail and the expanded view
      this.cam.fov = 2 * Math.atan(Math.tan(HFOV * Math.PI / 360) / asp) * 180 / Math.PI;
      this.cam.updateProjectionMatrix();
    }

    // Reuse the shadow maps the composer's RenderPass already rendered this
    // frame — same lights, same scene, one frame apart would be invisible and
    // rendering every cascade twice is the expensive half of a second pass.
    const shadowAuto = R.shadowMap.autoUpdate;
    const autoClear = R.autoClear;
    R.shadowMap.autoUpdate = false;
    R.autoClear = true;                 // passes leave this false mid-stack
    // hiding is a render-time filter only: the camera is a child of the robot
    // group, but matrices are updated for invisible branches too, so the eye
    // still tracks the pose it is mounted on
    for (let i = 0; i < this.hideFor.length; i++) {
      this.wasVisible[i] = this.hideFor[i].visible;
      this.hideFor[i].visible = false;
    }
    R.setRenderTarget(this.rt);
    R.render(this.sc.scene, this.cam);
    R.setRenderTarget(null);
    for (let i = 0; i < this.hideFor.length; i++) this.hideFor[i].visible = this.wasVisible[i];
    R.autoClear = autoClear;
    R.shadowMap.autoUpdate = shadowAuto;
    this.renders++;
  }

  /** Every frame: stamp the feed texture into its screen rectangle. */
  blit(r) {
    const R = this.sc.renderer;
    const W = window.innerWidth, H = window.innerHeight;
    const y = H - r.y - r.h;            // GL viewports count from the bottom
    R.setViewport(r.x, y, r.w, r.h);
    R.setScissor(r.x, y, r.w, r.h);
    R.setScissorTest(true);
    R.render(this.quadScene, this.quadCam);
    // hand the renderer back exactly as it was found
    R.setScissorTest(false);
    R.setViewport(0, 0, W, H);
    R.setScissor(0, 0, W, H);
    this.blits++;
  }
}
