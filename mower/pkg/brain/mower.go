package brain

// mower.go — the shared body of both shipped algorithms.
//
// Both brains are the same machine with one switch flipped: "automower" is the
// faithful random-bounce mower, "spiral" adds Husqvarna's spiral-cutting
// behaviour on top. Everything below runs on NOISY sensors only — no map, no
// ground-truth pose.
//
// Conventions used throughout (they match pkg/sim/sensors.go):
//
//	bearing/angle: robot-relative radians, 0 = ahead, + = LEFT, - = RIGHT
//	Wire.Direction: bearing to the nearest point of the energised boundary
//	Wire.Strength : 1/(0.2 + distance), so distance = 1/Strength - 0.2
//	Wire.Inside   : the wire coil (0.2 m ahead of the axle) is inside the
//	                current WORK AREA — the whole lawn normally, or the target
//	                zone while a zone mow mission is running.
//
// Docking: seek the wire, then follow it with the WIRE ON THE LEFT
// (Direction ~ +pi/2, positive omega steers towards it). That circulation
// direction takes the mower down the wire spur that ends at the charging
// station, so it arrives from the south facing the dock's approach heading.
// The camera's "dock" label drives the last 1.5 m.
//
// Mission end: when a mow mission reaches 95% the ENGINE clears it. A brain
// therefore sees Mission() flip from a nearly-complete mow mission to nil —
// that is its cue to drive home and park (see missionEnded below). A user
// StopMowing also clears the mission, but with low progress, and then the
// correct behaviour is to idle in place.

import (
	"math"
	"math/rand"

	"github.com/styrops/huskvarna-demo/pkg/model"
	"github.com/styrops/huskvarna-demo/pkg/sdk"
)

// pattern selects how a brain covers ground once it is inside its work area.
// Everything else — docking, undocking, stuck handling, zone transit — is
// shared.
type pattern int

const (
	patternBounce pattern = iota // random bounce, like a real Husqvarna
	patternSpiral                // random bounce + spiral cutting in tall grass
	patternLines                 // systematic boustrophedon stripes
)

type mode int

const (
	modeIdle mode = iota
	modeMow
	modeSeekWire
	modeFollowWire
	modeDockApproach
	modeUndock
)

// Tunables, all in SI units / sim seconds.
const (
	mowSpeed      = 0.50 // m/s cruising with the blade down
	transitSpeed  = 0.45 // m/s crossing the lawn towards a zone
	wireSpeed     = 0.35 // m/s following the boundary wire
	dockSpeed     = 0.18 // m/s final approach
	dockSightDist = 1.6  // m; commit to the dock only from this close
	rangeStopDist = 0.35 // m; back off before actually hitting things
	wireStandoff  = 0.25 // m; distance kept from the wire while following
	dockBattery   = 20.0 // % below which the mower goes home on its own
	escapeLimit   = 3    // wiggle attempts before declaring itself stuck

	// How often the brain hands its SLAM map to the platform, sim seconds.
	mapPublishPeriod = 2.0
)

type mower struct {
	name    string
	desc    string
	pattern pattern
	rnd     *rand.Rand
	pe      *PoseEstimator
	mode    mode
	started bool

	// bounce / escape manoeuvre: phase 1 = reverse, 2 = rotate, 0 = none
	phase    int
	phaseEnd float64
	rotOmega float64
	rotDur   float64

	// brain-side progress watchdog (the engine has its own safety layer)
	winStart float64
	winTrav  float64
	winCmd   float64
	escapes  int
	gaveUp   bool
	gaveUpAt float64
	lastCmdV float64

	// docking
	undockEnd    float64
	followSince  float64
	lastDockSeen float64
	dockCool     float64 // do not re-commit to a failed dock approach at once
	transitBlind float64 // drive straight until this time when crossing to a zone
	outsideSince float64 // sim time the wire sensor first read "outside", 0 = inside
	wireD        float64
	wireDRate    float64
	haveWireD    bool

	lastMapPub float64 // sim time of the last PublishMap

	// mission bookkeeping
	lastMissionID string
	lastProgress  float64
	goHome        bool

	// spiral cutting
	spiralOn     bool
	spiralR      float64
	spiralEnd    float64
	spiralCool   float64
	spiralEntryA float64
	bladeEMA     float64
	haveEMA      bool

	// stripe mowing (patternLines)
	ln lineState
}

