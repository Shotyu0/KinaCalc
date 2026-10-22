// Live gathering tracker. Reads screen-share frames in the background, so tracking keeps going while
// the game covers the page. Messages in: start { readable, box }, box { box }, snapshot, locate { rough },
// pause { on }. Messages out: snapshot { bitmap, w, h }, located { box, match, reading }, reading { r },
// extraction { ex }, ended.
'use strict';
importScripts('gather-reader.js');
const R = self.GatherReader, W = R.REF_W, H = R.REF_H;
const cv = new OffscreenCanvas(W, H), ctx = cv.getContext('2d', { willReadFrequently: true });
let box = null, tr = null, paused = false, wantSnap = false, snap = null, lastPost = 0, lastT = 0, itemPx = null;

// Each finished extraction goes out with a picture of its item icon, taken while it was still Common.
function newTracker() { tr = R.tracker({ onDone: ex => postMessage({ type: 'extraction', ex: ex, icon: itemPx }) }); }
// Reads the popup box (fractions of the frame) from a frame or bitmap.
function readBox(src, w, h, b) {
  ctx.drawImage(src, b.x * w, b.y * h, b.w * w, b.h * h, 0, 0, W, H);
  const r = R.read({ w: W, h: H, ch: 4, data: ctx.getImageData(0, 0, W, H).data });
  if (r.present && r.grade === 'Common') {
    const [x0, y0, x1, y1] = R.ITEM_BOX;
    const img = ctx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    itemPx = { w: img.width, h: img.height, data: img.data };
  }
  return r;
}
async function pump(readable) {
  const reader = readable.getReader();
  for (;;) {
    const got = await reader.read();
    if (got.done) break;
    const frame = got.value, w = frame.displayWidth, h = frame.displayHeight;
    try {
      if (wantSnap) {
        wantSnap = false;
        if (snap) snap.close();
        snap = await createImageBitmap(frame);
        const copy = await createImageBitmap(snap);
        postMessage({ type: 'snapshot', bitmap: copy, w: w, h: h }, [copy]);
      }
      if (box && tr && !paused) {
        const t = frame.timestamp / 1e6, r = readBox(frame, w, h, box);
        tr.feed(t, r);
        lastT = t;
        if (t - lastPost >= 0.5) { lastPost = t; postMessage({ type: 'reading', r: { present: r.present, s: r.s, f: r.f, grade: r.grade, orb: r.orb } }); }
      }
    } finally { frame.close(); }
  }
  if (tr) tr.finish(lastT);
  postMessage({ type: 'ended' });
}
// Finds the popup near a rough box (pixels of the last snapshot), reading only the area around it.
function locate(rough) {
  if (!snap) return postMessage({ type: 'located', box: null, match: 0 });
  const pad = { x: rough.w * 0.5, y: rough.h * 0.6 };
  const x0 = Math.max(0, Math.floor(rough.x - pad.x)), y0 = Math.max(0, Math.floor(rough.y - pad.y));
  const x1 = Math.min(snap.width, Math.ceil(rough.x + rough.w + pad.x)), y1 = Math.min(snap.height, Math.ceil(rough.y + rough.h + pad.y));
  const area = new OffscreenCanvas(x1 - x0, y1 - y0), actx = area.getContext('2d', { willReadFrequently: true });
  actx.drawImage(snap, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
  const f = { w: x1 - x0, h: y1 - y0, ch: 4, data: actx.getImageData(0, 0, x1 - x0, y1 - y0).data };
  const b = R.locate(f, { x: rough.x - x0, y: rough.y - y0, w: rough.w, h: rough.h });
  const frac = { x: (b.x + x0) / snap.width, y: (b.y + y0) / snap.height, w: b.w / snap.width, h: b.h / snap.height };
  const r = readBox(snap, snap.width, snap.height, frac);
  postMessage({ type: 'located', box: frac, match: b.match, reading: { present: r.present, s: r.s, f: r.f, grade: r.grade, orb: r.orb } });
}
onmessage = e => {
  const m = e.data;
  if (m.type === 'start') { box = m.box || null; newTracker(); pump(m.readable); }
  else if (m.type === 'box') { box = m.box; newTracker(); }
  else if (m.type === 'snapshot') wantSnap = true;
  else if (m.type === 'locate') locate(m.rough);
  else if (m.type === 'pause') paused = !!m.on;
};
