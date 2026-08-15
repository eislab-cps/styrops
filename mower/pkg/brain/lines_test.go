package brain

// Tests for the stripe brain. They use a tiny self-contained kinematic robot
// rather than pkg/sim, so pkg/brain keeps no dependency on the simulator.

import (
	"math"
	"strings"
	"testing"

	"github.com/styrops/huskvarna-demo/pkg/model"
	"github.com/styrops/huskvarna-demo/pkg/sdk"
)

// rectRobot is a differential-drive mower inside an axis-aligned rectangle.
// It is deliberately minimal: exact kinematics, exact odometry, an exact
// compass and no GPS, so a failure here is the brain's fault and not noise.
type rectRobot struct {
	w, h     float64
	pose     model.Pose
	v, omega float64
	blade    bool
	state    model.RobotState
	t        float64
	mission  *model.Mission
	logs     []string
	visited  map[[2]int]bool
}

func newRectRobot(w, h float64) *rectRobot {
	return &rectRobot{
		w: w, h: h,
		pose:    model.Pose{X: w / 2, Y: h / 2, Theta: 0.3},
		mission: &model.Mission{ID: "m1", Kind: "mow"},
		visited: map[[2]int]bool{},
	}
}

// step integrates one control period and returns the sensor frame the brain
// will see next.
func (r *rectRobot) step(dt float64) model.SensorFrame {
	dth := r.omega * dt
	mid := r.pose.Theta + dth/2
	dc := r.v * dt
	nx, ny := r.pose.X+dc*math.Cos(mid), r.pose.Y+dc*math.Sin(mid)
	bump := model.Bump{}
	if nx < 0.35 || nx > r.w-0.35 || ny < 0.35 || ny > r.h-0.35 {
		bump.Front = true // hard wall well outside the wire, should never be hit
	} else {
		r.pose.X, r.pose.Y = nx, ny
	}
	r.pose.Theta = wrap(r.pose.Theta + dth)
	r.t += dt
	if r.blade {
		r.visited[[2]int{int(r.pose.X / 0.5), int(r.pose.Y / 0.5)}] = true
	}

	// Boundary wire: a rectangle inset 0.6 m, sensed 0.2 m ahead of the axle.
	const inset = 0.6
	fx := r.pose.X + wireSensorAhead*math.Cos(r.pose.Theta)
	fy := r.pose.Y + wireSensorAhead*math.Sin(r.pose.Theta)
	inside := fx > inset && fx < r.w-inset && fy > inset && fy < r.h-inset
	d := math.Min(math.Min(r.pose.X-inset, r.w-inset-r.pose.X),
		math.Min(r.pose.Y-inset, r.h-inset-r.pose.Y))
	near := nearestOnRect(r.pose.X, r.pose.Y, inset, r.w-inset, inset, r.h-inset)

	return model.SensorFrame{
		T:        r.t,
		Odometry: model.Odometry{DLeft: dc - dth*robotWheelBase/2, DRight: dc + dth*robotWheelBase/2},
		IMU:      model.IMU{YawRate: r.omega, Heading: r.pose.Theta},
		GPS:      model.GPS{Fix: false},
		Range:    beams(5),
		Bump:     bump,
		Wire: model.Wire{
			Inside:    inside,
			Strength:  1 / (0.2 + math.Abs(d)),
			Direction: wrap(math.Atan2(near[1]-r.pose.Y, near[0]-r.pose.X) - r.pose.Theta),
		},
		BladeCurrent: 0.9,
		Battery:      model.Battery{Percent: 80, Voltage: 20.9},
	}
}

func nearestOnRect(x, y, x0, x1, y0, y1 float64) [2]float64 {
	cx := math.Max(x0, math.Min(x1, x))
	cy := math.Max(y0, math.Min(y1, y))
	// Project onto whichever edge is closest.
	cands := [][2]float64{{x0, cy}, {x1, cy}, {cx, y0}, {cx, y1}}
	best, bd := cands[0], math.Inf(1)
	for _, c := range cands {
		if d := math.Hypot(c[0]-x, c[1]-y); d < bd {
			best, bd = c, d
		}
	}
	return best
}

const wireSensorAhead = 0.20 // must match pkg/sim's wire coil offset

func (r *rectRobot) Sensors() model.SensorFrame  { return r.step(0.1) }
func (r *rectRobot) Drive(v, omega float64)      { r.v, r.omega = v, omega }
func (r *rectRobot) Blade(on bool)               { r.blade = on }
func (r *rectRobot) SetCutHeight(float64)        {}
func (r *rectRobot) PublishPose(model.Pose)      {}
func (r *rectRobot) PublishMap(model.RobotMap)   {}
func (r *rectRobot) Mission() *model.Mission     { return r.mission }
func (r *rectRobot) SetState(s model.RobotState) { r.state = s }
func (r *rectRobot) Now() float64                { return r.t }
func (r *rectRobot) Log(_, _, msg string, _ map[string]any) {
	r.logs = append(r.logs, msg)
}

