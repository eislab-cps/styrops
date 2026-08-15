package brain

// Unit tests for the brain package. They use a fake sdk.Robot rather than the
// real engine so that pkg/brain stays free of any dependency on pkg/sim; the
// full closed-loop behaviour (mowing, docking, stuck) is covered by the
// integration tests in pkg/sim.

import (
	"math"
	"testing"

	"github.com/styrops/huskvarna-demo/pkg/model"
	"github.com/styrops/huskvarna-demo/pkg/sdk"
)

func TestBothBrainsAreRegistered(t *testing.T) {
	for _, n := range []string{"automower", "spiral"} {
		f, ok := sdk.Registry[n]
		if !ok {
			t.Fatalf("brain %q not registered", n)
		}
		b := f()
		if b.Name() != n {
			t.Errorf("Name() = %q, want %q", b.Name(), n)
		}
		if len(b.Description()) < 20 {
			t.Errorf("brain %q has a thin description", n)
		}
		if b2 := f(); b2 == b {
			t.Errorf("factory for %q returned a shared instance", n)
		}
	}
}

// fakeRobot replays a scripted sensor stream and records commands.
type fakeRobot struct {
	t         float64
	frame     model.SensorFrame
	mission   *model.Mission
	v, omega  float64
	blade     bool
	state     model.RobotState
	est       *model.Pose
	logs      []string
	logLevels []string
	maps      int
	lastMap   model.RobotMap
}

func (r *fakeRobot) Sensors() model.SensorFrame  { return r.frame }
func (r *fakeRobot) Drive(v, omega float64)      { r.v, r.omega = v, omega }
func (r *fakeRobot) Blade(on bool)               { r.blade = on }
func (r *fakeRobot) SetCutHeight(float64)        {}
func (r *fakeRobot) PublishPose(p model.Pose)    { c := p; r.est = &c }
func (r *fakeRobot) PublishMap(m model.RobotMap) { r.maps++; r.lastMap = m }
func (r *fakeRobot) Mission() *model.Mission     { return r.mission }
func (r *fakeRobot) SetState(s model.RobotState) { r.state = s }
func (r *fakeRobot) Now() float64                { return r.t }
func (r *fakeRobot) Log(level, _, msg string, _ map[string]any) {
	r.logs = append(r.logs, msg)
	r.logLevels = append(r.logLevels, level)
}

func beams(d float64) []model.RangeBeam {
	out := make([]model.RangeBeam, 12)
	for i := range out {
		out[i] = model.RangeBeam{
			Angle: (-60 + float64(i)*120/11) * math.Pi / 180,
			Dist:  d,
			Hit:   d < 5,
		}
	}
	return out
}

// straight builds a "nothing wrong, keep going" frame.
func straight(t float64) model.SensorFrame {
	return model.SensorFrame{
		T:            t,
		Odometry:     model.Odometry{DLeft: 0.05, DRight: 0.05},
		IMU:          model.IMU{Heading: 0},
		GPS:          model.GPS{Pos: model.Vec2{X: 10, Y: 10}, Accuracy: 1.5, Fix: true},
		Range:        beams(5),
		Wire:         model.Wire{Inside: true, Strength: 1 / (0.2 + 4), Direction: math.Pi / 2},
		BladeCurrent: 0.9,
		Battery:      model.Battery{Percent: 80, Voltage: 20.9},
	}
}

func TestPoseEstimatorTracksAStraightLine(t *testing.T) {
	pe := NewPoseEstimator()
	// 4 m due east in 0.05 m steps, GPS agreeing.
	var p model.Pose
	for i := 0; i < 80; i++ {
		sf := straight(float64(i) * 0.1)
		sf.GPS.Pos = model.Vec2{X: float64(i) * 0.05, Y: 0}
		p = pe.Update(sf)
	}
	if math.Abs(p.X-3.95) > 0.3 {
		t.Errorf("x = %.2f, want ~3.95", p.X)
	}
	if math.Abs(p.Y) > 0.3 {
		t.Errorf("y = %.2f, want ~0", p.Y)
	}
	if math.Abs(wrap(p.Theta)) > 0.1 {
		t.Errorf("theta = %.2f, want ~0", p.Theta)
	}
	if math.Abs(pe.Travelled()-4.0) > 0.05 {
		t.Errorf("travelled = %.2f, want ~4.0", pe.Travelled())
	}
}

