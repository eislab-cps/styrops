package livesim

import (
	"log"
	"math"
	"math/rand"
	"sort"
	"sync"
	"time"

	"github.com/styrops/buildingai/pkg/model"
	"github.com/styrops/buildingai/pkg/store"
)

// bindingPeriod is how much simulated time passes between equipment rescans.
const bindingPeriod = 10 * time.Minute

// maxSubStep caps how much simulated time one integration step covers, so a
// long jump (a slow tick, a test advancing an hour) still moves people along
// their route in believable increments.
const maxSubStep = 30 * time.Second

// PersonView is one simulated person as served by GET /api/live/people.
//
// Coordinates are floor-plan ("PDF") coordinates: the exact space used by
// room.center, walkable-graph node x/y and coverage-zone centres. The viewer
// converts to its own world space with
// (x - page.width/2, -(y - page.height/2)); heading is already expressed in
// that world space (degrees counter-clockwise from +X).
type PersonView struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Role    string  `json:"role"`  // "student" | "staff"
	State   string  `json:"state"` // "walking" | "in_room"
	Room    string  `json:"room"`  // room name, empty while in a corridor
	Level   string  `json:"level"` // "level0" | "level1" | "level2"
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Heading float64 `json:"heading"`
	Icon    string  `json:"icon"` // "man" | "woman", matches /api/icons
}

// Status is the simulation summary served by GET /api/live/state.
type Status struct {
	Enabled       bool           `json:"enabled"`
	Running       bool           `json:"running"`
	SimTime       time.Time      `json:"sim_time"`
	SimClock      string         `json:"sim_clock"` // "Mon 08:32"
	Speed         float64        `json:"speed"`
	Seed          int64          `json:"seed"`
	Population    int            `json:"population"`
	Inside        int            `json:"inside"`
	Walking       int            `json:"walking"`
	RoomsOccupied int            `json:"rooms_occupied"`
	PeopleByLevel map[string]int `json:"people_by_level"`
	PowerKW       float64        `json:"power_kw"`
	EnergyKWh     float64        `json:"energy_kwh"`
	Classes       int            `json:"classes"`
	LecturesNow   []Booking      `json:"lectures_now"`
	RoomsModelled map[string]int `json:"rooms_by_class"`
	Provisioned   int            `json:"provisioned_equipment"`
}

// ResetOptions re-seeds the simulation. Zero fields keep the current value.
type ResetOptions struct {
	Seed   *int64     `json:"seed,omitempty"`
	People *int       `json:"people,omitempty"`
	Speed  *float64   `json:"speed,omitempty"`
	Start  *time.Time `json:"start,omitempty"`
}

// Sim is the living-building simulation.
type Sim struct {
	cfg   Config
	store *store.MemoryStore
	w     *world

	mu          sync.RWMutex
	simNow      time.Time
	people      []*person
	sched       *schedule
	classes     int
	rooms       map[RoomKey]*roomState
	active      map[RoomKey]bool
	energy      map[string]float64
	levelCounts map[string]int
	occupied    map[RoomKey][]*person
	bindings    []binding
	ownedKeys   []string
	lastSensor  time.Time
	lastBinding time.Time
	lastNotify  time.Time
	provisioned int

	running bool
	stop    chan struct{}
	done    chan struct{}
}

// New builds a simulation over the building data already loaded into the store.
// It does not start the goroutine; call Start for that.
func New(st *store.MemoryStore, cfg Config) *Sim {
	cfg = cfg.withDefaults()
	s := &Sim{
		cfg:   cfg,
		store: st,
		w:     buildWorld(st),
	}
	s.reset(cfg.Seed, cfg.Start, cfg.People)
	if cfg.Provision {
		s.provisioned = s.provision()
		if s.provisioned > 0 {
			s.store.BumpEquipmentVersion()
		}
	}
	s.refreshBindings()
	return s
}