func newMower(name, desc string, p pattern, seed int64) *mower {
	return &mower{
		name:    name,
		desc:    desc,
		pattern: p,
		rnd:     rand.New(rand.NewSource(seed)),
		pe:      NewPoseEstimator(),
	}
}

func (b *mower) Name() string        { return b.name }
func (b *mower) Description() string { return b.desc }

func (b *mower) Step(r sdk.Robot, dt float64) {
	sf := r.Sensors()
	r.PublishPose(b.pe.Update(sf))
	now := r.Now()
	// The occupancy map the estimator has been accumulating, published a few
	// times a sim-minute — it is a few kB, and nothing downstream needs it at
	// control rate.
	if now-b.lastMapPub >= mapPublishPeriod {
		b.lastMapPub = now
		r.PublishMap(b.pe.Map())
	}
	if !b.started {
		b.started = true
		b.winStart, b.winTrav = now, b.pe.Travelled()
	}
	m := r.Mission()
	b.trackMission(r, m)

	// 1. Leaving the charger takes priority over everything else.
	if b.mode == modeUndock {
		b.undock(r, now)
		return
	}

	// 2. Sitting on the charger.
	if sf.Battery.Charging {
		b.park(r, sf, m, now)
		return
	}

	// 3. Decide what we are doing.
	wantDock := b.goHome || sf.Battery.Percent < dockBattery
	if m != nil && m.Kind == "dock" {
		wantDock = true
	}
	if m == nil && !wantDock {
		b.mode = modeIdle
		b.idle(r)
		return
	}

	b.watchdog(r, now)
	if b.gaveUp {
		r.SetState(model.StateStuck)
		b.drive(r, 0, 0)
		r.Blade(false)
		if now-b.gaveUpAt > 20 { // try again every 20 s; a hand may have freed us
			b.gaveUp = false
			b.escapes = 0
		}
		return
	}

	if wantDock {
		switch b.mode {
		case modeSeekWire, modeFollowWire, modeDockApproach:
		default:
			b.mode = modeSeekWire
			b.resetManeuver()
			r.Log("info", "nav", "returning to the charging station", map[string]any{
				"battery": sf.Battery.Percent,
			})
		}
	} else if b.mode != modeMow {
		b.mode = modeMow
		b.resetManeuver()
	}

	// 4. Finish any manoeuvre already in flight.
	if b.phase != 0 {
		if b.mode == modeMow {
			r.SetState(model.StateMowing)
			r.Blade(true)
		} else {
			r.SetState(model.StateDocking)
			r.Blade(false)
		}
		if b.runManeuver(r, now) {
			return
		}
	}

	switch b.mode {
	case modeMow:
		b.doMow(r, sf, now, dt)
	case modeSeekWire:
		b.doSeekWire(r, sf, now)
	case modeFollowWire:
		b.doFollowWire(r, sf, now, dt)
	case modeDockApproach:
		b.doDockApproach(r, sf, now)
	default:
		b.idle(r)
	}
}

// trackMission notices the engine closing a mow mission out at >=95% (the
// mission simply disappears with its progress near 1) and turns that into
// "drive home and park". A user StopMowing clears the mission too, but with
// low progress, and then we just idle.
func (b *mower) trackMission(r sdk.Robot, m *model.Mission) {
	if m != nil {
		if m.ID != b.lastMissionID {
			b.lastMissionID = m.ID
			b.goHome = false
		}
		b.lastProgress = m.Progress
		return
	}
	if b.lastMissionID == "" {
		return
	}
	finished := b.lastProgress >= 0.94
	b.lastMissionID, b.lastProgress = "", 0
	if finished {
		b.goHome = true
		r.Log("info", "nav", "lawn is cut, returning to the charging station", nil)
	}
}

