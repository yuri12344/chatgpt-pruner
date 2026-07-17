/**
 * Blocks / stubs / dedupes noisy ChatGPT API traffic (not bridge SSE).
 * Injected before debounce.js so the SSE patch wraps this layer.
 */
(() => {
  if (window.__chatPrunerNetGuardActive) return;
  window.__chatPrunerNetGuardActive = true;

  const BLOCK_PATTERNS = [
    '/ces/v1/rgstr',
    '/ces/v1/t',
    '/ces/v1/m',
    '/ces/statsc/',
    '/ces/v1/telemetry/',
    '/backend-api/lat/',
    '/backend-api/sentinel/ping',
    '/backend-api/sentinel/heartbeat',
    'ab.chatgpt.com/v1/rgstr',
  ];

  const CONNECTOR_CACHE_URLS = [
    '/backend-api/aip/connectors/list_accessible',
    '/backend-api/aip/connectors/links/list_accessible',
  ];
  const CONNECTOR_CACHE_MS = 120000;
  const SIDEBAR_HISTORY_CACHE_MS = 60000;

  const DEDUPE_PREFIXES = [
    '/backend-api/gizmos/',
    // ponytail: never dedupe /conversation/{id} — parallel GET/POST share URL, breaks chat load
    '/backend-api/conversations',
  ];

  // ponytail: fetch/XHR only — parser <img>/<link> loads bypass this script
  const CACHE_ASSETS = [
    '/cdn/assets/sprites-core-',
  ];

  const WIDGET_STATE_URL = '/backend-api/ecosystem/widget_state';
  const CALL_MCP_URL = '/backend-api/ecosystem/call_mcp';
  const WIDGET_STATE_MIN_MS = 12000;
  const MCP_FATAL_RE = /runtime mismatch|invalid view token|unknown scope/i;

  const inflight = new Map();
  const inflightAssets = new Map();
  const assetCache = new Map();
  let lastWidgetStateAt = 0;
  let lastWidgetStateBody = '{}';
  let mcpCircuitOpen = false;
  const connectorCache = new Map();
  const sidebarHistoryCache = new Map();

  const stats = {
    blocked: 0,
    stubbed: 0,
    deduped: 0,
    assetHits: 0,
    assetInflight: 0,
    widgetThrottled: 0,
    mcpCircuitTripped: 0,
    mcpCircuitOpen: 0,
    connectorCached: 0,
    sidebarHistoryCached: 0,
    bridgeTokens: 0,
  };
  window.__chatPrunerNetGuardStats = stats;

  const TOKEN_KEYS = ['viewToken', 'view_token', 'processStreamUrl', 'process_stream_url'];

  function deepFindStrings(obj) {
    const found = {};
    if (!obj || typeof obj !== 'object') return found;
    const stack = [obj];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
      seen.add(cur);
      for (const k of TOKEN_KEYS) {
        const v = cur[k];
        if (typeof v === 'string' && v && !found[k]) found[k] = v;
      }
      for (const v of Object.values(cur)) {
        if (v && typeof v === 'object') stack.push(v);
      }
    }
    return found;
  }

  function toolFromMcpBody(body) {
    if (!body || typeof body !== 'object') return '';
    return (
      body?.params?.name ||
      body?.name ||
      body?.tool ||
      body?.arguments?.name ||
      ''
    );
  }

  function conversationIdFromUrl() {
    const m = location.pathname.match(/\/c\/([a-f0-9-]+)/i);
    return m ? m[1] : '';
  }

  function emitBridgeToken(detail) {
    const viewToken = detail?.viewToken;
    if (!viewToken) return;
    const threadId = detail?.threadId || conversationIdFromUrl();
    stats.bridgeTokens += 1;
    try {
      document.dispatchEvent(
        new CustomEvent('chatpruner:bridge-token', {
          detail: {
            viewToken,
            threadId,
            processStreamUrl: detail.processStreamUrl || '',
            tool: detail.tool || '',
          },
        }),
      );
    } catch { /* ponytail: best-effort */ }
  }

  function sniffMcpPair(reqBody, resBody) {
    let tool = '';
    try {
      const req = typeof reqBody === 'string' ? JSON.parse(reqBody) : reqBody;
      if (req) {
        tool = toolFromMcpBody(req);
        const hit = deepFindStrings(req);
        if (hit.viewToken || hit.view_token) {
          emitBridgeToken({
            viewToken: hit.viewToken || hit.view_token,
            processStreamUrl: hit.processStreamUrl || hit.process_stream_url || '',
            tool,
          });
        }
      }
    } catch { /* ponytail: opaque body */ }
    try {
      const res = typeof resBody === 'string' ? JSON.parse(resBody) : resBody;
      if (!res) return;
      const hit = deepFindStrings(res);
      if (hit.viewToken || hit.view_token) {
        emitBridgeToken({
          viewToken: hit.viewToken || hit.view_token,
          processStreamUrl: hit.processStreamUrl || hit.process_stream_url || '',
          tool: tool || toolFromMcpBody(res),
        });
      }
    } catch { /* ponytail: opaque body */ }
  }

  async function sniffMcpFetchResponse(res, reqBody) {
    const wrapped = await wrapMcpResponse(res);
    try {
      const text = await wrapped.clone().text();
      sniffMcpPair(reqBody, text);
    } catch { /* ponytail: best-effort */ }
    return wrapped;
  }

  function urlOf(resource) {
    return typeof resource === 'string' ? resource : resource?.url || '';
  }

  function shouldBlock(url) {
    if (!url) return false;
    return BLOCK_PATTERNS.some((p) => url.includes(p));
  }

  function connectorCacheKey(url) {
    if (!url) return '';
    for (const match of CONNECTOR_CACHE_URLS) {
      if (url.includes(match)) return match;
    }
    return '';
  }

  function cachedConnectorBody(key) {
    const hit = connectorCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > CONNECTOR_CACHE_MS) {
      connectorCache.delete(key);
      return null;
    }
    return hit.body;
  }

  function rememberConnectorBody(key, body) {
    if (!key || !body) return;
    connectorCache.set(key, { body, at: Date.now() });
  }

  function normalizeUrlKey(url) {
    try {
      const u = new URL(url, location.origin);
      return u.pathname + u.search;
    } catch {
      return String(url).split('#')[0];
    }
  }

  /** ponytail: plural /conversations list + gizmo project lists only — not /conversation/{id}. */
  function sidebarHistoryCacheKey(url) {
    if (!url) return '';
    if (url.includes('/backend-api/conversations')) return normalizeUrlKey(url);
    if (url.includes('/backend-api/gizmos/') && url.includes('/conversations')) {
      return normalizeUrlKey(url);
    }
    return '';
  }

  function isConversationListBody(text) {
    try {
      return Array.isArray(JSON.parse(text).items);
    } catch {
      return false;
    }
  }

  function cachedSidebarHistoryBody(key) {
    const hit = sidebarHistoryCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > SIDEBAR_HISTORY_CACHE_MS) {
      sidebarHistoryCache.delete(key);
      return null;
    }
    return hit.body;
  }

  function rememberSidebarHistoryBody(key, body) {
    if (!key || !body || !isConversationListBody(body)) return;
    sidebarHistoryCache.set(key, { body, at: Date.now() });
  }

  function fetchSidebarHistoryCached(cacheKey, resource, init) {
    const cached = cachedSidebarHistoryBody(cacheKey);
    if (cached) {
      stats.sidebarHistoryCached++;
      return fakeJson(cached);
    }
    return dedupeFetch(cacheKey, resource, init).then(async (res) => {
      if (res.ok) {
        try {
          rememberSidebarHistoryBody(cacheKey, await res.clone().text());
        } catch { /* ponytail: best-effort cache */ }
      }
      return res;
    });
  }

  function fetchConnectorCached(url, resource, init) {
    const key = connectorCacheKey(url);
    const cached = key ? cachedConnectorBody(key) : null;
    if (cached) {
      stats.connectorCached++;
      return fakeJson(cached);
    }
    return originalFetch(resource, init).then(async (res) => {
      if (key && res.ok) {
        try {
          rememberConnectorBody(key, await res.clone().text());
        } catch { /* ponytail: best-effort cache */ }
      }
      return res;
    });
  }

  function dedupeKey(url) {
    if (!url) return '';
    for (const p of DEDUPE_PREFIXES) {
      if (url.includes(p)) return url.split('?')[0] + '?' + new URL(url, location.origin).search;
    }
    return '';
  }

  function fakeJson(body, status = 200) {
    return Promise.resolve(
      new Response(body, {
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }

  function fakeEmpty() {
    return fakeJson('{}');
  }

  function fakeMcpCircuit() {
    stats.mcpCircuitOpen++;
    return fakeJson(
      '{"detail":"Error code: INVALID_ARGUMENT; Error: McpServerError: view token runtime mismatch"}',
      400,
    );
  }

  function isFatalMcpBody(text) {
    return MCP_FATAL_RE.test(text || '');
  }

  function fetchCachedAsset(url, resource, init) {
    const cached = assetCache.get(url);
    if (cached) {
      stats.assetHits++;
      return Promise.resolve(cached.clone());
    }
    const pending = inflightAssets.get(url);
    if (pending) {
      stats.assetInflight++;
      return pending.then((res) => res.clone());
    }
    const flight = originalFetch(resource, init)
      .then((res) => {
        if (res.ok) assetCache.set(url, res.clone());
        return res;
      })
      .finally(() => {
        inflightAssets.delete(url);
      });
    inflightAssets.set(url, flight);
    return flight;
  }

  function dedupeFetch(key, resource, init) {
    if (key && inflight.has(key)) {
      stats.deduped++;
      return inflight.get(key).then((res) => res.clone());
    }
    const pending = originalFetch(resource, init).finally(() => {
      if (key) inflight.delete(key);
    });
    if (key) inflight.set(key, pending);
    return pending.then((res) => res.clone());
  }

  function wrapMcpResponse(res) {
    if (res.ok) {
      mcpCircuitOpen = false;
      return Promise.resolve(res);
    }
    if (mcpCircuitOpen) return Promise.resolve(res);
    return res.clone().text().then((text) => {
      if (isFatalMcpBody(text)) {
        mcpCircuitOpen = true;
        stats.mcpCircuitTripped++;
      }
      return res;
    });
  }

  const originalFetch = window.fetch.bind(window);

  window.fetch = function chatPrunerNetGuardFetch(resource, init) {
    const url = urlOf(resource);

    if (shouldBlock(url)) {
      stats.blocked++;
      return fakeEmpty();
    }

    const connectorKey = connectorCacheKey(url);
    if (connectorKey) return fetchConnectorCached(url, resource, init);

    if (mcpCircuitOpen && url.includes(CALL_MCP_URL)) {
      return fakeMcpCircuit();
    }

    if (url.includes(WIDGET_STATE_URL)) {
      const now = Date.now();
      if (now - lastWidgetStateAt < WIDGET_STATE_MIN_MS) {
        stats.widgetThrottled++;
        return fakeJson(lastWidgetStateBody);
      }
      lastWidgetStateAt = now;
      return originalFetch(resource, init).then(async (res) => {
        try {
          const text = await res.clone().text();
          if (text) lastWidgetStateBody = text;
        } catch { /* ponytail: best-effort cache */ }
        return res;
      });
    }

    for (const prefix of CACHE_ASSETS) {
      if (!url.includes(prefix)) continue;
      return fetchCachedAsset(url, resource, init);
    }

    const sidebarKey = sidebarHistoryCacheKey(url);
    if (sidebarKey) return fetchSidebarHistoryCached(sidebarKey, resource, init);

    const key = dedupeKey(url);
    if (key) return dedupeFetch(key, resource, init);

    if (url.includes(CALL_MCP_URL)) {
      const reqBody = init?.body;
      return sniffMcpFetchResponse(originalFetch(resource, init), reqBody);
    }

    return originalFetch(resource, init);
  };

  const originalSendBeacon = navigator.sendBeacon?.bind(navigator);
  if (originalSendBeacon) {
    navigator.sendBeacon = function (url, data) {
      if (shouldBlock(url)) return true;
      return originalSendBeacon(url, data);
    };
  }

  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__cpUrl = url;
    if (shouldBlock(url)) {
      this.__cpBlocked = true;
      return;
    }
    if (mcpCircuitOpen && String(url).includes(CALL_MCP_URL)) {
      this.__cpMcpCircuit = true;
      return;
    }
    const connectorKey = connectorCacheKey(String(url));
    if (connectorKey) this.__cpConnectorKey = connectorKey;
    const sidebarKey = sidebarHistoryCacheKey(String(url));
    if (sidebarKey) this.__cpSidebarKey = sidebarKey;
    return originalXhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__cpBlocked) {
      stats.blocked++;
      Object.defineProperty(this, 'status', { value: 200 });
      Object.defineProperty(this, 'readyState', { value: 4 });
      Object.defineProperty(this, 'responseText', { value: '{}' });
      if (this.onload) setTimeout(() => this.onload(), 0);
      return;
    }
    if (this.__cpMcpCircuit) {
      stats.mcpCircuitOpen++;
      Object.defineProperty(this, 'status', { value: 400 });
      Object.defineProperty(this, 'readyState', { value: 4 });
      Object.defineProperty(this, 'responseText', {
        value: '{"detail":"Error code: INVALID_ARGUMENT; Error: McpServerError: view token runtime mismatch"}',
      });
      if (this.onload) setTimeout(() => this.onload(), 0);
      return;
    }
    if (this.__cpConnectorKey) {
      const cached = cachedConnectorBody(this.__cpConnectorKey);
      if (cached) {
        stats.connectorCached++;
        Object.defineProperty(this, 'status', { value: 200 });
        Object.defineProperty(this, 'readyState', { value: 4 });
        Object.defineProperty(this, 'responseText', { value: cached });
        if (this.onload) setTimeout(() => this.onload(), 0);
        return;
      }
    }
    if (this.__cpSidebarKey) {
      const cached = cachedSidebarHistoryBody(this.__cpSidebarKey);
      if (cached) {
        stats.sidebarHistoryCached++;
        Object.defineProperty(this, 'status', { value: 200 });
        Object.defineProperty(this, 'readyState', { value: 4 });
        Object.defineProperty(this, 'responseText', { value: cached });
        if (this.onload) setTimeout(() => this.onload(), 0);
        return;
      }
    }
    const xhr = this;
    const url = xhr.__cpUrl || '';
    if (xhr.__cpConnectorKey) {
      const priorOnload = xhr.onload;
      xhr.onload = function (...onloadArgs) {
        if (xhr.status >= 200 && xhr.status < 300 && xhr.responseText) {
          rememberConnectorBody(xhr.__cpConnectorKey, xhr.responseText);
        }
        if (priorOnload) return priorOnload.apply(this, onloadArgs);
      };
      return originalXhrSend.apply(this, args);
    }
    if (xhr.__cpSidebarKey) {
      const priorOnload = xhr.onload;
      xhr.onload = function (...onloadArgs) {
        if (xhr.status >= 200 && xhr.status < 300 && xhr.responseText) {
          rememberSidebarHistoryBody(xhr.__cpSidebarKey, xhr.responseText);
        }
        if (priorOnload) return priorOnload.apply(this, onloadArgs);
      };
      return originalXhrSend.apply(this, args);
    }
    if (!url.includes(CALL_MCP_URL)) {
      return originalXhrSend.apply(this, args);
    }
    if (args[0] && typeof args[0] === 'string') xhr.__cpReqBody = args[0];
    const priorOnload = xhr.onload;
    xhr.onload = function (...onloadArgs) {
      if (xhr.status >= 200 && xhr.status < 300) mcpCircuitOpen = false;
      if (xhr.status >= 400 && isFatalMcpBody(xhr.responseText)) {
        mcpCircuitOpen = true;
        stats.mcpCircuitTripped++;
      }
      try {
        sniffMcpPair(xhr.__cpReqBody, xhr.responseText);
      } catch { /* ponytail */ }
      if (priorOnload) return priorOnload.apply(this, onloadArgs);
    };
    return originalXhrSend.apply(this, args);
  };

  console.log('[ChatPruner] net-guard active');
})();
