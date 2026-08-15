package brain

// pose.go — the localisation helper both brains share.
//
// It is deliberately small and honest about what a real mower has: wheel
// odometry (accurate short term, drifts), a compass (noisy but drift-bounded)
// and a garden-grade GPS (metre-level, correlated error, drops out near the
// house). Dead reckoning is corrected by a complementary filter on heading and
// a low-gain position correction from GPS. The result is published through
// sdk.Robot.PublishPose so the UI can draw estimate vs ground truth.

import (
	"math"

	"github.com/styrops/huskvarna-demo/pkg/model"
)

// ---- occupancy map ----
//
// The map is built IN THE ESTIMATE FRAME, from the robot's own noisy senses
// only. When the pose estimate drifts, previously mapped obstacles smear —
// that is not a bug, it is the whole point of showing the map next to ground
// truth. Cell semantics match model.RobotMap:
//
//	-1 unknown   never observed
//	 0 free      the chassis has physically occupied the cell, or a range beam
//	             passed through it without stopping
//	 1 obstacle  a range beam terminated here, or a bumper fired towards it
//
// Precedence within one update: swept-free is written first, then ray
// clearing (which only ever promotes unknown -> free, never erasing an
// obstacle), then beam hits, then bump contacts. So obstacles always win the
// step in which they are seen, and driving over a cell later re-marks it free.
const (
	MapCell = 0.5 // m
	// Sized generously around the 40 x 28 m garden: the estimate can wander
	// outside the property, and writes beyond the grid are simply dropped.
	mapCols = 96 // 48 m
	mapRows = 72 // 36 m

	mapUnknown  int8 = -1
	mapFree     int8 = 0
	mapObstacle int8 = 1

	trajMaxPoses = 300 // ~5 minutes of track at one pose per sim-second
	trajPeriodS  = 1.0

	// Where a bumper contact is recorded, measured from the estimated centre.
	bumpMarkDist = 0.50
	// Radius of the swept-free footprint stamp.
	footprintR = 0.30
)

// robotWheelBase is the mower's track width in metres. Firmware knows its own
// chassis; this must match the value the simulator integrates with.
const robotWheelBase = 0.30

// Filter gains. Heading trusts the compass slowly; position trusts GPS very
// slowly so a 1.5 m GPS wobble does not shake the estimate around.
const headingGain = 0.05

// GPS fusion. Garden GPS carries a ~1.5 m error with a ~20 s correlation time.
// Blending the raw fix in at any useful gain simply copies that wander into
// the estimate, which is glaring when a brain drives straight rows off it; but
// blending it in slowly lets dead-reckoning drift run away.
//
// So we do not blend the fix at all. We lowpass the INNOVATION (fix minus our
// own estimate): the vehicle's motion cancels out of that difference, leaving
// GPS noise minus dead-reckoning error, and averaging it suppresses the noise
// without costing any lag on the motion itself. The averaged residual is then
// paid off a fraction at a time, with an ASYMMETRIC gain — a small residual is
// mostly noise and barely moves the estimate (this is what keeps stripes
// straight), a large one is real drift and is pulled in hard.
//
// Tuned against the simulator; see TestPoseEstimateStaysCloseToTruth.
// Tuned by sweeping against recorded simulator traces; the optimum is broad
// and flat, and slower is better right up to the point where dead reckoning
// starts to run away. See TestPoseEstimateStaysCloseToTruth.
const (
	gpsLPSlow    = 0.0008 // innovation lowpass weight, per 10 Hz update (~60 s)
	gpsGainSmall = 0.0008 // matching residual pay-off rate
	gpsHoldDecay = 0.999  // residual decay per update while the fix is lost

	// Escape hatch. These only engage on a residual far outside the normal
	// operating band — a bad initialisation, or surfacing from a long GPS
	// outage somewhere else entirely. Inside the normal band the filter is
	// purely the slow one above, which is what keeps the lines brain's rows
	// straight; measured, the escape hatch does not move the statistics.
	gpsLPFast    = 0.0048 // 6x, once the residual is grossly wrong
	gpsGainLarge = 0.0048
	gpsSoftErr   = 1.50 // m, residual below this is ordinary noise
	gpsHardErr   = 4.00 // m, residual above this is a gross error
)

