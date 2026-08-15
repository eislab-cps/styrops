// main.mjs — wiring. Loads the world, opens the socket, routes frames.
//
// COORDINATE CONVENTION is defined once in scene.mjs (model x,y → three x, -z)
// and every module here follows it.

import { api } from './api.mjs';
import { WSBus } from './ws.mjs';
import { Scene3D } from './scene.mjs';
import { HUD } from './hud.mjs';
import { Chat } from './chat.mjs';
import { SlamView } from './slam.mjs';
import { MoaCam } from './cam.mjs';
import { Tutorial } from './tutorial.mjs';
import { ICON } from './icons.mjs';
import { loadPhotoTextures, PHOTO_STATUS } from './assets.mjs';

const canvas = document.getElementById('view');
const boot = document.getElementById('boot');

const scene = new Scene3D(canvas);
// declared before the HUD so the click handler can close over it
let slam;
const hud = new HUD(scene, {
  onReset: () => {
    scene.robot.resetTrail();
    refresh().catch(() => {});
  },
  onRobotClick: () => slam?.open(),
});
const chat = new Chat(hud);
slam = new SlamView(scene, hud);       // read-only: works logged out too
// discoverability: the topbar MAP button opens the same view as clicking the robot
document.querySelector('#btn-map')?.addEventListener('click', () => slam.open());
const tutorial = new Tutorial(chat);

// the mower's own camera — read-only, off by default, works logged out
const cam = new MoaCam(scene);
scene.onAfterFrame(() => cam.update());

scene.start();

// ── world identity: only rebuild statics when the static part really changed ─
function staticSig(w) {
  if (!w) return '';
  return JSON.stringify([
    w.name, w.width, w.height, w.grass_cell,
    w.house, w.paths, w.lawn, w.dock, w.guide_wire,
    (w.zones || []).map((z) => [z.id, z.name, z.area]),
  ]);
}
let sig = '';

function applyWorld(w) {
  if (!w) return;
  const s = staticSig(w);
  if (s !== sig) {
    sig = s;
    scene.setWorld(w);
    hud.setZones(w.zones || []);
  } else {
    scene.world = w;
    scene.obstacles.sync(w.obstacles || []);
  }
}

// ── bootstrap ───────────────────────────────────────────────────────────────
async function refresh() {
  const [world, grass, status] = await Promise.all([api.world(), api.grass(), api.status()]);
  applyWorld(world);
  scene.setGrass(grass);
  scene.robot.setStatus(status);
  hud.setStatus(status);
  cam.setStatus(status);
}

async function bootstrap() {
  // The photo textures decide which material each builder picks, so they have
  // to be resolved BEFORE the first world is constructed — otherwise the
  // garden gets built against the procedural fallbacks and then never swaps.
  // loadPhotoTextures never rejects; a missing file just means a fallback.
  await loadPhotoTextures(scene.maxAnisotropy);
  if (PHOTO_STATUS.missing.length) {
    console.warn('[assets] falling back to procedural for:', PHOTO_STATUS.missing.join(', '));
  }
  await refresh();
  boot.classList.add('gone');

  // secondary, non-blocking
  api.brains().then((b) => hud.setBrains(b)).catch(() => {});
  api.weather().then((w) => hud.setForecast(w)).catch(() => {});
  api.logs(200).then((l) => hud.pushLogs(l)).catch(() => {});
}

let bootAttempts = 0;
(function tryBoot() {
  bootstrap().catch((err) => {
    bootAttempts++;
    console.warn('[boot] retrying:', err.message || err);
    if (bootAttempts === 3) {
      const s = boot.querySelector('span');
      if (s) s.textContent = 'waiting for the mower…';
    }
    setTimeout(tryBoot, Math.min(4000, 500 * bootAttempts));
  });
})();

// refresh the forecast every couple of minutes — it drives the sky
setInterval(() => { api.weather().then((w) => hud.setForecast(w)).catch(() => {}); }, 120000);

// ── websocket ───────────────────────────────────────────────────────────────
const bus = new WSBus('/ws');
let lastReconnectToast = 0;

bus.on('status', (st) => { scene.robot.setStatus(st); hud.setStatus(st); cam.setStatus(st); });
bus.on('grass', (d) => { if (scene.grass && d) scene.grass.applyDiff(d.cells); });
bus.on('world', (w) => applyWorld(w));
bus.on('log', (e) => hud.pushLog(e));
bus.on('event', (n) => hud.notice(n));
bus.on('chat', (m) => chat.handle(m));

bus.onLifecycle((connected, isReconnect) => {
  hud.setWSState(connected);
  if (!connected) return;
  if (isReconnect) {
    refresh().catch(() => {});
    api.brains().then((b) => hud.setBrains(b)).catch(() => {});
    // A wedged server makes the idle watchdog cycle every ~16 s; announce it
    // once rather than papering the screen with toasts mid-demo.
    if (Date.now() - lastReconnectToast > 30000) {
      lastReconnectToast = Date.now();
      hud.toast('good', ICON.reconnect, 'Reconnected', 'live telemetry resumed', 2400);
    }
  }
});

bus.connect();

// keyboard: Esc clears the obstacle selection, "/" jumps into the chat box
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') hud.select(null);
  // the "/" jump-to-chat shortcut must never steal keystrokes from a field
  // the user is typing in (login card, sliders, selects, …)
  const typing = ev.target instanceof Element &&
    ev.target.closest('input, textarea, select, [contenteditable]');
  if (ev.key === '/' && !typing && document.activeElement !== chat.input) {
    ev.preventDefault();
    chat.input.focus();
  }
});

// handy for demos / console poking
window.mower = { scene, hud, chat, bus, api, slam, cam, tutorial };
