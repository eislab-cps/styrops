package sim

// robot.go — the sdk.Robot implementation handed to the active Brain.
//
// Every method here is called from inside the tick loop while e.mu is already
// held, so none of them lock. The Brain must not stash the Robot and call it
// from another goroutine; the SDK contract is "use it inside Step".

import (
	"math"

	"github.com/styrops/huskvarna-demo/pkg/model"
	"github.com/styrops/huskvarna-demo/pkg/sdk"
)

type robotAdapter struct{ e *engine }

// copyRobotMap deep-copies the variable-length parts so publisher and reader
// never share backing arrays.
func copyRobotMap(m model.RobotMap) *model.RobotMap {
	out := m
	out.Cells = append([]int8(nil), m.Cells...)
	out.Trajectory = append([]model.Pose(nil), m.Trajectory...)
	return &out
}

var _ sdk.Robot = (*robotAdapter)(nil)

func (r *robotAdapter) Sensors() model.SensorFrame {
	return r.e.sensorFrame(&r.e.odoBrain, &r.e.bumpBrain)
}

func (r *robotAdapter) Drive(v, omega float64) {
	if r.e.manual {
		return
	}
	r.e.cmdV = clamp(v, -maxV, maxV)
	r.e.cmdOmega = clamp(omega, -maxOmega, maxOmega)
}

func (r *robotAdapter) Blade(on bool) {
	if r.e.manual {
		return
	}
	if on == r.e.bladeOn {
		return
	}
	r.e.bladeOn = on
	state := "off"
	if on {
		state = "on"
	}
	r.e.logf("debug", "blade", "cutting disc "+state, r.stamp(nil))
}

func (r *robotAdapter) SetCutHeight(mm float64) {
	r.e.cutHeight = clamp(mm, 20, 60)
}

func (r *robotAdapter) PublishPose(p model.Pose) {
	p.Theta = angNorm(p.Theta)
	if math.IsNaN(p.X) || math.IsNaN(p.Y) || math.IsNaN(p.Theta) {
		return
	}
	r.e.estPose = &p
}

// PublishMap stores the brain's occupancy map. The engine keeps its own copy,
// so a brain is free to keep mutating the grid it published from.
func (r *robotAdapter) PublishMap(m model.RobotMap) {
	if m.Cols <= 0 || m.Rows <= 0 || len(m.Cells) != m.Cols*m.Rows {
		return // malformed; ignore rather than serve garbage on /api/slam
	}
	r.e.slam = copyRobotMap(m)
}

func (r *robotAdapter) Log(level, source, msg string, fields map[string]any) {
	switch level {
	case "debug", "info", "warn", "error":
	default:
		level = "info"
	}
	r.e.logf(level, source, msg, r.stamp(fields))
}

// stamp adds the brain's believed position to a log entry. Brains do not know
// where they are, only where they THINK they are, so entries are marked with
// the published estimate — falling back to ground truth before the first
// PublishPose.
func (r *robotAdapter) stamp(fields map[string]any) map[string]any {
	x, y := r.e.pose.X, r.e.pose.Y
	if r.e.estPose != nil {
		x, y = r.e.estPose.X, r.e.estPose.Y
	}
	return withXY(fields, x, y)
}

func (r *robotAdapter) Mission() *model.Mission {
	if r.e.mission == nil {
		return nil
	}
	m := *r.e.mission
	return &m
}

func (r *robotAdapter) SetState(s model.RobotState) {
	r.e.brainState = s
}

func (r *robotAdapter) Now() float64 { return r.e.simT }