// ----------------------------------------------------------------- behaviours

func (b *mower) idle(r sdk.Robot) {
	b.drive(r, 0, 0)
	r.Blade(false)
	r.SetState(model.StateIdle)
}

func (b *mower) park(r sdk.Robot, sf model.SensorFrame, m *model.Mission, now float64) {
	b.drive(r, 0, 0)
	r.Blade(false)
	r.SetState(model.StateCharging)
	b.resetManeuver()
	b.escapes, b.gaveUp = 0, false
	b.goHome = false
	b.mode = modeIdle
	if sf.Battery.Percent >= 95 && m != nil && m.Kind == "mow" {
		b.mode = modeUndock
		b.undockEnd = now + 5.0
		r.Log("info", "nav", "charged, resuming the mow mission", map[string]any{
			"percent": sf.Battery.Percent,
		})
	}
}

// undock reverses off the pad and spins round — the mower drives INTO the dock
// facing the house, so it has to back out before it can go anywhere.
func (b *mower) undock(r sdk.Robot, now float64) {
	r.SetState(model.StateMowing)
	r.Blade(false)
	switch {
	case now < b.undockEnd-2.0:
		b.drive(r, -0.25, 0)
	case now < b.undockEnd:
		b.drive(r, 0, 1.7)
	default:
		b.mode = modeMow
		b.resetManeuver()
		r.Log("info", "nav", "left the charging station", nil)
	}
}

// doMow is the classic random-bounce pattern: straight ahead until the wire,
// a bumper or the range finder says otherwise, then reverse and turn away by a
// random 90-170 degrees.
func (b *mower) doMow(r sdk.Robot, sf model.SensorFrame, now, dt float64) {
	r.SetState(model.StateMowing)
	w := sf.Wire
	if b.pattern == patternLines {
		b.linesObserve(w.Inside)
	}
	if w.Inside {
		b.outsideSince = 0
	} else if b.outsideSince == 0 {
		b.outsideSince = now
	}

	if !w.Inside {
		// Two very different situations look the same on the wire sensor:
		// we have just nudged over the boundary (turn back in), or we are in
		// the wrong part of the garden entirely because a zone mission wants
		// us somewhere else (drive there). Time outside tells them apart.
		if now-b.outsideSince > 5.0 {
			// Well outside the work area — this happens when a zone mission
			// starts while we are standing in a different zone. Cross the lawn
			// towards the wire with the blade off. Obstacles (in particular the
			// house) are handled bug-algorithm style: turn away, run blind for
			// a few seconds, then home in on the wire again.
			r.Blade(false)
			if sf.Bump.Front || sf.Bump.Left || sf.Bump.Right {
				b.transitBlind = now + 4.0
				b.startBounce(now, !sf.Bump.Left, 60, 140)
				b.runManeuver(r, now)
				return
			}
			if md, ma, ok := nearestBeam(sf.Range, 0.5); ok && md < rangeStopDist {
				b.transitBlind = now + 4.0
				b.startBounce(now, ma < 0, 60, 140)
				b.runManeuver(r, now)
				return
			}
			if now < b.transitBlind {
				b.drive(r, transitSpeed, 0)
				return
			}
			v := transitSpeed
			if math.Abs(w.Direction) > 0.9 {
				v = 0.08
			}
			b.drive(r, v, clamp(1.2*w.Direction, -2.0, 2.0))
			return
		}
		// Just crossed the boundary. Direction points back at the wire, i.e.
		// back into the work area, so turn that way. Zone edges are soft: we
		// only ever turn back, we never treat them as a wall.
		r.Blade(true)
		if b.pattern == patternLines && b.ln.haveAxis {
			b.linesUTurn(r, now) // end of a stripe: swing round onto the next one
		} else {
			b.startBounce(now, w.Direction > 0, 100, 170)
		}
		b.runManeuver(r, now)
		return
	}

	r.Blade(true)

	if sf.Bump.Front || sf.Bump.Left || sf.Bump.Right {
		turnLeft := b.rnd.Intn(2) == 0
		if sf.Bump.Right && !sf.Bump.Left {
			turnLeft = true
		}
		if sf.Bump.Left && !sf.Bump.Right {
			turnLeft = false
		}
		if b.pattern == patternLines && b.ln.haveAxis {
			b.linesAvoid(r, now, turnLeft) // step around it, then rejoin the stripe
		} else {
			b.startBounce(now, turnLeft, 90, 170)
		}
		b.runManeuver(r, now)
		return
	}

	if md, ma, ok := nearestBeam(sf.Range, 0.6); ok && md < rangeStopDist {
		if b.pattern == patternLines && b.ln.haveAxis {
			b.linesAvoid(r, now, ma < 0)
		} else {
			b.startBounce(now, ma < 0, 90, 170)
		}
		b.runManeuver(r, now)
		return
	}

	switch b.pattern {
	case patternSpiral:
		if b.spiralStep(r, sf, now, dt) {
			return
		}
	case patternLines:
		b.linesCruise(r, now)
		return
	}
	b.drive(r, mowSpeed, 0)
}

