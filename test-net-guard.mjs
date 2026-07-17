#!/usr/bin/env node
/** net-guard behavioral checks — run: node test-net-guard.mjs */
import assert from 'node:assert/strict';
import test from 'node:test';

async function dedupeFetch(url, inflight, originalFetch) {
  const key = url;
  if (key && inflight.has(key)) {
    return inflight.get(key).then((res) => res.clone());
  }
  const pending = originalFetch().finally(() => {
    if (key) inflight.delete(key);
  });
  if (key) inflight.set(key, pending);
  return pending.then((res) => res.clone());
}

test('inflight dedupe returns independent response bodies', async () => {
  let network = 0;
  const inflight = new Map();
  const originalFetch = async () => {
    network += 1;
    return new Response('{"ok":true}');
  };
  const [a, b] = await Promise.all([
    dedupeFetch('https://chatgpt.com/backend-api/conversations?x=1', inflight, originalFetch),
    dedupeFetch('https://chatgpt.com/backend-api/conversations?x=1', inflight, originalFetch),
  ]);
  assert.equal(network, 1);
  assert.notEqual(a, b);
  assert.deepEqual(await a.json(), await b.json());
});

test('asset inflight dedupe matches net-guard pattern', async () => {
  let network = 0;
  const inflightAssets = new Map();
  const assetCache = new Map();
  const url = 'https://chatgpt.com/cdn/assets/sprites-core-x.svg';

  async function fetchCachedAsset() {
    const cached = assetCache.get(url);
    if (cached) return cached.clone();
    const pending = inflightAssets.get(url);
    if (pending) return pending.then((res) => res.clone());
    const flight = (async () => {
      network += 1;
      return new Response('<svg/>', { status: 200 });
    })().then((res) => {
      if (res.ok) assetCache.set(url, res.clone());
      return res;
    }).finally(() => inflightAssets.delete(url));
    inflightAssets.set(url, flight);
    return flight;
  }

  const results = await Promise.all([fetchCachedAsset(), fetchCachedAsset(), fetchCachedAsset()]);
  assert.equal(network, 1);
  assert.equal(results.length, 3);
  for (const res of results) {
    assert.equal(await res.text(), '<svg/>');
  }
});

test('mcp fatal body trips circuit', () => {
  const MCP_FATAL_RE = /runtime mismatch|invalid view token|unknown scope/i;
  assert.ok(MCP_FATAL_RE.test('McpServerError: view token runtime mismatch'));
  assert.ok(!MCP_FATAL_RE.test('timeout waiting for tool'));
});

test('net-guard source contains mcp circuit breaker', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./net-guard.js', import.meta.url), 'utf8');
  assert.match(src, /res\.clone\(\)/);
  assert.match(src, /mcpCircuitOpen/);
  assert.match(src, /CALL_MCP_URL/);
  assert.match(src, /parser <img>/);
});

test('connectors use cache pass-through, not empty stub', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./net-guard.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /"connectors":\[\]/);
  assert.doesNotMatch(src, /"links":\[\]/);
  assert.match(src, /CONNECTOR_CACHE_URLS/);
  assert.match(src, /fetchConnectorCached/);
  assert.match(src, /rememberConnectorBody/);
});

test('single chat load must not dedupe /backend-api/conversation/{id}', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./net-guard.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\/backend-api\/conversation\/'/);
});

test('sidebar history uses cache and dedupe without empty stubs', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./net-guard.js', import.meta.url), 'utf8');
  assert.match(src, /sidebarHistoryCacheKey/);
  assert.match(src, /fetchSidebarHistoryCached/);
  assert.match(src, /isConversationListBody/);
  assert.match(src, /SIDEBAR_HISTORY_CACHE_MS/);
  assert.match(src, /\/backend-api\/conversations/);
  assert.doesNotMatch(src, /hide_snorlax=true/);
});

test('hide_snorlax conversations must not be stubbed with empty object', async () => {
  const { readFileSync } = await import('node:fs');
  const rules = JSON.parse(readFileSync(new URL('./rules.json', import.meta.url), 'utf8'));
  const src = readFileSync(new URL('./net-guard.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /hide_snorlax/);
  assert.ok(!rules.some((r) => String(r.condition?.urlFilter || '').includes('hide_snorlax')));
});

test('connector cache returns cached body without second network call', async () => {
  const connectorCache = new Map();
  const CONNECTOR_CACHE_MS = 120000;
  let network = 0;

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
    connectorCache.set(key, { body, at: Date.now() });
  }

  async function fetchConnectorCached(key, fetchFn) {
    const cached = cachedConnectorBody(key);
    if (cached) return cached;
    network += 1;
    const body = await fetchFn();
    rememberConnectorBody(key, body);
    return body;
  }

  const key = '/backend-api/aip/connectors/list_accessible';
  const a = await fetchConnectorCached(key, async () => '{"connectors":[{"id":"x"}]}');
  const b = await fetchConnectorCached(key, async () => '{"connectors":[]}');
  assert.equal(network, 1);
  assert.equal(a, b);
  assert.match(a, /"id":"x"/);
});

test('sidebar cache only stores bodies with items array', () => {
  function isConversationListBody(text) {
    try {
      return Array.isArray(JSON.parse(text).items);
    } catch {
      return false;
    }
  }
  assert.ok(isConversationListBody('{"items":[],"total":0}'));
  assert.ok(!isConversationListBody('{}'));
  assert.ok(!isConversationListBody('{"data":[]}'));
});

test('sidebar cache returns cached body without second network call', async () => {
  const sidebarHistoryCache = new Map();
  const SIDEBAR_HISTORY_CACHE_MS = 60000;
  let network = 0;

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
    if (!key || !body) return;
    try {
      if (!Array.isArray(JSON.parse(body).items)) return;
    } catch {
      return;
    }
    sidebarHistoryCache.set(key, { body, at: Date.now() });
  }

  async function fetchSidebar(key, fetchFn) {
    const cached = cachedSidebarHistoryBody(key);
    if (cached) return cached;
    network += 1;
    const body = await fetchFn();
    rememberSidebarHistoryBody(key, body);
    return body;
  }

  const key = '/backend-api/conversations?offset=0&limit=28';
  const a = await fetchSidebar(key, async () => '{"items":[{"id":"c1"}],"total":1}');
  const b = await fetchSidebar(key, async () => '{"items":[]}');
  assert.equal(network, 1);
  assert.equal(a, b);
  assert.match(a, /"id":"c1"/);
});
