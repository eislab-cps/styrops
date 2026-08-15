package sim

// sensors.go — everything the Brain is allowed to see. Every value here is
// NOISY; ground truth never leaves the engine except through RobotStatus,
// which is for the UI only.
//
// Sign conventions (shared by Range.Angle, Wire.Direction and camera Bearing):
//
//	robot-relative bearing, radians, wrapped to (-pi, pi]
//	  0    = straight ahead
//	  +    = to the LEFT  (counter-clockwise, same sense as Pose.Theta)
//	  -    = to the RIGHT
//	 ±pi   = straight behind

import (
	"math"

	"github.com/styrops/huskvarna-demo/pkg/model"
)

const (
	rangeBeams    = 12
	rangeFanDeg   = 60.0 // beams span -60 .. +60 degrees
	rangeMax      = 5.0  // m
	cameraRange   = 4.0  // m
	cameraConeDeg = 45.0 // +/- 45 degrees

	gpsSigma   = 1.0  // m, 1-sigma of the correlated position error (decent garden GNSS)
	gpsTauSec  = 20.0 // correlation time of the GPS random walk
	odoNoise   = 0.02 // 2% multiplicative, per wheel, per read
	odoWetSlip = 0.04 // extra reported-vs-actual slip on wet grass

	// The boundary-wire pickup coil sits ahead of the wheel axis, like a real
	// automower: the mower senses the wire before the chassis reaches it.
	wireSensorFwd = 0.20 // m
)

// sensorFrame builds a noisy snapshot. odo and bump are the caller's own
// latches — the brain and the REST API each have a pair, so polling
// /api/sensors never steals the brain's dead-reckoning deltas or its bump
// events. Caller must hold e.mu.
func (e *engine) sensorFrame(odo *model.Odometry, bump *model.Bump) model.SensorFrame {
	dt := e.simT - e.lastSensorT
	if dt < 0 || dt > 60 {
		dt = 0.1
	}
	e.lastSensorT = e.simT
	pos := v2(e.pose.X, e.pose.Y)

	sf := model.SensorFrame{T: e.simT}

	// ---- odometry: incremental wheel travel, consumed on read ----
	slip := 1.0
	if e.wet {
		slip += odoWetSlip
	}
	sf.Odometry = model.Odometry{
		DLeft:  odo.DLeft * e.odoBiasL * slip * (1 + e.rndS.NormFloat64()*odoNoise),
		DRight: odo.DRight * e.odoBiasR * slip * (1 + e.rndS.NormFloat64()*odoNoise),
	}
	odo.DLeft, odo.DRight = 0, 0

	// ---- IMU: yaw rate + drifting compass ----
	sf.IMU = model.IMU{
		YawRate: e.omega + e.rndS.NormFloat64()*0.02,
		Heading: angNorm(e.pose.Theta + e.headBias + e.rndS.NormFloat64()*0.015),
	}

	// ---- GPS: Ornstein-Uhlenbeck error, multipath dropouts near the house ----
	a := math.Exp(-dt / gpsTauSec)
	q := math.Sqrt(1-a*a) * gpsSigma
	e.gpsN.X = a*e.gpsN.X + q*e.rndS.NormFloat64()
	e.gpsN.Y = a*e.gpsN.Y + q*e.rndS.NormFloat64()
	dHouse, _ := distToPolyline(pos, polyPoints(e.world.House), true)
	fix := true
	acc := gpsSigma
	if pointInPolygon(pos, e.world.House) {
		dHouse = 0
	}
	if dHouse < 3.0 {
		acc = gpsSigma * (1 + (3.0 - dHouse))
		if e.rndS.Float64() < 0.35 {
			fix = false
		}
	}
	sf.GPS = model.GPS{
		Pos:      v2(e.pose.X+e.gpsN.X, e.pose.Y+e.gpsN.Y),
		Accuracy: math.Round(acc*100) / 100,
		Fix:      fix,
	}

	// ---- range finder ----
	sf.Range = e.rangeScan()

	// ---- bump: latched since the previous read of THIS consumer ----
	sf.Bump = *bump
	*bump = model.Bump{}

	// ---- boundary / guide wire ----
	sf.Wire = e.wireSensor()

	// ---- blade current ----
	sf.BladeCurrent = e.bladeCurrent()

	// ---- battery ----
	sf.Battery = e.batteryState()

	// ---- fake computer vision ----
	sf.Camera = e.cameraHint()

	return sf
}

// rangeScan casts rangeBeams beams across the forward fan. Obstacles, the
// house walls and the perimeter fence are solid; the lawn edge is not (it is
// an open garden — only the wire tells you about that).
func (e *engine) rangeScan() []model.RangeBeam {
	o := v2(e.pose.X, e.pose.Y)
	fence := rectPoly(0, 0, worldW, worldH)
	out := make([]model.RangeBeam, rangeBeams)
	for i := 0; i < rangeBeams; i++ {
		rel := (-rangeFanDeg + float64(i)*(2*rangeFanDeg/float64(rangeBeams-1))) * math.Pi / 180
		th := e.pose.Theta + rel
		dx, dy := math.Cos(th), math.Sin(th)
		best, hit := rangeMax, false
		if t, ok := rayPolygon(o, dx, dy, e.world.House); ok && t < best {
			best, hit = t, true
		}
		if t, ok := rayPolygon(o, dx, dy, fence); ok && t < best {
			best, hit = t, true
		}
		for j := range e.world.Obstacles {
			ob := &e.world.Obstacles[j]
			if t, ok := rayCircle(o, dx, dy, ob.Pos, ob.Radius); ok && t < best {
				best, hit = t, true
			}
		}
		d := best
		if hit {
			d = clamp(d*(1+e.rndS.NormFloat64()*0.01)+e.rndS.NormFloat64()*0.02, 0.02, rangeMax)
		}
		out[i] = model.RangeBeam{Angle: rel, Dist: d, Hit: hit}
	}
	return out
}

