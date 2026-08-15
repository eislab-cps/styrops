// live.js — what the building is doing right now.
//
// Two readouts:
//   · a per-room sensor heatmap, driven by whatever sensor values the
//     equipment carries and falling back to a plausible simulation so the
//     view is never empty;
//   · the building's own clock — the chip in the corner reading the
//     simulation's time, headcount and load off /api/live/state.
//
// Both are additive: they never touch the room meshes an agent highlights.
//
// The animated occupants that used to walk these corridors are gone: they
// drew the eye away from the architecture and told you nothing the occupancy
// figures don't. The simulation behind them (pkg/livesim) is untouched and
// still drives the sensors and the headcount.

// ── heatmap ──────────────────────────────────────────────────────────────
let heatOn = false;
let heatMetric = 'temperature';        // 'temperature' | 'co2'
const heatMeshes = {};                 // level -> { mesh, ranges, colors }
let heatBuilt = false;

const HEAT_RANGE = {
  temperature: { lo: 18, hi: 27, unit: '°C', label: 'Temperature' },
  co2:         { lo: 420, hi: 1400, unit: 'ppm', label: 'CO₂' },
};

// blue → green → amber → red
function heatColor(t, out) {
  const stops = [
    [0.00, 0.22, 0.58, 0.95],
    [0.34, 0.18, 0.78, 0.42],
    [0.62, 0.96, 0.78, 0.20],
    [1.00, 0.90, 0.22, 0.16],
  ];
  const k = clamp01(t);
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (k <= b[0] || i === stops.length - 2) {
      const f = (k - a[0]) / Math.max(1e-6, b[0] - a[0]);
      const g = clamp01(f);
      out[0] = a[1] + (b[1] - a[1]) * g;
      out[1] = a[2] + (b[2] - a[2]) * g;
      out[2] = a[3] + (b[3] - a[3]) * g;
      return out;
    }
  }
  return out;
}

// Sensor lookup: real value if the equipment in the room reports one,
// otherwise a stable simulated value that drifts slowly.
function roomMetric(level, room, metric, now) {
  const levelKey = level.split('/').pop();
  for (const eq of equipment) {
    if (eq.level !== levelKey || eq.room !== room.name) continue;
    const sensors = eq.sensors || (eq.details && eq.details.sensors) || [];
    for (const s of sensors) {
      const kind = String(s.type || s.name || s.id || '').toLowerCase();
      const wanted = metric === 'co2' ? ['co2', 'carbon'] : ['temp'];
      if (!wanted.some(w => kind.includes(w))) continue;
      // the API reports sensor readings as text
      const v = typeof s.value === 'number' ? s.value : parseFloat(s.value);
      if (Number.isFinite(v)) return { v, real: true };
    }
  }
  const seed = (room.id * 2654435761) >>> 0;
  const r = mulberry(seed);
  const a = r(), b = r(), c = r();
  const drift = Math.sin(now / 47000 + a * 6.28) * 0.5 + Math.sin(now / 13000 + b * 6.28) * 0.25;
  if (metric === 'co2') {
    const base = room.type === 'corridor' ? 470 : 520 + a * 620;
    const load = room.area > 300 ? 260 : 0;
    return { v: base + load + drift * 190 + c * 60, real: false };
  }
  const base = room.type === 'corridor' ? 20.4 : 20.8 + (a - 0.5) * 4.2;
  const solar = room.area > 300 ? 1.4 : 0;
  return { v: base + solar + drift * 1.7, real: false };
}

