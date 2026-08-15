package sim

import (
	"testing"

	"github.com/styrops/huskvarna-demo/pkg/model"
)

func warnAt(t float64, src, msg string, f map[string]any) model.LogEntry {
	return model.LogEntry{T: t, Level: "warn", Source: src, Msg: msg, Fields: f}
}

func TestLogRingFoldsRepeatedWarnings(t *testing.T) {
	r := newLogRing()

	// A mower bouncing off the same rock once a second for 60 sim-seconds.
	emitted := 0
	for i := 0; i < 60; i++ {
		ts := float64(i)
		if r.add(warnAt(ts, "motor", "collision, drive stopped", map[string]any{"bearing_deg": 0.0})) {
			emitted++
		}
		if r.add(warnAt(ts, "blade", "cutting disc load spike (obstacle contact)", nil)) {
			emitted++
		}
	}
	// Two 30 s windows x two distinct messages.
	if emitted != 4 {
		t.Errorf("emitted %d entries, want 4 (one per message per 30 s window)", emitted)
	}

	all := r.query(LogFilter{Limit: 100}, 60)
	if len(all) != 4 {
		t.Fatalf("ring holds %d entries, want 4: %+v", len(all), all)
	}
	for _, e := range all {
		if e.Fields["repeats"] != 30 {
			t.Errorf("entry %q at t=%.0f has repeats=%v, want 30", e.Msg, e.T, e.Fields["repeats"])
		}
	}
	// The original field must survive alongside the count.
	if all[0].Fields["bearing_deg"] != 0.0 {
		t.Errorf("folding dropped the original fields: %v", all[0].Fields)
	}
	// Ordering is still oldest-first and window boundaries are where expected.
	if all[0].T != 0 || all[2].T != 30 {
		t.Errorf("window starts at t=%.0f and t=%.0f, want 0 and 30", all[0].T, all[2].T)
	}
}

func TestLogRingDoesNotFoldOtherLevelsOrDistinctMessages(t *testing.T) {
	r := newLogRing()
	for i := 0; i < 5; i++ {
		if !r.add(model.LogEntry{T: float64(i), Level: "info", Source: "nav", Msg: "same"}) {
			t.Errorf("info entry %d was folded", i)
		}
		if !r.add(model.LogEntry{T: float64(i), Level: "error", Source: "system", Msg: "same"}) {
			t.Errorf("error entry %d was folded", i)
		}
	}
	if got := len(r.query(LogFilter{Limit: 100}, 5)); got != 10 {
		t.Errorf("kept %d entries, want 10", got)
	}

	r2 := newLogRing()
	r2.add(warnAt(0, "motor", "a", nil))
	if !r2.add(warnAt(0, "blade", "a", nil)) {
		t.Errorf("same message from a different source was folded")
	}
	if !r2.add(warnAt(0, "motor", "b", nil)) {
		t.Errorf("different message from the same source was folded")
	}
	if r2.add(warnAt(1, "motor", "a", nil)) {
		t.Errorf("repeat of an existing warning was not folded")
	}
}

func TestLogRingFoldingDoesNotMutatePublishedFields(t *testing.T) {
	r := newLogRing()
	f := map[string]any{"x": 1}
	r.add(warnAt(0, "motor", "boom", f))
	published := r.query(LogFilter{Limit: 1}, 0)[0].Fields
	r.add(warnAt(1, "motor", "boom", nil))
	r.add(warnAt(2, "motor", "boom", nil))
	if _, ok := published["repeats"]; ok {
		t.Errorf("folding mutated a map already handed to a subscriber: %v", published)
	}
	if _, ok := f["repeats"]; ok {
		t.Errorf("folding mutated the caller's fields map: %v", f)
	}
	if got := r.query(LogFilter{Limit: 1}, 2)[0].Fields["repeats"]; got != 3 {
		t.Errorf("repeats = %v, want 3", got)
	}
}
