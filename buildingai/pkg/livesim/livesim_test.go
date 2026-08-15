package livesim

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/styrops/buildingai/pkg/graph"
	"github.com/styrops/buildingai/pkg/model"
	"github.com/styrops/buildingai/pkg/store"
)

// realStore loads the actual A-building floor plans, so the simulation is
// exercised against the real rooms and the real navigation graph.
func realStore(t *testing.T) *store.MemoryStore {
	t.Helper()
	st := store.NewMemoryStore()
	building := model.Building{
		Name: "A-Building (LTU)",
		Levels: []model.Level{
			{ID: "level0", Label: "Floor 0"},
			{ID: "level1", Label: "Floor 1"},
			{ID: "level2", Label: "Floor 2"},
		},
	}
	st.SetBuilding(building)

	root := filepath.Join("..", "..", "data", "abuilding")
	var order []string
	for _, lvl := range building.Levels {
		raw, err := os.ReadFile(filepath.Join(root, lvl.ID, "floorplan_data.json"))
		if err != nil {
			t.Skipf("building data unavailable: %v", err)
		}
		var fd model.FloorData
		if err := json.Unmarshal(raw, &fd); err != nil {
			t.Fatalf("parse %s: %v", lvl.ID, err)
		}
		st.SetFloorData(lvl.ID, &fd)
		order = append(order, lvl.ID)
	}

	if raw, err := os.ReadFile(filepath.Join(root, "cross_floor_edges.json")); err == nil {
		var edges []model.CrossFloorEdge
		if err := json.Unmarshal(raw, &edges); err == nil {
			st.SetCrossFloorEdges(edges)
		}
	}
	st.SetMultiFloorGraph(graph.BuildMultiFloorGraph(st.GetFloors(), order, st.GetCrossFloorEdges()))
	return st
}

// monday is a fixed weekday used by every test, so results never depend on the
// day the suite happens to run.
func monday(hour, min int) time.Time {
	return time.Date(2026, 8, 10, hour, min, 0, 0, time.UTC) // 2026-08-10 is a Monday
}

func testConfig(start time.Time) Config {
	cfg := DefaultConfig()
	cfg.Start = start
	cfg.Seed = 12345
	cfg.People = 60
	cfg.Provision = true
	return cfg
}

func newTestSim(t *testing.T, start time.Time) *Sim {
	t.Helper()
	if start.Weekday() != time.Monday {
		t.Fatalf("tests assume a Monday start, got %s", start.Weekday())
	}
	return New(realStore(t), testConfig(start))
}

// advance walks the clock forward in realistic increments.
func advance(s *Sim, d time.Duration) {
	s.AdvanceSim(d)
}

func TestWorldClassification(t *testing.T) {
	s := newTestSim(t, monday(7, 0))
	if len(s.w.rooms) < 500 {
		t.Fatalf("expected the A-building to yield hundreds of rooms, got %d", len(s.w.rooms))
	}
	if len(s.w.lectures) == 0 || len(s.w.offices) == 0 || len(s.w.halls) == 0 {
		t.Fatalf("expected lecture/office/hall rooms, got %d/%d/%d",
			len(s.w.lectures), len(s.w.offices), len(s.w.halls))
	}
	if len(s.w.entrances) == 0 {
		t.Fatal("expected at least one entrance node")
	}
	// Every modelled room must be reachable on the walkable graph.
	for k, r := range s.w.rooms {
		if s.w.node(r.Node) == nil {
			t.Fatalf("room %v has no graph node", k)
		}
	}
}

func TestBuildingIsEmptyAtNight(t *testing.T) {
	s := newTestSim(t, monday(3, 0))
	if got := len(s.People("")); got != 0 {
		t.Fatalf("expected nobody in the building at 03:00, got %d", got)
	}
	// And it stays empty for the small hours.
	advance(s, 90*time.Minute) // 04:30
	if got := len(s.People("")); got != 0 {
		t.Fatalf("expected nobody in the building at 04:30, got %d", got)
	}
	occ := s.store.GetOccupancy()
	for key, o := range occ {
		if len(o.Persons) != 0 {
			t.Fatalf("room %s has %d occupants at night", key, len(o.Persons))
		}
	}
	st := s.State()
	if st.Inside != 0 {
		t.Fatalf("status reports %d people inside at night", st.Inside)
	}
}

