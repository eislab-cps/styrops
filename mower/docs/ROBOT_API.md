# Robot API — REST + WebSocket contract

The mower binary serves this API on `:9595`. Consumers: the embedded web UI
and the in-process colony executor. All payload types are `pkg/model` structs
serialized as JSON — that package is the source of truth for field names.

## REST

### Read side

| Method | Path | Returns |
|---|---|---|
| GET | `/api/world` | `model.World` — static scene + current obstacles |
| GET | `/api/grass` | `model.GrassGrid` — full grid snapshot |
| GET | `/api/status` | `model.RobotStatus` |
| GET | `/api/weather` | `model.Weather` — now + 72h forecast |
| GET | `/api/sensors` | `model.SensorFrame` — what the robot currently senses |
| GET | `/api/logs?limit=&level=&source=&minutes=` | `[]model.LogEntry`, newest last |

Log entries that happened somewhere carry `fields.x` / `fields.y`, rounded to
0.1 m — collisions, blade events, stuck/unstuck, docking, charge start/stop,
battery milestones, mission transitions, and everything a brain writes. Engine
entries are stamped with ground truth; brain entries are stamped with the
brain's own **estimated** pose (ground truth until it first publishes one), so
plotting the two side by side shows the localisation error directly. Entries
with no location (weather, sim speed, brain switch, reset) have no `x`/`y`.

Repeated `warn` entries with the same `source` and `msg` inside a 30 sim-second
window collapse into the first one, which grows a `fields.repeats` count. The
surviving entry keeps the **first** sighting's coordinates — where the trouble
started, not where the mower happened to be on the last bounce.
| GET | `/api/brains` | `[]sim.BrainInfo` |
| GET | `/api/zones` | `[]model.ZoneStats` |

### Mission control

| Method | Path | Body | Effect |
|---|---|---|---|
| POST | `/api/mission` | `{"action":"mow","zone":"back lawn"}` | start mowing (zone optional) |
| POST | `/api/mission` | `{"action":"stop"}` | stop, blade off, idle in place |
| POST | `/api/mission` | `{"action":"dock"}` | return to charger |
| POST | `/api/brain` | `{"name":"spiral"}` | switch algorithm |
| POST | `/api/cutheight` | `{"mm":35}` | set cutting height 20–60 |

### World editing (UI drag-drop)

| Method | Path | Body |
|---|---|---|
| POST | `/api/obstacles` | `{"type":"rock","x":12.5,"y":8.0}` → `model.Obstacle` (radius by type) |
| DELETE | `/api/obstacles/:id` | only `dropped:true` obstacles |

Obstacle types: `rock`, `tree`, `trampoline`, `toy`, `flowerbed`, `hedgehog`.

`hedgehog` obstacles **wander**. Each alternates between ambling (random
heading, 0.06–0.15 m/s, 2–8 sim-seconds) and sniffing on the spot (3–15
sim-seconds), staying on lawn or path and clear of the house, the scenery and
each other, and scurrying away when the mower comes within 1.2 m. Movement is
deterministic for a given sim seed. Collision, range beams, camera hints and
`GET /api/world` all read live positions. Grass is unaffected — wildlife never
masks lawn cells. A `world` event is pushed when a hedgehog has moved more than
0.15 m, throttled to 2 Hz, so the UI can follow without re-fetching.

### Manual override & sim control

| Method | Path | Body |
|---|---|---|
| POST | `/api/actuators` | `{"v":0.3,"omega":0.5,"blade_on":false}` — suspends brain, state=manual |
| POST | `/api/actuators/release` | resume brain control |
| POST | `/api/sim` | `{"speed":20}` — time multiplier 0.5–200 |
| POST | `/api/reset` | regrow grass, robot to dock, remove dropped obstacles |
| POST | `/api/weather` | `{"condition":"rain","hours":6}` — override weather, generator resumes after |
| POST | `/api/grass/grow` | `{"mm":25}` — instantly lengthen all lawn grass (demo lever) |
| POST | `/api/blade` | `{"sharpness":0.3}` — set blade wear 0..1 (demo lever; 1 = new blade) |

