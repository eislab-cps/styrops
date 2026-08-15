package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/styrops/buildingai/pkg/model"
	"github.com/styrops/buildingai/pkg/store"
)

type NoteHandlers struct {
	Store *store.MemoryStore
}

func (h *NoteHandlers) AddNote(c *gin.Context) {
	equipmentID := c.Param("id")
	var n model.Note
	if err := c.ShouldBindJSON(&n); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if n.ID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}
	if n.Text == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "text is required"})
		return
	}
	ok, errMsg := h.Store.AddNote(equipmentID, &n)
	if !ok {
		if errMsg == "note already exists" {
			c.JSON(http.StatusConflict, gin.H{"error": errMsg})
		} else {
			c.JSON(http.StatusNotFound, gin.H{"error": errMsg})
		}
		return
	}
	c.JSON(http.StatusCreated, n)
}

func (h *NoteHandlers) ListNotes(c *gin.Context) {
	equipmentID := c.Param("id")
	notes, ok := h.Store.GetNotesForEquipment(equipmentID)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "equipment not found"})
		return
	}
	c.JSON(http.StatusOK, notes)
}

func (h *NoteHandlers) DeleteNote(c *gin.Context) {
	noteID := c.Param("id")
	if !h.Store.DeleteNote(noteID) {
		c.JSON(http.StatusNotFound, gin.H{"error": "note not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}
