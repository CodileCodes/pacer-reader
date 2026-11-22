'use strict';
/* Reader UI: page view, highlight, listen mode (phone voice), fast read mode, masks, settings. */
(function () {
  const $ = id => document.getElementById(id);
  const HL_COLORS = {
    Yellow: [255, 235, 59], Orange: [255, 140, 0], Phosphoric: [170, 255, 0], Green: [60, 200, 90],
    'Light blue': [110, 195, 255], 'Light purple': [190, 155, 255], Gray: [160, 160, 160],
  };
  const DEFAULTS = {
    mode: 'listen', rate: 1.0, voice: '', engine: 'ai', aiVoice: 'af_heart', setAt: 0, wpm: 300, chunk: 2, flash: true, ramp: true, skim: false, anchors: false,
    zoom: 1, theme: 'system', para: { color: 'Yellow', level: 35 }, sent: { color: 'Orange', level: 60 },
  };

  // ------------------------------------------------------------------ storage (every access guarded)
  const store = {
    get(k, d) { try { const v = localStorage.getItem('pdfr.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('pdfr.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  const saved = store.get('settings', {});
  const S = Object.assign({}, DEFAULTS, saved, { para: Object.assign({}, DEFAULTS.para, saved.para), sent: Object.assign({}, DEFAULTS.sent, saved.sent) });
  const saveSettings = () => { S.setAt = Date.now(); store.set('settings', S); try { Sync.schedule(); } catch (e) { /* sync not ready */ } };
  const getSyncSettings = () => { const d = {}; Sync.SETTING_KEYS.forEach(k => { d[k] = S[k]; }); return { updatedAt: S.setAt || 0, data: d }; };
  function applySyncSettings(r) { Object.assign(S, r.data || {}); S.setAt = r.updatedAt; store.set('settings', S); applyTheme(); refreshUI(); if (st.book) drawHighlight(); }

  // ------------------------------------------------------------------ state
  const st = { book: null, key: null, page: 0, pos: null, range: null, playing: false, scale: 1, maskMode: false, renderTok: 0, renderTask: null, name: '' };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const toast = msg => { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3500); };

  function loading(on, msg) { $('loading').textContent = msg || 'Opening the book...'; $('loading').hidden = !on; }

  // ------------------------------------------------------------------ theme + highlight colours
  function applyTheme() {
    const r = document.documentElement;
    if (S.theme === 'system') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', S.theme);
  }
  const isDark = () => S.theme === 'dark' || (S.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  function hlColor(kind) {
    const c = S[kind]; const rgb = HL_COLORS[c.color];
    return rgb ? `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(c.level / 100 * 0.9).toFixed(2)})` : null;
  }

  // ------------------------------------------------------------------ page rendering
  const cv = $('cv'), pageBox = $('pageBox'), hlLayer = $('hl'), maskLayer = $('masks'), scroller = $('scroller');
  async function renderPage(p) {
    const tok = ++st.renderTok;
    const page = await st.book.pdf.getPage(p + 1);
    const v1 = page.getViewport({ scale: 1 });
    st.scale = Math.max(0.2, (scroller.clientWidth - 12) / v1.width * S.zoom);
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const vp = page.getViewport({ scale: st.scale * dpr });
    if (st.renderTask) { try { st.renderTask.cancel(); await st.renderTask.promise; } catch (e) { /* cancelled */ } }
    if (tok !== st.renderTok) return false;
    cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
    const w = vp.width / dpr, h = vp.height / dpr;
    cv.style.width = pageBox.style.width = w + 'px';
    cv.style.height = pageBox.style.height = h + 'px';
    st.renderTask = page.render({ canvasContext: cv.getContext('2d'), viewport: vp });
    try { await st.renderTask.promise; } catch (e) { return false; }
    st.renderTask = null;
    return tok === st.renderTok;
  }

  async function showPage(p, keepScroll) {
    p = Math.max(0, Math.min(st.book.n - 1, p));
    st.page = p;
    $('pageNum').value = p + 1;
    const ok = await renderPage(p);
    if (!ok) return;
    if (!keepScroll && !(st.pos && st.pos[0] === p)) scroller.scrollTop = 0;
    await drawMasks();
    await drawHighlight();
    st.book.paragraphs(p + 1); // prepare the next page in the background
  }

  async function drawMasks() {
    maskLayer.textContent = '';
    const size = st.book.sizes.get(st.page) || await (async () => { await st.book.paragraphs(st.page); return st.book.sizes.get(st.page); })();
    if (!size) return;
    st.book.masks.forEach((m, i) => {
      if (!st.book.maskRects(st.page).includes(m.rect)) return;
      const d = document.createElement('div');
      d.className = 'mask'; d.dataset.i = i;
      const sc = st.scale;
      Object.assign(d.style, { left: m.rect[0] * size.W * sc + 'px', top: m.rect[1] * size.H * sc + 'px', width: (m.rect[2] - m.rect[0]) * size.W * sc + 'px', height: (m.rect[3] - m.rect[1]) * size.H * sc + 'px' });
      maskLayer.appendChild(d);
    });
  }

  function addRect(parent, r, color, cls) {
    const d = document.createElement('div');
    d.className = 'hlr ' + (cls || '');
    d.style.background = color;
    const sc = st.scale;
    Object.assign(d.style, { left: r.x0 * sc - 1 + 'px', top: r.y0 * sc - 1 + 'px', width: (r.x1 - r.x0) * sc + 2 + 'px', height: (r.y1 - r.y0) * sc + 2 + 'px' });
    parent.appendChild(d);
    return d;
  }

  let drawTok = 0;
  async function drawHighlight() {
    const tok = ++drawTok;
    hlLayer.textContent = '';
    if (!st.book || !st.pos || st.pos[0] !== st.page) return;
    let info;
    try { info = await st.book.sentence(st.pos); } catch (e) { return; }
    if (tok !== drawTok) return;
    const { sent, para } = info, pc = hlColor('para'), sc = hlColor('sent');
    if (pc) {
      const b = para.bbox;
      addRect(hlLayer, { x0: b.x0 - 3, y0: b.y0 - 3, x1: b.x1 + 3, y1: b.y1 + 3 }, pc);
    }
    let use = sent.rects;
    if (S.mode === 'fast') {
      if (st.range && st.range.key === st.pos.join(',')) {
        const ws = sent.words.slice(st.range.w0, st.range.w1);
        if (ws.length) use = global_lineRects(ws.flatMap(w => w.rects));
      }
      if (S.anchors) {
        const ac = isDark() ? 'rgba(160,160,255,.38)' : 'rgba(90,90,200,.32)';
        sent.words.forEach(w => { if (w.rects.length && w.t.replace(/\W/g, '').length >= 5) { const r = w.rects[0]; addRect(hlLayer, { x0: r.x0, y0: r.y0, x1: r.x0 + (r.x1 - r.x0) / 2, y1: r.y1 }, ac); } });
      }
    }
    let first = null;
    use.forEach(r => { if (sc) addRect(hlLayer, r, sc, 'strong'); if (!first) first = r; });
    const all = use.reduce((a, r) => a ? { x0: Math.min(a.x0, r.x0), y0: Math.min(a.y0, r.y0), x1: Math.max(a.x1, r.x1), y1: Math.max(a.y1, r.y1) } : { ...r }, null);
    if (all) keepVisible(all);
  }
  function global_lineRects(rects) {
    const groups = [];
    for (const r of rects) {
      const g = groups[groups.length - 1];
      if (g && Math.abs(r.y0 - g.y0) < 0.5 * Math.max(g.y1 - g.y0, 1)) groups[groups.length - 1] = { x0: Math.min(g.x0, r.x0), y0: Math.min(g.y0, r.y0), x1: Math.max(g.x1, r.x1), y1: Math.max(g.y1, r.y1) };
      else groups.push({ ...r });
    }
    return groups;
  }
  function keepVisible(r) {
    const top = r.y0 * st.scale, bottom = r.y1 * st.scale, vh = scroller.clientHeight;
    const rel0 = top - scroller.scrollTop, rel1 = bottom - scroller.scrollTop;
    if (rel0 < vh * 0.12 || rel1 > vh * 0.78) {
      scroller.scrollTo({ top: Math.max(0, top - vh * 0.3), behavior: S.mode === 'fast' ? 'auto' : 'smooth' });
    }
  }

  // a position inside the book changed (reading engines call this)
  async function focus(pos, range) {
    st.pos = pos; st.range = range ? { key: pos.join(','), w0: range[0], w1: range[1] } : null;
    if (pos[0] !== st.page) await showPage(pos[0], true); else await drawHighlight();
  }

  // ------------------------------------------------------------------ wake lock + lock-screen controls
  let wake = null;
  async function wakeOn() { try { if (navigator.wakeLock && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch (e) { wake = null; } }
  function wakeOff() { try { if (wake) wake.release(); } catch (e) { /* ignore */ } wake = null; }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && st.playing) wakeOn(); });
  function mediaSession() {
    try {
      if (!('mediaSession' in navigator)) return;
      navigator.mediaSession.metadata = new MediaMetadata({ title: st.name || 'PDF Reader', artist: S.mode === 'fast' ? 'Fast read' : 'Reading aloud' });
      navigator.mediaSession.setActionHandler('play', () => { if (!st.playing) togglePlay(); });
      navigator.mediaSession.setActionHandler('pause', () => { if (st.playing) togglePlay(); });
      navigator.mediaSession.setActionHandler('previoustrack', () => stepSentence(-1));
      navigator.mediaSession.setActionHandler('nexttrack', () => stepSentence(1));
    } catch (e) { /* optional */ }
  }

  // ------------------------------------------------------------------ listen mode (phone's own voice)
  const synth = window.speechSynthesis;
  let voices = [], listenTok = 0;
  function loadVoices() {
    if (!synth) return;
    voices = synth.getVoices().filter(v => /^en/i.test(v.lang)).sort((a, b) => (b.localService - a.localService) || a.name.localeCompare(b.name));
    const sel = $('voice');
    sel.textContent = '';
    if (!voices.length) { const o = document.createElement('option'); o.textContent = 'Phone default'; sel.appendChild(o); return; }
    voices.forEach(v => { const o = document.createElement('option'); o.value = v.voiceURI; o.textContent = `${v.name} (${v.lang})${v.localService ? '' : ' online'}`; sel.appendChild(o); });
    if (voices.some(v => v.voiceURI === S.voice)) sel.value = S.voice;
  }
  if (synth) { loadVoices(); synth.addEventListener('voiceschanged', loadVoices); }
  const pickVoice = () => voices.find(v => v.voiceURI === S.voice) || voices.find(v => v.localService) || voices[0] || null;

  function speak(text, tok, onBoundary) {
    return new Promise(resolve => {
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
      u.rate = S.rate;
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      u.onend = fin; u.onerror = fin;
      if (onBoundary) u.onboundary = e => onBoundary(e.charIndex);
      // safety net: some phone voices never fire "end"
      setTimeout(() => { if (!done && tok !== listenTok) fin(); }, 200);
      synth.speak(u);
    });
  }

  const usingAI = () => S.engine === 'ai' && AI.supported;
  async function textAt(pos) {
    const { sent } = await st.book.sentence(pos);
    const cont = await st.book.continuation(pos);
    return Engine.speechText(sent, cont && cont.sent);
  }
  async function prefetch(from, tok) {
    let pos = from;
    for (let i = 0; i < 2; i++) {
      const c = await st.book.continuation(pos);
      pos = await st.book.nextPos(c ? c.pos : pos);
      if (!pos || tok !== listenTok) return;
      const t = await textAt(pos);
      if (Engine.speakable(t)) AI.get(t, S.aiVoice, S.rate).catch(() => {});
    }
  }
  async function listenLoop(tok) {
    while (st.playing && tok === listenTok && st.pos) {
      const { sent, last } = await st.book.sentence(st.pos);
      const cont = await st.book.continuation(st.pos);
      const text = Engine.speechText(sent, cont && cont.sent);
      await focus(st.pos, null);
      if (tok !== listenTok) return;
      let switched = false, timer = 0;
      const swap = async () => { if (switched || tok !== listenTok || !cont) return; switched = true; await focus(cont.pos, null); };
      if (Engine.speakable(text) && usingAI()) {
        let a;
        try { a = await AI.get(text, S.aiVoice, S.rate); } catch (e) { if (tok === listenTok) { pausePlayback(); toast('AI voice failed: ' + e.message); } return; }
        if (tok !== listenTok) return;
        if (cont) timer = setTimeout(swap, (a.samples.length / a.rate) * (sent.text.length / text.length) * 1000);
        prefetch(st.pos, tok);
        await AI.play(a);
        clearTimeout(timer);
      } else if (Engine.speakable(text)) {
        if (cont) {
          const frac = sent.text.length / text.length, est = text.length / (14 * S.rate);
          timer = setTimeout(swap, est * frac * 1000);
        }
        await speak(text, tok, ci => { if (cont && ci >= sent.text.length) swap(); });
        clearTimeout(timer);
      }
      if (tok !== listenTok) return;
      await sleep((last ? 380 : 110) / Math.max(1, S.rate));
      const from = cont ? cont.pos : st.pos;
      const nx = await st.book.nextPos(from);
      if (tok !== listenTok) return;
      if (!nx) { endReached(); return; }
      st.pos = nx; saveProgress();
    }
  }

  // ------------------------------------------------------------------ fast read mode
  const HARD = /[.!?…]["'”)\]]*$/, SOFT = /[,;:—–)]["'”)\]]*$/, CITE = /^\[\d+(?:[,–\-]\s*\d+)*\][.,;]?$/;
  const visible = t => /\w/.test(t) && !CITE.test(t);
  function wordWeight(t) {
    const n = t.replace(/\W/g, '').length;
    let w = n <= 3 ? 0.85 : 1 + 0.08 * Math.max(0, n - 6);
    if (/\d/.test(t)) w += 0.3;
    if (HARD.test(t)) w += 0.9; else if (SOFT.test(t)) w += 0.4;
    return Math.min(w, 3.5);
  }
  const orpIndex = n => (n <= 1 ? 0 : n <= 5 ? 1 : n <= 9 ? 2 : n <= 13 ? 3 : 4);
  function orpSplit(word) {
    const m = /^(\W*)([\s\S]*?)(\W*)$/.exec(word), lead = m[1].length, core = m[2];
    if (!core) return [word, '', ''];
    const k = lead + orpIndex(core.length);
    return [word.slice(0, k), word[k], word.slice(k + 1)];
  }
  function zone(wpm) {
    if (wpm <= 350) return ['comfortable', 'good'];
    if (wpm <= 450) return ['comprehension drops', 'warn'];
    return ['skimming speed', 'bad'];
  }

  const fast = { running: false, tok: 0, pos: null, cur: null, sumW: 26, cntW: 20, shown: 0, acc: 0, t0: 0, tRamp: 0, timer: 0 };
  async function afterSentence(pos) {
    if (!S.skim) return st.book.nextPos(pos);
    const ps = await st.book.paragraphs(pos[0]);
    return pos[1] + 1 < ps.length ? [pos[0], pos[1] + 1, 0] : st.book.firstPos(pos[0] + 1);
  }
  async function plan(pos) {
    let [p, pa, s, w] = pos, words = [], n = 0, found = false;
    for (let guard = 0; guard < 100000; guard++) {
      let sent;
      try { sent = (await st.book.sentence([p, pa, s])).sent; } catch (e) { return null; }
      words = sent.words; n = words.length;
      while (w < n && !visible(words[w].t)) w++;
      if (w < n) { found = true; break; }
      const nx = await afterSentence([p, pa, s]);
      if (!nx) return null;
      [p, pa, s] = nx; w = 0;
    }
    if (!found) return null;
    let w1 = w, weight = 0, count = 0;
    while (w1 < n && count < S.chunk) {
      const t = words[w1].t; w1++;
      if (!visible(t)) continue;
      weight += wordWeight(t); count++;
      if (HARD.test(t) || SOFT.test(t)) break; // never run a chunk across a phrase boundary
    }
    while (w1 < n && !visible(words[w1].t)) w1++;
    let next;
    if (w1 >= n) {
      const nx = await afterSentence([p, pa, s]);
      next = nx ? [...nx, 0] : null;
      const plen = (await st.book.paragraphs(p))[pa].sentences.length;
      if (S.skim || s === plen - 1) weight += 0.8; // breathe at the end of a paragraph
    } else next = [p, pa, s, w1];
    return { p, pa, s, w0: w, w1, count, weight, next };
  }
  function effWpm(now) {
    if (!S.ramp) return S.wpm;
    return S.wpm * (0.6 + 0.4 * Math.min(1, Math.max(0, (now - fast.tRamp) / 1000) / 90));
  }
  function duration(info, now) {
    fast.sumW += info.weight; fast.cntW += info.count;
    return Math.max(0.04, 60 / effWpm(now) * info.weight / (fast.sumW / fast.cntW));
  }
  function fastStart(pos4) {
    clearTimeout(fast.timer);
    fast.pos = pos4; fast.running = true; fast.tok++; fast.t0 = performance.now(); fast.tRamp = fast.t0;
    fastTick(fast.tok);
  }
  function fastStop() {
    if (fast.running) fast.acc += performance.now() - fast.t0;
    fast.running = false; fast.tok++; clearTimeout(fast.timer);
  }
  async function fastTick(tok) {
    if (!fast.running || tok !== fast.tok) return;
    const info = await plan(fast.pos);
    if (!fast.running || tok !== fast.tok) return;
    if (!info) { endReached(); return; }
    fast.cur = [info.p, info.pa, info.s, info.w0];
    fast.shown += info.count;
    const t0 = performance.now(), dur = duration(info, t0);
    fast.pos = info.next || [info.p, info.pa, info.s, info.w1];
    const sent = (await st.book.sentence([info.p, info.pa, info.s])).sent;
    showFlash(sent.words.slice(info.w0, info.w1).map(w => w.t).filter(visible));
    await focus([info.p, info.pa, info.s], [info.w0, info.w1]);
    if (!fast.running || tok !== fast.tok) return;
    if (++fast.n % 8 === 0) { saveProgress(); updateStatus(); }
    fast.timer = setTimeout(() => fastTick(tok), Math.max(0, dur * 1000 - (performance.now() - t0)));
  }
  fast.n = 0;
  function effectiveAvg() {
    const el = fast.acc + (fast.running ? performance.now() - fast.t0 : 0);
    return el > 5000 && fast.shown ? fast.shown / (el / 60000) : 0;
  }

  // flash panel: the key letter of the longest word sits on the centre line
  const fctx = document.createElement('canvas').getContext('2d');
  function showFlash(words) {
    const box = $('flash'); if (box.hidden) return;
    const el = $('flashText');
    if (!words.length) { el.textContent = ''; return; }
    const text = words.join(' ');
    const li = words.reduce((b, w, i) => (w.length > words[b].length ? i : b), 0);
    const [b, ch, a] = orpSplit(words[li]);
    const k = words.slice(0, li).join(' ').length + (li ? 1 : 0) + b.length;
    const before = text.slice(0, k), mid = text.slice(k, k + 1), after = text.slice(k + 1);
    let size = 40;
    const fam = getComputedStyle(el).fontFamily, avail = box.clientWidth * 0.44;
    for (; size > 16; size -= 2) {
      fctx.font = `${size}px ${fam}`;
      if (Math.max(fctx.measureText(before).width, fctx.measureText(after).width + fctx.measureText(mid).width / 2) <= avail) break;
    }
    el.style.fontSize = size + 'px';
    el.children[0].textContent = before; el.children[1].textContent = mid; el.children[2].textContent = after;
  }

  // ------------------------------------------------------------------ transport
  function endReached() { pausePlayback(); toast('Reached the end of the book.'); }
  function stopEngines() {
    listenTok++; fastStop();
    try { if (synth) synth.cancel(); } catch (e) { /* ignore */ }
    try { AI.stop(); } catch (e) { /* ignore */ }
  }
  function setPlayUI() {
    $('btnPlay').classList.toggle('on', st.playing);
    $('btnPlay').setAttribute('aria-label', st.playing ? 'Pause' : 'Play');
    $('icPlay').hidden = st.playing; $('icPause').hidden = !st.playing;
  }
  function pausePlayback() {
    st.playing = false; stopEngines(); wakeOff(); setPlayUI(); saveProgress();
  }
  async function startPlayback(wordIdx) {
    if (!st.book) { $('file').click(); return; }
    if (S.mode === 'listen' && usingAI() && AI.state !== 'ready') {
      AI.unlock();
      if (AI.state === 'idle' || AI.state === 'error') { askDownload(); return; }
      toast('The AI voice is still loading...'); return;
    }
    if (S.mode === 'listen' && !usingAI() && !synth) { toast('This browser has no built-in voice. Use Fast read.'); return; }
    if (S.mode === 'listen' && usingAI()) AI.unlock();
    if (!st.pos || st.pos[0] !== st.page) {
      const fp = await st.book.firstPos(st.page);
      if (!fp) { toast('No readable text from this page on.'); return; }
      st.pos = fp;
    }
    stopEngines();
    st.playing = true; setPlayUI(); wakeOn(); mediaSession();
    if (S.mode === 'fast') {
      let w = wordIdx;
      if (w === undefined || w === null) w = fast.cur && fast.cur.slice(0, 3).join(',') === st.pos.join(',') ? fast.cur[3] : 0;
      fastStart([...st.pos, w]);
    } else {
      const tok = ++listenTok;
      await sleep(60); // some phones drop a speak() issued right after cancel()
      listenLoop(tok);
    }
  }
  function askDownload() {
    sheet('The AI voice needs a one-time download of about 90 MB. Use Wi-Fi if you can. It is kept on this device afterwards.', [
      ['Download AI voice', () => loadAI(true)], ['Use the phone voice instead', () => { S.engine = 'system'; saveSettings(); refreshUI(); }, 'ghost'], ['Cancel', null, 'ghost']]);
  }
  async function loadAI(thenPlay) {
    if (!AI.supported) { toast('This browser cannot run the AI voice.'); return; }
    if (AI.state === 'loading') return;
    $('aiStatus').textContent = 'Downloading the AI voice... 0%';
    try {
      await AI.init(p => { $('aiStatus').textContent = 'Downloading the AI voice... ' + p + '%'; if (S.mode === 'listen') $('status').textContent = 'AI voice: downloading ' + p + '%'; });
      $('aiStatus').textContent = 'AI voice is ready.'; updateStatus();
      if (thenPlay && st.book) startPlayback();
    } catch (e) {
      $('aiStatus').textContent = 'Could not load the AI voice: ' + e.message; toast('Could not load the AI voice. Check your connection.');
    }
  }
  function togglePlay() { if (st.playing) pausePlayback(); else startPlayback(); }
  async function stepSentence(d) {
    if (!st.book || !st.pos) return;
    const was = st.playing;
    const np = d > 0 ? await st.book.nextPos(st.pos) : await st.book.prevPos(st.pos);
    if (!np) return;
    if (was) stopEngines();
    st.pos = np; fast.cur = null;
    await focus(np, null);
    if (was) startPlayback(0); else saveProgress();
  }
  async function gotoPage(p) {
    if (!st.book) return;
    p = Math.max(0, Math.min(st.book.n - 1, p));
    const was = st.playing;
    if (was) stopEngines();
    const fp = await st.book.firstPos(p);
    if (fp && fp[0] === p) st.pos = fp;
    fast.cur = null; st.range = null;
    await showPage(p);
    if (was) startPlayback(0); else saveProgress();
  }

  // ------------------------------------------------------------------ progress
  function saveProgress() {
    if (!st.key || !st.pos) return;
    Library.update(st.key, { pos: st.pos });
  }
  function updateStatus() {
    const avg = effectiveAvg();
    $('status').textContent = S.mode === 'fast'
      ? `${S.wpm} wpm target${avg ? `, ${Math.round(avg)} average` : ''}`
      : `${usingAI() ? 'AI voice' : 'Phone voice'} ${S.rate.toFixed(2)}x${usingAI() && AI.slow ? ' (this phone is slow, try 1.0x or the phone voice)' : ''}`;
  }

  // ------------------------------------------------------------------ tap to start, masks
  const g = { down: null, band: null };
  pageBox.addEventListener('pointerdown', e => {
    if (!st.book) return;
    const r = pageBox.getBoundingClientRect();
    g.down = { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now(), id: e.pointerId, moved: false };
    if (st.maskMode) {
      pageBox.setPointerCapture(e.pointerId);
      g.band = document.createElement('div'); g.band.className = 'band'; maskLayer.appendChild(g.band);
    }
  });
  pageBox.addEventListener('pointermove', e => {
    if (!g.down) return;
    const r = pageBox.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (Math.hypot(x - g.down.x, y - g.down.y) > 8) g.down.moved = true;
    if (g.band) Object.assign(g.band.style, { left: Math.min(x, g.down.x) + 'px', top: Math.min(y, g.down.y) + 'px', width: Math.abs(x - g.down.x) + 'px', height: Math.abs(y - g.down.y) + 'px' });
  });
  pageBox.addEventListener('pointercancel', () => { if (g.band) g.band.remove(); g.band = null; g.down = null; });
  pageBox.addEventListener('pointerup', async e => {
    const d = g.down; g.down = null;
    if (!d || !st.book) return;
    const r = pageBox.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (st.maskMode) {
      if (g.band) g.band.remove(); g.band = null;
      const size = st.book.sizes.get(st.page); if (!size) return;
      if (d.moved && Math.abs(x - d.x) > 12 && Math.abs(y - d.y) > 8) {
        const rect = [Math.max(0, Math.min(x, d.x) / st.scale / size.W), Math.max(0, Math.min(y, d.y) / st.scale / size.H),
          Math.min(1, Math.max(x, d.x) / st.scale / size.W), Math.min(1, Math.max(y, d.y) / st.scale / size.H)];
        askScope(rect);
      } else {
        const nx = x / st.scale / size.W, ny = y / st.scale / size.H;
        const idx = st.book.masks.findIndex(m => st.book.maskRects(st.page).includes(m.rect) && nx >= m.rect[0] && nx <= m.rect[2] && ny >= m.rect[1] && ny <= m.rect[3]);
        if (idx >= 0) askRemove(idx);
      }
      return;
    }
    if (d.moved || performance.now() - d.t > 500) return; // a scroll or long press, not a tap
    const px = x / st.scale, py = y / st.scale;
    const paras = await st.book.paragraphs(st.page);
    for (let pa = 0; pa < paras.length; pa++) {
      const b = paras[pa].bbox;
      if (px < b.x0 - 4 || px > b.x1 + 4 || py < b.y0 - 4 || py > b.y1 + 4) continue;
      const hit = (rs) => rs.some(q => px >= q.x0 && px <= q.x1 && py >= q.y0 && py <= q.y1);
      let si = 0, wi = 0;
      paras[pa].sentences.forEach((s, i) => { if (hit(s.rects)) { si = i; s.words.forEach((w, j) => { if (hit(w.rects)) wi = j; }); } });
      stopEngines();
      st.pos = [st.page, pa, si]; fast.cur = null;
      await focus(st.pos, null);
      startPlayback(wi);
      return;
    }
  });

  function sheet(title, buttons) {
    $('actionTitle').textContent = title;
    const box = $('actionButtons'); box.textContent = '';
    buttons.forEach(([label, fn, cls]) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label; if (cls) b.className = cls;
      b.addEventListener('click', () => { $('action').hidden = true; if (fn) fn(); });
      box.appendChild(b);
    });
    $('action').hidden = false;
  }
  function askScope(rect) {
    const add = scope => { const m = { rect, scope }; if (scope === 'page') m.page = st.page; st.book.masks.push(m); applyMasks(); };
    sheet('Skip this box on which pages?', [
      ['All pages', () => add('all')], ['Odd pages (1, 3, 5...)', () => add('odd')], ['Even pages (2, 4, 6...)', () => add('even')],
      ['This page only', () => add('page')], ['Cancel', () => drawMasks(), 'ghost']]);
  }
  function askRemove(i) {
    sheet('Remove this mask?', [['Remove', () => { st.book.masks.splice(i, 1); applyMasks(); }, 'danger'], ['Keep', null, 'ghost']]);
  }
  async function applyMasks() {
    const was = st.playing; if (was) pausePlayback();
    Library.update(st.key, { masks: st.book.masks });
    st.book.setMasks(st.book.masks);
    fast.cur = null;
    if (st.pos) { try { await st.book.sentence(st.pos); } catch (e) { st.pos = await st.book.firstPos(st.page); } }
    await showPage(st.page, true);
  }

  // ------------------------------------------------------------------ opening a book
  async function openBook(meta, blob) {
    loading(true);
    pausePlayback();
    try {
      const buf = await blob.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
      const book = new Engine.Book(pdf);
      st.book = book; st.name = meta.name; st.key = meta.id;
      book.masks = (meta.masks || []).slice();
      $('pageTotal').textContent = '/ ' + book.n;
      $('docName').textContent = meta.title || meta.name;
      document.title = (meta.title || meta.name) + ' - Pacer Reader';
      await book.scanNoise();
      let pos = null;
      if (meta.pos) { try { await book.sentence(meta.pos); pos = meta.pos; } catch (e) { pos = null; } }
      st.pos = pos || await book.firstPos(0);
      st.range = null; fast.cur = null; fast.shown = 0; fast.acc = 0;
      $('stage').hidden = false;
      await showPage(st.pos ? st.pos[0] : 0);
      if (!st.pos) toast('No selectable text found. Scanned books need OCR, which is only in the laptop version.');
    } catch (e) {
      console.error(e);
      toast('Could not open that PDF.');
    }
    loading(false);
    updateStatus();
  }
  function closeBook() { pausePlayback(); st.book = null; st.key = null; st.pos = null; }

  // ------------------------------------------------------------------ settings sheet wiring
  function fillColors(sel) { Object.keys(HL_COLORS).forEach(c => { const o = document.createElement('option'); o.textContent = c; sel.appendChild(o); }); }
  function refreshUI() {
    document.body.dataset.mode = S.mode;
    $('modeListen').setAttribute('aria-pressed', S.mode === 'listen');
    $('modeFast').setAttribute('aria-pressed', S.mode === 'fast');
    $('flash').hidden = !(S.mode === 'fast' && S.flash);
    $('wpm').value = S.wpm; $('rate').value = S.rate; $('rateVal').textContent = S.rate.toFixed(2) + 'x';
    $('chunk').value = S.chunk;
    ['flashOpt', 'rampOpt', 'skimOpt', 'anchorOpt'].forEach(id => { $(id).checked = S[{ flashOpt: 'flash', rampOpt: 'ramp', skimOpt: 'skim', anchorOpt: 'anchors' }[id]]; });
    const [label, cls] = zone(S.wpm);
    $('zone').textContent = label; $('zone').dataset.z = cls; $('zoneDock').textContent = S.mode === 'fast' ? label : ''; $('zoneDock').dataset.z = cls;
    $('speedVal').textContent = S.mode === 'fast' ? S.wpm + ' wpm' : S.rate.toFixed(1) + 'x';
    $('theme').value = S.theme;
    $('engine').value = S.engine; $('aiVoice').value = S.aiVoice;
    document.body.dataset.engine = usingAI() ? 'ai' : 'system';
    $('aiStatus').textContent = AI.state === 'ready' ? 'AI voice is ready.' : AI.state === 'loading' ? $('aiStatus').textContent : 'Not downloaded yet (about 90 MB, once).';
    ['para', 'sent'].forEach(k => { $(k + 'Color').value = S[k].color; $(k + 'Level').value = S[k].level; });
    updateStatus();
  }
  function setMode(m) {
    if (m === S.mode) return;
    const was = st.playing; pausePlayback();
    S.mode = m; saveSettings(); refreshUI();
    if (st.book) drawHighlight();
    if (m === 'fast') toast('Fast read: the voice is off.');
    if (was) toast('Paused. Press play to continue.');
  }
  function setWpm(v) { S.wpm = Math.max(100, Math.min(1200, Math.round(v / 25) * 25)); saveSettings(); refreshUI(); }
  function setRate(v) { S.rate = Math.max(0.5, Math.min(usingAI() ? 2 : 2.5, Math.round(v * 20) / 20)); saveSettings(); refreshUI(); if (st.playing && S.mode === 'listen') startPlayback(); }

  function bind() {
    fillColors($('paraColor')); fillColors($('sentColor'));
    const off = document.createElement('option'); off.textContent = 'Off'; $('paraColor').insertBefore(off, $('paraColor').firstChild);
    $('file').addEventListener('change', e => { const f = e.target.files[0]; if (f) Library.add(f); e.target.value = ''; });
    AI.VOICES.forEach(([id, label]) => { const o = document.createElement('option'); o.value = id; o.textContent = label; $('aiVoice').appendChild(o); });
    $('engine').addEventListener('change', e => { S.engine = e.target.value; saveSettings(); refreshUI(); if (st.playing) pausePlayback(); });
    $('aiVoice').addEventListener('change', e => { S.aiVoice = e.target.value; saveSettings(); AI.clearQueue && AI.state === 'ready' && AI.clearQueue(); if (st.playing && S.mode === 'listen') startPlayback(); });
    $('aiLoad').addEventListener('click', () => loadAI(false));
    $('prev').addEventListener('click', () => gotoPage(st.page - 1));
    $('next').addEventListener('click', () => gotoPage(st.page + 1));
    $('pageNum').addEventListener('change', e => gotoPage((parseInt(e.target.value, 10) || 1) - 1));
    $('btnPlay').addEventListener('click', togglePlay);
    $('btnBack').addEventListener('click', () => stepSentence(-1));
    $('btnFwd').addEventListener('click', () => stepSentence(1));
    $('modeListen').addEventListener('click', () => setMode('listen'));
    $('modeFast').addEventListener('click', () => setMode('fast'));
    $('slower').addEventListener('click', () => (S.mode === 'fast' ? setWpm(S.wpm - 25) : setRate(S.rate - 0.1)));
    $('faster').addEventListener('click', () => (S.mode === 'fast' ? setWpm(S.wpm + 25) : setRate(S.rate + 0.1)));
    $('btnMenu').addEventListener('click', () => { $('settings').hidden = false; });
    $('closeSettings').addEventListener('click', () => { $('settings').hidden = true; });
    $('scrim').addEventListener('click', () => { $('settings').hidden = true; });
    $('voice').addEventListener('change', e => { S.voice = e.target.value; saveSettings(); if (st.playing && S.mode === 'listen') startPlayback(); });
    $('rate').addEventListener('input', e => { S.rate = parseFloat(e.target.value); $('rateVal').textContent = S.rate.toFixed(2) + 'x'; });
    $('rate').addEventListener('change', () => { saveSettings(); refreshUI(); if (st.playing && S.mode === 'listen') startPlayback(); });
    $('wpm').addEventListener('change', e => setWpm(parseInt(e.target.value, 10) || 300));
    $('chunk').addEventListener('change', e => { S.chunk = parseInt(e.target.value, 10); saveSettings(); });
    [['flashOpt', 'flash'], ['rampOpt', 'ramp'], ['skimOpt', 'skim'], ['anchorOpt', 'anchors']].forEach(([id, k]) => {
      $(id).addEventListener('change', e => { S[k] = e.target.checked; saveSettings(); refreshUI(); if (st.book) drawHighlight(); });
    });
    $('theme').addEventListener('change', e => { S.theme = e.target.value; saveSettings(); applyTheme(); if (st.book) drawHighlight(); });
    ['para', 'sent'].forEach(k => {
      $(k + 'Color').addEventListener('change', e => { S[k].color = e.target.value; saveSettings(); if (st.book) drawHighlight(); });
      $(k + 'Level').addEventListener('input', e => { S[k].level = parseInt(e.target.value, 10); saveSettings(); if (st.book) drawHighlight(); });
    });
    const zoom = f => { S.zoom = Math.max(0.6, Math.min(3, S.zoom * f)); saveSettings(); if (st.book) showPage(st.page, true); };
    $('zoomOut').addEventListener('click', () => zoom(1 / 1.15));
    $('zoomIn').addEventListener('click', () => zoom(1.15));
    $('zoomFit').addEventListener('click', () => { S.zoom = 1; saveSettings(); if (st.book) showPage(st.page, true); });
    $('maskMode').addEventListener('click', () => {
      st.maskMode = !st.maskMode;
      $('maskMode').setAttribute('aria-pressed', st.maskMode);
      pageBox.classList.toggle('masking', st.maskMode);
      document.body.classList.toggle('masking', st.maskMode);
      if (st.maskMode) { $('settings').hidden = true; toast('Drag a box over a header or footer. Tap a box to remove it.'); }
    });
    $('clearMasks').addEventListener('click', () => {
      if (!st.book || !st.book.masks.length) { toast('No masks in this book.'); return; }
      sheet('Remove all masks from this book?', [['Remove all', () => { st.book.masks = []; applyMasks(); }, 'danger'], ['Keep', null, 'ghost']]);
    });
    // sync
    const syncUI = () => {
      $('syncState').textContent = Sync.status;
      $('syncRepo').value = Sync.repo || $('syncRepo').value;
      $('syncConnect').hidden = Sync.connected; $('syncNow').hidden = !Sync.connected; $('syncOff').hidden = !Sync.connected;
      $('syncToken').parentElement.hidden = Sync.connected; $('syncRepo').disabled = Sync.connected;
      $('libSync').dataset.on = Sync.connected ? '1' : '0';
      $('libSync').title = Sync.status;
    };
    window.__syncUI = syncUI;
    $('syncConnect').addEventListener('click', async () => {
      try { await Sync.connect($('syncRepo').value, $('syncToken').value); $('syncToken').value = ''; } catch (e) { toast(e.message); }
      syncUI();
    });
    $('syncNow').addEventListener('click', () => Sync.now());
    $('libSync').addEventListener('click', () => { if (Sync.connected) Sync.now(); else { $('settings').hidden = false; $('syncRepo').scrollIntoView(); } });
    $('syncOff').addEventListener('click', () => sheet('Disconnect sync on this device? Your books stay here.', [['Disconnect', () => { Sync.disconnect(); syncUI(); }, 'danger'], ['Keep', null, 'ghost']]));
    $('libSettings').addEventListener('click', () => { $('settings').hidden = false; });
    syncUI();
    document.addEventListener('keydown', e => {
      if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight' && e.ctrlKey) stepSentence(1);
      else if (e.key === 'ArrowLeft' && e.ctrlKey) stepSentence(-1);
      else if (e.key === 'ArrowRight') gotoPage(st.page + 1);
      else if (e.key === 'ArrowLeft') gotoPage(st.page - 1);
    });
    let rz = 0;
    window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (st.book) showPage(st.page, true); }, 250); });
  }

  // ------------------------------------------------------------------ start
  async function start() {
    applyTheme(); bind(); refreshUI();
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    Engine.loadDict('vendor/words.txt');
    try { if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {}); } catch (e) { /* optional */ }
    Library.init();
    Sync.init({
      status: v => { $('syncState').textContent = v; $('libSync').title = v; $('libSync').dataset.state = /failed|Could not/.test(v) ? 'bad' : /Syncing|Uploading|Downloading/.test(v) ? 'busy' : 'ok'; },
      changed: () => Library.render(),
      app: { getSettings: getSyncSettings, applySettings: applySyncSettings },
    });
    if (S.engine === 'ai' && AI.supported) { try { if (await caches.has('transformers-cache')) loadAI(false); } catch (e) { /* ignore */ } }
  }
  window.PDFR = { st, S, focus, showPage, plan, wordWeight, orpSplit, startPlayback, pausePlayback, setMode, openBook, closeBook, stepSentence, gotoPage, sheet, toast, loading };
  start();
})();