func TestBuildingFillsUpDuringTheDay(t *testing.T) {
	s := newTestSim(t, monday(6, 0))
	advance(s, 5*time.Hour) // 11:00
	inside := len(s.People(""))
	if inside < 20 {
		t.Fatalf("expected a busy building at 11:00, got %d people inside", inside)
	}
	// People must be spread over more than one floor.
	levels := map[string]int{}
	for _, p := range s.People("") {
		levels[p.Level]++
	}
	if len(levels) < 2 {
		t.Fatalf("expected people on several floors, got %v", levels)
	}

	advance(s, 12*time.Hour) // 23:00
	if got := len(s.People("")); got != 0 {
		t.Fatalf("expected an empty building at 23:00, got %d", got)
	}
}

// findLectureBooking returns a Monday booking whose room is not reused later in
// the day, so CO2 in that room can be watched rising and then decaying.
func findLectureBooking(s *Sim) (Booking, bool) {
	for _, b := range s.Schedule() {
		if b.Weekday != time.Monday || b.Slot != 0 {
			continue
		}
		reused := false
		for _, other := range s.Schedule() {
			if other.Weekday == time.Monday && other.Slot > 0 && other.Room == b.Room {
				reused = true
				break
			}
		}
		if !reused {
			return b, true
		}
	}
	return Booking{}, false
}

func TestStudentsAreInLectureRoomsAtLectureTime(t *testing.T) {
	s := newTestSim(t, monday(7, 0))
	bookings := s.Schedule()
	if len(bookings) == 0 {
		t.Fatal("expected a synthesized weekly timetable")
	}

	advance(s, 90*time.Minute) // 08:30, well into the first slot
	occ := s.Occupancy()

	var mondayFirst []Booking
	for _, b := range bookings {
		if b.Weekday == time.Monday && b.Slot == 0 {
			mondayFirst = append(mondayFirst, b)
		}
	}
	if len(mondayFirst) == 0 {
		t.Skip("no Monday 08:15 lecture in this seed")
	}

	filled := 0
	for _, b := range mondayFirst {
		if occ[b.Room] >= 5 {
			filled++
		}
		if room, ok := s.Room(b.Room); ok && room.Class != ClassLecture {
			t.Fatalf("booking %v is not in a lecture room (class %s)", b.Room, room.Class)
		}
	}
	if filled == 0 {
		t.Fatalf("no booked lecture room filled up at 08:30 (bookings: %d, occupied rooms: %d)",
			len(mondayFirst), len(occ))
	}

	// The status endpoint must agree that a lecture is running.
	if len(s.State().LecturesNow) == 0 {
		t.Fatal("status reports no lectures running at 08:30")
	}
}

func TestPeopleWalkAlongRealGraphEdges(t *testing.T) {
	s := newTestSim(t, monday(7, 30))

	type seg struct{ x1, y1, x2, y2 float64 }
	byLevel := map[string][]seg{}
	for _, e := range s.w.graph.Edges {
		a, b := s.w.node(e.From), s.w.node(e.To)
		if a == nil || b == nil || a.Level != b.Level {
			continue // cross-floor edges have no planar geometry
		}
		byLevel[a.Level] = append(byLevel[a.Level], seg{a.X, a.Y, b.X, b.Y})
	}

	checked := 0
	for i := 0; i < 60; i++ {
		advance(s, 30*time.Second)
		for _, p := range s.People("") {
			if p.State != stateWalking {
				continue
			}
			best := math.MaxFloat64
			for _, sg := range byLevel[p.Level] {
				if d := pointSegmentDistance(p.X, p.Y, sg.x1, sg.y1, sg.x2, sg.y2); d < best {
					best = d
				}
			}
			if best > 0.05 {
				t.Fatalf("walking person %s at (%.2f, %.2f) on %s is %.3f units off every graph edge",
					p.ID, p.X, p.Y, p.Level, best)
			}
			checked++
		}
	}
	if checked == 0 {
		t.Fatal("nobody was walking during the morning arrival window")
	}
	t.Logf("verified %d walking samples against the real navigation graph", checked)
}

