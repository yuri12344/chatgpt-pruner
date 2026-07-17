(() => {
  // ponytail: chain onload — net-guard must run before debounce wraps fetch
  function injectPageScripts(files, idx = 0) {
    if (idx >= files.length) return;
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL(files[idx]);
    script.async = false;
    script.onload = () => {
      script.remove();
      injectPageScripts(files, idx + 1);
    };
    script.onerror = () => injectPageScripts(files, idx + 1);
    (document.head || document.documentElement).appendChild(script);
  }
  injectPageScripts(['net-guard.js', 'debounce.js']);

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
  const HOT_TURNS = 2;
  // ponytail: Auto on + keep 6 — DOM prune is the main RunTask lever
  const DEFAULTS = {
    keepLast: 6,
    auto: true,
    minimized: false,
    tuningPreset: 'balanced',
    bridgeLog: false,
    bridgeTermMin: false,
    widgetHibernate: true,
    lowMotion: false,
    policyV2: false,
  };

  const BRIDGE_LOG_MAX_LINES = 200;

  const bridge = {
    port: null,
    enabled: false,
    termVisible: false,
    termMin: false,
    lastToken: '',
    convLabel: '',
    lineCount: 0,
    navInstalled: false,
  };

  const state = {
    placeholderEl: null,
    observer: null,
    bootObserver: null,
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
    pruneNeedsRerun: false,
    widgetHibernate: true,
    lowMotion: false,
  };

  const THROTTLE_MS = 400;
  const PRUNE_IDLE_TIMEOUT_MS = 160;
  const PRUNE_BATCH_SIZE = 12;
  const GHOST_CLEANUP_EVERY_MS = 8000;
  const TURN_NODE_SEL = 'article[data-testid^="conversation-turn-"], section[data-testid^="conversation-turn-"]';

  function qs(sel, root = document) { return root.querySelector(sel); }
  function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

  function conversationIdFromUrl() {
    const m = location.pathname.match(/\/c\/([a-f0-9-]+)/i);
    return m ? m[1] : '';
  }

  function setBridgeStatus(text) {
    const el = document.getElementById('chatprune-bridge-status');
    if (el) el.textContent = text;
    const term = document.getElementById('chatprune-terminal');
    if (term) term.dataset.state = text;
  }

  function showBridgeTerminal(show = true) {
    bridge.termVisible = show;
    const term = document.getElementById('chatprune-terminal');
    const tab = document.getElementById('chatprune-term-tab');
    if (!term || !tab) return;
    if (!bridge.enabled || !show) {
      term.hidden = true;
      tab.hidden = !bridge.enabled || !bridge.termMin;
      return;
    }
    bridge.termMin = false;
    term.hidden = false;
    tab.hidden = true;
  }

  function minimizeBridgeTerminal() {
    bridge.termMin = true;
    const term = document.getElementById('chatprune-terminal');
    const tab = document.getElementById('chatprune-term-tab');
    if (term) term.hidden = true;
    if (tab && bridge.enabled) tab.hidden = false;
    void setSettings({ bridgeTermMin: true });
  }

  function clearBridgeLog() {
    const body = document.getElementById('chatprune-bridge-log');
    if (body) body.replaceChildren();
    bridge.lineCount = 0;
  }

  function appendBridgeLine(text, kind = 'stdout') {
    if (!bridge.enabled || !text) return;
    showBridgeTerminal(true);
    const body = document.getElementById('chatprune-bridge-log');
    if (!body) return;
    const span = document.createElement('span');
    span.className = `cp-line cp-${kind}`;
    const chunk = kind === 'cmd' || kind === 'meta' ? `${text}\n` : text;
    span.textContent = chunk;
    body.appendChild(span);
    bridge.lineCount += (chunk.match(/\n/g) || []).length + (chunk.endsWith('\n') ? 0 : 1);
    while (bridge.lineCount > BRIDGE_LOG_MAX_LINES && body.firstChild) {
      const first = body.firstChild;
      const t = first.textContent || '';
      bridge.lineCount -= (t.match(/\n/g) || []).length + (t.endsWith('\n') ? 0 : 1);
      first.remove();
    }
    body.scrollTop = body.scrollHeight;
  }

  function ensureBridgePort() {
    if (bridge.port) return bridge.port;
    try {
      bridge.port = chrome.runtime.connect({ name: 'bridge-log' });
      bridge.port.onMessage.addListener((msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'status') {
          setBridgeStatus(msg.message || msg.state || '…');
          return;
        }
        if (msg.type === 'line' && msg.text) {
          appendBridgeLine(msg.text, msg.kind || 'stdout');
        }
      });
      bridge.port.onDisconnect.addListener(() => {
        bridge.port = null;
        setBridgeStatus('disconnected');
      });
    } catch {
      setBridgeStatus('port failed');
    }
    return bridge.port;
  }

  function subscribeBridgeToken(viewToken, threadId = '', tool = '') {
    if (!bridge.enabled || !viewToken) return;
    bridge.lastToken = viewToken;
    bridge.convLabel = threadId || conversationIdFromUrl();
    const convEl = document.getElementById('chatprune-bridge-conv');
    if (convEl) {
      convEl.textContent = bridge.convLabel ? `~/thread/${bridge.convLabel.slice(0, 8)}` : '~/thread';
    }
    showBridgeTerminal(true);
    const port = ensureBridgePort();
    if (!port) return;
    setBridgeStatus('connecting');
    if (tool) appendBridgeLine(`# ${tool}`, 'meta');
    port.postMessage({ type: 'setToken', viewToken, threadId: bridge.convLabel });
  }

  function mountBridgeTerminal(initial) {
    if (document.getElementById('chatprune-terminal')) return;

    const term = document.createElement('div');
    term.id = 'chatprune-terminal';
    term.hidden = true;
    term.innerHTML = `
      <div class="cp-term-titlebar">
        <span class="cp-term-bullet" aria-hidden="true">•</span>
        <span class="cp-term-title">computer-use</span>
        <span id="chatprune-bridge-conv" class="cp-term-path">~/thread</span>
        <span id="chatprune-bridge-status" class="cp-term-status">idle</span>
        <span class="cp-term-actions">
          <button type="button" id="chatprune-term-clear" class="cp-term-btn" title="Clear">clear</button>
          <button type="button" id="chatprune-term-min" class="cp-term-btn" title="Minimize">−</button>
        </span>
      </div>
      <div id="chatprune-bridge-log" class="cp-term-body" role="log"></div>
    `;

    const tab = document.createElement('button');
    tab.type = 'button';
    tab.id = 'chatprune-term-tab';
    tab.hidden = true;
    tab.title = 'Open bridge terminal';
    tab.textContent = '>_ bridge';

    document.documentElement.appendChild(term);
    document.documentElement.appendChild(tab);

    document.getElementById('chatprune-term-clear')?.addEventListener('click', clearBridgeLog);
    document.getElementById('chatprune-term-min')?.addEventListener('click', minimizeBridgeTerminal);
    tab.addEventListener('click', () => {
      bridge.termMin = false;
      void setSettings({ bridgeTermMin: false });
      showBridgeTerminal(true);
    });

    bridge.termMin = !!initial.bridgeTermMin;
    if (bridge.enabled && !bridge.termMin) showBridgeTerminal(true);
    else if (bridge.enabled && bridge.termMin) {
      term.hidden = true;
      tab.hidden = false;
    }
  }

  function installBridgeLog() {
    if (!bridge.enabled) return;
    document.addEventListener('chatpruner:bridge-token', (ev) => {
      const d = ev?.detail;
      if (!d?.viewToken) return;
      subscribeBridgeToken(d.viewToken, d.threadId || '', d.tool || '');
    });

    if (bridge.navInstalled) return;
    bridge.navInstalled = true;
    const onNav = () => {
      const cid = conversationIdFromUrl();
      if (cid && cid !== bridge.convLabel) {
        bridge.convLabel = cid;
        const el = document.getElementById('chatprune-bridge-conv');
        if (el) el.textContent = cid ? `~/thread/${cid.slice(0, 8)}` : '~/thread';
      }
    };
    onNav();
    document.addEventListener('chatpruner:navigate', onNav);
    window.addEventListener('popstate', onNav);
  }

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
    return Math.max(4, Math.min(200, n));
  }

  function mirrorLowMotion(enabled) {
    document.documentElement.classList.toggle('chatpruner-low-motion', !!enabled);
    document.documentElement.classList.toggle('chatpruner-no-effects', !!enabled);
  }

  function markScrollTargets(container) {
    let el = container;
    for (let i = 0; i < 10 && el; i++) {
      if (el instanceof HTMLElement) el.dataset.chatprunerScroll = '1';
      el = el.parentElement;
    }
  }

  function hibernateTurnWidgets(root) {
    if (!state.widgetHibernate || !(root instanceof Element)) return 0;
    let n = 0;
    for (const iframe of root.querySelectorAll('iframe')) {
      if (iframe.dataset.prunerHibernated === '1') continue;
      const src = iframe.getAttribute('src') || iframe.src || '';
      const title = iframe.getAttribute('title') || iframe.getAttribute('aria-label') || 'widget';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chatprune-hibernated-widget';
      btn.textContent = `Hibernated: ${title} (click to restore)`;
      btn.dataset.prunerSrc = src;
      iframe.dataset.prunerHibernated = '1';
      iframe.replaceWith(btn);
      btn.addEventListener('click', () => {
        const neo = document.createElement('iframe');
        if (btn.dataset.prunerSrc) neo.src = btn.dataset.prunerSrc;
        neo.setAttribute('title', title);
        btn.replaceWith(neo);
      }, { once: true });
      n += 1;
    }
    return n;
  }

  function markColdTurns() {
    const turns = findTurnsGlobal();
    if (!turns.length) return;
    const hotStart = Math.max(0, turns.length - HOT_TURNS);
    let hibernated = 0;
    for (let i = 0; i < turns.length; i++) {
      const root = turnRoot(turns[i]);
      if (!(root instanceof HTMLElement)) continue;
      const cold = i < hotStart;
      root.classList.toggle('chatpruner-cold', cold);
      root.classList.toggle('chatpruner-hot', !cold);
      if (cold) {
        root.style.contentVisibility = 'auto';
        root.style.containIntrinsicSize = 'auto 480px';
        hibernated += hibernateTurnWidgets(root);
      } else {
        root.style.contentVisibility = '';
        root.style.containIntrinsicSize = '';
      }
    }
    if (hibernated) logStatus(`Hibernated ${hibernated} widget(s) in cold turns.`);
  }

  function normalizePreset(value) {
    const preset = String(value || '').trim().toLowerCase();
    return PRESET_VALUES.includes(preset) ? preset : DEFAULTS.tuningPreset;
  }

  function presetHint(preset) {
    if (preset === 'stable') return 'Most stable, less “live” feel.';
    if (preset === 'snappy') return 'Snappier, with more micro-jank risk.';
    return 'Balance between stability and responsiveness.';
  }

  function applyPagePreset(presetValue) {
    const preset = normalizePreset(presetValue);
    try { localStorage.setItem(PRESET_STORAGE_KEY, preset); } catch { }
    return preset;
  }

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

  function asTurnRoot(node) {
    if (!(node instanceof Element)) return null;
    if (node.classList?.contains('chatprune-placeholder')) return null;
    if (node.hasAttribute('data-turn-id-container')) return node;
    if (node.matches?.(TURN_NODE_SEL) || node.matches?.('[data-testid^="conversation-turn-"]')) {
      return turnRoot(node);
    }
    if (node.matches?.('article[data-turn], section[data-turn]')) return turnRoot(node);
    return null;
  }

  function ensurePlaceholder(parent, removedCount, keepLast) {
    if (state.placeholderEl && state.placeholderEl.isConnected) {
      state.placeholderEl.textContent = `🗿 ${removedCount} older messages removed (visible: ${keepLast})`;
      return state.placeholderEl;
    }
    const ph = document.createElement('div');
    ph.className = 'chatprune-placeholder';
    ph.textContent = `🗿 ${removedCount} older messages removed (visible: ${keepLast})`;
    parent.insertBefore(ph, parent.firstChild);
    state.placeholderEl = ph;
    return ph;
  }

  function cleanupGhostTurns(force = false) {
    const now = Date.now();
    if (!force && now - state.lastGhostCleanupAt < GHOST_CLEANUP_EVERY_MS) return 0;
    state.lastGhostCleanupAt = now;

    let removed = 0;
    for (const t of qsa(TURN_NODE_SEL)) {
      const hasMarkdown = !!qs('div.markdown.prose', t);
      const text = (t.textContent || '').trim();
      if (!hasMarkdown && text.length === 0) {
        turnRoot(t).remove();
        removed++;
      }
    }

    // ponytail: project chats wrap each turn in div[data-turn-id-container]
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

    const keep = clampKeep(keepLast);
    const turns = findTurnsGlobal();
    if (!turns.length) {
      logStatus('Auto: waiting for chat to load...');
      return;
    }

    const container = state.container || findContainerFromTurns(turns);
    if (container) state.container = container;

    if (turns.length <= keep) {
      markColdTurns();
      const ghosts = cleanupGhostTurns(false);
      if (ghosts) logStatus(`Auto: on. Messages: ${turns.length} (limit: ${keep}). Cleared ${ghosts} ghosts.`);
      else logStatus(`Auto: on. Messages: ${turns.length} (limit: ${keep}).`);
      return;
    }

    const seen = new Set();
    const toRemove = [];
    for (const turn of turns.slice(0, turns.length - keep)) {
      const root = turnRoot(turn);
      if (!seen.has(root)) {
        seen.add(root);
        toRemove.push(root);
      }
    }
    const parent = toRemove[0]?.parentElement || container || document.body;

    ensurePlaceholder(parent, toRemove.length, keep);
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
      markColdTurns();
      const ghosts = cleanupGhostTurns(true);
      logStatus(`Pruned ${total} turns. Cleared ${ghosts} ghosts. Kept ${keep}.`);

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
    if (state.bootObserver) { state.bootObserver.disconnect(); state.bootObserver = null; }
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

  function onNavigated() {
    if (state.placeholderEl && state.placeholderEl.isConnected) state.placeholderEl.remove();
    state.placeholderEl = null;
    state.container = null;
    if (state.autoEnabled) startWatching();
  }

  function attachObserver(root) {
    if (!root) return;
    if (state.observer) state.observer.disconnect();
    const obs = new MutationObserver((records) => {
      if (location.href !== state.lastUrl) {
        state.lastUrl = location.href;
        onNavigated();
        return;
      }
      let dirty = false;
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (asTurnRoot(node)) dirty = true;
        }
        if (r.removedNodes.length) dirty = true;
      }
      if (dirty) schedulePrune();
    });
    // ponytail: direct children only — if ChatGPT nests turns deeper, re-find container / subtree
    obs.observe(root, { childList: true, subtree: false });
    state.observer = obs;
  }

  function startWatching() {
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
    if (state.bootObserver) { state.bootObserver.disconnect(); state.bootObserver = null; }
    if (!state.autoEnabled) return;

    const tryAttach = () => {
      const turns = findTurnsGlobal();
      if (!turns.length) return false;
      const container = findContainerFromTurns(turns);
      if (!container) return false;
      state.container = container;
      markScrollTargets(container);
      attachObserver(container);
      prune(state.keepLast, true); // markColdTurns runs when prune finishes
      return true;
    };

    if (tryAttach()) return;

    logStatus('Auto: waiting for chat to load...');
    const boot = new MutationObserver(() => {
      if (tryAttach()) {
        boot.disconnect();
        state.bootObserver = null;
      }
    });
    boot.observe(document.documentElement, { childList: true, subtree: true });
    state.bootObserver = boot;
  }

  function setAuto(enabled, keepLast) {
    state.autoEnabled = enabled;
    state.keepLast = clampKeep(keepLast);

    if (!enabled) {
      disconnectObservers();
      logStatus('Auto: off.');
      return;
    }

    startWatching();
  }

  function mountUI(initial) {
    if (document.getElementById('chatprune-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'chatprune-panel';

    const min = document.createElement('div');
    min.id = 'chatprune-min';
    min.textContent = '🗿';
    min.title = 'Open Chat Pruner';

    const box = document.createElement('div');
    box.id = 'chatprune-box';

    box.innerHTML = `
      <h4>Chat Pruner</h4>
      <div id="chatprune-meta">
        <div>Keep</div>
        <input id="chatprune-keep" type="number" min="4" max="200" step="1" />
      </div>
      <div id="chatprune-preset-row">
        <div>Preset</div>
        <select id="chatprune-preset">
          <option value="stable">Stable</option>
          <option value="balanced">Balanced</option>
          <option value="snappy">Snappy</option>
        </select>
      </div>
      <div id="chatprune-preset-hint"></div>
      <div id="chatprune-row">
        <button class="chatprune-btn" id="chatprune-prune">Prune</button>
        <button class="chatprune-btn" id="chatprune-clean">Clear Ghosts</button>
      </div>
      <div class="chatprune-toggle-row">
        <input type="checkbox" id="chatprune-auto" />
        <label for="chatprune-auto">Auto (prune on its own)</label>
      </div>
      <div class="chatprune-toggle-row">
        <input type="checkbox" id="chatprune-hibernate" />
        <label for="chatprune-hibernate">Hibernate old widgets</label>
      </div>
      <div class="chatprune-toggle-row">
        <input type="checkbox" id="chatprune-low-motion" />
        <label for="chatprune-low-motion">Low motion / no FX</label>
      </div>
      <div class="chatprune-toggle-row">
        <input type="checkbox" id="chatprune-bridge-log-toggle" />
        <label for="chatprune-bridge-log-toggle">Bridge terminal</label>
      </div>
      <div id="chatprune-bridge-row">
        <button type="button" class="chatprune-btn chatprune-btn-ghost" id="chatprune-open-term">Open terminal</button>
      </div>
      <div id="chatprune-status">Ready.</div>
      <div id="chatprune-footer">
        <span class="chatprune-link" id="chatprune-minimize">Minimize</span>
        <span class="chatprune-link" id="chatprune-reload">Reload</span>
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
    const bridgeCk = document.getElementById('chatprune-bridge-log-toggle');
    const openTermBtn = document.getElementById('chatprune-open-term');
    const hibernateCk = document.getElementById('chatprune-hibernate');
    const lowMotionCk = document.getElementById('chatprune-low-motion');

    keepInput.value = String(initial.keepLast);
    autoCk.checked = !!initial.auto;
    bridge.enabled = !!initial.bridgeLog;
    if (bridgeCk) bridgeCk.checked = bridge.enabled;
    state.widgetHibernate = initial.widgetHibernate !== false;
    state.lowMotion = !!initial.lowMotion;
    if (hibernateCk) hibernateCk.checked = state.widgetHibernate;
    if (lowMotionCk) lowMotionCk.checked = state.lowMotion;
    mirrorLowMotion(state.lowMotion);
    const activePreset = applyPagePreset(initial.tuningPreset);
    presetSel.value = activePreset;
    presetHintEl.textContent = presetHint(activePreset);

    document.getElementById('chatprune-prune').addEventListener('click', async () => {
      const keepLast = clampKeep(parseInt(keepInput.value, 10));
      keepInput.value = String(keepLast);
      await setSettings({ keepLast });
      state.keepLast = keepLast;
      prune(keepLast, true);
    });

    document.getElementById('chatprune-clean').addEventListener('click', () => {
      const removed = cleanupGhostTurns(true);
      logStatus(`Cleared ${removed} ghosts (empty turns).`);
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
      logStatus(`Preset ${preset} saved. Click Reload to apply.`);
    });

    hibernateCk?.addEventListener('change', async () => {
      state.widgetHibernate = !!hibernateCk.checked;
      await setSettings({ widgetHibernate: state.widgetHibernate });
      markColdTurns();
    });

    lowMotionCk?.addEventListener('change', async () => {
      state.lowMotion = !!lowMotionCk.checked;
      mirrorLowMotion(state.lowMotion);
      await setSettings({ lowMotion: state.lowMotion });
    });

    bridgeCk?.addEventListener('change', async () => {
      bridge.enabled = !!bridgeCk.checked;
      await setSettings({ bridgeLog: bridge.enabled });
      if (bridge.enabled) {
        mountBridgeTerminal({ bridgeTermMin: bridge.termMin });
        installBridgeLog();
        showBridgeTerminal(true);
        if (bridge.lastToken) subscribeBridgeToken(bridge.lastToken);
      } else {
        if (bridge.port) {
          bridge.port.postMessage({ type: 'close' });
          bridge.port.disconnect();
          bridge.port = null;
        }
        showBridgeTerminal(false);
        const tab = document.getElementById('chatprune-term-tab');
        if (tab) tab.hidden = true;
        setBridgeStatus('off');
      }
    });

    openTermBtn?.addEventListener('click', () => {
      bridge.enabled = true;
      if (bridgeCk) bridgeCk.checked = true;
      void setSettings({ bridgeLog: true, bridgeTermMin: false });
      mountBridgeTerminal({ bridgeTermMin: false });
      installBridgeLog();
      showBridgeTerminal(true);
      if (bridge.lastToken) subscribeBridgeToken(bridge.lastToken);
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
      let settings = await getSettings();
      settings.tuningPreset = normalizePreset(settings.tuningPreset);
      // one-shot: Auto on + Keep 6 for upgrades that still had Auto off
      if (!settings.policyV2) {
        settings = { ...settings, auto: true, keepLast: 6, policyV2: true };
        await setSettings({ auto: true, keepLast: 6, policyV2: true });
      }
      state.widgetHibernate = settings.widgetHibernate !== false;
      state.lowMotion = !!settings.lowMotion;
      mirrorLowMotion(state.lowMotion);
      mountUI(settings);
      if (settings.bridgeLog) {
        mountBridgeTerminal(settings);
        installBridgeLog();
      }
      installPreSendLightenHook();
      if (settings.auto) setAuto(true, settings.keepLast);
      else logStatus('Ready. (Use Prune or enable Auto)');
    })();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