// spiralStep implements Husqvarna's spiral cutting: a rise in blade current
// means the mower has driven into a patch of tall grass, so it switches from
// straight lines to an expanding spiral to clean the patch up before carrying
// on. Returns true when it has taken control of the drive this step.
func (b *mower) spiralStep(r sdk.Robot, sf model.SensorFrame, now, dt float64) bool {
	cur := sf.BladeCurrent
	if b.spiralOn {
		if now > b.spiralEnd || cur < b.spiralEntryA*0.9 {
			b.spiralOn = false
			b.spiralCool = now + 20
			r.Log("debug", "nav", "grass is short again, back to straight lines", nil)
			return false
		}
		b.spiralR += 0.08 * dt // grow the radius ~8 cm per second
		omega := clamp(wireSpeed/b.spiralR, -2.2, 2.2)
		b.drive(r, wireSpeed, omega)
		return true
	}

	if !b.haveEMA {
		b.bladeEMA, b.haveEMA = cur, true
	} else {
		b.bladeEMA += 0.02 * (cur - b.bladeEMA)
	}
	if now > b.spiralCool && cur > 1.25*b.bladeEMA && cur > 1.0 {
		b.spiralOn = true
		b.spiralR = 0.30
		b.spiralEnd = now + 45
		b.spiralEntryA = cur
		r.Log("info", "nav", "tall grass detected, spiral cutting", map[string]any{
			"blade_a": math.Round(cur*100) / 100,
		})
		return true
	}
	return false
}

// doSeekWire drives towards the strongest wire signal until the boundary is
// within reach, then hands over to the wire follower.
func (b *mower) doSeekWire(r sdk.Robot, sf model.SensorFrame, now float64) {
	r.SetState(model.StateDocking)
	r.Blade(false)

	if dk, ok := findObject(sf.Camera, "dock"); ok && dk.Dist < dockSightDist && now > b.dockCool {
		b.enterDockApproach(r, now, dk)
		return
	}
	if sf.Bump.Front || sf.Bump.Left || sf.Bump.Right {
		b.startBounce(now, !sf.Bump.Left, 60, 140)
		b.runManeuver(r, now)
		return
	}
	w := sf.Wire
	if wireDist(w.Strength) < 0.45 {
		b.mode = modeFollowWire
		b.followSince = now
		b.haveWireD = false
		r.Log("info", "nav", "boundary wire acquired", nil)
		return
	}
	v := transitSpeed
	if math.Abs(w.Direction) > 0.7 {
		v = 0.05
	}
	b.drive(r, v, clamp(1.5*w.Direction, -2.0, 2.0))
}