func TestPoseEstimatorTurnsWithTheWheels(t *testing.T) {
	pe := NewPoseEstimator()
	// Spin in place: right wheel forward, left wheel back, for pi/2 total.
	const step = 0.01 // m per wheel per update
	dth := 2 * step / robotWheelBase
	n := int(math.Round((math.Pi / 2) / dth))
	var p model.Pose
	for i := 0; i < n; i++ {
		sf := straight(float64(i) * 0.1)
		sf.Odometry = model.Odometry{DLeft: -step, DRight: step}
		sf.IMU.Heading = float64(i+1) * dth // compass agrees
		sf.GPS.Fix = false
		p = pe.Update(sf)
	}
	if math.Abs(wrap(p.Theta-math.Pi/2)) > 0.1 {
		t.Errorf("theta = %.3f, want ~%.3f", p.Theta, math.Pi/2)
	}
	if math.Hypot(p.X, p.Y) > 0.05 {
		t.Errorf("spinning in place moved the estimate to (%.2f,%.2f)", p.X, p.Y)
	}
}

func TestPoseEstimatorPullsHeadingTowardsTheCompass(t *testing.T) {
	pe := NewPoseEstimator()
	// Odometry says straight ahead, but the compass insists we point at 1 rad.
	for i := 0; i < 400; i++ {
		sf := straight(float64(i) * 0.1)
		sf.IMU.Heading = 1.0
		sf.GPS.Fix = false
		pe.Update(sf)
	}
	if math.Abs(pe.Pose().Theta-1.0) > 0.05 {
		t.Errorf("heading did not converge on the compass: %.3f", pe.Pose().Theta)
	}
}

func TestMowerIdlesWithoutAMission(t *testing.T) {
	b := sdk.Registry["automower"]()
	r := &fakeRobot{frame: straight(0)}
	for i := 0; i < 20; i++ {
		r.t = float64(i) * 0.1
		r.frame = straight(r.t)
		b.Step(r, 0.1)
	}
	if r.v != 0 || r.omega != 0 {
		t.Errorf("idle mower is driving: v=%.2f omega=%.2f", r.v, r.omega)
	}
	if r.blade {
		t.Errorf("idle mower has the blade running")
	}
	if r.state != model.StateIdle {
		t.Errorf("state = %s, want idle", r.state)
	}
	if r.est == nil {
		t.Errorf("brain never published a pose estimate")
	}
}

func TestMowerDrivesAndCutsOnAMowMission(t *testing.T) {
	b := sdk.Registry["automower"]()
	r := &fakeRobot{mission: &model.Mission{ID: "m1", Kind: "mow"}}
	for i := 0; i < 40; i++ {
		r.t = float64(i) * 0.1
		r.frame = straight(r.t)
		b.Step(r, 0.1)
	}
	if r.v <= 0.1 {
		t.Errorf("mower is not driving: v=%.2f", r.v)
	}
	if !r.blade {
		t.Errorf("blade is off while mowing")
	}
	if r.state != model.StateMowing {
		t.Errorf("state = %s, want mowing", r.state)
	}
}

