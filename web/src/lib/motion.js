// Small rAF-driven motion helpers shared across panels. Every helper is a
// no-op under prefers-reduced-motion or Theme Studio's data-anim='off', so
// the existing motion contract still holds: designed, never forced.

export function reduced() {
  if (typeof window === 'undefined') return true;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return true;
  return document.documentElement.dataset.anim === 'off';
}

/**
 * rAF tween from `from` to `to` with cubic-out easing.
 * Returns a cancel function. Calls onFrame with the eased value each frame.
 */
export function tween(from, to, duration, onFrame, onDone) {
  if (reduced() || duration <= 0 || from === to) {
    onFrame(to);
    onDone?.();
    return () => {};
  }
  const t0 = performance.now();
  let raf = 0;
  let cancelled = false;
  function frame(now) {
    if (cancelled) return;
    const p = Math.min(1, (now - t0) / duration);
    const e = 1 - Math.pow(1 - p, 3);
    onFrame(from + (to - from) * e);
    if (p < 1) raf = requestAnimationFrame(frame);
    else onDone?.();
  }
  raf = requestAnimationFrame(frame);
  return () => {
    cancelled = true;
    cancelAnimationFrame(raf);
  };
}

/**
 * Smoothly scroll `el` toward `top`. Long glides get a custom rAF tween
 * (native smooth scrolling is inconsistent across browsers and distances);
 * any user wheel/touch input cancels it instantly so we never fight the user.
 */
export function smoothScrollTo(el, top, duration = 420) {
  if (!el) return;
  const max = el.scrollHeight - el.clientHeight;
  const target = Math.max(0, Math.min(top, max));
  const from = el.scrollTop;
  if (Math.abs(target - from) < 2) return;
  const stop = () => cancel();
  const cancel = tween(from, target, duration, (v) => { el.scrollTop = v; }, () => {
    el.removeEventListener('wheel', stop);
    el.removeEventListener('touchstart', stop);
  });
  el.addEventListener('wheel', stop, { passive: true, once: true });
  el.addEventListener('touchstart', stop, { passive: true, once: true });
}

/**
 * Svelte action: fade an element in (opacity only — no transform, so
 * click targets never move) the first time it enters the viewport.
 * `opts.delay` staggers siblings via --rv-delay.
 */
export function reveal(node, opts = {}) {
  if (reduced() || typeof IntersectionObserver === 'undefined') return {};
  node.classList.add('rv');
  if (opts.delay) node.style.setProperty('--rv-delay', `${opts.delay}ms`);
  const io = new IntersectionObserver((ents) => {
    for (const e of ents) {
      if (e.isIntersecting) {
        node.classList.add('rv-in');
        io.unobserve(node);
      }
    }
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.04 });
  io.observe(node);
  return { destroy() { io.disconnect(); } };
}

/** Svelte action for <img>: fade in once the bitmap is actually decoded. */
export function imgFade(node) {
  node.classList.add('imgload');
  const done = () => node.classList.add('imgdone');
  if (node.complete && node.naturalWidth > 0) { done(); return {}; }
  node.addEventListener('load', done, { once: true });
  node.addEventListener('error', done, { once: true });
  return {
    destroy() {
      node.removeEventListener('load', done);
      node.removeEventListener('error', done);
    },
  };
}

/**
 * Svelte action on a scroll container: toggles sf-top / sf-bot classes as
 * content scrolls under the edges, so CSS can paint soft fade masks that
 * only appear when there is actually more to scroll.
 */
export function scrollFade(node, opts = {}) {
  let raf = 0;
  const topPad = opts.top === false ? 0 : 14;
  const botPad = opts.bottom === false ? 0 : 14;
  function update() {
    raf = 0;
    const max = node.scrollHeight - node.clientHeight;
    if (max <= 8) {
      node.classList.remove('sf-top', 'sf-bot');
      return;
    }
    node.classList.toggle('sf-top', topPad > 0 && node.scrollTop > 4);
    node.classList.toggle('sf-bot', botPad > 0 && node.scrollTop < max - 4);
  }
  function onScroll() { if (!raf) raf = requestAnimationFrame(update); }
  const ro = new ResizeObserver(onScroll);
  ro.observe(node);
  node.addEventListener('scroll', onScroll, { passive: true });
  update();
  return {
    destroy() {
      ro.disconnect();
      node.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