// activeWire returns the currently energised work-area boundary.
//
// Normally that is the installed guide wire (a closed loop just inside the
// lawn edge, around the house, through the dock). While a ZONE mow mission is
// running and the battery is comfortable, the sim energises the zone boundary
// instead — this is how the brain, which has no map, learns where its work
// area is. Below 25% the guide wire comes back so the mower can find home.
func (e *engine) activeWire() (pts []model.Vec2, zone model.Polygon) {
	if e.mission != nil && e.mission.Kind == "mow" && e.mission.Zone != "" && e.battery > 25 {
		if p, ok := e.zonePolygon(e.mission.Zone); ok {
			return polyPoints(p), p
		}
	}
	return e.world.GuideWire, nil
}

func (e *engine) wireSensor() model.Wire {
	pos := v2(e.pose.X, e.pose.Y)
	front := v2(pos.X+wireSensorFwd*math.Cos(e.pose.Theta), pos.Y+wireSensorFwd*math.Sin(e.pose.Theta))
	pts, zone := e.activeWire()

	// Inside is polarity, not geography: it says which side of the ENERGISED
	// loop the pickup coil is on. Beyond the wire the mower is outside its
	// work area even though there may still be lawn there.
	inside := false
	if zone != nil {
		inside = pointInPolygon(front, zone)
	} else {
		inside = e.insideWireLoop(front)
	}
	d, np := distToPolyline(pos, pts, true)
	strength := 1.0 / (0.2 + d)
	strength *= 1 + e.rndS.NormFloat64()*0.03
	bearing := angNorm(math.Atan2(np.Y-pos.Y, np.X-pos.X) - e.pose.Theta)
	bearing = angNorm(bearing + e.rndS.NormFloat64()*0.02)
	return model.Wire{Inside: inside, Strength: strength, Direction: bearing}
}

// bladeCurrent models the motor load of the cutting disc, in amps.
func (e *engine) bladeCurrent() float64 {
	if !e.bladeOn {
		return math.Max(0, 0.1+e.rndS.NormFloat64()*0.01)
	}
	h := e.grass.heightAt(v2(e.pose.X, e.pose.Y))
	load := 0.0
	if h > 0 {
		load = math.Max(0, h-e.cutHeight)
	}
	cur := 0.8 + 0.05*load
	if e.wet {
		cur *= 1.3
	}
	// A blunt disc tears rather than slices, so the motor works harder.
	cur *= 1 + (1-e.sharpness)*bladeDullCurrent
	// Blade fighting an obstacle: near-stall spike.
	if e.simT-e.lastCollT < 0.6 {
		cur = math.Max(cur, 2.7+e.rndS.Float64()*0.35)
	}
	return math.Max(0, cur+e.rndS.NormFloat64()*0.04)
}

func (e *engine) batteryState() model.Battery {
	return model.Battery{
		Percent:  math.Round(e.battery*10) / 10,
		Voltage:  math.Round((18.0+0.036*e.battery)*100) / 100,
		Charging: e.charging,
	}
}

// cameraHint is the "fake computer vision": obstacles, the dock and the house
// within cameraRange in a +/- cameraConeDeg cone, correctly labelled, with
// noisy bearing/distance and a distance-dependent confidence.
func (e *engine) cameraHint() model.CameraHint {
	pos := v2(e.pose.X, e.pose.Y)
	cone := cameraConeDeg * math.Pi / 180
	var objs []model.DetectedObject

	add := func(label string, p model.Vec2, surfaceOffset float64) {
		d := dist(pos, p) - surfaceOffset
		if d < 0 {
			d = 0
		}
		if d > cameraRange {
			return
		}
		b := angNorm(math.Atan2(p.Y-pos.Y, p.X-pos.X) - e.pose.Theta)
		if math.Abs(b) > cone {
			return
		}
		// Occlusion: you cannot see the dock through the house.
		if label != "wall" {
			th := e.pose.Theta + b
			if t, ok := rayPolygon(pos, math.Cos(th), math.Sin(th), e.world.House); ok && t < d-0.05 {
				return
			}
		}
		conf := clamp(0.99-0.06*d-e.rndS.Float64()*0.05, 0.7, 0.99)
		objs = append(objs, model.DetectedObject{
			Label:      label,
			Bearing:    angNorm(b + e.rndS.NormFloat64()*0.03),
			Dist:       math.Max(0, d*(1+e.rndS.NormFloat64()*0.05)),
			Confidence: math.Round(conf*100) / 100,
		})
	}

	for i := range e.world.Obstacles {
		o := &e.world.Obstacles[i]
		add(o.Type, o.Pos, o.Radius)
	}
	add("dock", e.world.Dock.Pos, 0)
	// The house is reported as its nearest visible point, labelled "wall".
	_, np := distToPolyline(pos, polyPoints(e.world.House), true)
	add("wall", np, 0)
	return model.CameraHint{Objects: objs}
}
