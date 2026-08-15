package sim

// geom.go — small 2D geometry helpers. All lengths in meters, angles in
// radians, CCW-positive, 0 rad = +X. Nothing here touches engine state, so it
// is safe to call from anywhere.

import (
	"math"

	"github.com/styrops/huskvarna-demo/pkg/model"
)

func v2(x, y float64) model.Vec2 { return model.Vec2{X: x, Y: y} }

func dist(a, b model.Vec2) float64 { return math.Hypot(a.X-b.X, a.Y-b.Y) }

func clamp(x, lo, hi float64) float64 {
	if x < lo {
		return lo
	}
	if x > hi {
		return hi
	}
	return x
}

// approach moves cur towards target by at most step (acceleration limiting).
func approach(cur, target, step float64) float64 {
	if target > cur {
		return math.Min(target, cur+step)
	}
	return math.Max(target, cur-step)
}

// angNorm wraps an angle into (-pi, pi].
func angNorm(a float64) float64 {
	a = math.Mod(a+math.Pi, 2*math.Pi)
	if a <= 0 {
		a += 2 * math.Pi
	}
	return a - math.Pi
}

// angDiff returns the signed shortest rotation from b to a, in (-pi, pi].
func angDiff(a, b float64) float64 { return angNorm(a - b) }

func cross(ax, ay, bx, by float64) float64 { return ax*by - ay*bx }

// rectPoly builds an axis-aligned rectangle polygon (CCW).
func rectPoly(x0, y0, x1, y1 float64) model.Polygon {
	return model.Polygon{v2(x0, y0), v2(x1, y0), v2(x1, y1), v2(x0, y1)}
}

// pointInPolygon is a standard even-odd ray cast. Points exactly on an edge
// are undefined (fine: the grid is 0.25 m and the robot is 0.35 m).
func pointInPolygon(p model.Vec2, poly model.Polygon) bool {
	in := false
	n := len(poly)
	for i, j := 0, n-1; i < n; j, i = i, i+1 {
		pi, pj := poly[i], poly[j]
		if (pi.Y > p.Y) != (pj.Y > p.Y) {
			x := (pj.X-pi.X)*(p.Y-pi.Y)/(pj.Y-pi.Y) + pi.X
			if p.X < x {
				in = !in
			}
		}
	}
	return in
}

// distPointSeg returns the distance from p to segment a-b and the closest point.
func distPointSeg(p, a, b model.Vec2) (float64, model.Vec2) {
	ex, ey := b.X-a.X, b.Y-a.Y
	l2 := ex*ex + ey*ey
	if l2 < 1e-12 {
		return dist(p, a), a
	}
	t := clamp(((p.X-a.X)*ex+(p.Y-a.Y)*ey)/l2, 0, 1)
	c := v2(a.X+t*ex, a.Y+t*ey)
	return dist(p, c), c
}

// distToPolyline returns the distance from p to the polyline pts and the
// nearest point on it. closed=true adds the last->first segment.
func distToPolyline(p model.Vec2, pts []model.Vec2, closed bool) (float64, model.Vec2) {
	best := math.Inf(1)
	var bp model.Vec2
	n := len(pts)
	if n == 0 {
		return best, p
	}
	if n == 1 {
		return dist(p, pts[0]), pts[0]
	}
	last := n - 1
	if closed {
		last = n
	}
	for i := 0; i < last; i++ {
		a := pts[i]
		b := pts[(i+1)%n]
		d, c := distPointSeg(p, a, b)
		if d < best {
			best, bp = d, c
		}
	}
	return best, bp
}

func polyPoints(poly model.Polygon) []model.Vec2 { return []model.Vec2(poly) }

// polygonArea is the absolute shoelace area in m^2.
func polygonArea(poly model.Polygon) float64 {
	s := 0.0
	n := len(poly)
	for i, j := 0, n-1; i < n; j, i = i, i+1 {
		s += (poly[j].X + poly[i].X) * (poly[j].Y - poly[i].Y)
	}
	return math.Abs(s) / 2
}

