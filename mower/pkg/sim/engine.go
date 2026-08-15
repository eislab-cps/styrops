package sim

// engine.go — the concrete Engine. One mutex owns all state; the tick loop
// takes it for the duration of a wall tick and the Brain runs inside that
// critical section, so brains never observe a torn world.
//
// Time model: the physics runs at a fixed 50 Hz of SIM time. SetSpeed(mult)
// scales how many sim-seconds are consumed per wall tick, so at mult=1 the sim
// runs in real time and at mult=200 one wall second is 200 sim seconds.

import (
	"errors"
	"fmt"
	"math"
	"math/rand"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/styrops/huskvarna-demo/pkg/model"
	"github.com/styrops/huskvarna-demo/pkg/sdk"
)

const (
	brainPeriod  = 0.1 // sim seconds between Brain.Step calls (10 Hz)
	wallTick     = 20 * time.Millisecond
	statusPeriod = 0.2 // sim seconds between status events (~5 Hz)
	grassPeriod  = 0.5 // sim seconds between grass diffs (~2 Hz)
	statsPeriod  = 2.0 // sim seconds between grow+coverage sweeps

	defaultCutHeight = 35.0 // mm
	defaultSeed      = 20260406
	defaultBrainName = "automower"
)

type engine struct {
	mu sync.Mutex

	seed int64
	rndP *rand.Rand // process/actuator noise (tick loop)
	rndS *rand.Rand // sensor noise

	world   model.World
	grass   *grassGrid
	nextObs int

	// wandering wildlife (see hedgehog.go)
	hogs     map[string]*hogState
	hogRef   map[string]model.Vec2 // positions at the last world event
	hogCount int
	hogEmitT float64

	simT  float64
	speed float64

	// --- robot ground truth ---
	pose           model.Pose
	v, omega       float64 // actual body velocities
	cmdV, cmdOmega float64 // commanded (brain or manual)
	bladeOn        bool
	cutHeight      float64
	sharpness      float64 // 1.0 factory sharp .. 0.0 dead
	battery        float64 // percent
	charging       bool
	brainState     model.RobotState
	estPose        *model.Pose
	slam           *model.RobotMap // latest map published by the active brain
	manual         bool

	// --- missions ---
	mission    *model.Mission
	pendingMow *model.Mission // stashed while an explicit dock mission runs
	missionSeq int
	coverage   model.CoverageStats

	// --- sensor plumbing ---
	odoBrain, odoAPI   model.Odometry
	odoBiasL, odoBiasR float64
	gpsN               model.Vec2
	lastSensorT        float64
	headBias           float64
	bumpBrain, bumpAPI model.Bump
	lastCollT          float64
	lastCollLogT       float64
	collisions         int

	// --- safety layer ---
	anchorPos  model.Vec2
	anchorT    float64
	stuck      bool
	stuckSince *float64

	// --- weather ---
	wx        *weatherGen
	weather   model.Weather
	wxCond    string
	wxIdx     int
	wet       bool
	lastRainT float64
	wxOv      *wxOverride // manual weather override, nil = generator in charge

	// --- brain ---
	brain     sdk.Brain
	brainName string
	robot     sdk.Robot

	// --- accumulators ---
	brainAcc, statusAcc, grassAcc, statsAcc, driftAcc, wxAcc float64
	battMilestone                                            int

	logs      *logRing
	bus       *eventBus
	done      chan struct{}
	closeOnce sync.Once
}

// New builds the default villa-garden simulation with the demo seed.
func New() Engine { return NewWithSeed(defaultSeed) }

// NewWithSeed builds a simulation with an explicit RNG seed. Given the same
// seed and the same sequence of calls the run is bit-for-bit reproducible.
func NewWithSeed(seed int64) Engine { return newEngine(seed) }

func newEngine(seed int64) *engine {
	e := &engine{
		seed:  seed,
		speed: 1,
		logs:  newLogRing(),
		bus:   newEventBus(),
		done:  make(chan struct{}),
	}
	e.robot = &robotAdapter{e: e}
	e.reset(true)
	return e
}

