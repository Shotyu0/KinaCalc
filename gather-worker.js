// Live gathering and crafting tracker. Reads screen-share frames in the background, so tracking keeps going
// while the game covers the page. Messages in: start { readable, box, version, mode }, box { box }, snapshot,
// locate { rough }, pause { on }, report. Messages out: snapshot { bitmap, w, h }, located { box, match,
// reading }, reading { r }, extraction { ex, icon }, problem { reasons, ex, sheet }, ended.
'use strict';
importScripts('gather-reader.js');
const R = self.GatherReader, W = R.REF_W, H = R.REF_H;
// Known item icons, to name the item and its grade. Tracking works without them, from the title color.
fetch('data/gather-icons.json').then(r => r.ok ? r.json() : null).then(d => { if (d) R.useIcons(d); }).catch(() => {});
const cv = new OffscreenCanvas(W, H), ctx = cv.getContext('2d', { willReadFrequently: true });
// mode 'craft' reads the crafting popup: no item icons, and combos to confirm.
let box = null, tr = null, paused = false, wantSnap = false, snap = null, lastPost = 0, lastT = 0, itemPx = null, version = '', mode = 'gather', runs = [];

// Problem reports. The last 20 seconds of the popup box are kept as small JPEGs; an odd extraction, or
// the player's own report, turns its frames into one picture. Only the popup box is kept, never the rest
// of the screen. At most two pictures per reason and six in all per session.
const KEEP = 20, MAX_FRAMES = 32, recent = [], perReason = {};
let problems = 0;
function keepFrame(t, r) {
  const info = r.present ? { s: r.s, f: r.f, grade: r.grade, orb: r.orb, x2: r.x2, blue: r.blue, item: r.item ? R.iconName(r.item.i) + (r.item.sure ? '' : '?') : null } : null;
  cv.convertToBlob({ type: 'image/jpeg', quality: 0.85 }).then(blob => {
    recent.push({ t: t, blob: blob, info: info });
    while (recent.length && recent[0].t < lastT - KEEP) recent.shift();
  }, () => {});
}
const pct = v => Math.round(v * 100) + '%';
// One picture: a header saying what happened, then each frame with what was read from it.
async function sheet(frames, lines) {
  const cols = 4, capH = 18, headH = 18 * lines.length + 12, rows = Math.ceil(frames.length / cols);
  const c = new OffscreenCanvas(cols * W, headH + rows * (H + capH)), g = c.getContext('2d');
  g.fillStyle = '#10141c'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#e8e2d0'; g.font = '14px sans-serif';
  lines.forEach((l, i) => g.fillText(l, 8, 18 + i * 18));
  const t0 = frames.length ? frames[0].t : 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i], x = (i % cols) * W, y = headH + Math.floor(i / cols) * (H + capH);
    try { const bmp = await createImageBitmap(f.blob); g.drawImage(bmp, x, y); bmp.close(); } catch (_) {}
    const n = f.info;
    g.fillStyle = '#c8cbd2'; g.font = '12px sans-serif';
    g.fillText((f.t - t0).toFixed(1) + 's  ' + (n ? 'S ' + pct(n.s) + ' F ' + pct(n.f) + ' ' + (n.grade || 'grade?') + (mode === 'craft' ? (n.blue ? ' blue' : '') : ' ' + (n.item || 'item?') + (n.orb ? ' orb' : '') + (n.x2 ? ' x2' : '')) : 'no popup'), x + 4, y + H + 13);
  }
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
}
// Frames between two times, thinned evenly to fit the picture.
function framesBetween(from, to) {
  const list = recent.filter(f => f.t >= from && f.t <= to);
  if (list.length <= MAX_FRAMES) return list;
  return Array.from({ length: MAX_FRAMES }, (_, i) => list[Math.round(i * (list.length - 1) / (MAX_FRAMES - 1))]);
}
function summary(ex) {
  if (!ex) return null;
  const o = {};
  for (const k of mode === 'craft' ? ['result', 'openGrade', 'blue', 'closedBy'] : ['result', 'openGrade', 'grade', 'qty', 'tierUp', 'titleColor', 'x2', 'orb']) if (ex[k] != null) o[k] = ex[k];
  if (ex.item) o.item = ex.item[0]; else if (ex.material) o.material = ex.material[0];
  o.seconds = +(ex.end - ex.start).toFixed(1);
  return o;
}
function problem(reasons, from, ex) {
  if (problems >= 6) return;
  const fresh = reasons.filter(r => (perReason[r] || 0) < 2);
  if (!fresh.length) return;
  problems++;
  for (const r of fresh) perReason[r] = (perReason[r] || 0) + 1;
  // Wait a moment so the frames just after it are kept too.
  setTimeout(async () => {
    const frames = framesBetween(from, lastT), s = summary(ex);
    const lines = ['Kina Ledger ' + (mode === 'craft' ? 'crafting' : 'gathering') + ' tracker · ' + version + ' · ' + reasons.join(', '),
      s ? 'Read as: ' + JSON.stringify(s) : 'Reported by the player: the last ' + Math.round(lastT - from) + ' seconds',
      'Box ' + (box ? [box.x, box.y, box.w, box.h].map(v => v.toFixed(4)).join(', ') : 'none') + ' · ' + frames.length + ' frames, ' + (frames.length ? (frames[frames.length - 1].t - frames[0].t).toFixed(1) : 0) + ' s'];
    try { postMessage({ type: 'problem', reasons: reasons, ex: s, sheet: await sheet(frames, lines) }); } catch (_) {}
  }, 1500);
}