func TestMowerBouncesOnBumpAndOnLeavingTheWorkArea(t *testing.T) {
	for _, tc := range []struct {
		name  string
		mutat func(*model.SensorFrame)
	}{
		{"bump", func(sf *model.SensorFrame) { sf.Bump = model.Bump{Front: true, Left: true} }},
		{"wire", func(sf *model.SensorFrame) { sf.Wire.Inside = false; sf.Wire.Strength = 1 / (0.2 + 0.3) }},
		{"range", func(sf *model.SensorFrame) { sf.Range = beams(0.2) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := sdk.Registry["automower"]()
			r := &fakeRobot{mission: &model.Mission{ID: "m1", Kind: "mow"}}
			for i := 0; i < 10; i++ { // get it moving forwards first
				r.t = float64(i) * 0.1
				r.frame = straight(r.t)
				b.Step(r, 0.1)
			}
			reversed, rotated := false, false
			for i := 10; i < 50; i++ {
				r.t = float64(i) * 0.1
				sf := straight(r.t)
				if i < 12 {
					tc.mutat(&sf)
				}
				r.frame = sf
				b.Step(r, 0.1)
				if r.v < -0.05 {
					reversed = true
				}
				if reversed && math.Abs(r.omega) > 0.5 {
					rotated = true
				}
			}
			if !reversed {
				t.Errorf("mower did not back off")
			}
			if !rotated {
				t.Errorf("mower did not turn away after backing off")
			}
		})
	}
}

func TestMowerGivesUpWhenWheelsReportNoTravel(t *testing.T) {
	b := sdk.Registry["automower"]()
	r := &fakeRobot{mission: &model.Mission{ID: "m1", Kind: "mow"}}
	everStuck, stoppedWhenStuck := false, true
	for i := 0; i < 400; i++ { // 40 sim-seconds
		r.t = float64(i) * 0.1
		sf := straight(r.t)
		sf.Odometry = model.Odometry{} // wedged: wheels turn, mower does not move
		sf.Bump = model.Bump{Front: true}
		r.frame = sf
		b.Step(r, 0.1)
		if r.state == model.StateStuck {
			everStuck = true
			if r.v != 0 || r.blade {
				stoppedWhenStuck = false
			}
		}
	}
	if !everStuck {
		t.Errorf("brain never reported StateStuck (last state %s)", r.state)
	}
	if !stoppedWhenStuck {
		t.Errorf("brain kept driving or cutting while reporting stuck")
	}
	gaveUp := false
	for i, lvl := range r.logLevels {
		if lvl == "error" {
			gaveUp = true
			t.Logf("error log: %s", r.logs[i])
		}
	}
	if !gaveUp {
		t.Errorf("brain never logged an error; logs = %v", r.logs)
	}
}

func TestMowerParksAndUndocksOnTheCharger(t *testing.T) {
	b := sdk.Registry["automower"]()
	r := &fakeRobot{}
	// Sitting on the charger, half full, nothing to do: stay put.
	for i := 0; i < 10; i++ {
		r.t = float64(i) * 0.1
		sf := straight(r.t)
		sf.Battery = model.Battery{Percent: 50, Charging: true}
		r.frame = sf
		b.Step(r, 0.1)
	}
	if r.v != 0 || r.state != model.StateCharging {
		t.Errorf("charging mower: v=%.2f state=%s", r.v, r.state)
	}
	// Full, with a mow mission waiting: it must back out of the dock.
	r.mission = &model.Mission{ID: "m1", Kind: "mow"}
	reversed := false
	for i := 10; i < 60; i++ {
		r.t = float64(i) * 0.1
		sf := straight(r.t)
		sf.Battery = model.Battery{Percent: 100, Charging: i < 12}
		r.frame = sf
		b.Step(r, 0.1)
		if r.v < -0.1 {
			reversed = true
		}
	}
	if !reversed {
		t.Errorf("mower never backed out of the dock")
	}
}

