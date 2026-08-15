// chat.mjs — conversation with the mower's agent, buildingai-style.
//
// The user MUST log in with their own ColonyOS private key; the browser then
// talks to the colonies server directly with signed RPCs (no key ever touches
// the mower server). Flow per turn:
//   submitFunctionSpec exec_query {goal, session_id, agent:"automower"}
//     → root process out[0] → graph id
//     → poll process graph until done → agent_completed node's out[0]
//   meanwhile getLogsBySession is polled and think/tool/status envelopes are
//   rendered live. context_summary from the answer is carried to the next
//   turn — that is the whole conversation-memory mechanism.
//
// Credentials persist in IndexedDB ("mower"/config/auth), same exposure model
// as buildingai: the key stays in this browser only.

import { ICON } from './icons.mjs';
import { ColoniesClient } from '../vendor/colonies-ts.mjs';

const CHAT_ID = 'mower_' + Date.now().toString(36) + '_' + Math.random().toString(16).slice(2, 8);

export const chatId = () => CHAT_ID;

const DEFAULT_SERVER = '';
const DEFAULT_COLONY = '';

// ── IndexedDB credential store ──────────────────────────────────────────────
const DB_NAME = 'mower', DB_STORE = 'config', DB_KEY = 'auth';

function idb() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(DB_STORE);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function loadAuth() {
  try {
    const db = await idb();
    return await new Promise((res) => {
      const rq = db.transaction(DB_STORE).objectStore(DB_STORE).get(DB_KEY);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => res(null);
    });
  } catch { return null; }
}
async function saveAuth(v) {
  try {
    const db = await idb();
    db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(v, DB_KEY);
  } catch { /* private mode etc — session-only login */ }
}
async function clearAuth() {
  try {
    const db = await idb();
    db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).delete(DB_KEY);
  } catch { /* ignore */ }
}

function makeClient(serverUrl) {
  const u = new URL(serverUrl);
  return new ColoniesClient({
    host: u.hostname,
    port: parseInt(u.port) || (u.protocol === 'https:' ? 443 : 80),
    tls: u.protocol === 'https:',
  });
}

// ── minimal markdown: escape first, then bold / italic / code / lists ───────
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

export function md(src) {
  const inline = (t) => t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>');
  const out = [];
  let list = null, para = [];
  const flushP = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const flushL = () => {
    if (!list) return;
    out.push(`<${list.tag}>` + list.items.map((i) => '<li>' + inline(i) + '</li>').join('') + `</${list.tag}>`);
    list = null;
  };
  for (const raw of esc(src).split('\n')) {
    const t = raw.trim();
    const ul = /^[-*+]\s+(.*)$/.exec(t);
    const ol = /^\d+[.)]\s+(.*)$/.exec(t);
    if (ul || ol) {
      flushP();
      const tag = ul ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { flushL(); list = { tag, items: [] }; }
      list.items.push((ul || ol)[1]);
      continue;
    }
    flushL();
    if (!t) { flushP(); continue; }
    para.push(t);
  }
  flushL(); flushP();
  return out.join('') || '';
}

// ── answer post-processing (mirrors the exec conventions) ───────────────────
const THINK_RE = /<think>[\s\S]*?<\/think>/g;
const HEX64_RE = /^[0-9a-f]{64}$/;

function extractGraphId(out) {
  const s = String(out || '').trim();
  try {
    const m = JSON.parse(s);
    for (const k of ['graph_id', 'process_graph_id', 'processgraphid']) {
      if (typeof m[k] === 'string' && m[k]) return m[k];
    }
    return '';
  } catch { /* not JSON */ }
  return HEX64_RE.test(s) ? s : '';
}