// Compass bias learning. The compass is the single biggest dead-reckoning
// error: it drifts a tenth of a radian or so, and at half a metre per second
// that walks the estimate sideways faster than any sane GPS filter can chase.
//
// It is observable without a map, though: over a long enough leg, the
// DIRECTION of the GPS displacement is the true course made good, and the
// difference from the course our own estimate thinks it made is the compass
// error. One sample is noisy (metre-level GPS over an 8 m baseline is ~0.2 rad)
// so it is leaked into a running correction, which converges to a few
// hundredths of a radian and is then subtracted from every compass reading.
const (
	courseBaselineM = 8.0  // m of GPS displacement before a leg counts as evidence
	courseRefM      = 16.0 // m; a leg this long is full-weight evidence
	courseGain      = 0.10 // how fast the learned heading correction moves
	courseMaxErr    = 0.8  // rad, wilder samples are outliers, not evidence
	courseMaxCorr   = 0.35 // rad, clamp on the learned correction
	courseLenTol    = 0.4  // reject if GPS and estimated leg lengths disagree by more

)

// PoseEstimator turns noisy sensor frames into a pose estimate.
type PoseEstimator struct {
	p     model.Pose
	init  bool
	trav  float64 // total travelled distance, metres (for progress watchdogs)
	lastT float64

	innX, innY float64 // lowpassed GPS residual still to be applied

	headingCorr  float64 // learned compass correction, radians
	anchorGPS    model.Vec2
	legDX, legDY float64 // dead-reckoning-only displacement since the anchor
	anchorOK     bool

	cells     []int8
	traj      []model.Pose
	lastTrajT float64
	trajInit  bool
}

func NewPoseEstimator() *PoseEstimator {
	pe := &PoseEstimator{cells: make([]int8, mapCols*mapRows)}
	for i := range pe.cells {
		pe.cells[i] = mapUnknown
	}
	return pe
}

