// hud.mjs — top bar chips, mission controls, obstacle palette, toasts, log drawer.
//
// COORDINATE CONVENTION: drops raycast to the ground plane and are converted
// back to MODEL metres (x, y) by scene.screenToGround() before hitting
// POST /api/obstacles — see scene.mjs for the single definition.

import * as THREE from 'three';
import { api } from './api.mjs';
import { TYPE_LABEL } from './obstacles.mjs';
import { ICON, OBSTACLE_ICON, WEATHER_ICON } from './icons.mjs';

const $ = (sel) => document.querySelector(sel);

const RING_C = 2 * Math.PI * 9;
const SPD_MIN = 0.5, SPD_MAX = 200;
const SPD_K = Math.log(SPD_MAX / SPD_MIN);
const sliderToSpeed = (v) => SPD_MIN * Math.exp(SPD_K * (v / 100));
const speedToSlider = (s) => Math.round(100 * Math.log(Math.max(SPD_MIN, s) / SPD_MIN) / SPD_K);

function fmtSpeed(s) {
  if (s >= 10) return Math.round(s) + '×';
  if (s >= 1) return (Math.round(s * 10) / 10).toString().replace(/\.0$/, '') + '×';
  return s.toFixed(1) + '×';
}

/** Sim seconds → the top bar's clock. Shared with the MOA CAM timestamp. */
export function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return (d ? `${d}d ` : '') + `${p(h)}:${p(m)}:${p(s)}`;
}

