# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project overview

Automower demo: a 2D lawn-mower robot simulator with a 3D web UI, packaged as
one Go binary that is also a ColonyOS executor. The user chats with the robot
in the UI; chat is answered by the colony's agentic AI (routine `automower`)
which operates the robot through `tool_mower_*` colony functions.

## Build & run

```bash
make build            # → bin/mower
./bin/mower --no-colony            # sim + UI only, http://localhost:9595
source <path to your colonies env file> && ./bin/mower
make test             # go test ./... -race
```

## Architecture

One process, four parts:

- `pkg/sim` — authoritative 2D simulation (50 Hz): world, grass grid, robot
  physics, noisy sensors, weather, hardware log. `sim/iface.go` is the Engine
  contract everything else consumes.
- `pkg/brain` + `pkg/sdk` — the robot SDK. Algorithms (`Brain`) see ONLY noisy
  `SensorFrame`s and actuator calls — never ground truth. Register via
  `sdk.Register`; swap live via `POST /api/brain`.
- `pkg/server` — gin REST + WebSocket push per `docs/ROBOT_API.md`; serves the
  embedded `web/` UI (three.js, vanilla ES modules, no build step).
- `pkg/executor` + `pkg/chat` — ColonyOS integration. The executor registers
  as `automower` (type `toolsexecutor`) and advertises `tool_mower_*`
  functions; the chat proxy submits `exec_query` processes and streams the
  session log. Browser never holds colony keys.

## Hard rules

- **No imports from the exec/agentic repos.** The only cross-project surface
  is the colony function contract (`tool_mower_*`) and the skill/routine
  files that live in `exec-tui/config/`. Colonies SDK comes from
  `github.com/styrops/colonies` (replace => `../colonies`).
- `pkg/model` types are the wire format for REST/WS; `docs/ROBOT_API.md` must
  be updated in the same commit as any change to them.
- Brains must stay ignorant of ground truth — anything they need must come
  through `sdk.Robot`.
- Web UI: plain ES modules served as-is; three.js is vendored in
  `web/vendor/` (no CDN).
