package sim

// physics.go — differential-drive kinematics, collision response, cutting,
// battery and the safety-layer stuck detector. One fixed 50 Hz substep;
// everything here assumes e.mu is held.

import (
	"math"

	"github.com/styrops/huskvarna-demo/pkg/model"
)

const (
	physicsDT = 1.0 / 50.0 // sim seconds per physics substep

	robotRadius = 0.35 // m, chassis radius
	wheelBase   = 0.30 // m, track width (brains assume the same number)
	maxV        = 0.6  // m/s
	maxOmega    = 2.5  // rad/s
	accelV      = 0.8  // m/s^2
	accelOmega  = 6.0  // rad/s^2

	// Dock capture: the robot must be on the pad and not arriving backwards
	// through the house wall. Heading is compared to Dock.Heading (the
	// approach direction).
	dockCaptureDist = 0.28 // m
	dockCaptureAng  = 100 * math.Pi / 180
	dockCaptureVMax = 0.35 // m/s — you cannot latch at full mowing speed

	// Battery: ~90 sim-minutes of mowing, 5x faster charge on the dock.
	battMowPerSec  = 100.0 / (90 * 60) // %/s with blade + drive
	battIdlePerSec = 0.0015            // %/s parked, electronics only
	battChargeMult = 5.0

	// Blade wear. Sharpness runs 1.0 (factory sharp) down to 0.0 (dead).
	bladeWearPerHour  = 0.006 // fraction lost per sim-hour of blade-on time
	bladeWearWetMult  = 2.0   // wet grass is abrasive
	bladeWearTallMult = 1.5   // ...and so is hacking through long growth
	bladeTallMM       = 25.0  // "tall" = this far above the cut height
	bladeWearPerHit   = 0.002 // one obstacle strike on the cutting disc
	// A dull blade tears instead of slicing: the cut lands this many mm above
	// the requested height at sharpness 0, quadratically less as it sharpens.
	bladeRaggednessMM = 10.0
	// Extra motor load a blunt disc draws, as a fraction, at sharpness 0.
	bladeDullCurrent = 0.7

	// Safety layer: commanded motion but no displacement for this long.
	stuckWindowSec = 8.0
	stuckCmdV      = 0.05 // m/s
	stuckMoveM     = 0.05 // m
)

// stepPhysics advances the robot by one substep.
func (e *engine) stepPhysics(dt float64) {
	cv := clamp(e.cmdV, -maxV, maxV)
	co := clamp(e.cmdOmega, -maxOmega, maxOmega)
	if e.battery <= 0 {
		cv, co = 0, 0
	}
	e.v = approach(e.v, cv, accelV*dt)
	e.omega = approach(e.omega, co, accelOmega*dt)

	vEff := e.v
	if e.wet {
		vEff *= 0.96 // slightly less traction on wet grass
	}

	newTheta := angNorm(e.pose.Theta + e.omega*dt)
	mid := e.pose.Theta + e.omega*dt/2
	np := v2(e.pose.X+vEff*dt*math.Cos(mid), e.pose.Y+vEff*dt*math.Sin(mid))

	// A disc robot can always rotate in place; only translation can be
	// blocked. Substeps are <= 12 mm so nothing can tunnel through anything.
	if blocked, contact := e.blockedAt(np); blocked {
		e.onCollision(contact, np)
		e.v = 0
		e.pose.Theta = newTheta
		e.accumOdo(0, e.omega*dt)
		return
	}
	e.pose.X, e.pose.Y = np.X, np.Y
	e.pose.Theta = newTheta
	e.accumOdo(vEff*dt, e.omega*dt)
}

// accumOdo converts body motion into per-wheel travel for both odometry
// accumulators (one for the brain, one for the REST API).
func (e *engine) accumOdo(dc, dth float64) {
	dl := dc - dth*wheelBase/2
	dr := dc + dth*wheelBase/2
	e.odoBrain.DLeft += dl
	e.odoBrain.DRight += dr
	e.odoAPI.DLeft += dl
	e.odoAPI.DRight += dr
}

// onCollision latches bump flags by contact bearing and logs (throttled).
func (e *engine) onCollision(contact, attempt model.Vec2) {
	ref := contact
	if dist(contact, v2(e.pose.X, e.pose.Y)) < 1e-6 {
		ref = attempt
	}
	b := angNorm(math.Atan2(ref.Y-e.pose.Y, ref.X-e.pose.X) - e.pose.Theta)
	deg := b * 180 / math.Pi
	var hit model.Bump
	switch {
	case math.Abs(deg) > 160: // reversed into something
		hit.Left, hit.Right = true, true
	default:
		if math.Abs(deg) <= 60 {
			hit.Front = true
		}
		if deg > 20 && deg < 160 {
			hit.Left = true
		}
		if deg < -20 && deg > -160 {
			hit.Right = true
		}
	}
	for _, l := range []*model.Bump{&e.bumpBrain, &e.bumpAPI} {
		l.Front = l.Front || hit.Front
		l.Left = l.Left || hit.Left
		l.Right = l.Right || hit.Right
	}
	e.collisions++
	e.lastCollT = e.simT
	if e.simT-e.lastCollLogT > 1.0 {
		e.lastCollLogT = e.simT
		lvl := "info"
		if e.bladeOn {
			lvl = "warn"
		}
		e.logAt(lvl, "motor", "collision, drive stopped", map[string]any{
			"bearing_deg": math.Round(deg),
			"blade_on":    e.bladeOn,
		})
		if e.bladeOn {
			// The disc actually hit something: that costs real edge.
			e.applySharpness(e.sharpness - bladeWearPerHit)
			e.logAt("warn", "blade", "cutting disc load spike (obstacle contact)", map[string]any{
				"sharpness": math.Round(e.sharpness*1000) / 1000,
			})
		}
	}
}