// reset rebuilds the population, schedule and room physics. Caller must hold
// the write lock (or be in New, before the Sim is shared).
func (s *Sim) reset(seed int64, start time.Time, people int) {
	s.cfg.Seed = seed
	s.cfg.Start = start
	s.cfg.People = people
	s.simNow = start

	rng := rand.New(rand.NewSource(seed))
	s.people, s.classes = s.buildPopulation(rng)

	var teachers []string
	students := 0
	for _, p := range s.people {
		if p.role == roleStaff {
			teachers = append(teachers, p.id)
		} else {
			students++
		}
	}
	classSize := 0
	if s.classes > 0 {
		classSize = (students + s.classes - 1) / s.classes
	}
	s.sched = buildSchedule(rng, roomsFitting(s.w.lectures, classSize), s.classes, teachers)

	// Rooms the simulation can send people to: everything referenced by the
	// population plus every room in the weekly timetable.
	s.active = map[RoomKey]bool{}
	for _, p := range s.people {
		for _, k := range []RoomKey{p.home, p.lunch, p.meeting} {
			if !k.zero() {
				s.active[k] = true
			}
		}
	}
	for _, b := range s.sched.all {
		s.active[b.Room] = true
	}

	s.rooms = make(map[RoomKey]*roomState, len(s.w.rooms))
	for k, r := range s.w.rooms {
		s.rooms[k] = s.newRoomState(r)
	}
	s.energy = map[string]float64{}
	for _, lvl := range s.w.levels {
		s.energy[lvl] = 0
	}
	s.levelCounts = map[string]int{}
	s.occupied = map[RoomKey][]*person{}
	s.lastSensor = start
	s.lastBinding = start

	// Place everyone according to the schedule at the start instant instead of
	// having the whole population walk in from the entrances at once.
	for _, p := range s.people {
		s.updatePerson(p, s.simNow, 0)
		if len(p.path) > 0 {
			// Snap to the destination: at t0 people are already where the
			// schedule says they should be.
			p.node = p.path[len(p.path)-1]
			p.path = p.path[:0]
			p.segDone = 0
			if p.exiting {
				p.inside = false
				p.exiting = false
			}
			s.place(p)
		}
	}
	s.aggregate()
}

// Start launches the ticker goroutine.
func (s *Sim) Start() {
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return
	}
	s.running = true
	s.stop = make(chan struct{})
	s.done = make(chan struct{})
	tick, speed := s.cfg.Tick, s.cfg.Speed
	s.mu.Unlock()

	log.Printf("livesim: %d people, %d rooms, %d lecture rooms, %d entrances, clock %s at %.0fx",
		len(s.people), len(s.w.rooms), len(s.w.lectures), len(s.w.entrances),
		s.SimNow().Format("Mon 2006-01-02 15:04"), speed)

	go func() {
		defer close(s.done)
		ticker := time.NewTicker(tick)
		defer ticker.Stop()
		last := time.Now()
		for {
			select {
			case <-s.stop:
				return
			case now := <-ticker.C:
				elapsed := now.Sub(last)
				last = now
				if elapsed <= 0 {
					continue
				}
				s.AdvanceSim(time.Duration(float64(elapsed) * speed))
			}
		}
	}()
}

// Stop halts the ticker goroutine.
func (s *Sim) Stop() {
	if s == nil {
		return
	}
	s.mu.Lock()
	if !s.running {
		s.mu.Unlock()
		return
	}
	s.running = false
	close(s.stop)
	done := s.done
	s.mu.Unlock()
	<-done
}

// AdvanceSim moves the simulation forward by d of *simulated* time. The ticker
// calls it with (real elapsed x Speed); tests call it directly.
func (s *Sim) AdvanceSim(d time.Duration) {
	if s == nil || d <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for d > 0 {
		step := d
		if step > maxSubStep {
			step = maxSubStep
		}
		s.step(step)
		d -= step
	}
	s.publish()
}

// step is one integration step over dt of simulated time.
func (s *Sim) step(dt time.Duration) {
	s.simNow = s.simNow.Add(dt)
	secs := dt.Seconds()
	for _, p := range s.people {
		s.updatePerson(p, s.simNow, secs)
	}
	s.aggregate()
	s.integrateRooms(s.simNow, secs)
	s.accumulateEnergy(secs)
}

// publish pushes the current state into the shared store.
func (s *Sim) publish() {
	if s.cfg.WriteOccupancy {
		s.publishOccupancy()
	}
	if s.simNow.Sub(s.lastBinding) >= bindingPeriod {
		s.lastBinding = s.simNow
		s.refreshBindings()
	}
	if s.simNow.Sub(s.lastSensor) >= s.cfg.SensorPeriod {
		s.lastSensor = s.simNow
		s.publishSensors(s.simNow)
	}
}