function buildHeatLayers() {
  if (heatBuilt) return;
  heatBuilt = true;
  for (const level of LEVELS) {
    const fg = floorGroups[level];
    if (!fg || !fg.meshes.length) continue;
    const parts = [];
    const ranges = [];
    let total = 0;
    for (const m of fg.meshes) {
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      const p = g.attributes.position;
      ranges.push({ start: total, count: p.count, room: m.userData });
      total += p.count;
      parts.push(p.array);
      if (g !== m.geometry) g.dispose();
    }
    const pos = new Float32Array(total * 3);
    let o = 0;
    for (const a of parts) { pos.set(a, o); o += a.length; }
    const colors = new Float32Array(total * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeBoundingSphere();
    const mat = noTone(new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.72,
      side: THREE.DoubleSide, depthWrite: false,
    }));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.z = 1.35;
    mesh.renderOrder = 400;
    mesh.visible = false;
    fg.container.add(mesh);
    heatMeshes[level] = { mesh, ranges, colors: geo.attributes.color };
  }
}

const _hc = [0, 0, 0];
function updateHeatmap() {
  if (!heatOn) return;
  const now = Date.now();
  const range = HEAT_RANGE[heatMetric];
  for (const level of LEVELS) {
    const h = heatMeshes[level];
    if (!h || !h.mesh.visible) continue;
    const arr = h.colors.array;
    for (const r of h.ranges) {
      const { v } = roomMetric(level, r.room, heatMetric, now);
      heatColor((v - range.lo) / (range.hi - range.lo), _hc);
      for (let i = 0; i < r.count; i++) {
        const o = (r.start + i) * 3;
        arr[o] = _hc[0]; arr[o + 1] = _hc[1]; arr[o + 2] = _hc[2];
      }
    }
    h.colors.needsUpdate = true;
  }
}

function setHeat(on, metric) {
  buildHeatLayers();
  if (metric) heatMetric = metric;
  heatOn = on;
  for (const level of LEVELS) {
    const h = heatMeshes[level];
    if (h) h.mesh.visible = on;
  }
  if (on) { openBuilding({ frame: peelT < 0.5 }); updateHeatmap(); }
  updateHeatLegend();
  render();
}

function updateHeatLegend() {
  const el = document.getElementById('heatLegend');
  if (!el) return;
  el.style.display = heatOn ? 'block' : 'none';
  if (!heatOn) return;
  const r = HEAT_RANGE[heatMetric];
  el.innerHTML =
    `<div class="hud-legend-title">${r.label}</div>` +
    `<div class="hud-ramp"></div>` +
    `<div class="hud-legend-scale"><span>${r.lo}${r.unit}</span><span>${r.hi}${r.unit}</span></div>`;
}

// ── the building's own clock ─────────────────────────────────────────────
// /api/live/state carries the simulation's time of day, how many people are
// in the building and what it is drawing. A small chip is enough to make the
// view feel live rather than staged.
let liveState = null;

async function pollLiveState() {
  try {
    const r = await fetch('/api/live/state', { cache: 'no-store' });
    if (!r.ok) return;
    const st = await r.json();
    if (!st || st.enabled === false) { hideLiveChip(); return; }
    liveState = st;
    renderLiveChip(st);
  } catch (e) { /* the chip simply stays as it was */ }
}

function hideLiveChip() {
  const el = document.getElementById('liveChip');
  if (el) el.style.display = 'none';
}

function renderLiveChip(st) {
  const el = document.getElementById('liveChip');
  if (!el) return;
  el.style.display = 'flex';
  const kw = typeof st.power_kw === 'number' ? st.power_kw.toFixed(0) : '–';
  const lecture = (st.lectures_now && st.lectures_now.length)
    ? `<span class="live-part"><i>◫</i>${st.lectures_now.length} in session</span>` : '';
  el.innerHTML =
    `<span class="live-dot"></span>` +
    `<span class="live-part live-clock">${st.sim_clock || ''}</span>` +
    `<span class="live-part"><i>☖</i>${st.inside != null ? st.inside : '–'} inside</span>` +
    `<span class="live-part"><i>⚡</i>${kw} kW</span>` +
    lecture;
}

function startLiveLayers() {
  buildHeatLayers();
  pollLiveState();
  setInterval(pollLiveState, 5000);
  // Sensor values move slowly; a redraw every couple of seconds is plenty.
  setInterval(() => { if (heatOn) { updateHeatmap(); render(); } }, 2000);
}