func pointSegmentDistance(px, py, x1, y1, x2, y2 float64) float64 {
	dx, dy := x2-x1, y2-y1
	l2 := dx*dx + dy*dy
	if l2 == 0 {
		return math.Hypot(px-x1, py-y1)
	}
	tt := ((px-x1)*dx + (py-y1)*dy) / l2
	if tt < 0 {
		tt = 0
	}
	if tt > 1 {
		tt = 1
	}
	return math.Hypot(px-(x1+tt*dx), py-(y1+tt*dy))
}

func TestCO2RisesWithOccupancyAndDecaysAfterwards(t *testing.T) {
	s := newTestSim(t, monday(7, 0))
	booking, ok := findLectureBooking(s)
	if !ok {
		t.Skip("no exclusive Monday morning lecture in this seed")
	}

	_, before, ok := s.RoomClimate(booking.Room)
	if !ok {
		t.Fatalf("no climate state for %v", booking.Room)
	}
	if math.Abs(before-outdoorCO2) > 1 {
		t.Fatalf("expected a room to start at outdoor CO2, got %.0f", before)
	}

	advance(s, 105*time.Minute) // 08:45, lecture in progress
	occupied := s.Occupancy()[booking.Room]
	_, peak, _ := s.RoomClimate(booking.Room)
	if occupied < 5 {
		t.Skipf("lecture room %v only drew %d people in this seed", booking.Room, occupied)
	}
	if peak <= before+100 {
		t.Fatalf("CO2 in %v with %d people only moved %.0f -> %.0f ppm",
			booking.Room, occupied, before, peak)
	}

	advance(s, 4*time.Hour) // 12:45, long after the lecture ended
	if now := s.Occupancy()[booking.Room]; now > 2 {
		t.Skipf("room %v is busy again (%d people)", booking.Room, now)
	}
	_, decayed, _ := s.RoomClimate(booking.Room)
	if decayed >= peak-50 {
		t.Fatalf("CO2 in %v did not decay after the lecture: peak %.0f, later %.0f",
			booking.Room, peak, decayed)
	}
	t.Logf("%v: %.0f -> %.0f -> %.0f ppm with %d people", booking.Room, before, peak, decayed, occupied)
}

func TestTemperatureStaysPlausible(t *testing.T) {
	s := newTestSim(t, monday(6, 0))
	for i := 0; i < 12; i++ {
		advance(s, time.Hour)
		for k, st := range s.rooms {
			if st.temp < 18 || st.temp > 25 {
				t.Fatalf("room %v temperature %.2f out of plausible range at %s",
					k, st.temp, s.SimNow().Format("15:04"))
			}
		}
	}

	// A full lecture room must be measurably warmer than the same room empty.
	booking, ok := findLectureBooking(s)
	if !ok {
		return
	}
	base := s.baseTemp(s.SimNow())
	if st := s.rooms[booking.Room]; st != nil && st.count > 3 {
		if st.temp < base {
			t.Fatalf("occupied room %v (%d people) is colder (%.2f) than the baseline %.2f",
				booking.Room, st.count, st.temp, base)
		}
	}
}

func TestOccupancyEndpointAggregatesMatchPeopleList(t *testing.T) {
	s := newTestSim(t, monday(7, 0))
	advance(s, 3*time.Hour) // 10:00

	// Count the people list by (level, room).
	fromPeople := map[RoomKey]int{}
	for _, p := range s.People("") {
		if p.Room == "" {
			continue
		}
		fromPeople[RoomKey{Level: p.Level, Name: p.Room}]++
	}
	if len(fromPeople) == 0 {
		t.Fatal("expected occupied rooms at 10:00")
	}

	fromStore := map[RoomKey]int{}
	for key, o := range s.store.GetOccupancy() {
		if o.Level == "" || o.Room == "" {
			continue // not written by the simulation
		}
		if o.Count != len(o.Persons) {
			t.Fatalf("room %s: count %d != %d persons", key, o.Count, len(o.Persons))
		}
		rk := RoomKey{Level: o.Level, Name: o.Room}
		if _, ok := s.Room(rk); !ok {
			t.Fatalf("occupancy references unknown room %s/%s", o.Level, o.Room)
		}
		if OccupancyKey(rk) != key {
			t.Fatalf("occupancy key %q does not match room %v", key, rk)
		}
		fromStore[RoomKey{Level: o.Level, Name: o.Room}] = len(o.Persons)
	}

	if len(fromStore) != len(fromPeople) {
		t.Fatalf("occupancy covers %d rooms, people list covers %d", len(fromStore), len(fromPeople))
	}
	for k, want := range fromPeople {
		if got := fromStore[k]; got != want {
			t.Fatalf("room %v: occupancy says %d, people list says %d", k, got, want)
		}
	}
}