const fmtLogT = (t) => {
  const s = Math.max(0, Math.floor(t || 0));
  return `${String(Math.floor(s / 60) % 1000).padStart(3, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export class HUD {
  constructor(scene, hooks = {}) {
    this.scene = scene;
    this.hooks = hooks;
    this.status = null;
    this.logRows = 0;
    this.dragType = null;
    this.selected = null;
    this.cutTouched = 0;
    this.speedTouched = 0;
    this._v = new THREE.Vector3();
    this.stuckToast = null;

    this.el = {
      state: $('#chip-state'), vState: $('#v-state'),
      batt: $('#chip-batt'), vBatt: $('#v-batt'), battFill: $('#batt-fill'),
      cov: $('#v-cov'), covRing: $('#cov-ring'),
      wxIco: $('#v-wxico'), temp: $('#v-temp'), forecast: $('#forecast'),
      clock: $('#v-clock'), speed: $('#v-speed'), rngSpeed: $('#rng-speed'),
      wsDot: $('#ws-dot'), wsText: $('#ws-text'),
      zone: $('#sel-zone'), brain: $('#sel-brain'),
      cut: $('#rng-cut'), cutOut: $('#out-cut'),
      note: $('#mission-note'),
      logBody: $('#log-body'), logCount: $('#log-count'), logLast: $('#log-last'),
      drawer: $('#logdrawer'), logLed: document.querySelector('.log-led'),
      toasts: $('#toasts'), ghost: $('#drag-ghost'),
      pop: $('#obs-pop'), popName: $('#obs-name'), popDel: $('#obs-del'),
      mow: $('#btn-mow'), grow: $('#btn-grow'),
      blade: $('#chip-blade'), vBlade: $('#v-blade'), bladeIco: $('#v-bladeico'),
      wear: $('#btn-wear'), newBlade: $('#btn-newblade'),
      slam: $('#slam-label'), slamDrift: $('#slam-drift'),
      wxSet: $('#wx-set'), heatLegend: $('#heat-legend'),
    };

    this.bindControls();
    this.bindEnvironment();
    this.bindPalette();
    this.bindPicking();
    this.bindLogDrawer();

    this._v2 = new THREE.Vector3();
    scene.onFrame(() => { this.positionPopover(); this.positionSlam(); });
  }

  // ── mission controls ──────────────────────────────────────────────────────
  bindControls() {
    const guard = (fn) => async () => {
      try { await fn(); } catch (err) { this.toast('bad', ICON.bad, 'Command failed', String(err.message || err)); }
    };

    this.el.mow.addEventListener('click', guard(async () => {
      const zone = this.el.zone.value;
      await api.mow(zone || undefined);
      this.toast('good', ICON.play, 'Mowing', zone ? `zone: ${zone}` : 'whole lawn', 2600);
    }));
    $('#btn-stop').addEventListener('click', guard(() => api.stop()));
    $('#btn-dock').addEventListener('click', guard(() => api.dock()));
    $('#btn-reset').addEventListener('click', guard(async () => {
      await api.reset();
      this.hooks.onReset?.();
      this.toast('good', ICON.reset, 'Simulation reset', 'grass regrown, robot docked', 2600);
    }));

    this.el.zone.addEventListener('change', () => {
      this.scene.highlightZone(this.el.zone.value || null);
    });

    this.el.brain.addEventListener('change', guard(async () => {
      const name = this.el.brain.value;
      await api.setBrain(name);
      this.toast('good', ICON.brain, 'Brain switched', name, 2600);
    }));

    this.el.cut.addEventListener('input', () => {
      this.cutTouched = performance.now();
      this.el.cutOut.textContent = `${this.el.cut.value} mm`;
    });
    this.el.cut.addEventListener('change', guard(async () => {
      this.cutTouched = performance.now();
      await api.setCutHeight(Number(this.el.cut.value));
    }));

    for (const b of document.querySelectorAll('.spd')) {
      b.addEventListener('click', guard(async () => {
        const s = Number(b.dataset.speed);
        this.speedTouched = performance.now();
        this.el.rngSpeed.value = String(speedToSlider(s));
        this.el.speed.textContent = fmtSpeed(s);
        await api.setSpeed(s);
      }));
    }
    this.el.rngSpeed.addEventListener('input', () => {
      this.speedTouched = performance.now();
      this.el.speed.textContent = fmtSpeed(sliderToSpeed(Number(this.el.rngSpeed.value)));
    });
    this.el.rngSpeed.addEventListener('change', guard(async () => {
      this.speedTouched = performance.now();
      const s = Math.round(sliderToSpeed(Number(this.el.rngSpeed.value)) * 10) / 10;
      await api.setSpeed(s);
    }));

    for (const t of document.querySelectorAll('.tgl')) {
      t.addEventListener('click', () => {
        const on = !t.classList.contains('on');
        t.classList.toggle('on', on);
        this.scene.setViewToggle(t.dataset.view, on);
        // the colormap is meaningless without its scale
        if (t.dataset.view === 'heat') this.el.heatLegend.classList.toggle('show', on);
      });
    }
  }

  // ── weather buttons + grow (both login-gated by CSS) ──────────────────────
  bindEnvironment() {
    for (const b of this.el.wxSet ? this.el.wxSet.querySelectorAll('.wxb') : []) {
      const cond = b.dataset.wx;
      b.innerHTML = WEATHER_ICON[cond] || WEATHER_ICON.cloudy;
      b.addEventListener('click', async () => {
        // optimistic: the status stream confirms (or corrects) within ~200 ms
        this.markWeather(cond);
        try {
          await api.setWeather(cond);
          this.toast('good', WEATHER_ICON[cond], 'Weather set', cond, 2000);
        } catch (err) {
          this.markWeather(this.lastWx);
          this.toast('bad', ICON.bad, 'Weather refused', String(err.message || err));
        }
      });
    }

    if (this.el.grow) {
      const gi = this.el.grow.querySelector('.gi');
      if (gi) gi.innerHTML = ICON.sprout;
      this.el.grow.addEventListener('click', async () => {
        this.el.grow.disabled = true;
        try {
          await api.growGrass(25);
          this.toast('good', ICON.sprout, 'Fertilizer applied', 'grass is growing', 3200);
        } catch (err) {
          this.toast('bad', ICON.bad, 'Nothing sprouted', String(err.message || err));
        } finally {
          this.el.grow.disabled = false;
        }
      });
    }

    if (this.el.bladeIco) this.el.bladeIco.innerHTML = ICON.blade;
    const blade = async (btn, sharpness, title, text) => {
      if (!btn) return;
      btn.querySelector('.bi').innerHTML = ICON.blade;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api.setBlade(sharpness);
          this.toast('good', ICON.blade, title, text, 3000);
        } catch (err) {
          this.toast('bad', ICON.bad, 'Blade unchanged', String(err.message || err));
        } finally {
          btn.disabled = false;
        }
      });
    };
    // 0.25 is deliberately "bad but still cutting" — it turns the chip amber
    // and gives the agent something to complain about.
    blade(this.el.wear, 0.25, 'Blade worn to 25%', 'she will notice the ragged cut');
    blade(this.el.newBlade, 1.0, 'Fresh blade fitted', 'sharpness back to 100%');
  }

  markWeather(cond) {
    if (!this.el.wxSet || cond === this.wxMarked) return;
    this.wxMarked = cond;
    for (const b of this.el.wxSet.querySelectorAll('.wxb')) {
      b.classList.toggle('on', b.dataset.wx === cond);
    }
  }

  // ── palette drag-and-drop ─────────────────────────────────────────────────
  bindPalette() {
    const ghost = this.el.ghost;

    const move = (ev) => {
      ghost.style.transform = `translate(${ev.clientX}px, ${ev.clientY}px) translate(-50%,-50%) scale(1)`;
    };

    const end = async (ev) => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', end);
      document.body.classList.remove('dragging');
      ghost.classList.remove('on');
      const type = this.dragType;
      this.dragType = null;
      if (!type) return;
      if (ev.target !== this.scene.canvas) return;
      // ground raycast → MODEL metres (see coordinate convention)
      const p = this.scene.screenToGround(ev);
      if (!p) return;
      const w = this.scene.world;
      if (w && (p.x < 0 || p.y < 0 || p.x > w.width || p.y > w.height)) {
        this.toast('warn', ICON.warn, 'Outside the garden', 'drop inside the plot', 2200);
        return;
      }
      try {
        const o = await api.addObstacle(type, Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100);
        this.toast('good', ICON.plus, `${TYPE_LABEL[type] || type} placed`,
          `at ${p.x.toFixed(1)} m, ${p.y.toFixed(1)} m`, 2200);
        this.hooks.onObstacleAdded?.(o);
      } catch (err) {
        this.toast('bad', ICON.bad, 'Could not place', String(err.message || err));
      }
    };

    for (const item of document.querySelectorAll('.pal-item')) {
      item.innerHTML = OBSTACLE_ICON[item.dataset.type] || '';
      item.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        this.dragType = item.dataset.type;
        ghost.innerHTML = item.innerHTML;
        ghost.classList.add('on');
        document.body.classList.add('dragging');
        move(ev);
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', end);
      });
    }
  }

  // ── obstacle pick / delete / camera focus ─────────────────────────────────
  bindPicking() {
    const c = this.scene.canvas;
    let down = null;

    c.addEventListener('pointerdown', (ev) => { down = { x: ev.clientX, y: ev.clientY, b: ev.button }; });
    c.addEventListener('pointerup', (ev) => {
      if (!down || down.b !== 0) { down = null; return; }
      const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
      down = null;
      if (moved > 5) return;
      // the mower wins over anything behind it — clicking her opens the map
      if (this.scene.pickRobot(ev)) { this.select(null); this.hooks.onRobotClick?.(); return; }
      const id = this.scene.pickObstacle(ev);
      this.select(id);
    });

    c.addEventListener('dblclick', (ev) => {
      const v = this.scene.screenToGroundVec(ev);
      if (v) this.scene.focusOn(v);
    });

    this.el.popDel.addEventListener('click', async () => {
      const id = this.selected;
      if (!id) return;
      try {
        await api.delObstacle(id);
        this.select(null);
      } catch (err) {
        this.toast('bad', ICON.bad, 'Delete refused', String(err.message || err));
      }
    });
  }

  select(id) {
    const data = this.scene.obstacles.select(id);
    this.selected = data ? id : null;
    if (!data) { this.el.pop.classList.remove('show'); return; }
    this.el.popName.textContent = TYPE_LABEL[data.type] || data.type;
    this.el.popDel.style.display = data.dropped ? '' : 'none';
    this.el.pop.classList.add('show');
    this.positionPopover();
  }

  positionPopover() {
    if (!this.selected) return;
    const v = this.scene.obstacles.posOf(this.selected, this._v);
    if (!v) { this.select(null); return; }
    const p = this.scene.project(v);
    this.el.pop.style.left = `${p.x}px`;
    this.el.pop.style.top = `${p.y}px`;
    this.el.pop.style.opacity = p.visible ? '1' : '0';
  }

  /** Track the holographic SLAM estimate with a floating label. */
  positionSlam() {
    const r = this.scene.robot;
    const on = r.ghostActive;
    if (on !== this.slamOn) {
      this.slamOn = on;
      this.el.slam.classList.toggle('show', on);
    }
    if (!on) return;
    const p = this.scene.project(this._v2.set(r.curGhost.x, 0.66, -r.curGhost.y));
    this.el.slam.style.left = `${p.x}px`;
    this.el.slam.style.top = `${p.y}px`;
    this.el.slam.style.opacity = p.visible ? '1' : '0';
    const d = r.drift;
    if (Math.abs(d - (this.lastDrift || 0)) > 0.005) {
      this.lastDrift = d;
      this.el.slamDrift.textContent = `${d.toFixed(2)} m`;
    }
  }

  // ── log drawer ────────────────────────────────────────────────────────────
  bindLogDrawer() {
    const head = $('#log-head');
    head.addEventListener('click', () => this.el.drawer.classList.toggle('collapsed'));
  }

  pushLogs(list) { for (const e of list || []) this.pushLog(e, true); this.trimLog(); }

  pushLog(e, bulk) {
    if (!e) return;
    const body = this.el.logBody;
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;

    const row = document.createElement('div');
    row.className = 'lrow ' + (e.level || 'info');
    const t = document.createElement('span'); t.className = 'lt'; t.textContent = fmtLogT(e.t);
    const s = document.createElement('span'); s.className = 'ls'; s.textContent = e.source || '—';
    const m = document.createElement('span'); m.className = 'lm';
    m.textContent = e.msg || '';
    if (e.fields) {
      const f = document.createElement('span'); f.className = 'lf';
      f.textContent = '  ' + Object.entries(e.fields)
        .map(([k, v]) => `${k}=${typeof v === 'number' ? (Math.round(v * 100) / 100) : v}`).join(' ');
      m.appendChild(f);
    }
    row.append(t, s, m);
    body.appendChild(row);
    this.logRows++;

    if (!bulk) {
      this.trimLog();
      this.el.logLast.textContent = `${e.source || ''} · ${e.msg || ''}`;
      this.el.logLed.classList.remove('blink');
      void this.el.logLed.offsetWidth;
      this.el.logLed.classList.add('blink');
    }
    if (atBottom) body.scrollTop = body.scrollHeight;
  }

  trimLog() {
    const body = this.el.logBody;
    while (this.logRows > 500) { body.removeChild(body.firstChild); this.logRows--; }
    this.el.logCount.textContent = String(this.logRows);
  }

  // ── data in ───────────────────────────────────────────────────────────────
  setZones(zones) {
    const sel = this.el.zone;
    const keep = sel.value;
    sel.innerHTML = '';
    const all = document.createElement('option');
    all.value = ''; all.textContent = 'Whole lawn';
    sel.appendChild(all);
    for (const z of zones || []) {
      const o = document.createElement('option');
      // POST /api/mission takes the zone by name ("back lawn") per ROBOT_API.md
      o.value = z.name; o.textContent = z.name;
      sel.appendChild(o);
    }
    if (keep) sel.value = keep;
  }

  setBrains(list) {
    const sel = this.el.brain;
    sel.innerHTML = '';
    for (const b of list || []) {
      const o = document.createElement('option');
      o.value = b.name;
      o.textContent = b.name;
      if (b.description) o.title = b.description;
      if (b.active) o.selected = true;
      sel.appendChild(o);
    }
  }

  setForecast(weather) {
    if (!weather) return;
    const box = this.el.forecast;
    box.innerHTML = '';
    for (const p of (weather.forecast || []).slice(0, 8)) {
      const d = document.createElement('div');
      d.className = 'fc';
      d.innerHTML =
        `<b>+${p.hours_ahead}h</b><i>${WEATHER_ICON[p.condition] || WEATHER_ICON.cloudy}</i>` +
        `<s>${Math.round(p.temp_c)}°</s><b>${Math.round((p.rain_prob || 0) * 100)}%</b>`;
      box.appendChild(d);
    }
  }

  setWSState(connected) {
    this.el.wsDot.classList.toggle('up', connected);
    this.el.wsText.textContent = connected ? 'LIVE' : 'OFFLINE';
  }

  /** model.RobotStatus */
  setStatus(st) {
    if (!st) return;
    this.status = st;
    const now = performance.now();

    // state
    const state = st.state || 'idle';
    this.el.state.className = 'chip s-' + state;
    this.el.vState.textContent = state.toUpperCase();
    this.el.mow.classList.toggle('active', state === 'mowing');

    // battery
    const b = st.battery || { percent: 0, charging: false };
    const pct = Math.max(0, Math.min(100, b.percent || 0));
    this.el.vBatt.textContent = `${Math.round(pct)}%`;
    this.el.battFill.setAttribute('width', String(Math.max(0.6, 17.2 * pct / 100)));
    this.el.batt.classList.toggle('charging', !!b.charging);
    if (!this.boltDone) { this.boltDone = true; document.getElementById('v-bolt').innerHTML = ICON.bolt; }
    this.el.batt.classList.toggle('low', pct <= 30 && pct > 15);
    this.el.batt.classList.toggle('crit', pct <= 15);

    // blade wear — the chip only exists once the server publishes the field,
    // so an older mower binary simply shows no blade chip
    const sh = st.blade_sharpness;
    if (this.el.blade) {
      if (typeof sh === 'number') {
        const p = Math.max(0, Math.min(100, sh * 100));
        this.el.blade.hidden = false;
        this.el.vBlade.textContent = `${Math.round(p)}%`;
        this.el.blade.classList.toggle('low', p < 40 && p >= 15);
        this.el.blade.classList.toggle('crit', p < 15);
      } else {
        this.el.blade.hidden = true;
      }
    }

    // coverage
    const cov = st.coverage ? (st.coverage.cut_percent || 0) : 0;
    this.el.cov.textContent = `${Math.round(cov)}%`;
    this.el.covRing.setAttribute('stroke-dashoffset', String(RING_C * (1 - Math.min(1, cov / 100))));

    // weather
    const w = st.weather || {};
    this.el.wxIco.innerHTML = WEATHER_ICON[w.condition] || WEATHER_ICON.cloudy;
    this.el.temp.textContent = `${Math.round(w.temp_c || 0)}°C`;
    if (w.condition) this.markWeather(w.condition);
    if (w.condition && w.condition !== this.lastWx) {
      this.lastWx = w.condition;
      this.scene.setWeather(w.condition);
    }

    // clock + speed
    this.el.clock.textContent = fmtClock(st.sim_time);
    const sp = st.sim_speed || 1;
    if (now - this.speedTouched > 1500) {
      this.el.speed.textContent = fmtSpeed(sp);
      this.el.rngSpeed.value = String(speedToSlider(sp));
      for (const btn of document.querySelectorAll('.spd')) {
        btn.classList.toggle('on', Math.abs(Number(btn.dataset.speed) - sp) < 0.05);
      }
    }

    // cut height (don't fight the user mid-drag)
    if (now - this.cutTouched > 1500 && st.cut_height) {
      this.el.cut.value = String(Math.round(st.cut_height));
      this.el.cutOut.textContent = `${Math.round(st.cut_height)} mm`;
    }

    // brain
    if (st.brain && this.el.brain.value !== st.brain) {
      const has = [...this.el.brain.options].some((o) => o.value === st.brain);
      if (has) this.el.brain.value = st.brain;
    }

    // mission note
    const m = st.mission;
    if (m) {
      const pct2 = Math.round((m.progress || 0) * 100);
      this.el.note.innerHTML =
        `<b>${m.kind}</b>${m.zone ? ' · ' + m.zone : ' · whole lawn'} · ${pct2}%`;
    } else {
      const c = st.coverage || {};
      this.el.note.textContent = `no active mission · avg ${Math.round(c.avg_height || 0)} mm`;
    }
  }

  // ── toasts ────────────────────────────────────────────────────────────────
  toast(kind, icon, title, text, ttl = 4200) {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    const i = document.createElement('span'); i.className = 'ti'; i.innerHTML = icon;
    const tx = document.createElement('span'); tx.className = 'tx';
    const b = document.createElement('b'); b.textContent = title;
    tx.appendChild(b);
    if (text) { const s = document.createElement('span'); s.textContent = text; tx.appendChild(s); }
    el.append(i, tx);
    this.el.toasts.appendChild(el);
    const kill = () => {
      if (el.dataset.dead) return;
      el.dataset.dead = '1';
      el.classList.add('out');
      setTimeout(() => el.remove(), 320);
    };
    el.addEventListener('click', kill);
    if (ttl > 0) setTimeout(kill, ttl);
    return { el, kill };
  }

  /** WS "event" frame: sim.Notice {kind, msg} */
  notice(n) {
    if (!n) return;
    const msg = n.msg || '';
    switch (n.kind) {
      case 'stuck':
        if (this.stuckToast) this.stuckToast.kill();
        this.stuckToast = this.toast('warn', ICON.warn, 'Robot is stuck', msg || 'needs a hand', 0);
        break;
      case 'unstuck':
        if (this.stuckToast) { this.stuckToast.kill(); this.stuckToast = null; }
        this.toast('good', ICON.ok, 'Free again', msg, 2800);
        break;
      case 'docked':
        this.toast('good', ICON.dock, 'Docked', msg || 'charging', 3200);
        break;
      case 'undocked':
        this.toast('good', ICON.ok, 'Left the dock', msg, 2400);
        break;
      case 'mission_done':
        this.toast('party', ICON.party, 'Mission complete', msg || 'the lawn is cut', 6000);
        break;
      case 'low_battery':
        this.toast('bad', ICON.battery, 'Low battery', msg || 'heading home', 5000);
        break;
      case 'obstacle_added':
        break;
      case 'error':
        this.toast('bad', ICON.bad, 'Error', msg, 6000);
        break;
      default:
        this.toast('good', ICON.info, n.kind, msg, 3000);
    }
  }
}
