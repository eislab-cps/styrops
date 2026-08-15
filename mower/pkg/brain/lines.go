package brain

// lines.go — systematic stripe (boustrophedon) mowing.
//
// Random bounce is what the real machines do, but to a watching human it looks
// like the mower is ignoring instructions. This brain mows the way a person
// would: parallel stripes up and down the long axis of the work area, U-turning
// at the boundary wire and stepping sideways by one and a half blade widths.
//
// It has no map. The stripes are held together entirely by the shared
// PoseEstimator — dead reckoning, compass, a low-gain GPS nudge — so the rows
// are never perfectly straight and slowly wander as the estimate drifts. That
// is deliberate: the wander IS the demo of why localisation matters. Bumps and
// range hits are stepped around and the mower then rejoins its stripe.
//
// Sequence:
//  1. survey  — random bounce for surveySec while recording the bounding box of
//     everywhere the wire sensor said "inside"
//  2. stripe  — row heading = long axis of that box; cruise with a heading +
//     cross-track controller; U-turn at the wire; shift one row
//  3. when a row turns out to be too short, the sweep has run off the end of
//     the area, so reverse the step direction and offset the phase

import (
	"math"

	"github.com/styrops/huskvarna-demo/pkg/model"
	"github.com/styrops/huskvarna-demo/pkg/sdk"
)

const (
	brainSeedLines int64 = 3_000_003

	bladeWidth = 0.22 // m, cutting disc diameter
	// Nominally one and a half blade widths; trimmed slightly so neighbouring
	// stripes still overlap once the pose estimate has drifted a few cm.
	rowSpacing = 0.30 // m

	surveySec = 45.0 // minimum sim seconds of bouncing before committing
	// ...and the survey keeps going until it has seen an area at least this
	// wide, so the "long axis" is not decided off two passes. Hard-capped so a
	// tiny zone still gets striped eventually.
	surveyMinSpanM = 10.0
	surveyMaxSec   = 180.0

	minRowRunM  = 1.5 // a stripe shorter than this means we ran off the end
	rowBumpQuit = 2   // obstacles per stripe before treating it as blocked
	avoidRunSec = 3.0 // drive blind this long after stepping around something
)

// lineState is the stripe-pattern bookkeeping. All coordinates are in the pose
// ESTIMATOR's frame, which is roughly but not exactly world frame.
type lineState struct {
	haveBB       bool
	bbMin, bbMax model.Vec2
	surveyEnd    float64

	haveAxis bool
	heading  float64 // row axis, radians
	dir      float64 // +1 travelling along +axis, -1 along -axis
	lateral  float64 // target cross-row coordinate of the current stripe
	step     float64 // cross-row shift applied at each U-turn (+/- rowSpacing)

	rowStartAlong float64 // along-row coordinate where this stripe began
	rowBumps      int
	avoidEnd      float64
}

func init() {
	sdk.Register("lines", func() sdk.Brain {
		return newMower(
			"lines",
			"Systematic stripe pattern, the way a human would mow: parallel rows "+
				"along the long axis of the area, U-turn at the boundary wire, one "+
				"and a half blade widths sideways each pass. Row straightness is "+
				"limited by the mower's own pose estimate, so the stripes wander.",
			patternLines, brainSeedLines,
		)
	})
}

// surveySpan is the larger side of the area seen so far, metres.
func (l *lineState) surveySpan() float64 {
	if !l.haveBB {
		return 0
	}
	return math.Max(l.bbMax.X-l.bbMin.X, l.bbMax.Y-l.bbMin.Y)
}

// rowAxes returns the along-row and cross-row (left of along) unit vectors.
func (b *mower) rowAxes() (along, cross model.Vec2) {
	c, s := math.Cos(b.ln.heading), math.Sin(b.ln.heading)
	return model.Vec2{X: c, Y: s}, model.Vec2{X: -s, Y: c}
}

func (b *mower) rowCoords() (along, cross float64) {
	p := b.pe.Pose()
	u, w := b.rowAxes()
	return p.X*u.X + p.Y*u.Y, p.X*w.X + p.Y*w.Y
}

// linesObserve grows the estimated bounding box of the work area. Only points
// the wire sensor calls "inside" count, so a zone mission measures the zone.
func (b *mower) linesObserve(inside bool) {
	if !inside {
		return
	}
	p := b.pe.Pose()
	if !b.ln.haveBB {
		b.ln.bbMin = model.Vec2{X: p.X, Y: p.Y}
		b.ln.bbMax = b.ln.bbMin
		b.ln.haveBB = true
		return
	}
	b.ln.bbMin.X = math.Min(b.ln.bbMin.X, p.X)
	b.ln.bbMin.Y = math.Min(b.ln.bbMin.Y, p.Y)
	b.ln.bbMax.X = math.Max(b.ln.bbMax.X, p.X)
	b.ln.bbMax.Y = math.Max(b.ln.bbMax.Y, p.Y)
}