func TestOccupancyPreservesForeignEntriesAndAliens(t *testing.T) {
	s := newTestSim(t, monday(7, 0))
	advance(s, 3*time.Hour)

	// A room the simulation currently occupies, plus a key it does not own.
	var occupiedKey string
	for key, o := range s.store.GetOccupancy() {
		if o.Level != "" {
			occupiedKey = key
			break
		}
	}
	if occupiedKey == "" {
		t.Fatal("expected at least one simulated room")
	}

	current := s.store.GetOccupancy()
	merged := map[string]model.RoomOccupancy{}
	for k, v := range current {
		merged[k] = v
	}
	entry := merged[occupiedKey]
	entry.Aliens = []model.Alien{{ID: "xeno-1"}}
	merged[occupiedKey] = entry
	merged["999999"] = model.RoomOccupancy{
		Persons: []model.Person{{ID: "manual-1", Name: "Manual"}},
		Aliens:  []model.Alien{},
	}
	s.store.SetOccupancy(merged)

	advance(s, 5*time.Minute)

	after := s.store.GetOccupancy()
	if _, ok := after["999999"]; !ok {
		t.Fatal("the simulation clobbered a manually placed occupancy entry")
	}
	if len(after[occupiedKey].Aliens) != 1 {
		t.Fatalf("the simulation dropped a manually placed alien: %+v", after[occupiedKey])
	}
}

func TestProvisionedSensorsFollowTheSimulation(t *testing.T) {
	s := newTestSim(t, monday(7, 0))
	if s.State().Provisioned == 0 {
		t.Fatal("expected livesim to provision climate equipment")
	}
	advance(s, 2*time.Hour) // 09:00

	// Find the busiest room and read its provisioned sensors back out of the
	// store, exactly as GET /api/equipment would.
	var busiest RoomKey
	best := 0
	for k, n := range s.Occupancy() {
		if n > best {
			best, busiest = n, k
		}
	}
	if best < 3 {
		t.Skipf("no busy room at 09:00 (max %d)", best)
	}

	id := "livesim-climate-" + busiest.Level + "-" + busiest.Name
	eq, ok := s.store.GetEquipment(id)
	if !ok {
		t.Fatalf("no provisioned equipment %s", id)
	}
	seen := map[string]model.Sensor{}
	for _, sen := range eq.Sensors {
		seen[sen.Type] = sen
	}

	temp, err := strconv.ParseFloat(seen["temperature"].Value, 64)
	if err != nil || temp < 18 || temp > 26 {
		t.Fatalf("implausible temperature %q (%v)", seen["temperature"].Value, err)
	}
	co2, err := strconv.ParseFloat(seen["co2"].Value, 64)
	if err != nil || co2 < outdoorCO2 {
		t.Fatalf("implausible CO2 %q (%v)", seen["co2"].Value, err)
	}
	if co2 <= outdoorCO2+20 {
		t.Fatalf("CO2 in a room with %d people should have risen, got %.0f", best, co2)
	}
	if !seen["presence"].BinaryValue {
		t.Fatalf("presence sensor is false in a room with %d people", best)
	}
	if got := seen["occupancy_count"].Value; got != strconv.Itoa(best) {
		t.Fatalf("occupancy sensor says %q, simulation says %d", got, best)
	}
	if seen["temperature"].Timestamp.IsZero() {
		t.Fatal("sensor timestamp was never set")
	}
}

func TestEnergyMetersAccumulate(t *testing.T) {
	s := newTestSim(t, monday(7, 0))
	first := s.State().EnergyKWh
	advance(s, 4*time.Hour)
	second := s.State().EnergyKWh
	if second <= first {
		t.Fatalf("energy meter did not accumulate: %.2f -> %.2f", first, second)
	}

	eq, ok := s.store.GetEquipment("livesim-energy-level0")
	if !ok {
		t.Fatal("no level0 energy meter")
	}
	for _, sen := range eq.Sensors {
		v, err := strconv.ParseFloat(sen.Value, 64)
		if err != nil {
			t.Fatalf("sensor %s has non-numeric value %q", sen.ID, sen.Value)
		}
		if sen.Type == "energy" && v <= 0 {
			t.Fatalf("energy meter reads %.2f kWh after 4 hours", v)
		}
		if sen.Type == "power" && v < levelIdleKW {
			t.Fatalf("power meter reads %.2f kW, below the idle load", v)
		}
	}
}

