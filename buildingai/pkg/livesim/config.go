// Package livesim turns the static A-building model into a "living building":
// a population of simulated people that move between real rooms along the real
// navigation graph, and equipment sensors whose values follow from where those
// people are.
//
// The simulation is a single goroutine ticking on real time. Every tick it
// advances a *simulation clock* (real elapsed time x Speed), moves people,
// aggregates per-room occupancy into the shared store, and periodically pushes
// sensor readings. Everything else in the server keeps reading the store as
// before -- GET /api/occupancy and GET /api/equipment simply start telling the
// truth about a building that is now in motion.
//
// Determinism: given the same Config (Seed, People, Start, Speed) and the same
// sequence of clock advances, the simulation produces bit-identical output.
// Tests drive it with AdvanceSim instead of starting the goroutine.
package livesim

import "time"

// Config controls the simulation. The zero value is not usable; use
// DefaultConfig and override.
type Config struct {
	// Enabled turns the simulation on. When false the /api/live endpoints
	// still exist but report an empty, disabled simulation.
	Enabled bool

	// Speed is how many simulated seconds pass per real second. 60 means a
	// simulated day passes in 24 real minutes. 1 means real time.
	Speed float64

	// Seed makes the population, the weekly schedule and all per-person
	// timing jitter reproducible.
	Seed int64

	// People is the size of the simulated population (students + staff).
	People int

	// Start is the simulated wall-clock time at which the simulation begins.
	// Zero means "today at 08:00 local time, moved forward to Monday if that
	// lands on a weekend": the morning rush is still in progress, so a demo
	// opens on a building that is already alive.
	Start time.Time

	// Tick is the real-time interval between simulation steps.
	Tick time.Duration

	// SensorPeriod is how much *simulated* time passes between sensor
	// publications. Physics is integrated every tick; only the publishing is
	// throttled, which keeps the reading cadence in the range a real BMS
	// would produce instead of hammering the store.
	SensorPeriod time.Duration

	// Provision creates livesim-owned climate equipment (temperature, CO2,
	// presence, occupancy count) in every room the simulation actually uses,
	// plus per-floor energy meters. Existing equipment is never modified
	// beyond its sensor values.
	Provision bool

	// WriteOccupancy lets the simulation own the global occupancy map
	// (GET/PUT /api/occupancy). Rooms the simulation does not use are left
	// untouched, and manually placed aliens are preserved.
	WriteOccupancy bool

	// Broadcast asks the server to wire Notify to a WebSocket broadcast of
	// {"type":"live"} messages. Off by default: the simulation changes state
	// continuously and clients are expected to poll /api/live/people at their
	// own frame rate.
	Broadcast bool

	// Notify, when set, is called (at most once per NotifyPeriod) after the
	// occupancy map changed. The server wires this to a WebSocket broadcast.
	Notify func(version int64)

	// NotifyPeriod throttles Notify in real time.
	NotifyPeriod time.Duration

	// WalkSpeed is walking speed in floor-plan units per simulated second.
	// The floor plans are metric (1 unit ~ 1 m), so 1.3 is a normal walk.
	WalkSpeed float64

	// CeilingHeight (metres) is used to turn room areas into air volumes for
	// the CO2 model.
	CeilingHeight float64
}

// DefaultConfig returns the configuration the server starts with.
// The simulation is opt-in (--livesim): by default the building starts
// empty — no provisioned equipment, no simulated people — so equipment
// and occupancy belong entirely to the REST API.
func DefaultConfig() Config {
	return Config{
		Enabled:        false,
		Speed:          60,
		Seed:           20260601,
		People:         60,
		Tick:           500 * time.Millisecond,
		SensorPeriod:   2 * time.Minute,
		Provision:      true,
		WriteOccupancy: true,
		NotifyPeriod:   time.Second,
		WalkSpeed:      1.3,
		CeilingHeight:  3.0,
	}
}

// withDefaults fills in unset fields so a partially-specified Config still runs.
func (c Config) withDefaults() Config {
	d := DefaultConfig()
	if c.Speed <= 0 {
		c.Speed = d.Speed
	}
	if c.People <= 0 {
		c.People = d.People
	}
	if c.Tick <= 0 {
		c.Tick = d.Tick
	}
	if c.SensorPeriod <= 0 {
		c.SensorPeriod = d.SensorPeriod
	}
	if c.NotifyPeriod <= 0 {
		c.NotifyPeriod = d.NotifyPeriod
	}
	if c.WalkSpeed <= 0 {
		c.WalkSpeed = d.WalkSpeed
	}
	if c.CeilingHeight <= 0 {
		c.CeilingHeight = d.CeilingHeight
	}
	if c.Seed == 0 {
		c.Seed = d.Seed
	}
	if c.Start.IsZero() {
		c.Start = DefaultStart(time.Now())
	}
	return c
}

// DefaultStart picks the simulated start instant: 08:00 on the day of ref,
// advanced to the next Monday if ref falls on a weekend. Keeping the demo on a
// weekday means the synthesized lecture schedule is always in play, and 08:00
// means people are already inside when the first frame is drawn.
func DefaultStart(ref time.Time) time.Time {
	return SnapToWeekday(time.Date(ref.Year(), ref.Month(), ref.Day(), 8, 0, 0, 0, ref.Location()))
}

// SnapToWeekday moves a start instant forward to the next Monday if it lands on
// a weekend, keeping the time of day. Used for start times given as a bare time
// of day; a fully specified date is taken literally, weekend or not.
func SnapToWeekday(t time.Time) time.Time {
	for t.Weekday() == time.Saturday || t.Weekday() == time.Sunday {
		t = t.AddDate(0, 0, 1)
	}
	return t
}
