package sim

// grass.go — the grass height field and coverage bookkeeping.
//
// Heights are millimetres. -1 marks "not lawn" (house, gravel path, gravel
// border, static obstacle footprint). Cells are grassCellSize (0.25 m) square,
// row-major, index = iy*cols + ix, cell centre = ((ix+0.5)*cell,(iy+0.5)*cell).

import (
	"math"
	"math/rand"

	"github.com/styrops/huskvarna-demo/pkg/model"
)

const (
	grassMinInit = 35.0 // mm
	grassMaxInit = 55.0 // mm
	grassMax     = 90.0 // mm, cap
	growMMPerH   = 2.0  // mm per sim-hour, dry
	growWetMult  = 3.0  // multiplier while the grass is wet
	cutTolerance = 5.0  // mm; "cut" == height <= cutHeight + this

	// A cell counts as cut when its centre falls within cutMarkRadius of the
	// disc centre: the 0.11 m disc plus the lay-over of the surrounding blades.
	cutDiscRadius = 0.11
	cutMarkRadius = 0.14

	// A grass event never carries more than this many cells; the rest are
	// carried over to the next emit so a slow UI cannot stall the engine.
	maxDiffCells = 4000
)

type grassGrid struct {
	cols, rows int
	cell       float64
	h          []float64 // mm, -1 = not lawn
	zone       []int16   // index into world.Zones, -1 = none
	lastEmit   []float64 // last height pushed to subscribers
	dirty      map[int]bool
	lawnCells  int
	zoneCells  []int
}

func newGrassGrid(w model.World, rnd *rand.Rand) *grassGrid {
	g := &grassGrid{
		cols:      int(math.Round(w.Width / w.GrassCell)),
		rows:      int(math.Round(w.Height / w.GrassCell)),
		cell:      w.GrassCell,
		dirty:     map[int]bool{},
		zoneCells: make([]int, len(w.Zones)),
	}
	n := g.cols * g.rows
	g.h = make([]float64, n)
	g.zone = make([]int16, n)
	g.lastEmit = make([]float64, n)
	for i := range g.zone {
		g.zone[i] = -1
	}
	for iy := 0; iy < g.rows; iy++ {
		for ix := 0; ix < g.cols; ix++ {
			i := iy*g.cols + ix
			c := v2((float64(ix)+0.5)*g.cell, (float64(iy)+0.5)*g.cell)
			g.h[i] = -1
			if !cellIsLawn(w, c) {
				g.lastEmit[i] = -1
				continue
			}
			g.h[i] = grassMinInit + rnd.Float64()*(grassMaxInit-grassMinInit)
			g.lastEmit[i] = g.h[i]
			g.lawnCells++
			for zi := range w.Zones {
				if pointInPolygon(c, w.Zones[zi].Area) {
					g.zone[i] = int16(zi)
					g.zoneCells[zi]++
					break
				}
			}
		}
	}
	return g
}

// cellIsLawn decides, once at build time, whether a cell grows grass.
func cellIsLawn(w model.World, c model.Vec2) bool {
	if pointInPolygon(c, w.House) {
		return false
	}
	for _, p := range w.Paths {
		if pointInPolygon(c, p) {
			return false
		}
	}
	// Grass grows under scenery too — a real lawn keeps its turf beneath a
	// tree, the mower just steers around it. Masking obstacle footprints out
	// of the field punched visible holes in the rendered turf (they read as
	// white "snow" patches through the diorama), so obstacles no longer
	// affect the grass field at all: they only block the mower.
	for _, lp := range w.Lawn {
		if pointInPolygon(c, lp) {
			return true
		}
	}
	return false
}

func (g *grassGrid) index(p model.Vec2) int {
	ix := int(p.X / g.cell)
	iy := int(p.Y / g.cell)
	if ix < 0 || iy < 0 || ix >= g.cols || iy >= g.rows {
		return -1
	}
	return iy*g.cols + ix
}

