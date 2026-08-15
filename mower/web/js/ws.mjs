// ws.mjs — single /ws connection, JSON dispatch by `type`, exponential backoff.
//
// Server → client frames are {"type": ..., "data": ...} where type is one of
// status | grass | world | log | event | chat (docs/ROBOT_API.md).
// The client never sends anything; commands go over REST.

// The server pushes `status` at ~5 Hz, so silence is always a fault. A socket
// can sit in readyState CLOSING indefinitely when the peer dies without
// replying to the close handshake (hung server, network partition) — in that
// state `onclose` never fires and the UI would show a permanent, wrong "LIVE".
// The idle watchdog cuts that socket loose and reconnects.
const IDLE_TIMEOUT = 15000;
const IDLE_CHECK = 4000;

export class WSBus {
  constructor(path = '/ws') {
    this.path = path;
    this.lastRx = 0;
    this.idleTimer = 0;
    this.handlers = new Map();   // type -> Set<fn>
    this.lifecycle = new Set();  // fn(connected, everConnected)
    this.sock = null;
    this.tries = 0;
    this.everConnected = false;
    this.connected = false;
    this.timer = 0;
    this.closedByUs = false;
  }

  on(type, fn) {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    set.add(fn);
    return () => set.delete(fn);
  }

  /** fn(connected: boolean, isReconnect: boolean) */
  onLifecycle(fn) { this.lifecycle.add(fn); return () => this.lifecycle.delete(fn); }

  url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}${this.path}`;
  }

  connect() {
    if (this.sock && (this.sock.readyState === 0 || this.sock.readyState === 1)) return;
    clearTimeout(this.timer);

    let sock;
    try {
      sock = new WebSocket(this.url());
    } catch (err) {
      console.warn('[ws] construct failed', err);
      this.scheduleReconnect();
      return;
    }
    this.sock = sock;

    sock.onopen = () => {
      const isReconnect = this.everConnected;
      this.everConnected = true;
      this.connected = true;
      this.tries = 0;
      this.lastRx = Date.now();
      this.startIdleWatch();
      this.emitLifecycle(true, isReconnect);
    };

    sock.onmessage = (ev) => {
      this.lastRx = Date.now();
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      if (!frame || typeof frame !== 'object') return;
      // tolerate bare pings / typeless frames
      if (!frame.type) return;
      const set = this.handlers.get(frame.type);
      if (!set) return;
      for (const fn of set) {
        try { fn(frame.data, frame); } catch (err) { console.error(`[ws] handler ${frame.type}`, err); }
      }
    };

    sock.onerror = () => { /* onclose always follows */ };

    sock.onclose = () => {
      if (this.sock === sock) this.sock = null;
      if (this.connected) { this.connected = false; this.emitLifecycle(false, this.everConnected); }
      if (!this.closedByUs) this.scheduleReconnect();
    };
  }

  startIdleWatch() {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      if (!this.connected || !this.sock) return;
      if (Date.now() - this.lastRx < IDLE_TIMEOUT) return;
      console.warn(`[ws] no frames for ${Date.now() - this.lastRx} ms — dropping the socket and reconnecting`);
      this.drop();
    }, IDLE_CHECK);
  }

  /** Abandon the current socket without waiting on a close handshake. */
  drop() {
    const sock = this.sock;
    this.sock = null;
    if (sock) {
      sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null;
      try { sock.close(); } catch { /* already dead */ }
    }
    if (this.connected) { this.connected = false; this.emitLifecycle(false, this.everConnected); }
    if (this.closedByUs) return;
    this.tries = 0;               // a healthy socket just died — retry promptly
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    this.tries++;
    // 400ms → 800 → 1600 … capped at 10s, ±25% jitter
    const base = Math.min(400 * Math.pow(2, this.tries - 1), 10000);
    const delay = base * (0.75 + Math.random() * 0.5);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  emitLifecycle(connected, isReconnect) {
    for (const fn of this.lifecycle) {
      try { fn(connected, isReconnect); } catch (err) { console.error('[ws] lifecycle', err); }
    }
  }

  close() {
    this.closedByUs = true;
    clearTimeout(this.timer);
    clearInterval(this.idleTimer);
    this.idleTimer = 0;
    if (this.sock) this.sock.close();
  }
}