function parseEnvelope(msg) {
  let env;
  try { env = JSON.parse(msg); } catch {
    const t = String(msg || '').trim();
    return t ? { role: 'thinking', text: t } : null;
  }
  if (!env || typeof env !== 'object') return null;
  const wf = env.workflowid || env.workflow_id || '';
  switch (env.kind) {
    case 'think': return { role: 'thinking', text: String(env.text || '').trim(), wf };
    case 'tool': return { role: 'tool', text: String(env.tool || env.name || env.text || '').trim(), wf };
    case 'status': return { role: 'status', text: String(env.text || '').trim(), wf };
    default: return null; // prompt, answer, sys, energy
  }
}

export class Chat {
  constructor(hud) {
    this.hud = hud;
    this.log = document.querySelector('#chat-log');
    this.input = document.querySelector('#chat-input');
    this.send = document.querySelector('#chat-send');
    this.sub = document.querySelector('#chat-sub');
    this.panel = document.querySelector('#chat');
    this.reopen = document.querySelector('#chat-reopen');
    this.hero = this.log.querySelector('.chat-hero');

    // colony connection state
    this.client = null;
    this.colony = null;
    this.contextSummary = '';
    this.logSeq = 0;

    // inline-SVG glyphs (no emoji font dependency)
    document.querySelector('.ai-mark').innerHTML = ICON.spark;
    this.reopen.innerHTML = ICON.spark;
    this.send.innerHTML = ICON.send;

    this.pinned = true;
    this.busy = false;
    this.turn = null;

    this.log.addEventListener('scroll', () => {
      this.pinned = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 70;
    });

    this.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); this.submit(); }
    });
    this.input.addEventListener('input', () => this.autosize());
    this.send.addEventListener('click', () => this.submit());

    for (const s of document.querySelectorAll('.sugg')) {
      s.addEventListener('click', () => {
        this.input.value = s.textContent;
        this.autosize();
        this.submit();
      });
    }

    const toggle = (open) => {
      this.panel.classList.toggle('hidden', !open);
      this.reopen.classList.toggle('show', !open);
      if (open) setTimeout(() => this.input.focus(), 180);
    };
    document.querySelector('#chat-toggle').addEventListener('click', () => toggle(false));
    this.reopen.addEventListener('click', () => toggle(true));

    this.lock();
    this.autoLogin();
  }

  // ── login ─────────────────────────────────────────────────────────────────
  lock() {
    this.panel.classList.add('locked');
    // viewer mode: without a colony identity the whole control surface
    // (mission buttons, palette, sim speed, …) is hidden via CSS
    document.body.classList.remove('authed');
    if (!this.card) this.buildConnectCard();
    this.card.style.display = '';
  }

  unlock() {
    this.panel.classList.remove('locked');
    document.body.classList.add('authed');
    if (this.card) this.card.style.display = 'none';
    this.ensureLogoutBtn();
    this.sub.textContent = 'ask the mower anything';
  }

  buildConnectCard() {
    const c = document.createElement('div');
    c.className = 'connect-card';
    c.innerHTML = `
      <h3>Connect to Moa</h3>
      <p>Chat is signed with <b>your</b> colony identity — enter your key to talk to the mower.</p>
      <label>Server<input type="text" id="cc-server" value="${DEFAULT_SERVER}" placeholder="https://your-colonies-server" autocomplete="off"></label>
      <label>Colony<input type="text" id="cc-colony" value="${DEFAULT_COLONY}" placeholder="colony name" autocomplete="off"></label>
      <label>Private key<input type="password" id="cc-key" placeholder="Your ColonyOS private key" autocomplete="off"></label>
      <div class="cc-row"><button id="cc-go">Connect</button><span class="cc-err" id="cc-err"></span></div>`;
    // sits at the top of the log, above the hero text
    this.log.insertBefore(c, this.log.firstChild);
    this.card = c;
    const go = c.querySelector('#cc-go');
    const err = c.querySelector('#cc-err');
    const attempt = async () => {
      err.textContent = '';
      go.disabled = true;
      go.textContent = 'Connecting…';
      try {
        await this.login(
          c.querySelector('#cc-server').value.trim(),
          c.querySelector('#cc-colony').value.trim(),
          c.querySelector('#cc-key').value.trim(),
          true,
        );
      } catch (e) {
        err.textContent = /40[13]|signature|denied|invalid/i.test(String(e))
          ? 'rejected — check the key' : (e.message || String(e));
      } finally {
        go.disabled = false;
        go.textContent = 'Connect';
      }
    };
    go.addEventListener('click', attempt);
    c.querySelector('#cc-key').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') attempt();
    });
  }

  ensureLogoutBtn() {
    if (this.logoutBtn) { this.logoutBtn.style.display = ''; return; }
    const head = document.querySelector('#chat-toggle')?.parentElement;
    if (!head) return;
    const b = document.createElement('button');
    b.className = 'chat-logout';
    b.title = 'Disconnect from the colony';
    b.textContent = 'disconnect';
    b.addEventListener('click', () => this.logout());
    head.insertBefore(b, document.querySelector('#chat-toggle'));
    this.logoutBtn = b;
  }

  async login(serverUrl, colony, prvKey, persist) {
    if (!serverUrl || !colony || !prvKey) throw new Error('all fields are required');
    const client = makeClient(serverUrl);
    client.setPrivateKey(prvKey);
    await client.getExecutors(colony); // connectivity + key check
    this.client = client;
    this.colony = colony;
    if (persist) saveAuth({ serverUrl, colony, prvKey });
    this.unlock();
    this.note('connected to ' + colony + ' @ ' + new URL(serverUrl).hostname);
  }

  async autoLogin() {
    const a = await loadAuth();
    if (!a) return;
    try { await this.login(a.serverUrl, a.colony, a.prvKey, false); }
    catch { this.lock(); }
  }

  logout() {
    clearAuth();
    this.client = null;
    this.colony = null;
    this.contextSummary = '';
    if (this.logoutBtn) this.logoutBtn.style.display = 'none';
    this.sub.textContent = 'not connected';
    this.lock();
  }

  // ── asking from outside the panel (tutorial overlay, hero chips) ──────────
  /**
   * Fill the composer with `text` and send it. Returns false when there is no
   * colony session — the caller is expected to send the user to the login card
   * rather than silently dropping the question.
   */
  ask(text) {
    if (!this.client) return false;
    if (this.panel.classList.contains('hidden')) {
      this.panel.classList.remove('hidden');
      this.reopen.classList.remove('show');
    }
    this.input.value = text;
    this.autosize();
    this.submit();
    return true;
  }

  /** Bring the connect card into view and put the cursor in the key field. */
  focusConnect() {
    if (this.panel.classList.contains('hidden')) {
      this.panel.classList.remove('hidden');
      this.reopen.classList.remove('show');
    }
    if (!this.card) this.buildConnectCard();
    this.card.style.display = '';
    this.card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    this.card.classList.remove('flash');
    void this.card.offsetWidth;
    this.card.classList.add('flash');
    setTimeout(() => this.card.querySelector('#cc-key')?.focus(), 160);
  }

  // ── UI plumbing (unchanged) ───────────────────────────────────────────────
  autosize() {
    const i = this.input;
    i.style.height = 'auto';
    i.style.height = Math.min(110, i.scrollHeight) + 'px';
  }

  scroll() { if (this.pinned) this.log.scrollTop = this.log.scrollHeight; }

  add(el) {
    if (this.hero) { this.hero.remove(); this.hero = null; }
    this.log.appendChild(el);
    this.scroll();
    return el;
  }

  async submit() {
    const text = this.input.value.trim();
    if (!text || this.busy) return;
    if (!this.client) { this.lock(); return; }
    this.input.value = '';
    this.autosize();

    const bubble = document.createElement('div');
    bubble.className = 'msg user';
    bubble.textContent = text;
    this.add(bubble);

    this.startTurn();
    try {
      const answer = await this.runTurn(text);
      this.handle({ chat_id: CHAT_ID, role: 'assistant', text: answer, done: true });
    } catch (err) {
      this.endTurn();
      this.note('could not reach the agent — ' + (err.message || err));
      this.hud?.toast('bad', ICON.bad, 'Chat failed', String(err.message || err));
    }
  }

  // ── the colony turn ───────────────────────────────────────────────────────
  async runTurn(goal) {
    const kwargs = { goal, session_id: CHAT_ID, agent: 'automower' };
    if (this.contextSummary) kwargs.context_summary = this.contextSummary;

    const proc = await this.client.submitFunctionSpec({
      funcname: 'exec_query',
      kwargs,
      conditions: { colonyname: this.colony, executortype: 'execexecutor' },
      maxwaittime: 600,
      maxexectime: 1800,
    });

    const deadline = Date.now() + 10 * 60 * 1000;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // stage 1: root process → graph id
    let rootOut = '';
    for (;;) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the agent');
      await this.pumpSessionLog();
      const p = await this.client.getProcess(proc.processid || proc.id);
      if (p && p.state === 2) { rootOut = (p.out && p.out[0]) || ''; break; }
      if (p && p.state === 3) throw new Error('agent request failed');
      await sleep(1000);
    }
    const graphId = extractGraphId(rootOut);
    if (!graphId) return this.cleanAnswer(rootOut);

    // stage 2: the agentic workflow
    for (;;) {
      if (Date.now() > deadline) throw new Error('the agent timed out');
      await this.pumpSessionLog(graphId);
      const g = await this.client.getProcessGraph(graphId);
      if (g && (g.state === 2 || g.state === 3)) {
        await this.pumpSessionLog(graphId);
        return await this.finalAnswer(g);
      }
      await sleep(1000);
    }
  }

  async finalAnswer(graph) {
    let fallback = '';
    for (const pid of graph.processids || []) {
      let p;
      try { p = await this.client.getProcess(pid); } catch { continue; }
      if (!p) continue;
      const out = (p.out && p.out[0]) || '';
      const fn = p.spec && p.spec.funcname;
      if (fn === 'agent_completed') return this.cleanAnswer(out);
      if (fn === 'agent_final_handler' && out) fallback = out;
      else if (!fallback && p.state === 2 && out) fallback = out;
    }
    if (fallback) return this.cleanAnswer(fallback);
    throw new Error(graph.state === 3 ? 'the agent workflow failed' : 'the agent produced no answer');
  }

  async pumpSessionLog(graphId) {
    let rows;
    try {
      rows = await this.client.getLogsBySession(this.colony, CHAT_ID, 1000, this.logSeq);
    } catch { return; }
    for (const r of rows || []) {
      if (r.seq > this.logSeq) this.logSeq = r.seq;
      const ev = parseEnvelope(r.message);
      if (!ev || !ev.text) continue;
      if (ev.wf && graphId && ev.wf !== graphId) continue;
      this.handle({
        chat_id: CHAT_ID, role: ev.role,
        text: ev.text.length > 600 ? ev.text.slice(0, 600) + '…' : ev.text,
        done: false,
      });
    }
  }

  cleanAnswer(raw) {
    let s = String(raw || '').trim();
    for (let i = 0; i < 3; i++) { // unwrap nested JSON
      let m;
      try { m = JSON.parse(s); } catch { break; }
      if (!m || typeof m !== 'object') break;
      if (typeof m.context_summary === 'string' && m.context_summary) {
        this.contextSummary = m.context_summary;
      }
      let found = false;
      for (const k of ['response', 'answer', 'result', 'message', 'text', 'content']) {
        if (typeof m[k] === 'string' && m[k]) { s = m[k].trim(); found = true; break; }
      }
      if (!found) break;
    }
    s = s.replace(THINK_RE, '').trim();
    if (s.startsWith('```') && s.endsWith('```')) {
      s = s.slice(3, -3);
      const nl = s.indexOf('\n');
      if (nl >= 0 && !s.slice(0, nl).includes(' ')) s = s.slice(nl + 1);
      s = s.trim();
    }
    return s || '(no answer)';
  }

  // ── turn state / rendering (unchanged) ────────────────────────────────────
  startTurn() {
    this.busy = true;
    this.turn = { think: null, thinkBody: null, thinkText: '', bubble: null, text: '' };
    this.input.disabled = true;
    this.send.disabled = true;
    this.sub.textContent = 'thinking…';
    this.sub.classList.add('busy');
    // Safety net: if a turn never finishes (agent crash) the composer must
    // not stay locked in front of an audience.
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (!this.busy) return;
      this.endTurn();
      this.note('no reply — the agent went quiet');
    }, 180000);
  }

  endTurn() {
    clearTimeout(this.watchdog);
    this.busy = false;
    this.input.disabled = false;
    this.send.disabled = false;
    this.sub.textContent = this.client ? 'ask the mower anything' : 'not connected';
    this.sub.classList.remove('busy');
    if (this.turn) {
      if (this.turn.think) { this.turn.think.classList.add('done'); this.turn.think.open = false; }
      if (this.turn.bubble) this.turn.bubble.classList.remove('streaming');
      for (const c of this.log.querySelectorAll('.toolchip:not(.done)')) c.classList.add('done');
    }
    this.turn = null;
    setTimeout(() => this.input.focus(), 60);
  }

  note(text) {
    const el = document.createElement('div');
    el.className = 'msg note';
    el.textContent = text;
    this.add(el);
  }

  ensureThinking() {
    const t = this.turn;
    if (t.think) return t;
    const d = document.createElement('details');
    d.className = 'think';
    d.open = true;
    const s = document.createElement('summary');
    s.innerHTML = '<span class="dots"><i></i><i></i><i></i></span><span>thinking…</span>';
    const body = document.createElement('div');
    body.className = 'tbody';
    d.append(s, body);
    this.add(d);
    t.think = d; t.thinkBody = body;
    return t;
  }

  ensureBubble() {
    const t = this.turn;
    if (t.bubble) return t;
    const b = document.createElement('div');
    b.className = 'msg bot streaming';
    this.add(b);
    t.bubble = b; t.text = '';
    return t;
  }

  /**
   * Merge an incoming chunk with what we already have: snapshot, duplicate
   * or delta — the prefix test resolves all three.
   */
  static merge(have, incoming) {
    const inc = incoming == null ? '' : String(incoming);
    if (!inc) return have;
    if (!have) return inc;
    if (inc.length >= have.length && inc.startsWith(have)) return inc;  // snapshot
    if (have.endsWith(inc)) return have;                                // duplicate
    return have + inc;                                                  // delta
  }

  /** Chat frame renderer (fed by runTurn; also accepts WS "chat" frames). */
  handle(m) {
    if (!m || (m.chat_id && m.chat_id !== CHAT_ID)) return;
    if (!this.turn) this.startTurn();
    const t = this.turn;
    const role = m.role || 'assistant';

    if (role === 'thinking') {
      this.ensureThinking();
      t.thinkText = Chat.merge(t.thinkText, m.text);
      t.thinkBody.textContent = t.thinkText;
      t.thinkBody.scrollTop = t.thinkBody.scrollHeight;
      this.scroll();
    } else if (role === 'tool') {
      const chip = document.createElement('div');
      chip.className = 'toolchip';
      const name = String(m.text || 'tool').trim();
      chip.innerHTML = `<span class="cog">${ICON.gear}</span><span>${esc(name)}</span>`;
      this.add(chip);
      // a tool call closes the current bubble; further prose opens a new one
      t.bubble = null; t.text = '';
    } else if (role === 'status') {
      if (m.text) this.note(String(m.text));
    } else {
      if (m.text) {
        this.ensureBubble();
        t.text = Chat.merge(t.text, m.text);
        t.bubble.innerHTML = md(t.text);
        this.scroll();
      }
    }

    if (m.done) this.endTurn();
  }
}