// Update integrates one sensor frame and returns the new estimate.
func (pe *PoseEstimator) Update(sf model.SensorFrame) model.Pose {
	if !pe.init {
		pe.p.Theta = sf.IMU.Heading
		if sf.GPS.Fix {
			pe.p.X, pe.p.Y = sf.GPS.Pos.X, sf.GPS.Pos.Y
			pe.init = true
		}
	}
	pe.lastT = sf.T

	// --- dead reckoning from wheel deltas ---
	dl, dr := sf.Odometry.DLeft, sf.Odometry.DRight
	dc := (dl + dr) / 2
	dth := (dr - dl) / robotWheelBase
	mid := pe.p.Theta + dth/2
	pe.p.X += dc * math.Cos(mid)
	pe.p.Y += dc * math.Sin(mid)
	// Same increment banked separately: the compass learner has to compare
	// GPS against DEAD RECKONING, not against the GPS-corrected estimate.
	// Comparing against the corrected estimate puts the same GPS noise on
	// both sides of the subtraction, which cancels the very signal we are
	// trying to measure.
	pe.legDX += dc * math.Cos(mid)
	pe.legDY += dc * math.Sin(mid)
	pe.p.Theta = wrap(pe.p.Theta + dth)
	pe.trav += math.Abs(dc)

	// --- complementary filter: pull heading towards the compass, corrected
	//     by whatever bias we have learned from GPS course over ground ---
	compass := wrap(sf.IMU.Heading + pe.headingCorr)
	pe.p.Theta = wrap(pe.p.Theta + headingGain*wrap(compass-pe.p.Theta))

	// --- GPS correction, gated on fix ---
	if sf.GPS.Fix && !pe.init {
		pe.p.X, pe.p.Y = sf.GPS.Pos.X, sf.GPS.Pos.Y
		pe.init = true
		pe.innX, pe.innY = 0, 0
	} else if sf.GPS.Fix {
		// urgency: 0 while the averaged residual looks like GPS noise, 1 once
		// it is big enough to be real drift. It scales BOTH how fast we
		// believe new evidence and how hard we act on it, so the filter is
		// patient in the steady state and quick after a genuine excursion.
		u := clamp((math.Hypot(pe.innX, pe.innY)-gpsSoftErr)/(gpsHardErr-gpsSoftErr), 0, 1)
		w := gpsLPSlow + u*(gpsLPFast-gpsLPSlow)
		if sf.GPS.Accuracy > 2.5 {
			w *= 0.4 // degraded fix (multipath near the house): trust it less
		}
		pe.innX += w * (sf.GPS.Pos.X - pe.p.X - pe.innX)
		pe.innY += w * (sf.GPS.Pos.Y - pe.p.Y - pe.innY)
	} else {
		// No fix: bleed the outstanding residual away rather than keep
		// applying a correction nobody is confirming any more.
		pe.innX *= gpsHoldDecay
		pe.innY *= gpsHoldDecay
	}

	// Pay off part of the outstanding residual. innX/innY hold "correction
	// still owed", so draining what we apply keeps the loop stable for any
	// gain and stops the lowpass and the correction fighting each other.
	if pe.init {
		u := clamp((math.Hypot(pe.innX, pe.innY)-gpsSoftErr)/(gpsHardErr-gpsSoftErr), 0, 1)
		k := gpsGainSmall + u*(gpsGainLarge-gpsGainSmall)
		pe.p.X += k * pe.innX
		pe.p.Y += k * pe.innY
		pe.innX -= k * pe.innX
		pe.innY -= k * pe.innY
	}

	pe.learnCompassBias(sf)

	pe.updateMap(sf)

	if !pe.trajInit || sf.T-pe.lastTrajT >= trajPeriodS {
		pe.trajInit, pe.lastTrajT = true, sf.T
		pe.traj = append(pe.traj, pe.p)
		if n := len(pe.traj); n > trajMaxPoses {
			copy(pe.traj, pe.traj[n-trajMaxPoses:])
			pe.traj = pe.traj[:trajMaxPoses]
		}
	}
	return pe.p
}

// learnCompassBias compares the course the GPS says we made good against the
// course our own estimate thinks it made, over legs of at least
// courseBaselineM, and leaks the difference into headingCorr.
func (pe *PoseEstimator) learnCompassBias(sf model.SensorFrame) {
	if !sf.GPS.Fix || !pe.init {
		pe.anchorOK = false // a gap in the fix breaks the baseline
		pe.legDX, pe.legDY = 0, 0
		return
	}
	if !pe.anchorOK {
		pe.anchorGPS, pe.anchorOK = sf.GPS.Pos, true
		pe.legDX, pe.legDY = 0, 0
		return
	}
	gx, gy := sf.GPS.Pos.X-pe.anchorGPS.X, sf.GPS.Pos.Y-pe.anchorGPS.Y
	ex, ey := pe.legDX, pe.legDY
	lg, le := math.Hypot(gx, gy), math.Hypot(ex, ey)
	if lg < courseBaselineM {
		return // not far enough yet for the GPS noise to average out
	}
	// Only believe the sample if both stories agree on how far we went;
	// otherwise the mower doubled back and "course made good" means nothing.
	// Longer legs carry proportionally more weight, because the same metre of
	// GPS noise is a smaller angle over a longer baseline.
	if le > 0 && math.Abs(lg-le) <= courseLenTol*lg {
		w := clamp(lg/courseRefM, 0, 1.5)
		if err := wrap(math.Atan2(gy, gx) - math.Atan2(ey, ex)); math.Abs(err) < courseMaxErr {
			pe.headingCorr = clamp(pe.headingCorr+courseGain*w*err, -courseMaxCorr, courseMaxCorr)
		}
	}
	pe.anchorGPS = sf.GPS.Pos
	pe.legDX, pe.legDY = 0, 0
}

