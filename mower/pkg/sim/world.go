package sim

// world.go — the default scene: an organically shaped Swedish villa garden,
// roughly 40 x 28 m, origin at the bottom-left corner, +X east, +Y north.
//
// Nothing in the plot is axis aligned except the world bounding box:
//
//   - the property boundary is a closed Catmull-Rom spline through 16 hand
//     placed control points, sampled to an 80-vertex polygon, with gentle
//     bulges and bays and no straight run longer than about 8 m;
//   - the house footprint stays a plain rectangle (the web UI raises a pitched
//     roof off it, so it must not become an L) but is rotated 12 degrees off
//     axis and sits north-east of the plot centre;
//   - the gravel path is an S-shaped ribbon offset around a spline centreline;
//   - the flower bed is a chain of three overlapping discs following the
//     boundary, which reads as one long kidney-shaped bed.
//
// Every consumer downstream (point-in-polygon, collision, wire distance, ray
// casts) is a generic polygon operation, so only this builder changed.

import (
	"math"

	"math/rand"

	"github.com/styrops/huskvarna-demo/pkg/model"
)

const (
	worldW = 40.0 // m
	worldH = 28.0 // m

	grassCellSize = 0.25 // m

	// House: rectangular footprint, rotated off axis, nudged off centre.
	houseHalfW = 5.5  // m, half length along the house's own X
	houseHalfH = 4.0  // m, half depth along the house's own Y
	houseCX    = 21.2 // m, footprint centre
	houseCY    = 19.2 // m
	houseTheta = 12 * math.Pi / 180

	// Boundary/guide wire is laid wireInset inside the lawn edge and wireInset
	// outside the house. Keep it small: the mower turns back at the wire, so
	// anything beyond it never gets cut.
	wireInset = 0.10

	// The charging station stands off the house's south wall far enough that
	// the mower's centre can sit on the pad (chassis radius 0.35 m).
	dockStandoff = 0.5
	// Position of the dock and the front door along that wall, in house-local
	// X (0 = wall centre, negative = towards the house's own west end).
	dockLocalX = -1.5
	doorLocalX = 2.0

	pathHalfWidth = 0.6 // m; a 1.2 m gravel ribbon
)

// obstacleRadius is the physical radius used for each drop-in obstacle type.
var obstacleRadius = map[string]float64{
	"rock":       0.30,
	"tree":       0.80,
	"trampoline": 1.50,
	"toy":        0.20,
	"flowerbed":  1.50,
	"hedgehog":   0.15,
}

// houseLocal maps a point in the house's own frame (origin at the footprint
// centre, +Y towards the back of the house) into world coordinates.
func houseLocal(x, y float64) model.Vec2 {
	c, s := math.Cos(houseTheta), math.Sin(houseTheta)
	return v2(houseCX+x*c-y*s, houseCY+x*s+y*c)
}

// housePoly is the rectangular footprint, rotated, wound counter-clockwise.
func housePoly() model.Polygon {
	return model.Polygon{
		houseLocal(-houseHalfW, -houseHalfH),
		houseLocal(+houseHalfW, -houseHalfH),
		houseLocal(+houseHalfW, +houseHalfH),
		houseLocal(-houseHalfW, +houseHalfH),
	}
}

// houseRing is the footprint grown by d, used for the guide wire island.
func houseRing(d float64) []model.Vec2 {
	w, h := houseHalfW+d, houseHalfH+d
	return []model.Vec2{
		houseLocal(-w, -h), houseLocal(+w, -h), houseLocal(+w, +h), houseLocal(-w, +h),
	}
}

// dockApproachHeading is the outward wall normal turned around: the heading the
// mower carries as it drives into the pad. It rotates with the house.
func dockApproachHeading() float64 { return angNorm(houseTheta + math.Pi/2) }

// lawnControlPoints are the hand-placed knots of the property boundary, listed
// counter-clockwise from the west side. Spacing is 5-8 m so the sampled curve
// never runs straight for long.
func lawnControlPoints() []model.Vec2 {
	return []model.Vec2{
		v2(2.4, 6.0),   // west, lower
		v2(3.6, 2.6),   // rounded south-west corner
		v2(9.0, 1.8),   // south
		v2(15.5, 2.9),  // shallow bay
		v2(22.0, 1.7),  // bulge towards the road
		v2(29.5, 2.6),  //
		v2(35.8, 4.4),  // south-east corner
		v2(37.9, 9.5),  // east bulge
		v2(36.4, 15.0), // east bay
		v2(37.6, 20.5), // east bulge
		v2(32.0, 25.4), // north-east corner
		v2(24.0, 26.3), // north bulge
		v2(15.0, 25.2), // north bay
		v2(6.5, 26.0),  // north-west
		v2(2.0, 21.0),  // west, upper
		v2(3.2, 13.0),  // west, middle bay
	}
}