func TestExistingSensorsAreDrivenToo(t *testing.T) {
	s := newTestSim(t, monday(7, 0))

	// Create equipment the way examples/api/scenario/populate_building.py does,
	// in a room the simulation actually uses.
	var target RoomKey
	for _, b := range s.Schedule() {
		if b.Weekday == time.Monday && b.Slot == 0 {
			target = b.Room
			break
		}
	}
	if target.zero() {
		t.Skip("no Monday morning lecture in this seed")
	}
	s.store.CreateEquipment(&model.Equipment{
		ID: "temp-x", Name: "Temp", Type: "temperature_sensor", Category: "monitoring",
		Level: target.Level, Room: target.Name, Status: "running",
		Sensors: []model.Sensor{
			{ID: "temp-x-val", Name: "Temperature", Type: "temperature", DataType: "text", Unit: "°C", Value: "21.5"},
		},
	})
	s.store.CreateEquipment(&model.Equipment{
		ID: "motion-x", Name: "Motion", Type: "motion_sensor", Category: "monitoring",
		Level: target.Level, Room: target.Name, Status: "running",
		Sensors: []model.Sensor{
			{ID: "motion-x-det", Name: "Motion", Type: "motion", DataType: "binary"},
		},
	})

	advance(s, 2*time.Hour) // 09:00, past the binding refresh interval

	eq, _ := s.store.GetEquipment("temp-x")
	if len(eq.Sensors) != 1 || eq.Sensors[0].Value == "21.5" {
		t.Fatalf("pre-existing temperature sensor was not driven: %+v", eq.Sensors)
	}
	if _, err := strconv.ParseFloat(eq.Sensors[0].Value, 64); err != nil {
		t.Fatalf("temperature sensor value %q is not numeric", eq.Sensors[0].Value)
	}
	motion, _ := s.store.GetEquipment("motion-x")
	if s.Occupancy()[target] > 0 && !motion.Sensors[0].BinaryValue {
		t.Fatal("motion sensor stayed false in an occupied room")
	}
}

func TestDeterministicUnderSeed(t *testing.T) {
	runOnce := func() []PersonView {
		s := New(realStore(t), testConfig(monday(7, 0)))
		for i := 0; i < 20; i++ {
			s.AdvanceSim(6 * time.Minute)
		}
		return s.People("")
	}
	a, b := runOnce(), runOnce()
	if len(a) != len(b) {
		t.Fatalf("same seed produced %d and %d people", len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("same seed diverged at %d:\n %+v\n %+v", i, a[i], b[i])
		}
	}

	// A different seed must produce a different building day.
	cfg := testConfig(monday(7, 0))
	cfg.Seed = 999
	other := New(realStore(t), cfg)
	for i := 0; i < 20; i++ {
		other.AdvanceSim(6 * time.Minute)
	}
	if same := len(other.People("")) == len(a) && equalViews(other.People(""), a); same {
		t.Fatal("a different seed produced an identical simulation")
	}
}

func equalViews(a, b []PersonView) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestResetRewindsTheClock(t *testing.T) {
	s := newTestSim(t, monday(7, 0))
	advance(s, 5*time.Hour)
	if s.SimNow().Hour() != 12 {
		t.Fatalf("expected 12:00, got %s", s.SimNow())
	}

	start := monday(8, 0)
	people := 30
	st := s.Reset(ResetOptions{Start: &start, People: &people})
	if !st.SimTime.Equal(start) {
		t.Fatalf("reset did not rewind the clock: %s", st.SimTime)
	}
	if st.Population != 30 {
		t.Fatalf("reset did not resize the population: %d", st.Population)
	}
	if len(s.People("")) > 30 {
		t.Fatalf("more people than the population after reset")
	}
}

