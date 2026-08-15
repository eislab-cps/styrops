// Package server implements the REST + WebSocket API from docs/ROBOT_API.md
// and serves the embedded web UI.
package server

import (
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"github.com/styrops/huskvarna-demo/pkg/sim"
)

// Chat is browser→colonies-server direct (buildingai-style login with the
// user's own colony key) — this server deliberately has NO chat proxy and
// never holds a colony user key.
type Server struct {
	engine sim.Engine
	hub    *hub
	http   *http.Server
}

func New(addr string, engine sim.Engine, webFS fs.FS) *Server {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	s := &Server{engine: engine, hub: newHub()}

	api := r.Group("/api")
	{
		api.GET("/world", func(c *gin.Context) { c.JSON(200, engine.World()) })
		api.GET("/grass", func(c *gin.Context) { c.JSON(200, engine.Grass()) })
		api.GET("/status", func(c *gin.Context) { c.JSON(200, engine.Status()) })
		api.GET("/weather", func(c *gin.Context) { c.JSON(200, engine.Weather()) })
		api.GET("/sensors", func(c *gin.Context) { c.JSON(200, engine.Sensors()) })
		api.GET("/brains", func(c *gin.Context) { c.JSON(200, engine.Brains()) })
		api.GET("/zones", func(c *gin.Context) { c.JSON(200, engine.Zones()) })

		api.GET("/logs", func(c *gin.Context) {
			var q struct {
				Limit   int     `form:"limit"`
				Level   string  `form:"level"`
				Source  string  `form:"source"`
				Minutes float64 `form:"minutes"`
			}
			_ = c.ShouldBindQuery(&q)
			c.JSON(200, engine.Logs(sim.LogFilter{
				Limit: q.Limit, Level: q.Level, Source: q.Source, Minutes: q.Minutes,
			}))
		})

		api.POST("/mission", func(c *gin.Context) {
			var b struct {
				Action string `json:"action"`
				Zone   string `json:"zone"`
			}
			if err := c.ShouldBindJSON(&b); err != nil {
				c.JSON(400, gin.H{"error": err.Error()})
				return
			}
			var err error
			switch b.Action {
			case "mow":
				err = engine.StartMowing(b.Zone)
			case "stop":
				err = engine.StopMowing()
			case "dock":
				err = engine.Dock()
			default:
				c.JSON(400, gin.H{"error": "action must be mow|stop|dock"})
				return
			}
			if err != nil {
				c.JSON(409, gin.H{"error": err.Error()})
				return
			}
			c.JSON(200, engine.Status())
		})

		api.POST("/brain", func(c *gin.Context) {
			var b struct {
				Name string `json:"name"`
			}
			if err := c.ShouldBindJSON(&b); err != nil {
				c.JSON(400, gin.H{"error": err.Error()})
				return
			}
			if err := engine.SetBrain(b.Name); err != nil {
				c.JSON(400, gin.H{"error": err.Error()})
				return
			}
			c.JSON(200, engine.Brains())
		})

		api.POST("/cutheight", func(c *gin.Context) {
			var b struct {
				MM float64 `json:"mm"`
			}
			if err := c.ShouldBindJSON(&b); err != nil {
				c.JSON(400, gin.H{"error": err.Error()})
				return
			}
			if err := engine.SetCutHeight(b.MM); err != nil {
				c.JSON(400, gin.H{"error": err.Error()})
				return
			}
			c.JSON(200, gin.H{"mm": b.MM})
		})

		api.POST("/obstacles", func(c *gin.Context) {
			var b struct {
				Type string  `json:"type"`
				X    float64 `json:"x"`
				Y    float64 `json:"y"`
			}
			if err := c.ShouldBindJSON(&b); err != nil {
				c.JSON(400, gin.H{"error": err.Error()})
				return
			}
			ob, err := engine.AddObstacle(b.Type, b.X, b.Y)
			if err != nil {
				c.JSON(400, gin.H{"error": err.Error()})
				return
			}
			c.JSON(201, ob)
		})

		api.DELETE("/obstacles/:id", func(c *gin.Context) {
			if err := engine.RemoveObstacle(c.Param("id")); err != nil {
				c.JSON(404, gin.H{"error": err.Error()})
				return
			}
			c.Status(204)
		})

		api.POST("/actuators", func(c *gin.Context) {
			var b struct {
				V       float64 `json:"v"`
				Omega   float64 `json:"omega"`
				BladeOn bool    `json:"blade_on"`
			}
			if err := c.ShouldBindJSON(&b); err != nil {
				c.JSON(400, gin.H{"error": err.Error()})
				return
			}
			if err := engine.ManualDrive(b.V, b.Omega, b.BladeOn); err != nil {
				c.JSON(409, gin.H{"error": err.Error()})
				return
			}
			c.Status(204)
		})
		api.POST("/actuators/release", func(c *gin.Context) {
			engine.ManualRelease()
			c.Status(204)
		})

		api.GET("/slam", func(c *gin.Context) {
			m, ok := engine.SLAM()
			if !ok {
				c.JSON(404, gin.H{"error": "no map published yet"})
				return
			}
			c.JSON(200, m)
		})

		api.POST("/weather", func(c *gin.Context) {
			var b struct {
				Condition string  `json:"condition"`
				Hours     float64 `json:"hours"`
			}
			if err := c.ShouldBindJSON(&b); err != nil {
				c.JSON(400, gin.H{"error": err.Error()})
				return
			}
			if err := engine.SetWeather(b.Condition, b.Hours); err != nil {
				c.JSON(400, gin.H{"error": err.Error()})
				return
			}
			c.JSON(200, engine.Weather())
		})

		api.POST("/blade", func(c *gin.Context) {
			var b struct {
				Sharpness float64 `json:"sharpness"`
			}
			if err := c.ShouldBindJSON(&b); err != nil {
				c.JSON(400, gin.H{"error": err.Error()})
				return
			}
			if err := engine.SetBladeSharpness(b.Sharpness); err != nil {
				c.JSON(400, gin.H{"error": err.Error()})
				return
			}
			c.Status(204)
		})

		api.POST("/grass/grow", func(c *gin.Context) {
			var b struct {
				MM float64 `json:"mm"`
			}
			if err := c.ShouldBindJSON(&b); err != nil {
				c.JSON(400, gin.H{"error": err.Error()})
				return
			}
			if err := engine.GrowGrass(b.MM); err != nil {
				c.JSON(400, gin.H{"error": err.Error()})
				return
			}
			c.Status(204)
		})

		api.POST("/sim", func(c *gin.Context) {
			var b struct {
				Speed float64 `json:"speed"`
			}
			if err := c.ShouldBindJSON(&b); err != nil {
				c.JSON(400, gin.H{"error": err.Error()})
				return
			}
			if err := engine.SetSpeed(b.Speed); err != nil {
				c.JSON(400, gin.H{"error": err.Error()})
				return
			}
			c.Status(204)
		})
		api.POST("/reset", func(c *gin.Context) {
			engine.Reset()
			c.Status(204)
		})
	}

	r.GET("/ws", s.handleWS)

	// Embedded web UI at /. index.html is served directly — http.FileServer
	// 301-redirects any path ending in index.html back to "/", which loops.
	r.NoRoute(func(c *gin.Context) {
		p := strings.TrimPrefix(c.Request.URL.Path, "/")
		if p == "" || p == "index.html" {
			data, err := fs.ReadFile(webFS, "index.html")
			if err != nil {
				c.String(500, "index.html missing")
				return
			}
			c.Data(200, "text/html; charset=utf-8", data)
			return
		}
		c.FileFromFS(p, http.FS(webFS))
	})

	s.http = &http.Server{Addr: addr, Handler: r}
	return s
}

