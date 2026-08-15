// === Dagny Chat Panel ===
import { ColoniesClient, Crypto } from './colonies-ts.mjs';
import { marked, Renderer } from './marked.mjs';
import { rowsToTurn, fmtTokens } from './sessionlog.mjs';
import morphdom from './morphdom.mjs';

// Brain glyph for the thinking summary (mirrors execapp ChatTurn / boiler).
const BRAIN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ct-brain" aria-hidden="true"><path d="M12 5a3 3 0 1 0-5.997.142 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.142 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/></svg>';
function fmtEnergy(wh) { if (wh >= 1000) return (wh / 1000).toFixed(2) + ' kWh'; return wh.toFixed(wh < 10 ? 2 : 1) + ' Wh'; }
function fmtCost(kr) { if (kr >= 0.01) return kr.toFixed(2) + ' kr'; return (kr * 100).toFixed(2) + ' öre'; }

// XSS-safe markdown renderer. marked covers GFM (tables, lists, code,
// strikethrough, blockquote) and we override the html/link/image
// renderers so LLM-emitted <script>/<img onerror=...> etc. can't escape
// into the DOM. Keep this in sync with boiler/web/chat.mjs.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function isSafeURL(href) {
  if (!href) return false;
  const lower = href.trim().toLowerCase();
  if (lower.startsWith('javascript:')) return false;
  if (lower.startsWith('vbscript:'))   return false;
  if (lower.startsWith('data:'))       return false;
  if (lower.startsWith('file:'))       return false;
  return true;
}
const safeRenderer = new Renderer();
safeRenderer.html = (html) => escapeHtml(html);
safeRenderer.link = (href, title, text) => {
  if (!isSafeURL(href)) return escapeHtml(text || href);
  const t = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${escapeHtml(href)}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`;
};
safeRenderer.image = (href, title, text) => {
  if (!isSafeURL(href)) return escapeHtml(text || href);
  const t = title ? ` title="${escapeHtml(title)}"` : '';
  return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text || '')}"${t}>`;
};
marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false, renderer: safeRenderer });

const DB_NAME = 'buildingai';
const DB_STORE = 'config';
const DB_KEY = 'auth';

let chatClient = null;
let chatColony = '';
let chatPrvKey = '';
let chatSessionId = null;
let chatContextSummary = '';
let chatSending = false;
let thinkingInterval = null;
let thinkingSince = 0;
let thinkingSeenKeys = new Set();
let thinkingEntries = [];

// IndexedDB helpers
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveAuth(data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(data, DB_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function loadAuth() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).get(DB_KEY);
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch { return null; }
}

async function clearAuth() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(DB_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

function showChat(connected) {
  const panel = document.getElementById('chat-panel');
  const viewer = document.getElementById('viewer-container');
  const toggle = document.getElementById('chat-toggle');

  document.getElementById('chat-login').style.display = connected ? 'none' : 'flex';
  document.getElementById('chat-messages').style.display = connected ? 'flex' : 'none';
  document.getElementById('chat-input-area').style.display = connected ? 'flex' : 'none';
  document.getElementById('chat-status').textContent = connected ? 'Connected' : 'Not connected';
  document.getElementById('chat-status').style.color = connected ? '#5cb85c' : '#666';
  document.getElementById('chat-logout-btn').style.display = connected ? 'inline-block' : 'none';
  document.getElementById('chat-header').style.display = connected ? 'flex' : 'none';

  if (connected) {
    // Dress the panel for a live session but leave it docked or open exactly
    // as the user left it: the landing view is the map, and a key restored
    // from storage is not a request to slide the panel back out.
    panel.classList.remove('fullscreen');
    viewer.style.display = '';
    if (toggle) toggle.style.display = '';
    window.dispatchEvent(new Event('resize'));
  } else {
    // The map is public. Logged out, the viewer stays up and the panel simply
    // docks with the login form in it — only the chat needs a colony key.
    panel.classList.remove('fullscreen');
    panel.classList.remove('hidden');
    viewer.style.display = '';
    if (toggle) toggle.style.display = '';
    window.dispatchEvent(new Event('resize'));
  }
}

async function connectToColony(serverUrl, colony, prvKey) {
  const url = new URL(serverUrl);
  const host = url.hostname;
  const port = parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80);
  const tls = url.protocol === 'https:';

  const client = new ColoniesClient({ host, port, tls });
  client.setPrivateKey(prvKey);

  // Test connection
  const executors = await client.getExecutors(colony);
  if (!executors) throw new Error('No response from server');

  chatClient = client;
  chatColony = colony;
  chatPrvKey = prvKey;
  return true;
}