func TestSpiralBrainSpiralsInTallGrass(t *testing.T) {
	b := sdk.Registry["spiral"]()
	r := &fakeRobot{mission: &model.Mission{ID: "m1", Kind: "mow"}}
	// Settle the blade-current baseline on short grass.
	for i := 0; i < 300; i++ {
		r.t = float64(i) * 0.1
		r.frame = straight(r.t)
		b.Step(r, 0.1)
	}
	if math.Abs(r.omega) > 0.1 {
		t.Fatalf("spiral brain is turning on short grass: omega=%.2f", r.omega)
	}
	// Now drive into a tall patch: blade current jumps.
	turning := 0
	for i := 300; i < 400; i++ {
		r.t = float64(i) * 0.1
		sf := straight(r.t)
		sf.BladeCurrent = 2.0
		r.frame = sf
		b.Step(r, 0.1)
		if math.Abs(r.omega) > 0.1 {
			turning++
		}
	}
	if turning < 20 {
		t.Errorf("spiral brain did not spiral in tall grass (%d turning steps)", turning)
	}
	if !r.blade {
		t.Errorf("blade off while spiral cutting")
	}
}

func TestHelpers(t *testing.T) {
	if d := wireDist(1 / (0.2 + 1.3)); math.Abs(d-1.3) > 1e-9 {
		t.Errorf("wireDist = %v, want 1.3", d)
	}
	if !math.IsInf(wireDist(0), 1) {
		t.Errorf("wireDist(0) should be +Inf")
	}
	c := model.CameraHint{Objects: []model.DetectedObject{
		{Label: "dock", Dist: 3},
		{Label: "tree", Dist: 1},
		{Label: "dock", Dist: 1.2},
	}}
	o, ok := findObject(c, "dock")
	if !ok || o.Dist != 1.2 {
		t.Errorf("findObject picked %+v", o)
	}
	if _, ok := findObject(c, "hedgehog"); ok {
		t.Errorf("findObject invented a hedgehog")
	}
	if d, a, ok := nearestBeam(beams(2.5), 0.6); !ok || math.Abs(d-2.5) > 1e-9 || math.Abs(a) > 1.1 {
		t.Errorf("nearestBeam = %v %v %v", d, a, ok)
	}
	if _, _, ok := nearestBeam(beams(5), 0.6); ok {
		t.Errorf("nearestBeam reported a hit for beams that did not hit")
	}
	if got := clamp(5, 0, 1); got != 1 {
		t.Errorf("clamp = %v", got)
	}
	if got := wrap(3 * math.Pi); math.Abs(got-math.Pi) > 1e-9 {
		t.Errorf("wrap(3pi) = %v", got)
	}
}

// ---- occupancy map ----

func mapAt(m model.RobotMap, x, y float64) int8 {
	ix, iy := int(x/m.Cell), int(y/m.Cell)
	if ix < 0 || iy < 0 || ix >= m.Cols || iy >= m.Rows {
		return -9
	}
	return m.Cells[iy*m.Cols+ix]
}

// beamsToWall models a real static wall at world x = wallX, seen from robotX
// heading east. A wall that stays put is what makes the map converge; a
// synthetic "always 2 m ahead" return would paint a trail of ghosts.
func beamsToWall(robotX, wallX float64) []model.RangeBeam {
	out := make([]model.RangeBeam, 12)
	for i := range out {
		a := (-60 + float64(i)*120/11) * math.Pi / 180
		d := (wallX - robotX) / math.Cos(a)
		if d < 5 {
			out[i] = model.RangeBeam{Angle: a, Dist: d, Hit: true}
			continue
		}
		out[i] = model.RangeBeam{Angle: a, Dist: 5, Hit: false}
	}
	return out
}