// aggregate recomputes per-room and per-level headcounts from the people.
func (s *Sim) aggregate() {
	for k := range s.occupied {
		delete(s.occupied, k)
	}
	for k := range s.levelCounts {
		s.levelCounts[k] = 0
	}
	for _, st := range s.rooms {
		st.count = 0
	}
	for _, p := range s.people {
		if !p.inside {
			continue
		}
		s.levelCounts[p.level]++
		if p.inRoom.zero() {
			continue // in a corridor, between rooms
		}
		s.occupied[p.inRoom] = append(s.occupied[p.inRoom], p)
		if st := s.rooms[p.inRoom]; st != nil {
			st.count++
		}
	}
}

// publishOccupancy writes aggregated room occupancy into the global store map.
//
// KEY FORMAT: "<level>/<room name>", e.g. "level1/A2306".
//
// The legacy convention for this map is the room id as a string, but room ids
// are only unique *within a floor*: the A-building has an id 57 on every level,
// and both a level0 and a level1 room called A117. Numeric keys would therefore
// silently drop rooms as floors collided (and the browser resolves such a key
// against the first floor that has the id, which puts upper-floor people on the
// ground floor). Simulated entries use the qualified key instead and repeat
// level / room / count inside the value, so nothing is ambiguous. Hand-written
// numeric entries keep working -- they are simply left alone.
//
// Entries the simulation does not own are preserved, as are aliens placed by
// hand in rooms the simulation does occupy.
func (s *Sim) publishOccupancy() {
	prev := s.store.GetOccupancy()
	next := make(map[string]model.RoomOccupancy, len(prev)+len(s.occupied))
	owned := make(map[string]bool, len(s.ownedKeys))
	for _, k := range s.ownedKeys {
		owned[k] = true
	}
	for k, v := range prev {
		if owned[k] {
			continue // simulation-owned, rewritten below
		}
		next[k] = v
	}

	keys := make([]RoomKey, 0, len(s.occupied))
	for k := range s.occupied {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].Level != keys[j].Level {
			return keys[i].Level < keys[j].Level
		}
		return keys[i].Name < keys[j].Name
	})

	newOwned := make([]string, 0, len(keys))
	for _, k := range keys {
		room := s.w.rooms[k]
		if room == nil {
			continue
		}
		id := OccupancyKey(k)
		persons := make([]model.Person, 0, len(s.occupied[k]))
		for _, p := range s.occupied[k] {
			persons = append(persons, model.Person{ID: p.id, Name: p.name, Icon: p.icon})
		}
		aliens := []model.Alien{}
		if old, ok := next[id]; ok && len(old.Aliens) > 0 {
			aliens = old.Aliens
		} else if old, ok := prev[id]; ok && len(old.Aliens) > 0 {
			aliens = old.Aliens
		}
		next[id] = model.RoomOccupancy{
			Persons: persons,
			Aliens:  aliens,
			Count:   len(persons),
			Level:   k.Level,
			Room:    k.Name,
		}
		newOwned = append(newOwned, id)
	}
	s.ownedKeys = newOwned

	version := s.store.SetOccupancy(next)
	if s.cfg.Notify != nil {
		now := time.Now()
		if now.Sub(s.lastNotify) >= s.cfg.NotifyPeriod {
			s.lastNotify = now
			s.cfg.Notify(version)
		}
	}
}

// OccupancyKey is the key the simulation uses in the global occupancy map:
// "<level>/<room name>". See publishOccupancy for why it is not the room id.
func OccupancyKey(k RoomKey) string { return k.Level + "/" + k.Name }

// People returns everyone currently inside the building, optionally filtered to
// one level. People who have gone home are not in the building and are omitted.
func (s *Sim) People(level string) []PersonView {
	if s == nil {
		return []PersonView{}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]PersonView, 0, len(s.people))
	for _, p := range s.people {
		if !p.inside {
			continue
		}
		if level != "" && p.level != level {
			continue
		}
		out = append(out, PersonView{
			ID:      p.id,
			Name:    p.name,
			Role:    string(p.role),
			State:   p.state,
			Room:    p.inRoom.Name,
			Level:   p.level,
			X:       round(p.x, 2),
			Y:       round(p.y, 2),
			Heading: round(p.heading, 1),
			Icon:    p.icon,
		})
	}
	return out
}