### Blade wear

`status.blade_sharpness` runs from `1.0` (factory sharp) down to `0.0` (dead)
and is part of every status frame. It wears only while the disc is spinning:
0.006 per sim-hour of blade-on time, doubled on wet grass, ×1.5 while cutting
growth more than 25 mm above the cut height, plus 0.002 per obstacle strike on
the disc (the same event as the `cutting disc load spike` warning). It never
goes below 0.

A worn blade tears instead of slicing, so the grass ends up
`(1 - sharpness)² × 10 mm` **above** the requested `cut_height`. Coverage stats
are not fudged to hide this: `cut_percent` counts cells at or below
`cut_height + 5 mm`, so below roughly sharpness 0.3 the lawn stops counting as
cut however long the mower runs — which is the point. A blunt disc also draws
`1 + (1 - sharpness) × 0.7` times the current, visible on
`sensors.blade_current`.

Crossing 0.40 downwards logs one `warn` — `blade worn, cut quality degraded`;
crossing 0.15 logs `blade nearly dead`. Raising sharpness re-arms both.
`POST /api/blade` logs `blade serviced` when raised and `blade wear simulated`
when lowered. `POST /api/reset` fits a new blade.

### SLAM

| Method | Path | Returns |
|---|---|---|
| GET | `/api/slam` | `model.RobotMap` — the occupancy map the ACTIVE BRAIN has built from its own noisy sensors (est-frame, drifts with the estimate; never ground truth). 404 until the brain publishes one. |

`cells` is row-major, `index = iy*cols + ix`, cell `(0,0)` covering the world
origin. Grid is 0.5 m, 96×72 cells (48×28 m — deliberately larger than the
garden, because the estimate can wander off the property; writes outside are
dropped). Legend:

| value | meaning | written when |
|---|---|---|
| `-1` | unknown | never observed |
| `0` | free | the chassis physically occupied the cell, **or** a range beam passed through it without returning |
| `1` | obstacle | a range beam terminated here, **or** a bumper fired towards it (marked 0.5 m ahead of the estimated centre) |

Within one update the order is swept-free → ray clearing (only ever promotes
`-1`→`0`, never erases an obstacle) → beam returns → bump contacts, so an
obstacle always wins the step it is seen in, and driving over a cell later
re-marks it free. Everything is in the ESTIMATE frame: when the pose estimate
drifts, previously mapped obstacles smear. That is honest, not a bug — it is
the point of showing this next to `status.pose`.

`est_pose` is the brain's current estimate and `trajectory` its recent track,
decimated to ~1 pose per sim-second and capped at 300. Brains republish every
~2 sim-seconds. The map is cleared when the brain is swapped (`POST
/api/brain`) or on `POST /api/reset` — a new algorithm starts with an empty
head — so expect a 404 again straight after either.

### Chat

There is NO chat endpoint on this server. Chat runs browser→colonies-server
directly: the user logs in with their own colony private key in the UI
(buildingai-style, persisted in IndexedDB), and the browser submits
`exec_query` processes signed with that key. The mower server never holds a
colony user key.

## WebSocket `/ws`

Server → client JSON messages, `{"type": ..., "data": ...}`:

| type | data | cadence |
|---|---|---|
| `status` | `model.RobotStatus` | ~5 Hz |
| `grass` | `{"cells":[[index,height_mm],...]}` | ~2 Hz, changed cells only |
| `world` | `model.World` | on obstacle add/remove |
| `log` | `model.LogEntry` | as logged |
| `event` | `{"kind":"stuck"|"unstuck"|"docked"|"mission_done"|"low_battery"|...,"msg":...}` | as they happen |
| `chat` | `{"chat_id":...,"role":"assistant"|"thinking"|"tool"|"status","text":...,"done":bool}` | during agent turns |

Client → server: nothing (commands go via REST). The socket may send pings;
reconnect with backoff and re-fetch `/api/grass` + `/api/world` on reconnect.
