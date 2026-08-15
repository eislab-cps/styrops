package sim

// hedgehog.go — the garden's wildlife.
//
// Obstacles of type "hedgehog" are not scenery: they amble about on their own.
// Each one alternates between ambling (a fresh random heading, 0.06-0.15 m/s,
// for 2-8 sim-seconds) and sniffing about on the spot (3-15 sim-seconds). They
// stay on lawn or path, keep clear of the house, the trees and each other, and
// scurry away from the mower rather than getting run over.
//
// Everything that senses obstacles — collision, range beams, camera hints and
// the World() snapshot handed to the UI — reads e.world.Obstacles live on every
// call, so a hedgehog that moves is immediately real to all of them. The one
// place obstacles are baked in is cellIsLawn, which runs once at build time;
// hedgehogs are excluded there, so wildlife never punches holes in the lawn.

import (
	"math"

	"github.com/styrops/huskvarna-demo/pkg/model"
)

const (
	hogSpeedMin = 0.06 // m/s
	hogSpeedMax = 0.15 // m/s
	hogAmbleMin = 2.0  // sim seconds
	hogAmbleMax = 8.0
	hogPauseMin = 3.0
	hogPauseMax = 15.0

	// A hedgehog that finds the mower this close stops sniffing and legs it.
	hogShyRadius = 1.2 // m

	// A "world" event goes out at most every hogEmitPeriod sim-seconds, and
	// only once some hedgehog has actually moved hogMoveEmitM since the last.
	hogMoveEmitM  = 0.15 // m
	hogEmitPeriod = 0.5  // sim seconds, i.e. 2 Hz max
)

// hogState is one animal's private wander state. speed 0 means sniffing.
type hogState struct {
	heading float64 // radians
	speed   float64 // m/s, 0 while paused
	until   float64 // sim time this phase ends
}

// refreshHogs recounts the wildlife and drops state for animals that are gone.
// Called after anything mutates the obstacle list.
func (e *engine) refreshHogs() {
	e.hogCount = 0
	live := make(map[string]bool)
	for i := range e.world.Obstacles {
		if e.world.Obstacles[i].Type != "hedgehog" {
			continue
		}
		e.hogCount++
		live[e.world.Obstacles[i].ID] = true
	}
	for id := range e.hogs {
		if !live[id] {
			delete(e.hogs, id)
		}
	}
	for id := range e.hogRef {
		if !live[id] {
			delete(e.hogRef, id)
		}
	}
}

// stepHedgehogs advances every hedgehog by one substep. All randomness comes
// from e.rndP, the tick-loop generator, so a run is reproducible from its seed.
func (e *engine) stepHedgehogs(dt float64) {
	if e.hogCount == 0 {
		return
	}
	robot := v2(e.pose.X, e.pose.Y)
	for i := range e.world.Obstacles {
		o := &e.world.Obstacles[i]
		if o.Type != "hedgehog" {
			continue
		}
		h := e.hogs[o.ID]
		if h == nil {
			h = &hogState{}
			e.hogs[o.ID] = h
			e.hogNextPhase(h, false) // new arrivals set off walking
		}
		if e.simT >= h.until {
			e.hogNextPhase(h, h.speed > 0)
		}

		// Startled: head directly away from the mower, at a trot.
		if dist(o.Pos, robot) < hogShyRadius {
			h.heading = angNorm(math.Atan2(o.Pos.Y-robot.Y, o.Pos.X-robot.X) + e.rndP.NormFloat64()*0.3)
			h.speed = hogSpeedMax
			if h.until < e.simT+1.5 {
				h.until = e.simT + 1.5
			}
		}
		if h.speed <= 0 {
			continue // sniffing
		}

		np := v2(o.Pos.X+h.speed*dt*math.Cos(h.heading),
			o.Pos.Y+h.speed*dt*math.Sin(h.heading))
		if !e.hogCanStand(np, i, robot) {
			// Nosed into the fence, the house or a tree. This is an about-face
			// with a bit of jitter rather than a true geometric reflection —
			// we have no cheap surface normal for a spline boundary, and a
			// hedgehog turning round is exactly what it looks like anyway.
			h.heading = angNorm(h.heading + math.Pi + (e.rndP.Float64()*1.2 - 0.6))
			continue
		}
		o.Pos = np
	}
	e.maybeEmitHogMove()
}

// hogNextPhase flips between ambling and sniffing.
func (e *engine) hogNextPhase(h *hogState, wasAmbling bool) {
	if wasAmbling {
		h.speed = 0
		h.until = e.simT + hogPauseMin + e.rndP.Float64()*(hogPauseMax-hogPauseMin)
		return
	}
	h.heading = e.rndP.Float64() * 2 * math.Pi
	h.speed = hogSpeedMin + e.rndP.Float64()*(hogSpeedMax-hogSpeedMin)
	h.until = e.simT + hogAmbleMin + e.rndP.Float64()*(hogAmbleMax-hogAmbleMin)
}

// hogCanStand reports whether obstacle `self` may sit at p: on lawn or path,
// clear of the house, clear of the mower and clear of every other obstacle.
func (e *engine) hogCanStand(p model.Vec2, self int, robot model.Vec2) bool {
	o := &e.world.Obstacles[self]
	if !e.drivable(p) {
		return false
	}
	if d, _ := distToPolyline(p, polyPoints(e.world.House), true); d < o.Radius {
		return false
	}
	if dist(p, robot) < o.Radius+robotRadius {
		return false
	}
	for j := range e.world.Obstacles {
		if j == self {
			continue
		}
		q := &e.world.Obstacles[j]
		if dist(p, q.Pos) < o.Radius+q.Radius {
			return false
		}
	}
	return true
}

// maybeEmitHogMove pushes a "world" event, at most at 2 Hz, once some hedgehog
// has wandered far enough to be worth redrawing.
func (e *engine) maybeEmitHogMove() {
	if e.simT-e.hogEmitT < hogEmitPeriod {
		return
	}
	worth := false
	for i := range e.world.Obstacles {
		o := &e.world.Obstacles[i]
		if o.Type != "hedgehog" {
			continue
		}
		if ref, ok := e.hogRef[o.ID]; !ok || dist(ref, o.Pos) > hogMoveEmitM {
			worth = true
			break
		}
	}
	if !worth {
		return
	}
	e.hogEmitT = e.simT
	for i := range e.world.Obstacles {
		o := &e.world.Obstacles[i]
		if o.Type == "hedgehog" {
			e.hogRef[o.ID] = o.Pos
		}
	}
	e.publishWorld()
}
