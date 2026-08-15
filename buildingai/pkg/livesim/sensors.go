package livesim

import (
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/styrops/buildingai/pkg/model"
	"github.com/styrops/buildingai/pkg/store"
)

// Physical constants for the room models.
const (
	outdoorCO2     = 420.0  // ppm
	co2PerPerson   = 5.2e-6 // m^3/s of CO2 exhaled, sedentary adult
	tempTau        = 900.0  // s, thermal lag of a room
	occupancyTempK = 1.5    // max degrees added by a packed room
	achIdle        = 0.5    // air changes/hour, ventilation at rest
	fullDensity    = 0.15   // people per m^2 counted as "packed" (~6.7 m^2 each)
	wifiRangeUnits = 35.0   // floor-plan units an access point "sees"
	motionHoldSimS = 300.0  // motion latches this long after the last person
	levelIdleKW    = 12.0   // per-floor base load
	levelActiveKW  = 18.0   // extra when the floor is in use
	perPersonKW    = 0.12   // plug loads / lighting per occupant
)

type sensorKind int

const (
	kindNone sensorKind = iota
	kindTemperature
	kindCO2
	kindPresence
	kindMotion
	kindOccupancy
	kindHumidity
	kindEnergy
	kindPower
	kindWifiUsers
)

// binding ties one existing sensor to something the simulation models. Bindings
// are rebuilt periodically, so equipment created after startup (for example by
// examples/api/scenario/populate_building.py) starts moving on its own.
type binding struct {
	sensorID string
	kind     sensorKind
	binary   bool
	room     RoomKey    // zero for building/level scoped sensors
	level    string     // equipment level
	center   [2]float64 // room centre, for proximity-based sensors
}

// roomState is the live physical state of one room.
type roomState struct {
	room       *Room
	count      int
	temp       float64
	co2        float64
	volume     float64
	achMax     float64
	tempOffset float64
	lastPerson time.Time // simulated time a person was last present
	seenPerson bool
	area       float64
}

// density is how packed the room is, 0..1, from occupants per square metre.
// Using floor area rather than a guessed seat count keeps the thermal and
// ventilation response tied to something the floor plan actually knows.
func (st *roomState) density() float64 {
	if st.area <= 0 {
		return 0
	}
	d := (float64(st.count) / st.area) / fullDensity
	if d > 1 {
		d = 1
	}
	return d
}

func (s *Sim) newRoomState(r *Room) *roomState {
	area := r.Area
	if area < 6 {
		area = 6
	}
	volume := area * s.cfg.CeilingHeight
	achMax := 3.0
	switch r.Class {
	case ClassLecture, ClassHall:
		achMax = 4.0
	case ClassMeeting:
		achMax = 3.5
	case ClassService:
		achMax = 2.0
	}
	// A small fixed per-room offset keeps rooms from reading identically.
	off := (float64(spread(hashInts(s.cfg.Seed+17, int(r.ID), len(r.Key.Name)), 100))/100.0 - 0.5) * 0.8
	st := &roomState{room: r, volume: volume, area: area, achMax: achMax, tempOffset: off}
	st.temp = s.baseTemp(s.simNow) + off
	st.co2 = outdoorCO2
	return st
}

// baseTemp is the day cycle: coolest before dawn, warmest mid-afternoon.
func (s *Sim) baseTemp(t time.Time) float64 {
	hours := float64(t.Hour()) + float64(t.Minute())/60
	return 20.8 + 0.9*math.Sin(2*math.Pi*(hours-9)/24)
}

// integrateRooms advances temperature and CO2 by dt simulated seconds.
func (s *Sim) integrateRooms(now time.Time, dt float64) {
	if dt <= 0 {
		return
	}
	base := s.baseTemp(now)
	for _, st := range s.rooms {
		density := st.density()
		if st.count > 0 {
			st.lastPerson = now
			st.seenPerson = true
		}

		// Demand-controlled ventilation: airflow follows occupancy.
		ach := achIdle + (st.achMax-achIdle)*density
		k := ach / 3600.0 // 1/s
		q := k * st.volume
		steady := outdoorCO2
		if q > 0 {
			steady = outdoorCO2 + float64(st.count)*co2PerPerson/q*1e6
		}
		st.co2 = steady + (st.co2-steady)*math.Exp(-k*dt)
		if st.co2 < outdoorCO2 {
			st.co2 = outdoorCO2
		}
		if st.co2 > 5000 {
			st.co2 = 5000
		}

		target := base + st.tempOffset + occupancyTempK*density
		st.temp += (target - st.temp) * (1 - math.Exp(-dt/tempTau))
	}
}

