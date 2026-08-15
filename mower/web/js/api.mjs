// api.mjs — thin typed-ish wrapper over the REST surface in docs/ROBOT_API.md.
// Every path and body key here is verbatim from that document / pkg/model json tags.

async function req(method, path, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(path, opt);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    const err = new Error(`${method} ${path} → ${res.status} ${res.statusText}${detail ? ': ' + detail : ''}`);
    // Callers that treat one status as a normal state (404 = "no SLAM map yet")
    // must not have to regex the message.
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  const txt = await res.text();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch { return txt; }
}

const get = (p) => req('GET', p);
const post = (p, b) => req('POST', p, b === undefined ? {} : b);
const del = (p) => req('DELETE', p);

export const api = {
  // ---- read side ----
  world:   () => get('/api/world'),                       // model.World
  grass:   () => get('/api/grass'),                       // model.GrassGrid {cols,rows,cell,heights}
  status:  () => get('/api/status'),                      // model.RobotStatus
  weather: () => get('/api/weather'),                     // model.Weather {now,forecast}
  sensors: () => get('/api/sensors'),                     // model.SensorFrame
  brains:  () => get('/api/brains'),                      // []sim.BrainInfo {name,description,active}
  zones:   () => get('/api/zones'),                       // []model.ZoneStats
  slam:    () => get('/api/slam'),                        // model.RobotMap (404 until a brain publishes)
  logs:    (limit = 200) => get(`/api/logs?limit=${limit | 0}`),

  // ---- mission control ----
  mow:  (zone) => post('/api/mission', zone ? { action: 'mow', zone } : { action: 'mow' }),
  stop: () => post('/api/mission', { action: 'stop' }),
  dock: () => post('/api/mission', { action: 'dock' }),
  setBrain: (name) => post('/api/brain', { name }),
  setCutHeight: (mm) => post('/api/cutheight', { mm }),

  // ---- world editing ----
  addObstacle: (type, x, y) => post('/api/obstacles', { type, x, y }),
  delObstacle: (id) => del('/api/obstacles/' + encodeURIComponent(id)),

  // ---- environment ----
  setWeather: (condition) => post('/api/weather', { condition }),  // sunny|cloudy|rain|storm
  growGrass: (mm = 25) => post('/api/grass/grow', { mm }),
  setBlade: (sharpness) => post('/api/blade', { sharpness }),      // 0..1, 1 = new

  // ---- sim control ----
  setSpeed: (speed) => post('/api/sim', { speed }),
  reset: () => post('/api/reset', {}),

  // ---- chat (async; replies stream back over the websocket) ----
  chat: (text, chat_id) => post('/api/chat', { text, chat_id }),
};
