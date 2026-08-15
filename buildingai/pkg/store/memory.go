package store

import (
	"strings"
	"sync"
	"time"

	"github.com/styrops/buildingai/pkg/model"
)

type MemoryStore struct {
	mu sync.RWMutex

	// Building data (read-only, loaded at startup)
	building        model.Building
	floors          map[string]*model.FloorData // level id -> floor data
	crossFloorEdges []model.CrossFloorEdge
	multiFloorGraph *model.NavGraph

	// Equipment (global, in-memory)
	equipment         map[string]*model.Equipment
	sensors           map[string]*model.Sensor   // sensor id -> sensor
	sensorEquipment   map[string]string          // sensor id -> equipment id
	actuators         map[string]*model.Actuator // actuator id -> actuator
	actuatorEquipment map[string]string          // actuator id -> equipment id
	noteEquipment     map[string]string          // note id -> equipment id
	equipmentVersion  int64

	// Global occupancy and coverage (persistent, not per-session)
	occupancy        map[string]model.RoomOccupancy
	occupancyVersion int64
	coverage         []model.CoverageZone
	coverageVersion  int64

	// Sessions
	sessions map[string]*model.Session
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		floors:            make(map[string]*model.FloorData),
		equipment:         make(map[string]*model.Equipment),
		sensors:           make(map[string]*model.Sensor),
		sensorEquipment:   make(map[string]string),
		actuators:         make(map[string]*model.Actuator),
		actuatorEquipment: make(map[string]string),
		noteEquipment:     make(map[string]string),
		occupancy:         make(map[string]model.RoomOccupancy),
		coverage:          []model.CoverageZone{},
		sessions:          make(map[string]*model.Session),
	}
}

// === Building ===

func (s *MemoryStore) SetBuilding(b model.Building) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.building = b
}

func (s *MemoryStore) GetBuilding() model.Building {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.building
}

func (s *MemoryStore) SetFloorData(levelID string, data *model.FloorData) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.floors[levelID] = data
}

func (s *MemoryStore) GetFloorData(levelID string) (*model.FloorData, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, ok := s.floors[levelID]
	return d, ok
}

func (s *MemoryStore) SetCrossFloorEdges(edges []model.CrossFloorEdge) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.crossFloorEdges = edges
}

func (s *MemoryStore) GetCrossFloorEdges() []model.CrossFloorEdge {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.crossFloorEdges
}

func (s *MemoryStore) SetMultiFloorGraph(g *model.NavGraph) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.multiFloorGraph = g
}

func (s *MemoryStore) GetMultiFloorGraph() *model.NavGraph {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.multiFloorGraph
}

func (s *MemoryStore) GetFloors() map[string]*model.FloorData {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.floors
}

// === Equipment ===

func (s *MemoryStore) CreateEquipment(e *model.Equipment) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e.Version = s.equipmentVersion
	if e.Sensors == nil {
		e.Sensors = []model.Sensor{}
	}
	if e.Actuators == nil {
		e.Actuators = []model.Actuator{}
	}
	if e.Notes == nil {
		e.Notes = []model.Note{}
	}
	now := time.Now()
	for i := range e.Sensors {
		if e.Sensors[i].Timestamp.IsZero() {
			e.Sensors[i].Timestamp = now
		}
		s.sensorEquipment[e.Sensors[i].ID] = e.ID
	}
	for i := range e.Actuators {
		if e.Actuators[i].Timestamp.IsZero() {
			e.Actuators[i].Timestamp = now
		}
		s.actuatorEquipment[e.Actuators[i].ID] = e.ID
	}
	for i := range e.Notes {
		if e.Notes[i].Timestamp.IsZero() {
			e.Notes[i].Timestamp = now
		}
		s.noteEquipment[e.Notes[i].ID] = e.ID
	}
	s.publishEquipmentLocked(e)
}

// cloneEquipmentLocked returns a private copy of a stored equipment record.
//
// Equipment records are published by pointer (GetEquipment / ListEquipment hand
// the pointer to a handler, which serialises it *after* the store lock is
// released). Mutating a published record in place therefore races with readers.
// Every mutation instead clones, mutates the clone and republishes it, so a
// record is immutable once it has been handed out. Callers must hold the write
// lock. Returns nil if the equipment does not exist.
func (s *MemoryStore) cloneEquipmentLocked(id string) *model.Equipment {
	e, ok := s.equipment[id]
	if !ok {
		return nil
	}
	c := *e
	c.Sensors = append(make([]model.Sensor, 0, len(e.Sensors)), e.Sensors...)
	c.Actuators = append(make([]model.Actuator, 0, len(e.Actuators)), e.Actuators...)
	c.Notes = append(make([]model.Note, 0, len(e.Notes)), e.Notes...)
	return &c
}

