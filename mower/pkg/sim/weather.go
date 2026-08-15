package sim

// weather.go — a fake local weather service. Conditions are generated per 3 h
// period by a seeded Markov chain, so the 72 h forecast is STABLE: a period is
// generated exactly once and never re-rolled. As sim time advances past a
// period boundary the window simply slides and one new period is appended.

import (
	"math"
	"math/rand"

	"github.com/styrops/huskvarna-demo/pkg/model"
)

const (
	weatherPeriodSec = 3 * 3600.0 // 3 h periods
	forecastPeriods  = 24         // 72 h ahead
	wetAfterRainSec  = 2 * 3600.0 // grass stays wet 2 h after rain stops
)

type wxPeriod struct {
	cond    string
	tempC   float64
	rainMmH float64
	windMps float64
	rainPrb float64
}

type weatherGen struct {
	rnd  *rand.Rand
	gen  []wxPeriod // absolute period index 0..len-1, generated once
	seed int64
}

func newWeatherGen(seed int64) *weatherGen {
	w := &weatherGen{rnd: rand.New(rand.NewSource(seed ^ 0x5EED_C10D)), seed: seed}
	w.ensure(forecastPeriods + 2)
	return w
}

// transition is the condition Markov chain; keys are cumulative thresholds.
func nextCondition(prev string, u float64) string {
	type row struct {
		p float64
		c string
	}
	var rows []row
	switch prev {
	case "sunny":
		rows = []row{{0.60, "sunny"}, {0.95, "cloudy"}, {1.00, "rain"}}
	case "rain":
		rows = []row{{0.45, "rain"}, {0.90, "cloudy"}, {1.00, "storm"}}
	case "storm":
		rows = []row{{0.50, "rain"}, {1.00, "cloudy"}}
	default: // cloudy
		rows = []row{{0.30, "sunny"}, {0.75, "cloudy"}, {0.97, "rain"}, {1.00, "storm"}}
	}
	for _, r := range rows {
		if u <= r.p {
			return r.c
		}
	}
	return "cloudy"
}

func (w *weatherGen) ensure(n int) {
	for len(w.gen) < n {
		i := len(w.gen)
		prev := "cloudy"
		if i > 0 {
			prev = w.gen[i-1].cond
		}
		c := nextCondition(prev, w.rnd.Float64())
		// Diurnal swing: period i covers sim-hours [3i, 3i+3).
		hour := math.Mod(float64(3*i), 24)
		diurnal := 4.0 * math.Sin(2*math.Pi*(hour-9)/24)
		base := map[string]float64{"sunny": 20, "cloudy": 17.5, "rain": 15.5, "storm": 14.5}[c]
		p := wxPeriod{
			cond:  c,
			tempC: clamp(base+diurnal+w.rnd.NormFloat64()*0.8, 12, 24),
		}
		switch c {
		case "rain":
			p.rainMmH = 1.5 + w.rnd.Float64()*2.5
			p.windMps = 4 + w.rnd.Float64()*4
			p.rainPrb = 0.85
		case "storm":
			p.rainMmH = 6 + w.rnd.Float64()*6
			p.windMps = 10 + w.rnd.Float64()*6
			p.rainPrb = 0.95
		case "sunny":
			p.windMps = 1 + w.rnd.Float64()*3
			p.rainPrb = 0.05
		default:
			p.windMps = 2 + w.rnd.Float64()*3
			p.rainPrb = 0.25
		}
		w.gen = append(w.gen, p)
	}
}

func (w *weatherGen) periodIndex(simT float64) int { return int(simT / weatherPeriodSec) }

// at returns the weather for the period containing simT.
func (w *weatherGen) at(simT float64) wxPeriod {
	i := w.periodIndex(simT)
	w.ensure(i + forecastPeriods + 2)
	return w.gen[i]
}

// weather builds the API view: now + the next 72 h in 3 h periods.
func (w *weatherGen) weather(simT float64) model.Weather {
	i := w.periodIndex(simT)
	w.ensure(i + forecastPeriods + 2)
	cur := w.gen[i]
	out := model.Weather{
		Now: model.WeatherNow{
			Condition: cur.cond,
			TempC:     math.Round(cur.tempC*10) / 10,
			WindMps:   math.Round(cur.windMps*10) / 10,
			RainMmH:   math.Round(cur.rainMmH*10) / 10,
		},
		Forecast: make([]model.WeatherPeriod, 0, forecastPeriods),
	}
	for k := 1; k <= forecastPeriods; k++ {
		p := w.gen[i+k]
		out.Forecast = append(out.Forecast, model.WeatherPeriod{
			HoursAhead: 3 * k,
			Condition:  p.cond,
			TempC:      math.Round(p.tempC*10) / 10,
			RainProb:   p.rainPrb,
		})
	}
	return out
}

func isRaining(cond string) bool { return cond == "rain" || cond == "storm" }

// ---- manual override ----

// wxOverride pins the weather to a chosen condition until a sim time. The
// generator keeps running underneath, so once the override lapses the forecast
// picks up exactly where it would have been.
type wxOverride struct {
	p     wxPeriod
	until float64 // sim seconds
}

// overridePeriod builds the fixed weather used while an override is in force.
// Values are mid-range for the condition (no RNG) so a forced "rain" is
// reproducible for tests and demos.
func overridePeriod(condition string) (wxPeriod, bool) {
	switch condition {
	case "sunny":
		return wxPeriod{cond: "sunny", tempC: 21, windMps: 2.5, rainPrb: 0.05}, true
	case "cloudy":
		return wxPeriod{cond: "cloudy", tempC: 17.5, windMps: 3.5, rainPrb: 0.25}, true
	case "rain":
		return wxPeriod{cond: "rain", tempC: 15, windMps: 6, rainMmH: 2.8, rainPrb: 0.90}, true
	case "storm":
		return wxPeriod{cond: "storm", tempC: 14, windMps: 13, rainMmH: 9, rainPrb: 0.97}, true
	}
	return wxPeriod{}, false
}