// defaultWorld builds the villa garden. rnd is unused today but kept so the
// scene can be randomised later without changing call sites.
func defaultWorld(_ *rand.Rand) model.World {
	// ---- property boundary ----
	boundary := ensureCCW(catmullClosed(lawnControlPoints(), 5)) // 80 vertices
	lawn := model.Polygon(boundary)

	house := housePoly()

	// ---- charging station, against the (rotated) south wall ----
	dock := model.Dock{
		Pos:     houseLocal(dockLocalX, -(houseHalfH + dockStandoff)),
		Heading: dockApproachHeading(),
	}
	door := houseLocal(doorLocalX, -houseHalfH)

	// ---- gravel path: an S from the front door down to the boundary ----
	pathCentre := catmullOpen([]model.Vec2{
		door,
		v2(23.2, 12.6),
		v2(25.6, 9.6),
		v2(22.6, 6.4),
		v2(23.7, 2.5),
	}, 10)
	path := ribbonPolygon(pathCentre, pathHalfWidth)

	// ---- zones: two spline dividers cut the plot into three curved pieces ----
	aWest := nearestIndex(boundary, v2(2.6, 10.0))
	aEast := nearestIndex(boundary, v2(37.5, 11.0))
	bNorth := nearestIndex(boundary, v2(10.5, 25.9))

	// Divider A sweeps west-to-east, well south of the house.
	dividerA := catmullOpen([]model.Vec2{
		boundary[aWest],
		v2(9.0, 11.3), v2(16.0, 10.4), v2(23.0, 12.0), v2(30.0, 10.9),
		boundary[aEast],
	}, 8)
	// Divider B branches off A and runs north, west of the house.
	bStart := nearestIndex(dividerA, v2(11.0, 11.2))
	dividerB := catmullOpen([]model.Vec2{
		dividerA[bStart],
		v2(10.2, 16.5), v2(11.6, 21.0),
		boundary[bNorth],
	}, 8)

	// front lawn: boundary arc round the south, closed by divider A.
	front := append([]model.Vec2{}, ringArc(boundary, aWest, aEast)...)
	ra := reverseVecs(dividerA)
	front = append(front, ra[1:len(ra)-1]...)

	// side strip: west half of A, up divider B, then the north-west boundary.
	side := append([]model.Vec2{}, dividerA[:bStart+1]...)
	side = append(side, dividerB[1:]...)
	arcSide := ringArc(boundary, bNorth, aWest)
	side = append(side, arcSide[1:len(arcSide)-1]...)

	// back lawn: east half of A, the east and north boundary, back down B.
	// The house sits inside this polygon; its cells are simply not lawn.
	back := append([]model.Vec2{}, dividerA[bStart:]...)
	arcBack := ringArc(boundary, aEast, bNorth)
	back = append(back, arcBack[1:]...)
	rb := reverseVecs(dividerB)
	back = append(back, rb[1:len(rb)-1]...)

	zones := []model.Zone{
		{ID: "z-front", Name: "front lawn", Area: model.Polygon(front)},
		{ID: "z-back", Name: "back lawn", Area: model.Polygon(back)},
		{ID: "z-side", Name: "side strip", Area: model.Polygon(side)},
	}

	// ---- guide wire ----
	wire := buildGuideWire(boundary, dock)

	// ---- scenery ----
	// The flower bed is three overlapping discs following the eastern
	// boundary, so it reads as one long curved bed rather than a circle.
	obstacles := []model.Obstacle{
		{ID: "obs-tree-1", Type: "tree", Pos: v2(7.5, 9.5), Radius: 0.8},
		{ID: "obs-tree-2", Type: "tree", Pos: v2(31.5, 7.5), Radius: 0.8},
		{ID: "obs-bed-1", Type: "flowerbed", Pos: v2(32.4, 21.6), Radius: 1.15},
		{ID: "obs-bed-2", Type: "flowerbed", Pos: v2(33.9, 19.9), Radius: 1.15},
		{ID: "obs-bed-3", Type: "flowerbed", Pos: v2(34.6, 17.9), Radius: 1.15},
	}

	return model.World{
		Name:      "Villa Björkbacken",
		Width:     worldW,
		Height:    worldH,
		Lawn:      []model.Polygon{lawn},
		House:     house,
		Paths:     []model.Polygon{path},
		Dock:      dock,
		GuideWire: wire,
		Obstacles: obstacles,
		Zones:     zones,
		GrassCell: grassCellSize,
	}
}