func (r *rectRobot) logged(sub string) bool {
	for _, l := range r.logs {
		if strings.Contains(l, sub) {
			return true
		}
	}
	return false
}

func TestLinesBrainIsRegisteredAndNotDefault(t *testing.T) {
	f, ok := sdk.Registry["lines"]
	if !ok {
		t.Fatal("brain \"lines\" not registered")
	}
	b := f()
	if b.Name() != "lines" {
		t.Errorf("Name() = %q", b.Name())
	}
	d := strings.ToLower(b.Description())
	if !strings.Contains(d, "stripe") {
		t.Errorf("description should mention the stripe pattern: %q", b.Description())
	}
	// The engine's default is "automower"; nothing here may change that.
	if sdk.Registry["automower"] == nil {
		t.Error("automower must remain registered as the default")
	}
}

func TestLinesBrainMowsSystematicStripes(t *testing.T) {
	b := sdk.Registry["lines"]()
	r := newRectRobot(20, 12)

	var headings []float64
	uturns := 0
	prevDir := 0
	for i := 0; i < 12000; i++ { // 20 minutes of sim time at 10 Hz
		b.Step(r, 0.1)
		if r.t > 250 && r.blade { // after the survey phase
			headings = append(headings, r.pose.Theta)
			dir := 0
			if math.Abs(wrap(r.pose.Theta)) < 0.6 {
				dir = 1
			} else if math.Abs(wrap(r.pose.Theta-math.Pi)) < 0.6 {
				dir = -1
			}
			if dir != 0 && prevDir != 0 && dir != prevDir {
				uturns++
			}
			if dir != 0 {
				prevDir = dir
			}
		}
	}

	if !r.logged("surveying the work area") {
		t.Errorf("brain never surveyed; logs = %v", r.logs)
	}
	if !r.logged("mowing in stripes") {
		t.Fatalf("brain never committed to a stripe pattern; logs = %v", r.logs)
	}
	if r.state != model.StateMowing {
		t.Errorf("state = %s, want mowing", r.state)
	}

	// The long axis of a 20x12 area is X, so rows must run roughly east-west
	// and the mower must reverse direction repeatedly.
	onAxis := 0
	for _, h := range headings {
		if math.Abs(wrap(h)) < 0.6 || math.Abs(wrap(h-math.Pi)) < 0.6 {
			onAxis++
		}
	}
	if frac := float64(onAxis) / float64(len(headings)); frac < 0.7 {
		t.Errorf("only %.0f%% of the time spent on the row axis, want >= 70%%", frac*100)
	}
	if uturns < 8 {
		t.Errorf("only %d U-turns in 20 sim-minutes, expected a sweep", uturns)
	}

	// And it must actually get around: coverage of the 0.5 m occupancy grid.
	cells := int((20 / 0.5) * (12 / 0.5))
	if got := float64(len(r.visited)) / float64(cells); got < 0.35 {
		t.Errorf("stripe pattern visited only %.0f%% of the area", got*100)
	}
	t.Logf("uturns=%d on-axis=%.0f%% visited=%d cells", uturns,
		100*float64(onAxis)/float64(len(headings)), len(r.visited))
}

func TestLinesBrainRejoinsThePatternAfterAnObstacle(t *testing.T) {
	b := sdk.Registry["lines"]()
	r := newRectRobot(20, 12)
	for i := 0; i < 4000; i++ { // settle into the pattern
		b.Step(r, 0.1)
	}
	if !r.logged("mowing in stripes") {
		t.Fatalf("never started striping; logs = %v", r.logs)
	}
	headingBefore := r.pose.Theta

	// One obstacle encounter: a close range hit for a couple of steps.
	m := b.(*mower)
	before := m.ln.lateral
	for i := 0; i < 3; i++ {
		m.linesAvoid(r, r.t, true)
		b.Step(r, 0.1)
	}
	if m.ln.lateral == before {
		t.Errorf("repeated obstacles on one stripe did not end the row")
	}
	for i := 0; i < 600; i++ { // 60 s to recover
		b.Step(r, 0.1)
	}
	// Back on an axis-aligned heading, one way or the other.
	h := r.pose.Theta
	if math.Abs(wrap(h)) > 0.6 && math.Abs(wrap(h-math.Pi)) > 0.6 {
		t.Errorf("mower did not rejoin the pattern: heading %.2f (was %.2f)", h, headingBefore)
	}
	if !r.blade {
		t.Errorf("blade off after an obstacle")
	}
}