// reset (re)builds the world and the robot. Caller must hold e.mu unless the
// engine is not published yet. full=true also rebuilds the weather generator.
func (e *engine) reset(full bool) {
	rndW := rand.New(rand.NewSource(e.seed))
	e.rndP = rand.New(rand.NewSource(e.seed + 1))
	e.rndS = rand.New(rand.NewSource(e.seed + 2))

	e.world = defaultWorld(rndW)
	e.grass = newGrassGrid(e.world, rndW)
	e.nextObs = 1
	e.hogs = map[string]*hogState{}
	e.hogRef = map[string]model.Vec2{}
	e.hogEmitT = 0
	e.refreshHogs()

	if full {
		e.simT = 0
		e.wx = newWeatherGen(e.seed)
		e.wxIdx = -1
		e.lastRainT = -1e9
	}
	p := e.wx.at(e.simT)
	e.wxCond = p.cond
	e.weather = e.buildWeather()
	e.wxIdx = e.wx.periodIndex(e.simT)
	if isRaining(p.cond) {
		e.lastRainT = e.simT
	}
	e.wet = isRaining(p.cond) || e.simT-e.lastRainT < wetAfterRainSec

	// Robot starts parked on the charger, fully charged.
	e.pose = model.Pose{X: e.world.Dock.Pos.X, Y: e.world.Dock.Pos.Y, Theta: e.world.Dock.Heading}
	e.v, e.omega, e.cmdV, e.cmdOmega = 0, 0, 0, 0
	e.bladeOn = false
	e.cutHeight = defaultCutHeight
	e.sharpness = 1.0
	e.battery = 100
	e.charging = true
	e.brainState = model.StateIdle
	e.estPose = nil
	e.manual = false
	e.mission, e.pendingMow = nil, nil
	e.battMilestone = 101

	e.odoBrain, e.odoAPI = model.Odometry{}, model.Odometry{}
	e.odoBiasL = 1 + rndW.NormFloat64()*0.006
	e.odoBiasR = 1 + rndW.NormFloat64()*0.006
	e.gpsN = model.Vec2{}
	e.lastSensorT = e.simT
	e.headBias = 0
	e.bumpBrain, e.bumpAPI = model.Bump{}, model.Bump{}
	e.lastCollT, e.lastCollLogT, e.collisions = -1e9, -1e9, 0

	e.anchorPos = v2(e.pose.X, e.pose.Y)
	e.anchorT = e.simT
	e.stuck, e.stuckSince = false, nil

	e.wxOv = nil
	e.brainAcc, e.statusAcc, e.grassAcc, e.statsAcc, e.driftAcc, e.wxAcc = 0, 0, 0, 0, 0, 0
	e.coverage = e.grass.growAndStats(0, e.cutHeight, e.world.Zones)

	name := e.brainName
	if name == "" {
		name = defaultBrainName
	}
	e.installBrain(name)
}

// installBrain swaps in a fresh instance, falling back to a parked brain when
// pkg/brain has not been linked in (e.g. a bare unit test).
func (e *engine) installBrain(name string) {
	// A fresh brain starts with an empty head: whatever the previous algorithm
	// had mapped is not this one's knowledge.
	e.slam = nil
	if f, ok := sdk.Registry[name]; ok {
		e.brain = f()
		e.brainName = name
		return
	}
	e.brain = parkedBrain{}
	e.brainName = "parked"
}

// parkedBrain is the no-op fallback: it keeps the mower still.
type parkedBrain struct{}

func (parkedBrain) Name() string        { return "parked" }
func (parkedBrain) Description() string { return "no algorithm linked in; the mower stays put" }
func (parkedBrain) Step(r sdk.Robot, _ float64) {
	r.Drive(0, 0)
	r.Blade(false)
	r.SetState(model.StateIdle)
}

// ---------------------------------------------------------------- tick loop

func (e *engine) Run() {
	ticker := time.NewTicker(wallTick)
	defer ticker.Stop()
	for {
		select {
		case <-e.done:
			return
		case <-ticker.C:
			e.mu.Lock()
			e.advanceLocked(e.speed * wallTick.Seconds())
			e.mu.Unlock()
		}
	}
}

func (e *engine) Close() {
	e.closeOnce.Do(func() {
		close(e.done)
		e.bus.close()
	})
}

