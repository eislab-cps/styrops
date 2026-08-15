// Package model holds all shared data types for the automower simulator.
// Everything is JSON-serializable; these types ARE the wire format for the
// REST/WS API (docs/ROBOT_API.md) — change them and you change the contract.
package model

import "time"

type Vec2 struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type Polygon []Vec2

type Pose struct {
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	Theta float64 `json:"theta"` // radians, 0 = +X, counter-clockwise
}

// World is the static scene. Coordinates in meters, origin bottom-left.
type World struct {
	Name      string     `json:"name"`
	Width     float64    `json:"width"`
	Height    float64    `json:"height"`
	Lawn      []Polygon  `json:"lawn"`      // mowable areas
	House     Polygon    `json:"house"`     // no-go footprint
	Paths     []Polygon  `json:"paths"`     // stone/gravel, no grass, drivable
	Dock      Dock       `json:"dock"`
	GuideWire []Vec2     `json:"guide_wire"` // closed loop around lawn, spur to dock
	Obstacles []Obstacle `json:"obstacles"`
	Zones     []Zone     `json:"zones"`
	GrassCell float64    `json:"grass_cell"` // grid cell size in meters
}

type Dock struct {
	Pos     Vec2    `json:"pos"`
	Heading float64 `json:"heading"` // approach direction
}

type Obstacle struct {
	ID      string  `json:"id"`
	Type    string  `json:"type"` // rock | tree | trampoline | toy | flowerbed | hedgehog
	Pos     Vec2    `json:"pos"`
	Radius  float64 `json:"radius"`
	Dropped bool    `json:"dropped"` // true if user-dropped at runtime
}

type Zone struct {
	ID   string  `json:"id"`
	Name string  `json:"name"` // "front lawn", "back lawn", ...
	Area Polygon `json:"area"`
}

// ---- Sensors (what the Brain/SLAM sees — noisy, never ground truth) ----

type SensorFrame struct {
	T            float64    `json:"t"` // sim time, seconds
	Odometry     Odometry   `json:"odometry"`
	IMU          IMU        `json:"imu"`
	GPS          GPS        `json:"gps"`
	Range        []RangeBeam `json:"range"`
	Bump         Bump       `json:"bump"`
	Wire         Wire       `json:"wire"`
	BladeCurrent float64    `json:"blade_current"` // amps; rises in tall/wet grass
	Battery      Battery    `json:"battery"`
	Camera       CameraHint `json:"camera"`
}

// Odometry is incremental wheel travel since the previous Sensors() call,
// with slip/drift noise applied. Integrate it yourself — that's the SLAM game.
type Odometry struct {
	DLeft  float64 `json:"d_left"`  // meters
	DRight float64 `json:"d_right"` // meters
}

type IMU struct {
	YawRate float64 `json:"yaw_rate"` // rad/s, noisy
	Heading float64 `json:"heading"`  // compass heading, noisy, slow drift
}

type GPS struct {
	Pos      Vec2    `json:"pos"`      // noisy position
	Accuracy float64 `json:"accuracy"` // 1-sigma meters (garden GPS: 1-3 m)
	Fix      bool    `json:"fix"`
}

type RangeBeam struct {
	Angle float64 `json:"angle"` // relative to robot heading
	Dist  float64 `json:"dist"`  // meters; = MaxRange if no hit
	Hit   bool    `json:"hit"`
}

type Bump struct {
	Front bool `json:"front"`
	Left  bool `json:"left"`
	Right bool `json:"right"`
}

// Wire models the boundary/guide wire sensor of a real automower.
type Wire struct {
	Inside    bool    `json:"inside"`    // inside the boundary loop
	Strength  float64 `json:"strength"`  // signal strength, ~1/dist to wire
	Direction float64 `json:"direction"` // bearing to nearest wire point, robot-relative
}

type Battery struct {
	Percent  float64 `json:"percent"`
	Voltage  float64 `json:"voltage"`
	Charging bool    `json:"charging"`
}

// CameraHint is the "fake computer vision": the sim tells the robot what a
// camera+detector would have seen, no pixels involved.
type CameraHint struct {
	Objects []DetectedObject `json:"objects"`
}

type DetectedObject struct {
	Label      string  `json:"label"`   // matches Obstacle.Type, or "wall", "dock"
	Bearing    float64 `json:"bearing"` // robot-relative radians
	Dist       float64 `json:"dist"`
	Confidence float64 `json:"confidence"`
}

