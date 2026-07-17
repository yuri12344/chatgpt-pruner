/**
 * Relay codex-bridge /process/stream SSE to content script (bypasses page PNA).
 */
const BRIDGE_BASE = 'http://127.0.0.1:8787';
const PORT_NAME = 'bridge-log';

/** @type {AbortController | null} */
let streamAbort = null;
/** @type {string} */
let activeToken = '';

function post(port, msg) {
  try {
    port.postMessage(msg);
  } catch {
    /* ponytail: tab gone */
  }
}

function closeStream() {
  if (streamAbort) {
    streamAbort.abort();
    streamAbort = null;
  }
}

function parseSseChunk(buffer) {
  const events = [];
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() || '';
  for (const block of blocks) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trimStart();
      if (data && data !== 'ping') events.push(data);
    }
  }
  return { events, rest };
}

function linesFromEvent(raw) {
  let ev;
  try {
    ev = JSON.parse(raw);
  } catch {
    return [];
  }
  const payload = ev.payload || {};
  const kind = ev.kind || '';
  const seq = ev.scopeSeq ?? ev.scope_seq ?? 0;
  const tool = ev.toolName || ev.tool || '';

  if (kind === 'command_started') {
    const argv = payload.argv;
    const cmd = Array.isArray(argv) ? argv.join(' ') : tool || 'command';
    return [{ type: 'line', text: `$ ${cmd}`, kind: 'cmd', seq, tool }];
  }
  if (kind === 'command_finished') {
    const code = payload.exitCode ?? payload.exit_code ?? '?';
    return [{ type: 'line', text: `[finished exit ${code}]`, kind: 'meta', seq, tool }];
  }
  if (kind === 'output_chunk') {
    const out = [];
    const stdout = payload.stdoutChunk ?? payload.stdout ?? '';
    const stderr = payload.stderrChunk ?? payload.stderr ?? '';
    if (stdout) out.push({ type: 'line', text: stdout, kind: 'stdout', seq, tool });
    if (stderr) out.push({ type: 'line', text: stderr, kind: 'stderr', seq, tool });
    if (payload.finished && !stdout && !stderr) {
      out.push({ type: 'line', text: '[process finished]', kind: 'meta', seq, tool });
    }
    return out;
  }
  return [];
}

async function bindThread(threadId, viewToken) {
  if (!threadId || !viewToken) return;
  try {
    await fetch(`${BRIDGE_BASE}/threads/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId, viewToken }),
    });
  } catch {
    /* ponytail: harness may be down */
  }
}

async function openStream(viewToken, threadId, port) {
  closeStream();
  activeToken = viewToken;
  const ac = new AbortController();
  streamAbort = ac;
  const url = `${BRIDGE_BASE}/process/stream?viewToken=${encodeURIComponent(viewToken)}`;

  post(port, { type: 'status', state: 'connecting', message: 'connecting…' });

  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok || !res.body) {
      post(port, {
        type: 'status',
        state: 'error',
        message: res.ok ? 'no stream body' : `bridge ${res.status}`,
      });
      return;
    }
    post(port, { type: 'status', state: 'listening', message: 'listening' });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (!ac.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseChunk(buffer);
      buffer = parsed.rest;
      for (const raw of parsed.events) {
        for (const line of linesFromEvent(raw)) {
          post(port, line);
        }
      }
    }
    if (!ac.signal.aborted) {
      post(port, { type: 'status', state: 'error', message: 'stream ended' });
    }
  } catch (err) {
    if (ac.signal.aborted) return;
    const msg = err?.message || String(err);
    post(port, {
      type: 'status',
      state: 'error',
      message: /fetch|network|failed/i.test(msg) ? 'bridge offline' : msg,
    });
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'close') {
      closeStream();
      activeToken = '';
      return;
    }
    if (msg.type === 'setToken' && msg.viewToken) {
      const tok = String(msg.viewToken);
      const threadId = msg.threadId ? String(msg.threadId) : '';
      if (tok === activeToken && streamAbort) return;
      void bindThread(threadId, tok);
      void openStream(tok, threadId, port);
    }
  });

  port.onDisconnect.addListener(() => {
    if (streamAbort) {
      closeStream();
      activeToken = '';
    }
  });
});
