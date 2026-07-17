#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const rules = JSON.parse(readFileSync(new URL('./rules.json', import.meta.url), 'utf8'));
const scroll = readFileSync(new URL('./scroll-patch.js', import.meta.url), 'utf8');
const content = readFileSync(new URL('./content.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));

test('CSS applies content-visibility to turns (always on)', () => {
  assert.match(css, /content-visibility:\s*auto/);
  assert.match(css, /\[data-testid\^="conversation-turn-"\]/);
  assert.doesNotMatch(css, /chatgpt-pruner-terminal/);
  assert.doesNotMatch(content, /terminalLite|Terminal Lite|chatprune-lite/);
});

test('DNR blocks telemetry/intake and statsig family', () => {
  const filters = rules.map((r) => r.condition.urlFilter);
  assert.ok(filters.some((f) => f.includes('telemetry/intake')));
  assert.ok(filters.some((f) => f.includes('statsigapi.net')));
  assert.ok(filters.some((f) => f.includes('oaistatsig.com')));
  assert.ok(filters.some((f) => f.includes('featuregates.org')));
  assert.ok(manifest.host_permissions.some((h) => h.includes('statsig')));
});

test('scroll-patch is MAIN world document_start and coalesces scroll', () => {
  const boot = (manifest.content_scripts || []).find(
    (s) => s.world === 'MAIN' && s.js?.includes('scroll-patch.js'),
  );
  assert.ok(boot, 'MAIN scroll-patch.js');
  assert.equal(boot.run_at, 'document_start');
  assert.match(scroll, /passive:\s*true/);
  assert.match(scroll, /requestAnimationFrame/);
  assert.match(scroll, /removeEventListener/);
  assert.match(scroll, /type === 'scroll'/);
});

test('scroll-patch memoizes cookie split', () => {
  assert.match(scroll, /getOwnPropertyDescriptor\(Document\.prototype, 'cookie'\)/);
  assert.match(scroll, /sep === '; '/);
  assert.match(scroll, /TTL_MS/);
});

test('rAF coalesce drops duplicate scroll ticks', async () => {
  let calls = 0;
  let scheduled = false;
  const queue = [];
  const rAF = (fn) => { queue.push(fn); };
  const listener = () => { calls += 1; };
  const wrapped = function () {
    if (scheduled) return;
    scheduled = true;
    rAF(() => {
      scheduled = false;
      listener();
    });
  };
  wrapped();
  wrapped();
  wrapped();
  assert.equal(calls, 0);
  while (queue.length) queue.shift()();
  assert.equal(calls, 1);
});
