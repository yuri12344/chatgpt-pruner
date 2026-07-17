/**
 * SSE stream deduplicator + telemetry blocker.
 *
 * This version processes the stream in small slices and performs aggressive
 * squash-by-key on JSON events before enqueueing to React.
 */
(() => {
  if (window.__chatPrunerDeduplicatorActive) return;
  window.__chatPrunerDeduplicatorActive = true;

  const TUNING_PRESETS = {
    stable: {
      FLUSH_INTERVAL: 200,
      PROCESS_BUDGET_MS: 4,
      MAX_EVENTS_PER_TICK: 64,
      MAX_EVENTS_PER_EMIT: 6,
      MAX_EMIT_BYTES: 9000,
      STARTUP_SAFE_MS: 14000,
      STARTUP_MAX_EVENTS_PER_EMIT: 1,
      STARTUP_MAX_EMIT_BYTES: 2600,
      MIN_COOLDOWN_MS: 140,
      MAX_COOLDOWN_MS: 3500,
      COOLDOWN_FACTOR: 1.6,
      FAST_RENDER_THRESHOLD_MS: 180,
      FAST_MIN_COOLDOWN_MS: 90,
      FAST_COOLDOWN_FACTOR: 1.0,
      ASSISTANT_MIN_GROWTH: 700,
      ASSISTANT_MAX_HOLD_MS: 8000,
    },
    balanced: {
      FLUSH_INTERVAL: 180,
      PROCESS_BUDGET_MS: 4,
      MAX_EVENTS_PER_TICK: 64,
      MAX_EVENTS_PER_EMIT: 8,
      MAX_EMIT_BYTES: 12000,
      STARTUP_SAFE_MS: 12000,
      STARTUP_MAX_EVENTS_PER_EMIT: 2,
      STARTUP_MAX_EMIT_BYTES: 3500,
      MIN_COOLDOWN_MS: 120,
      MAX_COOLDOWN_MS: 3500,
      COOLDOWN_FACTOR: 1.5,
      FAST_RENDER_THRESHOLD_MS: 220,
      FAST_MIN_COOLDOWN_MS: 70,
      FAST_COOLDOWN_FACTOR: 0.9,
      ASSISTANT_MIN_GROWTH: 600,
      ASSISTANT_MAX_HOLD_MS: 7000,
    },
    snappy: {
      FLUSH_INTERVAL: 150,
      PROCESS_BUDGET_MS: 5,
      MAX_EVENTS_PER_TICK: 80,
      MAX_EVENTS_PER_EMIT: 10,
      MAX_EMIT_BYTES: 15000,
      STARTUP_SAFE_MS: 9000,
      STARTUP_MAX_EVENTS_PER_EMIT: 2,
      STARTUP_MAX_EMIT_BYTES: 4200,
      MIN_COOLDOWN_MS: 90,
      MAX_COOLDOWN_MS: 3200,
      COOLDOWN_FACTOR: 1.35,
      FAST_RENDER_THRESHOLD_MS: 260,
      FAST_MIN_COOLDOWN_MS: 55,
      FAST_COOLDOWN_FACTOR: 0.75,
      ASSISTANT_MIN_GROWTH: 500,
      ASSISTANT_MAX_HOLD_MS: 6000,
    },
  };

  const PRESET_STORAGE_KEY = 'chatpruner:tuning-preset';
  function readStoredPreset() {
    try {
      const value = (localStorage.getItem(PRESET_STORAGE_KEY) || '').trim().toLowerCase();
      if (value && Object.prototype.hasOwnProperty.call(TUNING_PRESETS, value)) return value;
    } catch { }
    return 'balanced';
  }

  const ACTIVE_TUNING = readStoredPreset();
  const TUNING = TUNING_PRESETS[ACTIVE_TUNING] || TUNING_PRESETS.balanced;
  window.__chatPrunerAvailableTunings = Object.keys(TUNING_PRESETS);
  window.__chatPrunerActiveTuning = ACTIVE_TUNING;
  const {
    FLUSH_INTERVAL,
    PROCESS_BUDGET_MS,
    MAX_EVENTS_PER_TICK,
    MAX_EVENTS_PER_EMIT,
    MAX_EMIT_BYTES,
    STARTUP_SAFE_MS,
    STARTUP_MAX_EVENTS_PER_EMIT,
    STARTUP_MAX_EMIT_BYTES,
    MIN_COOLDOWN_MS,
    MAX_COOLDOWN_MS,
    COOLDOWN_FACTOR,
    FAST_RENDER_THRESHOLD_MS,
    FAST_MIN_COOLDOWN_MS,
    FAST_COOLDOWN_FACTOR,
    ASSISTANT_MIN_GROWTH,
    ASSISTANT_MAX_HOLD_MS,
  } = TUNING;
  const CONV_URL = '/backend-api/f/conversation';
  const DEBUG_MODE = (() => {
    try { return localStorage.getItem('chatpruner:debug') === '1'; } catch { return false; }
  })();
  const HEAVY_STATS_INTERVAL_MS = 2000;
  const MAX_PENDING_HOLD_MS = 420;
  const MAX_ASSISTANT_DELAY_MS = 900;
  const logDebug = (...args) => { if (DEBUG_MODE) console.log(...args); };
  let uiBoostUntil = 0;

  document.addEventListener('chatpruner:ui-interaction', () => {
    uiBoostUntil = performance.now() + 1200;
  });

  const BLOCK_PATTERNS = [
    '/ces/v1/t', '/ces/v1/m', '/ces/v1/i', '/ces/v1/p', '/ces/statsc/',
    '/ces/v1/telemetry/', '/backend-api/lat/',
    'ab.chatgpt.com/v1/rgstr', 'dd-api-key=', 'ddforward='
  ];

  function shouldBlock(url) {
    if (!url) return false;
    for (const p of BLOCK_PATTERNS) if (url.includes(p)) return true;
    return false;
  }

  function fakeOk() {
    return Promise.resolve(new Response('{}', {
      status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' }
    }));
  }

  function parseSseEnvelope(eventText) {
    const out = {
      eventName: '',
      dataPayload: null,
      isDone: false,
      parsedJson: null,
    };

    if (!eventText) return out;

    const lines = eventText.split(/\r?\n/);
    const chunks = [];
    for (const line of lines) {
      if (line.startsWith('event:')) {
        out.eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        chunks.push(line.slice(5).trimStart());
      }
    }

    if (chunks.length === 0) return out;

    out.dataPayload = chunks.join('\n').trim();
    if (out.dataPayload === '[DONE]') {
      out.isDone = true;
      return out;
    }

    const first = out.dataPayload[0];
    if (first === '{' || first === '[' || first === '"') {
      try { out.parsedJson = JSON.parse(out.dataPayload); } catch { }
    }

    return out;
  }

  function growthThresholdForLen(textLen) {
    if (textLen > 20000) return 4500;
    if (textLen > 12000) return 2500;
    if (textLen > 6000) return 1200;
    return ASSISTANT_MIN_GROWTH;
  }

  function holdWindowForLen(textLen) {
    if (textLen > 20000) return ASSISTANT_MAX_HOLD_MS;
    if (textLen > 12000) return 4500;
    return 1800;
  }

  function bumpCount(map, key, inc = 1) {
    const k = key == null || key === '' ? '(empty)' : key;
    map.set(k, (map.get(k) || 0) + inc);
  }

  function topCounts(map, limit = 8) {
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([key, count]) => ({ key, count }));
  }

  function hasOwn(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  function normalizePatchCandidate(node) {
    if (!node || typeof node !== 'object') return null;

    const op = typeof node.o === 'string'
      ? node.o
      : (typeof node.op === 'string' ? node.op : '');
    const path = typeof node.p === 'string'
      ? node.p
      : (typeof node.path === 'string' ? node.path : '');

    let hasValue = false;
    let value = null;
    if (hasOwn(node, 'v')) {
      hasValue = true;
      value = node.v;
    } else if (hasOwn(node, 'value')) {
      hasValue = true;
      value = node.value;
    }

    if (!op && !path && !hasValue) return null;

    return { op, path, hasValue, value };
  }

  function findPatchCandidate(parsed) {
    const direct = normalizePatchCandidate(parsed);
    if (direct) return direct;

    if (!parsed || typeof parsed !== 'object') return null;
    if (Array.isArray(parsed)) {
      if (parsed.length === 1) return normalizePatchCandidate(parsed[0]);
      return null;
    }

    return (
      normalizePatchCandidate(parsed.delta) ||
      normalizePatchCandidate(parsed.patch) ||
      normalizePatchCandidate(parsed.payload) ||
      (Array.isArray(parsed.ops) && parsed.ops.length === 1 ? normalizePatchCandidate(parsed.ops[0]) : null)
    );
  }

  function extractMsgIdFromPatchPath(path) {
    if (!path) return null;
    const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const candidates = [
      path.match(/\/mapping\/([^/]+)/),
      path.match(/\/messages\/([^/]+)/),
      path.match(/\/message\/([^/]+)/),
    ];
    for (const match of candidates) {
      const value = match?.[1] || '';
      if (uuidLike.test(value)) return value;
    }
    return null;
  }

  function isContentPath(path) {
    if (!path) return false;
    return (
      path.includes('/message/content') ||
      path.includes('/content/parts') ||
      path.includes('/output_text') ||
      path.includes('/text') ||
      path.includes('/thinking') ||
      path.includes('/reasoning')
    );
  }

  function isTerminalPath(path) {
    if (!path) return false;
    return (
      path.includes('/message/status') ||
      path.includes('/message/end_turn') ||
      path.includes('/status') ||
      path.includes('/end_turn') ||
      path.includes('/finished')
    );
  }

  function collectPatchOps(value, out = [], depth = 0) {
    if (depth > 3 || value == null) return out;
    if (Array.isArray(value)) {
      for (const item of value) collectPatchOps(item, out, depth + 1);
      return out;
    }
    if (typeof value !== 'object') return out;

    const op = typeof value.o === 'string' ? value.o : (typeof value.op === 'string' ? value.op : '');
    const path = typeof value.p === 'string' ? value.p : (typeof value.path === 'string' ? value.path : '');
    const hasV = hasOwn(value, 'v') || hasOwn(value, 'value');
    const v = hasOwn(value, 'v') ? value.v : (hasOwn(value, 'value') ? value.value : null);
    if (op || path || hasV) {
      out.push({ op, path, value: v });
    }

    if (value.delta != null) collectPatchOps(value.delta, out, depth + 1);
    if (value.patch != null) collectPatchOps(value.patch, out, depth + 1);
    if (value.payload != null) collectPatchOps(value.payload, out, depth + 1);
    if (value.ops != null) collectPatchOps(value.ops, out, depth + 1);
    return out;
  }

  function classifyJsonEvent(eventText) {
    const env = parseSseEnvelope(eventText);
    const signature = `${eventText.length}:${eventText.slice(-96)}`;

    if (env.isDone) {
      return {
        key: 'sse:done',
        kind: 'done',
        msgId: null,
        textLen: -1,
        eventType: null,
        eventName: env.eventName || 'done',
        hasContent: false,
        orderSensitive: false,
        signature,
      };
    }

    if (!env.parsedJson) {
      if (env.dataPayload == null) return null;
      if ((env.eventName || '') === 'delta') {
        return {
          key: `delta:text:${signature}`,
          kind: 'delta_generic',
          msgId: null,
          textLen: -1,
          eventType: null,
          eventName: 'delta',
          hasContent: false,
          orderSensitive: false,
          patchOp: null,
          patchPath: null,
          isRelevant: false,
          signature,
        };
      }
      return {
        key: `event:${env.eventName || 'data'}`,
        kind: 'event_text',
        msgId: null,
        textLen: -1,
        eventType: null,
        eventName: env.eventName || 'data',
        hasContent: false,
        orderSensitive: false,
        signature,
      };
    }

    const parsed = env.parsedJson;
    const eventName = env.eventName || '';

    if (!parsed || typeof parsed !== 'object') {
      return {
        key: `event:${eventName || 'data'}`,
        kind: 'event_text',
        msgId: null,
        textLen: -1,
        eventType: null,
        eventName: eventName || 'data',
        hasContent: false,
        orderSensitive: false,
        patchOp: null,
        patchPath: null,
        signature,
      };
    }

    const patch = findPatchCandidate(parsed);

    // OpenAI delta stream can arrive as JSON patch operations.
    // Some ops are order-sensitive (append-like) and must not be squashed.
    if (patch) {
      const patchOp = patch.op || '';
      const patchPath = patch.path || '';
      const patchValue = patch.hasValue ? patch.value : null;
      const nestedOps = collectPatchOps(patchValue);
      const patchMsg = patchValue?.message;
      const patchMsgId = typeof patchMsg?.id === 'string'
        ? patchMsg.id
        : extractMsgIdFromPatchPath(patchPath);
      const patchRole = patchMsg?.author?.role;
      const patchText = patchMsg?.content?.parts?.[0];
      const patchTextLen = typeof patchText === 'string' ? patchText.length : -1;
      const nestedContentOps = nestedOps.filter(x => isContentPath(x.path));
      const nestedTerminalOps = nestedOps.filter(x => isTerminalPath(x.path));
      const nestedContentOp = nestedContentOps[0] || null;
      const derivedPath = patchPath || (nestedContentOp ? nestedContentOp.path : '');
      const derivedOp = patchOp || (nestedContentOp ? nestedContentOp.op : '');
      const opLower = (derivedOp || '').toLowerCase();
      const hasTerminal = nestedTerminalOps.length > 0 || isTerminalPath(derivedPath);
      const patchHasContent =
        patchTextLen > 0 ||
        isContentPath(derivedPath) ||
        (typeof patchValue === 'string' && patchValue.length > 0 && isContentPath(derivedPath)) ||
        nestedContentOps.length > 0;
      const isRelevant = patchHasContent || hasTerminal || !!patchMsgId || eventName === 'delta';
      const orderSensitive =
        eventName === 'delta' ||
        opLower === 'append' ||
        opLower === 'insert' ||
        opLower === 'splice' ||
        derivedPath.endsWith('/-') ||
        derivedPath.includes('/-/');
      const appendText =
        opLower === 'append' &&
        typeof patchValue === 'string' &&
        isContentPath(derivedPath)
          ? patchValue
          : null;
      const appendMergeKey = appendText != null
        ? `append:${patchMsgId || 'unknown'}:${derivedPath || 'root'}`
        : null;
      const stablePatchKey = patchMsgId
        ? `delta:${derivedOp || 'op'}:${derivedPath || 'root'}:msg:${patchMsgId}`
        : `delta:${derivedOp || 'op'}:${derivedPath || 'root'}`;
      const patchKey = orderSensitive
        ? `${stablePatchKey}:sig:${signature}`
        : stablePatchKey;

      let patchKind = 'delta_patch';
      if (patchMsgId) {
        if (patchRole === 'tool') patchKind = 'tool_msg';
        else if (patchRole == null || patchRole === 'assistant') patchKind = 'assistant_msg';
        else patchKind = 'message';
      }

      return {
        key: patchKey,
        kind: patchKind,
        msgId: patchMsgId,
        textLen: patchTextLen,
        eventType: null,
        eventName,
        hasContent: patchHasContent || hasTerminal,
        orderSensitive,
        patchOp: derivedOp || null,
        patchPath: derivedPath || null,
        isRelevant,
        appendText,
        appendMergeKey,
        signature,
      };
    }

    // If transport says this is a delta but we couldn't parse it into a known
    // schema, treat it as order-sensitive and unique to avoid corrupting state.
    if (eventName === 'delta') {
      return {
        key: `delta:raw:${signature}`,
        kind: 'delta_generic',
        msgId: null,
        textLen: -1,
        eventType: null,
        eventName,
        hasContent: true,
        orderSensitive: true,
        patchOp: null,
        patchPath: null,
        isRelevant: true,
        appendText: null,
        appendMergeKey: null,
        signature,
      };
    }

    const msg = parsed?.message;
    const msgId = typeof msg?.id === 'string' ? msg.id : null;
    const role = msg?.author?.role;
    const text = msg?.content?.parts?.[0];
    const textLen = typeof text === 'string' ? text.length : -1;
    const eventType = typeof parsed?.type === 'string' ? parsed.type : null;

    if (msgId) {
      const isAssistant = role == null || role === 'assistant';
      const isTool = role === 'tool';
      const hasContent = textLen >= 0;
      return {
        key: `msg:${msgId}`,
        kind: isAssistant ? 'assistant_msg' : (isTool ? 'tool_msg' : 'message'),
        msgId,
        textLen,
        eventType,
        eventName,
        hasContent,
        orderSensitive: false,
        patchOp: null,
        patchPath: null,
        isRelevant: hasContent,
        appendText: null,
        appendMergeKey: null,
        signature,
      };
    }

    if (eventType) {
      const t = eventType.toLowerCase();
      const isLikelyControl =
        t.includes('resume') ||
        t.includes('input_message') ||
        t.includes('heartbeat') ||
        t.includes('ping') ||
        t.includes('telemetry') ||
        t.includes('latency') ||
        t.includes('status') ||
        t.includes('trace') ||
        t.includes('ack') ||
        t.includes('conduit');
      const hasStructuredContent = !!(
        parsed?.delta ||
        parsed?.text ||
        parsed?.content ||
        parsed?.output_text ||
        parsed?.message_delta ||
        parsed?.message?.content ||
        parsed?.output?.length
      );
      const hasContent = hasStructuredContent || (!isLikelyControl && t.length > 0);
      return {
        key: `type:${eventType}`,
        kind: 'type',
        msgId: null,
        textLen: -1,
        eventType,
        eventName,
        hasContent,
        orderSensitive: false,
        patchOp: null,
        patchPath: null,
        isRelevant: hasContent,
        appendText: null,
        appendMergeKey: null,
        signature,
      };
    }

    return {
      key: 'json:generic',
      kind: 'json',
      msgId: null,
      textLen: -1,
      eventType: null,
      eventName,
      hasContent: true,
      orderSensitive: false,
      patchOp: null,
      patchPath: null,
      isRelevant: true,
      appendText: null,
      appendMergeKey: null,
      signature,
    };
  }

  function shouldForwardMeta(meta) {
    if (!meta) return true;
    if (meta.kind === 'done') return true;
    if (meta.kind === 'event_text') return meta.eventName === 'delta_encoding';
    if (
      meta.kind === 'assistant_msg' ||
      meta.kind === 'tool_msg' ||
      meta.kind === 'message' ||
      meta.kind === 'json'
    ) return true;
    if (meta.kind === 'delta_patch' || meta.kind === 'delta_generic') {
      return !!meta.isRelevant;
    }
    if (meta.kind === 'type') {
      if (meta.hasContent) return true;
      const t = (meta.eventType || '').toLowerCase();
      return t.includes('complete') || t.includes('finish') || t.includes('final') || t.includes('done') || t.includes('error') || t.includes('failed');
    }
    return false;
  }

  // ─── Interceptor with deduplication ───
  // ponytail: DOM prune lives only in content.js (duplicate stream-side prune fought Keep=20)
  const originalFetch = window.fetch;

  window.fetch = function (...args) {
    const [resource] = args;
    const url = typeof resource === 'string' ? resource : resource?.url || '';

    if (shouldBlock(url)) return fakeOk();

    if (!url.includes(CONV_URL) || url.includes('/prepare')) {
      return originalFetch.apply(this, args);
    }

    logDebug('[ChatPruner] 🔧 Stream intercepted — anti-freeze deduplicator enabled');
    return originalFetch.apply(this, args).then(response => {
      if (!response.ok || !response.body) return response;

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      const encoder = new TextEncoder();

      let controller;
      let streamClosed = false;
      let streamDone = false;
      let processing = false;
      let flushTimer = null;
      let scheduledDelay = null;

      let textBuffer = '';
      let rawEvents = [];
      let rawReadIndex = 0;
      let pendingEvents = [];
      let pendingMetas = [];
      let pendingSinceAt = 0;
      const pendingIndexesByKey = new Map();
      const pendingAppendIndexesByKey = new Map();

      let nextEmitAt = performance.now() + FLUSH_INTERVAL;
      let totalDropped = 0;
      let droppedInBatch = 0;
      let batchCount = 0;
      let waitingRenderCooldown = false;
      let lastRenderCostMs = 0;
      let lastCooldownMs = FLUSH_INTERVAL;
      const sampleRawEvents = [];
      const sampleClassified = [];
      const lastForwardedSignatureByKey = new Map();
      const lastForwardedAssistantLenById = new Map();
      let lastAssistantForwardAt = 0;
      let lastContentCandidateEvent = null;
      let lastContentCandidateSignature = '';
      let lastForwardedContentSignature = '';
      const streamOpenedAt = performance.now();
      let adaptiveMaxEventsPerEmit = MAX_EVENTS_PER_EMIT;
      let adaptiveMaxEmitBytes = MAX_EMIT_BYTES;
      let adaptiveStableBatches = 0;

      const rawEventNameCounts = new Map();
      const classifiedKindCounts = new Map();
      const classifiedKeyCounts = new Map();
      const droppedByKeyCounts = new Map();
      const patchPathCounts = new Map();
      let rawEventTotal = 0;

      function closeStream() {
        if (streamClosed) return;
        streamClosed = true;
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
          scheduledDelay = null;
        }
        try { controller.close(); } catch { }
      }

      let lastHeavyStatsAt = 0;
      function publishStats(forceHeavy = false) {
        const streamAgeMs = performance.now() - streamOpenedAt;
        const startupSafeActive = streamAgeMs < STARTUP_SAFE_MS;
        const baseStats = {
          backlogEvents: rawEvents.length - rawReadIndex,
          pendingEvents: pendingEvents.length,
          waitingRenderCooldown,
          lastRenderCostMs: Math.round(lastRenderCostMs),
          lastCooldownMs: Math.round(lastCooldownMs),
          totalDropped,
          batches: batchCount,
          streamDone,
          trackedAssistantMsgs: lastForwardedAssistantLenById.size,
          lastContentSeen: !!lastContentCandidateEvent,
          rawEventTotal,
          adaptiveMaxEventsPerEmit,
          adaptiveMaxEmitBytes,
          startupSafeActive,
          streamAgeMs: Math.round(streamAgeMs),
        };

        if (!DEBUG_MODE) {
          window.__chatPrunerStreamStats = baseStats;
          return;
        }

        const now = performance.now();
        const includeHeavy = forceHeavy || (now - lastHeavyStatsAt >= HEAVY_STATS_INTERVAL_MS);
        if (!includeHeavy) {
          window.__chatPrunerStreamStats = baseStats;
          return;
        }

        lastHeavyStatsAt = now;
        window.__chatPrunerStreamStats = {
          ...baseStats,
          sampleRawEvents,
          sampleClassified,
          topEventNames: topCounts(rawEventNameCounts, 10),
          topKinds: topCounts(classifiedKindCounts, 10),
          topKeys: topCounts(classifiedKeyCounts, 10),
          topDroppedKeys: topCounts(droppedByKeyCounts, 10),
          topPatchPaths: topCounts(patchPathCounts, 10),
        };
      }

      function scheduleProcess(delay = 0) {
        const nextDelay = Math.max(0, Math.floor(delay));
        if (flushTimer !== null) {
          if (scheduledDelay !== null && nextDelay < scheduledDelay) {
            clearTimeout(flushTimer);
            flushTimer = null;
          } else {
            return;
          }
        }

        scheduledDelay = nextDelay;
        flushTimer = setTimeout(() => {
          flushTimer = null;
          scheduledDelay = null;
          processQueue(false);
        }, nextDelay);
      }

      function enqueueRawEvent(eventText) {
        if (!eventText) return;
        rawEventTotal++;
        if (DEBUG_MODE && sampleRawEvents.length < 3) {
          sampleRawEvents.push(eventText.slice(0, 320));
        }
        rawEvents.push(eventText);
      }

      function compactRawQueue() {
        if (rawReadIndex < 2048) return;
        if (rawReadIndex < Math.floor(rawEvents.length / 2)) return;
        rawEvents = rawEvents.slice(rawReadIndex);
        rawReadIndex = 0;
      }

      function rebuildPendingIndexes() {
        pendingIndexesByKey.clear();
        pendingAppendIndexesByKey.clear();
        for (let i = 0; i < pendingMetas.length; i++) {
          const meta = pendingMetas[i];
          if (!meta) continue;
          if (!meta.orderSensitive && meta.key) {
            pendingIndexesByKey.set(meta.key, i);
          }
          if (meta.appendMergeKey) {
            pendingAppendIndexesByKey.set(meta.appendMergeKey, i);
          }
        }
      }

      function tryMergeAdjacentAppend(existingEvent, incomingEvent, existingMeta, incomingMeta) {
        if (!existingMeta || !incomingMeta) return null;
        if (!existingMeta.appendMergeKey || existingMeta.appendMergeKey !== incomingMeta.appendMergeKey) return null;
        if (typeof existingMeta.appendText !== 'string' || typeof incomingMeta.appendText !== 'string') return null;

        const env = parseSseEnvelope(existingEvent);
        if (!env.parsedJson) return null;
        const patch = findPatchCandidate(env.parsedJson);
        if (!patch) return null;

        const mergedText = existingMeta.appendText + incomingMeta.appendText;
        if (hasOwn(env.parsedJson, 'v')) {
          env.parsedJson.v = mergedText;
        } else if (hasOwn(env.parsedJson, 'value')) {
          env.parsedJson.value = mergedText;
        } else if (patch.value != null && typeof patch.value === 'object') {
          if (hasOwn(patch.value, 'v')) patch.value.v = mergedText;
          if (hasOwn(patch.value, 'value')) patch.value.value = mergedText;
        } else {
          return null;
        }

        const eventLine = incomingMeta.eventName ? `event: ${incomingMeta.eventName}\n` : '';
        const rebuilt = `${eventLine}data: ${JSON.stringify(env.parsedJson)}`;
        const rebuiltMeta = classifyJsonEvent(rebuilt);
        if (!rebuiltMeta) return null;
        rebuiltMeta.appendText = mergedText;
        rebuiltMeta.appendMergeKey = incomingMeta.appendMergeKey;
        return { eventText: rebuilt, meta: rebuiltMeta };
      }

      function ingestEvent(eventText) {
        const meta = classifyJsonEvent(eventText);
        if (!meta) {
          pendingEvents.push(eventText);
          pendingMetas.push(null);
          if (pendingSinceAt === 0) pendingSinceAt = performance.now();
          return;
        }
        if (DEBUG_MODE && sampleClassified.length < 20) {
          sampleClassified.push({
            key: meta.key,
            kind: meta.kind,
            eventType: meta.eventType || null,
            eventName: meta.eventName || null,
            hasContent: !!meta.hasContent,
            textLen: meta.textLen,
            orderSensitive: !!meta.orderSensitive,
            patchOp: meta.patchOp || null,
            patchPath: meta.patchPath || null,
          });
        }

        if (DEBUG_MODE) {
          bumpCount(rawEventNameCounts, meta.eventName || '(none)');
          bumpCount(classifiedKindCounts, meta.kind || '(none)');
          bumpCount(classifiedKeyCounts, meta.key || '(none)');
          if (meta.patchPath) {
            bumpCount(
              patchPathCounts,
              `${meta.patchOp || 'op'} ${meta.patchPath}`
            );
          }
        }

        if (meta.hasContent) {
          lastContentCandidateEvent = eventText;
          lastContentCandidateSignature = meta.signature || '';
        }

        if (!shouldForwardMeta(meta)) {
          droppedInBatch++;
          totalDropped++;
          if (DEBUG_MODE) bumpCount(droppedByKeyCounts, meta.key || '(none)');
          return;
        }

        if (meta.orderSensitive) {
          if (meta.appendMergeKey) {
            const prevIndex = pendingAppendIndexesByKey.get(meta.appendMergeKey);
            const isAdjacent = prevIndex !== undefined && prevIndex === (pendingEvents.length - 1);
            if (isAdjacent) {
              const merged = tryMergeAdjacentAppend(
                pendingEvents[prevIndex],
                eventText,
                pendingMetas[prevIndex],
                meta
              );
              if (merged) {
                pendingEvents[prevIndex] = merged.eventText;
                pendingMetas[prevIndex] = merged.meta;
                droppedInBatch++;
                totalDropped++;
                if (DEBUG_MODE) bumpCount(droppedByKeyCounts, meta.key || '(none)');
                return;
              }
            }
          }
          pendingEvents.push(eventText);
          pendingMetas.push(meta);
          if (pendingSinceAt === 0) pendingSinceAt = performance.now();
          if (meta.appendMergeKey) {
            pendingAppendIndexesByKey.set(meta.appendMergeKey, pendingEvents.length - 1);
          }
          return;
        }

        const lastForwardedSig = lastForwardedSignatureByKey.get(meta.key);
        if (lastForwardedSig && lastForwardedSig === meta.signature) {
          droppedInBatch++;
          totalDropped++;
          if (DEBUG_MODE) bumpCount(droppedByKeyCounts, meta.key || '(none)');
          return;
        }

        const existingIndex = pendingIndexesByKey.get(meta.key);
        if (existingIndex === undefined) {
          pendingEvents.push(eventText);
          pendingMetas.push(meta);
          if (pendingSinceAt === 0) pendingSinceAt = performance.now();
          pendingIndexesByKey.set(meta.key, pendingEvents.length - 1);
          return;
        }

        pendingEvents[existingIndex] = eventText;
        pendingMetas[existingIndex] = meta;
        droppedInBatch++;
        totalDropped++;
        if (DEBUG_MODE) bumpCount(droppedByKeyCounts, meta.key || '(none)');
      }

      function shrinkPendingBeforeEmit(force) {
        const maxForward = force ? 64 : 24;
        if (pendingEvents.length <= maxForward) return;
        if (pendingMetas.some(meta => meta && meta.orderSensitive)) return;

        const keep = [];
        for (let i = 0; i < pendingEvents.length; i++) {
          const meta = pendingMetas[i];
          if (!meta) continue;
          if (meta.kind === 'assistant_msg' || meta.kind === 'tool_msg' || meta.kind === 'done') keep.push(i);
        }

        if (keep.length === 0) {
          const start = Math.max(0, pendingEvents.length - maxForward);
          for (let i = start; i < pendingEvents.length; i++) keep.push(i);
        } else if (keep.length > maxForward) {
          keep.splice(0, keep.length - maxForward);
        }

        const keepSet = new Set(keep);
        const nextEvents = [];
        const nextMetas = [];
        for (let i = 0; i < pendingEvents.length; i++) {
          if (!keepSet.has(i)) continue;
          nextEvents.push(pendingEvents[i]);
          nextMetas.push(pendingMetas[i]);
        }

        const removed = pendingEvents.length - nextEvents.length;
        if (removed > 0) {
          droppedInBatch += removed;
          totalDropped += removed;
        }

        pendingEvents = nextEvents;
        pendingMetas = nextMetas;
        if (pendingEvents.length === 0) pendingSinceAt = 0;
      }

      function emitPending(force = false) {
        if (pendingEvents.length === 0) {
          pendingSinceAt = 0;
          return;
        }

        const now = performance.now();
        const pendingForMs = pendingSinceAt > 0 ? now - pendingSinceAt : 0;
        const forceByLatency = !force && pendingForMs >= MAX_PENDING_HOLD_MS;

        if (waitingRenderCooldown && !forceByLatency) return;
        if (!force && !forceByLatency && now < nextEmitAt) return;

        if (!force) {
          const assistantMetas = [];
          let onlyAssistant = pendingMetas.length > 0;
          for (const meta of pendingMetas) {
            if (!meta || meta.kind !== 'assistant_msg') {
              onlyAssistant = false;
              break;
            }
            assistantMetas.push(meta);
          }

          if (onlyAssistant && assistantMetas.length > 0) {
            const now = performance.now();
            let shouldDelay = true;
            let minWait = 600;

            for (const meta of assistantMetas) {
              const prevLen = lastForwardedAssistantLenById.get(meta.msgId) || 0;
              const growth = meta.textLen > 0 ? meta.textLen - prevLen : Number.MAX_SAFE_INTEGER;
              const needGrowth = growthThresholdForLen(meta.textLen);
              const holdMs = holdWindowForLen(meta.textLen);
              const elapsed = now - lastAssistantForwardAt;

              if (growth >= needGrowth || elapsed >= holdMs || growth < 0) {
                shouldDelay = false;
                break;
              }

              minWait = Math.min(minWait, Math.max(80, holdMs - elapsed));
            }

            if (shouldDelay) {
              if (pendingForMs >= MAX_ASSISTANT_DELAY_MS) {
                shouldDelay = false;
              } else {
                scheduleProcess(Math.min(minWait, MAX_ASSISTANT_DELAY_MS));
                publishStats();
                return;
              }
            }
          }
        }

        shrinkPendingBeforeEmit(force);

        const streamAgeMs = performance.now() - streamOpenedAt;
        const startupSafeActive = streamAgeMs < STARTUP_SAFE_MS;
        const uiBoostActive = performance.now() < uiBoostUntil;
        let cappedMaxEvents = Math.min(
          adaptiveMaxEventsPerEmit,
          startupSafeActive ? STARTUP_MAX_EVENTS_PER_EMIT : MAX_EVENTS_PER_EMIT
        );
        let cappedMaxBytes = Math.min(
          adaptiveMaxEmitBytes,
          startupSafeActive ? STARTUP_MAX_EMIT_BYTES : MAX_EMIT_BYTES
        );
        if (uiBoostActive) {
          cappedMaxEvents = Math.min(cappedMaxEvents, 1);
          cappedMaxBytes = Math.min(cappedMaxBytes, 1400);
        }

        let emitCount = Math.min(cappedMaxEvents, pendingEvents.length);
        let bytes = 0;
        let chosen = 0;
        for (let i = 0; i < emitCount; i++) {
          const nextBytes = pendingEvents[i].length + 2;
          if (i > 0 && (bytes + nextBytes) > cappedMaxBytes) break;
          bytes += nextBytes;
          chosen = i + 1;
        }
        if (chosen > 0) emitCount = chosen;

        const emittedEvents = pendingEvents.slice(0, emitCount);
        const emittedMetas = pendingMetas.slice(0, emitCount);
        const mergedText = emittedEvents.join('\n\n') + '\n\n';
        pendingEvents = pendingEvents.slice(emitCount);
        pendingMetas = pendingMetas.slice(emitCount);
        if (pendingEvents.length === 0) pendingSinceAt = 0;
        rebuildPendingIndexes();
        batchCount++;
        waitingRenderCooldown = true;

        const enqueueAt = performance.now();
        try { controller.enqueue(encoder.encode(mergedText)); } catch { }

        let released = false;
        const releaseCooldown = (measuredCost) => {
          if (released || streamClosed) return;
          released = true;
          const safeCost = Math.max(16, measuredCost || 0);
          lastRenderCostMs = safeCost;
          if (safeCost <= FAST_RENDER_THRESHOLD_MS) {
            lastCooldownMs = Math.max(
              FAST_MIN_COOLDOWN_MS,
              Math.min(safeCost * FAST_COOLDOWN_FACTOR, 260)
            );
          } else {
            lastCooldownMs = Math.max(MIN_COOLDOWN_MS, Math.min(safeCost * COOLDOWN_FACTOR, MAX_COOLDOWN_MS));
          }
          if (safeCost > 1200) {
            adaptiveMaxEventsPerEmit = 1;
            adaptiveMaxEmitBytes = 1800;
            adaptiveStableBatches = 0;
          } else if (safeCost > 700) {
            adaptiveMaxEventsPerEmit = Math.max(1, Math.floor(adaptiveMaxEventsPerEmit / 2));
            adaptiveMaxEmitBytes = Math.max(2200, Math.floor(adaptiveMaxEmitBytes * 0.65));
            adaptiveStableBatches = 0;
          } else if (safeCost > 320) {
            adaptiveMaxEventsPerEmit = Math.max(1, adaptiveMaxEventsPerEmit - 1);
            adaptiveMaxEmitBytes = Math.max(2500, adaptiveMaxEmitBytes - 900);
            adaptiveStableBatches = 0;
          } else if (safeCost < 220) {
            adaptiveStableBatches++;
            if (adaptiveStableBatches >= 4) {
              adaptiveMaxEventsPerEmit = Math.min(MAX_EVENTS_PER_EMIT, adaptiveMaxEventsPerEmit + 1);
              adaptiveMaxEmitBytes = Math.min(MAX_EMIT_BYTES, adaptiveMaxEmitBytes + 800);
              adaptiveStableBatches = 0;
            }
          } else {
            adaptiveStableBatches = 0;
          }
          const congestionPenalty = safeCost > 700 ? Math.min(1400, Math.round(safeCost * 0.35)) : 0;
          const boostPenalty = performance.now() < uiBoostUntil ? 140 : 0;
          nextEmitAt = performance.now() + lastCooldownMs + congestionPenalty + boostPenalty;
          waitingRenderCooldown = false;

          if (droppedInBatch > 0 || safeCost > 150 || batchCount % 15 === 0) {
            logDebug(`[ChatPruner] 📤 Batch #${batchCount}: events=${emittedEvents.length} | dedupe=${droppedInBatch} | render=${Math.round(safeCost)}ms | cooldown=${Math.round(lastCooldownMs)}ms | cap=${adaptiveMaxEventsPerEmit}/${adaptiveMaxEmitBytes} | totalSaved=${totalDropped}`);
          }
          droppedInBatch = 0;

          let emittedAssistant = false;
          for (const meta of emittedMetas) {
            if (!meta) continue;
            if (!meta.orderSensitive && meta.key && meta.signature) {
              lastForwardedSignatureByKey.set(meta.key, meta.signature);
            }
            if (meta.kind === 'assistant_msg' && meta.msgId && meta.textLen >= 0) {
              lastForwardedAssistantLenById.set(meta.msgId, meta.textLen);
              emittedAssistant = true;
            }
            if (meta.hasContent && meta.signature) {
              lastForwardedContentSignature = meta.signature;
            }
          }
          if (emittedAssistant) lastAssistantForwardAt = performance.now();

          publishStats();
          scheduleProcess(0);
        };

        const safety = setTimeout(() => releaseCooldown(MIN_COOLDOWN_MS), MAX_COOLDOWN_MS + 400);
        requestAnimationFrame(() => {
          clearTimeout(safety);
          releaseCooldown(performance.now() - enqueueAt);
        });
        publishStats();
      }

      function queueDecodedText(decodedText) {
        if (!decodedText) return;
        textBuffer += decodedText;

        const parts = textBuffer.split(/(?:\r?\n){2,}/);
        textBuffer = parts.pop() || '';

        for (const p of parts) {
          const clean = p.trim();
          if (clean) enqueueRawEvent(clean);
        }
      }

      function processQueue(forceEmit) {
        if (processing) {
          if (forceEmit) scheduleProcess(0);
          return;
        }

        processing = true;
        const started = performance.now();
        let processed = 0;

        while (rawReadIndex < rawEvents.length) {
          ingestEvent(rawEvents[rawReadIndex++]);
          processed++;
          if (processed >= MAX_EVENTS_PER_TICK) break;
          if ((performance.now() - started) >= PROCESS_BUDGET_MS) break;
        }

        compactRawQueue();

        if (forceEmit) {
          emitPending(true);
        } else {
          emitPending(false);
        }

        const hasBacklog = rawReadIndex < rawEvents.length;
        processing = false;
        publishStats();

        if (hasBacklog) {
          scheduleProcess(waitingRenderCooldown ? 16 : 0);
          return;
        }

        if (streamDone) {
          emitPending(true);
          if (!waitingRenderCooldown && pendingEvents.length === 0) {
            if (
              lastContentCandidateEvent &&
              lastContentCandidateSignature &&
              lastContentCandidateSignature !== lastForwardedContentSignature
            ) {
              try {
                controller.enqueue(encoder.encode(lastContentCandidateEvent + '\n\n'));
                lastForwardedContentSignature = lastContentCandidateSignature;
                logDebug('[ChatPruner] 🧷 Failsafe: resent last content snapshot before closing stream');
              } catch { }
            }
            closeStream();
            publishStats(true);
            const rootSnapshot = {
              rawEventTotal,
              topEventNames: topCounts(rawEventNameCounts, 8),
              topKinds: topCounts(classifiedKindCounts, 8),
              topKeys: topCounts(classifiedKeyCounts, 8),
              topDroppedKeys: topCounts(droppedByKeyCounts, 8),
              topPatchPaths: topCounts(patchPathCounts, 8),
            };
            window.__chatPrunerRootSnapshot = rootSnapshot;
            logDebug('[ChatPruner] 🧬 Root snapshot:', rootSnapshot);
            logDebug(`[ChatPruner] ✅ Stream complete — renders skipped: ${totalDropped}`);
          }
          return;
        }

        if (!waitingRenderCooldown && pendingEvents.length > 0) {
          const wait = Math.max(0, nextEmitAt - performance.now());
          scheduleProcess(wait);
        }
      }

      let reading = false;
      function pump() {
        if (reading || streamClosed) return;
        reading = true;

        reader.read().then(({ value, done }) => {
          reading = false;
          if (value) queueDecodedText(decoder.decode(value, { stream: true }));

          if (done) {
            queueDecodedText(decoder.decode());
            const tail = textBuffer.trim();
            textBuffer = '';
            if (tail) enqueueRawEvent(tail);
            streamDone = true;
            processQueue(true);
            return;
          }

          scheduleProcess(0);
          pump();
        }).catch(err => {
          if (streamClosed) return;
          try { controller.error(err); } catch { }
          streamClosed = true;
        });
      }

      const bufferedStream = new ReadableStream({
        start(ctrl) {
          controller = ctrl;
          pump();
        },
        cancel() {
          streamClosed = true;
          if (flushTimer !== null) {
            clearTimeout(flushTimer);
            flushTimer = null;
            scheduledDelay = null;
          }
          reader.cancel();
        }
      });

      const newResponse = new Response(bufferedStream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });

      Object.defineProperty(newResponse, 'url', { value: response.url });
      return newResponse;
    });
  };

  // ─── OpenAI telemetry blockers ───
  const originalSendBeacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = function (url, data) {
    if (shouldBlock(url)) return true;
    return originalSendBeacon(url, data);
  };
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url, ...r) {
    if (shouldBlock(url)) { this.__blocked = true; return; }
    return originalXhrOpen.call(this, m, url, ...r);
  };
  XMLHttpRequest.prototype.send = function (data) {
    if (this.__blocked) {
      Object.defineProperty(this, 'status', { value: 200 });
      Object.defineProperty(this, 'readyState', { value: 4 });
      if (this.onload) setTimeout(() => this.onload(), 0);
      return;
    }
    return originalXhrSend.call(this, data);
  };

  console.log('[ChatPruner] ✅ SSE deduplicator active — anti-freeze enabled');
  logDebug('[ChatPruner] ⚙️  Preset: ' + ACTIVE_TUNING + ' | Flush: ' + FLUSH_INTERVAL + 'ms | Budget: ' + PROCESS_BUDGET_MS + 'ms');
})();
