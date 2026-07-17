#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const rules = JSON.parse(readFileSync(new URL('./rules.json', import.meta.url), 'utf8'));
const scroll = readFileSync(new URL('./scroll-patch.js', import.meta.url), 'utf8');
const content = readFileSync(new URL('./content.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const netGuard = readFileSync(new URL('./net-guard.js', import.meta.url), 'utf8');

test('cold turns get content-visibility; hot turns do not via global CSS', () => {
  assert.match(css, /\.chatpruner-cold/);
  assert.match(css, /content-visibility:\s*auto/);
  assert.doesNotMatch(css, /^\[data-testid\^="conversation-turn-"\]/m);
  assert.match(content, /HOT_TURNS\s*=\s*2/);
  assert.match(content, /markColdTurns/);
});

test('defaults: Auto on, Keep 6', () => {
  assert.match(content, /keepLast:\s*6/);
  assert.match(content, /auto:\s*true/);
  assert.match(content, /policyV2/);
});

test('sentinel not in DNR block rules', () => {
  const filters = rules.map((r) => r.condition.urlFilter).join('\n');
  assert.doesNotMatch(filters, /sentinel/);
  assert.doesNotMatch(netGuard, /BLOCK_PATTERNS[\s\S]{0,200}sentinel\/ping/);
});

test('scroll-patch: scroll only, no wheel', () => {
  const boot = (manifest.content_scripts || []).find(
    (s) => s.world === 'MAIN' && s.js?.includes('scroll-patch.js'),
  );
  assert.ok(boot, 'MAIN scroll-patch.js');
  assert.match(scroll, /type === 'scroll'/);
  assert.doesNotMatch(scroll, /type === 'wheel'/);
  assert.match(scroll, /shouldCoalesceScroll/);
  assert.match(scroll, /TTL_MS/);
});

test('bridge has no setInterval nav poll', () => {
  assert.doesNotMatch(content, /setInterval\(onNav/);
  assert.match(content, /chatpruner:navigate/);
});

test('low-motion CSS present', () => {
  assert.match(css, /chatpruner-low-motion/);
  assert.match(css, /chatpruner-no-effects/);
  assert.doesNotMatch(css, /transform:\s*none/);
});