// doFollowWire tracks the boundary wire with the wire on the LEFT, which is
// the circulation direction that leads to the charging station.
func (b *mower) doFollowWire(r sdk.Robot, sf model.SensorFrame, now, dt float64) {
	r.SetState(model.StateDocking)
	r.Blade(false)

	if dk, ok := findObject(sf.Camera, "dock"); ok && dk.Dist < dockSightDist && now > b.dockCool {
		b.enterDockApproach(r, now, dk)
		return
	}
	if sf.Bump.Front || sf.Bump.Left || sf.Bump.Right {
		// Something on the wire. Back off and turn right, keeping the wire on
		// the left so we resume in the same direction.
		b.startBounce(now, false, 40, 90)
		b.runManeuver(r, now)
		return
	}

	w := sf.Wire
	d := wireDist(w.Strength)
	if d > 1.5 {
		b.mode = modeSeekWire
		return
	}
	if now-b.followSince > 300 {
		// Been round long enough without seeing home — break the pattern and
		// re-acquire from somewhere else rather than orbit forever.
		b.followSince = now
		b.mode = modeSeekWire
		b.startBounce(now, b.rnd.Intn(2) == 0, 60, 180)
		r.Log("warn", "nav", "no dock found along the wire, re-acquiring", nil)
		b.runManeuver(r, now)
		return
	}

	// Signed lateral offset: positive inside the loop, negative outside. The
	// setpoint is +wireStandoff, so the same law both holds station inside and
	// drags the mower back in if it strays over the wire.
	s := d
	target := math.Pi / 2 // wire abeam to PORT while inside...
	if !w.Inside {
		s = -d
		target = -math.Pi / 2 // ...and abeam to starboard once we have crossed
	}
	if !b.haveWireD {
		b.wireD, b.wireDRate, b.haveWireD = s, 0, true
	}
	rate := (s - b.wireD) / math.Max(dt, 1e-3)
	b.wireDRate += 0.3 * (rate - b.wireDRate)
	b.wireD = s

	// align == 0 when the wire is exactly abeam on the expected side. Positive
	// omega turns left, i.e. towards the wire, so all three terms share a sign.
	align := wrap(w.Direction - target)
	omega := clamp(1.2*align+2.0*(s-wireStandoff)-3.0*b.wireDRate, -1.8, 1.8)
	v := wireSpeed
	if math.Abs(align) > 0.6 {
		v = 0.12
	}
	b.drive(r, v, omega)
}

func (b *mower) enterDockApproach(r sdk.Robot, now float64, dk model.DetectedObject) {
	if b.mode == modeDockApproach {
		return
	}
	b.mode = modeDockApproach
	b.lastDockSeen = now
	r.Log("info", "nav", "charging station in sight", map[string]any{
		"dist": math.Round(dk.Dist*100) / 100, "confidence": dk.Confidence,
	})
}

// doDockApproach servos on the camera bearing to the dock and creeps in. The
// engine latches the charger once we are on the pad, pointing roughly along
// the dock's approach heading and moving slowly.
func (b *mower) doDockApproach(r sdk.Robot, sf model.SensorFrame, now float64) {
	r.SetState(model.StateDocking)
	r.Blade(false)

	if sf.Bump.Front || sf.Bump.Left || sf.Bump.Right {
		// Something between us and the pad (the house corner, a toy). Abort,
		// go back to the wire and do not re-commit for a while.
		r.Log("warn", "nav", "obstruction on the dock approach, backing off", nil)
		b.dockCool = now + 25
		b.mode = modeSeekWire
		b.haveWireD = false
		b.startBounce(now, b.rnd.Intn(2) == 0, 60, 140)
		b.runManeuver(r, now)
		return
	}

	dk, ok := findObject(sf.Camera, "dock")
	if !ok {
		if now-b.lastDockSeen > 4.0 {
			r.Log("warn", "nav", "lost sight of the dock, back to the wire", nil)
			b.dockCool = now + 10
			b.mode = modeSeekWire
			b.haveWireD = false
			return
		}
		b.drive(r, 0.10, 0) // momentarily out of the camera cone: creep on
		return
	}
	b.lastDockSeen = now
	v := dockSpeed
	if math.Abs(dk.Bearing) > 0.45 {
		v = 0.04
	}
	b.drive(r, v, clamp(2.0*dk.Bearing, -1.2, 1.2))
}

// ------------------------------------------------------------------ plumbing