// advance runs the sim forward by simSeconds. Used by Run and by tests that
// want to skip ahead without waiting on the wall clock.
func (e *engine) advance(simSeconds float64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.advanceLocked(simSeconds)
}

func (e *engine) advanceLocked(simSeconds float64) {
	n := int(simSeconds/physicsDT + 0.5)
	for i := 0; i < n; i++ {
		e.simT += physicsDT
		e.stepWeather(physicsDT)

		e.brainAcc += physicsDT
		if e.brainAcc >= brainPeriod-1e-9 {
			e.brainAcc = 0
			if !e.manual && e.brain != nil {
				e.brain.Step(e.robot, brainPeriod)
			}
		}

		e.stepPhysics(physicsDT)
		e.stepHedgehogs(physicsDT)
		e.stepCutting(physicsDT)
		e.stepBattery(physicsDT)
		e.stepStuck()
		e.stepDrift(physicsDT)
		e.stepStats(physicsDT)
		e.stepMission()
		e.stepEvents(physicsDT)
	}
}

// stepDrift slowly walks the compass bias (the reason dead reckoning needs a
// complementary filter).
func (e *engine) stepDrift(dt float64) {
	e.driftAcc += dt
	if e.driftAcc < 1.0 {
		return
	}
	e.driftAcc = 0
	e.headBias = clamp(e.headBias+e.rndP.NormFloat64()*0.004, -0.15, 0.15)
}

func (e *engine) stepWeather(dt float64) {
	e.wxAcc += dt
	if e.wxAcc < 1.0 {
		return
	}
	e.wxAcc = 0
	if e.wxOv != nil && e.simT >= e.wxOv.until {
		e.wxOv = nil
		e.logf("info", "system", "weather override expired, forecast resumed", nil)
	}
	idx := e.wx.periodIndex(e.simT)
	p := e.currentPeriod()
	if idx != e.wxIdx {
		e.wxIdx = idx
		e.weather = e.buildWeather()
	}
	if p.cond != e.wxCond {
		e.applyWeatherChange(p, "")
	}
	e.updateWetness(p)
}

// currentPeriod is the weather actually in force: the manual override while
// one is running, otherwise the generator.
func (e *engine) currentPeriod() wxPeriod {
	if e.wxOv != nil && e.simT < e.wxOv.until {
		return e.wxOv.p
	}
	return e.wx.at(e.simT)
}

// applyWeatherChange records a new condition and tells everyone about it.
func (e *engine) applyWeatherChange(p wxPeriod, why string) {
	e.wxCond = p.cond
	e.weather = e.buildWeather()
	f := map[string]any{
		"condition": p.cond,
		"temp_c":    math.Round(p.tempC*10) / 10,
		"rain_mm_h": math.Round(p.rainMmH*10) / 10,
	}
	if why != "" {
		f["source"] = why
	}
	e.logf("info", "system", "weather changed", f)
	e.notice("weather", "weather is now "+p.cond)
}

// updateWetness keeps the wet-grass flag (growth x3, extra wheel slip, higher
// blade current) in step with whatever weather is in force.
func (e *engine) updateWetness(p wxPeriod) {
	if isRaining(p.cond) {
		e.lastRainT = e.simT
	}
	e.wet = isRaining(p.cond) || e.simT-e.lastRainT < wetAfterRainSec
}

// buildWeather renders the API view, splicing an active override over the
// generated forecast so the UI shows the override window then the resumption.
func (e *engine) buildWeather() model.Weather {
	w := e.wx.weather(e.simT)
	if e.wxOv == nil || e.simT >= e.wxOv.until {
		return w
	}
	p := e.wxOv.p
	w.Now = model.WeatherNow{
		Condition: p.cond,
		TempC:     math.Round(p.tempC*10) / 10,
		WindMps:   math.Round(p.windMps*10) / 10,
		RainMmH:   math.Round(p.rainMmH*10) / 10,
	}
	left := e.wxOv.until - e.simT
	for i := range w.Forecast {
		if float64(w.Forecast[i].HoursAhead)*3600 <= left {
			w.Forecast[i].Condition = p.cond
			w.Forecast[i].TempC = math.Round(p.tempC*10) / 10
			w.Forecast[i].RainProb = p.rainPrb
		}
	}
	return w
}

