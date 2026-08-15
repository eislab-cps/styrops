package handlers

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/styrops/buildingai/pkg/model"
	"github.com/styrops/buildingai/pkg/server/websocket"
	"github.com/styrops/buildingai/pkg/store"
)

type SessionHandlers struct {
	Store *store.MemoryStore
	Hub   *websocket.Hub
}

func (h *SessionHandlers) List(c *gin.Context) {
	sessions := h.Store.ListSessions()
	if sessions == nil {
		sessions = []*model.Session{}
	}
	c.JSON(http.StatusOK, sessions)
}

func (h *SessionHandlers) Create(c *gin.Context) {
	id := uuid.New().String()
	sess := h.Store.CreateSession(id)
	c.JSON(http.StatusCreated, sess)
}

func (h *SessionHandlers) Get(c *gin.Context) {
	id := c.Param("id")
	sess, ok := h.Store.GetSession(id)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	c.JSON(http.StatusOK, sess)
}

func (h *SessionHandlers) Delete(c *gin.Context) {
	id := c.Param("id")
	if !h.Store.DeleteSession(id) {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}

func (h *SessionHandlers) SetViewport(c *gin.Context) {
	id := c.Param("id")
	var vp model.Viewport
	if err := c.ShouldBindJSON(&vp); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if _, ok := h.Store.UpdateSessionViewport(id, vp); !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	h.Hub.SendToSession(id, websocket.Message{Type: "viewport", Data: vp})
	c.JSON(http.StatusOK, gin.H{"status": "updated"})
}

func (h *SessionHandlers) SetHighlights(c *gin.Context) {
	id := c.Param("id")
	var highlights []model.RoomHighlight
	if err := c.ShouldBindJSON(&highlights); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Validate room names against the building model. Unknown names
	// (typos, prefix/suffix mismatches like "A1540" vs "1540A") are
	// silently dropped by the renderer, which used to produce
	// success-with-fewer-rooms-than-expected — the caller saw status:ok
	// and assumed every requested room got highlighted. We now partition
	// the request into accepted + skipped and report both, so an LLM
	// caller can see partial failures and self-correct. Empty highlights
	// (a clear) are passed through unchanged. Lookups by RoomID are
	// considered always-valid since they're not name-based.
	// canonical map: uppercase-name → original room name (preserves
	// the data file's exact casing). Matching is case-insensitive but the
	// stored highlight is rewritten to the canonical form so viewers
	// always render the same label.
	canonical := map[string]string{}
	for _, fd := range h.Store.GetFloors() {
		if fd == nil {
			continue
		}
		for _, r := range fd.Rooms {
			if r.Name != "" {
				canonical[strings.ToUpper(r.Name)] = r.Name
			}
		}
	}
	var accepted []model.RoomHighlight
	var skipped []string
	for _, hl := range highlights {
		if hl.Name == "" || hl.RoomID != 0 || len(canonical) == 0 {
			accepted = append(accepted, hl)
			continue
		}
		if name, ok := canonical[strings.ToUpper(hl.Name)]; ok {
			hl.Name = name
			accepted = append(accepted, hl)
			continue
		}
		skipped = append(skipped, hl.Name)
	}

	if _, ok := h.Store.UpdateSessionHighlights(id, accepted); !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	h.Hub.SendToSession(id, websocket.Message{Type: "highlights", Data: accepted})

	resp := gin.H{
		"status":      "updated",
		"highlighted": acceptedNames(accepted),
	}
	if len(skipped) > 0 {
		resp["status"] = "partial"
		resp["skipped_unknown"] = skipped
		resp["hint"] = "Some rooms were not found in the building model and were skipped. Common mismatch: 'A1540' vs '1540A' (suffix vs prefix). Use GET /api/building/floors/{level} or the search endpoint to find canonical names."
	}
	c.JSON(http.StatusOK, resp)
}

func acceptedNames(hs []model.RoomHighlight) []string {
	out := make([]string, 0, len(hs))
	for _, h := range hs {
		if h.Name != "" {
			out = append(out, h.Name)
		}
	}
	return out
}

func (h *SessionHandlers) SetOccupancy(c *gin.Context) {
	id := c.Param("id")
	var occupancy map[string]model.RoomOccupancy
	if err := c.ShouldBindJSON(&occupancy); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	version, ok := h.Store.UpdateSessionOccupancy(id, occupancy)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	h.Hub.SendToSession(id, websocket.Message{Type: "occupancy", Version: version})
	c.JSON(http.StatusOK, gin.H{"status": "updated"})
}

func (h *SessionHandlers) SetRoute(c *gin.Context) {
	id := c.Param("id")
	var route model.RouteResult
	if err := c.ShouldBindJSON(&route); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if !h.Store.UpdateSessionRoute(id, &route) {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	h.Hub.SendToSession(id, websocket.Message{Type: "route", Data: route})
	c.JSON(http.StatusOK, gin.H{"status": "updated"})
}

func (h *SessionHandlers) SetCoverage(c *gin.Context) {
	id := c.Param("id")
	var coverage []model.CoverageZone
	if err := c.ShouldBindJSON(&coverage); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if _, ok := h.Store.UpdateSessionCoverage(id, coverage); !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	h.Hub.SendToSession(id, websocket.Message{Type: "coverage", Data: coverage})
	c.JSON(http.StatusOK, gin.H{"status": "updated"})
}

func (h *SessionHandlers) HandleWebSocket(c *gin.Context) {
	id := c.Param("id")
	if _, ok := h.Store.GetSession(id); !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}

	upgrader := websocket.Upgrader()
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}

	h.Hub.HandleConnection(conn, id)
}