// Each finished extraction goes out with a picture of its item icon, taken while it was still Common.
// Crafting has no icon; its combo crafts are kept as pictures to confirm, like gathering's tier-ups.
function newTracker() {
  runs = [];
  tr = R.tracker({ mode: mode, onDone: ex => {
    postMessage({ type: 'extraction', ex: ex, icon: mode === 'craft' ? null : itemPx });
    const odd = (ex.odd || []).slice();
    let from = ex.start;
    if (mode === 'craft') {
      // A run that joins the craft before it is that craft's combo.
      const before = R.crafts(runs).length, list = R.crafts(runs.concat(ex));
      runs.push(ex);
      if (list.length === before) { odd.push('combo craft'); from = list[list.length - 1].start; }
      else if (ex.blue) odd.push('blue panel without a combo');
    }
    if (odd.length) problem(odd, from - 1, ex);
  } });
}
// Reads the popup box (fractions of the frame) from a frame or bitmap.
function readBox(src, w, h, b) {
  ctx.drawImage(src, b.x * w, b.y * h, b.w * w, b.h * h, 0, 0, W, H);
  const r = R.read({ w: W, h: H, ch: 4, data: ctx.getImageData(0, 0, W, H).data }, { items: mode !== 'craft' });
  if (mode !== 'craft' && r.present && r.grade === 'Common') {
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
        lastT = t;
        keepFrame(t, r);
        tr.feed(t, r);
        if (t - lastPost >= 0.5) { lastPost = t; postMessage({ type: 'reading', r: { present: r.present, s: r.s, f: r.f, grade: r.grade, orb: r.orb, blue: r.blue } }); }
      }
    } finally { frame.close(); }
  }
  if (tr) tr.finish(lastT);
  // Give a last problem picture time to finish before saying so.
  setTimeout(() => postMessage({ type: 'ended' }), recent.length && problems ? 1700 : 0);
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
  const b = R.locate(f, { x: rough.x - x0, y: rough.y - y0, w: rough.w, h: rough.h }, mode);
  const frac = { x: (b.x + x0) / snap.width, y: (b.y + y0) / snap.height, w: b.w / snap.width, h: b.h / snap.height };
  const r = readBox(snap, snap.width, snap.height, frac);
  postMessage({ type: 'located', box: frac, match: b.match, reading: { present: r.present, s: r.s, f: r.f, grade: r.grade, orb: r.orb, blue: r.blue } });
}
onmessage = e => {
  const m = e.data;
  if (m.type === 'start') { box = m.box || null; version = m.version || ''; mode = m.mode === 'craft' ? 'craft' : 'gather'; newTracker(); pump(m.readable); }
  else if (m.type === 'box') { box = m.box; newTracker(); }
  else if (m.type === 'snapshot') wantSnap = true;
  else if (m.type === 'locate') locate(m.rough);
  else if (m.type === 'pause') paused = !!m.on;
  else if (m.type === 'report') problem(['reported by the player'], lastT - 15, null);
};