// stepStats grows the grass and recomputes coverage in one full-grid sweep.
func (e *engine) stepStats(dt float64) {
	e.statsAcc += dt
	if e.statsAcc < statsPeriod {
		return
	}
	grow := growMMPerH * (e.statsAcc / 3600)
	if e.wet {
		grow *= growWetMult
	}
	e.statsAcc = 0
	e.coverage = e.grass.growAndStats(grow, e.cutHeight, e.world.Zones)
}

func (e *engine) stepEvents(dt float64) {
	e.statusAcc += dt
	if e.statusAcc >= statusPeriod {
		e.statusAcc = 0
		e.bus.publish(Event{Type: "status", Data: e.statusLocked()})
	}
	e.grassAcc += dt
	if e.grassAcc >= grassPeriod {
		e.grassAcc = 0
		if d := e.grass.diff(); len(d.Cells) > 0 {
			e.bus.publish(Event{Type: "grass", Data: d})
		}
	}
}

// stepMission keeps Mission.Progress current and closes missions out.
func (e *engine) stepMission() {
	if e.mission == nil {
		return
	}
	switch e.mission.Kind {
	case "mow":
		p := e.coverage.CutPercent / 100
		if e.mission.Zone != "" {
			if zs, ok := e.coverage.ByZone[e.mission.Zone]; ok {
				p = zs.CutPercent / 100
			}
		}
		e.mission.Progress = clamp(p, 0, 1)
		if p >= 0.95 {
			z := e.mission.Zone
			if z == "" {
				z = "whole lawn"
			}
			e.logAt("info", "nav", "mow mission complete", map[string]any{
				"zone": z, "cut_percent": math.Round(e.coverage.CutPercent*10) / 10,
			})
			e.notice("mission_done", "finished mowing "+z)
			e.mission = nil
		}
	case "dock":
		if e.charging {
			e.mission.Progress = clamp(e.battery/95, 0, 1)
		}
		if e.charging && e.battery >= 95 {
			e.logAt("info", "nav", "dock mission complete", map[string]any{
				"percent": math.Round(e.battery),
			})
			e.notice("mission_done", "docked and charged")
			// Resume whatever mow mission the dock request interrupted.
			e.mission, e.pendingMow = e.pendingMow, nil
			if e.mission != nil {
				e.logAt("info", "nav", "resuming interrupted mow mission", map[string]any{
					"zone": e.mission.Zone,
				})
			}
		}
	}
}

// ---------------------------------------------------------------- log/events

func (e *engine) logf(level, source, msg string, fields map[string]any) {
	en := model.LogEntry{
		T:      math.Round(e.simT*100) / 100,
		Wall:   time.Now(),
		Level:  level,
		Source: source,
		Msg:    msg,
		Fields: fields,
	}
	// Repeated warnings (a mower bouncing off the same rock) are folded into
	// the entry that started the burst and are not re-pushed to subscribers.
	if e.logs.add(en) {
		e.bus.publish(Event{Type: "log", Data: en})
	}
}

// logAt is logf plus where it happened: the mower's GROUND-TRUTH position,
// rounded to 0.1 m. Used for every engine-written entry that has a meaningful
// location (collisions, blade events, stuck, docking, missions, battery).
func (e *engine) logAt(level, source, msg string, fields map[string]any) {
	e.logf(level, source, msg, withXY(fields, e.pose.X, e.pose.Y))
}

// withXY copies fields and adds x/y rounded to 0.1 m. It never mutates the
// caller's map, and it leaves any existing keys (including a fold's "repeats")
// alone.
func withXY(fields map[string]any, x, y float64) map[string]any {
	out := make(map[string]any, len(fields)+2)
	for k, v := range fields {
		out[k] = v
	}
	out["x"] = math.Round(x*10) / 10
	out["y"] = math.Round(y*10) / 10
	return out
}

func (e *engine) notice(kind, msg string) {
	e.bus.publish(Event{Type: "event", Data: Notice{Kind: kind, Msg: msg}})
}

func (e *engine) publishWorld() {
	e.bus.publish(Event{Type: "world", Data: e.worldLocked()})
}

