'use strict';
/* Finds a cover picture for a book from its title: Open Library first, Google Books second.
   Both services allow browser requests. If neither knows the book, the library draws a plain generated cover. */
window.Covers = (function () {
  const norm = s => (s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(the|a|an|of|and)\b/g, ' ').replace(/\s+/g, ' ').trim();
  function similarity(a, b) {
    const x = new Set(norm(a).split(' ').filter(Boolean)), y = new Set(norm(b).split(' ').filter(Boolean));
    if (!x.size || !y.size) return 0;
    let n = 0; x.forEach(w => { if (y.has(w)) n++; });
    return n / Math.max(x.size, y.size);
  }
  /** File name or PDF metadata title -> something searchable. */
  function cleanTitle(s) {
    return (s || '').replace(/\.pdf$/i, '').replace(/[_]+/g, ' ')
      .replace(/\((?:z-?lib|libgen|pdfdrive|[^)]*\.(?:org|com|net|io))[^)]*\)/gi, '')
      .replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const junk = t => !t || t.length < 3 || /^(untitled|microsoft word|unknown|document\d*)/i.test(t) || /\.(docx?|pdf|indd|qxd|tex)$/i.test(t);

  async function getJSON(url) {
    const c = new AbortController(), t = setTimeout(() => c.abort(), 9000);
    try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) return null; return await r.json(); } catch (e) { return null; } finally { clearTimeout(t); }
  }
  async function openLibrary(title, author) {
    const q = new URLSearchParams({ title, limit: '8', fields: 'title,author_name,cover_i' });
    if (author) q.set('author', author);
    let j = await getJSON('https://openlibrary.org/search.json?' + q);
    if (!j || !(j.docs || []).some(d => d.cover_i)) j = await getJSON('https://openlibrary.org/search.json?' + new URLSearchParams({ q: title, limit: '8', fields: 'title,author_name,cover_i' }));
    let best = null, bs = 0;
    ((j && j.docs) || []).forEach(d => {
      if (!d.cover_i) return;
      const s = similarity(title, d.title) + (author && d.author_name ? 0.25 * similarity(author, d.author_name.join(' ')) : 0);
      if (s > bs) { bs = s; best = d; }
    });
    if (!best || bs < 0.6) return null;
    return { url: `https://covers.openlibrary.org/b/id/${best.cover_i}-L.jpg`, title: best.title, author: (best.author_name || [])[0] || '', score: bs };
  }
  async function googleBooks(title, author) {
    const q = 'intitle:' + title + (author ? '+inauthor:' + author : '');
    const j = await getJSON('https://www.googleapis.com/books/v1/volumes?maxResults=6&printType=books&q=' + encodeURIComponent(q).replace(/%2B/g, '+'));
    let best = null, bs = 0;
    ((j && j.items) || []).forEach(it => {
      const v = it.volumeInfo || {}; const img = v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail);
      if (!img) return;
      const s = similarity(title, v.title || '') + (author && v.authors ? 0.25 * similarity(author, v.authors.join(' ')) : 0);
      if (s > bs) { bs = s; best = { url: img.replace(/^http:/, 'https:').replace('&edge=curl', '').replace('zoom=1', 'zoom=2'), title: v.title, author: (v.authors || [])[0] || '', score: s }; }
    });
    return best && bs >= 0.6 ? best : null;
  }
  async function toBlob(url) {
    try { const r = await fetch(url); if (!r.ok) return null; const b = await r.blob(); return b.size > 1500 && /image/.test(b.type) ? b : null; } catch (e) { return null; }
  }
  /** -> { url, blob|null, title, author } or null */
  async function find(title, author) {
    title = cleanTitle(title);
    if (junk(title)) return null;
    const hit = (await openLibrary(title, author)) || (await googleBooks(title, author));
    if (!hit) return null;
    hit.blob = await toBlob(hit.url);
    return hit;
  }
  return { find, cleanTitle, junk, similarity };
})();
