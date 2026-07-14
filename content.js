(() => {
  // Inject debounce.js into page context (content scripts can't monkey-patch page's fetch)
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('debounce.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  // Profiler is expensive. Keep it opt-in via chrome.storage.local.enableProfiler.
  try {
    chrome.storage.local.get({ enableProfiler: false }, (res) => {
      if (!res || !res.enableProfiler) return;
      const profScript = document.createElement('script');
      profScript.src = chrome.runtime.getURL('profiler.js');
      profScript.onload = () => profScript.remove();
      (document.head || document.documentElement).appendChild(profScript);
    });
  } catch { }

  const PRESET_STORAGE_KEY = 'chatpruner:tuning-preset';
  const PRESET_VALUES = ['stable', 'balanced', 'snappy'];
  const DEFAULTS = { keepLast: 20, auto: false, minimized: false, tuningPreset: 'balanced' };

  const state = {
    placeholderEl: null,
    observer: null,
    retryTimer: null,
    lastPruneAt: 0,
    lastGhostCleanupAt: 0,
    lastUrl: location.href,
    autoEnabled: false,
    keepLast: DEFAULTS.keepLast,
    container: null,
    pruneTimer: null,
    pruneIdleId: null,
    pruneQueued: false,
    pruneInFlight: false,
    pruneNeedsRerun: false
  };

  const THROTTLE_MS = 400;
  const PRUNE_IDLE_TIMEOUT_MS = 160;
  const PRUNE_BATCH_SIZE = 12;
  const GHOST_CLEANUP_EVERY_MS = 8000;

  function qs(sel, root = document) { return root.querySelector(sel); }
  function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

  function logStatus(msg) {
    const el = document.getElementById('chatprune-status');
    if (el) el.textContent = msg;
  }

  function getSettings() {
    return new Promise((resolve) => {
      try { chrome.storage.local.get(DEFAULTS, (res) => resolve(res || { ...DEFAULTS })); }
      catch { resolve({ ...DEFAULTS }); }
    });
  }

  function setSettings(patch) {
    return new Promise((resolve) => {
      try { chrome.storage.local.set(patch, () => resolve()); }
      catch { resolve(); }
    });
  }

  function clampKeep(n) {
    if (!Number.isFinite(n)) return DEFAULTS.keepLast;
    return Math.max(5, Math.min(200, n));
  }

  function normalizePreset(value) {
    const preset = String(value || '').trim().toLowerCase();
    return PRESET_VALUES.includes(preset) ? preset : DEFAULTS.tuningPreset;
  }

  function presetHint(preset) {
    if (preset === 'stable') return 'Mais estável, menos “ao vivo”.';
    if (preset === 'snappy') return 'Mais fluido, com risco de micro-jank.';
    return 'Meio-termo entre estabilidade e fluidez.';
  }

  function applyPagePreset(presetValue) {
    const preset = normalizePreset(presetValue);
    try { localStorage.setItem(PRESET_STORAGE_KEY, preset); } catch { }
    return preset;
  }

  const TURN_NODE_SEL = 'article[data-testid^="conversation-turn-"], section[data-testid^="conversation-turn-"]';

  function turnRoot(node) {
    const parent = node?.parentElement;
    if (parent && parent.hasAttribute('data-turn-id-container')) return parent;
    return node;
  }

  function findTurnsGlobal() {
    let turns = qsa(TURN_NODE_SEL);
    if (turns.length) return turns;

    turns = qsa('[data-testid^="conversation-turn-"]');
    if (turns.length) return turns;

    turns = qsa('article[data-turn], section[data-turn]');
    if (turns.length) return turns;

    // Worst-case: derive from markdown
    const mds = qsa('div.markdown.prose');
    const set = new Set();
    const out = [];
    for (const m of mds) {
      let cur = m;
      for (let i = 0; i < 12 && cur; i++) {
        const tag = (cur.tagName || '').toLowerCase();
        if (tag === 'article' || tag === 'section') {
          const tid = cur.getAttribute('data-testid') || '';
          if (tid.startsWith('conversation-turn-') || cur.hasAttribute('data-turn')) {
            if (!set.has(cur)) { set.add(cur); out.push(cur); }
          }
          break;
        }
        cur = cur.parentElement;
      }
    }
    return out;
  }

  function findContainerFromTurns(turns) {
    if (!turns.length) return null;
    return turnRoot(turns[0]).parentElement || null;
  }

  function ensurePlaceholder(parent, removedCount, keepLast) {
    if (state.placeholderEl && state.placeholderEl.isConnected) {
      state.placeholderEl.textContent = `🗿 ${removedCount} mensagens antigas removidas (visíveis: ${keepLast})`;
      return state.placeholderEl;
    }
    const ph = document.createElement('div');
    ph.className = 'chatprune-placeholder';
    ph.textContent = `🗿 ${removedCount} mensagens antigas removidas (visíveis: ${keepLast})`;
    parent.insertBefore(ph, parent.firstChild);
    state.placeholderEl = ph;
    return ph;
  }

  // Remove empty shells (only icons, no markdown/text) and orphan project wrappers.
  function cleanupGhostTurns(force = false) {
    const now = Date.now();
    if (!force && now - state.lastGhostCleanupAt < GHOST_CLEANUP_EVERY_MS) return 0;
    state.lastGhostCleanupAt = now;

    let removed = 0;
    const turns = qsa(TURN_NODE_SEL);
    for (const t of turns) {
      const hasMarkdown = !!qs('div.markdown.prose', t);
      const text = (t.textContent || '').trim();
      if (!hasMarkdown && text.length === 0) {
        turnRoot(t).remove();
        removed++;
      }
    }

    // ponytail: project chats wrap each turn in div[data-turn-id-container]; pruning only the
    // inner section left empty wrappers (upgrade path: none, just remove the shell).
    for (const w of qsa('div[data-turn-id-container]')) {
      if (qs(TURN_NODE_SEL, w)) continue;
      if ((w.textContent || '').trim().length === 0) {
        w.remove();
        removed++;
      }
    }
    return removed;
  }

  function prune(keepLast, force = false) {
    const now = Date.now();
    if (!force && now - state.lastPruneAt < THROTTLE_MS) return;
    if (state.pruneInFlight) {
      state.pruneNeedsRerun = true;
      return;
    }
    state.lastPruneAt = now;

    const turns = findTurnsGlobal();
    if (!turns.length) {
      logStatus('Auto: aguardando o chat montar...');
      return;
    }

    const container = state.container || findContainerFromTurns(turns);
    if (container) state.container = container;

    if (turns.length <= keepLast) {
      const ghosts = cleanupGhostTurns(false);
      if (ghosts) logStatus(`Auto: armado. Mensagens: ${turns.length} (limite: ${keepLast}). Limpou ${ghosts} fantasmas.`);
      else logStatus(`Auto: armado. Mensagens: ${turns.length} (limite: ${keepLast}).`);
      return;
    }

    const seen = new Set();
    const toRemove = [];
    for (const turn of turns.slice(0, turns.length - keepLast)) {
      const root = turnRoot(turn);
      if (!seen.has(root)) {
        seen.add(root);
        toRemove.push(root);
      }
    }
    const parent = toRemove[0]?.parentElement || container || document.body;

    ensurePlaceholder(parent, toRemove.length, keepLast);
    state.pruneInFlight = true;

    let idx = 0;
    const total = toRemove.length;

    const step = () => {
      const limit = Math.min(total, idx + PRUNE_BATCH_SIZE);
      for (; idx < limit; idx++) {
        const node = toRemove[idx];
        if (node && node.isConnected) node.remove();
      }

      if (idx < total) {
        requestAnimationFrame(step);
        return;
      }

      state.pruneInFlight = false;
      const ghosts = cleanupGhostTurns(true);
      logStatus(`Podado: removi ${total} turns. Limpou ${ghosts} fantasmas. Mantive ${keepLast}.`);

      if (state.pruneNeedsRerun) {
        state.pruneNeedsRerun = false;
        prune(state.keepLast, true);
      }
    };

    requestAnimationFrame(step);
  }


  function schedulePrune() {
    if (!state.autoEnabled || state.pruneQueued) return;
    state.pruneQueued = true;

    const run = () => {
      state.pruneQueued = false;
      state.pruneTimer = null;
      state.pruneIdleId = null;
      prune(state.keepLast);
    };

    if (typeof requestIdleCallback === 'function') {
      state.pruneIdleId = requestIdleCallback(run, { timeout: PRUNE_IDLE_TIMEOUT_MS });
      return;
    }

    state.pruneTimer = setTimeout(run, 0);
  }

  function disconnectObservers() {
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
    if (state.retryTimer) { clearInterval(state.retryTimer); state.retryTimer = null; }
    if (state.pruneTimer) { clearTimeout(state.pruneTimer); state.pruneTimer = null; }
    if (state.pruneIdleId && typeof cancelIdleCallback === 'function') {
      cancelIdleCallback(state.pruneIdleId);
      state.pruneIdleId = null;
    }
    state.pruneQueued = false;
    state.pruneInFlight = false;
    state.pruneNeedsRerun = false;
    state.container = null;
  }

  function attachObserver(root) {
    if (!root) return;
    if (state.observer) state.observer.disconnect();
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList' && (r.addedNodes.length || r.removedNodes.length)) {
          schedulePrune();
          return;
        }
      }
    });
    obs.observe(root, { childList: true, subtree: true });
    state.observer = obs;
  }

  function setAuto(enabled, keepLast) {
    state.autoEnabled = enabled;
    state.keepLast = keepLast;

    disconnectObservers();

    if (!enabled) {
      logStatus('Auto: desligado.');
      return;
    }

    logStatus('Auto: aguardando o chat montar...');

    state.retryTimer = setInterval(() => {
      if (!state.autoEnabled) return;

      if (location.href !== state.lastUrl) {
        state.lastUrl = location.href;
        state.container = null;
        if (state.placeholderEl && state.placeholderEl.isConnected) state.placeholderEl.remove();
        state.placeholderEl = null;
      }

      const turns = findTurnsGlobal();
      if (!turns.length) return;

      const container = findContainerFromTurns(turns);
      if (container && state.container !== container) {
        state.container = container;
        attachObserver(container);
      }
      schedulePrune();
    }, 500);

  }

  function mountUI(initial) {
    if (document.getElementById('chatprune-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'chatprune-panel';

    const min = document.createElement('div');
    min.id = 'chatprune-min';
    min.textContent = '🗿';
    min.title = 'Abrir Chat Pruner';

    const box = document.createElement('div');
    box.id = 'chatprune-box';

    box.innerHTML = `
      <h4>Chat Pruner</h4>
      <div id="chatprune-meta">
        <div>Manter</div>
        <input id="chatprune-keep" type="number" min="5" max="200" step="1" />
      </div>
      <div id="chatprune-preset-row">
        <div>Modo</div>
        <select id="chatprune-preset">
          <option value="stable">Stable</option>
          <option value="balanced">Balanced</option>
          <option value="snappy">Snappy</option>
        </select>
      </div>
      <div id="chatprune-preset-hint"></div>
      <div id="chatprune-row">
        <button class="chatprune-btn" id="chatprune-prune">Podar</button>
        <button class="chatprune-btn" id="chatprune-clean">Limpar Fantasmas</button>
      </div>
      <div id="chatprune-toggle">
        <input type="checkbox" id="chatprune-auto" />
        <label for="chatprune-auto">Auto (poda sozinho)</label>
      </div>
      <div id="chatprune-status">Pronto.</div>
      <div id="chatprune-footer">
        <span class="chatprune-link" id="chatprune-minimize">Minimizar</span>
        <span class="chatprune-link" id="chatprune-reload">Recarregar</span>
      </div>
    `;

    panel.appendChild(box);
    panel.appendChild(min);
    document.documentElement.appendChild(panel);

    const notifyUiInteraction = () => {
      try {
        document.dispatchEvent(new CustomEvent('chatpruner:ui-interaction'));
      } catch { }
    };
    panel.addEventListener('pointerdown', notifyUiInteraction, true);
    panel.addEventListener('change', notifyUiInteraction, true);
    panel.addEventListener('keydown', (ev) => {
      const k = ev.key || '';
      if (k === 'Enter' || k === ' ' || k.startsWith('Arrow')) notifyUiInteraction();
    }, true);

    const keepInput = document.getElementById('chatprune-keep');
    const autoCk = document.getElementById('chatprune-auto');
    const presetSel = document.getElementById('chatprune-preset');
    const presetHintEl = document.getElementById('chatprune-preset-hint');

    keepInput.value = String(initial.keepLast);
    autoCk.checked = !!initial.auto;
    const activePreset = applyPagePreset(initial.tuningPreset);
    presetSel.value = activePreset;
    presetHintEl.textContent = presetHint(activePreset);

    document.getElementById('chatprune-prune').addEventListener('click', async () => {
      const keepLast = clampKeep(parseInt(keepInput.value, 10));
      keepInput.value = String(keepLast);
      await setSettings({ keepLast });
      state.keepLast = keepLast;
      prune(keepLast);
    });

    document.getElementById('chatprune-clean').addEventListener('click', () => {
      const removed = cleanupGhostTurns();
      logStatus(`Limpou ${removed} fantasmas (turns vazios).`);
    });

    autoCk.addEventListener('change', async () => {
      const keepLast = clampKeep(parseInt(keepInput.value, 10));
      keepInput.value = String(keepLast);
      const auto = autoCk.checked;
      await setSettings({ auto, keepLast });
      setAuto(auto, keepLast);
    });

    presetSel.addEventListener('change', async () => {
      const preset = applyPagePreset(presetSel.value);
      presetSel.value = preset;
      presetHintEl.textContent = presetHint(preset);
      await setSettings({ tuningPreset: preset });
      logStatus(`Modo ${preset} salvo. Clique em Recarregar para aplicar.`);
    });

    document.getElementById('chatprune-minimize').addEventListener('click', async () => {
      box.style.display = 'none';
      min.style.display = 'flex';
      await setSettings({ minimized: true });
    });

    min.addEventListener('click', async () => {
      min.style.display = 'none';
      box.style.display = 'block';
      await setSettings({ minimized: false });
    });

    document.getElementById('chatprune-reload').addEventListener('click', () => location.reload());

    if (initial.minimized) {
      box.style.display = 'none';
      min.style.display = 'flex';
    }
  }


  function installPreSendLightenHook() {
    const maybeLighten = () => {
      if (!state.autoEnabled) return;
      schedulePrune();
    };

    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return;
      const el = ev.target;
      if (!(el instanceof HTMLElement)) return;
      const inComposer = el.matches('textarea') || el.getAttribute('contenteditable') === 'true';
      if (!inComposer) return;
      maybeLighten();
    }, true);

    document.addEventListener('pointerdown', (ev) => {
      const el = ev.target;
      if (!(el instanceof Element)) return;
      const sendBtn = el.closest('button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="Enviar"]');
      if (!sendBtn) return;
      maybeLighten();
    }, true);
  }

  function init() {
    (async () => {
      const settings = await getSettings();
      settings.tuningPreset = normalizePreset(settings.tuningPreset);
      mountUI(settings);
      installPreSendLightenHook();
      if (settings.auto) setAuto(true, settings.keepLast);
      else logStatus('Pronto. (Use Podar ou ligue Auto)');
    })();
  }

  // debounce.js injection happens immediately above (document_start)
  // but UI needs DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
