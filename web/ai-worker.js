/* Runs the Kokoro voice model off the main thread so the page stays smooth. */
import { KokoroTTS } from './vendor/kokoro.web.js';
let tts = null;
const dropped = new Set();
let queue = Promise.resolve();

function pieces(text, max) {
  const out = [];
  const sentences = text.match(/[^.!?…]+[.!?…]+["'”)\]]*\s*|[^.!?…]+$/g) || [text];
  for (let s of sentences) {
    s = s.trim();
    while (s.length > max) {
      let cut = Math.max(s.lastIndexOf(', ', max), s.lastIndexOf('; ', max), s.lastIndexOf(': ', max));
      if (cut < max * 0.4) cut = s.lastIndexOf(' ', max);
      if (cut < 1) cut = max;
      out.push(s.slice(0, cut + 1).trim()); s = s.slice(cut + 1).trim();
    }
    if (s) out.push(s);
  }
  return out;
}

self.onmessage = e => {
  const m = e.data;
  if (m.type === 'init') {
    KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: m.dtype || 'q8', device: 'wasm',
      progress_callback: p => self.postMessage({ type: 'progress', p: { status: p.status, file: p.file, progress: p.progress, loaded: p.loaded, total: p.total } }),
    }).then(t => { tts = t; self.postMessage({ type: 'ready' }); })
      .catch(err => self.postMessage({ type: 'error', message: String((err && err.message) || err) }));
  } else if (m.type === 'drop') {
    dropped.add(m.id);
  } else if (m.type === 'gen') {
    queue = queue.then(async () => {
      if (dropped.has(m.id)) { dropped.delete(m.id); return; }
      try {
        const parts = [], t0 = performance.now();
        let rate = 24000;
        for (const piece of pieces(m.text, 230)) {
          if (!/\w/.test(piece)) continue;
          const a = await tts.generate(piece, { voice: m.voice, speed: m.speed });
          rate = a.sampling_rate || rate; parts.push(a.audio || a.data);
        }
        const gap = Math.round(rate * 0.12);
        const total = parts.reduce((n, p) => n + p.length, 0) + gap * Math.max(0, parts.length - 1);
        const all = new Float32Array(total);
        let o = 0; parts.forEach((p, i) => { all.set(p, o); o += p.length + (i < parts.length - 1 ? gap : 0); });
        self.postMessage({ type: 'audio', id: m.id, samples: all, rate, ms: performance.now() - t0 }, [all.buffer]);
      } catch (err) {
        self.postMessage({ type: 'fail', id: m.id, message: String((err && err.message) || err) });
      }
    });
  }
};