// State reports the simulation clock and aggregate figures.
func (s *Sim) State() Status {
	if s == nil {
		return Status{Enabled: false, PeopleByLevel: map[string]int{}, RoomsModelled: map[string]int{}, LecturesNow: []Booking{}}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()

	st := Status{
		Enabled:       true,
		Running:       s.running,
		SimTime:       s.simNow,
		SimClock:      s.simNow.Format("Mon 15:04"),
		Speed:         s.cfg.Speed,
		Seed:          s.cfg.Seed,
		Population:    len(s.people),
		PeopleByLevel: map[string]int{},
		Classes:       s.classes,
		RoomsModelled: map[string]int{},
		Provisioned:   s.provisioned,
		LecturesNow:   []Booking{},
	}
	for _, p := range s.people {
		if !p.inside {
			continue
		}
		st.Inside++
		if p.state == stateWalking {
			st.Walking++
		}
		st.PeopleByLevel[p.level]++
	}
	st.RoomsOccupied = len(s.occupied)
	for _, r := range s.w.ordered {
		st.RoomsModelled[string(r.Class)]++
	}
	for lvl := range s.energy {
		st.EnergyKWh += s.energy[lvl]
		st.PowerKW += s.levelPowerKW(lvl)
	}
	st.EnergyKWh = round(st.EnergyKWh, 1)
	st.PowerKW = round(st.PowerKW, 2)
	if isWorkday(s.simNow.Weekday()) {
		st.LecturesNow = append(st.LecturesNow, s.sched.at(s.simNow.Weekday(), minutesOfDay(s.simNow))...)
		sort.Slice(st.LecturesNow, func(i, j int) bool {
			return st.LecturesNow[i].Class < st.LecturesNow[j].Class
		})
	}
	return st
}

// Reset re-seeds and restarts the simulation from its start instant.
func (s *Sim) Reset(opts ResetOptions) Status {
	if s == nil {
		return Status{}
	}
	s.mu.Lock()
	seed, start, people := s.cfg.Seed, s.cfg.Start, s.cfg.People
	if opts.Seed != nil {
		seed = *opts.Seed
	}
	if opts.Start != nil {
		start = *opts.Start
	}
	if opts.People != nil && *opts.People > 0 {
		people = *opts.People
	}
	if opts.Speed != nil && *opts.Speed > 0 {
		s.cfg.Speed = *opts.Speed
	}
	s.ownedKeys = nil
	s.reset(seed, start, people)
	if s.cfg.Provision {
		s.provisioned += s.provision()
	}
	s.refreshBindings()
	s.publish()
	s.mu.Unlock()
	return s.State()
}

// SimNow is the current simulated wall-clock time.
func (s *Sim) SimNow() time.Time {
	if s == nil {
		return time.Time{}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.simNow
}

// Schedule returns the full synthesized weekly timetable, ordered.
func (s *Sim) Schedule() []Booking {
	if s == nil {
		return []Booking{}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := append([]Booking(nil), s.sched.all...)
	sort.Slice(out, func(i, j int) bool {
		if out[i].Weekday != out[j].Weekday {
			return out[i].Weekday < out[j].Weekday
		}
		if out[i].Slot != out[j].Slot {
			return out[i].Slot < out[j].Slot
		}
		return out[i].Class < out[j].Class
	})
	if out == nil {
		out = []Booking{}
	}
	return out
}

// Occupancy returns the current per-room headcount, keyed by room.
func (s *Sim) Occupancy() map[RoomKey]int {
	if s == nil {
		return map[RoomKey]int{}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[RoomKey]int, len(s.occupied))
	for k, v := range s.occupied {
		out[k] = len(v)
	}
	return out
}

// Room exposes a modelled room (geometry + classification) for tests and tools.
func (s *Sim) Room(k RoomKey) (Room, bool) {
	if s == nil {
		return Room{}, false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.w.rooms[k]
	if !ok {
		return Room{}, false
	}
	return *r, true
}

// RoomClimate reports the modelled temperature and CO2 of a room.
func (s *Sim) RoomClimate(k RoomKey) (tempC, co2ppm float64, ok bool) {
	if s == nil {
		return 0, 0, false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	st, ok := s.rooms[k]
	if !ok {
		return 0, 0, false
	}
	return st.temp, st.co2, true
}

func round(v float64, decimals int) float64 {
	p := math.Pow(10, float64(decimals))
	return math.Round(v*p) / p
}