// ---------------------------------------------------------------- read side

func (e *engine) worldLocked() model.World {
	w := e.world
	w.Obstacles = append([]model.Obstacle(nil), e.world.Obstacles...)
	return w
}

func (e *engine) deriveState() model.RobotState {
	switch {
	case e.manual:
		return model.StateManual
	case e.battery <= 0:
		return model.StateError
	case e.stuck:
		return model.StateStuck
	case e.charging:
		return model.StateCharging
	}
	if e.brainState != "" {
		return e.brainState
	}
	return model.StateIdle
}

func (e *engine) statusLocked() model.RobotStatus {
	st := model.RobotStatus{
		State:          e.deriveState(),
		Pose:           e.pose,
		Battery:        e.batteryStateNoNoise(),
		BladeOn:        e.bladeOn,
		CutHeight:      e.cutHeight,
		BladeSharpness: math.Round(e.sharpness*1000) / 1000,
		Brain:          e.brainName,
		Coverage:       e.coverage,
		Weather:        e.weather.Now,
		SimTime:        math.Round(e.simT*100) / 100,
		SimSpeed:       e.speed,
	}
	if e.estPose != nil {
		p := *e.estPose
		st.EstPose = &p
	}
	if e.mission != nil {
		m := *e.mission
		st.Mission = &m
	}
	if e.stuckSince != nil {
		t := *e.stuckSince
		st.StuckSince = &t
	}
	// Coverage map is shared with the grid; hand out a copy.
	byZone := make(map[string]model.ZoneStats, len(e.coverage.ByZone))
	for k, v := range e.coverage.ByZone {
		byZone[k] = v
	}
	st.Coverage.ByZone = byZone
	return st
}

// batteryStateNoNoise is the UI/status view of the pack (no sensor noise).
func (e *engine) batteryStateNoNoise() model.Battery {
	return model.Battery{
		Percent:  math.Round(e.battery*10) / 10,
		Voltage:  math.Round((18.0+0.036*e.battery)*100) / 100,
		Charging: e.charging,
	}
}

func (e *engine) World() model.World {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.worldLocked()
}

func (e *engine) Grass() model.GrassGrid {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.grass.snapshot()
}

func (e *engine) Status() model.RobotStatus {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.statusLocked()
}

func (e *engine) Weather() model.Weather {
	e.mu.Lock()
	defer e.mu.Unlock()
	w := e.weather
	w.Forecast = append([]model.WeatherPeriod(nil), e.weather.Forecast...)
	return w
}

func (e *engine) Logs(f LogFilter) []model.LogEntry {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.logs.query(f, e.simT)
}

func (e *engine) Sensors() model.SensorFrame {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.sensorFrame(&e.odoAPI, &e.bumpAPI)
}

// SLAM returns the newest occupancy map published by the active brain. The
// grid is the BRAIN's belief in its own estimate frame, not ground truth.
func (e *engine) SLAM() (model.RobotMap, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.slam == nil {
		return model.RobotMap{}, false
	}
	return *copyRobotMap(*e.slam), true
}

func (e *engine) Brains() []BrainInfo {
	e.mu.Lock()
	defer e.mu.Unlock()
	names := make([]string, 0, len(sdk.Registry))
	for n := range sdk.Registry {
		names = append(names, n)
	}
	sort.Strings(names)
	out := make([]BrainInfo, 0, len(names))
	for _, n := range names {
		b := sdk.Registry[n]()
		out = append(out, BrainInfo{Name: n, Description: b.Description(), Active: n == e.brainName})
	}
	return out
}

func (e *engine) Zones() []model.ZoneStats {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]model.ZoneStats, 0, len(e.world.Zones))
	for _, z := range e.world.Zones {
		if zs, ok := e.coverage.ByZone[z.Name]; ok {
			out = append(out, zs)
		} else {
			out = append(out, model.ZoneStats{Name: z.Name})
		}
	}
	return out
}

// ------------------------------------------------------------ mission control