// ---- Robot status (ground truth + mission state, for UI and agent) ----

type RobotState string

const (
	StateIdle     RobotState = "idle"
	StateMowing   RobotState = "mowing"
	StateDocking  RobotState = "docking"
	StateCharging RobotState = "charging"
	StateStuck    RobotState = "stuck"
	StateManual   RobotState = "manual"
	StateError    RobotState = "error"
)

type RobotStatus struct {
	State      RobotState    `json:"state"`
	Pose       Pose          `json:"pose"`               // ground truth (UI only)
	EstPose    *Pose         `json:"est_pose,omitempty"` // brain's own estimate, if published
	Battery    Battery       `json:"battery"`
	BladeOn    bool          `json:"blade_on"`
	CutHeight  float64       `json:"cut_height"` // mm
	// BladeSharpness 1.0 = factory sharp, 0.0 = dead. Wears with cutting
	// hours (faster wet / in tall grass) and obstacle contact. A dull blade
	// cuts ragged (effective cut height rises) and draws more current.
	BladeSharpness float64 `json:"blade_sharpness"`
	Brain      string        `json:"brain"`      // active algorithm name
	Mission    *Mission      `json:"mission,omitempty"`
	Coverage   CoverageStats `json:"coverage"`
	Weather    WeatherNow    `json:"weather"`
	StuckSince *float64      `json:"stuck_since,omitempty"` // sim time when stuck began
	SimTime    float64       `json:"sim_time"`
	SimSpeed   float64       `json:"sim_speed"`
}

type Mission struct {
	ID        string  `json:"id"`
	Kind      string  `json:"kind"` // mow | dock
	Zone      string  `json:"zone,omitempty"`
	StartedAt float64 `json:"started_at"`
	Progress  float64 `json:"progress"` // 0..1, cut fraction of target area
}

type CoverageStats struct {
	CutPercent float64              `json:"cut_percent"` // cells at/below cut height
	AvgHeight  float64              `json:"avg_height"`  // mm
	MaxHeight  float64              `json:"max_height"`  // mm
	ByZone     map[string]ZoneStats `json:"by_zone"`
}

type ZoneStats struct {
	Name       string  `json:"name"`
	CutPercent float64 `json:"cut_percent"`
	AvgHeight  float64 `json:"avg_height"`
}

// ---- Hardware log ----

type LogEntry struct {
	T      float64        `json:"t"` // sim time
	Wall   time.Time      `json:"wall"`
	Level  string         `json:"level"`  // debug | info | warn | error
	Source string         `json:"source"` // motor | blade | battery | nav | sensor | system
	Msg    string         `json:"msg"`
	Fields map[string]any `json:"fields,omitempty"`
}

// ---- Weather (fake local weather service) ----

type Weather struct {
	Now      WeatherNow      `json:"now"`
	Forecast []WeatherPeriod `json:"forecast"` // next 72h, 3h periods
}

type WeatherNow struct {
	Condition string  `json:"condition"` // sunny | cloudy | rain | storm
	TempC     float64 `json:"temp_c"`
	WindMps   float64 `json:"wind_mps"`
	RainMmH   float64 `json:"rain_mm_h"`
}

type WeatherPeriod struct {
	HoursAhead int     `json:"hours_ahead"`
	Condition  string  `json:"condition"`
	TempC      float64 `json:"temp_c"`
	RainProb   float64 `json:"rain_prob"` // 0..1
}

// ---- Robot-built SLAM map ----

// RobotMap is the occupancy map the ACTIVE BRAIN has built from its own noisy
// sensors — never ground truth. Row-major, index = iy*Cols + ix; cell (0,0)
// covers world origin. Values: -1 unknown, 0 observed free/swept, 1 obstacle.
type RobotMap struct {
	Cols       int    `json:"cols"`
	Rows       int    `json:"rows"`
	Cell       float64 `json:"cell"` // meters
	Cells      []int8 `json:"cells"`
	EstPose    Pose   `json:"est_pose"`
	Trajectory []Pose `json:"trajectory"` // decimated recent estimate track
	T          float64 `json:"t"`         // sim time of the snapshot
}

// ---- Grass grid ----

// GrassGrid is row-major, index = iy*Cols + ix. Heights in mm.
type GrassGrid struct {
	Cols    int       `json:"cols"`
	Rows    int       `json:"rows"`
	Cell    float64   `json:"cell"`    // meters
	Heights []float64 `json:"heights"` // -1 = not lawn (house/path/outside)
}
