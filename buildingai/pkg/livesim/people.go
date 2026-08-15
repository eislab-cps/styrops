package livesim

import (
	"fmt"
	"math"
	"math/rand"
	"sort"
	"time"

	"github.com/styrops/buildingai/pkg/graph"
)

type role string

const (
	roleStudent role = "student"
	roleStaff   role = "staff"
)

const (
	stateWalking = "walking"
	stateInRoom  = "in_room"
	stateAway    = "away"
)

// staffFraction of the population are employees with an office; the rest are
// students belonging to a class.
const staffFraction = 0.35

// studentsPerClass sizes the cohorts that share a timetable.
const studentsPerClass = 20

// person is one simulated human. The static half (who they are, where they
// belong) is fixed at creation; the dynamic half is integrated every tick.
type person struct {
	index int
	id    string
	name  string
	role  role
	class int // students only

	icon     string  // "man" | "woman", matches the viewer's icon names
	home     RoomKey // office (staff) or study hall (student)
	lunch    RoomKey
	meeting  RoomKey // staff only
	entrance int     // graph node the person enters and leaves through

	// dynamic state
	inside  bool
	node    int     // graph node currently occupied (or walked away from)
	path    []int   // remaining nodes, path[0] is the node being walked to
	segDone float64 // distance already walked along the current segment
	exiting bool    // the current path ends outside the building

	target   RoomKey // where the schedule wants this person
	inRoom   RoomKey // room actually occupied right now (empty while walking)
	hasPlan  bool
	state    string
	x, y     float64
	level    string
	heading  float64
	offsetUX float64 // unit-circle offset, scaled by room radius on arrival
	offsetUY float64
}

// Names are split by the icon the viewer would draw, so a simulated "Hanna"
// is not rendered with the man icon.
var firstNamesByIcon = map[string][]string{
	"man": {
		"Erik", "Johan", "Lars", "Anders", "Per", "Nils", "Mikael", "Gustav",
		"Oskar", "Henrik", "Emil", "Viktor", "Tobias", "Daniel", "Fredrik", "Simon",
	},
	"woman": {
		"Anna", "Maria", "Karin", "Eva", "Sara", "Elin", "Ida", "Linnea",
		"Frida", "Malin", "Hanna", "Klara", "Sofia", "Amanda", "Julia", "Moa",
	},
}

var lastNames = []string{
	"Andersson", "Johansson", "Karlsson", "Nilsson", "Eriksson", "Larsson",
	"Olsson", "Persson", "Svensson", "Gustafsson", "Pettersson", "Jonsson",
	"Lindberg", "Bergström", "Lundqvist", "Sandberg", "Holm", "Forsberg",
	"Wikström", "Öberg", "Häggström", "Nyström", "Sjögren", "Ek",
}

// personName draws a name and the matching icon.
func personName(rng *rand.Rand) (name, icon string) {
	icon = "man"
	if rng.Intn(2) == 0 {
		icon = "woman"
	}
	first := firstNamesByIcon[icon]
	return first[rng.Intn(len(first))] + " " + lastNames[rng.Intn(len(lastNames))], icon
}