// === sensor discovery ======================================================

// kindFor decides what a sensor represents, from its own type first and the
// equipment type second. Matching is deliberately loose: sensor vocabularies in
// this project are free-form strings.
func kindFor(sen model.Sensor, eqType string) sensorKind {
	t := strings.ToLower(sen.Type)
	if t == "" {
		t = strings.ToLower(sen.Name)
	}
	unit := strings.ToLower(sen.Unit)
	eq := strings.ToLower(eqType)

	switch {
	case strings.Contains(t, "co2"), strings.Contains(t, "carbon"), strings.Contains(eq, "co2"):
		return kindCO2
	case strings.Contains(t, "temp"), unit == "°c", unit == "c", strings.Contains(eq, "temperature"):
		return kindTemperature
	case strings.Contains(t, "humid"):
		return kindHumidity
	case strings.Contains(t, "motion"), strings.Contains(eq, "motion"):
		return kindMotion
	case strings.Contains(t, "presence"):
		return kindPresence
	case strings.Contains(t, "occupan"), strings.Contains(eq, "occupancy_counter"):
		return kindOccupancy
	case strings.Contains(t, "energy"), strings.Contains(t, "kwh"), unit == "kwh":
		return kindEnergy
	case strings.Contains(t, "power"), unit == "kw":
		return kindPower
	case strings.Contains(t, "connected_users"), strings.Contains(t, "clients"),
		strings.Contains(t, "users"):
		return kindWifiUsers
	}
	return kindNone
}

// refreshBindings rescans the equipment store. Cheap enough to run every few
// seconds and it is the only thing that couples the simulation to equipment
// that other clients create.
func (s *Sim) refreshBindings() {
	var out []binding
	for _, eq := range s.store.ListEquipment("", "", "", "") {
		if eq == nil {
			continue
		}
		key := RoomKey{Level: eq.Level, Name: eq.Room}
		room := s.w.rooms[key]
		center := [2]float64{}
		if room != nil {
			center = room.Center
		}
		for _, sen := range eq.Sensors {
			kind := kindFor(sen, eq.Type)
			if kind == kindNone {
				continue
			}
			if kind != kindEnergy && kind != kindPower && kind != kindWifiUsers && room == nil {
				continue // room-scoped sensor in a room we do not model
			}
			out = append(out, binding{
				sensorID: sen.ID,
				kind:     kind,
				binary:   sen.DataType == "binary",
				room:     key,
				level:    eq.Level,
				center:   center,
			})
		}
	}
	s.bindings = out
}

// publishSensors writes the current model state to every bound sensor in a
// single store transaction.
func (s *Sim) publishSensors(now time.Time) {
	if len(s.bindings) == 0 {
		return
	}
	updates := make([]store.SensorUpdate, 0, len(s.bindings))
	text := func(id, v string) {
		updates = append(updates, store.SensorUpdate{SensorID: id, DataType: "text", Value: v})
	}
	binary := func(id string, v bool) {
		updates = append(updates, store.SensorUpdate{SensorID: id, DataType: "binary", BinaryValue: v})
	}

	for _, b := range s.bindings {
		st := s.rooms[b.room]
		switch b.kind {
		case kindTemperature:
			if st != nil {
				text(b.sensorID, fmt.Sprintf("%.1f", st.temp))
			}
		case kindCO2:
			if st != nil {
				text(b.sensorID, fmt.Sprintf("%.0f", st.co2))
			}
		case kindHumidity:
			if st != nil {
				text(b.sensorID, fmt.Sprintf("%.0f", s.humidity(st)))
			}
		case kindPresence, kindMotion:
			if st == nil {
				continue
			}
			on := st.count > 0
			if !on && st.seenPerson && now.Sub(st.lastPerson).Seconds() < motionHoldSimS {
				on = true
			}
			if b.binary {
				binary(b.sensorID, on)
			} else {
				text(b.sensorID, boolWord(on))
			}
		case kindOccupancy:
			if st == nil {
				continue
			}
			if b.binary {
				binary(b.sensorID, st.count > 0)
			} else {
				text(b.sensorID, fmt.Sprintf("%d", st.count))
			}
		case kindEnergy:
			text(b.sensorID, fmt.Sprintf("%.1f", s.energyKWh(b.level)))
		case kindPower:
			text(b.sensorID, fmt.Sprintf("%.2f", s.powerKW(b.level)))
		case kindWifiUsers:
			text(b.sensorID, fmt.Sprintf("%d", s.usersNear(b.level, b.center)))
		}
	}
	s.store.ApplySensorValues(updates)
}

