'use strict';
/* AI voice (Kokoro-82M running in the browser). The model downloads once (~90 MB) and is cached by the browser. */
window.AI = (function () {
  const VOICES = [
    ['af_heart', 'Heart (US, female)'], ['af_bella', 'Bella (US, female)'], ['af_nicole', 'Nicole (US, female)'],
    ['af_sarah', 'Sarah (US, female)'], ['af_sky', 'Sky (US, female)'], ['am_adam', 'Adam (US, male)'],
    ['am_michael', 'Michael (US, male)'], ['bf_emma', 'Emma (UK, female)'], ['bf_isabella', 'Isabella (UK, female)'],
    ['bm_george', 'George (UK, male)'], ['bm_lewis', 'Lewis (UK, male)'],
  ];
  const supported = typeof Worker !== 'undefined' && (typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined');
  let worker = null, state = 'idle', initP = null, onProg = null, lastErr = '';
  const pending = new Map(), cache = new Map();
  let nextId = 1, ctx = null, cur = null, slowCount = 0, slow = false;

  const files = {};
  function progress(p) {
    if (!p || p.status !== 'progress' || !p.total) return;
    files[p.file] = { l: p.loaded, t: p.total };
    let l = 0, t = 0; for (const k in files) { l += files[k].l; t += files[k].t; }
    if (onProg && t) onProg(Math.min(100, Math.round(l / t * 100)));
  }
  function init(cb) {
    if (cb) onProg = cb;
    if (state === 'ready') return Promise.resolve();
    if (initP) return initP;
    state = 'loading'; lastErr = '';
    initP = new Promise((res, rej) => {
      try { worker = new Worker('ai-worker.js', { type: 'module' }); } catch (e) { state = 'error'; lastErr = String(e); initP = null; rej(e); return; }
      worker.onmessage = ev => {
        const m = ev.data;
        if (m.type === 'progress') progress(m.p);
        else if (m.type === 'ready') { state = 'ready'; res(); }
        else if (m.type === 'error') { state = 'error'; lastErr = m.message; initP = null; try { worker.terminate(); } catch (e) { /* */ } worker = null; rej(new Error(m.message)); }
        else if (m.type === 'audio') {
          const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
          const dur = m.samples.length / m.rate * 1000;
          if (m.ms > dur * 1.1) { if (++slowCount >= 3) slow = true; } else slowCount = 0;
          p.res({ samples: m.samples, rate: m.rate });
        } else if (m.type === 'fail') { const p = pending.get(m.id); if (p) { pending.delete(m.id); p.rej(new Error(m.message)); } }
      };
      worker.onerror = ev => { state = 'error'; lastErr = ev.message || 'worker failed'; initP = null; rej(new Error(lastErr)); };
      worker.postMessage({ type: 'init', dtype: 'q8' });
    });
    return initP;
  }
  const key = (t, v, s) => v + '|' + s + '|' + t;
  function get(text, voice, speed) {
    const k = key(text, voice, speed);
    if (cache.has(k)) return cache.get(k).p;
    const id = nextId++;
    const p = new Promise((res, rej) => { pending.set(id, { res, rej }); worker.postMessage({ type: 'gen', id, text, voice, speed }); });
    cache.set(k, { id, p });
    while (cache.size > 6) { const first = cache.keys().next().value; const e = cache.get(first); cache.delete(first); if (pending.has(e.id)) { pending.delete(e.id); worker.postMessage({ type: 'drop', id: e.id }); } }
    p.catch(() => cache.delete(k));
    return p;
  }
  function clearQueue() {
    cache.forEach(e => { if (pending.has(e.id)) { pending.delete(e.id); worker.postMessage({ type: 'drop', id: e.id }); } });
    cache.clear();
  }
  function unlock() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!ctx) ctx = new AC();
      if (ctx.state === 'suspended') ctx.resume();
    } catch (e) { /* no audio */ }
  }
  /** Plays samples; resolves when finished or stopped. */
  function play(a) {
    return new Promise(resolve => {
      unlock();
      const buf = ctx.createBuffer(1, a.samples.length, a.rate);
      buf.copyToChannel(a.samples, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(ctx.destination);
      cur = { src, resolve };
      src.onended = () => { if (cur && cur.src === src) cur = null; resolve(); };
      src.start();
    });
  }
  function stop() {
    if (cur) { const c = cur; cur = null; try { c.src.onended = null; c.src.stop(); } catch (e) { /* */ } c.resolve(); }
  }
  return { VOICES, supported, init, get, play, stop, unlock, clearQueue, get state() { return state; }, get error() { return lastErr; }, get slow() { return slow; } };
})();
