package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/styrops/buildingai/pkg/livesim"
)

// LiveHandlers serve the living-building simulation. Sim may be nil, which
// means the simulation was disabled with --livesim=false; the endpoints then
// answer with an empty population and enabled:false rather than an error, so
// clients can poll unconditionally.
type LiveHandlers struct {
	Sim *livesim.Sim
}

// GetPeople returns everyone currently inside the building.
//
//	GET /api/live/people[?level=level1]
//	[{"id":"sim-p001","name":"Anna Ek","role":"staff","state":"walking",
//	  "room":"","level":"level0","x":123.45,"y":210.11,"heading":274.5,
//	  "icon":"woman"}]
//
// COORDINATE SPACE: x and y are floor-plan ("PDF") coordinates -- the same
// space as room.center, walkable-graph node x/y, and coverage-zone centres,
// bounded by the level's page.width / page.height from
// GET /api/building/floors/{level}. The viewer converts them itself with
// pdfToWorld(x, y, pw, ph) = [x - pw/2, -(y - ph/2)]; the server never emits
// viewer world coordinates.
//
// heading is already in the viewer's world space: degrees counter-clockwise
// from +X (0 = east, 90 = "up" on screen), so it can be applied to a sprite
// without flipping the sign of the Y axis first.
//
// People who have gone home are simply absent from the list.
func (h *LiveHandlers) GetPeople(c *gin.Context) {
	c.JSON(http.StatusOK, h.Sim.People(c.Query("level")))
}

// GetState returns the simulation clock and aggregate figures.
//
//	GET /api/live/state
func (h *LiveHandlers) GetState(c *gin.Context) {
	c.JSON(http.StatusOK, h.Sim.State())
}

// GetSchedule returns the synthesized weekly lecture timetable.
//
//	GET /api/live/schedule
func (h *LiveHandlers) GetSchedule(c *gin.Context) {
	c.JSON(http.StatusOK, h.Sim.Schedule())
}

// Reset re-seeds the simulation and rewinds it to a start instant.
//
//	POST /api/live/reset
//	{"seed": 7, "people": 80, "speed": 120, "start": "2026-08-10T08:00:00+02:00"}
//
// All fields are optional; omitted fields keep their current value.
func (h *LiveHandlers) Reset(c *gin.Context) {
	if h.Sim == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "live simulation is disabled"})
		return
	}
	var opts livesim.ResetOptions
	if c.Request.Body != nil {
		// An empty or absent body is a plain reset.
		_ = c.ShouldBindJSON(&opts)
	}
	c.JSON(http.StatusOK, h.Sim.Reset(opts))
}