// Run starts the engine event pump and the HTTP server (blocking).
func (s *Server) Run() error {
	events, cancel := s.engine.Subscribe()
	defer cancel()
	go func() {
		for ev := range events {
			s.hub.broadcast(ev)
		}
	}()
	slog.Info("http server listening", "addr", s.http.Addr)
	return s.http.ListenAndServe()
}

func (s *Server) Close() { _ = s.http.Close() }

// ---- WebSocket hub ----

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 32 * 1024,
	CheckOrigin:     func(*http.Request) bool { return true }, // demo: same-host or LAN
}

type hub struct {
	mu      sync.Mutex
	clients map[*wsClient]struct{}
}

type wsClient struct {
	conn *websocket.Conn
	send chan sim.Event
}

func newHub() *hub { return &hub{clients: map[*wsClient]struct{}{}} }

func (h *hub) broadcast(ev sim.Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		select {
		case c.send <- ev:
		default: // slow client: drop event, never block the sim
		}
	}
}

func (s *Server) handleWS(c *gin.Context) {
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	cl := &wsClient{conn: conn, send: make(chan sim.Event, 256)}
	s.hub.mu.Lock()
	s.hub.clients[cl] = struct{}{}
	s.hub.mu.Unlock()

	go func() { // writer
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		defer conn.Close()
		for {
			select {
			case ev, ok := <-cl.send:
				if !ok {
					return
				}
				conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if err := conn.WriteJSON(ev); err != nil {
					return
				}
			case <-ticker.C:
				conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
					return
				}
			}
		}
	}()

	// reader: discard input, detect close
	go func() {
		defer func() {
			s.hub.mu.Lock()
			delete(s.hub.clients, cl)
			s.hub.mu.Unlock()
			close(cl.send)
		}()
		conn.SetReadLimit(4096)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
}
