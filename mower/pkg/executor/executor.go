// Package executor makes the robot a first-class ColonyOS executor: it
// registers itself on the colony under the name "automower" and advertises
// tool_mower_* functions that the colony's agentic AI discovers via the
// function registry. This is the ONLY colony-facing surface of the robot —
// the agent and the robot share no code, just these function contracts.
package executor

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/styrops/colonies/pkg/client"
	"github.com/styrops/colonies/pkg/core"
	"github.com/styrops/colonies/pkg/security/crypto"

	"github.com/styrops/huskvarna-demo/pkg/model"
	"github.com/styrops/huskvarna-demo/pkg/sim"
)

const ExecutorType = "toolsexecutor"

// Config comes from the standard COLONIES_* env (see cmd/mower/main.go).
type Config struct {
	ServerHost   string
	ServerPort   int
	Insecure     bool // true = plain http to the colonies server
	ColonyName   string
	ColonyPrvKey string // required to register the executor
	Name         string // executor name on the colony, default "automower"
	Location     string
}

type Executor struct {
	cfg    Config
	client *client.ColoniesClient
	prvKey string
	engine sim.Engine
	stop   chan struct{}
}

type toolSpec struct {
	desc string
	args []*core.FunctionArg
}

func arg(name, typ, desc string, required bool) *core.FunctionArg {
	return &core.FunctionArg{Name: name, Type: typ, Description: desc, Required: required}
}

// toolSpecs: the descriptions ARE the agent-facing contract — the LLM decides
// when to call a tool purely from this text.
func toolSpecs() map[string]toolSpec {
	return map[string]toolSpec{
		"tool_mower_get_status": {
			desc: "Get the mower's full live status: state (idle/mowing/docking/charging/stuck/manual), battery, blade on/off, cutting height and blade_sharpness (1.0 = new, below ~0.4 = worn — a dull blade cuts ragged and draws extra current; recommend replacement), active mission with progress, lawn coverage (overall and per zone), active algorithm, current weather and sim time. Call this FIRST for almost any question about the robot.",
		},
		"tool_mower_start_mowing": {
			desc: "Start a mowing mission. Optionally restrict to a named zone (see tool_mower_get_status coverage for zone names, e.g. 'front lawn', 'back lawn'). The robot mows, recharges itself when needed, and continues until the zone is done.",
			args: []*core.FunctionArg{arg("zone", "string", "Zone name to mow; omit or empty = whole lawn", false)},
		},
		"tool_mower_stop": {
			desc: "Stop the current mission immediately: blade off, robot idles in place. Use when the user asks to stop, pause, or halt.",
		},
		"tool_mower_dock": {
			desc: "Send the robot back to its charging station. Use when the user asks it to go home, charge, or park.",
		},
		"tool_mower_get_weather": {
			desc: "Get the local garden weather: current conditions plus a 72-hour forecast in 3-hour periods (condition, temperature, rain probability). Use to answer weather questions and to decide whether mowing now is sensible (wet grass cuts poorly and stresses the blade motor).",
		},
		"tool_mower_get_logs": {
			desc: "Read the robot's hardware log (motor, blade, battery, navigation, sensor and system events). Entries carry x/y coordinates in their fields — correlate event positions with the garden layout from tool_mower_get_world to find WHERE problems cluster (e.g. repeated collisions near one obstacle) and propose concrete improvements. Essential for diagnosing: why it stopped, where it got stuck, blade overload, charging issues.",
			args: []*core.FunctionArg{
				arg("minutes", "number", "Only entries from the last N sim-minutes (default 60)", false),
				arg("level", "string", "Minimum level: debug, info, warn or error", false),
				arg("source", "string", "Filter by source: motor, blade, battery, nav, sensor, system", false),
				arg("limit", "number", "Max entries (default 50, newest kept)", false),
			},
		},
		"tool_mower_get_coverage": {
			desc: "Detailed cut-quality report: overall and per-zone cut percentage, average and max grass height. Use to answer 'is it done?', 'which parts are missed?', 'is the lawn well cut?'.",
		},
		"tool_mower_get_world": {
			desc: "Describe the garden: lawn zones with sizes, charging dock position, and all obstacles including ones the user dropped in (type and position). Use for questions about the garden layout or obstacles.",
		},
		"tool_mower_get_sensors": {
			desc: "Live sensor snapshot: camera object detections (with labels), range beams, bump switches, boundary-wire signal, blade motor current, GPS, battery. Use for 'what do you see?', 'what is in front of you?'.",
		},
		"tool_mower_set_cut_height": {
			desc: "Set the cutting height in millimeters (20-60). Higher is gentler for wet or long grass.",
			args: []*core.FunctionArg{arg("mm", "number", "Cutting height in mm, 20-60", true)},
		},
		"tool_mower_set_brain": {
			desc: "Switch the active mowing algorithm. Use tool_mower_list_brains to see what is available.",
			args: []*core.FunctionArg{arg("name", "string", "Algorithm name", true)},
		},
		"tool_mower_list_brains": {
			desc: "List the available mowing algorithms (name, description, which one is active). The robot's control software is pluggable.",
		},
	}
}