// publishEquipmentLocked stores a record and re-points the sensor/actuator
// indexes at it. Callers must hold the write lock.
func (s *MemoryStore) publishEquipmentLocked(e *model.Equipment) {
	s.equipment[e.ID] = e
	for i := range e.Sensors {
		s.sensors[e.Sensors[i].ID] = &e.Sensors[i]
	}
	for i := range e.Actuators {
		s.actuators[e.Actuators[i].ID] = &e.Actuators[i]
	}
}

func (s *MemoryStore) GetEquipment(id string) (*model.Equipment, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e, ok := s.equipment[id]
	return e, ok
}

func (s *MemoryStore) ListEquipment(level, roomFilter, typeFilter, category string) []*model.Equipment {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var result []*model.Equipment
	for _, e := range s.equipment {
		if level != "" && e.Level != level {
			continue
		}
		if roomFilter != "" && !strings.EqualFold(e.Room, roomFilter) {
			continue
		}
		if typeFilter != "" && e.Type != typeFilter {
			continue
		}
		if category != "" && e.Category != category {
			continue
		}
		result = append(result, e)
	}
	return result
}

func (s *MemoryStore) UpdateEquipment(e *model.Equipment) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	old, ok := s.equipment[e.ID]
	if !ok {
		return false
	}
	// Drop index entries for sensors/actuators the replacement no longer has,
	// then republish so the indexes point at the new record.
	kept := make(map[string]bool, len(e.Sensors)+len(e.Actuators))
	for i := range e.Sensors {
		kept[e.Sensors[i].ID] = true
		s.sensorEquipment[e.Sensors[i].ID] = e.ID
	}
	for i := range e.Actuators {
		kept[e.Actuators[i].ID] = true
		s.actuatorEquipment[e.Actuators[i].ID] = e.ID
	}
	for i := range old.Sensors {
		if id := old.Sensors[i].ID; !kept[id] {
			delete(s.sensors, id)
			delete(s.sensorEquipment, id)
		}
	}
	for i := range old.Actuators {
		if id := old.Actuators[i].ID; !kept[id] {
			delete(s.actuators, id)
			delete(s.actuatorEquipment, id)
		}
	}
	s.publishEquipmentLocked(e)
	return true
}

func (s *MemoryStore) DeleteEquipment(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.equipment[id]
	if !ok {
		return false
	}
	// Clean up sensor/actuator mappings
	for _, sen := range e.Sensors {
		delete(s.sensors, sen.ID)
		delete(s.sensorEquipment, sen.ID)
	}
	for _, act := range e.Actuators {
		delete(s.actuators, act.ID)
		delete(s.actuatorEquipment, act.ID)
	}
	for _, n := range e.Notes {
		delete(s.noteEquipment, n.ID)
	}
	delete(s.equipment, id)
	return true
}

func (s *MemoryStore) BumpEquipmentVersion() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.equipmentVersion++
	return s.equipmentVersion
}

func (s *MemoryStore) GetEquipmentVersion() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.equipmentVersion
}

// === Sensors ===

func (s *MemoryStore) AddSensor(equipmentID string, sen *model.Sensor) (bool, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.equipment[equipmentID]
	if !ok {
		return false, "equipment not found"
	}
	if _, exists := s.sensors[sen.ID]; exists {
		return false, "sensor already exists"
	}
	sen.Timestamp = time.Now()
	c := s.cloneEquipmentLocked(e.ID)
	c.Sensors = append(c.Sensors, *sen)
	s.publishEquipmentLocked(c)
	s.sensorEquipment[sen.ID] = equipmentID
	return true, ""
}

func (s *MemoryStore) GetSensorsForEquipment(equipmentID string) ([]model.Sensor, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e, ok := s.equipment[equipmentID]
	if !ok {
		return nil, false
	}
	return e.Sensors, true
}

func (s *MemoryStore) DeleteSensor(sensorID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	eqID, ok := s.sensorEquipment[sensorID]
	if !ok {
		return false
	}
	if c := s.cloneEquipmentLocked(eqID); c != nil {
		for i, sen := range c.Sensors {
			if sen.ID == sensorID {
				c.Sensors = append(c.Sensors[:i], c.Sensors[i+1:]...)
				break
			}
		}
		s.publishEquipmentLocked(c)
	}
	delete(s.sensors, sensorID)
	delete(s.sensorEquipment, sensorID)
	return true
}

func (s *MemoryStore) SetSensorValue(sensorID string, val model.SensorValue) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.setSensorValueLocked(sensorID, val)
}

