'use strict';
/* Sync through a private GitHub repo (Contents API): library.json (books, progress, masks, settings) and books/<id>.pdf.
   Per book, the newest change wins. Deleted books stay as tombstones so deletes travel too. */
window.Sync = (function () {
  const API = 'https://api.github.com';
  const MAX_PDF = 45 * 1024 * 1024;
  const FIELDS = ['title', 'author', 'name', 'size', 'pages', 'addedAt', 'updatedAt', 'pos', 'masks', 'coverUrl', 'coverNone', 'userTitle', 'deleted', 'file'];
  const SETTING_KEYS = ['rate', 'engine', 'aiVoice', 'wpm', 'chunk', 'flash', 'ramp', 'skim', 'anchors', 'theme', 'para', 'sent'];
  let cfg = load(), busy = false, again = false, timer = 0, status = cfg ? 'Not synced yet' : 'Not connected', hooks = {};
  function load() { try { const v = JSON.parse(localStorage.getItem('pdfr.sync') || 'null'); return v && v.repo && v.token ? v : null; } catch (e) { return null; } }
  function say(s) { status = s; if (hooks.status) hooks.status(s); }
  const b64dec = s => decodeURIComponent(escape(atob(s.replace(/\s/g, ''))));
  const b64enc = s => btoa(unescape(encodeURIComponent(s)));
  const blobToB64 = b => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(String(f.result).split(',')[1]); f.onerror = () => rej(f.error); f.readAsDataURL(b); });

  async function gh(method, path, body, accept) {
    const r = await fetch(API + '/repos/' + cfg.repo + path, {
      method,
      headers: Object.assign({ Authorization: 'Bearer ' + cfg.token, Accept: accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    return r;
  }
  async function httpError(r) {
    let m = ''; try { m = (await r.json()).message || ''; } catch (e) { /* */ }
    if (r.status === 401) return new Error('GitHub rejected the token. Make a new one and paste it again.');
    if (r.status === 403 || r.status === 429) return new Error('GitHub said slow down or no permission: ' + m);
    if (r.status === 404) return new Error('Repository not found, or the token cannot see it.');
    return new Error('GitHub error ' + r.status + (m ? ': ' + m : ''));
  }
  async function readLibrary() {
    const r = await gh('GET', '/contents/library.json');
    if (r.status === 404) {
      const root = await gh('GET', '');
      if (root.status === 404) throw await httpError(root);
      return { doc: { v: 1, settings: null, books: {} }, sha: null };
    }
    if (!r.ok) throw await httpError(r);
    const j = await r.json();
    let doc; try { doc = JSON.parse(b64dec(j.content)); } catch (e) { doc = { v: 1, settings: null, books: {} }; }
    doc.books = doc.books || {};
    return { doc, sha: j.sha };
  }
  async function writeLibrary(doc, sha) {
    const r = await gh('PUT', '/contents/library.json', { message: 'sync library', content: b64enc(JSON.stringify(doc)), sha: sha || undefined });
    if (r.status === 409 || r.status === 422) return 'conflict';
    if (!r.ok) throw await httpError(r);
    return 'ok';
  }
  const pick = (m) => { const o = {}; FIELDS.forEach(k => { if (m[k] !== undefined) o[k] = m[k]; }); return o; };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /** Pure merge of one device's books + settings with the remote doc. Exposed for tests. */
  function merge(localMetas, localSettings, remote) {
    const out = { v: 1, settings: remote.settings ? JSON.parse(JSON.stringify(remote.settings)) : null, books: JSON.parse(JSON.stringify(remote.books)) };
    const toLocal = [];
    const ids = new Set([...localMetas.map(m => m.id), ...Object.keys(remote.books)]);
    const lm = new Map(localMetas.map(m => [m.id, m]));
    ids.forEach(id => {
      const l = lm.get(id), r = remote.books[id];
      if (l && !r) { out.books[id] = pick(l); return; }
      if (!l && r) { toLocal.push(Object.assign({ id }, r)); return; }
      const lu = l.updatedAt || 0, ru = r.updatedAt || 0;
      if (lu > ru || (lu === ru && l.deleted && !r.deleted)) out.books[id] = Object.assign({}, r, pick(l));
      else if (ru > lu) toLocal.push(Object.assign({}, l, r, { id }));
      else if (!r.file && l.file) out.books[id] = Object.assign({}, r, { file: l.file });
      else if (r.file && !l.file) toLocal.push(Object.assign({}, l, { file: r.file }));
    });
    let settingsToLocal = null;
    const lsu = localSettings.updatedAt || 0, rsu = (remote.settings && remote.settings.updatedAt) || 0;
    if (lsu > rsu) out.settings = { updatedAt: lsu, data: localSettings.data };
    else if (rsu > lsu) settingsToLocal = remote.settings;
    return { out, toLocal, settingsToLocal };
  }

  async function uploadPdf(id, blob) {
    const path = '/contents/books/' + id + '.pdf';
    const content = await blobToB64(blob);
    let r = await gh('PUT', path, { message: 'add book', content });
    if (r.status === 422 || r.status === 409) {
      const g = await gh('GET', path);
      if (g.ok) { const j = await g.json(); return !!j.sha || true; }
    }
    if (!r.ok) throw await httpError(r);
    return true;
  }
  async function downloadPdf(id) {
    const r = await gh('GET', '/contents/books/' + id + '.pdf', null, 'application/vnd.github.raw+json');
    if (!r.ok) throw await httpError(r);
    return await r.blob();
  }
  async function deletePdf(id) {
    const path = '/contents/books/' + id + '.pdf';
    const g = await gh('GET', path);
    if (!g.ok) return;
    const j = await g.json();
    await gh('DELETE', path, { message: 'remove book', sha: j.sha });
  }

  async function run() {
    const DB = window.DB, app = hooks.app;
    for (let attempt = 0; attempt < 4; attempt++) {
      say('Syncing...');
      const { doc, sha } = await readLibrary();
      const before = JSON.stringify(doc);
      const metas = await DB.allMeta();
      const m = merge(metas, app.getSettings(), doc);
      for (const rec of m.toLocal) {
        const had = await DB.getMeta(rec.id);
        await DB.putMeta(Object.assign({}, had || {}, rec));
        if (rec.deleted) { await DB.delBlob(rec.id); await DB.delCover(rec.id); }
      }
      if (m.settingsToLocal) app.applySettings(m.settingsToLocal);
      // upload new local books before writing the library, so "file" is set when others see the book
      for (const l of await DB.allMeta()) {
        const r = m.out.books[l.id];
        if (!l.deleted && r && !r.file && await DB.hasBlob(l.id)) {
          if (l.size > MAX_PDF) { r.file = ''; r.tooBig = true; continue; }
          say('Uploading ' + (l.title || l.name) + '...');
          const blob = await DB.getBlob(l.id);
          await uploadPdf(l.id, blob);
          r.file = 'books/' + l.id + '.pdf';
          await DB.putMeta(Object.assign({}, l, { file: r.file }));
        }
      }
      if (JSON.stringify(m.out) !== before) {
        const res = await writeLibrary(m.out, sha);
        if (res === 'conflict') continue;
      }
      // remove files of deleted books
      let cleaned = false;
      for (const id in m.out.books) { const b = m.out.books[id]; if (b.deleted && b.file) { try { await deletePdf(id); b.file = ''; cleaned = true; } catch (e) { /* retry next time */ } } }
      if (cleaned) { const cur = await readLibrary(); Object.keys(m.out.books).forEach(id => { if (m.out.books[id].deleted && cur.doc.books[id]) cur.doc.books[id].file = ''; }); await writeLibrary(cur.doc, cur.sha); }
      hooks.changed && hooks.changed();
      // download books that other devices added
      for (const l of await DB.allMeta()) {
        if (l.deleted || !l.file || await DB.hasBlob(l.id)) continue;
        say('Downloading ' + (l.title || l.name) + '...');
        try { await DB.putBlob(l.id, await downloadPdf(l.id)); hooks.changed && hooks.changed(); } catch (e) { say('Could not download ' + (l.title || l.name)); }
      }
      cfg.last = Date.now(); localStorage.setItem('pdfr.sync', JSON.stringify(cfg));
      say('Synced ' + new Date(cfg.last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      return;
    }
    throw new Error('Two devices wrote at the same moment. Try again.');
  }
  async function now() {
    if (!cfg) return;
    if (busy) { again = true; return; }
    if (!navigator.onLine) { say('Offline. Will sync when you are back online.'); return; }
    busy = true;
    try { await run(); } catch (e) { say('Sync failed: ' + (e && e.message || e)); } finally { busy = false; }
    if (again) { again = false; schedule(2000); }
  }
  function schedule(ms) {
    if (!cfg) return;
    if (ms === undefined && timer) return; // keep the pending sync: reading changes progress every sentence
    clearTimeout(timer); timer = setTimeout(() => { timer = 0; now(); }, ms === undefined ? 12000 : ms);
  }
  function connect(repo, token) {
    repo = (repo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
    token = (token || '').trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Repository must look like yourname/pacer-sync');
    if (token.length < 20) throw new Error('Paste the whole token.');
    cfg = { repo, token }; localStorage.setItem('pdfr.sync', JSON.stringify(cfg));
    say('Connected. Syncing...'); return now();
  }
  function disconnect() { cfg = null; localStorage.removeItem('pdfr.sync'); clearTimeout(timer); say('Not connected'); }
  async function fetchBook(id) { // used when a card is tapped before its download finished
    const l = await window.DB.getMeta(id);
    if (!cfg || !l || !l.file) return null;
    const b = await downloadPdf(id); await window.DB.putBlob(id, b); return b;
  }
  window.addEventListener('online', () => schedule(1500));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(1000); else if (cfg) { clearTimeout(timer); timer = 0; now(); } });
  return {
    init(h) { hooks = h; if (cfg) schedule(800); }, now, schedule, connect, disconnect, fetchBook, merge, SETTING_KEYS,
    get connected() { return !!cfg; }, get repo() { return cfg ? cfg.repo : ''; }, get status() { return status; },
  };
})();