func (e *engine) resolveZone(zone string) (string, error) {
	z := strings.TrimSpace(zone)
	if z == "" {
		return "", nil
	}
	for _, zz := range e.world.Zones {
		if strings.EqualFold(zz.Name, z) || strings.EqualFold(zz.ID, z) {
			return zz.Name, nil
		}
	}
	return "", fmt.Errorf("unknown zone %q", zone)
}

func (e *engine) newMissionID(kind string) string {
	e.missionSeq++
	return fmt.Sprintf("%s-%d", kind, e.missionSeq)
}

func (e *engine) StartMowing(zone string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	name, err := e.resolveZone(zone)
	if err != nil {
		return err
	}
	e.mission = &model.Mission{ID: e.newMissionID("mow"), Kind: "mow", Zone: name, StartedAt: e.simT}
	e.pendingMow = nil
	target := name
	if target == "" {
		target = "whole lawn"
	}
	e.logAt("info", "nav", "mission started: mow", map[string]any{"zone": target})
	return nil
}

func (e *engine) StopMowing() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.mission, e.pendingMow = nil, nil
	e.cmdV, e.cmdOmega = 0, 0
	e.bladeOn = false
	e.brainState = model.StateIdle
	e.logAt("info", "nav", "mission stopped, idle in place", nil)
	return nil
}

func (e *engine) Dock() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.mission != nil && e.mission.Kind == "mow" {
		e.pendingMow = e.mission // resumed once the pack is full again
	}
	e.mission = &model.Mission{ID: e.newMissionID("dock"), Kind: "dock", StartedAt: e.simT}
	e.logAt("info", "nav", "mission started: return to charger", nil)
	return nil
}

func (e *engine) SetCutHeight(mm float64) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if mm < 20 || mm > 60 {
		return errors.New("cut height must be 20-60 mm")
	}
	e.cutHeight = mm
	e.logf("info", "blade", "cut height changed", map[string]any{"mm": mm})
	return nil
}

func (e *engine) SetBrain(name string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, ok := sdk.Registry[name]; !ok {
		return fmt.Errorf("unknown brain %q", name)
	}
	e.installBrain(name)
	e.cmdV, e.cmdOmega = 0, 0
	e.logf("info", "system", "algorithm switched", map[string]any{"brain": name})
	return nil
}

// ------------------------------------------------------------- world editing

func (e *engine) AddObstacle(typ string, x, y float64) (model.Obstacle, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	r, ok := obstacleRadius[typ]
	if !ok {
		return model.Obstacle{}, fmt.Errorf("unknown obstacle type %q", typ)
	}
	if x < 0 || y < 0 || x > worldW || y > worldH {
		return model.Obstacle{}, errors.New("obstacle outside the garden")
	}
	o := model.Obstacle{
		ID:      fmt.Sprintf("obs-drop-%d", e.nextObs),
		Type:    typ,
		Pos:     v2(x, y),
		Radius:  r,
		Dropped: true,
	}
	e.nextObs++
	e.world.Obstacles = append(e.world.Obstacles, o)
	e.refreshHogs()
	e.logf("info", "sensor", "obstacle added to the garden", map[string]any{
		"id": o.ID, "type": typ, "x": x, "y": y,
	})
	e.notice("obstacle_added", typ+" placed in the garden")
	e.publishWorld()
	return o, nil
}

func (e *engine) RemoveObstacle(id string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	for i, o := range e.world.Obstacles {
		if o.ID != id {
			continue
		}
		if !o.Dropped {
			return fmt.Errorf("obstacle %q is part of the garden and cannot be removed", id)
		}
		e.world.Obstacles = append(e.world.Obstacles[:i], e.world.Obstacles[i+1:]...)
		e.refreshHogs()
		e.logf("info", "sensor", "obstacle removed", map[string]any{"id": id})
		e.publishWorld()
		return nil
	}
	return fmt.Errorf("no such obstacle %q", id)
}

// ----------------------------------------------------------- manual override

func (e *engine) ManualDrive(v, omega float64, bladeOn bool) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.manual {
		e.logf("warn", "system", "manual override engaged, brain suspended", nil)
	}
	e.manual = true
	e.cmdV = clamp(v, -maxV, maxV)
	e.cmdOmega = clamp(omega, -maxOmega, maxOmega)
	e.bladeOn = bladeOn
	return nil
}

