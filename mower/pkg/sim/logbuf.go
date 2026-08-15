package sim

// logbuf.go — the hardware log: a fixed 5000-entry ring buffer. The engine
// writes real events (collisions, blade stall, battery milestones, charge
// start/stop, mission transitions, weather changes, stuck detection); brains
// write through sdk.Robot.Log.

import (
	"strings"

	"github.com/styrops/huskvarna-demo/pkg/model"
)

const (
	logCapacity = 5000

	// Bouncing off an obstacle produces the same warn pair every second or so.
	// Identical (source, msg) warnings inside this window collapse onto the
	// first entry, which grows a "repeats" field instead. Sim seconds.
	logDedupWindow = 30.0

	// Housekeeping bound on the dedup index.
	logDedupMaxKeys = 512
)

var logLevelRank = map[string]int{"debug": 0, "info": 1, "warn": 2, "error": 3}

type logRing struct {
	buf  []model.LogEntry
	head int   // next write slot
	n    int   // entries held (<= len(buf))
	seq  int64 // total entries ever written; buf index = seq % len(buf)

	dedup map[string]*dedupState
}

// dedupState remembers where the first entry of a repeating warning landed.
type dedupState struct {
	seq     int64   // sequence number of the entry that owns the count
	firstT  float64 // sim time of that first entry
	repeats int     // occurrences so far, including the first
}

func newLogRing() *logRing {
	return &logRing{buf: make([]model.LogEntry, logCapacity), dedup: map[string]*dedupState{}}
}

// add stores an entry. It returns false when the entry was folded into an
// existing one, in which case the caller must NOT push it to subscribers.
func (r *logRing) add(e model.LogEntry) bool {
	if e.Level == "warn" {
		if r.fold(e) {
			return false
		}
	}
	r.buf[r.head] = e
	r.head = (r.head + 1) % len(r.buf)
	r.seq++
	if r.n < len(r.buf) {
		r.n++
	}
	return true
}

// fold collapses a repeated warning onto its first entry. It reports true when
// the entry was absorbed.
//
// Folding keys on (source, msg) ONLY. Entries now carry x/y coordinates that
// drift slightly between repeats — a mower grinding against a rock reports a
// centimetre or two of difference every second — and folding on the fields as
// well would defeat the whole point. The surviving entry keeps the FIRST
// sighting's coordinates, which is the useful one: where the trouble started.
func (r *logRing) fold(e model.LogEntry) bool {
	key := e.Source + "\x00" + e.Msg
	d, ok := r.dedup[key]
	// Still in the window, and the owning entry has not been overwritten by
	// the ring wrapping around?
	if ok && e.T-d.firstT < logDedupWindow && e.T >= d.firstT && r.seq-d.seq < int64(len(r.buf)) {
		d.repeats++
		owner := &r.buf[int(d.seq%int64(len(r.buf)))]
		// Copy rather than mutate: the original Fields map may already have
		// been handed to a WebSocket subscriber.
		f := make(map[string]any, len(owner.Fields)+1)
		for k, v := range owner.Fields {
			f[k] = v
		}
		f["repeats"] = d.repeats
		owner.Fields = f
		return true
	}
	if len(r.dedup) >= logDedupMaxKeys {
		r.pruneDedup(e.T)
	}
	// This entry becomes the owner of the next window.
	r.dedup[key] = &dedupState{seq: r.seq, firstT: e.T, repeats: 1}
	return false
}

func (r *logRing) pruneDedup(nowT float64) {
	for k, d := range r.dedup {
		if nowT-d.firstT >= logDedupWindow || r.seq-d.seq >= int64(len(r.buf)) {
			delete(r.dedup, k)
		}
	}
	if len(r.dedup) >= logDedupMaxKeys {
		clear(r.dedup) // pathological: start over rather than grow without bound
	}
}

// query returns matching entries oldest-first, newest kept when limited.
func (r *logRing) query(f LogFilter, nowT float64) []model.LogEntry {
	limit := f.Limit
	if limit <= 0 {
		limit = 100
	}
	minRank := 0
	if f.Level != "" {
		if v, ok := logLevelRank[strings.ToLower(f.Level)]; ok {
			minRank = v
		}
	}
	sinceT := f.SinceT
	if f.Minutes > 0 {
		if t := nowT - f.Minutes*60; t > sinceT {
			sinceT = t
		}
	}
	// Walk newest -> oldest, collect up to limit, then reverse.
	out := make([]model.LogEntry, 0, limit)
	for k := 0; k < r.n; k++ {
		i := (r.head - 1 - k + len(r.buf)*2) % len(r.buf)
		e := r.buf[i]
		if logLevelRank[e.Level] < minRank {
			continue
		}
		if f.Source != "" && e.Source != f.Source {
			continue
		}
		if e.T < sinceT {
			continue
		}
		out = append(out, e)
		if len(out) >= limit {
			break
		}
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}