// SensorUpdate is one sensor value write. Used by ApplySensorValues to push a
// whole simulation tick worth of readings in a single lock acquisition.
type SensorUpdate struct {
	SensorID    string
	DataType    string // "binary" or "text"
	Value       string // used when DataType != "binary"
	BinaryValue bool   // used when DataType == "binary"
}

// ApplySensorValues writes a batch of sensor readings and returns how many were
// applied. Sensors that no longer exist are skipped. Each affected equipment
// record is cloned and republished once, so concurrent readers never observe a
// half-written record.
func (s *MemoryStore) ApplySensorValues(updates []SensorUpdate) int {
	if len(updates) == 0 {
		return 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	byEquipment := make(map[string][]SensorUpdate)
	for _, u := range updates {
		eqID, ok := s.sensorEquipment[u.SensorID]
		if !ok {
			continue
		}
		byEquipment[eqID] = append(byEquipment[eqID], u)
	}

	applied := 0
	now := time.Now()
	for eqID, ups := range byEquipment {
		c := s.cloneEquipmentLocked(eqID)
		if c == nil {
			continue
		}
		index := make(map[string]int, len(c.Sensors))
		for i := range c.Sensors {
			index[c.Sensors[i].ID] = i
		}
		changed := false
		for _, u := range ups {
			i, ok := index[u.SensorID]
			if !ok {
				continue
			}
			applySensorUpdate(&c.Sensors[i], u, now)
			changed = true
			applied++
		}
		if changed {
			s.publishEquipmentLocked(c)
		}
	}
	return applied
}

func applySensorUpdate(sen *model.Sensor, u SensorUpdate, now time.Time) {
	sen.DataType = u.DataType
	if u.DataType == "binary" {
		sen.BinaryValue = u.BinaryValue
	} else {
		sen.Value = u.Value
	}
	sen.Timestamp = now
}

// setSensorValueLocked applies a single value; callers must hold the write lock.
func (s *MemoryStore) setSensorValueLocked(sensorID string, val model.SensorValue) bool {
	eqID, ok := s.sensorEquipment[sensorID]
	if !ok {
		return false
	}
	c := s.cloneEquipmentLocked(eqID)
	if c == nil {
		return false
	}
	for i := range c.Sensors {
		if c.Sensors[i].ID != sensorID {
			continue
		}
		u := SensorUpdate{SensorID: sensorID, DataType: val.DataType, Value: val.Value}
		if val.DataType == "binary" && val.BinaryValue != nil {
			u.BinaryValue = *val.BinaryValue
		} else if val.DataType == "binary" {
			// binary write without a value: keep the previous reading
			u.BinaryValue = c.Sensors[i].BinaryValue
		}
		applySensorUpdate(&c.Sensors[i], u, time.Now())
		s.publishEquipmentLocked(c)
		return true
	}
	return false
}

// === Actuators ===

func (s *MemoryStore) AddActuator(equipmentID string, act *model.Actuator) (bool, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.equipment[equipmentID]
	if !ok {
		return false, "equipment not found"
	}
	if _, exists := s.actuators[act.ID]; exists {
		return false, "actuator already exists"
	}
	act.Timestamp = time.Now()
	c := s.cloneEquipmentLocked(e.ID)
	c.Actuators = append(c.Actuators, *act)
	s.publishEquipmentLocked(c)
	s.actuatorEquipment[act.ID] = equipmentID
	return true, ""
}

func (s *MemoryStore) GetActuatorsForEquipment(equipmentID string) ([]model.Actuator, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e, ok := s.equipment[equipmentID]
	if !ok {
		return nil, false
	}
	return e.Actuators, true
}

func (s *MemoryStore) DeleteActuator(actuatorID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	eqID, ok := s.actuatorEquipment[actuatorID]
	if !ok {
		return false
	}
	if c := s.cloneEquipmentLocked(eqID); c != nil {
		for i, act := range c.Actuators {
			if act.ID == actuatorID {
				c.Actuators = append(c.Actuators[:i], c.Actuators[i+1:]...)
				break
			}
		}
		s.publishEquipmentLocked(c)
	}
	delete(s.actuators, actuatorID)
	delete(s.actuatorEquipment, actuatorID)
	return true
}

func (s *MemoryStore) SetActuatorState(actuatorID string, state model.ActuatorState) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	eqID, ok := s.actuatorEquipment[actuatorID]
	if !ok {
		return false
	}
	c := s.cloneEquipmentLocked(eqID)
	if c == nil {
		return false
	}
	for i := range c.Actuators {
		if c.Actuators[i].ID == actuatorID {
			c.Actuators[i].State = state.State
			c.Actuators[i].Timestamp = time.Now()
			s.publishEquipmentLocked(c)
			return true
		}
	}
	return false
}