func (e *engine) ManualRelease() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.manual {
		e.logf("info", "system", "manual override released, brain resumed", nil)
	}
	e.manual = false
	e.cmdV, e.cmdOmega = 0, 0
}

// ------------------------------------------------------------- sim control

func (e *engine) SetSpeed(mult float64) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if mult < 0.5 || mult > 200 {
		return errors.New("sim speed must be 0.5-200")
	}
	e.speed = mult
	e.logf("info", "system", "sim speed changed", map[string]any{"mult": mult})
	return nil
}

// SetWeather overrides the generated weather for `hours` sim-hours.
func (e *engine) SetWeather(condition string, hours float64) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	p, ok := overridePeriod(condition)
	if !ok {
		return fmt.Errorf("unknown weather condition %q (want sunny|cloudy|rain|storm)", condition)
	}
	if hours <= 0 {
		hours = 6
	}
	hours = math.Min(hours, 72) // the forecast horizon; longer is meaningless
	e.wxOv = &wxOverride{p: p, until: e.simT + hours*3600}
	e.logf("info", "system", "weather override set", map[string]any{
		"condition": p.cond, "hours": math.Round(hours*10) / 10,
	})
	if p.cond != e.wxCond {
		e.applyWeatherChange(p, "manual override")
	} else {
		e.weather = e.buildWeather()
	}
	// React immediately rather than at the next 1 Hz weather tick, so grass
	// growth and wet-grass effects start with the command.
	e.updateWetness(p)
	return nil
}

// SetBladeSharpness is the demo lever for "the blade is worn" / "I fitted a
// new blade". 1.0 = factory sharp, 0.0 = dead.
func (e *engine) SetBladeSharpness(v float64) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if math.IsNaN(v) {
		return errors.New("blade sharpness must be a number")
	}
	if v < 0 || v > 1 {
		return errors.New("blade sharpness must be 0..1")
	}
	prev := e.sharpness
	e.applySharpness(v)
	msg := "blade sharpness set"
	switch {
	case v > prev:
		msg = "blade serviced"
	case v < prev:
		msg = "blade wear simulated"
	}
	e.logAt("info", "blade", msg, map[string]any{
		"sharpness":     math.Round(e.sharpness*1000) / 1000,
		"was":           math.Round(prev*1000) / 1000,
		"cut_offset_mm": math.Round(e.raggedness()*10) / 10,
	})
	e.bus.publish(Event{Type: "status", Data: e.statusLocked()})
	return nil
}

// GrowGrass is the demo lever: make the lawn shaggy on command.
func (e *engine) GrowGrass(mm float64) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if math.IsNaN(mm) {
		return errors.New("growth must be a number")
	}
	mm = clamp(mm, 5, 40)
	before := e.coverage.AvgHeight
	// growAndStats adds mm to every lawn cell, honours the 90 mm cap and marks
	// every changed cell dirty, so the normal grass-diff path carries it.
	e.coverage = e.grass.growAndStats(mm, e.cutHeight, e.world.Zones)
	e.logf("info", "system", "grass growth boost", map[string]any{
		"mm":         math.Round(mm*10) / 10,
		"avg_before": math.Round(before*10) / 10,
		"avg_after":  math.Round(e.coverage.AvgHeight*10) / 10,
	})
	// Push the whole field now instead of trickling it out at 2 Hz: the UI
	// applies these exactly like any other diff, just several chunks of them.
	e.flushGrassDiffs()
	e.bus.publish(Event{Type: "status", Data: e.statusLocked()})
	return nil
}

// flushGrassDiffs drains the dirty set into as many grass events as it takes.
func (e *engine) flushGrassDiffs() {
	for i := 0; i < 64; i++ {
		d := e.grass.diff()
		if len(d.Cells) == 0 {
			return
		}
		e.bus.publish(Event{Type: "grass", Data: d})
	}
}

func (e *engine) Reset() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.reset(false)
	e.logf("info", "system", "simulation reset: grass regrown, robot on the dock", nil)
	e.publishWorld()
	e.bus.publish(Event{Type: "status", Data: e.statusLocked()})
}

func (e *engine) Subscribe() (<-chan Event, func()) { return e.bus.subscribe() }