window.chatLogin = async function() {
  const server = document.getElementById('login-server').value.trim();
  const colony = document.getElementById('login-colony').value.trim();
  const key = document.getElementById('login-key').value.trim();
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';

  if (!server || !colony || !key) { errEl.textContent = 'All fields required'; return; }

  try {
    await connectToColony(server, colony, key);
    await saveAuth({ serverUrl: server, colony, prvKey: key });
    showChat(true);
    addMessage('system', '**Hi, I\'m Dagny** — your building assistant.\nHere are some things I can help with:\n' +
      '`take me to A2306`\n' +
      '`how do I get from A2527 to A2306?`\n' +
      '`mark room A1001 in red`\n' +
      '`clear everything`');
  } catch (e) {
    errEl.textContent = 'Connection failed: ' + (e.message || e);
  }
};

window.chatLogout = async function() {
  await clearAuth();
  chatClient = null;
  chatColony = '';
  chatPrvKey = '';
  chatSessionId = null;
  chatContextSummary = '';
  document.getElementById('chat-messages').innerHTML = '';
  showChat(false);
};

// Full CommonMark + GFM via vendored `marked` — gets us tables,
// ordered lists, blockquote, strikethrough, nested lists, etc. that
// the LLM regularly emits and the hand-rolled regex renderer dropped
// as raw text. XSS protection is in safeRenderer above.
function renderMarkdown(text) {
  try {
    return marked.parse(text);
  } catch (e) {
    console.warn('marked.parse failed:', e);
    return escapeHtml(text).replace(/\n/g, '<br>');
  }
}

function addMessage(role, text) {
  const el = document.createElement('div');
  el.className = 'chat-msg ' + role;
  el.innerHTML = renderMarkdown(text);
  const container = document.getElementById('chat-messages');
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

function updateMessage(el, text) {
  el.innerHTML = renderMarkdown(text);
  const container = document.getElementById('chat-messages');
  container.scrollTop = container.scrollHeight;
}

// Thinking log streaming: collects entries + renders live into the
// per-message cognition panel. Target element is captured in
// thinkingTargetEl so pollThinkingLogs can update it on each tick.
let thinkingTargetEl = null;
function startThinkingStream(graphId, el) {
  thinkingSince = Date.now() * 1000000;
  thinkingSeenKeys = new Set();
  thinkingEntries = [];
  thinkingTargetEl = el || null;
  thinkingInterval = setInterval(() => pollThinkingLogs(graphId), 500);
}

function stopThinkingStream() {
  if (thinkingInterval) { clearInterval(thinkingInterval); thinkingInterval = null; }
}

async function pollThinkingLogs(graphId) {
  try {
    const graph = await chatClient.getProcessGraph(graphId);
    const pids = graph.processids || [];

    for (const pid of pids) {
      try {
        const p = await chatClient.getProcess(pid);
        if (p.state !== 1 && p.state !== 2) continue;

        const logs = await chatClient.getLogs(chatColony, pid, '', 100, thinkingSince);
        if (!logs || logs.length === 0) continue;

        for (const log of logs) {
          const key = pid + (log.message || '').substring(0, 50);
          if (thinkingSeenKeys.has(key)) continue;
          thinkingSeenKeys.add(key);
          const entries = parseThinkingLog(log.message || '');
          if (!entries || !entries.length) continue;
          for (const entry of entries) {
            const last = thinkingEntries[thinkingEntries.length - 1];
            if (last && last.kind === entry.kind && last.text === entry.text) {
              last.count = (last.count || 1) + 1;
            } else {
              thinkingEntries.push(entry);
            }
          }
          if (thinkingTargetEl) {
            renderThinkingInto(thinkingTargetEl, thinkingEntries, /*live=*/ true);
          }
        }
      } catch {}
    }
  } catch {}
}

function extractResponse(raw) {
  return cleanResponse(extractText(raw, 0));
}

function cleanResponse(text) {
  return text
    // Strip <think>...</think> blocks (LLM reasoning artifacts)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    // Strip incomplete <think> blocks (no closing tag)
    .replace(/<think>[\s\S]*/gi, '')
    // Strip other XML-like tags that shouldn't be in output
    .replace(/<\/?(?:think|reasoning|analysis|internal)>/gi, '')
    // Strip escaped unicode that wasn't decoded
    .replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\n/g, '\n')
    // Clean up resulting whitespace
    .replace(/^\s*\n/gm, '')
    .trim();
}

