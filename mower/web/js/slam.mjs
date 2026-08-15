// slam.mjs — the modal you get by clicking the mower. Two views of the same
// garden, side by side in one card:
//
//   "Her map"   — the occupancy map the ACTIVE BRAIN built from its own noisy
//                 sensors (GET /api/slam), drawn against faint ground truth so
//                 the localisation drift is the thing you see.
//   "Coverage"  — reality: the true grass height field (GET /api/grass) on the
//                 same short-green → amber → red ramp as the 3D "Heat" view,
//                 i.e. where she has actually cut.
//
// COORDINATE CONVENTION (see scene.mjs). Both are model space: metres, origin
// bottom-left, +y north, row-major index = iy*cols + ix. A 2D canvas is the
// opposite — origin top-left, +y down — so every point goes through the one
// transform built in frame():
//
//     px = ox + x * s
//     py = oy + (H - y) * s          ← the y flip, once, here
//
// s is a single uniform metres→pixels scale (never distorted), W/H is the
// extent of the taller of {grid, real garden}, and (ox, oy) centres it. Grids
// are blitted from an ImageData of exactly cols×rows written bottom-row-first,
// which applies the same flip without a per-cell transform.
//
// Read-only: available logged out too.

import { api } from './api.mjs';
import { Modal } from './modal.mjs';

const POLL = { slam: 500, coverage: 1000 };     // 2 Hz belief, 1 Hz reality

// Same three stops as the Heat legend chip and the grass shaders' heatRamp().
const RAMP = [[26, 218, 85], [255, 188, 26], [242, 38, 25]];
const HEAT_LO = 20, HEAT_HI = 90;               // mm

const C = {
  unknown: [10, 14, 20],
  free: [38, 118, 74],                  // soft green — observed free / swept
  obstacleCell: [46, 30, 14],
  offLawn: [17, 22, 28],                // house / path / outside
  obstacle: '#ff8a3d',
  traj: 'rgba(90, 217, 255, 0.85)',
  est: '#5ad9ff',
  truth: 'rgba(255, 255, 255, 0.62)',
  outline: 'rgba(255, 255, 255, 0.26)',
  grid: 'rgba(255, 255, 255, 0.045)',
};

const TITLE = {
  slam: ['What Moa believes', 'her own map, built from noisy sensors'],
  coverage: ['What Moa has actually cut', 'true grass height across the lawn'],
};