func TestPeopleLevelFilter(t *testing.T) {
	s := newTestSim(t, monday(7, 0))
	advance(s, 4*time.Hour)
	all := s.People("")
	if len(all) == 0 {
		t.Fatal("expected people at 11:00")
	}
	for _, lvl := range []string{"level0", "level1", "level2"} {
		for _, p := range s.People(lvl) {
			if p.Level != lvl {
				t.Fatalf("level filter %s returned %s", lvl, p.Level)
			}
		}
	}
	sum := len(s.People("level0")) + len(s.People("level1")) + len(s.People("level2"))
	if sum != len(all) {
		t.Fatalf("per-level counts sum to %d, unfiltered list has %d", sum, len(all))
	}
}

func TestCoordinatesStayInsideThePage(t *testing.T) {
	s := newTestSim(t, monday(7, 0))
	advance(s, 4*time.Hour)
	fd, ok := s.store.GetFloorData("level0")
	if !ok {
		t.Fatal("no level0 floor data")
	}
	for _, p := range s.People("") {
		if p.X < 0 || p.X > fd.Page.Width || p.Y < 0 || p.Y > fd.Page.Height {
			t.Fatalf("person %s at (%.2f, %.2f) is outside the %.1fx%.1f page",
				p.ID, p.X, p.Y, fd.Page.Width, fd.Page.Height)
		}
		if p.Heading < 0 || p.Heading >= 360 {
			t.Fatalf("person %s has heading %.1f", p.ID, p.Heading)
		}
	}
}

func TestNilSimIsSafe(t *testing.T) {
	var s *Sim
	if got := s.People(""); len(got) != 0 {
		t.Fatalf("nil sim returned %d people", len(got))
	}
	if st := s.State(); st.Enabled {
		t.Fatal("nil sim reports enabled")
	}
	if got := s.Schedule(); len(got) != 0 {
		t.Fatalf("nil sim returned %d bookings", len(got))
	}
	s.Start()
	s.Stop()
	s.AdvanceSim(time.Minute)
}

func TestStartStopGoroutine(t *testing.T) {
	s := newTestSim(t, monday(9, 0))
	s.cfg.Tick = 5 * time.Millisecond
	s.cfg.Speed = 3600
	before := s.SimNow()
	s.Start()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if s.SimNow().After(before) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	s.Stop()
	if !s.SimNow().After(before) {
		t.Fatal("the simulation clock did not advance while running")
	}
	// Stop must be idempotent.
	s.Stop()
}

func TestDefaultStartAvoidsWeekends(t *testing.T) {
	sat := time.Date(2026, 8, 8, 22, 0, 0, 0, time.UTC) // Saturday
	got := DefaultStart(sat)
	if got.Weekday() != time.Monday || got.Hour() != 8 {
		t.Fatalf("expected Monday 08:00, got %s", got.Format("Mon 15:04"))
	}
	wed := time.Date(2026, 8, 12, 22, 0, 0, 0, time.UTC)
	if got := DefaultStart(wed); got.Weekday() != time.Wednesday || got.Hour() != 8 {
		t.Fatalf("expected Wednesday 08:00, got %s", got.Format("Mon 15:04"))
	}
}

func TestHeadingIsInViewerWorldSpace(t *testing.T) {
	// Walking east: +X, heading 0.
	if got := headingDeg(0, 0, 10, 0); got != 0 {
		t.Fatalf("east should be 0 degrees, got %.1f", got)
	}
	// Walking towards smaller PDF y is "up" on screen: 90 degrees.
	if got := headingDeg(0, 10, 0, 0); math.Abs(got-90) > 1e-9 {
		t.Fatalf("screen-up should be 90 degrees, got %.1f", got)
	}
	if got := headingDeg(0, 0, 0, 10); math.Abs(got-270) > 1e-9 {
		t.Fatalf("screen-down should be 270 degrees, got %.1f", got)
	}
}

func TestSlotBoundaries(t *testing.T) {
	cases := []struct {
		minutes int
		want    int
	}{
		{3 * 60, -1},
		{8*60 + 14, -1},
		{8*60 + 15, 0},
		{9 * 60, 0},
		{10 * 60, -1}, // break
		{12 * 60, -1}, // lunch
		{14 * 60, 2},
		{16 * 60, 3},
		{17 * 60, -1},
	}
	for _, c := range cases {
		if got := slotAt(c.minutes); got != c.want {
			t.Fatalf("slotAt(%d) = %d, want %d", c.minutes, got, c.want)
		}
	}
}
