// Package sdk is the robot programming interface — the ONLY surface a mowing
// algorithm may touch. A Brain sees noisy sensors and issues actuator
// commands; it never sees ground-truth pose or the world map. Swap brains at
// runtime via POST /api/brain or the tool_mower_set_brain colony function.
package sdk

import "github.com/styrops/huskvarna-demo/pkg/model"

// Robot is handed to the Brain on every control step.
type Robot interface {
	// Sensors returns the current noisy sensor snapshot. Odometry deltas
	// accumulate between calls and reset on read.
	Sensors() model.SensorFrame

	// Drive sets target velocities: v in m/s (max ~0.6), omega in rad/s.
	// The sim applies acceleration limits and wheel slip.
	Drive(v, omega float64)

	// Blade switches the cutting disc on/off.
	Blade(on bool)

	// SetCutHeight sets blade height in mm (20-60).
	SetCutHeight(mm float64)

	// PublishPose lets a localization/SLAM brain publish its pose estimate.
	// Shown in the UI next to ground truth so estimation error is visible.
	PublishPose(p model.Pose)

	// PublishMap lets the brain publish the occupancy map it has built from
	// its own sensors (GET /api/slam, and the click-the-robot SLAM view).
	PublishMap(m model.RobotMap)

	// Log writes to the hardware log (visible to the UI, the agent, and
	// GET /api/logs). source: nav|motor|blade|battery|sensor|system.
	Log(level, source, msg string, fields map[string]any)

	// Mission returns the currently requested mission (nil = none). The
	// brain decides how to execute it; state transitions are reported via
	// SetState.
	Mission() *model.Mission

	// SetState reports the brain's high-level state to the platform
	// (mowing, docking, charging, stuck, idle...).
	SetState(s model.RobotState)

	// Now returns sim time in seconds.
	Now() float64
}

// Brain is a replaceable mowing algorithm. Step is called at 10 Hz sim time.
// Implementations must be stateful structs — construct fresh via its Factory.
type Brain interface {
	Name() string
	Description() string
	Step(r Robot, dt float64)
}

// Factory creates a fresh Brain instance (used when switching algorithms).
type Factory func() Brain

// Registry of available brains, populated by init() in brain packages.
var Registry = map[string]Factory{}

func Register(name string, f Factory) { Registry[name] = f }