// === Notes ===

func (s *MemoryStore) AddNote(equipmentID string, n *model.Note) (bool, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.equipment[equipmentID]
	if !ok {
		return false, "equipment not found"
	}
	if _, exists := s.noteEquipment[n.ID]; exists {
		return false, "note already exists"
	}
	n.Timestamp = time.Now()
	c := s.cloneEquipmentLocked(e.ID)
	c.Notes = append(c.Notes, *n)
	s.publishEquipmentLocked(c)
	s.noteEquipment[n.ID] = equipmentID
	return true, ""
}

func (s *MemoryStore) GetNotesForEquipment(equipmentID string) ([]model.Note, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e, ok := s.equipment[equipmentID]
	if !ok {
		return nil, false
	}
	return e.Notes, true
}

func (s *MemoryStore) DeleteNote(noteID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	eqID, ok := s.noteEquipment[noteID]
	if !ok {
		return false
	}
	if c := s.cloneEquipmentLocked(eqID); c != nil {
		for i, n := range c.Notes {
			if n.ID == noteID {
				c.Notes = append(c.Notes[:i], c.Notes[i+1:]...)
				break
			}
		}
		s.publishEquipmentLocked(c)
	}
	delete(s.noteEquipment, noteID)
	return true
}

// === Global Occupancy ===

func (s *MemoryStore) SetOccupancy(occ map[string]model.RoomOccupancy) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.occupancy = occ
	s.occupancyVersion++
	return s.occupancyVersion
}

func (s *MemoryStore) GetOccupancy() map[string]model.RoomOccupancy {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.occupancy
}

func (s *MemoryStore) GetOccupancyVersion() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.occupancyVersion
}

// === Global Coverage ===

func (s *MemoryStore) SetCoverage(cov []model.CoverageZone) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.coverage = cov
	s.coverageVersion++
	return s.coverageVersion
}

func (s *MemoryStore) GetCoverage() []model.CoverageZone {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.coverage
}

// === Sessions ===

func (s *MemoryStore) CreateSession(id string) *model.Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess := &model.Session{
		ID:           id,
		Viewport:     model.Viewport{Mode: "3d", Floor: "level0", Zoom: 1.0},
		Highlights:   []model.RoomHighlight{},
		Occupancy:    make(map[string]model.RoomOccupancy),
		Coverage:     []model.CoverageZone{},
		LastWSActive: time.Now(),
	}
	s.sessions[id] = sess
	return sess
}

func (s *MemoryStore) ListSessions() []*model.Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var result []*model.Session
	for _, sess := range s.sessions {
		result = append(result, sess)
	}
	return result
}

func (s *MemoryStore) GetSession(id string) (*model.Session, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sess, ok := s.sessions[id]
	return sess, ok
}

func (s *MemoryStore) DeleteSession(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.sessions[id]
	if ok {
		delete(s.sessions, id)
	}
	return ok
}

func (s *MemoryStore) UpdateSessionViewport(id string, vp model.Viewport) (int64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	if !ok {
		return 0, false
	}
	sess.Viewport = vp
	sess.Version++
	return sess.Version, true
}

func (s *MemoryStore) UpdateSessionHighlights(id string, highlights []model.RoomHighlight) (int64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	if !ok {
		return 0, false
	}
	sess.Highlights = highlights
	sess.Version++
	return sess.Version, true
}

func (s *MemoryStore) UpdateSessionOccupancy(id string, occupancy map[string]model.RoomOccupancy) (int64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	if !ok {
		return 0, false
	}
	sess.Occupancy = occupancy
	sess.Version++
	return sess.Version, true
}

func (s *MemoryStore) UpdateSessionCoverage(id string, coverage []model.CoverageZone) (int64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	if !ok {
		return 0, false
	}
	sess.Coverage = coverage
	sess.Version++
	return sess.Version, true
}

func (s *MemoryStore) UpdateSessionRoute(id string, route *model.RouteResult) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	if !ok {
		return false
	}
	sess.Route = route
	sess.Version++
	return true
}

func (s *MemoryStore) TouchSession(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sess, ok := s.sessions[id]; ok {
		sess.LastWSActive = time.Now()
	}
}

func (s *MemoryStore) PurgeInactiveSessions(maxAge time.Duration) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var purged []string
	now := time.Now()
	for id, sess := range s.sessions {
		if now.Sub(sess.LastWSActive) > maxAge {
			delete(s.sessions, id)
			purged = append(purged, id)
		}
	}
	return purged
}
