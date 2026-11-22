'use strict';
/* Text engine: turns a PDF page into paragraphs > sentences > words with boxes.
   Skips page numbers, running headers/footers and contents pages, repairs "~" damage,
   joins hyphenated words, and applies user masks. */
(function (global) {
  const PAGENUM = /^\s*[-–—\[\(]*\s*(page\s*)?(\d{1,4}|[ivxlcdm]{1,7})(\s*(of|\/)\s*\d{1,4})?\s*[-–—\]\)]*\s*$/i;
  const HEADNUM = /^\s*\d{1,4}(?=\D)|(?<=\D)\d{1,4}\s*$/;
  const DOTS = /(?:\.\s?){5,}/;
  const END = /[.!?…]["'”’)\]]*$/;
  const STRAY = /^([^\w]*)([A-Za-z]{3,})\.([a-z]{1,2})([^\w.]*)$/;
  const MARGIN = 0.09;
  const ABBR = new Set(('mr mrs ms dr prof sr jr st vs etc e.g i.e fig no vol inc ltd co cf al approx dept mt gen col lt ' +
    'capt sgt rev hon jan feb mar apr jun jul aug sep sept oct nov dec ch pp p').split(' '));

  // ---------------------------------------------------------------- dictionary
  let DICT = null;
  async function loadDict(url) {
    DICT = new Map();
    try {
      const txt = await (await fetch(url)).text();
      txt.split('\n').forEach((w, i) => { w = w.trim(); if (w) DICT.set(w, i); });
    } catch (e) { /* the repair simply does less without a word list */ }
  }
  function freq(w) {
    if (!DICT) return 0;
    w = w.toLowerCase();
    if (w.length === 1 && w !== 'a' && w !== 'i') return 0;
    const r = DICT.get(w);
    return r === undefined ? 0 : 1 / (r + 1);
  }
  function hyphFreq(s) {
    const parts = s.split('-').filter(Boolean);
    return parts.length ? Math.min(...parts.map(freq)) : 0;
  }
  const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

  function fixCore(core) {
    if (core.endsWith('~') && ABBR.has(core.slice(0, -1).toLowerCase())) return core.slice(0, -1) + '.';
    if (core.endsWith('~') && core.length > 3 && hyphFreq(core.slice(0, -1)) > 0) return core.slice(0, -1) + ',';
    const idx = [];
    for (let i = 0; i < core.length; i++) if (core[i] === '~') idx.push(i);
    if (idx.length <= 2) {
      const combos = idx.length === 1 ? LETTERS.map(a => [a]) : LETTERS.flatMap(a => LETTERS.map(b => [a, b]));
      let best = null, bf = 0;
      for (const c of combos) {
        const arr = core.split('');
        idx.forEach((ix, k) => { arr[ix] = c[k]; });
        const cand = arr.join('');
        const f = hyphFreq(cand);
        if (f > bf) { bf = f; best = cand; }
      }
      if (best) return best;
    }
    const parts = core.split('~').filter(Boolean);
    if (parts.length >= 2 && parts.every(p => freq(p) > 0)) return parts.join(', ');
    return core.replace(/~/g, '');
  }

  function fixToken(tok) {
    const m0 = STRAY.exec(tok);
    if (m0 && DICT && DICT.size) {
      const left = m0[2], right = m0[3];
      if (freq(left) === 0 && freq(left + right) > 0) return m0[1] + left + right + m0[4];
    }
    if (!tok.includes('~')) return tok;
    const m = /^([^\p{L}\d_~]*)([\p{L}\d_~'\-]*)([^\p{L}\d_~]*)$/u.exec(tok);
    if (!m) return tok.replace(/~/g, '');
    if (!m[2].replace(/~/g, '')) return m[1] + m[3];
    return m[1] + fixCore(m[2]) + m[3];
  }

  // ---------------------------------------------------------------- sentences
  function isLower(ch) { return !!ch && ch === ch.toLowerCase() && ch !== ch.toUpperCase(); }
  function endsSentence(tok, nxt) {
    if (!END.test(tok)) return false;
    const core = tok.replace(/[.!?…"'”’)\]]+$/, '');
    if (tok.replace(/["'”’)\]]+$/, '').endsWith('.')) {
      if (ABBR.has(core.toLowerCase()) || /^[A-Z]$/.test(core) || /^(?:[A-Za-z]\.)+[A-Za-z]$/.test(core)) return false;
    }
    if (nxt === null) return true;
    const first = nxt.replace(/^["'“‘(\[]+/, '')[0];
    return !isLower(first);
  }
  function cleanForSpeech(t) {
    t = t.normalize('NFKC').replace(/­/g, '').replace(/[’‘]/g, "'");
    t = t.replace(/\[\d+(?:[,–\-]\s*\d+)*\]/g, '').replace(/https?:\/\/\S+/g, 'link');
    return t.replace(/\s+/g, ' ').trim();
  }
  function speechText(sent, cont) {
    let t = sent.text;
    if (cont) t = (t.endsWith('-') && t.length > 1) ? t.slice(0, -1) + cont.text : t + ' ' + cont.text;
    if (t && /[\p{L}\d]$/u.test(t)) t += '.';
    return t;
  }
  const speakable = t => /\w/.test(t);

  // ---------------------------------------------------------------- geometry
  function union(a, b) {
    return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
  }
  function lineRects(rects) {
    const groups = [];
    for (const r of rects) {
      const g = groups[groups.length - 1];
      if (g && Math.abs(r.y0 - g.y0) < 0.5 * Math.max(g.y1 - g.y0, 1)) groups[groups.length - 1] = union(g, r);
      else groups.push({ ...r });
    }
    return groups;
  }
  const normSig = t => t.replace(/\s+/g, ' ').trim().toLowerCase().replace(/\d+/g, '#');
  function dice(a, b) {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const grams = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.substr(i, 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
    const A = grams(a), B = grams(b);
    let hit = 0;
    for (const [g, c] of A) hit += Math.min(c, B.get(g) || 0);
    return 2 * hit / (a.length + b.length - 2);
  }
  const median = xs => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

  // ---------------------------------------------------------------- page text -> lines of words
  async function readLines(pdf, pno) {
    const page = await pdf.getPage(pno + 1);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (!it.str) continue;
      const m = pdfjsLib.Util.transform(vp.transform, it.transform);
      const fs = Math.hypot(m[2], m[3]);
      if (!fs || Math.abs(m[1]) > 0.2 * Math.abs(m[0])) continue; // skip rotated text
      items.push({ str: it.str, x: m[4], f: m[5], w: it.width * vp.scale, fs });
    }
    items.sort((a, b) => a.f - b.f);
    const raw = [];
    for (const it of items) {
      const last = raw[raw.length - 1];
      if (last && Math.abs(it.f - last.f) < 0.45 * Math.max(it.fs, last.fs)) { last.items.push(it); last.fs = Math.max(last.fs, it.fs); }
      else raw.push({ f: it.f, fs: it.fs, items: [it] });
    }
    const lines = [];
    for (const ln of raw) {
      ln.items.sort((a, b) => a.x - b.x);
      const words = [];
      let cur = null, prevEnd = null;
      const close = () => { if (cur) words.push(cur); cur = null; };
      for (const it of ln.items) {
        const n = it.str.length, cw = it.w / n;
        if (cur && prevEnd !== null && it.x - prevEnd > 0.28 * ln.fs) close();
        for (let i = 0; i < n; i++) {
          const ch = it.str[i], x0 = it.x + i * cw;
          if (/\s/.test(ch)) { close(); continue; }
          if (!cur) cur = { t: '', x0, x1: x0 + cw };
          cur.t += ch;
          cur.x1 = x0 + cw;
        }
        prevEnd = it.x + it.w;
      }
      close();
      if (words.length) {
        lines.push({ words, f: ln.f, fs: ln.fs, y0: ln.f - ln.fs * 0.85, y1: ln.f + ln.fs * 0.22, x0: words[0].x0, x1: words[words.length - 1].x1 });
      }
    }
    return { lines, W: vp.width, H: vp.height };
  }
  const lineText = ln => ln.words.map(w => w.t).join(' ');

  // ---------------------------------------------------------------- the book
  class Book {
    constructor(pdf) {
      this.pdf = pdf; this.n = pdf.numPages;
      this.cache = new Map(); this.noise = new Set(); this.masks = []; this.sizes = new Map();
    }
    async scanNoise() {
      const counts = new Map();
      const step = Math.max(1, Math.floor(this.n / 60));
      for (let p = 0; p < this.n; p += step) {
        try {
          const { lines, H } = await readLines(this.pdf, p);
          const seen = new Set();
          for (const ln of lines) if (this.inMargin(ln, H)) { const s = normSig(lineText(ln)); if (s) seen.add(s); }
          seen.forEach(s => counts.set(s, (counts.get(s) || 0) + 1));
        } catch (e) { /* ignore a bad page */ }
      }
      this.noise = new Set([...counts].filter(([, c]) => c >= 3).map(([s]) => s));
    }
    inMargin(ln, H) { return ln.y1 < H * MARGIN || ln.y0 > H * (1 - MARGIN); }
    dropLine(ln, H) {
      const text = lineText(ln), sig = normSig(text);
      if (!sig || DOTS.test(text)) return true;
      if (this.inMargin(ln, H)) {
        if (PAGENUM.test(text) || this.noise.has(sig)) return true;
        if (text.length <= 110 && ln.words.length <= 16 && HEADNUM.test(text)) return true;
        for (const s of this.noise) if (dice(sig, s) >= 0.88) return true;
      }
      return false;
    }
    setMasks(masks) { this.masks = masks; this.cache.clear(); }
    maskRects(p) {
      return this.masks.filter(m => m.scope === 'all' || (m.scope === 'odd' && (p + 1) % 2 === 1) ||
        (m.scope === 'even' && (p + 1) % 2 === 0) || (m.scope === 'page' && m.page === p)).map(m => m.rect);
    }
    paragraphs(p) {
      if (p < 0 || p >= this.n) return Promise.resolve([]);
      if (!this.cache.has(p)) this.cache.set(p, this.build(p).catch(e => { console.error(e); return []; }));
      return this.cache.get(p);
    }
    async build(p) {
      const { lines: all, W, H } = await readLines(this.pdf, p);
      this.sizes.set(p, { W, H });
      const rects = this.maskRects(p).map(r => [r[0] * W, r[1] * H, r[2] * W, r[3] * H]);
      let lines = all;
      if (rects.length) {
        lines = [];
        for (const ln of all) {
          const words = ln.words.filter(w => {
            const cx = (w.x0 + w.x1) / 2, cy = (ln.y0 + ln.y1) / 2;
            return !rects.some(r => r[0] <= cx && cx <= r[2] && r[1] <= cy && cy <= r[3]);
          });
          if (words.length) lines.push({ ...ln, words, x0: words[0].x0, x1: words[words.length - 1].x1 });
        }
      }
      const dots = lines.filter(l => DOTS.test(lineText(l))).length;
      if (dots >= 3 && dots >= 0.2 * lines.length) return []; // contents page
      const kept = lines.filter(l => !this.dropLine(l, H));
      if (!kept.length) return [];
      const dys = [];
      for (let i = 1; i < kept.length; i++) {
        const dy = kept[i].f - kept[i - 1].f;
        if (dy > 0.6 * kept[i].fs && dy < 2.8 * kept[i].fs) dys.push(dy);
      }
      const med = median(dys) || kept[0].fs * 1.25;
      const xs = kept.map(l => l.x0).sort((a, b) => a - b);
      const base = xs[Math.floor(xs.length / 4)];
      const blocks = [];
      let cur = [];
      for (const l of kept) {
        if (cur.length) {
          const prev = cur[cur.length - 1];
          const dy = l.f - prev.f;
          const prevEnds = END.test(prev.words[prev.words.length - 1].t);
          if (dy > 1.45 * med || (l.x0 - base > 1.0 * l.fs && prevEnds) || Math.abs(l.fs - prev.fs) > 0.15 * prev.fs) {
            blocks.push(cur); cur = [];
          }
        }
        cur.push(l);
      }
      if (cur.length) blocks.push(cur);
      const paras = [];
      for (const block of blocks) {
        const toks = this.tokens(block);
        if (!toks.length) continue;
        const prev = paras.length ? paras[paras.length - 1] : null;
        if (prev && !END.test(prev[prev.length - 1].t) && isLower(toks[0].t[0])) prev.push(...toks);
        else paras.push(toks);
      }
      return paras.map(t => this.makeParagraph(t));
    }
    tokens(block) {
      const ws = [];
      block.forEach((ln, li) => ln.words.forEach(w => ws.push({
        t: w.t.replace(/[\x00-\x08\x0b-\x1f\x7f­]/g, '-'), r: { x0: w.x0, y0: ln.y0, x1: w.x1, y1: ln.y1 }, li })));
      const out = [];
      for (let i = 0; i < ws.length; i++) {
        let { t } = ws[i];
        const rects = [ws[i].r];
        const nx = ws[i + 1];
        if (t.length > 1 && t.endsWith('-') && /\p{L}/u.test(t[t.length - 2]) && nx && nx.li !== ws[i].li && isLower(nx.t[0])) {
          t = t.slice(0, -1) + nx.t; rects.push(nx.r); i++;
        }
        t = fixToken(t);
        if (t) out.push({ t, rects });
      }
      while (out.length && ['.', ',', ';', ':', '|', "'", '`'].includes(out[0].t)) out.shift();
      return out;
    }
    makeParagraph(toks) {
      const sentences = [];
      let cur = [];
      toks.forEach((tok, i) => {
        cur.push(tok);
        const nxt = i + 1 < toks.length ? toks[i + 1].t : null;
        if (endsSentence(tok.t, nxt) || nxt === null) {
          const text = cleanForSpeech(cur.map(c => c.t).join(' '));
          const rects = lineRects(cur.flatMap(c => c.rects));
          sentences.push({ text, rects, open: nxt === null && !END.test(tok.t), words: cur });
          cur = [];
        }
      });
      let bbox = { ...sentences[0].rects[0] };
      sentences.forEach(s => s.rects.forEach(r => { bbox = union(bbox, r); }));
      return { bbox, sentences };
    }
    // navigation
    async firstPos(p) {
      for (; p >= 0 && p < this.n; p++) if ((await this.paragraphs(p)).length) return [p, 0, 0];
      return null;
    }
    async nextPos(pos) {
      const [p, pa, s] = pos, ps = await this.paragraphs(p);
      if (s + 1 < ps[pa].sentences.length) return [p, pa, s + 1];
      if (pa + 1 < ps.length) return [p, pa + 1, 0];
      return this.firstPos(p + 1);
    }
    async prevPos(pos) {
      const [p, pa, s] = pos;
      if (s > 0) return [p, pa, s - 1];
      if (pa > 0) { const ps = await this.paragraphs(p); return [p, pa - 1, ps[pa - 1].sentences.length - 1]; }
      for (let q = p - 1; q >= 0; q--) {
        const ps = await this.paragraphs(q);
        if (ps.length) return [q, ps.length - 1, ps[ps.length - 1].sentences.length - 1];
      }
      return null;
    }
    async sentence(pos) {
      const para = (await this.paragraphs(pos[0]))[pos[1]];
      return { sent: para.sentences[pos[2]], last: pos[2] === para.sentences.length - 1, para };
    }
    async continuation(pos) {
      const [p, pa, s] = pos, ps = await this.paragraphs(p);
      if (pa !== ps.length - 1 || s !== ps[pa].sentences.length - 1 || !ps[pa].sentences[s].open) return null;
      const np = await this.firstPos(p + 1);
      if (!np || np[0] !== p + 1) return null;
      const nb = (await this.sentence(np)).sent;
      return isLower(nb.text[0]) ? { pos: np, sent: nb } : null;
    }
  }

  global.Engine = { Book, loadDict, speechText, speakable, isLower, END };
})(window);
