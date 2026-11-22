const CACHE = 'pacer-v2';
const FILES = ['./', 'index.html', 'app.js', 'engine.js', 'db.js', 'covers.js', 'ai.js', 'ai-worker.js', 'sync.js', 'lib.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/words.txt', 'vendor/kokoro.web.js'];
const RUNTIME = 'pacer-runtime';
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== RUNTIME && k !== 'transformers-cache').map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin === location.origin) {
    // cache first so it opens offline, refresh in the background so updates arrive on the next launch
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(r, { ignoreSearch: true });
      const net = fetch(r).then(res => { if (res.ok) c.put(r, res.clone()); return res; }).catch(() => null);
      return hit || (await net) || Response.error();
    }));
    return;
  }
  // voice-engine files that load from a CDN: keep them after the first download so the AI voice works offline
  if (u.hostname === 'cdn.jsdelivr.net' || (u.hostname === 'huggingface.co' && /\/voices\//.test(u.pathname))) {
    e.respondWith(caches.open(RUNTIME).then(async c => { const hit = await c.match(r); if (hit) return hit; const res = await fetch(r); if (res.ok) c.put(r, res.clone()); return res; }));
  }
});
