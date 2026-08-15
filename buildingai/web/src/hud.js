// hud.js — the controls that sit on top of the view.
//
// One bar, thumb-reachable on a phone and unobtrusive on a desktop: which
// pose of the building you're looking at, which floor, and which live layers
// are on. The older checkbox panel is kept intact behind a Layers button so
// nothing that used to be reachable stopped being reachable.

let hudBuilt = false;

function buildHud() {
  if (hudBuilt) return;
  hudBuilt = true;

  const btn = id => document.getElementById(id);

  // ── floor chips ──
  const chips = btn('hudFloors');
  if (chips) {
    const mk = (label, title, fn) => {
      const b = document.createElement('button');
      b.className = 'hud-chip';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      chips.appendChild(b);
      return b;
    };
    hudChip3D = mk('3D', 'Stacked floor plates', () => { switchTo3D(); openBuilding({ still: true }); syncHud(); });
    BLDG.levels.forEach((l, i) => {
      hudChipFloor[i] = mk(BLDG.labels[i].replace('Floor ', 'F'), BLDG.labels[i],
        () => { switchToFloor(currentBuilding + '/' + l); syncHud(); });
    });
  }

  btn('btnBuilding').addEventListener('click', () => { toggleBuilding(); syncHud(); });
  btn('btnHeat').addEventListener('click', () => { setHeat(!heatOn); syncHud(); });
  btn('btnMetric').addEventListener('click', () => {
    setHeat(true, heatMetric === 'temperature' ? 'co2' : 'temperature');
    syncHud();
  });
  btn('btnChat').addEventListener('click', () => { toggleChatPanel(); });
  btn('btnLayers').addEventListener('click', () => toggleHudPop('layers'));
  btn('btnFind').addEventListener('click', () => {
    toggleHudPop('find');
    if (hudPopOpen === 'find') document.getElementById('searchRoom').focus();
  });
  btn('btnRoute').addEventListener('click', () => {
    toggleHudPop('route');
    if (hudPopOpen === 'route') document.getElementById('routeFrom').focus();
  });
  const cardX = document.getElementById('room-card-close');
  if (cardX) cardX.addEventListener('click', () => hideRoomCard());
  const fly = document.getElementById('routeFlightGo');
  if (fly) fly.addEventListener('click', () => flyRoute());
  const flyX = document.getElementById('routeFlightNo');
  if (flyX) flyX.addEventListener('click', () => hideRouteFlightChip());

  syncChatUI();
  syncHud();
}

let hudChip3D = null;
const hudChipFloor = [];

function syncHud() {
  const set = (id, on) => { const e = document.getElementById(id); if (e) e.classList.toggle('on', !!on); };
  set('btnHeat', heatOn);
  set('btnChat', chatPanelOpen());
  const m = document.getElementById('btnMetric');
  if (m) {
    m.textContent = heatMetric === 'co2' ? 'CO₂' : '°C';
    m.classList.toggle('dim', !heatOn);
  }
  if (hudChip3D) hudChip3D.classList.toggle('on', is3DView);
  hudChipFloor.forEach((b, i) => {
    b.classList.toggle('on', !is3DView && currentLevel === LEVELS[i]);
  });
  updateBuildingButton();
  updateHeatLegend();
}

// ── popovers off the bar ─────────────────────────────────────────────────
// Find, Route and Layers each hang a small card just above their button.
// Only one is ever out: they are all the same drawer, and two of them open at
// once is a menu, which is the thing this bar replaced. A click anywhere else
// or Escape puts the drawer back.
const HUD_POPS = {
  find: ['btnFind', 'findPop'],
  route: ['btnRoute', 'routePop'],
  layers: ['btnLayers', 'controls'],
};
let hudPopOpen = null;

function placeHudPop(pop, button) {
  const host = document.getElementById('viewer-container');
  if (!host) return;
  const hr = host.getBoundingClientRect();
  const br = button.getBoundingClientRect();
  const w = pop.offsetWidth || 260;
  const half = Math.min(w, hr.width - 20) / 2;
  let cx = br.left + br.width / 2 - hr.left;
  cx = Math.max(half + 10, Math.min(hr.width - half - 10, cx));
  pop.style.left = cx + 'px';
}

function setHudPop(name) {
  hudPopOpen = name || null;
  // a suggestion list belongs to the popover that raised it
  document.querySelectorAll('.hud-ac').forEach(e => e.remove());
  for (const key in HUD_POPS) {
    const [bid, pid] = HUD_POPS[key];
    const b = document.getElementById(bid), p = document.getElementById(pid);
    if (!b || !p) continue;
    const on = key === hudPopOpen;
    p.classList.toggle('open', on);
    b.classList.toggle('on', on);
    if (on) placeHudPop(p, b);
  }
}

function toggleHudPop(name) { setHudPop(hudPopOpen === name ? null : name); }

