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

### Stream smoothing (`debounce.js`)

ChatGPT can freeze on long threads because React reconciles huge SSE delta bursts on the main thread. This script patches `fetch` for `/backend-api/f/conversation` and:

- batches / dedupes stream deltas
- caps events and bytes per emit
- applies adaptive cooldown after expensive renders

Presets in the panel: **Stable**, **Balanced** (default), **Snappy**. Click **Recarregar** after changing preset.

### Optional profiler (`profiler.js`)

Off by default. Enable in DevTools console:

```js
chrome.storage.local.set({ enableProfiler: true }, () => location.reload());
```

Then inspect `window.__chatPrunerProfile` and `window.__chatPrunerStreamStats` during a stream.

## Panel controls

| Control | Action |
|--------|--------|
| **Manter** | How many recent turns to keep (5–200) |
| **Podar** | Prune now |
| **Limpar Fantasmas** | Remove empty turn / wrapper nodes |
| **Auto** | Prune automatically on new messages |
| **Modo** | Stream tuning preset |
| **Recarregar** | Reload page to apply preset |

## Privacy

- Runs only on `chatgpt.com` / `chat.openai.com`.
- Settings stay in `chrome.storage.local` on your machine.
- Blocks some ChatGPT telemetry endpoints via `declarativeNetRequest` (see `rules.json`).
- Does **not** send your chats anywhere. Pruning is local DOM removal only.

## Project layout

| File | Role |
|------|------|
| `manifest.json` | Extension manifest (MV3) |
| `content.js` | UI panel, pruning, script injection |
| `debounce.js` | SSE intercept, batching, presets |
| `profiler.js` | Optional stream / long-task profiler |
| `rules.json` | Telemetry block rules |
| `styles.css` | Panel styles |
| `fixtures/project-turn-snippet.html` | Synthetic DOM fixture for selector checks |
| `test-turn-selectors.mjs` | Quick fixture self-check (`node test-turn-selectors.mjs`) |

## Trade-offs

- Pruning is **visual only** — OpenAI may still hold full history server-side.
- Stream throttling trades some “live typing” smoothness for fewer UI freezes.
- ChatGPT’s DOM changes over time; selectors may need updates after UI deploys.

## License

MIT — see [LICENSE](LICENSE).