// raggedness is how far above the requested cut height a worn blade actually
// leaves the grass, in mm. Sharp blade: 0. Dead blade: bladeRaggednessMM.
func (e *engine) raggedness() float64 {
	d := 1 - e.sharpness
	return d * d * bladeRaggednessMM
}

// stepCutting lowers the grass under the disc while the blade runs, and wears
// the blade down for the time it spent doing so.
func (e *engine) stepCutting(dt float64) {
	if !e.bladeOn || e.battery <= 0 {
		return
	}
	pos := v2(e.pose.X, e.pose.Y)
	h := e.grass.heightAt(pos)
	e.grass.cut(pos, e.cutHeight+e.raggedness())

	wear := bladeWearPerHour / 3600 * dt
	if e.wet {
		wear *= bladeWearWetMult
	}
	if h > 0 && h > e.cutHeight+bladeTallMM {
		wear *= bladeWearTallMult
	}
	e.applySharpness(e.sharpness - wear)
}

// applySharpness clamps the new value and warns once on each downward crossing
// of a service threshold. Raising the blade back up re-arms the warnings.
func (e *engine) applySharpness(v float64) {
	prev := e.sharpness
	e.sharpness = clamp(v, 0, 1)
	for _, th := range []struct {
		at  float64
		msg string
	}{
		{0.40, "blade worn, cut quality degraded"},
		{0.15, "blade nearly dead"},
	} {
		if prev > th.at && e.sharpness <= th.at {
			e.logAt("warn", "blade", th.msg, map[string]any{
				"sharpness":     math.Round(e.sharpness*1000) / 1000,
				"cut_offset_mm": math.Round(e.raggedness()*10) / 10,
			})
		}
	}
}

// stepBattery drains or charges the pack and manages dock capture.
func (e *engine) stepBattery(dt float64) {
	onDock := e.dockCaptured()
	if onDock != e.charging {
		e.charging = onDock
		if onDock {
			e.logAt("info", "battery", "charging started", map[string]any{"percent": math.Round(e.battery)})
			e.notice("docked", "robot docked on the charging station")
		} else {
			e.logAt("info", "battery", "charging stopped, left the dock", map[string]any{"percent": math.Round(e.battery)})
			e.notice("undocked", "robot left the charging station")
		}
	}

	if e.charging {
		e.battery = math.Min(100, e.battery+battMowPerSec*battChargeMult*dt)
	} else {
		drain := battIdlePerSec
		if math.Abs(e.v) > 0.01 || math.Abs(e.omega) > 0.01 {
			drain += battMowPerSec * 0.55
		}
		if e.bladeOn {
			drain += battMowPerSec * 0.45
		}
		if e.wet {
			drain *= 1.1
		}
		e.battery = math.Max(0, e.battery-drain*dt)
	}
	e.batteryMilestones()
}

// dockCaptured is ground truth: on the pad, roughly aligned with the dock's
// approach heading, and not arriving at mowing speed.
func (e *engine) dockCaptured() bool {
	if dist(v2(e.pose.X, e.pose.Y), e.world.Dock.Pos) > dockCaptureDist {
		return false
	}
	if math.Abs(angDiff(e.pose.Theta, e.world.Dock.Heading)) > dockCaptureAng {
		return false
	}
	return e.v <= dockCaptureVMax && e.v >= -0.02
}

func (e *engine) batteryMilestones() {
	b := int(e.battery)
	for _, m := range []int{50, 20, 10, 5} {
		if b <= m && e.battMilestone > m {
			e.battMilestone = m
			lvl := "info"
			if m <= 20 {
				lvl = "warn"
			}
			e.logAt(lvl, "battery", "battery level", map[string]any{"percent": m})
			if m == 20 {
				e.notice("low_battery", "battery below 20%, heading home")
			}
			if m == 5 {
				e.notice("error", "battery critically low")
			}
			return
		}
	}
	if b > e.battMilestone {
		e.battMilestone = 101
	}
}

// stepStuck is the engine-side safety layer: it does not care what the brain
// believes, only that motion was commanded and nothing moved.
func (e *engine) stepStuck() {
	pos := v2(e.pose.X, e.pose.Y)
	if dist(pos, e.anchorPos) >= stuckMoveM {
		e.anchorPos = pos
		e.anchorT = e.simT
		if e.stuck {
			e.stuck = false
			e.stuckSince = nil
			e.logAt("info", "system", "robot is moving again", nil)
			e.notice("unstuck", "robot freed itself")
		}
		return
	}
	if e.stuck || math.Abs(e.cmdV) <= stuckCmdV {
		return
	}
	if e.simT-e.anchorT >= stuckWindowSec {
		e.stuck = true
		t := e.simT
		e.stuckSince = &t
		e.logAt("error", "system", "stuck: drive commanded but no displacement", map[string]any{
			"window_s":    stuckWindowSec,
			"commanded_v": math.Round(e.cmdV*100) / 100,
			"collisions":  e.collisions,
		})
		e.notice("stuck", "robot is stuck and cannot move")
	}
}