// linesCruise drives the current stripe (or bounces during the survey phase).
func (b *mower) linesCruise(r sdk.Robot, now float64) {
	if !b.ln.haveAxis {
		if b.ln.surveyEnd == 0 {
			b.ln.surveyEnd = now + surveySec
			r.Log("info", "nav", "surveying the work area before laying out stripes", nil)
		}
		if now < b.ln.surveyEnd || (b.ln.surveySpan() < surveyMinSpanM && now < b.ln.surveyEnd+surveyMaxSec) {
			b.drive(r, mowSpeed, 0) // straight lines + wire bounces = a survey
			return
		}
		b.linesPickAxis(r)
	}

	// Just stepped around an obstacle: run straight for a moment to clear it
	// before the cross-track term drags us back onto the row.
	if now < b.ln.avoidEnd {
		b.drive(r, mowSpeed, 0)
		return
	}

	est := b.pe.Pose()
	_, cross := b.rowCoords()

	want := b.ln.heading
	if b.ln.dir < 0 {
		want = wrap(want + math.Pi)
	}
	headErr := wrap(want - est.Theta)
	// Cross-track: positive means the stripe is to our left when travelling
	// along +axis, hence the dir factor.
	crossErr := clamp(b.ln.lateral-cross, -1.0, 1.0)

	omega := clamp(1.6*headErr+1.2*b.ln.dir*crossErr, -1.5, 1.5)
	v := mowSpeed
	if math.Abs(headErr) > 0.8 {
		v = 0.15 // swinging onto the row: slow down rather than cut a curve
	}
	b.drive(r, v, omega)
}

// linesPickAxis commits to the long axis of everything surveyed so far.
func (b *mower) linesPickAxis(r sdk.Robot) {
	h := 0.0
	if b.ln.haveBB && (b.ln.bbMax.Y-b.ln.bbMin.Y) > (b.ln.bbMax.X-b.ln.bbMin.X) {
		h = math.Pi / 2
	}
	b.ln.heading = h
	b.ln.haveAxis = true

	est := b.pe.Pose()
	b.ln.dir = 1
	if math.Abs(wrap(est.Theta-h)) > math.Pi/2 {
		b.ln.dir = -1 // start in whichever direction we happen to be pointing
	}
	along, cross := b.rowCoords()
	b.ln.lateral = cross
	b.ln.step = rowSpacing
	b.ln.rowStartAlong = along
	b.ln.rowBumps = 0

	r.Log("info", "nav", "mowing in stripes", map[string]any{
		"row_heading_deg": math.Round(h * 180 / math.Pi),
		"spacing_m":       rowSpacing,
		"area_m":          []float64{math.Round((b.ln.bbMax.X-b.ln.bbMin.X)*10) / 10, math.Round((b.ln.bbMax.Y-b.ln.bbMin.Y)*10) / 10},
	})
}

// linesUTurn ends the current stripe: shift one row sideways, reverse the
// travel direction and queue the physical about-turn.
func (b *mower) linesUTurn(r sdk.Robot, now float64) {
	along, _ := b.rowCoords()
	if math.Abs(along-b.ln.rowStartAlong) < minRowRunM {
		// Barely moved along the row: the sweep has walked off the end of the
		// area. Go back the other way, offset so the new pass falls between
		// the old ones.
		b.ln.step = -b.ln.step
		b.ln.lateral += 2.5 * b.ln.step
		r.Log("debug", "nav", "reached the end of the striped area, sweeping back", nil)
	}
	prevDir := b.ln.dir
	b.ln.lateral += b.ln.step
	b.ln.dir = -b.ln.dir
	b.ln.rowStartAlong = along
	b.ln.rowBumps = 0

	// Turn towards the side the next stripe is on: while travelling along
	// +axis a left turn increases the cross coordinate.
	turnLeft := (b.ln.step > 0) == (prevDir > 0)
	b.phase = 1
	b.phaseEnd = now + 0.6 // short nudge back off the wire
	b.rotOmega = 1.8
	if !turnLeft {
		b.rotOmega = -1.8
	}
	b.rotDur = math.Pi / 1.8 // 180 degrees
}

// linesAvoid steps around an obstacle without abandoning the stripe. After
// rowBumpQuit obstacles the row is treated as blocked and ended early.
func (b *mower) linesAvoid(r sdk.Robot, now float64, turnLeft bool) {
	b.ln.rowBumps++
	if b.ln.rowBumps >= rowBumpQuit {
		r.Log("debug", "nav", "stripe is blocked, moving to the next one", nil)
		b.linesUTurn(r, now)
		return
	}
	b.startBounce(now, turnLeft, 55, 85)
	b.ln.avoidEnd = now + avoidRunSec
}
