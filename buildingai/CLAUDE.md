# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Building simulation server with REST API and WebSocket-based session control. A Go binary embeds building floor plan data and a web viewer, exposing APIs for equipment management, navigation graph queries, and programmatic control of the map viewer. A built-in simulation keeps the building alive: people move between real rooms and the sensors respond.

## Build & Run

The Makefile is the primary build system:

```bash
make build       # Compile web sources + Go binary → ./bin/buildai
make run         # Build + start server on :9090
make run-edit    # Build + start with floor plan editing enabled (--edit)
make test        # go test ./... -race -count=1
make web         # Only compile web sources (web/src/ → web/index.html)
make clean       # Remove ./bin
```

Run a single test:
```bash
go test ./pkg/server/ -run TestEquipmentCRUD -v
```

## Architecture

### Request flow

HTTP/WS requests → Gin router (`pkg/server/server.go`) → handlers (`pkg/server/handlers/`) → in-memory store (`pkg/store/memory.go`). Session state changes are pushed to WebSocket clients via the hub (`pkg/server/websocket/hub.go`).

### Embedded assets

`embed.go` embeds `data/` (floor plans, equipment icons) and `web/` (compiled viewer) into the binary via `go:embed`. No external files needed at runtime.

### Web build pipeline

The web UI lives in `web/src/` as modular files. `cmd/build/main.go` compiles them into a single `web/index.html` by replacing `<include file="X"/>` tags with file contents. This compiled file is what gets embedded in the binary.

**Always edit files in `web/src/`, never `web/index.html` directly.** Run `make web` or `make build` to recompile. Files outside the include system (`web/styles.css`, `web/chat.mjs`) are edited directly.

### Key packages

- **`pkg/server/handlers/`** — REST handlers. `session.go` is the most complex: session lifecycle, viewport, highlights, occupancy, route, and coverage state, all pushed via WebSocket.
- **`pkg/store/memory.go`** — Thread-safe in-memory store (`sync.RWMutex`). Building data is read-only after startup; equipment and sessions are mutable.
- **`pkg/server/websocket/hub.go`** — Per-session WebSocket subscriptions, ping/pong keepalive, 1-hour auto-purge of inactive sessions.
- **`pkg/graph/`** — Dijkstra shortest path (`dijkstra.go`) and multi-floor graph construction (`multifloor.go`).
- **`pkg/livesim/`** — The living-building simulation (see below).
- **`pkg/model/`** — All data types. Equipment has Sensors and Actuators. Sessions hold viewport/highlight/occupancy/route/coverage state.

### Live simulation (`pkg/livesim/`)

A goroutine started by the server (opt-in: off by default, enable with
`--livesim=true`; the building otherwise starts empty so equipment and
occupancy belong to the REST API)
that makes the building *live*: ~60 simulated people follow a synthesized weekly
lecture/office schedule, walk between real rooms along the real multi-floor
walkable graph, and drive the sensor values other endpoints already serve.

- **Clock** — real elapsed time x `--livesim-speed` (default 60, so a day passes
  in 24 real minutes). Starts at 08:00 today, moved to Monday on a weekend.
- **`world.go`** — classifies floor-plan rooms by area (service / office /
  meeting / lecture / hall) and joins them to walkable-graph nodes.
- **`schedule.go`** — the weekly timetable and each person's day (arrival,
  lunch, departure), all derived deterministically from `--livesim-seed`.
- **`people.go`** — movement: `graph.ShortestPath` over the multi-floor graph,
  walking 1.3 units/simulated second.
- **`sensors.go`** — room CO2 and temperature physics, plus discovery of any
  sensor it can drive (yours as well as its own).
- Written through the store: `/api/occupancy` (keys `"level/room"`) and
  `/api/equipment` sensor values. Read via `/api/live/people` (floor-plan/PDF
  coordinates) and `/api/live/state`.

Full contract, coordinate space and flags: `docs/api/live.md`.

Tests live in `pkg/livesim/livesim_test.go` and run against the real embedded
A-building data; the endpoint tests are in `pkg/server/server_test.go`. Drive
the clock with `sim.AdvanceSim(d)` rather than starting the goroutine.

**Store invariant:** equipment records are published by pointer and serialised
by handlers *after* the store lock is released, so mutations must clone and
republish (`cloneEquipmentLocked` / `publishEquipmentLocked` in
`pkg/store/memory.go`) instead of mutating in place. Mutating in place races
with readers — `TestLiveSimulationConcurrentWithAPIReads` is the guard.

### MCP server

`mcp/server.py` exposes the REST API as MCP tools for Claude. See `mcp/README.md` for setup.

### Python scripts

`scripts/transform.py` extracts floor plans from PDFs. `scripts/build_graph.py` builds navigation graphs. These are offline data-preparation tools, not part of the runtime.

## REST API

Endpoints are grouped by resource: building, equipment, sensors, actuators, sessions, graph, icons. Sessions support WebSocket upgrade at `/ws/{session_id}` for real-time state push. Full endpoint documentation with curl examples is in `docs/api/`.

## Testing

API tests are in `pkg/server/server_test.go`. They use Go's standard `testing` + `httptest` against a fresh in-memory router per test. Coverage includes CRUD for all resources, concurrent access, edge cases, and error responses.

Simulation behaviour is tested in `pkg/livesim/livesim_test.go` against the real A-building floor plans (loaded from `../../data`), covering the schedule, movement along real graph edges, room physics and determinism.

## Git

Do NOT add Co-Authored-By lines for Claude in git commits.