// heightAt returns the grass height under p, or -1 off the lawn.
func (g *grassGrid) heightAt(p model.Vec2) float64 {
	i := g.index(p)
	if i < 0 {
		return -1
	}
	return g.h[i]
}

// cut lowers every lawn cell under the cutting disc to target mm.
func (g *grassGrid) cut(p model.Vec2, target float64) {
	ix0 := int((p.X - cutMarkRadius) / g.cell)
	ix1 := int((p.X + cutMarkRadius) / g.cell)
	iy0 := int((p.Y - cutMarkRadius) / g.cell)
	iy1 := int((p.Y + cutMarkRadius) / g.cell)
	for iy := iy0; iy <= iy1; iy++ {
		if iy < 0 || iy >= g.rows {
			continue
		}
		for ix := ix0; ix <= ix1; ix++ {
			if ix < 0 || ix >= g.cols {
				continue
			}
			i := iy*g.cols + ix
			if g.h[i] < 0 || g.h[i] <= target {
				continue
			}
			c := v2((float64(ix)+0.5)*g.cell, (float64(iy)+0.5)*g.cell)
			if dist(c, p) <= cutMarkRadius {
				g.h[i] = target
				g.dirty[i] = true
			}
		}
	}
}

// grow adds mm to every lawn cell (capped) and computes coverage in the same
// sweep — this is the only full-grid pass and runs a few times per sim-minute.
func (g *grassGrid) growAndStats(mm float64, cutHeight float64, zones []model.Zone) model.CoverageStats {
	thr := cutHeight + cutTolerance
	var sum, max float64
	cutN := 0
	zsum := make([]float64, len(zones))
	zcut := make([]int, len(zones))
	for i, h := range g.h {
		if h < 0 {
			continue
		}
		if mm > 0 && h < grassMax {
			h = math.Min(grassMax, h+mm)
			g.h[i] = h
			if math.Abs(h-g.lastEmit[i]) >= 0.5 {
				g.dirty[i] = true
			}
		}
		sum += h
		if h > max {
			max = h
		}
		z := g.zone[i]
		if z >= 0 {
			zsum[z] += h
		}
		if h <= thr {
			cutN++
			if z >= 0 {
				zcut[z]++
			}
		}
	}
	st := model.CoverageStats{ByZone: map[string]model.ZoneStats{}}
	if g.lawnCells > 0 {
		st.CutPercent = 100 * float64(cutN) / float64(g.lawnCells)
		st.AvgHeight = sum / float64(g.lawnCells)
		st.MaxHeight = max
	}
	for zi := range zones {
		n := g.zoneCells[zi]
		zs := model.ZoneStats{Name: zones[zi].Name}
		if n > 0 {
			zs.CutPercent = 100 * float64(zcut[zi]) / float64(n)
			zs.AvgHeight = zsum[zi] / float64(n)
		}
		st.ByZone[zones[zi].Name] = zs
	}
	return st
}

// diff drains up to maxDiffCells changed cells for a "grass" event.
func (g *grassGrid) diff() GrassDiff {
	if len(g.dirty) == 0 {
		return GrassDiff{}
	}
	n := len(g.dirty)
	if n > maxDiffCells {
		n = maxDiffCells
	}
	out := make([][2]float64, 0, n)
	for i := range g.dirty {
		out = append(out, [2]float64{float64(i), g.h[i]})
		g.lastEmit[i] = g.h[i]
		delete(g.dirty, i)
		if len(out) >= maxDiffCells {
			break
		}
	}
	return GrassDiff{Cells: out}
}

// snapshot copies the grid for GET /api/grass.
func (g *grassGrid) snapshot() model.GrassGrid {
	h := make([]float64, len(g.h))
	copy(h, g.h)
	return model.GrassGrid{Cols: g.cols, Rows: g.rows, Cell: g.cell, Heights: h}
}
