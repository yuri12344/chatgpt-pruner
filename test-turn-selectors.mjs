#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./fixtures/project-turn-snippet.html', import.meta.url), 'utf8');

const turnIds = [...html.matchAll(/data-testid=(conversation-turn-\d+)/g)].map((m) => m[1]);
const wrapperOpens = [...html.matchAll(/<div[^>]*data-turn-id-container=/g)].length;
const articles = [...html.matchAll(/<article\b/gi)].length;
const sectionOpens = [...html.matchAll(/<section\b/gi)].length;

if (articles !== 0) throw new Error(`fixture should have no article turns, got ${articles}`);
if (turnIds.length < 2) throw new Error(`expected >=2 turns, got ${turnIds.length}`);
if (sectionOpens < turnIds.length) throw new Error(`expected section per turn, sections=${sectionOpens} turns=${turnIds.length}`);
if (wrapperOpens < turnIds.length) throw new Error(`expected wrapper divs, wrappers=${wrapperOpens} turns=${turnIds.length}`);

for (const id of turnIds) {
  const chunk = html.slice(Math.max(0, html.indexOf(`data-testid=${id}`) - 1200), html.indexOf(`data-testid=${id}`));
  if (!/<div[^>]*data-turn-id-container=/.test(chunk)) {
    throw new Error(`${id} should be preceded by a wrapper div`);
  }
}

console.log('ok: project-turn-snippet matches project chat DOM');