// buildPopulation creates the people and their fixed room assignments.
// Returns the population and the number of student classes.
func (s *Sim) buildPopulation(rng *rand.Rand) ([]*person, int) {
	w := s.w
	total := s.cfg.People
	staffCount := int(math.Round(float64(total) * staffFraction))
	if staffCount < 1 && total > 0 {
		staffCount = 1
	}
	if staffCount > total {
		staffCount = total
	}
	studentCount := total - staffCount
	classes := (studentCount + studentsPerClass - 1) / studentsPerClass
	if classes < 1 {
		classes = 1
	}

	// Room pools, with graceful fallbacks so the simulation also runs on tiny
	// test fixtures that have no lecture halls or offices at all.
	offices := firstNonEmpty(w.offices, w.meetings, w.lectures, w.halls, w.ordered)
	studyPool := firstNonEmpty(w.halls, w.lectures, w.meetings, w.ordered)
	meetingPool := firstNonEmpty(w.meetings, w.lectures, w.offices, w.ordered)

	// Lunch happens in the biggest hall on each floor, so the lunch rush also
	// puts people on the stairs.
	var lunchPool []*Room
	byLevel := pickPerLevel(firstNonEmpty(w.halls, w.lectures, w.ordered), w.levels)
	for _, lvl := range w.levels {
		if r, ok := byLevel[lvl]; ok {
			lunchPool = append(lunchPool, r)
		}
	}
	if len(lunchPool) == 0 {
		lunchPool = largest(firstNonEmpty(w.halls, w.lectures, w.ordered), 3)
	}

	// One study space per class, spread across the whole pool (which is sorted
	// by level, so a modulo would put every class on the ground floor).
	studyRooms := make([]RoomKey, classes)
	for c := 0; c < classes; c++ {
		if len(studyPool) > 0 {
			studyRooms[c] = studyPool[spreadIndex(c, classes, len(studyPool))].Key
		}
	}

	people := make([]*person, 0, total)
	for i := 0; i < total; i++ {
		name, icon := personName(rng)
		p := &person{
			index: i,
			id:    fmt.Sprintf("sim-p%03d", i+1),
			name:  name,
			icon:  icon,
			state: stateAway,
		}
		if i < staffCount {
			p.role = roleStaff
			if len(offices) > 0 {
				p.home = offices[spreadIndex(i, staffCount, len(offices))].Key
			}
			if len(meetingPool) > 0 {
				p.meeting = meetingPool[spread(hashInts(s.cfg.Seed+3, i), len(meetingPool))].Key
			}
		} else {
			p.role = roleStudent
			p.class = (i - staffCount) % classes
			p.home = studyRooms[p.class]
		}
		if len(lunchPool) > 0 {
			p.lunch = lunchPool[spread(hashInts(s.cfg.Seed+5, i), len(lunchPool))].Key
		}
		if len(w.entrances) > 0 {
			p.entrance = w.entrances[spread(hashInts(s.cfg.Seed+11, i), len(w.entrances))]
		}
		p.node = p.entrance
		// Fixed unit-circle offset so people sitting in the same room are
		// scattered instead of stacked, and stay put while they sit.
		a := rng.Float64() * 2 * math.Pi
		r := math.Sqrt(rng.Float64())
		p.offsetUX = math.Cos(a) * r
		p.offsetUY = math.Sin(a) * r
		people = append(people, p)
	}
	return people, classes
}

// spreadIndex maps item i of n evenly over a pool of size poolLen. Room pools
// are sorted by (level, name), so spreading rather than taking the first n
// keeps the population from piling onto the ground floor.
func spreadIndex(i, n, poolLen int) int {
	if poolLen <= 0 {
		return 0
	}
	if n <= 1 {
		return 0
	}
	idx := i * poolLen / n
	if idx >= poolLen {
		idx = poolLen - 1
	}
	return idx
}

func firstNonEmpty(pools ...[]*Room) []*Room {
	for _, p := range pools {
		if len(p) > 0 {
			return p
		}
	}
	return nil
}

// largest returns up to n rooms with the biggest area, ties broken by key so
// the result is stable across runs.
func largest(rooms []*Room, n int) []*Room {
	sorted := append([]*Room(nil), rooms...)
	sort.SliceStable(sorted, func(i, j int) bool {
		a, b := sorted[i], sorted[j]
		if a.Area != b.Area {
			return a.Area > b.Area
		}
		if a.Key.Level != b.Key.Level {
			return a.Key.Level < b.Key.Level
		}
		return a.Key.Name < b.Key.Name
	})
	if len(sorted) > n {
		sorted = sorted[:n]
	}
	return sorted
}

// updatePerson re-targets if the schedule moved on, then walks for dt seconds
// of simulated time.
func (s *Sim) updatePerson(p *person, now time.Time, dt float64) {
	desired := s.desiredRoom(p, now)
	if !p.hasPlan || desired != p.target {
		p.target = desired
		p.hasPlan = true
		s.retarget(p)
	}

	if p.inside && len(p.path) > 0 {
		s.walk(p, s.cfg.WalkSpeed*dt)
	}
	s.place(p)
}