// CompassCorrection is the bias the estimator has learned out of the compass,
// in radians. Exposed for tests and diagnostics.
func (pe *PoseEstimator) CompassCorrection() float64 { return pe.headingCorr }

// ---- occupancy map ----

func (pe *PoseEstimator) cellIndex(x, y float64) int {
	ix := int(math.Floor(x / MapCell))
	iy := int(math.Floor(y / MapCell))
	if ix < 0 || iy < 0 || ix >= mapCols || iy >= mapRows {
		return -1 // outside the grid: drop the write
	}
	return iy*mapCols + ix
}

func (pe *PoseEstimator) write(x, y float64, v int8) {
	if i := pe.cellIndex(x, y); i >= 0 {
		pe.cells[i] = v
	}
}

// clearUnknown promotes unknown -> free only; a mapped obstacle survives.
func (pe *PoseEstimator) clearUnknown(x, y float64) {
	if i := pe.cellIndex(x, y); i >= 0 && pe.cells[i] == mapUnknown {
		pe.cells[i] = mapFree
	}
}

// updateMap folds one sensor frame into the grid. Bounded work per call:
// 5 footprint stamps + 12 beams x <= 10 ray samples + 3 bump marks.
func (pe *PoseEstimator) updateMap(sf model.SensorFrame) {
	p := pe.p

	// 1. Swept footprint. We are standing here, so it is free by definition —
	//    this also corrects a cell wrongly mapped as an obstacle earlier.
	pe.write(p.X, p.Y, mapFree)
	pe.write(p.X+footprintR, p.Y, mapFree)
	pe.write(p.X-footprintR, p.Y, mapFree)
	pe.write(p.X, p.Y+footprintR, mapFree)
	pe.write(p.X, p.Y-footprintR, mapFree)

	// 2/3. Range beams: clear the space they crossed, mark where they stopped.
	for _, b := range sf.Range {
		th := p.Theta + b.Angle
		cx, sy := math.Cos(th), math.Sin(th)
		reach := b.Dist
		if b.Hit {
			reach -= MapCell // do not clear the cell the return came from
		}
		for d := MapCell; d < reach; d += MapCell {
			pe.clearUnknown(p.X+d*cx, p.Y+d*sy)
		}
		if b.Hit {
			pe.write(p.X+b.Dist*cx, p.Y+b.Dist*sy, mapObstacle)
		}
	}

	// 4. Bumpers: something solid is right there, whatever the beams said.
	mark := func(rel float64) {
		th := p.Theta + rel
		pe.write(p.X+bumpMarkDist*math.Cos(th), p.Y+bumpMarkDist*math.Sin(th), mapObstacle)
	}
	if sf.Bump.Front {
		mark(0)
	}
	if sf.Bump.Left {
		mark(0.9)
	}
	if sf.Bump.Right {
		mark(-0.9)
	}
}

// Map snapshots the occupancy grid for sdk.Robot.PublishMap. The returned
// slices are copies, so the caller may hand them straight to the platform.
func (pe *PoseEstimator) Map() model.RobotMap {
	cells := make([]int8, len(pe.cells))
	copy(cells, pe.cells)
	traj := make([]model.Pose, len(pe.traj))
	copy(traj, pe.traj)
	return model.RobotMap{
		Cols:       mapCols,
		Rows:       mapRows,
		Cell:       MapCell,
		Cells:      cells,
		EstPose:    pe.p,
		Trajectory: traj,
		T:          pe.lastT,
	}
}

// Pose returns the current estimate.
func (pe *PoseEstimator) Pose() model.Pose { return pe.p }

// Travelled returns the total odometric distance since construction, metres.
func (pe *PoseEstimator) Travelled() float64 { return pe.trav }

func wrap(a float64) float64 {
	a = math.Mod(a+math.Pi, 2*math.Pi)
	if a <= 0 {
		a += 2 * math.Pi
	}
	return a - math.Pi
}

func clamp(x, lo, hi float64) float64 {
	if x < lo {
		return lo
	}
	if x > hi {
		return hi
	}
	return x
}