func New(cfg Config, engine sim.Engine) (*Executor, error) {
	if cfg.Name == "" {
		cfg.Name = "automower"
	}
	if cfg.ColonyPrvKey == "" {
		return nil, fmt.Errorf("COLONIES_COLONY_PRVKEY is required to register the executor")
	}

	c := client.CreateColoniesClient(cfg.ServerHost, cfg.ServerPort, cfg.Insecure, true)

	cr := crypto.CreateCrypto()
	prvKey, err := cr.GeneratePrivateKey()
	if err != nil {
		return nil, err
	}
	id, err := cr.GenerateID(prvKey)
	if err != nil {
		return nil, err
	}

	ex := core.CreateExecutor(id, ExecutorType, cfg.Name, cfg.ColonyName, time.Now(), time.Now())
	ex.LocationName = cfg.Location
	if _, err := c.AddExecutor(ex, cfg.ColonyPrvKey); err != nil {
		return nil, fmt.Errorf("add executor: %w", err)
	}
	if err := c.ApproveExecutor(cfg.ColonyName, cfg.Name, cfg.ColonyPrvKey); err != nil {
		return nil, fmt.Errorf("approve executor: %w", err)
	}

	for name, spec := range toolSpecs() {
		f := core.CreateFunctionWithDesc(cfg.Name, ExecutorType, cfg.ColonyName, name, spec.desc, spec.args)
		if _, err := c.AddFunction(f, prvKey); err != nil {
			return nil, fmt.Errorf("register %s: %w", name, err)
		}
	}

	slog.Info("colony executor registered", "name", cfg.Name, "colony", cfg.ColonyName, "tools", len(toolSpecs()))
	return &Executor{cfg: cfg, client: c, prvKey: prvKey, engine: engine, stop: make(chan struct{})}, nil
}

// Serve blocks, pulling assigned processes until Close.
func (e *Executor) Serve() {
	for {
		select {
		case <-e.stop:
			return
		default:
		}
		process, err := e.client.Assign(e.cfg.ColonyName, 10, "", "", e.prvKey)
		if err != nil {
			// "No process available" and timeouts are the idle path;
			// real errors get a logged backoff.
			msg := strings.ToLower(err.Error())
			if !strings.Contains(msg, "timeout") && !strings.Contains(msg, "no process available") {
				slog.Warn("assign failed", "err", err)
				time.Sleep(2 * time.Second)
			}
			continue
		}
		out := e.dispatch(process.FunctionSpec.FuncName, process.FunctionSpec.KwArgs)
		if err := e.client.CloseWithOutput(process.ID, []interface{}{out}, e.prvKey); err != nil {
			slog.Warn("close process failed", "err", err)
		}
	}
}

func (e *Executor) Close() { close(e.stop) }

