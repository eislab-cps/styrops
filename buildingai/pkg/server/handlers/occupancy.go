package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/styrops/buildingai/pkg/model"
	"github.com/styrops/buildingai/pkg/server/websocket"
	"github.com/styrops/buildingai/pkg/store"
)

type OccupancyHandlers struct {
	Store *store.MemoryStore
	Hub   *websocket.Hub
}

func (h *OccupancyHandlers) Get(c *gin.Context) {
	c.JSON(http.StatusOK, h.Store.GetOccupancy())
}

func (h *OccupancyHandlers) Set(c *gin.Context) {
	var occ map[string]model.RoomOccupancy
	if err := c.ShouldBindJSON(&occ); err != nil {
		// Empty body or {} is valid — treat as clear
		occ = make(map[string]model.RoomOccupancy)
	}
	if occ == nil {
		occ = make(map[string]model.RoomOccupancy)
	}
	version := h.Store.SetOccupancy(occ)
	h.Hub.BroadcastToAll(websocket.Message{Type: "occupancy", Version: version})
	c.JSON(http.StatusOK, gin.H{"status": "updated", "version": version})
}
