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
    // x2 stops short of the Fine panel's bright right edge, and below the (i) icon's stem.
    title: [18, 45, 230, 59], icon: [344, 40, 376, 66], x2: [360, 57, 373, 67],
    item: [25, 72, 50, 96],        // the item's own icon, left of the bars
    slot: [20, 67.5, 35],          // the square the icon art fills: left, top, size
    slotTop: [[21, 68], [22, 69], [52, 68], [53, 69]], slotBottom: [[21, 100], [22, 101], [52, 100], [53, 101]]
  };
  // Known item icons (data/gather-icons.json): each an 8x8 grid of premultiplied color and coverage.
  // The art is laid over the popup's own slot background before comparing, since the slot is tinted by
  // grade. A match closer than MATCH_MAX, and clearly closer than the next best, names the item.
  let ICONS = null;
  const MATCH_MAX = 11, MATCH_GAP = 3;
  function useIcons(data) {
    if (!data || !Array.isArray(data.icons) || data.size !== 8) return;
    ICONS = data.icons.map(i => ({
      names: i.names, grade: i.grade, family: String(i.names[0]).replace(/^(Fresh|Fine|Pure|Radiant) /, ''),
      g: Array.from({ length: 64 }, (_, k) => [i.g[k * 4], i.g[k * 4 + 1], i.g[k * 4 + 2], i.g[k * 4 + 3] / 255])
    }));
  }
  // The icon is only about 35 pixels, so a box a pixel or two off would spoil the match: each frame tries
  // the square at small shifts and sizes and keeps the best fit. Summed-area tables of the area around
  // the slot make each try a few lookups.
  const WIN = [12, 60, 64, 109];
  function matchItem(px) {
    if (!ICONS) return null;
    const ww = WIN[2] - WIN[0] + 1, wh = WIN[3] - WIN[1] + 1, W1 = ww + 1;
    const sat = [new Float64Array(W1 * (wh + 1)), new Float64Array(W1 * (wh + 1)), new Float64Array(W1 * (wh + 1))];
    for (let y = 0; y < wh; y++) {
      const run = [0, 0, 0];
      for (let x = 0; x < ww; x++) {
        const c = px(WIN[0] + x, WIN[1] + y);
        for (let k = 0; k < 3; k++) { run[k] += c[k]; sat[k][(y + 1) * W1 + x + 1] = sat[k][y * W1 + x + 1] + run[k]; }
      }
    }
    // Average color of box pixels [x0, x1) x [y0, y1), clipped to the window.
    const mean = (x0, y0, x1, y1) => {
      x0 = Math.max(0, Math.min(ww, Math.round(x0 - WIN[0]))); x1 = Math.max(x0 + 1, Math.min(ww, Math.round(x1 - WIN[0])));
      y0 = Math.max(0, Math.min(wh, Math.round(y0 - WIN[1]))); y1 = Math.max(y0 + 1, Math.min(wh, Math.round(y1 - WIN[1])));
      const n = (x1 - x0) * (y1 - y0);
      return sat.map(s => (s[y1 * W1 + x1] - s[y0 * W1 + x1] - s[y1 * W1 + x0] + s[y0 * W1 + x0]) / n);
    };
    const avg = (pts, dx, dy) => { const s = [0, 0, 0]; for (const p of pts) { const c = mean(p[0] + dx, p[1] + dy, p[0] + dx + 1, p[1] + dy + 1); s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; } return s.map(v => v / pts.length); };
    let best = null;
    for (let ds = -0.5; ds <= 0.5; ds += 0.5) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const ox = L.slot[0] + dx, oy = L.slot[1] + dy, cell = (L.slot[2] + ds) / 8, pop = [];
      for (let gy = 0; gy < 8; gy++) for (let gx = 0; gx < 8; gx++) pop.push(mean(ox + gx * cell, oy + gy * cell, ox + (gx + 1) * cell, oy + (gy + 1) * cell));
      const top = avg(L.slotTop, dx, dy), bot = avg(L.slotBottom, dx, dy);
      const ds2 = ICONS.map(ic => {
        const g = ic.g;
        let s = 0;
        for (let i = 0; i < 64; i++) {
          const f = ((i >> 3) + 0.5) / 8, ref = g[i], p = pop[i], a = 1 - ref[3];
          s += Math.abs(p[0] - (ref[0] + a * (top[0] + (bot[0] - top[0]) * f))) + Math.abs(p[1] - (ref[1] + a * (top[1] + (bot[1] - top[1]) * f))) + Math.abs(p[2] - (ref[2] + a * (top[2] + (bot[2] - top[2]) * f)));
        }
        return s / 192;
      });
      let bi = 0;
      for (let n = 1; n < ds2.length; n++) if (ds2[n] < ds2[bi]) bi = n;
      if (!best || ds2[bi] < best.d) best = { i: bi, d: ds2[bi], all: ds2 };
    }
    if (!best || best.d > MATCH_MAX) return null;
    // Sure of the item when it beats every other icon by a margin; sure of just the material when it beats
    // every other material's icons, though another grade of the same material comes close.
    let other = Infinity, otherFamily = Infinity;
    best.all.forEach((v, n) => {
      if (n === best.i) return;
      if (v < other) other = v;
      if (ICONS[n].family !== ICONS[best.i].family && v < otherFamily) otherFamily = v;
    });
    if (otherFamily - best.d < MATCH_GAP) return null;
    return { i: best.i, d: best.d, sure: other - best.d >= MATCH_GAP };
  }
  // Two item icons closer than this (average difference per color channel, 0-255) are the same item.
  // The same icon reads within about 1 between frames; Fine and Common Orichalcum Ore differ by about 30.
  const ICON_SAME = 14;
  // Title colors, used when the item icon doesn't settle it. Common is plain white and Fine is measured;
  // Pure and Radiant are the wiki's grade colors until seen in the popup.
  const TITLE = [['Fine', [40, 190, 98]], ['Pure', [66, 169, 223]], ['Radiant', [242, 181, 42]]];

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
  // The item icon as 4x4 cells of average color: 48 numbers.
  function itemIcon(px) {
    const b = L.item, cw = (b[2] - b[0] + 1) / 4, ch = (b[3] - b[1] + 1) / 4, out = [];
    for (let gy = 0; gy < 4; gy++) for (let gx = 0; gx < 4; gx++) {
      let r = 0, g = 0, bl = 0, k = 0;
      for (let y = Math.floor(b[1] + gy * ch); y < b[1] + (gy + 1) * ch; y++) for (let x = Math.floor(b[0] + gx * cw); x < b[0] + (gx + 1) * cw; x++) {
        const c = px(x, y); r += c[0]; g += c[1]; bl += c[2]; k++;
      }
      out.push(Math.round(r / k), Math.round(g / k), Math.round(bl / k));
    }
    return out;
  }
  function iconDist(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  }
  function medianIcon(list) {
    if (!list.length) return null;
    return list[0].map((_, i) => { const v = list.map(x => x[i]).sort((p, q) => p - q); return v[v.length >> 1]; });
  }
  // One frame of the popup box: { w, h, ch, data } with RGB (ch 3) or RGBA (ch 4) bytes.
  // The panel turns blue for a Splendent craft (and a Fine gathering node). It's see-through, so it's
  // sampled at several empty spots.
  const PANEL = [[150, 38], [250, 38], [300, 38], [320, 50], [320, 63]]; // inside the panel, clear of text, on both popups
  function panelBlue(px) {
    let n = 0;
    for (const p of PANEL) { const c = px(p[0], p[1]); if (c[2] >= 90 && c[2] - c[0] >= 45 && c[1] >= 60) n++; }
    return n >= 3;
  }
  // opts.items false skips naming the item from its icon (crafting has no icons to match).
  function read(f, opts) {
    const px = reader(f), white = c => Math.min(c[0], c[1], c[2]) > 190;
    const s = bar(px, L.sRow, sFill), fl = bar(px, L.fRow, fFill);
    if (!(count(px, L.sLabel, white) >= 6 && count(px, L.fLabel, white) >= 3 && s.clean > 0.8 && fl.clean > 0.8)) return { present: false };
    const g = grade(px), span = (L.barX1 - L.scanX0) * 2;
    return {
      present: true, s: s.frac, f: fl.frac, grade: g.name, gradeRgb: g.rgb, icon: itemIcon(px), item: opts && opts.items === false ? null : matchItem(px), blue: panelBlue(px),
      orb: count(px, L.icon, c => c[1] > 120 && c[1] > c[0] + 35 && c[1] > c[2] + 25) >= 25,
      // The white "x2" on the Plentiful Harvest orb. The Ore Appraiser icon shows in the same spot without it.
      x2: count(px, L.x2, c => Math.min(c[0], c[1], c[2]) > 150) >= 8,
      sDone: count(px, [L.scanX0, L.sRow - 2, L.barX1 - 4, L.sRow + 2], sDone) > span,
      fDone: count(px, [L.scanX0, L.fRow - 2, L.barX1 - 4, L.fRow + 2], fDone) > span
    };
  }

  // Grades low to high, as the popup title shows them.
  const RANK = { Common: 0, Fine: 1, Pure: 2, Radiant: 3 };
  // How long the popup takes to settle on the grade it opens at: it shows Common first, then flashes to
  // the grade the node rolled.
  const REVEAL = 0.8;

  // Turns readings into extractions, grouped into nodes of up to three. feed(seconds, reading).
  // opts.onDone(extraction) is called as each one finishes. Each extraction has:
  //   openGrade  the grade it opened at (random per extraction), which sets its odds of success
  //   grade      the grade it ended at; higher than openGrade when Ore Appraiser procs on a success
  //   tierUp     whether Appraiser raised it; qty 2 when Plentiful Harvest's x2 orb shows, else 1
  //   item       when its icon matched a known one, the item's names (icons shared by two items list both);
  //              openItem likewise for the grade it opened at; material, names of any grade of the same
  //              material, when only that much was sure
  //   odd        reasons it's worth a second look, for a problem report
  // opts.mode 'craft' reads the crafting popup, which has no item to name: only a craft cut short is odd.
  function tracker(opts) {
    opts = Object.assign({ nodeGap: 3, full: 0.97, lost: 0.6 }, opts || {});
    const ex = [], nodes = [];
    let cur = null, lastSeen = -Infinity;
    const mode = list => {
      const m = new Map(); let best = null;
      for (const v of list) { m.set(v, (m.get(v) || 0) + 1); if (!best || m.get(v) > m.get(best)) best = v; }
      return best;
    };
    function close(t, how) {
      if (!cur) return;
      cur.closedBy = how;
      cur.blue = cur.blues * 2 > cur.seen.length;
      delete cur.blues;
      cur.end = cur.result ? cur.resultAt : t;
      if (!cur.result) cur.result = 'interrupted';
      const before = cur.result === 'interrupted' ? cur.seen : cur.seen.filter(s => s.t < cur.resultAt);
      const settled = before.filter(s => s.t >= cur.start + REVEAL && s.g);
      cur.openGrade = mode((settled.length ? settled : before.filter(s => s.g)).map(s => s.g)) || cur.firstGrade;
      const after = cur.result === 'success' ? cur.seen.filter(s => s.t >= cur.resultAt && s.g) : [];
      cur.grade = after.length ? after[after.length - 1].g : cur.openGrade;
      // The item icon names the item outright when it matches a known one, and that beats the title color.
      // When it's only sure of the material (two grades of it look alike), the grade stays with the title.
      if (ICONS) {
        const open = before.filter(s => s.t >= cur.start + REVEAL && s.item != null), fin = cur.result === 'success' ? cur.seen.filter(s => s.t >= cur.resultAt && s.item != null) : [];
        const openSure = mode(open.filter(s => s.sure).map(s => s.item)), finSure = fin.filter(s => s.sure).map(s => s.item).pop();
        const any = mode(open.map(s => s.item)) != null ? mode(open.map(s => s.item)) : fin.map(s => s.item).pop();
        if (any != null) cur.material = ICONS[any].names;
        if (openSure != null) { cur.openItem = ICONS[openSure].names; cur.openGrade = ICONS[openSure].grade; }
        if (finSure != null) { cur.item = ICONS[finSure].names; cur.grade = ICONS[finSure].grade; }
        else if (openSure != null && (cur.result !== 'success' || !after.length || cur.grade === ICONS[openSure].grade)) { cur.item = ICONS[openSure].names; if (cur.result === 'success') cur.grade = ICONS[openSure].grade; }
      }
      cur.tierUp = cur.result === 'success' && cur.grade in RANK && cur.openGrade in RANK && RANK[cur.grade] > RANK[cur.openGrade];
      cur.qty = cur.result === 'success' ? (cur.x2 >= 2 ? 2 : 1) : 0;
      // A title color that matched no grade, as hex, so it can be added.
      if (!cur.grade && cur.oddRgb) cur.titleColor = '#' + cur.oddRgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
      delete cur.oddRgb;
      // Anything worth a second look, for a problem report: misreads, and rare cases to confirm.
      cur.odd = [];
      if (opts.mode === 'craft') { if (cur.result === 'interrupted') cur.odd.push('popup closed before a result'); }
      else {
        if (ICONS && !cur.material) cur.odd.push('item not recognized');
        if (!cur.openGrade || (cur.result === 'success' && !cur.grade)) cur.odd.push('grade not recognized');
        if (cur.result === 'interrupted') cur.odd.push('popup closed before a result');
        if (cur.orb && cur.qty < 2) cur.odd.push('green icon without x2');
        if (cur.tierUp) cur.odd.push('tier-up');
        if (/^(Pure|Radiant)$/.test(cur.grade) || /^(Pure|Radiant)$/.test(cur.openGrade)) cur.odd.push((RANK[cur.grade] > RANK[cur.openGrade] ? cur.grade : cur.openGrade) + ' grade');
      }
      // Which item this node gives: its icon while the popup still shows Common, since the icon changes
      // with the grade.
      cur.icon = medianIcon(cur.iconCommon.length ? cur.iconCommon : cur.iconOther);
      delete cur.seen; delete cur.iconCommon; delete cur.iconOther;
      ex.push(cur);
      const node = nodes[nodes.length - 1];
      if (node && cur.start - node.lastEnd <= opts.nodeGap && node.ex.length < 3) { node.ex.push(cur); node.lastEnd = cur.end; }
      else nodes.push({ start: cur.start, lastEnd: cur.end, ex: [cur] });
      cur.node = nodes.length;
      if (opts.onDone) opts.onDone(cur);
      cur = null;
    }
    function feed(t, r) {
      if (!r.present) { if (cur && t - lastSeen > opts.lost) close(lastSeen, 'gone'); return; }
      lastSeen = t;
      // Empty bars after a result: the next extraction at the same node has started.
      if (cur && cur.result && r.s < 0.25 && r.f < 0.25 && !r.sDone && !r.fDone) close(t, 'reset');
      if (!cur) cur = { start: t, firstGrade: r.grade, seen: [], iconCommon: [], iconOther: [], x2: 0, orb: false, blues: 0, result: null, resultAt: null };
      if (!cur.firstGrade && r.grade) cur.firstGrade = r.grade;
      cur.seen.push({ t: t, g: r.grade, item: r.item ? r.item.i : null, sure: !!(r.item && r.item.sure) });
      if (r.blue) cur.blues++;
      if (!r.grade && r.gradeRgb) cur.oddRgb = r.gradeRgb;
      const icons = r.grade === 'Common' ? cur.iconCommon : cur.iconOther;
      if (r.icon && icons.length < 40) icons.push(r.icon);
      if (!cur.result && (r.sDone || r.s >= opts.full)) { cur.result = 'success'; cur.resultAt = t; }
      else if (!cur.result && (r.fDone || r.f >= opts.full)) { cur.result = 'fail'; cur.resultAt = t; }
      // A double needs the green orb and its x2 together: Ore Appraiser's icon is green without the x2,
      // and the edge of a Fine panel can read as white without any green.
      if (cur.result === 'success') { if (r.x2 && r.orb) cur.x2++; if (r.orb) cur.orb = true; }
    }
    function finish(t) { close(t, 'end'); return { extractions: ex, nodes: nodes }; }
    return { feed: feed, finish: finish };
  }

  // Totals for a set of extractions. byOpen counts attempts and successes by the grade each opened at,
  // since that sets the odds; d (doubles) and u (Appraiser tier-ups) both happen on successes.
  function summarize(res, seconds) {
    const done = res.extractions.filter(e => e.result !== 'interrupted');
    const ok = done.filter(e => e.result === 'success');
    const byGrade = {}, byOpen = {};
    for (const e of ok) { const g = e.grade || '?'; byGrade[g] = (byGrade[g] || 0) + e.qty; }
    for (const e of done) {
      const g = e.openGrade || '?', o = byOpen[g] || (byOpen[g] = { x: 0, ok: 0 });
      o.x++; if (e.result === 'success') o.ok++;
    }
    return {
      seconds: seconds, nodes: res.nodes.length, x: done.length, ok: ok.length, fail: done.length - ok.length,
      d: ok.filter(e => e.qty > 1).length, u: ok.filter(e => e.tierUp).length,
      sec: done.reduce((s, e) => s + (e.end - e.start), 0), items: ok.reduce((s, e) => s + e.qty, 0), byGrade: byGrade, byOpen: byOpen,
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
      '.........................', '.........................', '.........................'], 'white', 'gather'],
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
      '.............................................................................................'], 'green', 'gather'],
    // The crafting popup's close button, where the gathering popup has its (i) icon.
    [330, 42, [
      '............#..................', '.............#............#....', '..............#..........#.....', '..............##.......##......',
      '...............##.....##.......', '................##..###........', '.................######........', '..................####.........',
      '.................#####.........', '................###.###........', '................##....##.......', '...............##......##......',
      '..............#.........##.....', '.............#...........#.....', '............#.............#....'], 'white', 'craft']
  ];
  const INK = {
    white: (d, i) => d[i] > 170 && d[i + 1] > 170 && d[i + 2] > 170,
    green: (d, i) => d[i + 1] > 150 && d[i + 1] > d[i] + 60 && d[i + 1] > d[i + 2] + 40
  };
  // Each anchor's text pixels and a sample of the pixels around them: a light set for the first, wide
  // search and a full one to settle the exact spot.
  const MASKS = LABELS.map(([x0, y0, rows, ink, mode]) => {
    const on = [], off = [];
    rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) (row[x] === '#' ? on : off).push([x0 + x, y0 + y]); });
    return {
      ink: INK[ink || 'white'], label: !ink, far: x0 > 300 || y0 < 30, mode: mode || null,
      coarse: { on: on.filter((_, i) => i % 2 === 0), off: off.filter((_, i) => i % 6 === 0) },
      fine: { on: on, off: off.filter((_, i) => i % 2 === 0) }
    };
  });
  // The point between the two bar labels: the size search scales around it, so the labels stay put while
  // the far anchors (the (i) icon and "Professional") settle the size.
  const PIVOT = [86, 84];
  // Finds the popup in a frame near a rough box someone drew around it ({ x, y, w, h } in the frame's
  // pixels) by matching its fixed text: the bar labels, then the (i) icon and "Professional" on the
  // gathering popup, or the close button on the crafting popup (mode 'craft'). Returns the exact box in
  // pixels and how well the bar labels matched (0.8 to 1 when found, under 0.3 when not).
  function locate(f, rough, mode) {
    const masks = MASKS.filter(m => !m.mode || m.mode === (mode || 'gather'));
    const ch = f.ch || 4, d = f.data;
    const hit = (ink, x, y) => {
      x = Math.round(x); y = Math.round(y);
      return x >= 0 && y >= 0 && x < f.w && y < f.h && ink(d, (y * f.w + x) * ch);
    };
    // Within a pixel: the far anchors' thin strokes would otherwise only count at the exact size.
    const near = (ink, x, y) => {
      x = Math.round(x); y = Math.round(y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (hit(ink, x + dx, y + dy)) return true;
      return false;
    };
    const score = (ox, oy, s, set, labelsOnly) => {
      let total = 0, n = 0;
      for (const m of masks) {
        if (labelsOnly && !m.label) continue;
        const pts = m[set], on = m.far && set === 'fine' ? near : hit;
        let a = 0, b = 0;
        for (const p of pts.on) if (on(m.ink, ox + p[0] * s, oy + p[1] * s)) a++;
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
    // Settle the position on the labels, then the size by scaling around them in small steps.
    let top = null;
    for (const c of best.slice()) {
      const r = Math.max(2, Math.round(2 * c.s));
      let pin = null;
      for (let oy = c.oy - r; oy <= c.oy + r; oy++) for (let ox = c.ox - r; ox <= c.ox + r; ox++) {
        const v = score(ox, oy, c.s, 'fine', true);
        if (!pin || v > pin.v) pin = { x: ox + PIVOT[0] * c.s, y: oy + PIVOT[1] * c.s, v: v };
      }
      for (let s = c.s * 0.88; s <= c.s * 1.12; s *= 1.0025) {
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const ox = pin.x + dx - PIVOT[0] * s, oy = pin.y + dy - PIVOT[1] * s, v = score(ox, oy, s, 'fine');
          if (!top || v > top.v) top = { ox: ox, oy: oy, s: s, v: v };
        }
      }
    }
    return { x: top.ox, y: top.oy, w: REF_W * top.s, h: REF_H * top.s, match: score(top.ox, top.oy, top.s, 'fine', true) };
  }

  // Crafting uses the same popup: each run of the bars is one craft. When a successful craft procs its
  // combo, the bars start again at once for the Splendent craft, without the popup closing, and its panel
  // turns blue or its title changes color. That run is the craft's combo, not a new craft. A new craft in a
  // batch always closes the popup for a moment first.
  function crafts(list) {
    const out = [];
    for (const e of list) {
      const prev = out[out.length - 1];
      if (prev && prev.combo == null && prev.result === 'success' && prev.closedBy === 'reset' && ((e.blue && !prev.blue) || (e.openGrade && e.openGrade !== prev.openGrade))) {
        prev.combo = e.result; prev.comboEnd = e.end; prev.kind2 = e.kind; continue;
      }
      out.push({ start: e.start, end: e.end, result: e.result, closedBy: e.closedBy, blue: e.blue, openGrade: e.openGrade, combo: null, kind: e.kind, icon: e.icon });
    }
    return out;
  }
  // Totals for crafts: attempts, successes, combo procs (cp) and combo crafts that landed (cok), which
  // give a Splendent instead of the normal item, and seconds per craft from one craft's start to the next.
  function craftSummary(items) {
    const done = items.filter(c => c.result !== 'interrupted'), ok = done.filter(c => c.result === 'success');
    const procs = ok.filter(c => c.combo != null), landed = procs.filter(c => c.combo === 'success');
    let sec = 0, n = 0;
    for (let i = 0; i + 1 < items.length; i++) { const d = items[i + 1].start - items[i].start; if (d > 0 && d < 120) { sec += d; n++; } }
    return { x: done.length, ok: ok.length, fail: done.length - ok.length, cp: procs.length, cok: landed.length, normal: ok.length - landed.length, splendent: landed.length, perCraft: n ? sec / n : NaN };
  }
  function iconName(i) { return ICONS && ICONS[i] ? ICONS[i].names[0] : null; }

  const api = { read: read, tracker: tracker, summarize: summarize, crafts: crafts, craftSummary: craftSummary, locate: locate, useIcons: useIcons, iconName: iconName, iconDist: iconDist, ICON_SAME: ICON_SAME, ITEM_BOX: L.item, REF_W: REF_W, REF_H: REF_H };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.GatherReader = api;
})(this);
