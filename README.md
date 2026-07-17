# ChatGPT Pruner

Chrome extension that keeps long ChatGPT threads usable: prunes old messages from the DOM, throttles SSE stream rendering, and blocks noisy telemetry that can add jank.

Works on regular chats and **ChatGPT Projects** (`/g/g-p-.../c/...`).

## Install (developer mode)

1. Clone this repo.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the repo folder.
5. Open [chatgpt.com](https://chatgpt.com) and use the floating **Chat Pruner** panel.

No build step. No API keys. No account with this project.

## What it does

### Message pruning (`content.js`)

- Keeps the last N conversation turns (default: 20).
- **Auto** mode prunes as the thread grows.
- **Ghost cleanup** removes empty turn shells.
- Project chats wrap each turn in `div[data-turn-id-container]`; the pruner removes the whole wrapper, not just the inner `<section>`.

### Network guard (`net-guard.js`) — v1.6

Blocks or softens ChatGPT-side traffic that freezes long MCP sessions:

| Target | Action |
|--------|--------|
| `connectors/list_accessible` (large catalog) | cache pass-through 2 min — real first fetch, then local replay |
| `connectors/links/list_accessible` | same cache — **no** empty stub |
| `ces/v1/rgstr`, sentinel heartbeat | block |
| `widget_state` | throttle to 1× / 12s |
| `sprites-core-*.svg` | cache + inflight dedupe **only for `fetch`/XHR** (parser/DOM loads bypass) |
| sidebar `conversations` + `gizmos/.../conversations` | in-flight dedupe + 60s cache (only bodies with `items[]`) |
| `call_mcp` + `runtime mismatch` | circuit breaker — first fatal 400 trips, then stubbed locally |

**v1.9.1:** Cookie `split` memoization (cuts repeated `getCookies`), DNR for `api.oaistatsig.com` + `featuregates.org`, default Keep 10.

**v1.9.0:** RunTask relief — always-on `content-visibility: auto` on turns, MAIN-world scroll/wheel coalesce (`scroll-patch.js`), DNR for `*/telemetry/intake` + `events.statsigapi.net`.

**v1.6.8:** Stop deduping `/backend-api/conversation/{id}` — parallel loads of a single chat shared one in-flight response → Content failed to load.

**v1.6.7:** Sidebar history — in-flight dedupe + 60s cache for `conversations` / `gizmos/.../conversations` (only when response has `items[]`).

**v1.6.6:** Stop blocking `conversations?hide_snorlax=true` — stub `{}` broke `conversationHistory` (`n.items is not iterable` → Content failed to load).

**v1.6.4:** Connector cache replaces empty stubs (fixes plugins showing offline with pruner on).

Inspect counters: `window.__chatPrunerNetGuardStats` in DevTools.

Sprites loaded by the HTML parser (`<img>`, `<link>`, resource type `other`) are **not** intercepted — only duplicate `fetch` calls are coalesced.

### Docker / ERR_NETWORK_CHANGED

Containers with `restart: unless-stopped` in a crash loop (e.g. `continental-api` with wrong DB host) create/destroy `veth` interfaces every few seconds. Chromium reports `net::ERR_NETWORK_CHANGED` and aborts ChatGPT API calls. **Stop the broken container** before long ChatGPT sessions — extension cannot fix host network churn.

### Stream smoothing (`debounce.js`)

ChatGPT can freeze on long threads because React reconciles huge SSE delta bursts on the main thread. This script patches `fetch` for `/backend-api/f/conversation` and:

- batches / dedupes stream deltas
- caps events and bytes per emit
- applies adaptive cooldown after expensive renders

Presets in the panel: **Stable**, **Balanced** (default), **Snappy**. Click **Reload** after changing preset.

### Optional profiler (`profiler.js`)

Off by default. Enable in DevTools console:

```js
chrome.storage.local.set({ enableProfiler: true }, () => location.reload());
```

Then inspect `window.__chatPrunerProfile` and `window.__chatPrunerStreamStats` during a stream.

## Panel controls

| Control | Action |
|--------|--------|
| **Keep** | How many recent turns to keep (5–200) |
| **Prune** | Prune now |
| **Clear Ghosts** | Remove empty turn / wrapper nodes |
| **Auto** | Prune automatically on new messages |
| **Preset** | Stream tuning preset |
| **Reload** | Reload page to apply preset |
| **Bridge terminal** | Live codex-bridge process output (Codex-style pane, v1.10) |

### Bridge terminal (v1.10, opcional)

Prefer **terminal real no PC**: no repo `codex-bridge`, `./scripts/tail-process.sh '<viewToken>'` (SSE local, só leitura).

A extensão ainda pode abrir um painel no browser (**Bridge terminal**, desligado por padrão). Sniff de `viewToken` em `call_mcp` + SSE via service worker.

- **Open terminal** — show the log pane
- **−** on the terminal — minimize to `>_ bridge` tab
- **clear** — wipe output

After updating: `chrome://extensions` → **Reload** this extension, then reload ChatGPT.

## Privacy

- Runs only on `chatgpt.com` / `chat.openai.com`.
- Settings stay in `chrome.storage.local` on your machine.
- Blocks some ChatGPT telemetry endpoints via `declarativeNetRequest` (see `rules.json`).
- Does **not** send your chats anywhere. Pruning is local DOM removal only.

## Project layout

| File | Role |
|------|------|
| `manifest.json` | Extension manifest (MV3) |
| `background.js` | Bridge SSE relay (`/process/stream` → panel) |
| `content.js` | UI panel, pruning, script injection |
| `net-guard.js` | Block/stub/dedupe noisy ChatGPT API calls |
| `debounce.js` | SSE intercept, batching, presets |
| `profiler.js` | Optional stream / long-task profiler |
| `scroll-patch.js` | MAIN-world passive + rAF coalesce for scroll/wheel |
| `rules.json` | Telemetry block rules |
| `styles.css` | Panel styles |
| `fixtures/project-turn-snippet.html` | Synthetic DOM fixture for selector checks |
| `test-net-guard.mjs` | Dedupe clone + MCP circuit pattern checks |
| `test-turn-selectors.mjs` | Project chat DOM fixture self-check |

## Trade-offs

- Pruning is **visual only** — OpenAI may still hold full history server-side.
- Stream throttling trades some “live typing” smoothness for fewer UI freezes.
- ChatGPT’s DOM changes over time; selectors may need updates after UI deploys.

## License

MIT — see [LICENSE](LICENSE).
