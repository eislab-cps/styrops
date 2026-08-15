package sim

// events.go — fan-out to WebSocket subscribers. Sends are non-blocking: a slow
// consumer loses events, the engine never blocks. The bus has its own mutex
// and never calls back into the engine, so publishing while holding the engine
// lock is safe.

import "sync"

const subscriberBuffer = 256

type eventBus struct {
	mu     sync.Mutex
	next   int
	subs   map[int]chan Event
	closed bool
}

func newEventBus() *eventBus { return &eventBus{subs: map[int]chan Event{}} }

func (b *eventBus) subscribe() (<-chan Event, func()) {
	b.mu.Lock()
	defer b.mu.Unlock()
	ch := make(chan Event, subscriberBuffer)
	if b.closed {
		close(ch)
		return ch, func() {}
	}
	id := b.next
	b.next++
	b.subs[id] = ch
	var once sync.Once
	return ch, func() {
		once.Do(func() {
			b.mu.Lock()
			defer b.mu.Unlock()
			if c, ok := b.subs[id]; ok {
				delete(b.subs, id)
				close(c)
			}
		})
	}
}

func (b *eventBus) publish(ev Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, ch := range b.subs {
		select {
		case ch <- ev:
		default: // slow consumer: drop
		}
	}
}

func (b *eventBus) close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	for id, ch := range b.subs {
		delete(b.subs, id)
		close(ch)
	}
}