// dispatch returns a JSON string; errors are returned as {"error": ...} output
// (never a failed process) so the LLM can read and recover.
func (e *Executor) dispatch(funcName string, kwargs map[string]interface{}) string {
	res, err := e.call(funcName, kwargs)
	if err != nil {
		b, _ := json.Marshal(map[string]string{"error": err.Error()})
		return string(b)
	}
	b, err := json.Marshal(res)
	if err != nil {
		return `{"error":"marshal failed"}`
	}
	return string(b)
}

func (e *Executor) call(funcName string, kw map[string]interface{}) (any, error) {
	str := func(key string) string { s, _ := kw[key].(string); return s }
	num := func(key string, def float64) float64 {
		if v, ok := kw[key].(float64); ok {
			return v
		}
		return def
	}

	switch funcName {
	case "tool_mower_get_status":
		return e.engine.Status(), nil

	case "tool_mower_start_mowing":
		zone := str("zone")
		if err := e.engine.StartMowing(zone); err != nil {
			return nil, err
		}
		return map[string]string{"result": "mowing started", "zone": zone}, nil

	case "tool_mower_stop":
		if err := e.engine.StopMowing(); err != nil {
			return nil, err
		}
		return map[string]string{"result": "stopped, blade off"}, nil

	case "tool_mower_dock":
		if err := e.engine.Dock(); err != nil {
			return nil, err
		}
		return map[string]string{"result": "heading to charging station"}, nil

	case "tool_mower_get_weather":
		return e.engine.Weather(), nil

	case "tool_mower_get_logs":
		f := sim.LogFilter{
			Minutes: num("minutes", 60),
			Level:   str("level"),
			Source:  str("source"),
			Limit:   int(num("limit", 50)),
		}
		return e.engine.Logs(f), nil

	case "tool_mower_get_coverage":
		return map[string]any{
			"overall": e.engine.Status().Coverage,
			"zones":   e.engine.Zones(),
		}, nil

	case "tool_mower_get_world":
		w := e.engine.World()
		return summarizeWorld(w), nil

	case "tool_mower_get_sensors":
		return e.engine.Sensors(), nil

	case "tool_mower_set_cut_height":
		mm := num("mm", 0)
		if err := e.engine.SetCutHeight(mm); err != nil {
			return nil, err
		}
		return map[string]any{"result": "cut height set", "mm": mm}, nil

	case "tool_mower_set_brain":
		name := str("name")
		if err := e.engine.SetBrain(name); err != nil {
			return nil, err
		}
		return map[string]string{"result": "algorithm switched", "brain": name}, nil

	case "tool_mower_list_brains":
		return e.engine.Brains(), nil

	default:
		return nil, fmt.Errorf("unknown tool: %s", funcName)
	}
}

// summarizeWorld keeps the world payload LLM-sized: zones with areas,
// obstacles, dock — not every polygon vertex.
func summarizeWorld(w model.World) map[string]any {
	zones := make([]map[string]any, 0, len(w.Zones))
	for _, z := range w.Zones {
		zones = append(zones, map[string]any{
			"name":    z.Name,
			"area_m2": polyArea(z.Area),
		})
	}
	obstacles := make([]map[string]any, 0, len(w.Obstacles))
	for _, o := range w.Obstacles {
		obstacles = append(obstacles, map[string]any{
			"type": o.Type, "x": o.Pos.X, "y": o.Pos.Y,
			"radius": o.Radius, "user_dropped": o.Dropped,
		})
	}
	return map[string]any{
		"garden_m":  fmt.Sprintf("%.0fx%.0f", w.Width, w.Height),
		"zones":     zones,
		"dock":      w.Dock.Pos,
		"obstacles": obstacles,
	}
}

func polyArea(p model.Polygon) float64 {
	if len(p) < 3 {
		return 0
	}
	a := 0.0
	for i := range p {
		j := (i + 1) % len(p)
		a += p[i].X*p[j].Y - p[j].X*p[i].Y
	}
	if a < 0 {
		a = -a
	}
	return a / 2
}