// watchdog is the brain's own stuck handling: if we command motion for six
// seconds and the wheels report almost no travel, wiggle out; after
// escapeLimit failures declare defeat so the platform can raise an alarm.
func (b *mower) watchdog(r sdk.Robot, now float64) {
	if now-b.winStart < 6.0 {
		return
	}
	moved := b.pe.Travelled() - b.winTrav
	commanded := b.winCmd > 0.05
	b.winStart, b.winTrav, b.winCmd = now, b.pe.Travelled(), 0

	// A healthy mower covers metres in six seconds, even one that spends the
	// window bouncing. Anything under this is shuffling on the spot.
	if moved >= 0.35 {
		b.escapes = 0
		return
	}
	// A manoeuvre in flight is no excuse: bouncing on the spot for six seconds
	// is exactly what being wedged looks like.
	if !commanded {
		return
	}
	b.escapes++
	if b.escapes > escapeLimit {
		b.gaveUp = true
		b.gaveUpAt = now
		r.Log("error", "nav", "cannot free myself, giving up", map[string]any{
			"attempts": b.escapes - 1,
		})
		return
	}
	r.Log("warn", "nav", "no progress, trying to wiggle free", map[string]any{
		"attempt": b.escapes,
	})
	b.startEscape(now)
}

func (b *mower) drive(r sdk.Robot, v, omega float64) {
	b.lastCmdV = v
	if a := math.Abs(v); a > b.winCmd {
		b.winCmd = a
	}
	r.Drive(v, omega)
}

func (b *mower) resetManeuver() { b.phase = 0 }

// startBounce queues reverse-then-rotate. turnLeft picks the rotation sense,
// minDeg/maxDeg the random turn size (a real automower turns 90-170 degrees).
func (b *mower) startBounce(now float64, turnLeft bool, minDeg, maxDeg float64) {
	b.phase = 1
	b.phaseEnd = now + 1.0
	ang := (minDeg + b.rnd.Float64()*(maxDeg-minDeg)) * math.Pi / 180
	b.rotOmega = 1.8
	if !turnLeft {
		b.rotOmega = -1.8
	}
	b.rotDur = ang / 1.8
	b.spiralOn = false
}

// startEscape is a longer, more violent version used by the watchdog.
func (b *mower) startEscape(now float64) {
	b.phase = 1
	b.phaseEnd = now + 1.6
	b.rotOmega = 2.0
	if b.rnd.Intn(2) == 0 {
		b.rotOmega = -2.0
	}
	b.rotDur = (2.0 + b.rnd.Float64()*2.0) / 2.0
	b.spiralOn = false
}

// runManeuver returns true while it owns the drive.
func (b *mower) runManeuver(r sdk.Robot, now float64) bool {
	if b.phase == 1 {
		if now < b.phaseEnd {
			b.drive(r, -0.28, 0)
			return true
		}
		b.phase = 2
		b.phaseEnd = now + b.rotDur
	}
	if b.phase == 2 {
		if now < b.phaseEnd {
			b.drive(r, 0, b.rotOmega)
			return true
		}
		b.phase = 0
	}
	return false
}

// wireDist inverts Wire.Strength back into metres.
func wireDist(strength float64) float64 {
	if strength <= 1e-6 {
		return math.Inf(1)
	}
	return math.Max(0, 1/strength-0.2)
}

// nearestBeam returns the closest hit inside +/- coneRad of straight ahead.
func nearestBeam(beams []model.RangeBeam, coneRad float64) (dist, angle float64, ok bool) {
	dist = math.Inf(1)
	for _, bm := range beams {
		if !bm.Hit || math.Abs(bm.Angle) > coneRad {
			continue
		}
		if bm.Dist < dist {
			dist, angle, ok = bm.Dist, bm.Angle, true
		}
	}
	return
}

// findObject returns the nearest camera detection with the given label.
func findObject(c model.CameraHint, label string) (model.DetectedObject, bool) {
	var best model.DetectedObject
	found := false
	for _, o := range c.Objects {
		if o.Label != label {
			continue
		}
		if !found || o.Dist < best.Dist {
			best, found = o, true
		}
	}
	return best, found
}
