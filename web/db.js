'use strict';
/* Local library storage (IndexedDB): book records, PDF blobs, cover images. Every call is guarded. */
window.DB = (function () {
  let dbp = null;
  function open() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('pacer', 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('meta', { keyPath: 'id' }); d.createObjectStore('blobs'); d.createObjectStore('covers'); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  function run(store, mode, fn) {
    return open().then(db => new Promise((res, rej) => {
      const t = db.transaction(store, mode), o = t.objectStore(store);
      const q = fn(o);
      t.oncomplete = () => res(q ? q.result : undefined);
      t.onerror = t.onabort = () => rej(t.error);
    }));
  }
  return {
    allMeta: () => run('meta', 'readonly', o => o.getAll()).then(a => a || []),
    getMeta: id => run('meta', 'readonly', o => o.get(id)),
    putMeta: m => run('meta', 'readwrite', o => o.put(m)),
    getBlob: id => run('blobs', 'readonly', o => o.get(id)),
    putBlob: (id, b) => run('blobs', 'readwrite', o => o.put(b, id)),
    delBlob: id => run('blobs', 'readwrite', o => o.delete(id)),
    hasBlob: id => run('blobs', 'readonly', o => o.count(id)).then(n => n > 0),
    getCover: id => run('covers', 'readonly', o => o.get(id)),
    putCover: (id, b) => run('covers', 'readwrite', o => o.put(b, id)),
    delCover: id => run('covers', 'readwrite', o => o.delete(id)),
  };
})();