// rayCircle returns the distance along the unit ray (ox,oy)+(dx,dy)*t at which
// it first enters the circle, or false. Rays starting inside return t=0.
func rayCircle(o model.Vec2, dx, dy float64, c model.Vec2, r float64) (float64, bool) {
	fx, fy := o.X-c.X, o.Y-c.Y
	b := 2 * (fx*dx + fy*dy)
	cc := fx*fx + fy*fy - r*r
	if cc <= 0 {
		return 0, true
	}
	disc := b*b - 4*cc
	if disc < 0 {
		return 0, false
	}
	sq := math.Sqrt(disc)
	t := (-b - sq) / 2
	if t < 0 {
		t = (-b + sq) / 2
	}
	if t < 0 {
		return 0, false
	}
	return t, true
}

// raySegment returns the distance along the unit ray at which it crosses
// segment a-b, or false.
func raySegment(o model.Vec2, dx, dy float64, a, b model.Vec2) (float64, bool) {
	ex, ey := b.X-a.X, b.Y-a.Y
	den := cross(dx, dy, ex, ey)
	if math.Abs(den) < 1e-12 {
		return 0, false
	}
	qx, qy := a.X-o.X, a.Y-o.Y
	t := cross(qx, qy, ex, ey) / den
	u := cross(qx, qy, dx, dy) / den
	if t < 0 || u < 0 || u > 1 {
		return 0, false
	}
	return t, true
}

// rayPolygon casts against every edge of a closed polygon.
func rayPolygon(o model.Vec2, dx, dy float64, poly model.Polygon) (float64, bool) {
	best := math.Inf(1)
	hit := false
	n := len(poly)
	for i := 0; i < n; i++ {
		if t, ok := raySegment(o, dx, dy, poly[i], poly[(i+1)%n]); ok && t < best {
			best, hit = t, true
		}
	}
	return best, hit
}

// ---- curve construction (used by the world builder) ----

// catmullPoint evaluates a uniform Catmull-Rom segment p1->p2 at t in [0,1].
func catmullPoint(p0, p1, p2, p3 model.Vec2, t float64) model.Vec2 {
	t2, t3 := t*t, t*t*t
	f := func(a, b, c, d float64) float64 {
		return 0.5 * (2*b + (-a+c)*t + (2*a-5*b+4*c-d)*t2 + (-a+3*b-3*c+d)*t3)
	}
	return model.Vec2{
		X: f(p0.X, p1.X, p2.X, p3.X),
		Y: f(p0.Y, p1.Y, p2.Y, p3.Y),
	}
}

// catmullClosed samples a closed Catmull-Rom spline through ctrl, per samples
// per control segment. The result is a polygon with len(ctrl)*per vertices and
// no repeated closing vertex.
func catmullClosed(ctrl []model.Vec2, per int) []model.Vec2 {
	n := len(ctrl)
	out := make([]model.Vec2, 0, n*per)
	for i := 0; i < n; i++ {
		p0, p1 := ctrl[(i-1+n)%n], ctrl[i]
		p2, p3 := ctrl[(i+1)%n], ctrl[(i+2)%n]
		for k := 0; k < per; k++ {
			out = append(out, catmullPoint(p0, p1, p2, p3, float64(k)/float64(per)))
		}
	}
	return out
}

// catmullOpen samples an open Catmull-Rom spline; the first and last control
// points are reflected so the curve starts and ends exactly on them.
func catmullOpen(ctrl []model.Vec2, per int) []model.Vec2 {
	n := len(ctrl)
	if n < 2 {
		return append([]model.Vec2(nil), ctrl...)
	}
	ext := make([]model.Vec2, 0, n+2)
	ext = append(ext, model.Vec2{X: 2*ctrl[0].X - ctrl[1].X, Y: 2*ctrl[0].Y - ctrl[1].Y})
	ext = append(ext, ctrl...)
	ext = append(ext, model.Vec2{X: 2*ctrl[n-1].X - ctrl[n-2].X, Y: 2*ctrl[n-1].Y - ctrl[n-2].Y})

	out := make([]model.Vec2, 0, (n-1)*per+1)
	for i := 1; i+2 < len(ext); i++ {
		for k := 0; k < per; k++ {
			out = append(out, catmullPoint(ext[i-1], ext[i], ext[i+1], ext[i+2], float64(k)/float64(per)))
		}
	}
	return append(out, ctrl[n-1])
}

