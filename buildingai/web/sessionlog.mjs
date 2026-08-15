// ── Colonies session-log envelope parsing ──
// The agentic executor writes durable session-log rows; each row's `message`
// is a JSON envelope {k, ...}. These pure functions parse and fold rows into a
// Turn for the chat UI to render. Mirrors execapp's turns.ts, scoped to the
// single-turn boiler chat. Kept side-effect free so it can be unit-tested.
//
// Envelope kinds:
//   prompt  {text}                         — the user goal
//   think   {iter, text, in, out}          — one reasoning step
//   tool    {text}                         — a tool call
//   sys     {text}                         — a system/tool result
//   answer  {text}                         — the (growing) final answer
//   status  {state: 'running'|'done'|...}  — turn lifecycle
//   energy  {wh, cost, duration_ms}        — telemetry

export function parseEnvelope(message) {
  try {
    const o = JSON.parse(message);
    if (o && typeof o === 'object' && typeof o.k === 'string') return o;
  } catch { /* not an envelope */ }
  return null;
}

export function newTurn() {
  return {
    prompt: '',
    thinking: [],   // [{iter, text, in, out}]
    events: [],     // [{kind:'tool'|'sys', text}]
    reply: '',
    status: 'pending', // 'pending' | 'running' | 'done' | 'error' | 'cancelled'
    tokensIn: 0,
    tokensOut: 0,
    energyWh: 0,
    cost: 0,
  };
}

// Fold one envelope into a turn (mutates and returns it).
export function applyEnvelope(turn, env) {
  switch (env.k) {
    case 'prompt':
      if (env.text != null) turn.prompt = env.text;
      break;
    case 'think':
      turn.thinking.push({
        iter: env.iter ?? turn.thinking.length + 1,
        text: env.text ?? '',
        in: env.in ?? 0,
        out: env.out ?? 0,
      });
      if (env.cin != null) turn.tokensIn = env.cin;
      if (env.cout != null) turn.tokensOut = env.cout;
      break;
    case 'tool':
    case 'sys':
      turn.events.push({ kind: env.k, text: env.text ?? '' });
      break;
    case 'answer':
      turn.reply = env.text ?? '';
      break;
    case 'status':
      if (env.state === 'done') turn.status = 'done';
      else if (env.state === 'error') turn.status = 'error';
      else if (env.state === 'cancelled') turn.status = 'cancelled';
      else if (env.state) turn.status = 'running';
      break;
    case 'energy':
      turn.energyWh += env.wh ?? 0;
      turn.cost += env.cost ?? 0;
      break;
  }
  return turn;
}

// Aggregate session-log rows into a single Turn. Rows are {seq, message,
// workflowid}. If graphId is given, only rows for that workflow are folded.
// Rows are ordered by seq so out-of-order delivery still yields a stable turn.
export function rowsToTurn(rows, graphId) {
  const turn = newTurn();
  const sorted = [...rows].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  for (const row of sorted) {
    if (graphId && row.workflowid && row.workflowid !== graphId) continue;
    const env = parseEnvelope(row.message ?? '');
    if (env) applyEnvelope(turn, env);
  }
  return turn;
}

// Compact a token count for display (1500 → "1.5k").
export function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n | 0);
}
