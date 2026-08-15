# huskvarna-demo

A robotic lawn mower with an AI you can talk to — built on
[ColonyOS](https://colonyos.io). One Go binary contains:

- a **2D garden simulation** (grass growth, weather, battery, physics) with a
  fancy **3D web UI** (three.js): drop obstacles onto the lawn, watch the
  mowed stripes appear, follow the robot's SLAM estimate vs its true pose;
- a **robot SDK** — mowing algorithms program against noisy sensors
  (odometry, range, bump, boundary wire, GPS, fake camera detections) and
  actuators only, and are swappable at runtime;
- a **ColonyOS executor** — the robot registers itself on the colony and
  advertises `tool_mower_*` functions;
- a **chat proxy** — the chat panel talks to the colony's agentic AI
  (routine `automower`, persona *Moa*), which operates the robot through
  those same colony functions. Ask it to mow, ask about the weather, ask why
  it's stuck.

## Run

```bash
make build
./bin/mower --no-colony     # simulator + UI only
# or, with the colony (executor + chat):
source <path-to-colonies-env> && ./bin/mower
```

Open http://localhost:9595.

## Docs

- `docs/ROBOT_API.md` — REST + WebSocket contract
- `pkg/sdk/sdk.go` — write your own mowing algorithm
- `CLAUDE.md` — architecture and project rules