func boolWord(v bool) string {
	if v {
		return "true"
	}
	return "false"
}

// humidity: drier when warm, wetter with people in the room.
func (s *Sim) humidity(st *roomState) float64 {
	h := 38 - (st.temp-21)*2.5 + st.density()*12
	return math.Max(20, math.Min(65, h))
}

// energyKWh returns the accumulated meter reading for a level, or the whole
// building when level is empty/unknown.
func (s *Sim) energyKWh(level string) float64 {
	if v, ok := s.energy[level]; ok {
		return v
	}
	total := 0.0
	for _, v := range s.energy {
		total += v
	}
	return total
}

func (s *Sim) powerKW(level string) float64 {
	if _, ok := s.energy[level]; ok {
		return s.levelPowerKW(level)
	}
	total := 0.0
	for lvl := range s.energy {
		total += s.levelPowerKW(lvl)
	}
	return total
}

func (s *Sim) levelPowerKW(level string) float64 {
	n := s.levelCounts[level]
	active := math.Min(1, float64(n)/20.0)
	return levelIdleKW + levelActiveKW*active + perPersonKW*float64(n)
}

// accumulateEnergy integrates the per-level meters over dt simulated seconds.
func (s *Sim) accumulateEnergy(dt float64) {
	for _, lvl := range s.w.levels {
		s.energy[lvl] += s.levelPowerKW(lvl) * dt / 3600.0
	}
}

// usersNear counts simulated people within radio range of an access point.
func (s *Sim) usersNear(level string, center [2]float64) int {
	n := 0
	for _, p := range s.people {
		if !p.inside || p.level != level {
			continue
		}
		if math.Hypot(p.x-center[0], p.y-center[1]) <= wifiRangeUnits {
			n++
		}
	}
	return n
}

// === provisioning ==========================================================

// provision creates the simulation's own climate equipment in every room it
// actually uses, plus one energy meter per floor and a building main meter.
// Existing equipment with the same id is left alone.
func (s *Sim) provision() int {
	created := 0
	for _, r := range s.w.ordered {
		if !s.active[r.Key] {
			continue
		}
		id := fmt.Sprintf("livesim-climate-%s-%s", r.Key.Level, r.Key.Name)
		if _, exists := s.store.GetEquipment(id); exists {
			continue
		}
		s.store.CreateEquipment(&model.Equipment{
			ID:       id,
			Name:     "Room climate " + r.Key.Name,
			Type:     "air_quality_sensor",
			Category: "monitoring",
			Level:    r.Key.Level,
			Room:     r.Key.Name,
			Status:   "running",
			Sensors: []model.Sensor{
				{ID: id + "-temp", Name: "Temperature", Type: "temperature", DataType: "text", Unit: "°C", Value: "21.0"},
				{ID: id + "-co2", Name: "CO2", Type: "co2", DataType: "text", Unit: "ppm", Value: "420"},
				{ID: id + "-humidity", Name: "Humidity", Type: "humidity", DataType: "text", Unit: "%", Value: "38"},
				{ID: id + "-presence", Name: "Presence", Type: "presence", DataType: "binary"},
				{ID: id + "-occupancy", Name: "Occupancy", Type: "occupancy_count", DataType: "text", Unit: "persons", Value: "0"},
			},
		})
		created++
	}

	meterRooms := pickPerLevel(s.w.ordered, s.w.levels)
	for _, lvl := range s.w.levels {
		room, ok := meterRooms[lvl]
		if !ok {
			continue
		}
		id := "livesim-energy-" + lvl
		if _, exists := s.store.GetEquipment(id); exists {
			continue
		}
		s.store.CreateEquipment(&model.Equipment{
			ID:       id,
			Name:     "Energy meter " + lvl,
			Type:     "distribution_panel",
			Category: "energy",
			Level:    lvl,
			Room:     room.Key.Name,
			Status:   "running",
			Sensors: []model.Sensor{
				{ID: id + "-energy", Name: "Energy", Type: "energy", DataType: "text", Unit: "kWh", Value: "0.0"},
				{ID: id + "-power", Name: "Power", Type: "power", DataType: "text", Unit: "kW", Value: "0.00"},
			},
		})
		created++
	}
	return created
}
