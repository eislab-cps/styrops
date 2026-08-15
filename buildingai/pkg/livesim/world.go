package livesim

import (
	"math"
	"sort"

	"github.com/styrops/buildingai/pkg/model"
	"github.com/styrops/buildingai/pkg/store"
)

// RoomClass is how the simulation reads a room out of the floor plan. The
// floor-plan data only says "room" or "corridor", so everything else is
// inferred from area -- the same way you would guess from a printed plan.
type RoomClass string

const (
	ClassCorridor RoomClass = "corridor" // circulation, never a destination
	ClassService  RoomClass = "service"  // shafts, closets, WCs -- too small to occupy
	ClassOffice   RoomClass = "office"   // staff rooms
	ClassMeeting  RoomClass = "meeting"  // seminar / group rooms
	ClassLecture  RoomClass = "lecture"  // lecture halls, teaching rooms
	ClassHall     RoomClass = "hall"     // labs, workshops, atria, canteen
)

// Area thresholds (m^2). The A-building plans are metric: polygon areas match
// the `area` field, and walkable-graph edge weights are euclidean distances in
// the same units.
const (
	serviceMaxArea = 10.0
	officeMaxArea  = 60.0
	meetingMaxArea = 120.0
	lectureMaxArea = 400.0
)

// RoomKey identifies a room across the whole building. Room *names* repeat
// between floors (level0 and level1 both have an "A117") and room *ids* are
// per-floor integers, so neither alone is unique.
type RoomKey struct {
	Level string `json:"level"`
	Name  string `json:"name"`
}

func (k RoomKey) zero() bool { return k.Level == "" && k.Name == "" }

// Room is one occupiable room, joined from floor-plan geometry and the
// multi-floor walkable graph.
type Room struct {
	Key      RoomKey
	ID       int // room id within its own floor (the /api/occupancy key)
	Class    RoomClass
	Area     float64
	Center   [2]float64 // PDF/floor-plan coordinates
	Node     int        // node id in the multi-floor walkable graph
	Capacity int        // plausible number of people
	Radius   float64    // in-room scatter radius, floor-plan units
}

// world is the static, read-only part of the simulation: geometry, graph and
// the room sets the schedule draws from. Built once at New.
type world struct {
	graph    *model.NavGraph
	nodeIdx  map[int]int // node id -> index into graph.Nodes
	rooms    map[RoomKey]*Room
	ordered  []*Room // deterministic order: level, then name
	lectures []*Room
	meetings []*Room
	offices  []*Room
	halls    []*Room

	entrances []int // graph node ids used as building entrances
	levels    []string
}

func classify(r model.Room) RoomClass {
	if r.Type == "corridor" {
		return ClassCorridor
	}
	switch {
	case r.Area < serviceMaxArea:
		return ClassService
	case r.Area < officeMaxArea:
		return ClassOffice
	case r.Area < meetingMaxArea:
		return ClassMeeting
	case r.Area < lectureMaxArea:
		return ClassLecture
	default:
		return ClassHall
	}
}

// capacityFor is a plausible headcount: dense in teaching rooms, sparse in
// offices and halls.
func capacityFor(class RoomClass, area float64) int {
	var perPerson float64
	switch class {
	case ClassLecture:
		perPerson = 2.0
	case ClassMeeting:
		perPerson = 3.0
	case ClassOffice:
		perPerson = 12.0
	case ClassHall:
		perPerson = 8.0
	default:
		perPerson = 10.0
	}
	c := int(area / perPerson)
	if c < 1 {
		c = 1
	}
	if c > 250 {
		c = 250
	}
	return c
}

// buildWorld joins the floor plans with the multi-floor walkable graph.
func buildWorld(st *store.MemoryStore) *world {
	g := st.GetMultiFloorGraph()
	w := &world{
		graph:   g,
		nodeIdx: map[int]int{},
		rooms:   map[RoomKey]*Room{},
	}
	if g == nil {
		return w
	}
	for i := range g.Nodes {
		w.nodeIdx[g.Nodes[i].ID] = i
	}

	// (level, room name) -> graph node id, preferring nodes of type "room"
	// (they sit inside the room; "entry" nodes sit in the doorway).
	roomNode := map[RoomKey]int{}
	for i := range g.Nodes {
		n := &g.Nodes[i]
		if n.Type != "room" {
			continue
		}
		k := RoomKey{Level: n.Level, Name: n.Name}
		if _, seen := roomNode[k]; !seen {
			roomNode[k] = n.ID
		}
	}

	building := st.GetBuilding()
	for _, lvl := range building.Levels {
		w.levels = append(w.levels, lvl.ID)
		fd, ok := st.GetFloorData(lvl.ID)
		if !ok || fd == nil {
			continue
		}
		for _, r := range fd.Rooms {
			if r.Name == "" {
				continue
			}
			k := RoomKey{Level: lvl.ID, Name: r.Name}
			if _, dup := w.rooms[k]; dup {
				continue
			}
			class := classify(r)
			if class == ClassCorridor {
				continue
			}
			node, hasNode := roomNode[k]
			if !hasNode {
				continue // unreachable on the walkable graph: not a destination
			}
			room := &Room{
				Key:      k,
				ID:       r.ID,
				Class:    class,
				Area:     r.Area,
				Center:   r.Center,
				Node:     node,
				Capacity: capacityFor(class, r.Area),
				Radius:   scatterRadius(r.Area),
			}
			w.rooms[k] = room
		}
	}

	for _, r := range w.rooms {
		w.ordered = append(w.ordered, r)
	}
	sort.Slice(w.ordered, func(i, j int) bool {
		a, b := w.ordered[i], w.ordered[j]
		if a.Key.Level != b.Key.Level {
			return a.Key.Level < b.Key.Level
		}
		return a.Key.Name < b.Key.Name
	})
	for _, r := range w.ordered {
		switch r.Class {
		case ClassLecture:
			w.lectures = append(w.lectures, r)
		case ClassMeeting:
			w.meetings = append(w.meetings, r)
		case ClassOffice:
			w.offices = append(w.offices, r)
		case ClassHall:
			w.halls = append(w.halls, r)
		}
	}
	w.entrances = w.pickEntrances()
	return w
}

