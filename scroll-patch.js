/**
 * MAIN world, document_start.
 * 1) Coalesce scroll on Element targets only (no wheel, no window/document).
 * 2) Memoize document.cookie.split('; ').
 */
(() => {
  if (window.__chatPrunerScrollPatch) return;
  window.__chatPrunerScrollPatch = true;

  const proto = EventTarget.prototype;
  const origAdd = proto.addEventListener;
  const origRemove = proto.removeEventListener;
  const wraps = new WeakMap();

  // ponytail: Element-only — listeners bind before we can mark the thread scroller
  function shouldCoalesceScroll(target) {
    return typeof Element !== 'undefined' && target instanceof Element;
  }

  function wrapListener(listener) {
    if (typeof listener === 'function') {
      let w = wraps.get(listener);
      if (w) return w;
      let scheduled = false;
      w = function (...args) {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          listener.apply(this, args);
        });
      };
      wraps.set(listener, w);
      return w;
    }
    if (listener && typeof listener.handleEvent === 'function') {
      let w = wraps.get(listener);
      if (w) return w;
      let scheduled = false;
      w = {
        handleEvent(ev) {
          if (scheduled) return;
          scheduled = true;
          requestAnimationFrame(() => {
            scheduled = false;
            listener.handleEvent(ev);
          });
        },
      };
      wraps.set(listener, w);
      return w;
    }
    return listener;
  }

  function passiveOpts(options) {
    if (options == null) return { passive: true };
    if (typeof options === 'boolean') return { capture: options, passive: true };
    return { ...options, passive: true };
  }

  // ponytail: scroll only — wheel left alone (CodeMirror/ProseMirror/modals)
  proto.addEventListener = function (type, listener, options) {
    if (type === 'scroll' && shouldCoalesceScroll(this)) {
      return origAdd.call(this, type, wrapListener(listener), passiveOpts(options));
    }
    return origAdd.call(this, type, listener, options);
  };

  proto.removeEventListener = function (type, listener, options) {
    if (type === 'scroll' && listener != null) {
      const w = wraps.get(listener);
      if (w) origRemove.call(this, type, w, options);
    }
    return origRemove.call(this, type, listener, options);
  };

  try {
    const desc =
      Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') ||
      Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');
    if (!desc || typeof desc.get !== 'function') return;

    const origGet = desc.get;
    const origSet = desc.set;
    const TTL_MS = 250;
    let raw = null;
    let parts = null;
    let facade = null;
    let at = 0;

    function facadeFor(str) {
      const o = new String(str);
      o.split = function (sep, lim) {
        if ((sep === '; ' || sep === ';') && lim === undefined) return parts.slice();
        return String.prototype.split.call(String(str), sep, lim);
      };
      return o;
    }

    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true,
      enumerable: desc.enumerable,
      get() {
        const v = origGet.call(this);
        const now = performance.now();
        if (facade && v === raw && now - at < TTL_MS) return facade;
        raw = v;
        parts = v ? v.split('; ') : [];
        at = now;
        facade = facadeFor(v);
        return facade;
      },
      set(value) {
        raw = null;
        parts = null;
        facade = null;
        at = 0;
        if (typeof origSet === 'function') return origSet.call(this, value);
      },
    });
  } catch { /* ponytail: sealed env */ }
})();