// retarget recomputes the route for a person whose destination changed.
func (s *Sim) retarget(p *person) {
	if p.target.zero() {
		if !p.inside {
			return
		}
		p.exiting = true
		p.inRoom = RoomKey{}
		s.routeTo(p, p.entrance)
		return
	}

	room := s.w.rooms[p.target]
	if room == nil {
		// Destination vanished from the model: treat as outside.
		p.target = RoomKey{}
		p.inRoom = RoomKey{}
		if p.inside {
			p.exiting = true
			s.routeTo(p, p.entrance)
		}
		return
	}

	if !p.inside {
		p.inside = true
		p.node = p.entrance
		p.path = nil
		p.segDone = 0
	}
	p.exiting = false
	p.inRoom = RoomKey{}
	s.routeTo(p, room.Node)
}

// routeTo plans a walk over the real multi-floor navigation graph.
func (s *Sim) routeTo(p *person, dest int) {
	p.segDone = 0
	p.path = p.path[:0]
	if p.node == dest {
		return
	}
	res := graph.ShortestPath(s.w.graph, p.node, dest)
	if res == nil || len(res.Path) < 2 {
		// The A-building graph is a single connected component, so this only
		// happens on degenerate data. Snap rather than strand the person.
		p.node = dest
		return
	}
	for _, n := range res.Path[1:] {
		p.path = append(p.path, n.RoomID)
	}
}

// walk consumes dist floor-plan units along the planned path, crossing as many
// graph edges as the step covers.
func (s *Sim) walk(p *person, dist float64) {
	for dist > 0 && len(p.path) > 0 {
		next := p.path[0]
		segLen := s.w.segmentLength(p.node, next)
		if segLen <= 0 {
			p.node = next
			p.path = p.path[1:]
			p.segDone = 0
			continue
		}
		remain := segLen - p.segDone
		if dist < remain {
			p.segDone += dist
			return
		}
		dist -= remain
		p.node = next
		p.path = p.path[1:]
		p.segDone = 0
	}
	if len(p.path) == 0 {
		p.segDone = 0
		if p.exiting {
			p.inside = false
			p.exiting = false
			p.inRoom = RoomKey{}
			p.state = stateAway
		}
	}
}

// place derives the rendered position from the graph state. While walking, the
// position is exactly on the segment between two adjacent graph nodes; while
// sitting in a room it is the room node plus a fixed per-person offset.
func (s *Sim) place(p *person) {
	if !p.inside {
		p.state = stateAway
		p.inRoom = RoomKey{}
		return
	}
	n := s.w.node(p.node)
	if n == nil {
		return
	}
	if len(p.path) > 0 {
		m := s.w.node(p.path[0])
		if m == nil {
			return
		}
		segLen := s.w.segmentLength(p.node, p.path[0])
		f := 0.0
		if segLen > 0 {
			f = p.segDone / segLen
		}
		if n.Level != m.Level {
			// Stairs/elevator: the two ends are on different floors, so the
			// person is shown at the near end, then at the far end.
			if f < 0.5 {
				p.x, p.y, p.level = n.X, n.Y, n.Level
			} else {
				p.x, p.y, p.level = m.X, m.Y, m.Level
			}
		} else {
			p.x = n.X + (m.X-n.X)*f
			p.y = n.Y + (m.Y-n.Y)*f
			p.level = n.Level
			if m.X != n.X || m.Y != n.Y {
				p.heading = headingDeg(n.X, n.Y, m.X, m.Y)
			}
		}
		p.state = stateWalking
		p.inRoom = RoomKey{}
		return
	}

	p.state = stateInRoom
	p.level = n.Level
	p.inRoom = RoomKey{}
	radius := 0.6
	if room := s.w.rooms[p.target]; room != nil && room.Node == p.node {
		p.inRoom = room.Key
		radius = room.Radius
	}
	p.x = n.X + p.offsetUX*radius
	p.y = n.Y + p.offsetUY*radius
}

// headingDeg is the direction of travel in the *viewer's* world space:
// degrees counter-clockwise from +X. The viewer maps floor-plan (PDF) points
// with world = (x - pageWidth/2, -(y - pageHeight/2)), so the Y axis flips and
// the heading is computed from -dy.
func headingDeg(x1, y1, x2, y2 float64) float64 {
	d := math.Atan2(-(y2-y1), x2-x1) * 180 / math.Pi
	if d < 0 {
		d += 360
	}
	return d
}
