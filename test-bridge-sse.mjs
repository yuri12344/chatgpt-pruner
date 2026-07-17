#!/usr/bin/env node
/** Bridge SSE bind structural checks — run: node test-bridge-sse.mjs */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('.', import.meta.url);
const read = (name) => readFileSync(new URL(name, root), 'utf8');

test('manifest grants localhost bridge + service worker', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.version, '1.11.0');
  assert.ok(manifest.host_permissions.some((p) => p.includes('127.0.0.1:8787')));
  assert.equal(manifest.background?.service_worker, 'background.js');
});

test('net-guard sniffs viewToken and dispatches bridge-token event', () => {
  const src = read('net-guard.js');
  assert.match(src, /chatpruner:bridge-token/);
  assert.match(src, /bridgeTokens/);
  assert.match(src, /sniffMcpPair/);
  assert.match(src, /deepFindStrings/);
});

test('background relays process/stream SSE', () => {
  const src = read('background.js');
  assert.match(src, /process\/stream/);
  assert.match(src, /bridge-log/);
  assert.match(src, /setToken/);
  assert.match(src, /parseSseChunk/);
});

test('content panel exposes bridge terminal', () => {
  const src = read('content.js');
  assert.match(src, /chatprune-terminal/);
  assert.match(src, /chatprune-bridge-log/);
  assert.match(src, /chatpruner:bridge-token/);
  assert.match(src, /bridge-log-toggle/);
  assert.match(src, /chrome\.runtime\.connect/);
  assert.match(src, /mountBridgeTerminal/);
});

test('styles include codex terminal pane', () => {
  const css = read('styles.css');
  assert.match(css, /#chatprune-terminal/);
  assert.match(css, /cp-term-body/);
});

test('background parses output_chunk lines', () => {
  const src = read('background.js');
  assert.match(src, /output_chunk/);
  assert.match(src, /stdoutChunk/);
});