/** mm → rgb triple on the cut→overgrown ramp (mirrors heatRamp() in grass.mjs). */
function ramp(mm) {
  const t = Math.max(0, Math.min(1, (mm - HEAT_LO) / (HEAT_HI - HEAT_LO)));
  const [a, b] = t < 0.5 ? [RAMP[0], RAMP[1]] : [RAMP[1], RAMP[2]];
  const u = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

export class SlamView {
  /** @param scene Scene3D (world + lawn outline)  @param hud HUD (live status) */
  constructor(scene, hud) {
    this.scene = scene;
    this.hud = hud;
    this.tab = 'slam';
    this.map = null;                    // model.RobotMap
    this.grass = null;                  // model.GrassGrid
    this.state = 'loading';             // loading | ok | empty | error
    this.timer = 0;

    this.canvas = document.querySelector('#slam-canvas');
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.empty = document.querySelector('#slam-empty');
    this.meta = document.querySelector('#slam-meta');
    this.head = document.querySelector('#slam-h');
    this.keys = { slam: document.querySelector('#keys-slam'), coverage: document.querySelector('#keys-cov') };

    // scratch surface the size of the GRID; scaled up on blit, so cells stay
    // square and crisp however the card is sized
    this.grid = document.createElement('canvas');
    this.gridCtx = this.grid.getContext('2d');

    for (const b of document.querySelectorAll('#slam-tabs .mtab')) {
      b.addEventListener('click', () => this.setTab(b.dataset.tab));
    }

    this.modal = new Modal('#slam-modal', {
      onShow: () => this.start(),
      onHide: () => this.stop(),
    });

    window.addEventListener('resize', () => { if (this.modal.open) this.draw(); });
  }

  open(tab) { if (tab) this.setTab(tab, true); this.modal.show(); }
  close() { this.modal.hide(); }
  toggle() { this.modal.toggle(); }
  get isOpen() { return this.modal.open; }

  setTab(tab, quiet) {
    if (tab !== 'slam' && tab !== 'coverage') return;
    this.tab = tab;
    for (const b of document.querySelectorAll('#slam-tabs .mtab')) {
      b.classList.toggle('on', b.dataset.tab === tab);
    }
    for (const k of Object.keys(this.keys)) {
      if (this.keys[k]) this.keys[k].hidden = k !== tab;
    }
    if (this.head) this.head.textContent = TITLE[tab][0];
    this.state = (tab === 'slam' ? this.map : this.grass) ? 'ok' : 'loading';
    if (quiet || !this.modal.open) return;
    this.start();                       // re-arms the poll at the tab's rate
  }

  start() {
    this.draw();
    this.tick();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), POLL[this.tab]);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = 0;
  }

  async tick() {
    const tab = this.tab;
    try {
      if (tab === 'slam') {
        const m = await api.slam();
        if (!this.modal.open || this.tab !== tab) return;
        if (m && m.cols && m.rows && Array.isArray(m.cells)) { this.map = m; this.state = 'ok'; }
        else this.state = 'empty';
      } else {
        const g = await api.grass();
        if (!this.modal.open || this.tab !== tab) return;
        if (g && g.cols && g.rows && g.heights) { this.grass = g; this.state = 'ok'; }
        else this.state = 'empty';
      }
    } catch (err) {
      if (!this.modal.open || this.tab !== tab) return;
      // 404 is not a failure — she simply has not mapped anything yet
      this.state = err.status === 404 ? 'empty' : 'error';
      this.errText = String(err.message || err);
    }
    this.draw();
  }

  // ── drawing ───────────────────────────────────────────────────────────────
  draw() {
    const cv = this.canvas, ctx = this.ctx;
    if (!cv || !ctx) return;

    const data = this.tab === 'slam' ? this.map : this.grass;
    const showEmpty = this.state !== 'ok' || !data;
    if (this.empty) {
      this.empty.hidden = !showEmpty;
      this.empty.textContent = this.state === 'error'
        ? `could not read the map — ${this.errText || 'server said no'}`
        : this.state === 'loading'
          ? 'asking Moa for her map…'
          : this.tab === 'coverage'
            ? 'no grass data yet — the garden is still loading'
            : 'no map yet — start mowing and Moa will map as she goes';
    }
    cv.style.visibility = showEmpty ? 'hidden' : '';
    if (showEmpty) { if (this.meta) this.meta.textContent = TITLE[this.tab][1]; return; }

    const f = this.frame(data.cols * data.cell, data.rows * data.cell);
    const { ctx: c, w, h, X, Y, s, W, H, dpr } = f;

    this.truthPt = null;
    c.save();
    c.clearRect(0, 0, w, h);
    c.fillStyle = '#070a0e';
    c.fillRect(0, 0, w, h);

    if (this.tab === 'slam') {
      this.blit(c, data.cols, data.rows, data.cell, X, Y, s, (i) => {
        const v = data.cells[i];
        return v === 0 ? C.free : v === 1 ? C.obstacleCell : C.unknown;
      });
      this.drawGrid(c, W, H, X, Y, dpr);
      this.drawObstacleDots(c, data, X, Y, s, dpr);
      this.drawTruth(c, X, Y, dpr);
      this.drawTrajectory(c, data, X, Y, dpr);
      this.drawPose(c, data.est_pose, X, Y, dpr);
    } else {
      this.blit(c, data.cols, data.rows, data.cell, X, Y, s, (i) => {
        const mm = data.heights[i];
        return mm < 0 ? C.offLawn : ramp(mm);
      });
      this.drawGrid(c, W, H, X, Y, dpr);
      this.drawTruth(c, X, Y, dpr);
    }
    c.restore();

    this.writeMeta(data);
  }

  /** Canvas backing store + the single model→pixel transform. */
  frame(gridW, gridH) {
    const cv = this.canvas, ctx = this.ctx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = cv.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }

    const world = this.scene.world;
    // Show the union of the grid and the real garden, so a map that is smaller
    // (or larger) than the plot still lines up with the ground-truth overlay.
    const W = Math.max(gridW, world ? world.width : 0) || gridW;
    const H = Math.max(gridH, world ? world.height : 0) || gridH;

    const pad = 12 * dpr;
    const s = Math.min((w - 2 * pad) / W, (h - 2 * pad) / H);
    const ox = (w - W * s) / 2;
    const oy = (h - H * s) / 2;
    return {
      ctx, w, h, dpr, s, W, H,
      X: (x) => ox + x * s,
      Y: (y) => oy + (H - y) * s,               // ← the flip
    };
  }

  /** Row-major grid → ImageData → one scaled blit. Bottom row first = y flip. */
  blit(ctx, cols, rows, cell, X, Y, s, colorAt) {
    if (this.grid.width !== cols || this.grid.height !== rows) {
      this.grid.width = cols; this.grid.height = rows;
    }
    const img = this.gridCtx.createImageData(cols, rows);
    const d = img.data;
    for (let iy = 0; iy < rows; iy++) {
      const dstRow = (rows - 1 - iy) * cols;      // model +y is north = up
      for (let ix = 0; ix < cols; ix++) {
        const c = colorAt(iy * cols + ix);
        const o = (dstRow + ix) * 4;
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
      }
    }
    this.gridCtx.putImageData(img, 0, 0);

    ctx.imageSmoothingEnabled = false;            // cells are cells, not a blur
    ctx.drawImage(this.grid, X(0), Y(rows * cell), cols * cell * s, rows * cell * s);
    ctx.imageSmoothingEnabled = true;
  }

  drawGrid(ctx, W, H, X, Y, dpr) {
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = Math.max(1, dpr * 0.6);
    ctx.beginPath();
    for (let x = 0; x <= W + 0.001; x += 5) { ctx.moveTo(X(x), Y(0)); ctx.lineTo(X(x), Y(H)); }
    for (let y = 0; y <= H + 0.001; y += 5) { ctx.moveTo(X(0), Y(y)); ctx.lineTo(X(W), Y(y)); }
    ctx.stroke();
  }

  drawObstacleDots(ctx, m, X, Y, s, dpr) {
    const { cols, rows, cells, cell } = m;
    const rad = Math.max(1.1 * dpr, cell * s * 0.30);
    ctx.fillStyle = C.obstacle;
    ctx.beginPath();
    for (let iy = 0; iy < rows; iy++) {
      for (let ix = 0; ix < cols; ix++) {
        if (cells[iy * cols + ix] !== 1) continue;
        const cx = X((ix + 0.5) * cell), cy = Y((iy + 0.5) * cell);
        ctx.moveTo(cx + rad, cy);
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  }

  /** Ghost-white reality: the real lawn outline and the real robot pose. */
  drawTruth(ctx, X, Y, dpr) {
    const world = this.scene.world;
    const poly = world && world.lawn && world.lawn[0];
    if (poly && poly.length > 2) {
      ctx.save();
      ctx.strokeStyle = C.outline;
      ctx.lineWidth = 1.4 * dpr;
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.beginPath();
      poly.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }

    const st = this.hud && this.hud.status;
    const p = st && st.pose;
    if (!p) return;
    const cx = X(p.x), cy = Y(p.y), r = 6.5 * dpr;
    ctx.save();
    ctx.strokeStyle = C.truth;
    ctx.lineWidth = 1.6 * dpr;
    ctx.shadowColor = 'rgba(0,0,0,.9)';
    ctx.shadowBlur = 4 * dpr;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.moveTo(cx, cy);
    // model +y is up on the canvas, so the heading tick negates sin(theta)
    ctx.lineTo(cx + Math.cos(p.theta) * r * 2.1, cy - Math.sin(p.theta) * r * 2.1);
    ctx.stroke();
    ctx.restore();
    this.truthPt = [cx, cy];
  }

  drawTrajectory(ctx, m, X, Y, dpr) {
    const t = m.trajectory;
    if (!t || t.length < 2) return;
    ctx.save();
    ctx.strokeStyle = C.traj;
    ctx.lineWidth = 1.5 * dpr;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    t.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
    ctx.stroke();
    ctx.restore();
  }

  drawPose(ctx, p, X, Y, dpr) {
    if (!p) return;
    const cx = X(p.x), cy = Y(p.y), r = 5.5 * dpr;

    // the drift itself: a hairline from where she is to where she thinks she is
    if (this.truthPt) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = dpr;
      ctx.setLineDash([2 * dpr, 3 * dpr]);
      ctx.beginPath();
      ctx.moveTo(this.truthPt[0], this.truthPt[1]);
      ctx.lineTo(cx, cy);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.fillStyle = C.est;
    ctx.strokeStyle = C.est;
    ctx.lineWidth = 2 * dpr;
    ctx.shadowColor = C.est;
    ctx.shadowBlur = 10 * dpr;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(p.theta) * r * 2.6, cy - Math.sin(p.theta) * r * 2.6);
    ctx.stroke();
    ctx.restore();
  }

  writeMeta(data) {
    if (!this.meta) return;
    const st = this.hud && this.hud.status;
    const bits = [];
    if (this.tab === 'slam') {
      let known = 0;
      for (let i = 0; i < data.cells.length; i++) if (data.cells[i] >= 0) known++;
      bits.push(`${data.cells.length ? Math.round((100 * known) / data.cells.length) : 0}% of the plot mapped`);
      if (st && st.pose && data.est_pose) {
        const d = Math.hypot(st.pose.x - data.est_pose.x, st.pose.y - data.est_pose.y);
        bits.push(`drift ${d.toFixed(2)} m`);
      }
      bits.push(`${data.cell} m cells`);
    } else {
      const cut = st && st.cut_height ? st.cut_height : 35;
      let lawn = 0, done = 0, sum = 0, max = 0;
      const h = data.heights;
      for (let i = 0; i < h.length; i++) {
        if (h[i] < 0) continue;
        lawn++; sum += h[i];
        if (h[i] > max) max = h[i];
        if (h[i] <= cut + 1) done++;
      }
      bits.push(`${lawn ? Math.round((100 * done) / lawn) : 0}% at cut height`);
      bits.push(`avg ${lawn ? Math.round(sum / lawn) : 0} mm`);
      bits.push(`tallest ${Math.round(max)} mm`);
    }
    this.meta.textContent = bits.join(' · ');
  }
}