document.addEventListener('mousedown', (e) => {
  if (!hudPopOpen) return;
  const [bid, pid] = HUD_POPS[hudPopOpen];
  const t = e.target;
  if (t.closest && (t.closest('#' + pid) || t.closest('#' + bid) || t.closest('.hud-ac'))) return;
  setHudPop(null);
});

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (hudPopOpen) { setHudPop(null); return; }
  if (!document.getElementById('room-card')?.classList.contains('hidden')) hideRoomCard();
});

window.addEventListener('resize', () => {
  if (!hudPopOpen) return;
  const [bid, pid] = HUD_POPS[hudPopOpen];
  const b = document.getElementById(bid), p = document.getElementById(pid);
  if (b && p) placeHudPop(p, b);
});

// ── the details card ─────────────────────────────────────────────────────
// What used to be the bottom half of the old panel. It has no home of its
// own on screen until there is something to say, and then it sits in the
// corner the toolbar leaves free.
function showRoomCard(title) {
  const c = document.getElementById('room-card');
  if (!c) return;
  if (title !== undefined && title !== null) {
    const t = document.getElementById('room-card-title');
    if (t) t.textContent = title;
  }
  c.classList.remove('hidden');
}

function hideRoomCard() {
  const c = document.getElementById('room-card');
  if (c) c.classList.add('hidden');
}

// Every write to the card goes through here so it can never be filled in
// while it is out of sight.
function setInfoCard(html, title) {
  const el = document.getElementById('info-content');
  if (el) el.innerHTML = html;
  showRoomCard(title);
}

// ── the assistant panel ──────────────────────────────────────────────────
// One switch for the docked chat, shared by the toolbar's Chat button and the
// slim ▶ handle on the edge of the panel, so the two can never disagree. Not
// logged in, the panel simply carries the login form — asking for the key is
// part of opening the chat, not a separate step.
function chatPanelOpen() {
  const p = document.getElementById('chat-panel');
  return !!p && !p.classList.contains('hidden') && p.style.display !== 'none';
}

function toggleChatPanel(force) {
  const p = document.getElementById('chat-panel');
  if (!p) return;
  const want = force === undefined ? !chatPanelOpen() : !!force;
  p.classList.toggle('hidden', !want);
  if (want) p.style.display = '';
  syncChatUI();
  window.dispatchEvent(new Event('resize'));
}

function syncChatUI() {
  const open = chatPanelOpen();
  const t = document.getElementById('chat-toggle');
  if (t) t.textContent = open ? '▶' : '◀';
  const b = document.getElementById('btnChat');
  if (b) b.classList.toggle('on', open);
}

window.baiChatToggle = () => toggleChatPanel();

// chat.mjs opens and closes the same panel when a session connects or drops,
// so the button follows the panel rather than only its own clicks.
(function watchChatPanel() {
  const p = document.getElementById('chat-panel');
  if (!p || typeof MutationObserver !== 'function') return;
  new MutationObserver(syncChatUI).observe(p, {
    attributes: true, attributeFilter: ['class', 'style'],
  });
})();

// ── standalone viewer ────────────────────────────────────────────────────
// The viewer normally appears once the assistant panel connects. ?viewer=1
// opens it directly, which is what demos and screenshots want.
(function standalone() {
  const p = new URLSearchParams(location.search);
  if (p.get('viewer') !== '1') return;
  const reveal = () => {
    const panel = document.getElementById('chat-panel');
    const v = document.getElementById('viewer-container');
    if (!panel || !v) return;
    panel.classList.add('hidden');
    panel.classList.remove('fullscreen');
    v.style.display = '';
    const t = document.getElementById('chat-toggle');
    if (t) { t.style.display = ''; t.textContent = '◀'; }
    window.dispatchEvent(new Event('resize'));
  };
  reveal();
  setTimeout(reveal, 60);
})();

// A tiny handle for scripted checks and for driving the view from the console.
window.bai = {
  // direct eval, so console and test drivers can reach the viewer's own
  // scope instead of only what is hung off window
  exec: function (src) { return eval(src); },
  open: (o) => openBuilding(o || { frame: true }),
  close: () => closeBuilding(),
  peel: () => peelT,
  setPeel: (t) => { setPeel(t); render(); },
  hero: () => { const s = heroCameraShot(); camera3D.position.copy(s.pos); orbitControls.target.copy(s.look); orbitControls.update(); render(); },
  overview: () => { const s = overviewShot(); camera3D.position.copy(s.pos); orbitControls.target.copy(s.look); orbitControls.update(); render(); },
  heat: (on, m) => { setHeat(on !== false, m); syncHud(); },
  chat: (on) => { toggleChatPanel(on); },
  chatOpen: () => chatPanelOpen(),
  // the animated occupants are gone; kept as a no-op so old scripts still run
  people: () => false,
  fly: () => flyRoute(),
  ready: () => shellBuilt && tiersReady,
  stats: () => ({
    calls: renderer.info.render.calls,
    tris: renderer.info.render.triangles,
    geoms: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    peel: peelT, mode: is3DView ? '3d' : '2d', heat: heatOn,
    chat: chatPanelOpen(),
  }),
};
