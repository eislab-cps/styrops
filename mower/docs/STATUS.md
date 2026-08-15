# Status / handoff — 2026-08-06

Live at https://mower.styrops.ai (k8s ns `styrops` on rocinante, chart in
`styrops/deployments/mower/`, image `registry.colonyos.io/colonyos/mower`).

## Contracts — do not break

- `docs/ROBOT_API.md` + `pkg/model` json tags = the REST/WS wire format.
- `pkg/sdk` = the only surface a mowing algorithm (Brain) may touch; brains
  never see ground truth.
- Colony functions `tool_mower_*` (`pkg/executor/executor.go`) = the agent
  contract; the routine/skill live in the `exec-tui` repo under `config/`
  (`routines/automower.md`, `skills/automower/SKILL.md`) — deploy those with
  `./bin/exec sync-config`, nothing else may live in the exec repos.
- No imports from the exec repos; colonies SDK via `replace` to `../colonies`.

## Deploy pipeline

`deployments/mower/build.sh` (host-build + docker push) → `update.sh` or
`kubectl rollout restart deployment/mower -n styrops`. Sim state resets on
restart. Secret `mower-colonies` provides COLONIES_* env.

## In flight (agent passes, 2026-08-06 evening)

- v4 visual pass on `web/js/`: photorealism push — CC0 photo textures
  vendored under `web/vendor/textures/` (PBR + PMREM env lighting),
  shell-textured "fur" grass (per-fiber look, mowing shortens fibers),
  trees rebuilt with branch skeletons + leaf-card canopies, outside-terrain
  removed (clean diorama base fading into sky).

## Landed today (deployed as v3)

- Full `web/js/` realism pass v3: tiered quality (SwiftShader vs GPU),
  Swedish villa, fence, dock model, instanced tufts, SLAM holographic
  overlay (off by default, SLAM toggle).
- `pkg/brain/lines.go` — systematic boustrophedon brain (not default);
  rate-limited duplicate warnings (`fields.repeats`) in the sim log buffer.
- Executor idle-log fix; server root-URL redirect-loop fix.

## Known rough edges

- Whole-lawn random-bounce needs ~6-8 sim-hours to 95% — demo with zone
  missions or 50x sim speed.
- Full `go test ./... -race` not re-run since the last two agent passes.
- Executor camera occlusion only models the house; chat thinking-stream
  depends on session-log envelope kinds (`think`/`tool`/`status`).
