'use strict';
/* Library screen: cards with covers, progress, add / open / delete, cover lookup. Talks to DB, Covers, Sync and PDFR. */
window.Library = (function () {
  const $ = id => document.getElementById(id);
  const urls = new Map(); // object URLs for cover blobs
  const busyCover = new Set(), tried = new Set();
  let metas = [];

  async function sha(buf) {
    try { if (crypto && crypto.subtle) { const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf)); return Array.from(d.slice(0, 10), x => x.toString(16).padStart(2, '0')).join(''); } } catch (e) { /* fall through */ }
    let h = 2166136261 >>> 0; const u = new Uint8Array(buf);
    const step = Math.max(1, Math.floor(u.length / 200000));
    for (let i = 0; i < u.length; i += step) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
    return 'f' + h.toString(16) + u.length.toString(16);
  }
  function hue(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }

  async function update(id, patch, quiet) {
    const m = await DB.getMeta(id); if (!m) return null;
    Object.assign(m, patch); if (!quiet) m.updatedAt = Date.now();
    await DB.putMeta(m);
    if (!quiet) Sync.schedule();
    return m;
  }

  // ---------------------------------------------------------------- covers
  async function coverSrc(m) {
    if (urls.has(m.id)) return urls.get(m.id);
    const b = await DB.getCover(m.id);
    if (b) { const u = URL.createObjectURL(b); urls.set(m.id, u); return u; }
    return null;
  }
  async function findCover(m, force) {
    if (busyCover.has(m.id) || (!force && tried.has(m.id))) return;
    tried.add(m.id);
    if (!force && (m.coverNone && m.coverNone > Date.now() - 7 * 864e5)) return;
    if (!force && (await DB.getCover(m.id))) return;
    busyCover.add(m.id); render();
    try {
      const hit = await Covers.find(m.title || m.name, m.author);
      if (hit && hit.blob) {
        await DB.putCover(m.id, hit.blob);
        if (urls.has(m.id)) { URL.revokeObjectURL(urls.get(m.id)); urls.delete(m.id); }
        const patch = { coverUrl: hit.url, coverNone: 0 };
        if (hit.score >= 0.8 && hit.title && !m.userTitle) { patch.title = hit.title; if (hit.author && !m.author) patch.author = hit.author; }
        await update(m.id, patch);
      } else {
        await update(m.id, { coverNone: Date.now() }, true);
      }
    } catch (e) { /* offline: try again next time */ }
    busyCover.delete(m.id); render();
  }
  async function firstPageCover(m) {
    const blob = await DB.getBlob(m.id); if (!blob) { PDFR.toast('This book is not downloaded yet.'); return; }
    const pdf = await pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;
    const page = await pdf.getPage(1);
    const vp0 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: 360 / vp0.width });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const out = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
    await DB.putCover(m.id, out);
    if (urls.has(m.id)) { URL.revokeObjectURL(urls.get(m.id)); urls.delete(m.id); }
    await update(m.id, { coverUrl: 'page1', coverNone: 0 }, true);
    render();
  }

  // ---------------------------------------------------------------- rendering
  async function render() {
    metas = (await DB.allMeta()).filter(m => !m.deleted).sort((a, b) => (b.openedAt || b.addedAt || 0) - (a.openedAt || a.addedAt || 0));
    const grid = $('shelf'); grid.textContent = '';
    $('libEmpty').hidden = metas.length > 0;
    for (const m of metas) {
      if (!urls.has(m.id) && !m.coverNone && !tried.has(m.id) && navigator.onLine) setTimeout(() => findCover(m), 50);
      const has = await DB.hasBlob(m.id);
      const card = document.createElement('div'); card.className = 'card'; card.setAttribute('role', 'button'); card.tabIndex = 0;
      const cov = document.createElement('div'); cov.className = 'cover';
      const src = await coverSrc(m);
      if (src) { const im = document.createElement('img'); im.src = src; im.alt = ''; cov.appendChild(im); }
      else {
        cov.classList.add('gen'); const h = hue(m.title || m.name || m.id);
        cov.style.setProperty('--h', h);
        const t = document.createElement('span'); t.textContent = m.title || m.name; cov.appendChild(t);
        if (busyCover.has(m.id)) { const s = document.createElement('i'); s.className = 'spin'; cov.appendChild(s); }
      }
      if (!has) { const cl = document.createElement('b'); cl.className = 'cloud'; cl.textContent = m.file ? 'in cloud' : 'missing'; cov.appendChild(cl); }
      const pct = m.pages && m.pos ? Math.min(100, Math.round((m.pos[0] + 1) / m.pages * 100)) : 0;
      const bar = document.createElement('div'); bar.className = 'prog'; const fill = document.createElement('div'); fill.style.width = pct + '%'; bar.appendChild(fill);
      const t = document.createElement('div'); t.className = 'ct'; t.textContent = m.title || m.name;
      const a = document.createElement('div'); a.className = 'ca'; a.textContent = m.author ? m.author : (m.pages ? m.pages + ' pages' : '');
      const more = document.createElement('button'); more.type = 'button'; more.className = 'more'; more.setAttribute('aria-label', 'Book options');
      more.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>';
      more.addEventListener('click', e => { e.stopPropagation(); options(m); });
      card.append(cov, bar, t, a, more);
      card.addEventListener('click', () => open(m.id));
      card.addEventListener('keydown', e => { if (e.key === 'Enter') open(m.id); });
      grid.appendChild(card);
    }
  }
  function options(m) {
    PDFR.sheet(m.title || m.name, [
      ['Find cover again', () => findCover(m, true)],
      ['Use first page as cover', () => firstPageCover(m)],
      ['Delete from library', () => PDFR.sheet('Delete "' + (m.title || m.name) + '" from every synced device?', [['Delete', () => remove(m.id), 'danger'], ['Keep', null, 'ghost']]), 'danger'],
      ['Close', null, 'ghost'],
    ]);
  }
  async function remove(id) {
    await update(id, { deleted: true });
    await DB.delBlob(id); await DB.delCover(id);
    if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); }
    if (PDFR.st.key === id) { PDFR.closeBook(); }
    render(); Sync.schedule(1500);
  }

  // ---------------------------------------------------------------- adding and opening
  async function add(file) {
    PDFR.loading(true);
    try {
      const buf = await file.arrayBuffer();
      const id = await sha(buf);
      let m = await DB.getMeta(id);
      if (m && !m.deleted) { await DB.putBlob(id, file); PDFR.loading(false); return open(id); }
      const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
      let title = '', author = '';
      try { const md = await pdf.getMetadata(); title = (md.info && md.info.Title || '').trim(); author = (md.info && md.info.Author || '').trim(); } catch (e) { /* none */ }
      const fromName = Covers.cleanTitle(file.name);
      if (Covers.junk(title) || /^[\w-]+\.\w{2,4}$/.test(title)) title = fromName;
      if (/^(unknown|admin|user|author)$/i.test(author) || author.length > 80) author = '';
      m = { id, name: file.name, title, author, size: file.size, pages: pdf.numPages, addedAt: Date.now(), updatedAt: Date.now(), pos: null, masks: [], openedAt: Date.now() };
      await DB.putBlob(id, file); await DB.putMeta(m);
      Sync.schedule(4000);
      findCover(m);
      PDFR.loading(false);
      return open(id);
    } catch (e) { console.error(e); PDFR.loading(false); PDFR.toast('Could not read that PDF.'); }
  }
  async function open(id) {
    const m = await DB.getMeta(id); if (!m) return;
    let blob = await DB.getBlob(id);
    if (!blob) {
      PDFR.loading(true, 'Downloading from your sync repo...');
      try { blob = await Sync.fetchBook(id); } catch (e) { /* handled below */ }
      PDFR.loading(false);
      if (!blob) { PDFR.toast(m.file ? 'Could not download this book. Check your connection.' : 'This book is not on this device. Add the PDF again.'); return; }
    }
    m.openedAt = Date.now(); await DB.putMeta(m);
    try { history.pushState({ v: 'reader' }, '', '#read'); } catch (e) { /* ignore */ }
    show(false);
    await PDFR.openBook(m, blob);
    if (!(await DB.getCover(id)) && !m.coverNone) findCover(m);
  }
  function show(lib) {
    document.body.dataset.view = lib ? 'library' : 'reader';
    if (lib) { PDFR.pausePlayback(); render(); }
  }
  function back() {
    if (location.hash === '#read') { try { history.back(); return; } catch (e) { /* fall through */ } }
    show(true);
  }
  function init() {
    $('libAdd').addEventListener('click', () => $('file').click());
    $('libEmptyAdd').addEventListener('click', () => $('file').click());
    $('btnOpen').addEventListener('click', back);
    window.addEventListener('popstate', () => { if (location.hash !== '#read') show(true); });
    document.body.dataset.view = 'library';
    if (location.hash === '#read') { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ } }
    render();
  }
  return { init, add, open, render, update, show, back };
})();