// scatterRadius keeps people from stacking on the exact room node while they
// are sitting in a room, without pushing them through walls.
func scatterRadius(area float64) float64 {
	r := math.Sqrt(math.Max(area, 1)) * 0.25
	if r > 4 {
		r = 4
	}
	if r < 0.4 {
		r = 0.4
	}
	return r
}

// pickEntrances chooses synthetic building entrances: the floor plans carry no
// entrance markers, so we take corridor nodes on the ground floor that are as
// far apart as possible (farthest-point sampling, deterministic).
func (w *world) pickEntrances() []int {
	var cands []*model.NavNode
	ground := ""
	if len(w.levels) > 0 {
		ground = w.levels[0]
	}
	for i := range w.graph.Nodes {
		n := &w.graph.Nodes[i]
		if n.Level == ground && n.Type == "corridor" {
			cands = append(cands, n)
		}
	}
	if len(cands) == 0 {
		for i := range w.graph.Nodes {
			cands = append(cands, &w.graph.Nodes[i])
		}
	}
	if len(cands) == 0 {
		return nil
	}
	sort.Slice(cands, func(i, j int) bool { return cands[i].ID < cands[j].ID })

	// Seed with the node farthest from the centroid, then greedily add the
	// node farthest from everything picked so far.
	var cx, cy float64
	for _, n := range cands {
		cx += n.X
		cy += n.Y
	}
	cx /= float64(len(cands))
	cy /= float64(len(cands))

	picked := []*model.NavNode{}
	best, bestD := cands[0], -1.0
	for _, n := range cands {
		if d := math.Hypot(n.X-cx, n.Y-cy); d > bestD {
			best, bestD = n, d
		}
	}
	picked = append(picked, best)
	for len(picked) < 3 && len(picked) < len(cands) {
		best, bestD = nil, -1.0
		for _, n := range cands {
			minD := math.MaxFloat64
			for _, p := range picked {
				if d := math.Hypot(n.X-p.X, n.Y-p.Y); d < minD {
					minD = d
				}
			}
			if minD > bestD {
				best, bestD = n, minD
			}
		}
		if best == nil {
			break
		}
		picked = append(picked, best)
	}
	ids := make([]int, 0, len(picked))
	for _, n := range picked {
		ids = append(ids, n.ID)
	}
	return ids
}

func (w *world) node(id int) *model.NavNode {
	i, ok := w.nodeIdx[id]
	if !ok {
		return nil
	}
	return &w.graph.Nodes[i]
}

// segmentLength is the distance between two adjacent graph nodes. Cross-floor
// edges (stairs, elevators) connect nodes on different floors where planar
// distance is meaningless, so they get a fixed traversal length.
const crossFloorLength = 20.0

func (w *world) segmentLength(a, b int) float64 {
	na, nb := w.node(a), w.node(b)
	if na == nil || nb == nil {
		return 0
	}
	if na.Level != nb.Level {
		return crossFloorLength
	}
	return math.Hypot(nb.X-na.X, nb.Y-na.Y)
}

// roomsFitting keeps the rooms that comfortably seat a class of n: big enough
// to hold them, small enough that the room is not mostly empty. Booking a
// 20-student class into a 400 m^2 hall would be both unrealistic and invisible
// in the CO2 model. Falls back to the whole pool if nothing fits.
func roomsFitting(rooms []*Room, n int) []*Room {
	if n <= 0 {
		return rooms
	}
	lo, hi := float64(n)*2.0, float64(n)*12.0
	var out []*Room
	for _, r := range rooms {
		if r.Area >= lo && r.Area <= hi {
			out = append(out, r)
		}
	}
	if len(out) == 0 {
		return rooms
	}
	return out
}

// pickPerLevel returns the largest room on each level -- used to give
// per-floor equipment (energy meters) a plausible home.
func pickPerLevel(rooms []*Room, levels []string) map[string]*Room {
	out := map[string]*Room{}
	for _, lvl := range levels {
		var best *Room
		for _, r := range rooms {
			if r.Key.Level != lvl {
				continue
			}
			if best == nil || r.Area > best.Area {
				best = r
			}
		}
		if best != nil {
			out[lvl] = best
		}
	}
	return out
}