// buildGuideWire lays one closed loop: round the property just inside the
// edge, then out along a curved spur to the house island, once around the
// house, and back down the same spur — exactly how a real boundary wire
// handles an island. The spur runs through the charging station, so a mower
// following the wire is led home. Because the spur is walked twice the loop is
// a zero-width slit, which the even-odd point-in-polygon test in
// insideWireLoop handles correctly.
func buildGuideWire(boundary []model.Vec2, dock model.Dock) []model.Vec2 {
	outer := offsetRing(boundary, wireInset)

	// Where the spur meets the house island: straight in from the pad along
	// the wall normal, which lands on the island's south edge.
	spurHead := houseLocal(dockLocalX, -(houseHalfH + wireInset))

	foot := nearestIndex(outer, v2(18.0, 2.0))
	spurUp := catmullOpen([]model.Vec2{
		outer[foot],
		v2(18.4, 6.5), v2(19.4, 10.5),
		dock.Pos,
		spurHead,
	}, 6)

	// The island walked once, starting and ending where the spur meets it.
	island := houseRing(wireInset) // corners: SW, SE, NE, NW in house frame
	loop := []model.Vec2{spurHead, island[1], island[2], island[3], island[0], spurHead}

	n := len(outer)
	wire := make([]model.Vec2, 0, n+len(spurUp)*2+len(loop)+2)
	for i := 0; i <= n; i++ { // all the way round, closing back on the foot
		wire = append(wire, outer[(foot+i)%n])
	}
	wire = append(wire, spurUp[1:]...) // up the spur, through the dock
	wire = append(wire, loop[1:]...)   // once around the house
	down := reverseVecs(spurUp)
	wire = append(wire, down[1:len(down)-1]...) // back down; the closing
	// segment of the polygon rejoins outer[foot].
	return wire
}

// onLawn reports whether p lies on mowable lawn (house and paths excluded —
// the path polygon overlaps the lawn, so test it first).
func (e *engine) onLawn(p model.Vec2) bool {
	if pointInPolygon(p, e.world.House) {
		return false
	}
	for _, pp := range e.world.Paths {
		if pointInPolygon(p, pp) {
			return false
		}
	}
	for _, lp := range e.world.Lawn {
		if pointInPolygon(p, lp) {
			return true
		}
	}
	return false
}

// drivable reports whether the robot's centre may be at p: lawn or path, never
// the house, never the ground outside the property boundary.
func (e *engine) drivable(p model.Vec2) bool {
	if pointInPolygon(p, e.world.House) {
		return false
	}
	for _, pp := range e.world.Paths {
		if pointInPolygon(p, pp) {
			return true
		}
	}
	for _, lp := range e.world.Lawn {
		if pointInPolygon(p, lp) {
			return true
		}
	}
	return false
}

// blockedAt reports whether the robot body (a disc of robotRadius) may be
// centred at p. The second return is the world point to blame for the contact,
// used to derive the bump bearing.
func (e *engine) blockedAt(p model.Vec2) (bool, model.Vec2) {
	// Perimeter fence (belt and braces: the property edge stops us first).
	if p.X < robotRadius || p.X > worldW-robotRadius || p.Y < robotRadius || p.Y > worldH-robotRadius {
		return true, p
	}
	if !e.drivable(p) {
		return true, p
	}
	if d, c := distToPolyline(p, polyPoints(e.world.House), true); d < robotRadius {
		return true, c
	}
	for i := range e.world.Obstacles {
		o := &e.world.Obstacles[i]
		if dist(p, o.Pos) < o.Radius+robotRadius {
			return true, o.Pos
		}
	}
	return false, p
}

// insideWireLoop reports whether p is inside the closed boundary-wire loop.
// This is what a real automower's loop sensor measures (the wire signal is
// polarity coded, so inside and outside are distinguishable). Even-odd
// counting is what makes the doubled spur behave as a zero-width slit.
func (e *engine) insideWireLoop(p model.Vec2) bool {
	return pointInPolygon(p, model.Polygon(e.world.GuideWire))
}

// zonePolygon looks a zone up by name (case sensitive, as published).
func (e *engine) zonePolygon(name string) (model.Polygon, bool) {
	for _, z := range e.world.Zones {
		if z.Name == name {
			return z.Area, true
		}
	}
	return nil, false
}
