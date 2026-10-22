// Reads the AION 2 gathering popup from screen frames, by its colors alone: whether the popup is up, how
// far the Success and Fail bars have filled, the grade from the title color, and the x2 orb that
// replaces the (i) icon on a double harvest. Frames are read in this browser and never sent anywhere.
(function (root) {
  'use strict';
  // Positions on a 380x110 box around the popup (from "Professional Lv." down to the Fail bar).
  const REF_W = 380, REF_H = 110;
  const L = {
    sRow: 76, fRow: 93, barX0: 62, barX1: 362, scanX0: 116,
    sLabel: [64, 72, 110, 80], fLabel: [64, 89, 86, 97],
    title: [18, 45, 230, 59], icon: [344, 40, 376, 66]
  };
  // Title colors. Common is plain white; Fine is measured, the others are guesses until seen.
  const TITLE = [['Fine', [40, 190, 98]], ['Pure', [70, 150, 255]], ['Radiant', [255, 170, 40]]];

  function reader(f) {
    const ch = f.ch || 4, sx = f.w / REF_W, sy = f.h / REF_H;
    return (x, y) => {
      const i = (Math.min(f.h - 1, Math.round(y * sy)) * f.w + Math.min(f.w - 1, Math.round(x * sx))) * ch;
      return [f.data[i], f.data[i + 1], f.data[i + 2]];
    };
  }
  const dark = c => Math.max(c[0], c[1], c[2]) < 64;
  // Success fill: blue while filling, white or lilac when it jumps, cyan when complete.
  const sFill = c => (c[2] > 200 && c[1] > 120 && c[0] < 140) || (c[1] > 200 && c[2] > 200) || (c[0] > 150 && c[2] > 180 && c[1] > 140);
  const sDone = c => c[1] > 220 && c[2] > 220 && c[0] < 170;
  // Fail fill: orange while filling, yellow when complete.
  const fFill = c => c[0] > 170 && c[1] > 70 && c[1] < 140 && c[2] < 60;
  const fDone = c => c[0] > 190 && c[1] > 190 && c[2] < 130;
  // How far a bar has filled, 0..1, reading right from its label until the fill stops.
  function bar(px, row, isFill) {
    let filled = 0, ok = 0, n = 0;
    for (let x = L.scanX0; x <= L.barX1 - 2; x += 2) {
      const c = px(x, row);
      n++;
      if (isFill(c)) { ok++; if (filled === x - 2 || (filled === 0 && x === L.scanX0)) filled = x; }
      else if (dark(c)) ok++;
    }
    return { frac: filled ? Math.min(1, (filled - L.barX0) / (L.barX1 - L.barX0)) : 0, clean: ok / n };
  }
  function count(px, box, test) {
    let k = 0;
    for (let y = box[1]; y <= box[3]; y++) for (let x = box[0]; x <= box[2]; x++) if (test(px(x, y))) k++;
    return k;
  }
  // The title's text color and the grade it matches; null when it matches none.
  function grade(px) {
    let r = 0, g = 0, b = 0, k = 0;
    for (let y = L.title[1]; y <= L.title[3]; y++) for (let x = L.title[0]; x <= L.title[2]; x++) {
      const c = px(x, y);
      if (Math.max(c[0], c[1], c[2]) > 140) { r += c[0]; g += c[1]; b += c[2]; k++; }
    }
    if (k < 12) return { name: null, rgb: null };
    const c = [r / k, g / k, b / k];
    if (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) < 45) return { name: 'Common', rgb: c };
    let best = null, bd = Infinity;
    for (const [name, ref] of TITLE) {
      const d = Math.hypot(c[0] - ref[0], c[1] - ref[1], c[2] - ref[2]);
      if (d < bd) { bd = d; best = name; }
    }
    return { name: bd < 120 ? best : null, rgb: c };
  }
  // One frame of the popup box: { w, h, ch, data } with RGB (ch 3) or RGBA (ch 4) bytes.
  function read(f) {
    const px = reader(f), white = c => Math.min(c[0], c[1], c[2]) > 190;
    const s = bar(px, L.sRow, sFill), fl = bar(px, L.fRow, fFill);
    if (!(count(px, L.sLabel, white) >= 6 && count(px, L.fLabel, white) >= 3 && s.clean > 0.8 && fl.clean > 0.8)) return { present: false };
    const g = grade(px), span = (L.barX1 - L.scanX0) * 2;
    return {
      present: true, s: s.frac, f: fl.frac, grade: g.name, gradeRgb: g.rgb,
      orb: count(px, L.icon, c => c[1] > 120 && c[1] > c[0] + 35 && c[1] > c[2] + 25) >= 25,
      sDone: count(px, [L.scanX0, L.sRow - 2, L.barX1 - 4, L.sRow + 2], sDone) > span,
      fDone: count(px, [L.scanX0, L.fRow - 2, L.barX1 - 4, L.fRow + 2], fDone) > span
    };
  }

  // Turns readings into extractions, grouped into nodes of up to three. feed(seconds, reading).
  // opts.onDone(extraction) is called as each one finishes.
  function tracker(opts) {
    opts = Object.assign({ nodeGap: 3, full: 0.97, lost: 0.6 }, opts || {});
    const ex = [], nodes = [];
    let cur = null, lastSeen = -Infinity;
    const mode = list => {
      const m = new Map(); let best = null;
      for (const v of list) { m.set(v, (m.get(v) || 0) + 1); if (!best || m.get(v) > m.get(best)) best = v; }
      return best;
    };
    function close(t) {
      if (!cur) return;
      cur.end = cur.result ? cur.resultAt : t;
      if (!cur.result) cur.result = 'interrupted';
      cur.grade = mode(cur.grades.slice(-6).filter(Boolean)) || cur.firstGrade;
      cur.tierUp = !!(cur.firstGrade && cur.grade && cur.grade !== cur.firstGrade);
      cur.qty = cur.result === 'success' ? (cur.orb ? 2 : 1) : 0;
      delete cur.grades;
      ex.push(cur);
      const node = nodes[nodes.length - 1];
      if (node && cur.start - node.lastEnd <= opts.nodeGap && node.ex.length < 3) { node.ex.push(cur); node.lastEnd = cur.end; }
      else nodes.push({ start: cur.start, lastEnd: cur.end, ex: [cur] });
      cur.node = nodes.length;
      if (opts.onDone) opts.onDone(cur);
      cur = null;
    }
    function feed(t, r) {
      if (!r.present) { if (cur && t - lastSeen > opts.lost) close(lastSeen); return; }
      lastSeen = t;
      // Empty bars after a result: the next extraction at the same node has started.
      if (cur && cur.result && r.s < 0.25 && r.f < 0.25 && !r.sDone && !r.fDone) close(t);
      if (!cur) cur = { start: t, firstGrade: r.grade, grades: [], orb: false, result: null, resultAt: null };
      if (!cur.firstGrade && r.grade) cur.firstGrade = r.grade;
      cur.grades.push(r.grade);
      if (!cur.result && (r.sDone || r.s >= opts.full)) { cur.result = 'success'; cur.resultAt = t; }
      else if (!cur.result && (r.fDone || r.f >= opts.full)) { cur.result = 'fail'; cur.resultAt = t; }
      if (cur.result === 'success' && r.orb) cur.orb = true;
    }
    function finish(t) { close(t); return { extractions: ex, nodes: nodes }; }
    return { feed: feed, finish: finish };
  }

  // Totals for a scanned recording.
  function summarize(res, seconds) {
    const done = res.extractions.filter(e => e.result !== 'interrupted');
    const ok = done.filter(e => e.result === 'success');
    const byGrade = {};
    for (const e of ok) { const g = e.grade || '?'; byGrade[g] = (byGrade[g] || 0) + e.qty; }
    return {
      seconds: seconds, nodes: res.nodes.length, x: done.length, ok: ok.length, fail: done.length - ok.length,
      d: ok.filter(e => e.qty > 1).length, u: done.filter(e => e.tierUp).length,
      sec: done.reduce((s, e) => s + (e.end - e.start), 0), items: ok.reduce((s, e) => s + e.qty, 0), byGrade: byGrade,
      interrupted: res.extractions.length - done.length
    };
  }

  // The white text of the "Success" and "Fail" labels, read from a recording. Each starts at the given
  // point on the 380x110 box; '#' is label text.
  const LABELS = [
    [60, 70, [
      '.......................................................', '.......................................................',
      '......####.............................................', '......#................................................',
      '......#......#..##...###....##.....##....###...##......', '......##.....#..##..##.#...##.#..##.##..####..##.#.....',
      '........##...#..##.##.....##.....##.###.##....##.......', '.........##..#..##.##.....##.....######..###...###.....',
      '..........#..#..##..#.....##.....#.........#.....#.....', '.....###.##..#####..####...####...####..####..####.....',
      '.......##.....#..#....#.....##.....##.....#.....#......', '.......................................................',
      '.......................................................']],
    [60, 87, [
      '...............................', '...............................', '......####.........#..#........',
      '......#...............#........', '......#.......#....#..#........', '......#........##..#..#........',
      '......####....###..#..#........', '......#......####..#..#........', '......#.....#...#..#..#........',
      '......#......#.##..#..#........', '......#.......#.#..#...#.......', '...............................',
      '...............................']],
    // The (i) icon at the top right, and the green word "Professional" above the title. Being far from
    // the labels, they pin down the popup's size.
    [346, 44, [
      '.........................', '...........##............', '........#......#.........', '.........................',
      '.........................', '...........##............', '.........................', '...........##............',
      '...........##............', '...........##............', '...........##............', '...........##............',
      '.........................', '.........................', '.........................'], 'white'],
    [128, 8, [
      '.............................................................................................',
      '.............................................................................................',
      '........####..................##......................#.........................##......#....',
      '........#..##.................#.................................................##......#....',
      '............#..##.#...###...####....##.....##....##...#....##.....#.##.....##...##......#....',
      '............#..####...####...###...####...####..###...#...#####...#####...####..##......#....',
      '........#####...#....#...#....#...##..##..#.....#.....#..#....#..##...#.....###.##......#....',
      '........###.....#...##....#...#...######..###...##....#..#....##.##...#...#####.##......#....',
      '....................##...##...#...##........##....##..#..#....##..#...#..#...##.##......#....',
      '.....................#...#....#...##.........#.....#..#..#....#...#...#..#...##.##......#....',
      '......................####....#.....###...####..####..#...####....#...#...#####..#......#####',
      '.......................#.............#...........#....#...............#....#.#..........#####',
      '.............................................................................................'], 'green']
  ];
  const INK = {
    white: (d, i) => d[i] > 170 && d[i + 1] > 170 && d[i + 2] > 170,
    green: (d, i) => d[i + 1] > 150 && d[i + 1] > d[i] + 60 && d[i + 1] > d[i + 2] + 40
  };
  // Each anchor's text pixels and a sample of the pixels around them: a light set for the first, wide
  // search and a full one to settle the exact spot.
  const MASKS = LABELS.map(([x0, y0, rows, ink]) => {
    const on = [], off = [];
    rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) (row[x] === '#' ? on : off).push([x0 + x, y0 + y]); });
    return {
      ink: INK[ink || 'white'], label: !ink,
      coarse: { on: on.filter((_, i) => i % 2 === 0), off: off.filter((_, i) => i % 6 === 0) },
      fine: { on: on, off: off.filter((_, i) => i % 2 === 0) }
    };
  });
  // Finds the popup in a frame near a rough box someone drew around it ({ x, y, w, h } in the frame's
  // pixels) by matching its fixed text: the bar labels, the (i) icon and "Professional". Returns the
  // exact box in pixels and how well the bar labels matched (0.8 to 1 when found, under 0.3 when not).
  function locate(f, rough) {
    const ch = f.ch || 4, d = f.data;
    const hit = (ink, x, y) => {
      x = Math.round(x); y = Math.round(y);
      return x >= 0 && y >= 0 && x < f.w && y < f.h && ink(d, (y * f.w + x) * ch);
    };
    const score = (ox, oy, s, set, labelsOnly) => {
      let total = 0, n = 0;
      for (const m of MASKS) {
        if (labelsOnly && !m.label) continue;
        const pts = m[set];
        let a = 0, b = 0;
        for (const p of pts.on) if (hit(m.ink, ox + p[0] * s, oy + p[1] * s)) a++;
        for (const p of pts.off) if (hit(m.ink, ox + p[0] * s, oy + p[1] * s)) b++;
        total += a / pts.on.length - b / pts.off.length; n++;
      }
      return total / n;
    };
    const s0 = (rough.w / 370 + rough.h / 105) / 2;
    let best = [];
    const keep = (ox, oy, s, v) => { best.push({ ox: ox, oy: oy, s: s, v: v }); best.sort((p, q) => q.v - p.v); if (best.length > 4) best.pop(); };
    for (let s = s0 * 0.7; s <= s0 * 1.35; s *= 1.03) {
      const step = Math.max(1, Math.round(2 * s));
      // The box may leave out the "Professional Lv." line above the popup, so look further up than down.
      for (let oy = rough.y - 0.6 * rough.h; oy <= rough.y + 0.35 * rough.h; oy += step) {
        for (let ox = rough.x - 0.25 * rough.w; ox <= rough.x + 0.25 * rough.w; ox += step) keep(ox, oy, s, score(ox, oy, s, 'coarse'));
      }
    }
    let top = null;
    for (const c of best.slice()) {
      const r = Math.max(2, Math.round(2 * c.s));
      for (let s = c.s * 0.97; s <= c.s * 1.03; s *= 1.005) {
        for (let oy = c.oy - r; oy <= c.oy + r; oy++) for (let ox = c.ox - r; ox <= c.ox + r; ox++) {
          const v = score(ox, oy, s, 'fine');
          if (!top || v > top.v) top = { ox: ox, oy: oy, s: s, v: v };
        }
      }
    }
    return { x: top.ox, y: top.oy, w: REF_W * top.s, h: REF_H * top.s, match: score(top.ox, top.oy, top.s, 'fine', true) };
  }

  const api = { read: read, tracker: tracker, summarize: summarize, locate: locate, REF_W: REF_W, REF_H: REF_H };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.GatherReader = api;
})(this);
