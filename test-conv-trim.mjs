#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const src = readFileSync(new URL('./net-guard.js', import.meta.url), 'utf8');

/** Mirror of net-guard trimConversationInPlace — keep in sync. */
function trimConversationInPlace(data, keepVisible = 6) {
  const mapping = data?.mapping;
  const current = data?.current_node;
  if (!mapping || typeof mapping !== 'object' || !current || !mapping[current]) return false;

  const chain = [];
  const seen = new Set();
  let id = current;
  while (id && mapping[id] && !seen.has(id)) {
    seen.add(id);
    chain.push(id);
    id = mapping[id].parent;
  }
  if (chain.length < 2) return false;
  chain.reverse();

  let visible = 0;
  let cutoff = 0;
  for (let i = chain.length - 1; i >= 0; i--) {
    const role = mapping[chain[i]]?.message?.author?.role;
    if (role === 'user' || role === 'assistant') {
      visible += 1;
      if (visible >= keepVisible) {
        cutoff = i;
        break;
      }
    }
  }
  if (cutoff === 0 && visible < keepVisible) return false;

  const keep = new Set(chain.slice(cutoff));
  const next = {};
  for (const kid of keep) {
    const node = mapping[kid];
    if (!node) continue;
    next[kid] = {
      ...node,
      children: Array.isArray(node.children) ? node.children.filter((c) => keep.has(c)) : [],
    };
  }
  const first = chain[cutoff];
  if (next[first]) next[first] = { ...next[first], parent: null };
  data.mapping = next;
  return true;
}

function makeConv(visiblePairs) {
  const mapping = {};
  let prev = null;
  const ids = [];
  for (let i = 0; i < visiblePairs; i++) {
    for (const role of ['user', 'assistant']) {
      const id = `${role}-${i}`;
      ids.push(id);
      mapping[id] = {
        id,
        parent: prev,
        children: [],
        message: { author: { role }, content: { parts: [`${role} ${i}`] } },
      };
      if (prev) mapping[prev].children.push(id);
      prev = id;
    }
  }
  return { title: 't', current_node: ids[ids.length - 1], mapping };
}

test('sentinel is not in BLOCK_PATTERNS', () => {
  const block = src.match(/const BLOCK_PATTERNS = \[([\s\S]*?)\];/);
  assert.ok(block, 'BLOCK_PATTERNS');
  assert.doesNotMatch(block[1], /sentinel/);
  assert.match(src, /SENTINEL_MEASURE/);
  assert.match(src, /sentinelSeen/);
});

test('trim uses response.json override, not clone/stringify', () => {
  assert.match(src, /response\.json\s*=\s*async/);
  assert.match(src, /trimConversationInPlace/);
  assert.match(src, /chatpruner:trim-conversation-json/);
});

test('trimConversationInPlace keeps last N visible on branch', () => {
  const data = makeConv(5);
  const before = Object.keys(data.mapping).length;
  assert.equal(trimConversationInPlace(data, 6), true);
  const after = Object.keys(data.mapping).length;
  assert.ok(after < before, `expected fewer nodes ${after} < ${before}`);
  assert.ok(data.mapping[data.current_node], 'current kept');
  const first = Object.values(data.mapping).find((n) => n.parent == null);
  assert.ok(first, 'root parent null');

  let visible = 0;
  for (const n of Object.values(data.mapping)) {
    if (n.message?.author?.role === 'user' || n.message?.author?.role === 'assistant') visible += 1;
  }
  assert.equal(visible, 6);
});

test('trim fail-open on garbage', () => {
  assert.equal(trimConversationInPlace(null), false);
  assert.equal(trimConversationInPlace({}), false);
  assert.equal(trimConversationInPlace({ mapping: {}, current_node: 'x' }), false);
});