function extractText(raw, depth) {
  if (depth > 3) return raw;

  try {
    // Strip markdown code fences
    let jsonStr = raw;
    const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();

    const parsed = JSON.parse(jsonStr);

    // Extract context summary if present
    if (parsed.context_summary) chatContextSummary = parsed.context_summary;

    // Try all known response fields
    const text = parsed.summary || parsed.message || parsed.response || parsed.result;
    if (text) {
      // Check if the extracted text is itself JSON or contains code fences — recurse
      if (text.trim().startsWith('{') || text.trim().startsWith('```')) {
        return extractText(text, depth + 1);
      }
      return text;
    }

    return raw;
  } catch {
    // Not JSON — strip code fences and return
    const clean = raw.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
    return clean || raw;
  }
}

// Parse one raw log message into one or more structured events.
// Returns an array (possibly empty) — one agentic log entry can carry
// several tool calls and we want each as its own line.
//
// Recognises the markdown blocks emitted by exec/pkg/executors/agentic/
// node_tool_loop.go's logAndCollect: iteration thinking, LLM output +
// tool calls, done analysis, tool-loop framing. LLM Input dumps are
// dropped (the model has already consumed them).
function parseThinkingLog(msg) {
  if (!msg) return [];
  const trimmed = msg.trim();
  if (!trimmed) return [];

  let parsed = null;
  try { parsed = JSON.parse(trimmed); } catch {}
  if (parsed && typeof parsed === 'object') {
    if (parsed.tool)     return [mkEntry('tool',  parsed.tool)];
    if (parsed.funcname) return [mkEntry('tool',  parsed.funcname)];
    if (parsed.thinking) return [mkEntry('think', cleanInline(parsed.thinking))];
    if (parsed.step)     return [mkEntry('step',  cleanInline(parsed.step))];
    if (parsed.message)  return [mkEntry('step',  cleanInline(parsed.message))];
    return [];
  }

  // LLM Input dumps (system prompt + delta replays) — pure noise.
  if (/^<details>.*## Iteration \d+ — LLM Input/.test(trimmed)) return [];
  if (/^## Iteration \d+ — LLM Input/.test(trimmed))            return [];

  // ## Iteration N — Thinking\n<reasoning>
  let m = trimmed.match(/^## Iteration (\d+) — Thinking\s*\n([\s\S]+)$/);
  if (m) {
    const text = cleanInline(m[2]);
    if (!text) return [];
    return [mkEntry('think', `iter ${m[1]}: ${clip(text, 600)}`)];
  }

  // ## Iteration N — LLM Output\n<prose>\n\n**Tool calls emitted:**\n- `tool(args)`
  m = trimmed.match(/^## Iteration (\d+) — LLM Output\s*\n([\s\S]*)$/);
  if (m) {
    const iter = m[1];
    const body = m[2];
    const out = [];
    const callsIdx = body.indexOf('**Tool calls emitted:**');
    const prose = (callsIdx >= 0 ? body.slice(0, callsIdx) : body).trim();
    if (prose) {
      const cleaned = cleanInline(prose);
      if (cleaned) out.push(mkEntry('recv', `iter ${iter}: ${clip(cleaned, 400)}`));
    }
    if (callsIdx >= 0) {
      const callsBlock = body.slice(callsIdx);
      const callRe = /^-\s*`([^`]+)`/gm;
      let cm;
      while ((cm = callRe.exec(callsBlock)) !== null) {
        out.push(mkEntry('tool', clip(cm[1], 200)));
      }
    }
    return out;
  }

  // ## Iteration N — Done [\n<analysis>]
  m = trimmed.match(/^## Iteration (\d+) — Done(?:\s*\n([\s\S]+))?$/);
  if (m) {
    const tail = m[2] ? cleanInline(m[2]) : '';
    const text = tail ? `iter ${m[1]} done — ${clip(tail, 400)}` : `iter ${m[1]} done`;
    return [mkEntry('recv', text)];
  }

  // ## Iteration N\n<analysis> (fallback without suffix)
  m = trimmed.match(/^## Iteration (\d+)\s*\n([\s\S]+)$/);
  if (m) {
    const text = cleanInline(m[2]);
    if (!text) return [];
    return [mkEntry('step', `iter ${m[1]}: ${clip(text, 400)}`)];
  }

  // ## Tool Loop Started\n**Goal:** <goal>
  m = trimmed.match(/^## Tool Loop Started\s*\n\*\*Goal:\*\*\s*([^\n]+)/);
  if (m) return [mkEntry('step', `loop start — ${clip(m[1].trim(), 200)}`)];

  // **Subgoal N:** <text>
  m = trimmed.match(/^\*\*Subgoal (\d+):\*\*\s*(.+)$/);
  if (m) return [mkEntry('step', `subgoal ${m[1]}: ${clip(m[2], 200)}`)];

  if (/^\*\*tool_done called\*\*/.test(trimmed))
    return [mkEntry('recv', 'tool_done — final answer ready')];
  if (/^\*\*tool_done refused\*\*/.test(trimmed))
    return [mkEntry('step', 'tool_done refused — verify gate failed')];

  // **Compactor:** / **Steering:** / **Dedup:** / etc.
  m = trimmed.match(/^\*\*([A-Za-z][A-Za-z _-]+):?\*\*\s*(.+)$/s);
  if (m) {
    const tag = m[1].toLowerCase();
    const text = cleanInline(m[2]);
    return [mkEntry('step', `${tag}: ${clip(text, 200)}`)];
  }

  // Plain-text fallback for explicit shapes only.
  if ((m = trimmed.match(/^(?:●\s*)?(?:calling|invoking|running|executing)\s+([a-zA-Z_][\w.]*)/i)))
    return [mkEntry('tool', m[1])];
  if ((m = trimmed.match(/^(?:waiting(?:\s+for|\s+on)?|polling)\s+(.+)$/i)))
    return [mkEntry('wait', clip(m[1], 60))];
  if ((m = trimmed.match(/^(?:received|returned|completed)\s+([a-zA-Z_][\w.]*)/i)))
    return [mkEntry('recv', m[1])];
  return [];
}

function mkEntry(kind, text) { return { kind, text, ts: Date.now() }; }

function cleanInline(s) {
  if (!s) return '';
  return String(s)
    .replace(/```[\s\S]*?```/g, '⟨…code…⟩')
    .replace(/<\/?(?:think|reasoning|analysis|internal)>/gi, '')
    .replace(/\\u003c/g, '<').replace(/\\u003e/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(s, n) {
  if (!s) return '';
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ── Cognition log renderer (sci-fi terminal scroll, mirrors boiler) ──
const KIND_META = {
  tool:  { tag: 'CALL ', glyph: '▸', cls: 'kg-call'  },
  wait:  { tag: 'WAIT ', glyph: '◌', cls: 'kg-wait'  },
  step:  { tag: 'STEP ', glyph: '◇', cls: 'kg-step'  },
  think: { tag: 'THINK', glyph: '◆', cls: 'kg-think' },
  recv:  { tag: 'RECV ', glyph: '◂', cls: 'kg-recv'  },
};

function renderThinkingInto(el, entries, live) {
  if (!el) return;
  if (!entries.length) {
    el.innerHTML = '<div class="kg-line kg-placeholder"><span class="kg-caret">▮</span> &nbsp;awaiting telemetry…</div>';
    return;
  }
  const lines = entries.map(e => renderThinkingLine(e)).join('');
  const tail = live
    ? '<div class="kg-line kg-status"><span class="kg-caret">▮</span> &nbsp;PROCESSING</div>'
    : '<div class="kg-line kg-status kg-done">● ANALYSIS COMPLETE</div>';
  el.innerHTML = lines + tail;
  el.scrollTop = el.scrollHeight;
}

function renderThinkingLine(entry) {
  const meta = KIND_META[entry.kind] || KIND_META.step;
  const ts = new Date(entry.ts || Date.now()).toTimeString().slice(0, 8);
  const count = entry.count && entry.count > 1
    ? `<span class="kg-count">×${entry.count}</span>` : '';
  const text = escapeHtml(entry.text || '');
  return (
    `<div class="kg-line ${meta.cls}">` +
      `<span class="kg-ts">${ts}</span>` +
      `<span class="kg-glyph">${meta.glyph}</span>` +
      `<span class="kg-tag">${meta.tag}</span>` +
      `<span class="kg-text">${text}</span>` +
      count +
    `</div>`
  );
}

// ── ChatTurn rendering + session-log thinking stream (ported from boiler) ──
function renderThinkingBody(turn) {
  const parts = [];
  for (const step of turn.thinking) {
    const toks = (step.in || step.out)
      ? `<span class="ct-tok" title="tokens this iteration — ↑ prompt · ↓ completion">↑${fmtTokens(step.in)} ↓${fmtTokens(step.out)}</span>` : '';
    parts.push(`<div class="ct-iter"><span>iteration ${step.iter}</span>${toks}</div>`);
    if (step.text && step.text.trim()) {
      parts.push(`<div class="ct-think-text markdown-body">${renderMarkdown(step.text)}</div>`);
    }
  }
  if (turn.events.length) {
    parts.push('<div class="ct-events">');
    for (const ev of turn.events) {
      const glyph = ev.kind === 'sys' ? '⚙' : '▸';
      parts.push(`<div class="ct-ev ct-ev-${ev.kind}"><span class="ct-ev-g">${glyph}</span><span>${escapeHtml(ev.text)}</span></div>`);
    }
    parts.push('</div>');
  }
  return parts.join('');
}

function renderControls(turn, live) {
  const parts = [];
  if (turn.tokensIn || turn.tokensOut) {
    parts.push(`<span class="ct-chip" title="Tokens this turn — ↑ input · ↓ output">↑ ${fmtTokens(turn.tokensIn)} ↓ ${fmtTokens(turn.tokensOut)}</span>`);
  }
  if (turn.energyWh && !live) {
    parts.push(`<span class="ct-chip"><span class="ct-bolt">⚡</span> ${fmtEnergy(turn.energyWh)}${turn.cost ? ` · ${fmtCost(turn.cost)}` : ''}</span>`);
  }
  return parts.join('');
}

function renderWithLinksSafe(text) { try { return renderMarkdown(text); } catch { return escapeHtml(text); } }

function renderChatTurn(turn, ui, live) {
  const hasTel = turn.thinking.length > 0 || turn.events.length > 0;
  ui.details.style.display = hasTel ? '' : 'none';
  if (hasTel) {
    ui.steps.textContent = turn.events.length ? `· ${turn.events.length} step${turn.events.length === 1 ? '' : 's'}` : '';
    ui.spin.style.display = live ? '' : 'none';
    ui.thinkBody.innerHTML = renderThinkingBody(turn);
    if (live) ui.details.open = true;
  }
  if (live && turn.reply) {
    ui.replyEl.style.display = '';
    morphdom(ui.replyEl, `<div>${renderWithLinksSafe(turn.reply)}</div>`, { childrenOnly: true });
  }
  ui.controls.innerHTML = renderControls(turn, live);
}

function streamSessionThinking(sessionId, graphId, ui) {
  let rows = [];
  let maxSeq = 0;
  let ws = null;
  let stopped = false;
  const rerender = () => renderChatTurn(rowsToTurn(rows, graphId), ui, !stopped);
  const ingest = (logs) => {
    if (!Array.isArray(logs) || !logs.length) return;
    rows.push(...logs);
    for (const l of logs) maxSeq = Math.max(maxSeq, l.seq ?? 0);
    rerender();
    const c = document.getElementById('chat-messages');
    if (c) c.scrollTop = c.scrollHeight;
  };
  (async () => {
    try { ingest(await chatClient.getLogsBySession(chatColony, sessionId, 10000, 0)); } catch {}
    if (stopped) return;
    try {
      ws = chatClient.subscribeSessionLog(chatColony, sessionId, maxSeq, 3600,
        (logs) => { if (!stopped) ingest(logs); }, () => {}, () => {});
    } catch {}
  })();
  return {
    stop() { stopped = true; if (ws) { try { ws.close(); } catch {} } },
    async finalize() {
      stopped = true;
      if (ws) { try { ws.close(); } catch {} }
      try {
        const pulled = await chatClient.getLogsBySession(chatColony, sessionId, 10000, 0);
        if (Array.isArray(pulled) && pulled.length) rows = pulled;
      } catch {}
      const turn = rowsToTurn(rows, graphId);
      renderChatTurn(turn, ui, false);
      ui.details.open = false;
      return turn;
    },
  };
}

window.chatSend = async function() {
  if (chatSending || !chatClient) return;
  const input = document.getElementById('chat-input');
  const goal = input.value.trim();
  if (!goal) return;

  input.value = '';
  if (input.tagName === 'TEXTAREA') { input.style.height = '38px'; input.style.overflowY = 'hidden'; }
  chatSending = true;
  document.getElementById('chat-send').disabled = true;

  // ChatTurn layout: prompt · collapsible thinking · reply · controls.
  const turnEl = document.createElement('div');
  turnEl.className = 'ct-turn';
  turnEl.innerHTML =
    '<div class="ct-prompt"><span class="ct-you">You &gt;</span> <span class="ct-prompt-text"></span></div>' +
    '<details class="ct-thinking" open><summary class="ct-think-summary">' +
      '<span class="ct-think-label">' + BRAIN_SVG + 'thinking</span>' +
      '<span class="ct-steps"></span><span class="ct-spin"></span>' +
    '</summary><div class="ct-think-body"></div></details>' +
    '<div class="ct-reply markdown-body" style="display:none"></div>' +
    '<div class="ct-working">working…</div>' +
    '<div class="ct-controls"></div>';
  turnEl.querySelector('.ct-prompt-text').textContent = goal;

  const container = document.getElementById('chat-messages');
  container.appendChild(turnEl);
  container.scrollTop = container.scrollHeight;

  const ui = {
    turnEl,
    details: turnEl.querySelector('.ct-thinking'),
    steps: turnEl.querySelector('.ct-steps'),
    spin: turnEl.querySelector('.ct-spin'),
    thinkBody: turnEl.querySelector('.ct-think-body'),
    replyEl: turnEl.querySelector('.ct-reply'),
    controls: turnEl.querySelector('.ct-controls'),
  };
  const workingEl = turnEl.querySelector('.ct-working');
  ui.details.style.display = 'none';
  let sessionStream = null;

  if (!chatSessionId) {
    chatSessionId = 'buildingai_' + Date.now() + '_' + Math.random().toString(16).slice(2, 8);
  }

  try {
    const viewerSessionId = window._viewerSessionId || '';
    const kwargs = {
      goal: goal,
      session_id: chatSessionId,
      agent: 'building',
      instructions: viewerSessionId
        ? 'When using building tools, always pass viewer_session_id="' + viewerSessionId + '" as a parameter.'
        : '',
    };
    if (chatContextSummary) {
      kwargs.context_summary = chatContextSummary;
    }

    const process = await chatClient.submitFunctionSpec({
      funcname: 'exec_query',
      kwargs: kwargs,
      conditions: { colonyname: chatColony, executortype: 'execexecutor' },
      maxwaittime: 600,
      maxexectime: 1800,
    });

    let graphId = null;
    const current = await chatClient.getProcess(process.processid);
    if (current.state === 2 && current.out?.length > 0) {
      graphId = extractGraphId(current);
    } else if (current.state === 3) {
      throw new Error(current.errors?.join(', ') || 'exec_query failed');
    }
    if (!graphId) {
      const execProc = await waitForProcess(process.processid, 2);
      const fullProc = await chatClient.getProcess(execProc.processid);
      graphId = extractGraphId(fullProc);
    }
    if (!graphId) throw new Error('No graph_id returned');

    sessionStream = streamSessionThinking(chatSessionId, graphId, ui);
    const result = await waitForGraphCompletion(graphId);
    const turn = await sessionStream.finalize();
    sessionStream = null;
    workingEl.remove();

    const responseText = result ? extractResponse(result) : (turn.reply || 'Task completed.');
    ui.replyEl.style.display = '';
    ui.replyEl.innerHTML = renderMarkdown(responseText);

    container.scrollTop = container.scrollHeight;
  } catch (e) {
    if (sessionStream) { sessionStream.stop(); sessionStream = null; }
    workingEl.remove();
    ui.replyEl.style.display = '';
    ui.replyEl.innerHTML = renderMarkdown('**Error:** ' + (e.message || e));
  } finally {
    chatSending = false;
    document.getElementById('chat-send').disabled = false;
    document.getElementById('chat-input').focus();
  }
};

// Auto-grow the chat textarea, capped at ~10 lines (240px).
window.chatAutogrow = function(ta) {
  ta.style.height = 'auto';
  const full = ta.scrollHeight;
  ta.style.height = Math.min(full, 240) + 'px';
  ta.style.overflowY = full > 240 ? 'auto' : 'hidden';
};

function extractGraphId(proc) {
  if (proc.out && proc.out.length > 0) {
    try {
      const output = JSON.parse(proc.out[0]);
      return output.graph_id || output.process_graph_id || null;
    } catch {
      // Might be a raw 64-char hex ID
      if (typeof proc.out[0] === 'string' && proc.out[0].length === 64) return proc.out[0];
    }
  }
  return null;
}

async function waitForGraphCompletion(graphId) {
  const completedPid = await findTerminalProcess(graphId);

  if (completedPid) {
    const p = await chatClient.getProcess(completedPid);
    if (p.state === 2) return await extractGraphResult(graphId);
    await waitForProcess(completedPid, 2);
  }

  return await extractGraphResult(graphId);
}

async function findTerminalProcess(graphId) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const graph = await chatClient.getProcessGraph(graphId);
    if (graph.state === 2 || graph.state === 3) return null; // already done

    const pids = graph.processids || [];
    for (const pid of pids) {
      try {
        const p = await chatClient.getProcess(pid);
        if (p.spec?.funcname === 'agent_completed') return pid;
      } catch {}
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}

async function extractGraphResult(graphId) {
  const graph = await chatClient.getProcessGraph(graphId);
  if (graph.state === 3) throw new Error('Agent workflow failed');

  const pids = graph.processids || [];
  const processes = [];
  for (const pid of pids) {
    try { processes.push(await chatClient.getProcess(pid)); } catch {}
  }

  for (const p of processes) {
    if (p.spec?.funcname === 'agent_completed' && p.state === 2 && p.out?.length > 0) return p.out[0];
  }
  for (const p of processes) {
    if (p.spec?.funcname === 'agent_final_handler' && p.state === 2 && p.out?.length > 0) return p.out[0];
  }
  for (let i = processes.length - 1; i >= 0; i--) {
    if (processes[i].state === 2 && processes[i].out?.length > 0) return processes[i].out[0];
  }
  return null;
}

function waitForProcess(processId, targetState) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const ws = chatClient.subscribeProcess(
      chatColony, processId, targetState, 600,
      (proc) => {
        if (!resolved) { resolved = true; resolve(proc); }
      },
      (err) => {
        if (!resolved) { resolved = true; reject(err); }
      },
      () => {
        if (!resolved) {
          // WebSocket closed, fall back to polling
          resolved = true;
          pollProcess(processId, targetState).then(resolve).catch(reject);
        }
      }
    );
  });
}

async function pollProcess(processId, targetState) {
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const proc = await chatClient.getProcess(processId);
    if (proc.state === targetState) return proc;
    if (proc.state === 3) throw new Error('Process failed');
  }
  throw new Error('Timeout waiting for process');
}

// Auto-login on page load
(async function() {
  const auth = await loadAuth();
  if (auth && auth.prvKey && auth.serverUrl && auth.colony) {
    try {
      document.getElementById('login-server').value = auth.serverUrl;
      document.getElementById('login-colony').value = auth.colony;
      await connectToColony(auth.serverUrl, auth.colony, auth.prvKey);
      showChat(true);
      addMessage('system', '**Hi, I\'m Dagny** — your building assistant.\nHere are some things I can help with:\n' +
        '`take me to A2306`\n' +
        '`how do I get from A2527 to A2306?`\n' +
        '`mark room A1001 in red`\n' +
        '`clear everything`');
    } catch (e) {
      console.log('Auto-login failed:', e.message);
    }
  }
})();
