// Package sim implements the authoritative 2D world simulation.
// iface.go defines the Engine contract consumed by pkg/server (REST/WS) and
// pkg/executor (colony tools). The concrete engine lives in this package.
package sim

import "github.com/styrops/huskvarna-demo/pkg/model"

// BrainInfo describes a registered algorithm.
type BrainInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Active      bool   `json:"active"`
}

// LogFilter filters hardware log queries. Zero values = no filter.
type LogFilter struct {
	Level   string  // minimum level: debug|info|warn|error
	Source  string  // exact source match
	SinceT  float64 // sim time lower bound
	Minutes float64 // convenience: last N sim-minutes
	Limit   int     // max entries, newest kept (default 100)
}

// Event is pushed to subscribers for WS forwarding.
type Event struct {
	Type string `json:"type"` // status | grass | world | log | event
	Data any    `json:"data"`
}

// GrassDiff is the payload of a "grass" event: changed cells since last tick.
type GrassDiff struct {
	Cells [][2]float64 `json:"cells"` // [index, height_mm]
}

// Notice is the payload of an "event" event.
type Notice struct {
	Kind string `json:"kind"` // stuck | unstuck | docked | undocked | mission_done | low_battery | obstacle_added | error
	Msg  string `json:"msg"`
}

// Engine is the full simulator API. All methods are safe for concurrent use.
type Engine interface {
	// -- read side --
	World() model.World
	Grass() model.GrassGrid
	Status() model.RobotStatus
	Weather() model.Weather
	Logs(f LogFilter) []model.LogEntry
	Sensors() model.SensorFrame
	Brains() []BrainInfo
	Zones() []model.ZoneStats
	// SLAM returns the latest map published by the active brain via
	// sdk.Robot.PublishMap; ok=false if none has been published yet.
	SLAM() (model.RobotMap, bool)

	// -- mission control --
	StartMowing(zone string) error // zone "" = whole lawn
	StopMowing() error             // stop + idle in place, blade off
	Dock() error                   // head home to charger
	SetCutHeight(mm float64) error
	SetBrain(name string) error

	// -- world editing --
	AddObstacle(typ string, x, y float64) (model.Obstacle, error)
	RemoveObstacle(id string) error

	// -- manual override (suspends brain until Release) --
	ManualDrive(v, omega float64, bladeOn bool) error
	ManualRelease()

	// -- sim control --
	SetSpeed(mult float64) error // 0.5 .. 200
	Reset()                      // regrow grass, robot to dock, clear dropped obstacles

	// SetWeather overrides the generated weather with the given condition
	// (sunny|cloudy|rain|storm) for `hours` sim-hours (default 6 if <= 0),
	// after which the generator resumes. Forecast reflects the override.
	SetWeather(condition string, hours float64) error

	// GrowGrass adds mm (clamped to 5..40) to every lawn cell, capped at the
	// usual max height — a demo lever to give the mower work instantly.
	GrowGrass(mm float64) error

	// SetBladeSharpness sets blade wear directly (0..1; 1 = new blade) — the
	// demo lever for "wear the blade down" and "replace the blade".
	SetBladeSharpness(v float64) error

	// -- push --
	// Subscribe returns a channel of events (status ~5 Hz, grass diffs ~2 Hz,
	// log entries, notices, world on change). Slow consumers get dropped
	// events, never a blocked engine. Unsubscribe with the returned cancel.
	Subscribe() (<-chan Event, func())

	// Run starts the tick loop and blocks until ctx is done (call in goroutine
	// from main). Stop everything by cancelling.
	Run()
	Close()
}