// leftNormal is the unit normal 90 degrees to the left of a->b. For a
// counter-clockwise polygon that points into the interior.
func leftNormal(a, b model.Vec2) model.Vec2 {
	dx, dy := b.X-a.X, b.Y-a.Y
	l := math.Hypot(dx, dy)
	if l < 1e-12 {
		return model.Vec2{}
	}
	return model.Vec2{X: -dy / l, Y: dx / l}
}

// signedArea is positive for a counter-clockwise ring.
func signedArea(pts []model.Vec2) float64 {
	s := 0.0
	n := len(pts)
	for i, j := 0, n-1; i < n; j, i = i, i+1 {
		s += (pts[j].X * pts[i].Y) - (pts[i].X * pts[j].Y)
	}
	return s / 2
}

// ensureCCW returns pts wound counter-clockwise.
func ensureCCW(pts []model.Vec2) []model.Vec2 {
	if signedArea(pts) >= 0 {
		return pts
	}
	return reverseVecs(pts)
}

func reverseVecs(pts []model.Vec2) []model.Vec2 {
	out := make([]model.Vec2, len(pts))
	for i, p := range pts {
		out[len(pts)-1-i] = p
	}
	return out
}

// offsetRing moves every vertex of a closed CCW ring by d along the vertex
// normal: positive d shrinks the ring, negative grows it. Only valid for small
// d relative to the local curvature, which is all the world builder needs.
func offsetRing(pts []model.Vec2, d float64) []model.Vec2 {
	n := len(pts)
	out := make([]model.Vec2, n)
	for i := 0; i < n; i++ {
		n1 := leftNormal(pts[(i-1+n)%n], pts[i])
		n2 := leftNormal(pts[i], pts[(i+1)%n])
		nx, ny := n1.X+n2.X, n1.Y+n2.Y
		l := math.Hypot(nx, ny)
		if l < 1e-9 {
			nx, ny, l = n2.X, n2.Y, 1
		}
		out[i] = model.Vec2{X: pts[i].X + d*nx/l, Y: pts[i].Y + d*ny/l}
	}
	return out
}

// ribbonPolygon thickens a centreline into a closed polygon halfW either side.
func ribbonPolygon(centre []model.Vec2, halfW float64) model.Polygon {
	n := len(centre)
	left := make([]model.Vec2, n)
	right := make([]model.Vec2, n)
	for i := range centre {
		a, b := centre[i], centre[i]
		switch {
		case i == 0:
			a, b = centre[0], centre[1]
		case i == n-1:
			a, b = centre[n-2], centre[n-1]
		default:
			a, b = centre[i-1], centre[i+1]
		}
		nrm := leftNormal(a, b)
		left[i] = model.Vec2{X: centre[i].X + halfW*nrm.X, Y: centre[i].Y + halfW*nrm.Y}
		right[i] = model.Vec2{X: centre[i].X - halfW*nrm.X, Y: centre[i].Y - halfW*nrm.Y}
	}
	poly := make(model.Polygon, 0, 2*n)
	poly = append(poly, left...)
	for i := n - 1; i >= 0; i-- {
		poly = append(poly, right[i])
	}
	return poly
}

// nearestIndex returns the index of the point in pts closest to p.
func nearestIndex(pts []model.Vec2, p model.Vec2) int {
	best, bd := 0, math.Inf(1)
	for i, q := range pts {
		if d := dist(p, q); d < bd {
			best, bd = i, d
		}
	}
	return best
}

// ringArc walks a closed ring forward from index a to index b, inclusive.
func ringArc(pts []model.Vec2, a, b int) []model.Vec2 {
	n := len(pts)
	out := make([]model.Vec2, 0, n)
	for i := a; ; i = (i + 1) % n {
		out = append(out, pts[i])
		if i == b {
			break
		}
	}
	return out
}