func TestEstimatorMapMarksSweptPathFreeAndBeamHitsAsObstacle(t *testing.T) {
	pe := NewPoseEstimator()
	m0 := pe.Map()
	if m0.Cell != 0.5 || m0.Cols*m0.Rows != len(m0.Cells) {
		t.Fatalf("map shape: %dx%d cell=%v cells=%d", m0.Cols, m0.Rows, m0.Cell, len(m0.Cells))
	}
	for _, c := range m0.Cells {
		if c != -1 {
			t.Fatalf("a fresh map must be entirely unknown, found %d", c)
		}
	}

	// Drive due east from (10,10) for 4 m towards a wall at x = 16.3. No GPS,
	// so the estimate frame lines up with truth and the assertions can be
	// about specific cells.
	pe.p = model.Pose{X: 10, Y: 10, Theta: 0}
	pe.init = true
	for i := 0; i < 80; i++ {
		sf := straight(float64(i) * 0.1)
		sf.GPS.Fix = false
		sf.IMU.Heading = 0
		sf.Range = beamsToWall(pe.Pose().X, 16.3)
		pe.Update(sf)
	}
	m := pe.Map()
	if math.Abs(m.EstPose.X-14) > 0.1 {
		t.Fatalf("estimate ended at x=%.2f, expected ~14", m.EstPose.X)
	}

	// Cells the chassis physically swept are free.
	for _, x := range []float64{10.2, 11.5, 12.5, 13.5} {
		if got := mapAt(m, x, 10); got != 0 {
			t.Errorf("cell (%.1f,10) on the driven path = %d, want 0 (free)", x, got)
		}
	}
	// The wall the beams kept terminating on is an obstacle.
	if got := mapAt(m, 16.4, 10.1); got != 1 {
		t.Errorf("cell on the wall = %d, want 1 (obstacle)", got)
	}
	// Space the beams crossed on the way there was cleared to free.
	if got := mapAt(m, 15.0, 10.0); got != 0 {
		t.Errorf("cell between mower and wall = %d, want 0 (free)", got)
	}
	// Nothing was invented behind the mower, where no beam ever pointed.
	if got := mapAt(m, 9.0, 14.0); got != -1 {
		t.Errorf("never-observed cell = %d, want -1 (unknown)", got)
	}
	// Trajectory is decimated to about one pose per sim-second and capped.
	if n := len(m.Trajectory); n < 6 || n > 12 {
		t.Errorf("trajectory has %d poses for 8 sim-seconds, want ~8", n)
	}
	if m.T <= 0 {
		t.Errorf("map timestamp = %v", m.T)
	}
}

func TestEstimatorMapMarksBumpContactsAsObstacle(t *testing.T) {
	pe := NewPoseEstimator()
	pe.p = model.Pose{X: 20, Y: 12, Theta: 0}
	pe.init = true
	sf := straight(1)
	sf.GPS.Fix = false
	sf.IMU.Heading = 0
	sf.Odometry = model.Odometry{}
	sf.Range = beams(5) // no returns at all
	sf.Bump = model.Bump{Front: true}
	pe.Update(sf)

	m := pe.Map()
	if got := mapAt(m, 20+bumpMarkDist, 12); got != 1 {
		t.Errorf("cell at the front bumper = %d, want 1 (obstacle)", got)
	}
	if got := mapAt(m, 20, 12); got != 0 {
		t.Errorf("the mower's own cell = %d, want 0 (free)", got)
	}
}

func TestEstimatorMapDropsWritesOutsideTheGrid(t *testing.T) {
	pe := NewPoseEstimator()
	pe.p = model.Pose{X: -5, Y: 200, Theta: 0} // estimate has wandered off world
	pe.init = true
	sf := straight(1)
	sf.GPS.Fix = false
	sf.Range = beams(1.0)
	pe.Update(sf) // must not panic or corrupt memory
	for _, c := range pe.Map().Cells {
		if c != -1 {
			t.Fatalf("off-grid writes leaked into the map")
		}
	}
}

func TestAllBrainsPublishTheirMap(t *testing.T) {
	for _, name := range []string{"automower", "spiral", "lines"} {
		b := sdk.Registry[name]()
		r := &fakeRobot{mission: &model.Mission{ID: "m1", Kind: "mow"}}
		for i := 0; i < 200; i++ { // 20 sim-seconds
			r.t = float64(i) * 0.1
			r.frame = straight(r.t)
			b.Step(r, 0.1)
		}
		// ~2 s cadence over 20 s.
		if r.maps < 8 || r.maps > 12 {
			t.Errorf("%s published %d maps in 20 sim-seconds, want ~10", name, r.maps)
		}
		if r.lastMap.Cols == 0 || len(r.lastMap.Cells) == 0 {
			t.Errorf("%s published an empty map", name)
		}
	}
}
