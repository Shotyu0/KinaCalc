(function () {
  'use strict';

  /* ---------- constants ---------- */
  const PROFESSIONS = ['Blacksmithing', 'Armorsmithing', 'Jewelcrafting', 'Alchemy', 'Cooking'];
  // AION2 Hub's names for professions the Global client calls something else.
  const PROF_ALIAS = { Tailoring: 'Armorsmithing' };
  function profName(p) { return PROF_ALIAS[p] || p; }
  // Success % by (your crafting level - recipe level), read from the Global client's Crafting Chance window
  // (Expected Probability). Each item grade has its own table, but all of them follow one curve: at a given
  // difference they're the same share of the way from the grade's starting chance to its cap. Rows not read
  // from the game yet come from that curve, which is measured best for Unique.
  const GRADES = ['Common', 'Rare', 'Epic', 'Unique'];
  const RATE_DATA = {
    Common: { 0: 74.011698, 1: 74.718902, 2: 75.631177, 3: 77.467106, 4: 77.669025, 5: 78.187021, 6: 79.129959, 7: 80.157193, 8: 80.991798, cap: 93.121326 },
    Rare: { 0: 76.828488, 1: 77.723444, 2: 78.724623, 3: 79.313600, 4: 80.308174, 5: 81.622882, 6: 82.096098, 7: 82.881229, 8: 83.645249, cap: 94.633946 },
    Epic: { 0: 79.571081, 1: 80.124386, 2: 80.926125, 3: 82.284634, 4: 82.883323, 5: 83.573495, 6: 84.114718, 7: 85.476782, 8: 85.793152, cap: 96.837241 },
    Unique: {
      0: 67.506212, 1: 68.198244, 2: 69.824562, 3: 71.774814, 4: 72.773479, 5: 74.093554, 6: 75.222343, 7: 76.203609, 8: 77.541261,
      18: 85.309191, 19: 85.836292, 20: 86.168055, 21: 86.922289, 22: 87.551611, 23: 88.112297, 24: 88.383568, 25: 88.600967,
      29: 90.335508, 30: 90.474499, 31: 90.594902, 32: 90.971587, 33: 91.491841, 34: 91.491841, 35: 92.029715, 36: 92.360459,
      37: 92.443413, 38: 92.443413, 57: 94.639789, cap: 94.639789
    }
  };
  // The COMBO column. Where it's measured, a combo craft fails about half as often as a normal craft at the same
  // difference, so unmeasured rows use that.
  const COMBO_KNOWN = { Unique: { 29: 95.042391, 30: 95.266197, 31: 95.320780, 32: 95.472605, 33: 95.472605, 34: 95.826254, 35: 96.160854, 36: 96.160854 } };
  const MAX_GAP = 57; // every table has reached its cap by this difference
  const RATES = (() => {
    const u = RATE_DATA.Unique, b0 = u[0], span = u.cap - b0;
    const pts = {};
    for (const g of Object.keys(u)) if (g !== 'cap') pts[+g] = (u[g] - b0) / span;
    const xs = Object.keys(pts).map(Number).sort((a, b) => a - b);
    const curve = [];
    for (let g = 0; g <= MAX_GAP; g++) {
      if (g in pts) { curve.push(pts[g]); continue; }
      const lo = xs.filter(x => x < g).pop(), hi = xs.find(x => x > g);
      curve.push(pts[lo] + (pts[hi] - pts[lo]) * (g - lo) / (hi - lo));
    }
    const out = {};
    for (const grade of GRADES) {
      const d = RATE_DATA[grade], ck = COMBO_KNOWN[grade] || {};
      out[grade] = curve.map((f, g) => {
        const known = g in d;
        const basic = known ? d[g] : d[0] + (d.cap - d[0]) * f;
        const cKnown = g in ck;
        return { gap: g, basic: basic, combo: cKnown ? ck[g] : 100 - (100 - basic) / 2, known: known, cKnown: cKnown };
      });
    }
    return out;
  })();
  // Recipes without a grade we have a table for use Unique, the hardest start.
  function gradeOf(r) { return GRADES.indexOf(r && r.grade) >= 0 ? r.grade : 'Unique'; }
  function rateRow(grade, gap) { return RATES[GRADES.indexOf(grade) >= 0 ? grade : 'Unique'][Math.max(0, Math.min(MAX_GAP, Math.floor(gap)))]; }
  const LS_DATA = 'kina-ledger:data:v1';
  const LS_UI = 'kina-ledger:ui:v1';
  const DAY = 864e5;
  const HIST_MAX = 200;
  const HIST_MERGE_MS = 10 * 60 * 1000;
  const PAGE = 50;
  const TABS = [['rank', 'Rankings'], ['gather', 'Gathering'], ['recipes', 'Recipes'], ['prices', 'Prices'], ['shots', 'Import'], ['settings', 'Settings']];
  const METRIC = {
    buy: { short: 'Buying all mats', hint: 'Every material bought at its cheapest source: the market, an NPC vendor, or crafting it from bought parts.' },
    gather: { short: 'With own gathering', hint: 'Materials you mark as gatherable cost nothing. This is the Kina you actually take home.' },
    opp: { short: 'Gain vs selling raw', hint: 'Gathered materials count at what they would sell for after the fee. Above zero means crafting beats selling the raw materials.' }
  };
  const ROUTE = { buy: 'Market', vendor: 'NPC', gather: 'Gather', craft: 'Craft', combo: 'Combo', missing: 'No price' };
  const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,160}$/;

  let CAT = { recipes: [] }; // loaded from data/catalog.json at startup
  let GATHERABLE = null; // names of materials gathered from nodes, from data/gather-icons.json
  const BUILD = '2026-10-25c'; // shown in the footer, to tell which version a browser is running

  /* ---------- formatting ---------- */
  const NF0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const NF1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
  const NF2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const s = String(v).trim().toLowerCase().replace(/[,\s_]/g, '');
    const m = s.match(/^(-?\d*\.?\d+)([kmb])?$/);
    if (!m) return null;
    const mult = m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : m[2] === 'b' ? 1e9 : 1;
    return parseFloat(m[1]) * mult;
  }
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }
  function k(n) { if (n == null || !isFinite(n)) return '—'; return Math.abs(n) < 100 && n % 1 ? NF1.format(n) : NF0.format(Math.round(n)); }
  function sk(n) { if (n == null || !isFinite(n)) return '—'; const r = Math.round(n); return (r > 0 ? '+' : r < 0 ? '−' : '') + NF0.format(Math.abs(r)); }
  function qfmt(n) { return n == null || !isFinite(n) ? '—' : NF2.format(n); }
  function pct(x, d) { return x == null || !isFinite(x) ? '—' : (x * 100).toFixed(d == null ? 1 : d) + '%'; }
  function roiTxt(x) { return x === Infinity ? '∞' : x == null || !isFinite(x) ? '—' : NF0.format(Math.round(x * 100)) + '%'; }
  function compact(n) {
    const a = Math.abs(n);
    if (a >= 1e9) return NF1.format(n / 1e9) + 'B';
    if (a >= 1e6) return NF1.format(n / 1e6) + 'M';
    if (a >= 1e4) return NF1.format(n / 1e3) + 'K';
    return NF0.format(n);
  }
  function tone(n) { return n == null || !isFinite(n) ? 'muted' : n >= 0 ? 'gain' : 'loss'; }
  function ago(ts) {
    if (!ts) return '—';
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    if (s < 86400 * 30) return Math.floor(s / 86400) + ' d ago';
    return new Date(ts).toLocaleDateString();
  }
  function when(ts) { return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  function norm(s) { return String(s || '').toLowerCase().replace(/[‘’`´]/g, "'").replace(/\s+/g, ' ').trim(); }
  function loose(s) { return norm(s).replace(/[^a-z0-9]+/g, ' ').trim(); }
  function uid(p) { return p + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4); }
  function slugId(name) { const s = loose(name).replace(/ /g, '-').slice(0, 140); return s ? 'n_' + s : uid('n'); }
  function plural(n, w) { return NF0.format(n) + ' ' + w + (n === 1 ? '' : 's'); }
  function str(v) { return v == null ? '' : String(v); }

  /* ---------- state ---------- */
  // Crafting levels are stored as the game's total: Novice 1–50 is 1–50, Professional 1–50 is 51–100.
  function readLevels(obj) {
    const out = {};
    if (obj && typeof obj === 'object') {
      for (const p of Object.keys(obj)) {
        const name = profName(p);
        if (num(obj[p]) != null && (name === p || !(name in obj))) out[name] = num(obj[p]);
      }
    }
    return out;
  }
  function lvTxt(total) {
    if (total == null || !isFinite(total)) return '';
    return total > 50 ? 'Professional Lv ' + (total - 50) : 'Novice Lv ' + total;
  }
  function mergeSettings(d) {
    const s = { tax: 10, listFee: 2, failLoss: 100, levels: {}, showPending: false, runs: [], crafts: [], craftMin: null };
    if (d && typeof d === 'object') {
      s.showPending = !!d.showPending;
      if (num(d.tax) != null) s.tax = num(d.tax);
      if (num(d.listFee) != null) s.listFee = num(d.listFee);
      if (num(d.failLoss) != null) s.failLoss = num(d.failLoss);
      s.levels = readLevels(d.levels);
      s.runs = readRuns(d.runs);
      s.crafts = readCrafts(d.crafts);
      if (num(d.craftMin) > 0) s.craftMin = num(d.craftMin);
    }
    return s;
  }
  const UI_KEYS = { tab: 's', goal: 's', metric: 's', per: 's', prof: 's', crafts: 's', wanted: 's', planGather: 'b', priceSort: 's', priceFilter: 's', rankAll: 'b', canCraft: 'b', recProf: 's', recSrc: 's', budget: 's', affordOnly: 'b', gatherShow: 's', gatherOdds: 's', gatherNoBreaks: 'b' };
  function readUI() {
    try {
      const x = JSON.parse(localStorage.getItem(LS_UI) || '{}') || {};
      const o = {};
      for (const key of Object.keys(UI_KEYS)) if (typeof x[key] === (UI_KEYS[key] === 'b' ? 'boolean' : 'string')) o[key] = x[key];
      if (o.tab && !TABS.some(t => t[0] === o.tab)) delete o.tab;
      if (o.metric && !Object.prototype.hasOwnProperty.call(METRIC, o.metric)) delete o.metric;
      return o;
    } catch (_) { return {}; }
  }
  function saveUI() {
    const o = {};
    for (const key of Object.keys(UI_KEYS)) o[key] = UI[key];
    try { localStorage.setItem(LS_UI, JSON.stringify(o)); } catch (_) {}
  }

  // auth: 'off' (no Firebase config) | 'pending' | 'out' | 'notmember' | 'member'. role: what this person may change.
  const S = { items: new Map(), recipes: new Map(), settings: mergeSettings(null), ready: false, mode: 'pending', auth: 'pending', role: 'owner', email: null, uid: null, mine: null, myGather: null, myRuns: null, myCrafts: null, myCraftMin: null, pool: new Map() };
  // The owner manages recipes, settings and deleting items; members update prices and their own levels.
  function canManage() { return S.mode !== 'db' || S.role === 'owner'; }
  // Your crafting levels: your own copy when the page knows who you are, otherwise the shared settings.
  function myLevels() { return S.uid ? (S.mine || {}) : S.settings.levels; }
  function setLevel(p, total) {
    const lv = Object.assign({}, myLevels());
    if (total == null) delete lv[p]; else lv[p] = total;
    if (S.uid && DB) { S.mine = lv; writePrefs(); }
    else Store.putSettings(Object.assign({}, S.settings, { levels: lv }));
  }
  // Which items you gather yourself. In the shared price book everyone keeps their own list; the
  // owner starts from the marks made before gathering became personal. In this browser alone, the
  // item's own flag is used.
  const NO_GATHER = new Set();
  let gatherSeed = { v: -1, set: NO_GATHER };
  function myGather() {
    if (!S.uid) return null;
    if (S.myGather) return S.myGather;
    if (S.role !== 'owner') return NO_GATHER;
    if (gatherSeed.v !== itemsVer) {
      const seed = new Set();
      for (const it of S.items.values()) if (it.gather) seed.add(it.id);
      gatherSeed = { v: itemsVer, set: seed };
    }
    return gatherSeed.set;
  }
  function isGathered(it) {
    if (!it) return false;
    const mine = myGather();
    return mine ? mine.has(it.id) : !!it.gather;
  }
  function setGather(ids, on) {
    if (S.uid && DB) {
      const next = new Set(myGather());
      for (const id of ids) { if (on) next.add(id); else next.delete(id); }
      S.myGather = next; itemsVer++;
      writePrefs();
      return;
    }
    for (const id of ids) {
      const it = getItem(id);
      if (!it) continue;
      const next = Object.assign({}, it, { gather: on, example: false });
      delete next.virtual;
      Store.putItem(next);
    }
  }
  // Your gathering sessions (how long you worked one kind of node and how many of each grade you got)
  // and the minutes one craft takes you. Like levels, they're yours alone in the shared price book and
  // kept with the settings in this browser alone. A session is { f: node's base item, m: minutes,
  // n: { item: count }, t: when }.
  const RUNS_MAX = 300;
  function readRuns(list) {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (const x of list) {
      if (!x || typeof x !== 'object' || typeof x.f !== 'string' || !ID_RE.test(x.f)) continue;
      const m = num(x.m), n = {};
      if (!(m > 0 && m <= 1440)) continue;
      if (x.n && typeof x.n === 'object') for (const id of Object.keys(x.n)) { const c = num(x.n[id]); if (ID_RE.test(id) && c >= 0 && c < 1e6) n[id] = c; }
      const st = readRunStats(x.st);
      out.push(Object.assign({ f: x.f, m: m, n: n, t: num(x.t) > 0 ? num(x.t) : 0 }, st ? { st: st } : {}));
    }
    return out.slice(-RUNS_MAX);
  }
  const OPEN_GRADES = ['Common', 'Fine', 'Pure', 'Radiant'];
  // A tracked session's counts: extractions, successes, doubles, tier-ups, seconds spent extracting;
  // g: [extractions, successes] by the grade each extraction opened at; t: successes by opening grade
  // (row) and final grade (column), 4x4 in OPEN_GRADES order; and act, mov, brk: seconds gathering,
  // moving between nodes, and on breaks.
  function readRunStats(o) {
    if (!o || typeof o !== 'object') return null;
    const s = {};
    for (const k of ['x', 'ok', 'd', 'u', 'sec']) { const v = num(o[k]); if (!(v >= 0 && v < 1e7)) return null; s[k] = v; }
    if (o.g && typeof o.g === 'object') {
      s.g = {};
      for (const grade of OPEN_GRADES) {
        const v = o.g[grade];
        if (Array.isArray(v) && v.length === 2 && num(v[0]) >= 0 && num(v[1]) >= 0 && num(v[1]) <= num(v[0])) s.g[grade] = [num(v[0]), num(v[1])];
      }
    }
    if (Array.isArray(o.t) && o.t.length === 16 && o.t.every(v => num(v) >= 0)) s.t = o.t.map(num);
    for (const k of ['act', 'mov', 'brk']) { const v = num(o[k]); if (v >= 0 && v < 1e6) s[k] = v; }
    return s;
  }
  // The kind of node, for pooling odds: the skills that double or raise a harvest are per kind.
  function nodeKind(name) { return /Ore$/.test(name) ? 'Ore' : /Gemstone$/.test(name) ? 'Gemstone' : /Odyle$/.test(name) ? 'Odyle' : /Log$/.test(name) ? 'Log' : 'Other'; }
  // Your odds for each kind of node, pooled from every tracked session of that kind: how often an
  // extraction opens at each grade, succeeds from it and ends at each grade, and doubles. items[h] is the
  // expected count of grade h per extraction, which steadies an hour's value against lucky or unlucky
  // rare grades.
  function gatherOdds() {
    const by = {};
    for (const r of myRuns()) {
      if (!r.st || !r.st.t || !r.st.g) continue;
      const k = nodeKind(itemName(r.f)), o = by[k] || (by[k] = { x: 0, ok: 0, d: 0, open: [0, 0, 0, 0], okBy: [0, 0, 0, 0], t: Array(16).fill(0), nodes: new Set() });
      o.x += r.st.x; o.ok += r.st.ok; o.d += r.st.d; o.nodes.add(r.f);
      OPEN_GRADES.forEach((g, i) => { const v = r.st.g[g]; if (v) { o.open[i] += v[0]; o.okBy[i] += v[1]; } });
      r.st.t.forEach((v, i) => { o.t[i] += v; });
    }
    for (const k of Object.keys(by)) {
      const o = by[k], opened = o.open.reduce((s, v) => s + v, 0), dbl = o.ok ? o.d / o.ok : 0;
      o.items = [0, 0, 0, 0];
      for (let g = 0; g < 4; g++) {
        if (!o.open[g] || !opened) continue;
        const pOpen = o.open[g] / opened, pOk = o.okBy[g] / o.open[g], row = o.t.slice(g * 4, g * 4 + 4), rowN = row.reduce((s, v) => s + v, 0);
        for (let h = 0; h < 4; h++) o.items[h] += pOpen * pOk * (rowN ? row[h] / rowN : (h === g ? 1 : 0)) * (1 + dbl);
      }
    }
    return by;
  }
  // Your opening-grade counts per node, [Common, Fine, Pure, Radiant], from your tracked sessions, shared
  // with the other members (pool/{uid}) for the pooled opening odds: the grade a node opens at is a roll of
  // the node, the same for everyone.
  function myPoolNodes() {
    const nodes = {};
    for (const r of myRuns()) {
      if (!r.st || !r.st.g) continue;
      const c = nodes[r.f] || (nodes[r.f] = [0, 0, 0, 0]);
      OPEN_GRADES.forEach((g, i) => { if (r.st.g[g]) c[i] += r.st.g[g][0]; });
    }
    return nodes;
  }
  // Your totals per node, also shared unless you turn it off (st), for everyone's rates. From every
  // session: minutes (m) and items (n). From tracked ones: extractions, successes, doubles, tier-ups,
  // seconds gathering, active, moving and break seconds, and [extractions, successes] by the grade they
  // opened at (g: Common, Fine, Pure, Radiant). No names. Success depends on each person's level and skills.
  // Here g is a list of four pairs; it's stored as { Common: [x, ok], … }, since Firestore can't hold a list
  // inside a list.
  const POOL_KEYS = ['m', 'x', 'ok', 'd', 'u', 'sec', 'act', 'mov', 'brk'];
  function myPoolStats() {
    const st = {}, r1 = v => Math.round(v * 10) / 10;
    for (const r of myRuns()) {
      const o = st[r.f] || (st[r.f] = { m: 0, x: 0, ok: 0, d: 0, u: 0, sec: 0, act: 0, mov: 0, brk: 0, n: {}, g: [[0, 0], [0, 0], [0, 0], [0, 0]] });
      o.m = r1(o.m + r.m);
      for (const id of Object.keys(r.n)) o.n[id] = (o.n[id] || 0) + r.n[id];
      if (!r.st) continue;
      for (const k of POOL_KEYS) if (k !== 'm') o[k] = r1(o[k] + (r.st[k] || 0));
      if (r.st.g) OPEN_GRADES.forEach((g, i) => { const v = r.st.g[g]; if (v) { o.g[i][0] += v[0]; o.g[i][1] += v[1]; } });
    }
    return st;
  }
  function readPoolStat(o) {
    if (!o || typeof o !== 'object') return null;
    const s = {}, ok = v => v != null && v >= 0 && v < 1e8;
    for (const k of POOL_KEYS) { const v = num(o[k]); s[k] = ok(v) ? v : 0; }
    s.n = {};
    if (o.n && typeof o.n === 'object') for (const id of Object.keys(o.n)) { const v = num(o.n[id]); if (ID_RE.test(id) && ok(v)) s.n[id] = v; }
    s.g = OPEN_GRADES.map((grade, i) => {
      const w = o.g && typeof o.g === 'object' ? (Array.isArray(o.g) ? o.g[i] : o.g[grade]) : null;
      const v = Array.isArray(w) ? w : [], a = ok(num(v[0])) ? num(v[0]) : 0, b = ok(num(v[1])) ? num(v[1]) : 0;
      return [a, Math.min(a, b)];
    });
    s.ok = Math.min(s.ok, s.x); s.d = Math.min(s.d, s.ok); s.u = Math.min(s.u, s.ok);
    return s;
  }
  function readPool(x) {
    const nodes = {}, st = {};
    if (x && x.nodes && typeof x.nodes === 'object') {
      for (const f of Object.keys(x.nodes)) {
        const c = x.nodes[f];
        if (ID_RE.test(f) && Array.isArray(c) && c.length === 4 && c.every(v => num(v) >= 0 && num(v) < 1e7)) nodes[f] = c.map(num);
      }
    }
    if (x && x.st && typeof x.st === 'object') for (const f of Object.keys(x.st)) { const o = readPoolStat(x.st[f]); if (ID_RE.test(f) && o) st[f] = o; }
    return { nodes: nodes, st: st, private: !!(x && x.private === true) };
  }
  // The same data always gives the same text, whatever order its keys came in.
  function canon(v) { return JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().reduce((o, kk) => { o[kk] = x[kk]; return o; }, {}) : x); }
  let poolSent = '';
  // Publishes your counts and totals when they change, once your sessions and the pool have both loaded,
  // so a choice not to share is known first. Signing in only fills them in, never clears them; clearing
  // takes removing your own sessions (saved). force writes even when it looks unchanged.
  function writePool(saved, force) {
    if (!S.uid || !DB || S.myRuns === null || !S.poolLoaded) return;
    const had = S.pool.get(S.uid), priv = !!(had && had.private);
    const nodes = myPoolNodes(), raw = priv ? {} : myPoolStats(), st = {};
    for (const f of Object.keys(raw)) st[f] = readPoolStat(raw[f]);
    if (!saved && !Object.keys(nodes).length && !Object.keys(st).length) return;
    const key = canon([nodes, st, priv]);
    if (!force && (key === poolSent || (had && canon([had.nodes, had.st, had.private]) === key))) { poolSent = key; return; }
    poolSent = key;
    const body = { nodes: nodes, at: Date.now() };
    if (Object.keys(st).length) {
      body.st = {};
      for (const f of Object.keys(st)) {
        const g = {};
        OPEN_GRADES.forEach((grade, i) => { if (st[f].g[i][0]) g[grade] = st[f].g[i]; });
        body.st[f] = Object.assign({}, st[f], { g: g });
      }
    }
    if (priv) body.private = true;
    // Firestore with the older rules refuses the totals; then just the counts go, as before, so no one
    // sees an error before the owner publishes the new rules. Data Firestore can't store at all is refused
    // before anything is sent, so that's caught too.
    const ref = DB.doc('pool/' + S.uid), failed = e => {
      if (e && e.code === 'permission-denied' && (body.st || body.private)) { S.poolRefused = true; scheduleRender(); ref.set({ nodes: nodes, at: body.at }).catch(e2 => writeFailed(e2, 'pool/' + S.uid)); }
      else writeFailed(e, 'pool/' + S.uid);
    };
    try { ref.set(body).catch(failed); } catch (e) { failed(e); }
  }
  // Everyone's totals per node: each member's shared ones, and yours from your own sessions.
  function communityStats() {
    const entries = new Map(S.pool), all = new Map();
    if (S.uid) entries.set(S.uid, { st: myPoolStats() });
    for (const [, p] of entries) for (const f of Object.keys(p.st || {})) {
      const s = p.st[f];
      if (!s || !(s.m > 0 || s.x > 0)) continue;
      const a = all.get(f) || { people: 0, m: 0, x: 0, ok: 0, d: 0, u: 0, sec: 0, act: 0, mov: 0, brk: 0, n: {}, g: [[0, 0], [0, 0], [0, 0], [0, 0]] };
      a.people++;
      for (const k of POOL_KEYS) a[k] += s[k] || 0;
      for (const id of Object.keys(s.n || {})) a.n[id] = (a.n[id] || 0) + s.n[id];
      (s.g || []).forEach((v, i) => { a.g[i][0] += v[0]; a.g[i][1] += v[1]; });
      all.set(f, a);
    }
    return all;
  }
  // Success by the grade extractions opened at, short: "Common 92% · Fine 100%".
  function openShort(g) { return OPEN_GRADES.map((k, i) => g[i][0] ? k + ' ' + pct(g[i][1] / g[i][0], 0) : null).filter(Boolean).join(' · '); }
  // How often extractions open at each grade, from everyone in the shared price book (or just you): this
  // node's counts once there are OPEN_MIN, else every node of its kind's.
  const OPEN_MIN = 50;
  function openOdds(f, kind) {
    const entries = new Map(S.uid ? S.pool : []), node = [0, 0, 0, 0], all = [0, 0, 0, 0], who = new Set(), whoAll = new Set();
    entries.set(S.uid || 'me', { nodes: myPoolNodes() });
    for (const [uid, p] of entries) for (const key of Object.keys(p.nodes)) {
      const c = p.nodes[key];
      if (!c.some(v => v) || nodeKind(itemName(key)) !== kind) continue;
      c.forEach((v, i) => { all[i] += v; }); whoAll.add(uid);
      if (key === f) { c.forEach((v, i) => { node[i] += v; }); who.add(uid); }
    }
    const sum = a => a.reduce((s, v) => s + v, 0);
    if (sum(node) >= OPEN_MIN) return { c: node, n: sum(node), people: who.size, scope: 'node' };
    if (sum(all) >= OPEN_MIN) return { c: all, n: sum(all), people: whoAll.size, scope: 'kind' };
    return null;
  }
  // Expected items of each final grade per extraction: opening grades from open (or your own), then your
  // success rate from that grade (your overall rate for a grade you've never opened), your tier-ups from
  // it, and your doubles.
  function expectedItems(o, open) {
    const items = [0, 0, 0, 0], sum = a => a.reduce((s, v) => s + v, 0), c = open ? open.c : o.open, n = sum(c);
    const dbl = o.ok ? o.d / o.ok : 0, okAll = o.x ? o.ok / o.x : 0;
    if (!n) return items;
    for (let g = 0; g < 4; g++) {
      if (!c[g]) continue;
      const pOk = o.open[g] ? o.okBy[g] / o.open[g] : okAll, row = o.t.slice(g * 4, g * 4 + 4), rowN = sum(row);
      for (let h = 0; h < 4; h++) items[h] += c[g] / n * pOk * (rowN ? row[h] / rowN : (h === g ? 1 : 0)) * (1 + dbl);
    }
    return items;
  }
  // Odds are only used once this many extractions of a kind have been tracked.
  const ODDS_MIN = 30;
  // A gap with no extraction longer than this is a break, not moving between nodes.
  const BREAK_S = 120;
  // "Common 11 of 12 (92%) · Fine 3 of 3 (100%)" from { grade: [extractions, successes] }.
  function openRatesTxt(g) {
    return OPEN_GRADES.filter(k => g && g[k] && g[k][0]).map(k => k + ' ' + g[k][1] + ' of ' + g[k][0] + ' (' + pct(g[k][1] / g[k][0], 0) + ')').join(' · ');
  }
  // Your crafting sessions from live tracking: { r: recipe, t: when, m: minutes, x: crafts, ok: successes,
  // cp: combo procs, cok: combo crafts that landed (a Splendent), spc: seconds per craft, lv: your level }.
  function readCrafts(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const c of list) {
      if (!c || typeof c.r !== 'string' || !ID_RE.test(c.r)) continue;
      const o = { r: c.r };
      for (const k of ['t', 'm', 'x', 'ok', 'cp', 'cok', 'spc', 'lv']) { const v = num(c[k]); o[k] = v >= 0 && v < 1e13 ? v : 0; }
      if (o.x > 0 && o.ok <= o.x && o.cp <= o.ok && o.cok <= o.cp) out.push(o);
    }
    return out.slice(-RUNS_MAX);
  }
  function myCrafts() { return S.uid ? (S.myCrafts || []) : (S.settings.crafts || []); }
  function setCrafts(list) {
    list = list.slice(-RUNS_MAX);
    if (S.uid && DB) { S.myCrafts = list; writePrefs(); }
    else Store.putSettings(Object.assign({}, S.settings, { crafts: list }));
  }
  function myRuns() { return S.uid ? (S.myRuns || []) : (S.settings.runs || []); }
  function myCraftMin() { const v = S.uid ? S.myCraftMin : S.settings.craftMin; return v > 0 ? v : null; }
  function setRuns(list) {
    list = list.slice(-RUNS_MAX);
    if (S.uid && DB) { S.myRuns = list; writePrefs(); writePool(true); }
    else Store.putSettings(Object.assign({}, S.settings, { runs: list }));
  }
  function setCraftMin(v) {
    if (S.uid && DB) { S.myCraftMin = v; writePrefs(); }
    else Store.putSettings(Object.assign({}, S.settings, { craftMin: v }));
  }
  function writePrefs() {
    if (!S.uid || !DB) return;
    const body = { levels: myLevels(), gather: [...myGather()] };
    // Left out until used, so saving levels still works under rules from before the Gathering tab.
    if (myRuns().length) body.runs = myRuns();
    if (myCrafts().length) body.crafts = myCrafts();
    if (myCraftMin() != null) body.craftMin = myCraftMin();
    dbWrite('users/' + S.uid, body);
  }
  const UI = Object.assign({
    tab: 'rank', goal: 'normal', metric: 'buy', per: 'kina', prof: 'all', open: null, crafts: '1', wanted: '1', planGather: true,
    priceQuery: '', priceSort: 'name', priceFilter: 'all', priceShow: 100, priceOpen: null,
    rankQ: '', rankAll: false, canCraft: false, rankShow: PAGE,
    recQ: '', recProf: 'all', recSrc: 'all', recShow: PAGE, budget: '', affordOnly: false,
    gatherShow: '', gatherQ: '', gOpen: null, runDraft: null, gatherOdds: 'exp', gatherNoBreaks: false
  }, readUI());
  UI.editor = null; UI.editorErr = []; UI.editorFrom = 'recipes';
  UI.shots = { status: 'idle', market: null, source: null, pasteText: '', pasteNote: '' };
  UI.newItem = { name: '', price: '', gather: false };
  UI.io = { exportText: '', importText: '', msg: '' };
  UI.confirm = null;
  UI.live = { state: 'off' };

  let DB = null, AUTH = null, unsubs = [];
  let itemsVer = 0, recipesVer = 0;

  function readHist(h) {
    return Array.isArray(h) ? h.filter(p => p && num(p.t) && num(p.p) > 0).map(p => ({ t: num(p.t), p: num(p.p) })).sort((a, b) => a.t - b.t) : [];
  }
  function readMats(a) { return Array.isArray(a) ? a.filter(m => m && m.item).map(m => ({ item: String(m.item), qty: num(m.qty) || 0 })) : []; }
  function readItem(id, x) {
    x = x || {};
    return { id: id, name: String(x.name == null ? id : x.name).trim(), price: num(x.price), vendor: num(x.vendor), gather: !!x.gather, bound: !!x.bound, unavailable: !!x.unavailable, updatedAt: num(x.updatedAt), hist: readHist(x.hist), example: !!x.example };
  }
  function readRecipe(id, x) {
    x = x || {};
    return {
      id: id, output: String(x.output || ''), outQty: num(x.outQty) || 1,
      profession: typeof x.profession === 'string' ? profName(x.profession) : '', grade: typeof x.grade === 'string' ? x.grade : '',
      level: num(x.level), success: num(x.success), fee: num(x.fee) || 0,
      combo: num(x.combo) || 0, comboItem: x.comboItem ? String(x.comboItem) : null,
      comboQty: num(x.comboQty), comboSuccess: num(x.comboSuccess), comboAdds: !!x.comboAdds,
      comboMats: readMats(x.comboMats), mats: readMats(x.mats),
      notes: String(x.notes || ''), updatedAt: num(x.updatedAt), example: !!x.example
    };
  }

  /* ---------- registry: your saved items and recipes, merged with the recipe catalog ---------- */
  const REG = { iv: -1, rv: -1, byName: new Map(), virt: new Map(), catNames: new Set(), recipes: new Map(), unavail: new Set() };
  function reg() {
    if (REG.iv === itemsVer && REG.rv === recipesVer) return REG;
    if (REG.iv !== itemsVer) {
      const byName = new Map(), virt = new Map(), catNames = new Set();
      for (const it of S.items.values()) { const n = norm(it.name); if (!byName.has(n)) byName.set(n, it); }
      const addV = nm => {
        const n = norm(nm);
        catNames.add(n);
        if (!n || byName.has(n)) return;
        let id = slugId(nm);
        while (S.items.has(id) || virt.has(id)) id += '-x';
        const v = { id: id, name: nm, price: null, vendor: null, gather: false, bound: /\(bound\)/i.test(nm), updatedAt: null, hist: [], virtual: true };
        virt.set(id, v); byName.set(n, v);
      };
      for (const c of CAT.recipes) {
        addV(c.out);
        if (c.comboItem) addV(c.comboItem);
        for (const m of c.mats || []) addV(m[0]);
        for (const m of c.comboMats || []) addV(m[0]);
      }
      REG.byName = byName; REG.virt = virt; REG.catNames = catNames;
    }
    const idOf = nm => REG.byName.get(norm(nm)).id;
    const toMats = list => (list || []).map(x => ({ item: idOf(x[0]), qty: x[1] }));
    const m = new Map();
    for (const c of CAT.recipes) {
      m.set(c.id, {
        id: c.id, src: 'catalog', output: idOf(c.out), outQty: c.qty || 1, profession: profName(c.prof || ''), grade: c.grade || '',
        level: c.lvl == null ? null : c.lvl, success: null, fee: 0,
        combo: c.combo || 0, comboItem: c.comboItem ? idOf(c.comboItem) : null, comboQty: null, comboSuccess: null, comboAdds: !!c.comboAdds,
        comboMats: toMats(c.comboMats), mats: toMats(c.mats), notes: '',
        pending: !!c.pending, transfer: Array.isArray(c.transfer) ? c.transfer : null
      });
    }
    for (const r of S.recipes.values()) {
      const base = m.get(r.id);
      m.set(r.id, Object.assign({}, r, { src: base ? 'edited' : 'mine', grade: r.grade || (base ? base.grade : ''), pending: base ? base.pending : false, transfer: base ? base.transfer : null }));
    }
    // Recipes that use an item marked as not in the game are left out, and so is any unpriced item only those recipes make.
    const unavail = new Set();
    for (const it of S.items.values()) if (it.unavailable) unavail.add(it.id);
    const recs = [...m.values()], makers = new Map(), blocked = new Map();
    for (const r of recs) { if (!makers.has(r.output)) makers.set(r.output, []); makers.get(r.output).push(r); }
    for (let changed = true; changed;) {
      changed = false;
      for (const r of recs) {
        if (blocked.has(r.id)) continue;
        const bad = r.mats.map(x => x.item).concat(r.output).find(id => unavail.has(id));
        if (bad) { blocked.set(r.id, bad); changed = true; }
      }
      for (const [id, list] of makers) {
        if (unavail.has(id)) continue;
        const it = S.items.get(id) || REG.virt.get(id);
        const known = it && (num(it.price) > 0 || num(it.vendor) > 0 || isGathered(it));
        if (!known && list.every(r => blocked.has(r.id) || r.pending)) { unavail.add(id); changed = true; }
      }
    }
    for (const r of recs) r.blockedBy = blocked.get(r.id) || null;
    // Item grades, for coloring names the way the game does.
    const grades = new Map();
    for (const c of CAT.recipes) {
      if (c.grade) grades.set(norm(c.out), c.grade);
      if (c.comboItem && c.comboGrade) grades.set(norm(c.comboItem), c.comboGrade);
    }
    for (const r of S.recipes.values()) {
      const it = r.grade && (S.items.get(r.output) || REG.virt.get(r.output));
      if (it) grades.set(norm(it.name), r.grade);
    }
    REG.grades = grades;
    REG.recipes = m; REG.unavail = unavail; REG.iv = itemsVer; REG.rv = recipesVer;
    return REG;
  }
  function getItem(id) { return S.items.get(id) || reg().virt.get(id) || null; }
  function allItems() { return [...S.items.values(), ...reg().virt.values()]; }
  // Recipes that count: everything except what the Global client doesn't have yet, unless Settings includes it.
  function notOut(r) { return r.pending || !!r.blockedBy; }
  function allRecipes() { const all = [...reg().recipes.values()]; return S.settings.showPending ? all : all.filter(r => !notOut(r)); }
  function notOutTag(r) {
    if (r.blockedBy && r.blockedBy !== r.output) return 'Uses ' + itemName(r.blockedBy) + ', not in game';
    return 'Not in Global yet';
  }
  function getRecipe(id) { return reg().recipes.get(id) || null; }
  function itemName(id) { const it = getItem(id); return it ? it.name : '(missing item)'; }
  const GRADE_CLASS = { Common: 'gr-common', Rare: 'gr-rare', Epic: 'gr-epic', Unique: 'gr-unique' };
  function itemGrade(id) { const it = getItem(id); return it ? reg().grades.get(norm(it.name)) || '' : ''; }
  // An item's name, colored by its grade like in the game.
  function nameHTML(id) { return '<span class="' + (GRADE_CLASS[itemGrade(id)] || 'gr-none') + '">' + esc(itemName(id)) + '</span>'; }
  // An item's listed price and how long ago it was entered, flagged when it's over a day old.
  function priceLine(id, prefix) {
    const it = getItem(id);
    if (!it || !(num(it.price) > 0)) return '<div class="sub">' + esc(prefix || '') + 'no price</div>';
    const pi = priceInfo(it);
    if (pi.doubtful) {
      return '<div class="sub stale" title="' + esc(doubtText(pi.latest, pi.usual)) + '">' + esc(prefix || '') + k(pi.latest) + ' looks wrong · using ' + k(pi.usual) + '</div>';
    }
    const old = !it.updatedAt || Date.now() - it.updatedAt > DAY;
    return '<div class="sub' + (old ? ' stale' : '') + '" title="' + esc(it.updatedAt ? 'Updated ' + when(it.updatedAt) : 'No date recorded') + '">' +
      esc(prefix || '') + k(it.price) + ' · ' + (it.updatedAt ? ago(it.updatedAt) : 'no date') + '</div>';
  }
  function doubtText(price, usual) {
    return price >= usual ? NF0.format(Math.round(price / usual)) + '× its usual ' + k(usual) : 'under a fifth of its usual ' + k(usual);
  }
  // Prices on a ranking row that look wrong: ones being ignored because they jumped away from their
  // usual price, and a crafted item listed far above what it costs to make.
  function priceDoubts(row) {
    const rc = rcOf(row.buy);
    const ids = [rc.r.output];
    if (rc.comboId !== rc.r.output && rc.pCombo > 0) ids.push(rc.comboId);
    const ignored = ids.filter(id => { const pi = priceInfo(getItem(id)); return pi && pi.doubtful; });
    const out = priceInfo(getItem(rc.r.output));
    const perItem = rc.pS > 0 ? rc.attemptCost / (rc.pS * rc.outQty) : NaN;
    const overCost = out && out.use > 0 && perItem > 0 && out.use >= DOUBT_COST * perItem ? out.use / perItem : null;
    return { ignored: ignored, overCost: overCost, perItem: perItem };
  }
  // The explanation under "Current list price" when the price looks wrong.
  function listDoubtHTML(row, out) {
    const pi = priceInfo(out), pd = priceDoubts(row);
    let h = '';
    if (pi && pi.doubtful) {
      h += '<dd class="why">This price is ' + esc(doubtText(pi.latest, pi.usual)) + ', so the math uses ' + k(pi.usual) + ' instead. If the market really moved, a few more readings at this level make it the new normal. If it was a bad listing, delete that reading on the Prices tab.</dd>';
    }
    if (pd.overCost) {
      h += '<dd class="why loss">This is ' + NF0.format(Math.round(pd.overCost)) + '× what one costs to make (' + k(pd.perItem) + '), which usually means a bad listing. It’s left out of the rankings until the price looks normal again.</dd>';
    }
    return h;
  }
  // Whether a price about to be saved looks wrong, and why.
  function newPriceDoubt(it, price, C) {
    if (!it || !(price > 0)) return null;
    const recent = histOf(it).slice(-10).map(x => x.p).filter(p => p > 0);
    if (recent.length && jumped(price, median(recent))) return doubtText(price, median(recent));
    let cheapest = Infinity;
    for (const r of (C && C.prod.get(it.id)) || []) {
      const rc = C.E.buy.recipe(r), per = rc.pS > 0 ? rc.attemptCost / (rc.pS * rc.outQty) : NaN;
      if (per > 0 && per < cheapest) cheapest = per;
    }
    return isFinite(cheapest) && price >= DOUBT_COST * cheapest ? NF0.format(Math.round(price / cheapest)) + '× what it costs to craft (' + k(cheapest) + ')' : null;
  }
  function priceAge(id) {
    const it = getItem(id);
    if (!it || !it.updatedAt) return '';
    return '<div class="sub' + (Date.now() - it.updatedAt > DAY ? ' stale' : '') + '">' + ago(it.updatedAt) + '</div>';
  }
  // How much of a craft's expected sales come from its Splendent proc, and what it would make without it.
  function comboShare(rc) {
    if (!rc || rc.kind === 'combo' || rc.sameCombo || !(rc.pCombo > 0) || rc.comboNet == null || !(rc.revenue > 0)) return null;
    const part = rc.pCombo * rc.comboQty * rc.comboNet;
    const without = rc.outNet == null ? NaN : rc.pS * rc.outQty * rc.outNet - rc.attemptCost;
    return { share: part / rc.revenue, without: without, driven: rc.profit > 0 && (part / rc.revenue >= 0.5 || without < 0) };
  }
  function findItem(name) { return reg().byName.get(norm(name)) || null; }
  function ensureItem(name) {
    const found = findItem(name);
    if (found && !found.virtual) return found;
    if (found) { const it = Object.assign({}, found); delete it.virtual; Store.putItem(it); return it; }
    let id = slugId(name);
    if (S.items.has(id)) id = uid('i');
    const it = { id: id, name: name.trim(), price: null, vendor: null, gather: false, bound: /\(bound\)/i.test(name), updatedAt: null, hist: [], example: false };
    Store.putItem(it);
    return it;
  }
  function usage() {
    const m = new Map();
    for (const r of allRecipes()) {
      const ids = new Set([r.output, r.comboItem].concat(r.mats.map(x => x.item), (r.comboMats || []).map(x => x.item)).filter(Boolean));
      for (const id of ids) m.set(id, (m.get(id) || 0) + 1);
    }
    return m;
  }
  // Guards against bad listings (troll or RMT prices). A new price this many times above or below the
  // item's usual price is ignored in favor of the usual one, and a crafted item listed this many times
  // above its cost to make is flagged.
  const DOUBT_JUMP = 5;
  const DOUBT_COST = 20;
  function median(list) {
    const s = list.slice().sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  // The usual price before the latest reading: the middle of the ten readings before it.
  function usualBefore(it) {
    const earlier = histOf(it).slice(0, -1).slice(-10).map(x => x.p).filter(p => p > 0);
    return earlier.length ? median(earlier) : null;
  }
  function jumped(price, usual) { return usual > 0 && price > 0 && (price >= usual * DOUBT_JUMP || price <= usual / DOUBT_JUMP); }
  // The price the math uses: the latest one, unless it jumped far from the usual price.
  const priceMemo = { v: -1, map: new Map() };
  function priceInfo(it) {
    if (!it) return null;
    if (priceMemo.v !== itemsVer) { priceMemo.v = itemsVer; priceMemo.map = new Map(); }
    let info = priceMemo.map.get(it.id);
    if (info) return info;
    const p = num(it.price), usual = p > 0 ? usualBefore(it) : null, doubtful = jumped(p, usual);
    info = { latest: p, usual: usual, doubtful: doubtful, use: doubtful ? usual : p };
    priceMemo.map.set(it.id, info);
    return info;
  }
  function histOf(it) {
    const h = it && Array.isArray(it.hist) ? it.hist : [];
    if (h.length) return h;
    return it && num(it.price) > 0 && it.updatedAt ? [{ t: it.updatedAt, p: it.price }] : [];
  }
  // Returns a copy of the item with a new current price, logged in its price history.
  function withPrice(it, price, ts) {
    ts = ts || Date.now();
    let hist = histOf(it).slice();
    if (price != null) {
      const last = hist[hist.length - 1];
      if (last && ts - last.t < HIST_MERGE_MS && ts >= last.t) hist[hist.length - 1] = { t: ts, p: price };
      else hist.push({ t: ts, p: price });
      hist.sort((a, b) => a.t - b.t);
      if (hist.length > HIST_MAX) hist = hist.slice(-HIST_MAX);
    }
    const next = Object.assign({}, it, { price: price, updatedAt: price == null ? it.updatedAt : ts, hist: hist, example: false });
    delete next.virtual;
    return next;
  }

  /* ---------- storage: the shared Firestore price book for members, this browser otherwise ---------- */
  const DEL = {};
  const queues = new Map();
  function dbWrite(path, body) {
    let q = queues.get(path);
    if (!q) { q = { busy: false, next: undefined }; queues.set(path, q); }
    q.next = body;
    if (!q.busy) drain(path, q);
  }
  async function drain(path, q) {
    q.busy = true;
    while (q.next !== undefined) {
      const body = q.next; q.next = undefined;
      try {
        const ref = DB.doc(path);
        if (body === DEL) await ref.delete(); else await ref.set(body);
      } catch (e) { writeFailed(e, path); }
    }
    q.busy = false;
  }
  function writeFailed(e, path) {
    const code = e && e.code;
    if (code === 'permission-denied') toast(canManage() ? 'The database refused that change. Make sure Firestore is using the latest firestore.rules.'
      : /^(users|pool)\//.test(path || '') ? 'Your settings weren’t saved: the shared price book’s rules need updating. Let the owner know.'
      : /^reports\//.test(path || '') ? 'That report didn’t send: the shared price book’s rules need updating. Download the pictures instead, and let the owner know.'
      : 'That change wasn’t saved: only the owner can make it.');
    else if (code === 'resource-exhausted') toast('The shared price book hit today’s free usage limit. Try again tomorrow.');
    else toast('A change did not save. Check your connection and try again.');
    scheduleRender();
  }
  function clean(o) { return JSON.parse(JSON.stringify(o)); }
  function persist(col, obj, del) {
    if (DB) {
      const body = Object.assign({}, obj); delete body.id; delete body.src; delete body.virtual;
      dbWrite(col + '/' + obj.id, del ? DEL : clean(body));
    } else saveLocal();
  }
  const Store = {
    putItem(it) { it = Object.assign({}, it); delete it.virtual; S.items.set(it.id, it); itemsVer++; persist('items', it); },
    delItem(id) { S.items.delete(id); itemsVer++; persist('items', { id: id }, true); },
    putRecipe(r) { r = Object.assign({}, r); delete r.src; S.recipes.set(r.id, r); recipesVer++; persist('recipes', r); },
    delRecipe(id) { S.recipes.delete(id); recipesVer++; persist('recipes', { id: id }, true); },
    putSettings(s) {
      S.settings = s;
      if (!DB) { saveLocal(); return; }
      const shared = clean(s); delete shared.runs; delete shared.crafts; delete shared.craftMin; // personal, kept in users/{uid}
      dbWrite('config/settings', shared);
    }
  };
  let localTimer = null;
  function saveLocal() {
    clearTimeout(localTimer);
    localTimer = setTimeout(() => {
      try { localStorage.setItem(LS_DATA, JSON.stringify({ items: [...S.items.values()], recipes: [...S.recipes.values()], settings: S.settings })); } catch (_) {}
    }, 150);
  }
  function loadLocal() {
    try {
      const d = JSON.parse(localStorage.getItem(LS_DATA) || 'null');
      if (!d) return;
      for (const x of d.items || []) if (x && x.id) S.items.set(x.id, readItem(x.id, x));
      for (const x of d.recipes || []) if (x && x.id) S.recipes.set(x.id, readRecipe(x.id, x));
      S.settings = mergeSettings(d.settings);
      itemsVer++; recipesVer++;
    } catch (_) {}
  }
  function subscribe() {
    const seen = new Set();
    const arrived = key => { seen.add(key); if (!S.ready && seen.size === 3) S.ready = true; scheduleRender(); };
    const failed = () => toast('Live updates stopped. Reload the page to reconnect.');
    unsubs.push(DB.collection('items').limit(2000).onSnapshot(snap => {
      S.items = new Map(snap.docs.map(d => [d.id, readItem(d.id, d.data())]));
      itemsVer++;
      arrived('items');
    }, failed));
    unsubs.push(DB.collection('recipes').limit(1000).onSnapshot(snap => {
      S.recipes = new Map(snap.docs.map(d => [d.id, readRecipe(d.id, d.data())]));
      recipesVer++;
      arrived('recipes');
    }, failed));
    unsubs.push(DB.doc('config/settings').onSnapshot(d => {
      S.settings = mergeSettings(d.exists ? d.data() : null);
      arrived('settings');
    }, failed));
  }

  /* ---------- profit engine ---------- */
  // p: normal craft success; pc: the second craft after a combo proc.
  function successFor(r) {
    const grade = gradeOf(r);
    const ov = num(r.success);
    if (ov != null) { const p = clamp01(ov / 100); return { p: p, pc: 1 - (1 - p) / 2, src: 'set', grade: grade }; }
    const lvl = num(myLevels()[r.profession]);
    const req = num(r.level);
    const floor = rateRow(grade, 0);
    if (lvl != null && req != null) {
      const gap = lvl - req;
      if (gap < 0) return { p: floor.basic / 100, pc: floor.combo / 100, src: 'low', gap: gap, grade: grade };
      const row = rateRow(grade, gap);
      return { p: row.basic / 100, pc: row.combo / 100, src: 'table', gap: gap, est: !row.known, grade: grade };
    }
    return { p: floor.basic / 100, pc: floor.combo / 100, src: 'assumed', grade: grade };
  }
  // The share of a sale's price lost to fees: the sales fee plus the listing fee, in percent.
  function saleFees() {
    const s = S.settings;
    return (num(s.tax) == null ? 10 : num(s.tax)) + (num(s.listFee) == null ? 2 : num(s.listFee));
  }
  function feesTxt() {
    const s = S.settings;
    return num(s.listFee) > 0 ? 'the ' + k(s.tax) + '% sales fee and ' + k(s.listFee) + '% listing fee' : 'the ' + k(s.tax) + '% sales fee';
  }
  function canCraft(r) {
    if (r.level == null) return true;
    const lvl = num(myLevels()[r.profession]);
    return lvl != null && lvl >= r.level;
  }

  // scn: 'buy' = purchase everything, 'gather' = gatherable mats are free, 'opp' = gatherable mats cost their after-fee sell value
  function engine(scn, prod, comboMakers) {
    // What a sale keeps: every sale pays the sales fee, and listing it paid the listing fee, both as a share of the price.
    const tax = clamp01(saleFees() / 100);
    const loss = clamp01((num(S.settings.failLoss) == null ? 100 : num(S.settings.failLoss)) / 100);
    const mu = new Map(), mr = new Map(), stack = new Set();
    function netSell(id) {
      const it = getItem(id);
      if (!it || it.bound) return null;
      const p = priceInfo(it).use;
      return p > 0 ? p * (1 - tax) : null;
    }
    function unit(id) {
      if (mu.has(id)) return mu.get(id);
      const it = getItem(id);
      const opts = [];
      if (it) {
        if (scn !== 'buy' && isGathered(it)) opts.push({ route: 'gather', cost: scn === 'gather' ? 0 : (netSell(id) || 0) });
        const p = priceInfo(it).use; if (p > 0 && !it.bound) opts.push({ route: 'buy', cost: p });
        const v = num(it.vendor); if (v > 0) opts.push({ route: 'vendor', cost: v });
      }
      const inCycle = stack.has(id);
      if (!inCycle) {
        stack.add(id);
        for (const r of prod.get(id) || []) {
          const rc = recipe(r);
          if (isFinite(rc.unitCost)) opts.push({ route: 'craft', cost: rc.unitCost, recipe: r.id });
        }
        for (const r of comboMakers.get(id) || []) {
          const ch = chase(r);
          if (isFinite(ch.cost)) opts.push({ route: 'combo', cost: Math.max(0, ch.cost), recipe: r.id });
        }
        stack.delete(id);
      }
      let best = null;
      for (const o of opts) if (!best || o.cost < best.cost - 1e-9) best = o;
      const res = best || { route: 'missing', cost: NaN };
      if (!inCycle) mu.set(id, res);
      return res;
    }
    function priceMats(list) {
      const out = [], missing = [];
      let cost = 0;
      for (const m of list || []) {
        const q = num(m.qty);
        if (!m.item || !(q > 0)) continue;
        const u = unit(m.item);
        if (!isFinite(u.cost)) missing.push(m.item); else cost += q * u.cost;
        out.push({ item: m.item, qty: q, route: u.route, cost: u.cost, recipe: u.recipe });
      }
      return { mats: out, missing: missing, cost: missing.length ? NaN : cost };
    }
    function recipe(r) {
      if (mr.has(r.id)) return mr.get(r.id);
      const sr = successFor(r), pS = sr.p;
      const c = clamp01((num(r.combo) || 0) / 100);
      // A proc on a successful craft means crafting again at the same success rate, unless the recipe sets its own combo success.
      const csN = num(r.comboSuccess);
      const cs = csN != null ? clamp01(csN / 100) : sr.pc;
      const outQty = Math.max(1, num(r.outQty) || 1);
      const comboId = r.comboItem || r.output;
      const sameCombo = comboId === r.output;
      const comboQty = Math.max(1, num(r.comboQty) || (sameCombo ? outQty : 1));
      const consume = pS + (1 - pS) * loss;
      const consumeC = cs + (1 - cs) * loss;
      const base = priceMats(r.mats);
      const cm = priceMats(r.comboMats);
      const outNet = netSell(r.output);
      const comboNet = sameCombo ? outNet : netSell(comboId);
      const fee = Math.max(0, num(r.fee) || 0);
      // With combo materials the combo is an optional second craft: it keeps the normal result and is
      // taken only when it is worth more than its materials. Without them the combo item is a free upgrade.
      const extraCombo = cm.mats.length > 0;
      let pCombo, pBase, comboCost = 0, comboTaken = c > 0, comboWhy = '';
      if (c > 0 && extraCombo) {
        const ev = cs * comboQty * (comboNet == null ? NaN : comboNet) - cm.cost * consumeC;
        comboTaken = isFinite(ev) && ev > 0;
        if (!comboTaken) comboWhy = isFinite(ev) ? 'costs more than it earns' : 'needs prices';
        pCombo = comboTaken ? pS * c * cs : 0;
        pBase = pS;
        comboCost = comboTaken ? pS * c * cm.cost * consumeC : 0;
      } else {
        pCombo = pS * c * cs;
        pBase = r.comboAdds ? pS : pS - pCombo;
      }
      const attemptCost = base.missing.length ? NaN : base.cost * consume + fee + comboCost;
      const units = pBase * outQty + (sameCombo ? pCombo * comboQty : 0);
      const comboMissing = c > 0 && !sameCombo && comboNet == null && !extraCombo;
      const byproduct = sameCombo ? 0 : pCombo * comboQty * (comboNet || 0);
      const unitCost = units > 0 ? (attemptCost - byproduct) / units : NaN;
      const revenue = outNet == null ? NaN : pBase * outQty * outNet + pCombo * comboQty * (comboNet || 0);
      const profit = revenue - attemptCost;
      const roi = attemptCost > 0 ? profit / attemptCost : (isFinite(profit) && profit > 0 ? Infinity : NaN);
      const breakEven = isFinite(unitCost) && tax < 1 ? unitCost / (1 - tax) : NaN;
      const res = {
        r: r, sr: sr, pS: pS, c: c, cs: cs, pCombo: pCombo, pBase: pBase, outQty: outQty, comboId: comboId, sameCombo: sameCombo, comboQty: comboQty,
        consume: consume, consumeC: consumeC, loss: loss, mats: base.mats, missing: base.missing, matCost: base.cost,
        cmats: cm.mats, comboMatCost: cm.cost, extraCombo: extraCombo, comboTaken: comboTaken, comboWhy: comboWhy, comboCost: comboCost,
        fee: fee, attemptCost: attemptCost, units: units, outNet: outNet, comboNet: comboNet, comboMissing: comboMissing,
        unitCost: unitCost, revenue: revenue, profit: profit, roi: roi, breakEven: breakEven
      };
      mr.set(r.id, res);
      return res;
    }
    // Crafting the base item until it procs its combo item, selling the normal items made along the way.
    function chase(r) {
      const rc = recipe(r);
      const baseNet = netSell(r.output);
      const credit = rc.pBase * rc.outQty * (baseNet || 0);
      const per = rc.pCombo * rc.comboQty;
      const cost = per > 0 && isFinite(rc.attemptCost) ? (rc.attemptCost - credit) / per : NaN;
      const net = netSell(rc.comboId);
      const profit = net == null ? NaN : net - cost;
      const roi = cost > 0 ? profit / cost : (isFinite(profit) && profit > 0 ? Infinity : NaN);
      return { kind: 'combo', rc: rc, sr: rc.sr, pS: per, c: rc.c, cost: cost, unitCost: cost, credit: credit, baseNet: baseNet, revenue: net == null ? NaN : net, outNet: net, profit: profit, roi: roi, missing: rc.missing };
    }
    return { unit: unit, recipe: recipe, chase: chase, netSell: netSell };
  }
  function buildCalc() {
    const recipes = allRecipes();
    const prod = new Map(), comboMakers = new Map();
    for (const r of recipes) {
      if (!r.output) continue;
      if (!prod.has(r.output)) prod.set(r.output, []);
      prod.get(r.output).push(r);
      if (r.comboItem && r.comboItem !== r.output && num(r.combo) > 0) {
        if (!comboMakers.has(r.comboItem)) comboMakers.set(r.comboItem, []);
        comboMakers.get(r.comboItem).push(r);
      }
    }
    const E = { buy: engine('buy', prod, comboMakers), gather: engine('gather', prod, comboMakers), opp: engine('opp', prod, comboMakers) };
    const rows = recipes.map(r => ({ r: r, buy: E.buy.recipe(r), gather: E.gather.recipe(r), opp: E.opp.recipe(r) }));
    // One row per Splendent item: what it costs to get one by crafting its base item until it procs.
    const comboRows = [];
    for (const list of comboMakers.values()) for (const r of list) {
      const pr = Object.assign({}, r, { id: r.id + '~s', output: r.comboItem, via: r.id });
      comboRows.push({ r: pr, kind: 'combo', buy: E.buy.chase(r), gather: E.gather.chase(r), opp: E.opp.chase(r) });
    }
    return { E: E, rows: rows, comboRows: comboRows, prod: prod };
  }
  /* ---------- risk and budget ---------- */
  // The ways one craft can turn out, each with its chance and the Kina you end up with
  // relative to what you put in (materials and fee).
  function outcomesOf(rc) {
    const mats = isFinite(rc.matCost) ? rc.matCost : NaN;
    const stake = mats + rc.fee;
    const normal = rc.outNet == null ? NaN : rc.outNet * rc.outQty;
    const comboUnit = rc.sameCombo ? rc.outNet : rc.comboNet;
    const comboVal = (comboUnit == null ? 0 : comboUnit * rc.comboQty) + (rc.r.comboAdds || rc.extraCombo ? normal : 0) -
      (rc.extraCombo ? rc.comboMatCost * rc.consumeC : 0);
    const list = [
      { label: 'Fails', p: 1 - rc.pS, kina: -(rc.fee + mats * rc.loss) },
      { label: 'Normal ' + itemName(rc.r.output), p: rc.pS - rc.pCombo, kina: normal - stake }
    ];
    if (rc.pCombo > 0) list.push({ label: rc.sameCombo ? 'Combo: an extra batch' : itemName(rc.comboId), p: rc.pCombo, kina: comboVal - stake, combo: true });
    const ev = list.reduce((s, o) => s + o.p * o.kina, 0);
    const lose = list.reduce((s, o) => s + (o.kina < 0 ? o.p : 0), 0);
    return { stake: stake, list: list, ev: ev, lose: lose };
  }
  const LOGF = [0];
  function logFact(n) { for (let i = LOGF.length; i <= n; i++) LOGF[i] = LOGF[i - 1] + Math.log(i); return LOGF[n]; }
  function normalCdf(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
    const tail = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - tail : tail;
  }
  // Chance that n crafts in a row end with more Kina than they started. Exact for up to 80 crafts,
  // a normal approximation beyond that.
  function chanceAhead(list, n) {
    const ps = list.map(o => o.p), ks = list.map(o => o.kina);
    while (ps.length < 3) { ps.push(0); ks.push(0); }
    if (n <= 80) {
      const lp = ps.map(p => p > 0 ? Math.log(p) : -Infinity);
      let sum = 0;
      for (let c = 0; c <= n; c++) {
        for (let b = 0; b <= n - c; b++) {
          const a = n - b - c;
          if (a * ks[0] + b * ks[1] + c * ks[2] <= 0) continue;
          const lw = logFact(n) - logFact(a) - logFact(b) - logFact(c) + (a ? a * lp[0] : 0) + (b ? b * lp[1] : 0) + (c ? c * lp[2] : 0);
          if (lw > -700) sum += Math.exp(lw);
        }
      }
      return Math.min(1, sum);
    }
    const mean = list.reduce((s, o) => s + o.p * o.kina, 0);
    const spread = list.reduce((s, o) => s + o.p * o.kina * o.kina, 0) - mean * mean;
    return spread > 0 ? normalCdf(n * mean / Math.sqrt(n * spread)) : (mean > 0 ? 1 : 0);
  }
  // Spending a whole budget on one recipe, one craft after another, without reinvesting what you sell.
  const budgetCache = new WeakMap();
  function budgetOf(rc, budget) {
    if (!(budget > 0) || !rc) return null;
    const hit = budgetCache.get(rc);
    if (hit && hit.budget === budget) return hit.val;
    const o = outcomesOf(rc);
    let val = null;
    if (isFinite(o.ev)) {
      if (!(o.stake > 0)) val = { o: o, free: true, n: null, total: o.ev };
      else {
        const n = Math.min(100000, Math.floor(budget / o.stake));
        val = {
          o: o, free: false, n: n, total: n * o.ev,
          ahead: n ? chanceAhead(o.list, n) : NaN,
          anyCombo: n && rc.pCombo > 0 ? 1 - Math.pow(1 - rc.pCombo, n) : NaN,
          worst: n ? n * Math.min.apply(null, o.list.map(x => x.kina)) : NaN
        };
      }
    }
    budgetCache.set(rc, { budget: budget, val: val });
    return val;
  }
  function rcOf(x) { return x && x.kind === 'combo' ? x.rc : x; }
  function myBudget() { const b = num(UI.budget); return b > 0 ? b : 0; }
  function metricVal(row) {
    const x = row[UI.metric];
    if (UI.per === 'roi') return x.roi;
    if (UI.per === 'budget' && myBudget()) {
      const bd = budgetOf(rcOf(x), myBudget());
      if (!bd) return x.profit;
      return bd.free || bd.n ? bd.total : -1e15 + (isFinite(x.profit) ? x.profit : 0); // over budget sorts last
    }
    return x.profit;
  }
  function sortKey(row) { const v = metricVal(row); return Number.isNaN(v) || v == null ? -Infinity : v; }
  // Items whose missing price blocks the most recipes from being ranked (only recipes your levels allow, once levels are set).
  function neededPrices(C) {
    const count = new Map();
    const levelsSet = Object.keys(myLevels()).length > 0;
    for (const row of C.rows) {
      if (levelsSet && !canCraft(row.r)) continue;
      const g = row.gather, out = getItem(row.r.output);
      const ids = new Set(g.missing);
      if (g.outNet == null && out && !out.bound) ids.add(row.r.output);
      for (const id of ids) count.set(id, (count.get(id) || 0) + 1);
    }
    return [...count].sort((a, b) => b[1] - a[1]);
  }

  /* ---------- views ---------- */
  const view = document.getElementById('view');

  function renderChrome() {
    document.getElementById('tabs').innerHTML = TABS.map(([id, label]) =>
      '<button class="tab" role="tab" id="tab-' + id + '" aria-selected="' + (UI.tab === id) + '" data-act="tab" data-tab="' + id + '">' + label + '</button>').join('');
    const st = document.getElementById('status'), btn = document.getElementById('acct-btn');
    let cls = '', txt = 'Connecting…';
    if (S.mode === 'db') { cls = 'ok'; txt = S.role === 'owner' ? 'Shared price book · owner' : 'Shared price book'; }
    else if (S.auth === 'notmember') { cls = 'warn'; txt = 'Not added yet'; }
    else if (S.mode === 'local') { cls = 'ok'; txt = 'Saved in this browser'; }
    st.className = 'status ' + cls;
    st.lastElementChild.textContent = txt;
    st.title = S.email ? 'Signed in as ' + S.email : '';
    const signedIn = S.auth === 'member' || S.auth === 'notmember';
    btn.hidden = !(signedIn || S.auth === 'out');
    btn.textContent = signedIn ? 'Sign out' : 'Sign in';
    btn.dataset.act = signedIn ? 'sign-out' : 'sign-in';
  }
  // A line above every tab when the shared price book isn't in use.
  function accountNotice() {
    if (S.auth === 'out') return '<div class="notice"><span>Sign in with Google to use the shared price book. Until then, prices you enter are saved in this browser only.</span><button class="btn small primary" data-act="sign-in">Sign in with Google</button></div>';
    if (S.auth === 'notmember') return '<div class="notice"><span>You’re signed in as <strong>' + esc(S.email) + '</strong>, but you haven’t been added to the shared price book yet. Send this address to the owner. Until then, prices you enter are saved in this browser only.</span></div>';
    return '';
  }
  let dlKey = '';
  function renderDatalist() {
    const key = itemsVer + ':' + recipesVer;
    if (key === dlKey) return;
    dlKey = key;
    const names = allItems().map(i => i.name).sort((a, b) => a.localeCompare(b));
    document.getElementById('dl-items').innerHTML = names.map(n => '<option value="' + esc(n) + '"></option>').join('');
  }
  function loadingView() {
    return '<section class="panel" aria-busy="true"><p class="muted">Opening your ledger…</p><div class="skel" style="width:60%"></div><div class="skel" style="width:85%"></div><div class="skel" style="width:40%"></div></section>';
  }
  function tagList(list) { return list.length ? '<div class="tags">' + list.map(([c, t]) => '<span class="tag ' + c + '">' + esc(t) + '</span>').join('') + '</div>' : ''; }
  function routeTag(route) { return '<span class="tag ' + route + '">' + ROUTE[route] + '</span>'; }
  function hasExamples() { for (const r of S.recipes.values()) if (r.example) return true; for (const i of S.items.values()) if (i.example) return true; return false; }
  function moreBtn(act, shown, total) {
    return total > shown ? '<div class="more"><span class="help">Showing ' + NF0.format(shown) + ' of ' + NF0.format(total) + '</span><button class="btn small" data-act="' + act + '">Show ' + Math.min(PAGE, total - shown) + ' more</button></div>' : '';
  }

  function rowFlags(row) {
    const r = row.r, b = row.buy, g = row.gather, out = getItem(r.output), f = [];
    if (r.example) f.push(['ex', 'Example']);
    if (notOut(r)) f.push(['warn', notOutTag(r)]);
    if (r.src === 'edited') f.push(['', 'Edited']);
    if (r.src === 'mine') f.push(['', 'My recipe']);
    if (b.sr.src === 'low') f.push(['loss', 'Needs ' + lvTxt(r.level)]);
    const bd = budgetOf(rcOf(row[UI.metric]), myBudget());
    if (bd && !bd.free && !bd.n) f.push(['loss', 'Over budget']);
    const cs = comboShare(row[UI.metric]);
    if (cs && cs.driven) f.push(['ex', 'Splendent-driven']);
    const pd = priceDoubts(row);
    if (pd.overCost) f.push(['loss', 'Check price']);
    if (pd.ignored.length) f.push(['warn', 'Ignoring a doubtful price']);
    if (out && out.bound) f.push(['', 'Ingredient only']);
    else if (b.outNet == null) f.push(['warn', 'Needs sell price']);
    if (b.comboMissing) f.push(['warn', 'Needs combo item price']);
    if (g.missing.length) f.push(['warn', plural(g.missing.length, 'material price') + ' missing']);
    else if (b.missing.length) f.push(['', 'Gathered mats need prices for buy-all']);
    return f;
  }
  function successWhy(sr, r) {
    if (sr.src === 'set') return 'Set on this recipe.';
    if (sr.src === 'table') return 'Your ' + r.profession + ' ' + lvTxt(myLevels()[r.profession]) + ' vs recipe ' + lvTxt(r.level) + ' (difference ' + sr.gap + ', ' + sr.grade + ' table)' + (sr.est ? '. This row is estimated until it’s read from the game.' : '.');
    if (sr.src === 'low') return 'Your ' + r.profession + ' level is below ' + lvTxt(r.level) + ', so this uses the lowest rate.';
    return 'Assumed. Add your ' + (r.profession || 'crafting') + ' level in Settings to look it up.';
  }
  function variantLabels(rows) {
    const by = new Map();
    for (const x of rows) { const k2 = x.r.output; if (!by.has(k2)) by.set(k2, []); by.get(k2).push(x.r.id); }
    const lab = new Map();
    for (const ids of by.values()) if (ids.length > 1) ids.sort().forEach((id, i) => lab.set(id, 'Variant ' + (i + 1) + ' of ' + ids.length));
    return lab;
  }

  function rankView() {
    const C = buildCalc();
    if (!C.rows.length) {
      return '<section class="empty"><span class="eyebrow">Rankings</span><h2 class="sec-h">Your ledger has no recipes yet</h2>' +
        '<p>Add a recipe and the prices of what goes into it. Kina Ledger then ranks every craft by expected profit, whether you buy the materials or gather them yourself.</p>' +
        '<div class="row-gap"><button class="btn primary" data-act="new-recipe">Add a recipe</button></div></section>';
    }
    const combo = UI.goal === 'combo';
    const pool = combo ? C.comboRows : C.rows;
    const B = myBudget();
    if (UI.per === 'budget' && !B) UI.per = 'kina';
    const affordable = x => { const bd = budgetOf(rcOf(x[UI.metric]), B); return !bd || bd.free || bd.n > 0; };
    const profs = [];
    for (const x of pool) if (x.r.profession && profs.indexOf(x.r.profession) < 0) profs.push(x.r.profession);
    const pi = p => { const i = PROFESSIONS.indexOf(p); return i < 0 ? 99 : i; };
    profs.sort((a, b) => pi(a) - pi(b) || a.localeCompare(b));
    if (UI.prof !== 'all' && profs.indexOf(UI.prof) < 0) UI.prof = 'all';
    const variants = variantLabels(pool);
    const q = loose(UI.rankQ);
    let rows = pool.filter(x =>
      (UI.prof === 'all' || x.r.profession === UI.prof) &&
      (!q || loose(itemName(x.r.output)).indexOf(q) >= 0) &&
      (!UI.canCraft || canCraft(x.r)) &&
      (!UI.affordOnly || !B || affordable(x)));
    const rankable = rows.filter(x => sortKey(x) > -Infinity && !priceDoubts(x).overCost);
    const hidden = rows.length - rankable.length;
    if (!UI.rankAll) rows = rankable;
    rows = rows.slice().sort((a, b) => (sortKey(b) - sortKey(a)) || itemName(a.r.output).localeCompare(itemName(b.r.output)));

    let h = (UI.live.mode === 'craft' ? liveHTML() : '') + leadHTML(C, rankable);
    if (hasExamples()) {
      h += '<div class="notice"><span>Some <strong>Example</strong> data with made-up prices is still in your ledger.</span>' +
        '<button class="btn small' + (UI.confirm === 'rmx' ? ' danger armed' : '') + '" data-act="rm-examples">' + (UI.confirm === 'rmx' ? 'Click again to remove' : 'Remove examples') + '</button></div>';
    }
    h += '<div class="bar"><div class="row-gap"><div class="seg" role="group" aria-label="What to rank">' +
      '<button data-act="goal" data-v="normal" aria-pressed="' + !combo + '">Crafts</button>' +
      '<button data-act="goal" data-v="combo" aria-pressed="' + combo + '">Splendent from combos</button></div>' +
      '<div class="seg" role="group" aria-label="Rank by">' +
      Object.keys(METRIC).map(m => '<button data-act="metric" data-m="' + m + '" aria-pressed="' + (UI.metric === m) + '">' + METRIC[m].short + '</button>').join('') +
      '</div></div><div class="seg" role="group" aria-label="Show as">' +
      '<button data-act="per" data-v="kina" aria-pressed="' + (UI.per === 'kina') + '">Kina</button>' +
      '<button data-act="per" data-v="roi" aria-pressed="' + (UI.per === 'roi') + '">ROI %</button>' +
      (B ? '<button data-act="per" data-v="budget" aria-pressed="' + (UI.per === 'budget') + '">With my budget</button>' : '') + '</div></div>';
    h += '<p class="help">' + (combo
      ? 'Each row is one Splendent item: what it costs to get by crafting its base item until it procs, after selling the normal items made along the way, and what it sells for after ' + feesTxt() + '. Open a row to see what it crafts if you keep it. Recipes that need a Splendent use this cost whenever making one is cheaper than buying it. ' + esc(METRIC[UI.metric].hint)
      : esc(METRIC[UI.metric].hint) + ' All figures are expected values per craft attempt, after ' + feesTxt() + '. Click a row for the breakdown. ' +
        '<strong>Splendent-driven</strong> means most of the profit comes from the occasional Splendent proc, so check that its price is current. ' +
        'A price that jumps ' + DOUBT_JUMP + '× away from its usual price is ignored, and a crafted item listed ' + DOUBT_COST + '× above its cost to make is held back as <strong>Check price</strong>. Prices over a day old are marked in Sells for.') +
      (UI.per === 'budget' ? ' <strong>With my budget</strong> shows the profit you’d expect from spending your whole budget on that craft, one craft after another without reinvesting, and your chance to finish ahead.' : '') + '</p>';
    h += '<div class="filters"><div class="field"><label for="rq">Find a recipe</label><input id="rq" class="in" type="search" value="' + esc(UI.rankQ) + '" data-inp="rq" placeholder="e.g. Orb, Tea, Longsword" autocomplete="off"></div>' +
      '<div class="field budget"><label for="budget">My budget (Kina)</label><input id="budget" class="in num" inputmode="decimal" value="' + esc(UI.budget) + '" data-chg="budget" placeholder="e.g. 10m" autocomplete="off"></div>' +
      '<label class="check"><input type="checkbox" id="rk-craft" data-chg="rk-craft"' + (UI.canCraft ? ' checked' : '') + '> Only what my levels can craft</label>' +
      '<label class="check"><input type="checkbox" id="rk-afford" data-chg="rk-afford"' + (UI.affordOnly ? ' checked' : '') + (B ? '' : ' disabled') + '> Only what my budget covers</label>' +
      '<label class="check"><input type="checkbox" id="rk-all" data-chg="rk-all"' + (UI.rankAll ? ' checked' : '') + '> Include recipes with missing or doubtful prices' + (hidden ? ' <span class="muted">(' + NF0.format(hidden) + ')</span>' : '') + '</label></div>';
    if (profs.length > 1) {
      h += '<div class="chips" role="group" aria-label="Profession">' +
        ['all'].concat(profs).map(p => '<button class="chip" data-act="prof" data-p="' + esc(p) + '" aria-pressed="' + (UI.prof === p) + '">' + (p === 'all' ? 'All professions' : esc(p)) + '</button>').join('') + '</div>';
    }
    if (UI.canCraft && !Object.keys(myLevels()).length) h += '<p class="help">Set your crafting levels in Settings so this filter knows what you can craft.</p>';
    if (!rows.length) {
      h += '<section class="empty"><h2 class="sec-h">' + (rankable.length || UI.rankAll ? 'No recipes match these filters' : 'No recipe has all its prices yet') + '</h2>' +
        '<p>' + (rankable.length || UI.rankAll ? 'Clear the search or change the filters above.' : 'A recipe is ranked once its result has a market price and every material has a price, an NPC price, or is marked as gathered. The list above shows which prices unlock the most recipes.') + '</p></section>';
      return h;
    }
    const th = (m, label) => '<th class="num' + (UI.metric === m ? ' is-sort' : '') + '" scope="col"><button class="th-btn" data-act="metric" data-m="' + m + '" aria-pressed="' + (UI.metric === m) + '">' + label + '</button></th>';
    h += '<div class="well"><table class="grid rank"><thead><tr><th scope="col">#</th><th scope="col">' + (combo ? 'Splendent item' : 'Recipe') + '</th><th class="num" scope="col">' + (combo ? 'Chance per craft' : 'Success') + '</th><th class="num" scope="col">Sells for</th>' +
      th('buy', 'Buying all mats') + th('gather', 'With own gathering') + th('opp', 'Gain vs selling raw') + '</tr></thead><tbody>';
    const shown = rows.slice(0, UI.rankShow);
    shown.forEach((row, i) => {
      const r = row.r, b = row.buy, open = UI.open === r.id;
      const out = getItem(r.output);
      const meta = [row.kind === 'combo' ? 'Combo from ' + itemName(b.rc.r.output) : null, r.profession || 'No profession', r.level != null ? lvTxt(r.level) : null, r.grade || null, variants.get(r.id) || null].filter(Boolean).join(' · ');
      const odds = row.kind === 'combo' ? (b.pS > 0 ? '≈ ' + qfmt(1 / b.pS) + ' crafts each' : 'no combo')
        : b.c > 0 ? 'combo ' + pct(b.c, 0) : (b.sr.src === 'assumed' ? 'assumed' : '&nbsp;');
      h += '<tr class="row' + (open ? ' open' : '') + '" data-act="toggle" data-id="' + esc(r.id) + '">' +
        '<td class="rk">' + (i + 1) + '</td>' +
        '<td class="c-name"><button class="rname" data-act="toggle" data-id="' + esc(r.id) + '" aria-expanded="' + open + '" aria-controls="d-' + esc(r.id) + '">' + nameHTML(r.output) +
        (b.outQty > 1 ? ' <span class="x">×' + qfmt(b.outQty) + '</span>' : '') + '</button>' +
        '<div class="rmeta"><span>' + esc(meta) + '</span>' + tagList(rowFlags(row)) + '</div></td>' +
        '<td class="num" data-label="' + (row.kind === 'combo' ? 'Chance per craft' : 'Success') + '"><div class="v">' + pct(b.pS) + '</div><div class="sub">' + odds + '</div></td>' +
        '<td class="num" data-label="Sells for"><div class="v">' + (out && out.bound ? '—' : k(b.revenue)) + '</div>' + (out && out.bound ? '<div class="sub">not sold</div>' : priceLine(r.output) +
          (row.kind === 'combo' ? priceLine(b.rc.r.output, 'Base ') : b.c > 0 && !b.sameCombo ? priceLine(b.comboId, 'Splendent ') : '')) + '</td>' +
        moneyCell(row.buy, 'buy', 'Buying all mats') + moneyCell(row.gather, 'gather', 'With own gathering') + moneyCell(row.opp, 'opp', 'Gain vs selling raw') +
        '</tr>';
      if (open) h += '<tr class="detail" id="d-' + esc(r.id) + '"><td colspan="7">' + detailHTML(C, row) + '</td></tr>';
    });
    h += '</tbody></table></div>' + moreBtn('rank-more', shown.length, rows.length);
    return h;
  }
  function moneyCell(rc, m, label) {
    const ok = isFinite(rc.profit);
    let big = UI.per === 'roi' ? roiTxt(rc.roi) : sk(rc.profit);
    let small = UI.per === 'roi' ? sk(rc.profit) + ' Kina' : 'ROI ' + roiTxt(rc.roi);
    let value = rc.profit;
    const bd = UI.per === 'budget' ? budgetOf(rcOf(rc), myBudget()) : null;
    if (ok && bd) {
      value = bd.total;
      if (bd.free) { big = sk(bd.total); small = 'costs no Kina'; }
      else if (!bd.n) { big = '—'; small = 'over budget'; value = NaN; }
      else { big = sk(bd.total); small = NF0.format(bd.n) + ' crafts · ' + pct(bd.ahead, 0) + ' ahead'; }
    }
    const why = rc.outNet == null ? 'no sell price' : rc.missing.length ? 'missing prices' : '';
    return '<td class="num' + (UI.metric === m ? ' is-sort' : '') + '" data-label="' + label + '"><div class="v ' + tone(value) + '">' + (ok ? big : '—') + '</div><div class="sub">' + (ok ? small : why) + '</div></td>';
  }
  function leadHTML(C, rankable) {
    let priced = 0, stale = 0;
    const now = Date.now();
    for (const it of S.items.values()) {
      if (num(it.price) > 0 || num(it.vendor) > 0) priced++;
      if (num(it.price) > 0 && it.updatedAt && now - it.updatedAt > DAY) stale++;
    }
    const need = neededPrices(C);
    const total = allItems().length;
    const stats = '<dl class="lead-stats">' +
      '<div><dt>Recipes ranked</dt><dd>' + NF0.format(C.rows.filter(x => sortKey(x) > -Infinity).length) + ' / ' + NF0.format(C.rows.length) + '</dd></div>' +
      '<div><dt>Items priced</dt><dd>' + NF0.format(priced) + ' / ' + NF0.format(total) + '</dd></div>' +
      '<div><dt>Prices over 24 h old</dt><dd class="' + (stale ? 'loss' : '') + '">' + NF0.format(stale) + '</dd></div>' +
      '<div><dt>Items needing a price</dt><dd>' + NF0.format(need.length) + '</dd></div></dl>';
    const needHTML = need.length ? '<div class="need"><span class="help">Prices that unlock the most recipes. Click one to find it on the Prices tab.</span><div class="chips">' +
      need.slice(0, 10).map(([id, n]) => '<button class="chip" data-act="find-price" data-id="' + esc(id) + '">' + esc(itemName(id)) + '<span class="muted">' + n + '</span></button>').join('') + '</div></div>' : '';
    const best = rankable.slice().sort((a, b) => sortKey(b) - sortKey(a)).find(x => x.buy.sr.src !== 'low') || rankable[0];
    if (!best) {
      return '<section class="lead"><div class="lead-main"><span class="eyebrow">Rankings</span><h2 class="lead-name">Add prices to rank your crafts</h2>' +
        '<p class="help">A recipe is ranked once its result and every material has a price. Pasting a price list from aion2.exchange on the Import tab is the fastest way to fill these in.</p>' + needHTML + '</div>' + stats + '</section>';
    }
    const rc = best[UI.metric];
    const bd = UI.per === 'budget' ? budgetOf(rcOf(rc), myBudget()) : null;
    if (bd && bd.n) {
      return '<section class="lead"><div class="lead-main"><span class="eyebrow">' + (bd.total > 0 ? 'Best use of your ' + compact(myBudget()) + ' budget' : 'Nothing your budget covers turns a profit') + ' · ' + METRIC[UI.metric].short + '</span>' +
        '<h2 class="lead-name">' + nameHTML(best.r.output) + '</h2>' +
        '<div class="lead-figs"><span class="big ' + tone(bd.total) + '">' + sk(bd.total) + '</span><span>Kina expected from ' + plural(bd.n, 'craft') + '</span><span class="sep">|</span><span>' + pct(bd.ahead) + ' chance to finish ahead</span>' +
        (isFinite(bd.anyCombo) ? '<span class="sep">|</span><span>' + pct(bd.anyCombo) + ' chance of a combo</span>' : '') + '</div>' +
        tagList(rowFlags(best)) + needHTML + '</div>' + stats + '</section>';
    }
    const positive = rc.profit > 0;
    return '<section class="lead"><div class="lead-main"><span class="eyebrow">' + (positive ? 'Most profitable right now' : 'Nothing turns a profit right now') + ' · ' + METRIC[UI.metric].short + '</span>' +
      '<h2 class="lead-name">' + nameHTML(best.r.output) + '</h2>' +
      '<div class="lead-figs"><span class="big ' + tone(rc.profit) + '">' + sk(rc.profit) + '</span><span>' + (best.kind === 'combo' ? 'Kina per Splendent' : 'Kina per attempt') + '</span><span class="sep">|</span><span>ROI ' + roiTxt(rc.roi) + '</span><span class="sep">|</span><span>' + pct(rc.pS) + (best.kind === 'combo' ? ' chance per craft' : ' success') + '</span></div>' +
      tagList(rowFlags(best)) + needHTML + '</div>' + stats + '</section>';
  }

  // A tick box for "I gather this" next to a material, for anything not crafted.
  function gatherBox(id, route) {
    if (route === 'craft' || route === 'combo') return '';
    return '<input type="checkbox" class="check" data-chg="gather-toggle" data-id="' + esc(id) + '"' + (isGathered(getItem(id)) ? ' checked' : '') +
      ' aria-label="I gather ' + esc(itemName(id)) + '" title="I gather this myself">';
  }
  // What one craft can turn into, and what spending your budget on it looks like.
  function riskHTML(rc) {
    const o = outcomesOf(rc), B = myBudget();
    if (!isFinite(o.ev)) return '<p class="help">Add the missing prices to see what a craft can turn into.</p>';
    let h = '<div class="mini-well"><table class="mini"><thead><tr><th>One craft</th><th class="num">Chance</th><th class="num">You end up</th></tr></thead><tbody>' +
      o.list.map(x => '<tr><td>' + esc(x.label) + '</td><td class="num">' + pct(x.p) + '</td><td class="num ' + tone(x.kina) + '">' + sk(x.kina) + '</td></tr>').join('') +
      '<tr><td><strong>Average</strong></td><td></td><td class="num ' + tone(o.ev) + '"><strong>' + sk(o.ev) + '</strong></td></tr></tbody></table></div>' +
      '<p class="note">Each craft puts ' + k(o.stake) + ' Kina of materials and fees on the line, and loses Kina ' + pct(o.lose) + ' of the time.</p>';
    if (!B) return h + '<p class="help">Enter your budget above the rankings to see how many crafts it covers and your chance to finish ahead.</p>';
    const bd = budgetOf(rc, B);
    if (bd.free) return h + '<p class="note">With your current choices this craft costs no Kina, so your budget doesn’t limit it.</p>';
    if (!bd.n) return h + '<p class="note loss">One craft costs ' + k(o.stake) + ', more than your ' + k(B) + ' budget.</p>';
    const combo = o.list.find(x => x.combo);
    return h + '<dl class="kv tot"><dt>Crafts your ' + compact(B) + ' covers</dt><dd>' + NF0.format(bd.n) + '</dd>' +
      '<dt>Expected profit</dt><dd class="' + tone(bd.total) + '"><strong>' + sk(bd.total) + '</strong></dd>' +
      '<dt>Chance to finish ahead</dt><dd>' + pct(bd.ahead) + '</dd>' +
      (combo && isFinite(bd.anyCombo) ? '<dt>Chance of at least one ' + esc(combo.label) + '</dt><dd>' + pct(bd.anyCombo) + '</dd>' : '') +
      '<dt>Worst case</dt><dd class="loss">' + sk(bd.worst) + '</dd></dl>' +
      '<p class="note">Assumes you spend the budget one craft after another without reinvesting what you sell.</p>';
  }
  // A Splendent row: the cost to get one through combos, and whether to sell it or craft with it.
  function comboDetailHTML(C, row) {
    const scn = UI.metric, E = C.E[scn], ch = row[scn], rc = ch.rc, base = rc.r;
    const name = itemName(row.r.output), baseName = itemName(base.output);
    const tries = ch.pS > 0 ? 1 / ch.pS : NaN;
    const out = getItem(row.r.output);
    const odds = '<dl class="kv"><dt>' + esc(baseName) + ' success</dt><dd>' + pct(rc.pS) + '</dd><dd class="why">' + esc(successWhy(rc.sr, base)) + '</dd>' +
      '<dt>Proc, then a second craft</dt><dd>' + pct(rc.c, 0) + ' × ' + pct(rc.cs) + '</dd>' +
      '<dt>Splendent per craft</dt><dd>' + pct(ch.pS) + '</dd>' +
      '<dt>Crafts per Splendent</dt><dd>≈ ' + qfmt(tries) + '</dd>' +
      '<dt>Normal items along the way</dt><dd>≈ ' + qfmt(rc.pBase * rc.outQty * tries) + '</dd><dd class="why">' +
      (ch.baseNet != null ? esc(baseName) + ' sold at ' + k(ch.baseNet) + ' each after the fee.' : esc(baseName) + ' has no market price, so they count as 0. Add its price to lower the cost.') + '</dd></dl>';
    const mats = '<div class="mini-well"><table class="mini"><thead><tr><th>Material</th><th class="num">Qty</th><th>Source</th><th class="num">Each</th><th class="num">Total</th><th class="c">Gather</th></tr></thead><tbody>' +
      treeRows(E, base.mats, rc, 0, rc.consume * tries, new Set([base.id])) + '</tbody></table></div>' +
      '<dl class="kv tot"><dt>Materials and fees, ' + qfmt(tries) + ' crafts</dt><dd>' + k(rc.attemptCost * tries) + '</dd>' +
      '<dt>Normal items sold</dt><dd>' + (ch.credit ? '−' + k(ch.credit * tries) : '0') + '</dd>' +
      '<dt>Cost per Splendent</dt><dd><strong>' + k(ch.cost) + '</strong></dd>' +
      (ch.cost < 0 ? '<dd class="why">Below zero: the normal items sell for more than the materials, so the Splendent is a bonus.</dd>' : '') + '</dl>';
    const users = C.rows.filter(x => x.r.mats.some(m => m.item === row.r.output));
    let use = '<dl class="kv"><dt>Listed price</dt><dd>' + (out && num(out.price) > 0 ? k(out.price) : '—') + '</dd>' +
      '<dt>Sold, after the fee</dt><dd>' + k(ch.outNet) + '</dd>' +
      '<dt>Profit per Splendent sold</dt><dd class="' + tone(ch.profit) + '"><strong>' + sk(ch.profit) + '</strong></dd></dl>';
    if (users.length) {
      use += '<p class="help">Or keep it to craft:</p><ul class="uses">' + users.map(x => {
        const m = x[scn].mats.find(mm => mm.item === row.r.output);
        const how = m.route === 'combo' ? 'making your own Splendent' : m.route === 'buy' ? 'buying the Splendent, since that’s cheaper' : 'no Splendent price yet';
        return '<li><button class="linkbtn" data-act="goto-recipe" data-id="' + esc(x.r.id) + '">' + esc(itemName(x.r.output)) + '</button>: <span class="' + tone(x[scn].profit) + '">' + sk(x[scn].profit) + '</span> per craft, ' + how + '</li>';
      }).join('') + '</ul>';
      if (out && num(out.price) > 0) use += '<p class="note">If you’d craft the next tier anyway, keeping it is worth the full ' + k(out.price) + ' you’d pay to buy one. Selling it nets ' + k(ch.outNet) + ' after the fee.</p>';
    } else use += '<p class="help">No released recipe uses ' + esc(name) + ' as a material.</p>';
    return '<div class="dgrid">' +
      '<div class="dcard"><h4>Odds</h4>' + odds + '</div>' +
      '<div class="dcard"><h4>Cost per Splendent · ' + METRIC[scn].short + '</h4>' + mats + '</div>' +
      '<div class="dcard"><h4>Sell it or keep it</h4>' + use + '</div>' +
      '</div><div class="dcard dwide"><h4>Risk and reward · one craft of ' + esc(baseName) + '</h4>' + riskHTML(rc) + '</div>' +
      craftTrackHTML({ r: base, [scn]: rc }) +
      '<div class="dcard dwide"><h4>Plan your crafts</h4>' + comboPlanHTML(C, row) + '</div>' +
      '<div class="row-gap dfoot">' + (canManage() ? '<button class="btn" data-act="edit" data-id="' + esc(base.id) + '">Edit ' + esc(baseName) + ' recipe</button>' : '') +
      '<button class="btn ghost" data-act="find-price" data-id="' + esc(row.r.output) + '">Price history</button></div>';
  }
  function detailHTML(C, row) {
    if (row.kind === 'combo') return comboDetailHTML(C, row);
    const scn = UI.metric, E = C.E[scn], rc = row[scn], r = row.r;
    const outName = itemName(r.output), comboName = itemName(rc.comboId);
    const out = getItem(r.output);
    let odds = '<dl class="kv"><dt>Success</dt><dd>' + pct(rc.pS) + '</dd><dd class="why">' + esc(successWhy(rc.sr, r)) + '</dd>';
    if (rc.c > 0) {
      if (rc.extraCombo) {
        odds += '<dt>Combo craft</dt><dd>' + (rc.comboTaken ? pct(rc.pCombo) : 'skipped') + '</dd><dd class="why">' + pct(rc.c, 0) + ' chance after a success. The combo craft uses its own materials and makes ' + qfmt(rc.comboQty) + ' × ' + esc(comboName) + ' on top of the normal result, at ' + pct(rc.cs) + ' success. ' +
          (rc.comboTaken ? 'Worth taking at these prices.' : 'Skipped in the math: it ' + rc.comboWhy + '.') + '</dd>';
      } else {
        odds += '<dt>Combo result</dt><dd>' + pct(rc.pCombo) + '</dd><dd class="why">' + pct(rc.c, 0) + ' proc chance on a successful craft, then a second craft at ' + pct(rc.cs) + '. Gives ' + qfmt(rc.comboQty) + ' × ' + esc(comboName) + (r.comboAdds ? ' on top of' : ' instead of') + ' the normal result.</dd>';
      }
    }
    const cshare = comboShare(rc);
    if (cshare) {
      const ci = getItem(rc.comboId), old = ci && (!ci.updatedAt || Date.now() - ci.updatedAt > DAY);
      odds += '<dt>Sales from the Splendent</dt><dd>' + pct(cshare.share, 0) + '</dd><dd class="why">' +
        (cshare.driven ? 'Most of this craft’s profit comes from the occasional ' + esc(comboName) + ', so its price matters most. ' : '') +
        'Without Splendent procs it would make ' + sk(cshare.without) + ' per attempt. The Splendent price, ' + k(ci && ci.price) + ', was entered ' +
        (ci && ci.updatedAt ? ago(ci.updatedAt) : 'at an unknown time') + (old ? '. Paste a fresh price if it looks off.' : '.') + '</dd>';
    }
    if (r.transfer && r.transfer.length) {
      odds += '<dt>Transfer Crafting</dt><dd>100%</dd><dd class="why">Turns a ' + esc(outName) + ' you own into ' + (rc.sameCombo ? 'its Splendent version' : esc(comboName)) + ' with ' +
        esc(r.transfer.map(x => x[1] + ' ' + x[0]).join(', ')) + '. The result is bound to your character, so it can’t be sold and isn’t counted here.</dd>';
    }
    odds += '<dt>Failed attempt</dt><dd>' + pct(1 - rc.pS) + '</dd><dd class="why">Loses ' + pct(rc.loss, 0) + ' of the materials.</dd>';
    odds += '<dt>Made per attempt</dt><dd>' + qfmt(rc.units) + ' × ' + esc(outName) + '</dd>';
    if (rc.c > 0 && !rc.sameCombo && rc.pCombo > 0) odds += '<dt>Combo items per attempt</dt><dd>' + qfmt(rc.pCombo * rc.comboQty) + ' × ' + esc(comboName) + '</dd>';
    const covered = rc.unitCost < 0; // the combo items alone earn more than every craft costs
    odds += '</dl><dl class="kv tot"><dt>Cost per item made</dt><dd>' + (covered ? '0' : k(rc.unitCost)) + '</dd>' +
      '<dt>Break-even list price</dt><dd>' + (covered ? 'Any price' : k(rc.breakEven)) + '</dd>' +
      (covered ? '<dd class="why">The ' + esc(comboName) + ' procs alone earn more than the materials cost, so the normal items are pure profit at any price.</dd>' : '') +
      '<dt>Current list price</dt><dd>' + (out && num(out.price) > 0 ? k(out.price) : '—') + '</dd>' + listDoubtHTML(row, out) +
      (out && histOf(out).length > 1 ? '<dd class="why" style="text-align:right">' + sparkHTML(out) + '</dd>' : '') + '</dl>';

    let rowsHTML = treeRows(E, r.mats, rc, 0, 1, new Set([r.id]));
    if (rc.cmats.length) {
      rowsHTML += '<tr class="part"><td colspan="6">Combo craft materials · used on ' + pct(rc.pS * rc.c, 0) + ' of attempts' + (rc.comboTaken ? '' : ' (skipped)') + '</td></tr>' + treeRows(E, r.comboMats, rc, 0, 1, new Set([r.id]));
    }
    const mats = '<div class="mini-well"><table class="mini"><thead><tr><th>Material</th><th class="num">Qty</th><th>Source</th><th class="num">Each</th><th class="num">Total</th><th class="c">Gather</th></tr></thead><tbody>' +
      rowsHTML + '</tbody></table></div>' +
      (scn === 'buy' ? '<p class="note">This view assumes you buy everything. Your Gather ticks change the With own gathering and Gain vs selling raw columns.</p>' : '') +
      '<dl class="kv tot"><dt>Materials</dt><dd>' + k(rc.matCost) + '</dd>' +
      (rc.consume < 0.9999 ? '<dt>Expected use (' + pct(rc.consume, 0) + ')</dt><dd>' + k(rc.matCost * rc.consume) + '</dd>' : '') +
      (rc.comboCost ? '<dt>Combo materials, expected</dt><dd>' + k(rc.comboCost) + '</dd>' : '') +
      (rc.fee ? '<dt>Crafting fee</dt><dd>' + k(rc.fee) + '</dd>' : '') +
      '<dt>Cost per attempt</dt><dd><strong>' + k(rc.attemptCost) + '</strong></dd>' +
      '<dt>Expected sales after fee</dt><dd>' + k(rc.revenue) + '</dd>' +
      '<dt>Profit per attempt</dt><dd class="' + tone(rc.profit) + '"><strong>' + sk(rc.profit) + '</strong></dd></dl>';

    return '<div class="dgrid">' +
      '<div class="dcard"><h4>Odds per attempt</h4>' + odds + '</div>' +
      '<div class="dcard"><h4>Materials · ' + METRIC[scn].short + '</h4>' + mats + '</div>' +
      '<div class="dcard"><h4>Plan a batch</h4>' + planHTML(C, row) + '</div>' +
      '</div><div class="dcard dwide"><h4>Risk and reward · ' + METRIC[scn].short + '</h4>' + riskHTML(rc) + '</div>' + craftTrackHTML(row) +
      '<div class="row-gap dfoot">' + (canManage() ? '<button class="btn" data-act="edit" data-id="' + esc(r.id) + '">Edit recipe</button>' : '') +
      '<button class="btn ghost" data-act="find-price" data-id="' + esc(r.output) + '">Price history</button>' + (r.notes ? '<span class="note">' + esc(r.notes) + '</span>' : '') + '</div>';
  }
  // Your live-tracked crafting of a recipe against the tables: success, combo procs and landings, and time
  // per craft, which also gives Kina an hour at that speed.
  function craftTrackHTML(row) {
    const r = row.r, rc = row[UI.metric], list = myCrafts().filter(c => c.r === r.id).sort((a, b) => b.t - a.t);
    const btn = '<button class="btn" data-act="live-craft" data-r="' + esc(r.id) + '"' + (!liveSupported() || UI.live.state !== 'off' ? ' disabled' : '') + '>Track crafting live</button>';
    let h = '<div class="dcard dwide"><h4>Your crafting</h4>';
    if (!list.length) {
      return h + '<p class="help">Track crafting live to measure your real success rate, combo procs and time per craft for this recipe. ' +
        (liveSupported() ? 'It reads the crafting popup from a screen share, in this browser only.' : 'It needs Edge or Chrome on a computer.') + '</p><div class="row-gap">' + btn + '</div></div>';
    }
    const t = list.reduce((a, c) => ({ x: a.x + c.x, ok: a.ok + c.ok, cp: a.cp + c.cp, cok: a.cok + c.cok, sec: a.sec + (c.spc > 0 ? c.spc * c.x : 0), n: a.n + (c.spc > 0 ? c.x : 0) }), { x: 0, ok: 0, cp: 0, cok: 0, sec: 0, n: 0 });
    const spc = t.n ? t.sec / t.n : NaN, perHour = spc > 0 ? 3600 / spc : NaN;
    h += '<dl class="kv"><dt>Succeeded</dt><dd>' + pct(t.ok / t.x) + ' of ' + plural(t.x, 'craft') + '</dd><dd class="why">The table gives ' + pct(rc.pS) + ' at your level now.' + (t.x < 50 ? ' It takes a few dozen crafts for this to be a fair comparison.' : '') + '</dd>' +
      (rc.c > 0 ? '<dt>Combo procs</dt><dd>' + (t.ok ? pct(t.cp / t.ok, 0) + ' of successes' : '—') + '</dd><dd class="why">Expected ' + pct(rc.c, 0) + '.</dd>' +
        '<dt>Combo crafts landed</dt><dd>' + (t.cp ? t.cok + ' of ' + t.cp : '—') + '</dd><dd class="why">The table gives ' + pct(rc.cs) + '.</dd>' : '') +
      '<dt>Time per craft</dt><dd>' + (isFinite(spc) ? NF1.format(spc) + ' s' : '—') + '</dd>' +
      (isFinite(perHour) && isFinite(rc.profit) ? '<dt>At that speed</dt><dd class="' + tone(rc.profit) + '"><strong>' + sk(rc.profit * perHour) + '</strong> an hour</dd><dd class="why">' + NF1.format(perHour) + ' crafts an hour × ' + sk(rc.profit) + ' per attempt (' + METRIC[UI.metric].short + '), with the materials in hand.</dd>' : '') + '</dl>' +
      '<div class="mini-well"><table class="mini"><thead><tr><th>When</th><th class="num">Crafts</th><th class="num">Succeeded</th><th class="num">Combos</th><th class="num">Per craft</th><th><span class="sr">Delete</span></th></tr></thead><tbody>' +
      list.map(c => '<tr><td>' + esc(when(c.t)) + '</td><td class="num">' + c.x + '</td><td class="num">' + c.ok + '</td><td class="num">' + c.cok + ' of ' + c.cp + '</td><td class="num">' + (c.spc ? NF1.format(c.spc) + ' s' : '—') + '</td>' +
        '<td><button class="btn small ghost" data-act="craft-del" data-r="' + esc(r.id) + '" data-t="' + c.t + '" aria-label="Delete the crafting session from ' + esc(when(c.t)) + '">Delete</button></td></tr>').join('') + '</tbody></table></div>' +
      '<div class="row-gap">' + btn + '</div></div>';
    return h;
  }
  function treeRows(E, list, rcParent, depth, mult, path) {
    const rcList = E.recipe(rcParent.r);
    const priced = list === rcParent.r.comboMats ? rcList.cmats : list === rcParent.r.mats ? rcList.mats : null;
    let h = '';
    for (const m of priced || []) {
      const q = m.qty * mult;
      const batch = m.route === 'craft' && getRecipe(m.recipe) && getRecipe(m.recipe).outQty > 1 ? getRecipe(m.recipe).outQty : 0;
      h += '<tr class="' + (depth ? 'subrow' : '') + '"><td><span class="indent" style="--d:' + depth + '"></span>' + (depth ? '↳ ' : '') + nameHTML(m.item) +
        (batch ? ' <span class="muted">(made ' + batch + ' per craft; ↳ rows are this craft’s share)</span>' : '') + '</td>' +
        '<td class="num">' + qfmt(q) + '</td><td>' + routeTag(m.route) + '</td><td class="num">' + k(m.cost) + (m.route === 'buy' ? priceAge(m.item) : '') + '</td><td class="num">' + k(q * m.cost) + '</td><td class="c">' + gatherBox(m.item, m.route) + '</td></tr>';
      const sub = m.route === 'craft' || m.route === 'combo' ? getRecipe(m.recipe) : null;
      if (sub && depth < 4 && !path.has(sub.id)) {
        const src = E.recipe(sub);
        const per = m.route === 'combo' ? src.pCombo * src.comboQty : src.units;
        if (per > 0) { const p2 = new Set(path); p2.add(sub.id); h += treeRows(E, sub.mats, src, depth + 1, (q / per) * src.consume, p2); }
      }
    }
    return h;
  }
  function walk(E, r, attempts, acc, depth, path) {
    const rc = E.recipe(r);
    acc.fees += attempts * rc.fee;
    const lists = [[rc.mats, rc.consume]];
    if (rc.comboTaken && rc.cmats.length) lists.push([rc.cmats, rc.pS * rc.c * rc.consumeC]);
    for (const [list, share] of lists) {
      for (const m of list) {
        const need = m.qty * attempts * share;
        const sub = m.route === 'craft' || m.route === 'combo' ? getRecipe(m.recipe) : null;
        if (sub && depth < 6 && !path.has(sub.id)) {
          const src = E.recipe(sub);
          const per = m.route === 'combo' ? src.pCombo * src.comboQty : src.units;
          // Crafts happen whole: one Magic Crystal craft uses all 20 Spiritstone and makes 10, even if you need 3.
          const subAttempts = per > 0 ? Math.ceil(need / per - 1e-9) : 0;
          const key = sub.id + ':' + m.route;
          const s = acc.subs.get(key) || { r: sub, attempts: 0, units: 0, made: 0, item: m.item, combo: m.route === 'combo' };
          s.attempts += subAttempts; s.units += need; s.made += subAttempts * per; acc.subs.set(key, s);
          const p2 = new Set(path); p2.add(sub.id);
          walk(E, sub, subAttempts, acc, depth + 1, p2);
        } else {
          const L = acc.leaves.get(m.item) || { item: m.item, route: m.route, unit: m.cost, qty: 0 };
          L.qty += need;
          acc.leaves.set(m.item, L);
        }
      }
    }
  }
  // What to buy, gather and craft first for a number of crafts of one recipe.
  function shopList(E, r, crafts) {
    const acc = { leaves: new Map(), subs: new Map(), fees: 0 };
    walk(E, r, crafts, acc, 0, new Set([r.id]));
    const order = { gather: 0, buy: 1, vendor: 2, missing: 3 };
    const leaves = [...acc.leaves.values()].sort((a, b) => (order[a.route] - order[b.route]) || itemName(a.item).localeCompare(itemName(b.item)));
    let spend = acc.fees, missing = false, body = '';
    for (const L of leaves) {
      const qty = Math.ceil(L.qty - 1e-6);
      const pays = L.route === 'buy' || L.route === 'vendor';
      const kin = pays ? qty * L.unit : 0;
      if (pays) spend += kin;
      if (L.route === 'missing') missing = true;
      body += '<tr><td>' + nameHTML(L.item) + '</td><td class="num">' + NF0.format(qty) + '</td><td>' + routeTag(L.route) + '</td><td class="num">' + (pays ? k(kin) : L.route === 'gather' ? '0' : '—') + '</td><td class="c">' + gatherBox(L.item, L.route) + '</td></tr>';
    }
    const subs = [...acc.subs.values()];
    let note = '';
    if (subs.length) {
      note = '<p class="note">Craft first: ' + subs.map(s => plural(s.attempts, 'craft') + ' of ' + esc(itemName(s.r.output)) +
        (s.combo ? ', expected to proc ' + NF0.format(Math.ceil(s.units - 1e-6)) + ' × ' + esc(itemName(s.item))
          : ', which makes ' + qfmt(s.r.outQty || 1) + ' per success when you need ' + NF0.format(Math.ceil(s.units - 1e-6)) +
            (s.made - s.units >= 1 ? '. Keep the spares for later crafts' : ''))).join('; ') + '.' +
        (subs.some(s => s.combo) ? ' Those combo crafts also make normal items you can sell, which this total doesn’t count.' : '') + '</p>';
    }
    return {
      table: '<div class="mini-well"><table class="mini"><thead><tr><th>Get</th><th class="num">Qty</th><th>From</th><th class="num">Kina</th><th class="c">Gather</th></tr></thead><tbody>' + body + '</tbody></table></div>',
      note: note, spend: spend, missing: missing
    };
  }
  // Chance of at least n successes in `tries` attempts at chance p each.
  function atLeast(n, tries, p) {
    if (n <= 0) return 1;
    if (tries < n || !(p > 0)) return 0;
    if (p >= 1) return 1;
    let term = Math.pow(1 - p, tries), below = 0;
    for (let i = 0; i < n; i++) { below += term; term *= (tries - i) / (i + 1) * p / (1 - p); }
    return Math.max(0, Math.min(1, 1 - below));
  }
  function craftsFor(n, p, target) {
    if (!(p > 0)) return NaN;
    let tries = n;
    while (tries < 100000 && atLeast(n, tries, p) < target) tries++;
    return tries;
  }
  function comboPlanHTML(C, row) {
    const E = UI.planGather ? C.E.gather : C.E.buy;
    const base = getRecipe(row.r.via);
    if (!base) return '';
    const rc = E.recipe(base), ch = E.chase(base), p = ch.pS;
    const n = Math.max(1, Math.min(1000, Math.round(num(UI.wanted) || 1)));
    const one = shopList(E, base, 1);
    const name = itemName(row.r.output), baseName = itemName(base.output);
    let out = '<div class="plan-in"><div class="field"><label for="plan-w">Splendents wanted</label><input id="plan-w" class="in num" inputmode="numeric" value="' + n + '" data-chg="plan-w"></div>' +
      '<label class="check"><input type="checkbox" id="plan-g" data-chg="plan-g"' + (UI.planGather ? ' checked' : '') + '> Gather what I can</label></div>' +
      '<p class="help">Each craft of ' + esc(baseName) + ': ' + pct(p) + ' gives ' + esc(name) + ', ' + pct(rc.pBase) + ' gives a normal ' + esc(baseName) + ', and ' + pct(1 - rc.pS) + ' fails.</p>' +
      '<h4>One craft uses</h4>' + one.table + one.note +
      '<dl class="kv tot"><dt>Kina for one craft</dt><dd>' + (one.missing ? '—' : k(one.spend)) + '</dd></dl>';
    if (p > 0) {
      const marks = [craftsFor(n, p, 0.5), craftsFor(n, p, 0.75), craftsFor(n, p, 0.9)];
      const tries = [...new Set([n, n + 1, n + 2, n + 4].concat(marks).filter(x => x >= n && x <= marks[2]))].sort((a, b) => a - b);
      out += '<h4>Your odds</h4><div class="mini-well"><table class="mini"><thead><tr><th class="num">Crafts</th><th class="num">Chance of ' + n + '+</th><th class="num">Kina spent</th><th class="num">Normal items made</th></tr></thead><tbody>' +
        tries.map(t => '<tr><td class="num">' + t + '</td><td class="num">' + pct(atLeast(n, t, p)) + '</td><td class="num">' + (one.missing ? '—' : k(shopList(E, base, t).spend)) + '</td><td class="num">≈ ' + qfmt(t * rc.pBase * rc.outQty) + '</td></tr>').join('') +
        '</tbody></table></div><p class="note">On average it takes ' + qfmt(n / p) + ' crafts. Budget for ' + marks[2] + ' to be 90% sure. Kina spent doesn’t subtract the normal items you can sell' +
        (ch.baseNet != null ? ' (' + k(ch.baseNet) + ' each after the fee)' : '') + '.</p>';
    }
    return out;
  }
  function planHTML(C, row) {
    const n = Math.max(1, Math.min(100000, Math.round(num(UI.crafts) || 1)));
    const E = UI.planGather ? C.E.gather : C.E.buy;
    const rc = E.recipe(row.r);
    const list = shopList(E, row.r, n);
    const spend = list.spend, missing = list.missing;
    const baseUnits = n * rc.pBase * rc.outQty;
    const comboUnits = n * rc.pCombo * rc.comboQty;
    const revenue = n * rc.revenue;
    const profit = missing ? NaN : revenue - spend;
    let out = '<div class="plan-in"><div class="field"><label for="plan-n">Crafts</label><input id="plan-n" class="in num" inputmode="numeric" value="' + n + '" data-chg="plan-n"></div>' +
      '<label class="check"><input type="checkbox" id="plan-g" data-chg="plan-g"' + (UI.planGather ? ' checked' : '') + '> Gather what I can</label></div>' + list.table + list.note;
    out += '<dl class="kv tot"><dt>Kina to spend</dt><dd>' + (missing ? '—' : k(spend)) + '</dd>' +
      '<dt>Expected to make</dt><dd>' + qfmt(rc.sameCombo ? baseUnits + comboUnits : baseUnits) + ' × ' + esc(itemName(row.r.output)) + '</dd>' +
      (rc.c > 0 && !rc.sameCombo && rc.pCombo > 0 ? '<dt>Expected combo items</dt><dd>' + qfmt(comboUnits) + ' × ' + esc(itemName(rc.comboId)) + '</dd>' : '') +
      '<dt>Expected sales after fee</dt><dd>' + k(revenue) + '</dd>' +
      '<dt>Expected profit</dt><dd class="' + tone(profit) + '"><strong>' + sk(profit) + '</strong></dd></dl>' +
      '<p class="note">' + (n === 1 ? 'One craft either fails (' + pct(1 - rc.pS) + '), succeeds' + (rc.pCombo > 0 ? ', or procs the combo (' + pct(rc.pCombo) + ')' : '') + '. The sales and profit above are averages over many crafts.' : 'These are averages. Small batches swing with luck, so buy a few spare materials.') + '</p>';
    return out;
  }

  function recipesView() {
    if (UI.editor) return editorHTML();
    const everything = [...reg().recipes.values()];
    const pendingCount = everything.filter(notOut).length;
    if (UI.recSrc === 'pending' && (!pendingCount || S.settings.showPending)) UI.recSrc = 'all';
    const list0 = UI.recSrc === 'pending' ? everything.filter(notOut) : allRecipes();
    const profs = [];
    for (const r of list0) if (r.profession && profs.indexOf(r.profession) < 0) profs.push(r.profession);
    const pi = p => { const i = PROFESSIONS.indexOf(p); return i < 0 ? 99 : i; };
    profs.sort((a, b) => pi(a) - pi(b) || a.localeCompare(b));
    const q = loose(UI.recQ);
    let list = list0.filter(r =>
      (UI.recProf === 'all' || r.profession === UI.recProf) &&
      (UI.recSrc === 'all' || UI.recSrc === 'pending' || (UI.recSrc === 'mine' ? r.src !== 'catalog' : r.src === 'catalog')) &&
      (!q || loose(itemName(r.output)).indexOf(q) >= 0 || r.mats.some(m => loose(itemName(m.item)).indexOf(q) >= 0)));
    list.sort((a, b) => pi(a.profession) - pi(b.profession) || (a.level || 0) - (b.level || 0) || itemName(a.output).localeCompare(itemName(b.output)));
    const mineCount = list0.filter(r => r.src !== 'catalog').length;
    let h = '<div class="toolbar"><h2 class="sec-h">Recipes</h2><div class="row-gap">' +
      (canManage() ? '<button class="btn primary" data-act="new-recipe">New recipe</button>' : '<span class="help">Only the owner can change recipes.</span>') + '</div></div>';
    h += '<p class="help">' + (CAT.recipes.length ? NF0.format(CAT.recipes.length - (S.settings.showPending ? 0 : pendingCount)) + ' Global recipes come from AION2 Hub' + (CAT.built ? ' (read ' + esc(CAT.built) + ')' : '') + '. Edit one to fix it for your client; your version replaces it. ' : '') +
      'Recipes you add yourself are listed under “Mine and edited”.' + (pendingCount && !S.settings.showPending ? ' ' + NF0.format(pendingCount) + ' recipes are left out of rankings because they need something the Global client doesn’t have yet. You can include them in Settings.' : '') + '</p>';
    h += '<div class="filters"><div class="field"><label for="recq">Find a recipe or material</label><input id="recq" class="in" type="search" value="' + esc(UI.recQ) + '" data-inp="recq" placeholder="e.g. Odyle" autocomplete="off"></div>' +
      '<div class="seg" role="group" aria-label="Source"><button data-act="rec-src" data-v="all" aria-pressed="' + (UI.recSrc === 'all') + '">All</button><button data-act="rec-src" data-v="catalog" aria-pressed="' + (UI.recSrc === 'catalog') + '">AION2 Hub</button><button data-act="rec-src" data-v="mine" aria-pressed="' + (UI.recSrc === 'mine') + '">Mine and edited (' + mineCount + ')</button>' +
      (pendingCount && !S.settings.showPending ? '<button data-act="rec-src" data-v="pending" aria-pressed="' + (UI.recSrc === 'pending') + '">Not in Global yet (' + pendingCount + ')</button>' : '') + '</div></div>';
    if (profs.length > 1) h += '<div class="chips" role="group" aria-label="Profession">' + ['all'].concat(profs).map(p => '<button class="chip" data-act="rec-prof" data-p="' + esc(p) + '" aria-pressed="' + (UI.recProf === p) + '">' + (p === 'all' ? 'All professions' : esc(p)) + '</button>').join('') + '</div>';
    if (!list.length) return h + '<section class="empty"><h2 class="sec-h">' + (list0.length ? 'No recipes match' : 'No recipes yet') + '</h2><p>' + (list0.length ? 'Clear the search or pick another profession.' : 'Copy a recipe from the in-game crafting window: what it makes, how many, and each material with its quantity.') + '</p></section>';
    const shown = list.slice(0, UI.recShow);
    h += '<ul class="rlist">';
    for (const r of shown) {
      const sr = successFor(r);
      const tags = [];
      if (r.src === 'edited') tags.push(['', 'Edited']);
      if (r.src === 'mine') tags.push(['', 'Mine']);
      if (notOut(r)) tags.push(['warn', notOutTag(r)]);
      if (r.example) tags.push(['ex', 'Example']);
      h += '<li><div class="rc-main"><div class="rc-name">' + nameHTML(r.output) + (r.outQty > 1 ? ' <span class="muted">×' + qfmt(r.outQty) + '</span>' : '') + tagList(tags) + '</div>' +
        '<div class="rc-meta">' + esc([r.profession, r.level != null ? lvTxt(r.level) : null, r.grade].filter(Boolean).join(' · ')) + ' · ' + pct(sr.p) + ' success' +
        (r.combo ? ' · combo ' + qfmt(r.combo) + '%' + (r.comboItem ? ' → ' + esc(itemName(r.comboItem)) : '') : '') + (r.fee ? ' · fee ' + k(r.fee) : '') + '</div>' +
        '<div class="rc-mats">' + r.mats.map(m => qfmt(m.qty) + ' ' + esc(itemName(m.item))).join(' · ') + '</div></div>' +
        (canManage() ? '<button class="btn small" data-act="edit" data-id="' + esc(r.id) + '">Edit</button>' : '') + '</li>';
    }
    return h + '</ul>' + moreBtn('rec-more', shown.length, list.length);
  }
  function blankDraft() {
    return { id: null, src: 'mine', output: '', outQty: '1', profession: 'Cooking', grade: 'Common', level: '', success: '', fee: '', combo: '', comboItem: '', comboQty: '', comboSuccess: '', comboAdds: false, mats: [{ name: '', qty: '1' }, { name: '', qty: '1' }], cmats: [], notes: '' };
  }
  function draftFrom(r) {
    return {
      id: r.id, src: r.src, output: itemName(r.output), outQty: str(r.outQty), profession: r.profession || 'Cooking', grade: r.grade || '', level: str(r.level), success: str(r.success), fee: r.fee ? str(r.fee) : '',
      combo: r.combo ? str(r.combo) : '', comboItem: r.comboItem ? itemName(r.comboItem) : '', comboQty: str(r.comboQty), comboSuccess: str(r.comboSuccess), comboAdds: !!r.comboAdds,
      mats: r.mats.map(m => ({ name: itemName(m.item), qty: str(m.qty) })), cmats: (r.comboMats || []).map(m => ({ name: itemName(m.item), qty: str(m.qty) })), notes: r.notes || ''
    };
  }
  function draftHint(d) {
    const lvl = num(myLevels()[d.profession]), req = num(d.level);
    const grade = gradeOf(d), floor = rateRow(grade, 0).basic.toFixed(2);
    if (lvl == null) return { ph: floor, help: 'Leave blank to use the level table. Set your ' + d.profession + ' level in Settings first.' };
    if (req == null) return { ph: floor, help: 'Leave blank and enter the recipe level to look up the rate.' };
    const gap = lvl - req;
    if (gap < 0) return { ph: floor, help: 'Your ' + d.profession + ' ' + lvTxt(lvl) + ' is below this recipe.' };
    const row = rateRow(grade, gap), p = row.basic.toFixed(2);
    return { ph: p, help: (row.known ? '' : 'About ') + p + '% from the ' + grade + ' table (' + lvTxt(lvl) + ' vs ' + lvTxt(req) + ', difference ' + gap + '). Leave blank to keep it in sync, or type what the game’s Crafting Chance window shows.' };
  }
  function matRows(list, kind) {
    return list.map((m, i) =>
      '<div class="mat"><input id="ed-' + kind + '-name-' + i + '" class="in" list="dl-items" value="' + esc(m.name) + '" data-inp="ed-mat" data-l="' + kind + '" data-i="' + i + '" data-k="name" placeholder="Material" aria-label="Material ' + (i + 1) + '" autocomplete="off">' +
      '<input id="ed-' + kind + '-qty-' + i + '" class="in num" value="' + esc(m.qty) + '" data-inp="ed-mat" data-l="' + kind + '" data-i="' + i + '" data-k="qty" inputmode="decimal" aria-label="Quantity of material ' + (i + 1) + '">' +
      '<button class="btn small ghost" data-act="ed-del-mat" data-l="' + kind + '" data-i="' + i + '" aria-label="Remove material ' + (i + 1) + '">Remove</button></div>').join('');
  }
  function editorHTML() {
    const d = UI.editor, isNew = !d.id, hint = draftHint(d);
    const fromCat = d.src === 'catalog' || d.src === 'edited';
    const profs = PROFESSIONS.slice(); if (d.profession && profs.indexOf(d.profession) < 0) profs.push(d.profession);
    const f = (key, label, extra, opt) => '<div class="field"><label for="ed-' + key + '">' + label + (opt ? ' <span class="opt">' + opt + '</span>' : '') + '</label><input id="ed-' + key + '" class="in" value="' + esc(d[key]) + '" data-inp="ed" data-k="' + key + '" autocomplete="off" ' + (extra || '') + '></div>';
    let actions = '';
    if (d.src === 'mine' && !isNew) actions += '<button class="btn danger' + (UI.confirm === 'del-' + d.id ? ' armed' : '') + '" data-act="ed-delete">' + (UI.confirm === 'del-' + d.id ? 'Click again to delete' : 'Delete') + '</button>';
    if (d.src === 'edited') actions += '<button class="btn danger' + (UI.confirm === 'restore-' + d.id ? ' armed' : '') + '" data-act="ed-restore">' + (UI.confirm === 'restore-' + d.id ? 'Click again to restore' : 'Restore original') + '</button>';
    let h = '<section class="panel"><div class="toolbar"><h2 class="sec-h">' + (isNew ? 'New recipe' : 'Edit recipe') + '</h2><div class="row-gap">' + actions +
      '<button class="btn" data-act="ed-cancel">Cancel</button><button class="btn primary" data-act="ed-save">Save recipe</button></div></div>';
    if (fromCat) h += '<p class="help">This recipe comes from AION2 Hub. Saving keeps your version in place of it' + (d.src === 'edited' ? ', and Restore original brings theirs back' : '') + '.</p>';
    if (UI.editorErr.length) h += '<ul class="errs">' + UI.editorErr.map(e => '<li>' + esc(e) + '</li>').join('') + '</ul>';
    h += '<div class="fgrid"><div class="field span2"><label for="ed-output">Makes</label><input id="ed-output" class="in" list="dl-items" value="' + esc(d.output) + '" data-inp="ed" data-k="output" placeholder="e.g. Morfa Tea" autocomplete="off"' + (fromCat ? ' readonly' : '') + '></div>' +
      f('outQty', 'Quantity made', 'inputmode="decimal"') +
      '<div class="field"><label for="ed-profession">Profession</label><select id="ed-profession" class="in" data-inp="ed" data-k="profession">' + profs.map(p => '<option' + (p === d.profession ? ' selected' : '') + '>' + esc(p) + '</option>').join('') + '</select></div>' +
      '<div class="field"><label for="ed-grade">Grade</label><select id="ed-grade" class="in" data-inp="ed" data-k="grade">' + GRADES.map(g => '<option' + (g === gradeOf(d) ? ' selected' : '') + '>' + g + '</option>').join('') + '</select></div>' +
      f('level', 'Recipe level', 'inputmode="numeric" placeholder="e.g. 60" title="The total the game shows in brackets: Professional Lv 10 is 60"') +
      '<div class="field"><label for="ed-success">Success % <span class="opt">optional</span></label><input id="ed-success" class="in" value="' + esc(d.success) + '" data-inp="ed" data-k="success" inputmode="decimal" placeholder="' + esc(hint.ph) + '" autocomplete="off"><span class="help" id="ed-success-help">' + esc(hint.help) + '</span></div>' +
      f('fee', 'Kina fee per craft', 'inputmode="decimal" placeholder="0"', 'optional') + '</div>';
    h += '<fieldset class="fs"><legend>Materials per craft</legend><div class="mats">' + matRows(d.mats, 'mats') +
      '</div><div><button class="btn small" data-act="ed-add-mat" data-l="mats">Add material</button></div></fieldset>';
    h += '<fieldset class="fs"><legend>Combo</legend><p class="help">After a successful craft a combo can trigger. For gear it usually swaps the result for the Splendent version. For food it usually makes another batch, so tick the box below.</p><div class="fgrid">' +
      f('combo', 'Combo chance %', 'inputmode="decimal" placeholder="0"') +
      '<div class="field span2"><label for="ed-comboItem">Combo gives <span class="opt">blank = same item</span></label><input id="ed-comboItem" class="in" list="dl-items" value="' + esc(d.comboItem) + '" data-inp="ed" data-k="comboItem" placeholder="e.g. Splendent Truth Orb" autocomplete="off"></div>' +
      f('comboQty', 'Combo quantity', 'inputmode="decimal" placeholder="' + esc(d.comboItem ? '1' : (d.outQty || '1')) + '"') +
      f('comboSuccess', 'Combo success %', 'inputmode="decimal" placeholder="from the COMBO table"', 'optional') +
      '</div><label class="check"><input type="checkbox" id="ed-comboAdds" data-chg="ed-check" data-k="comboAdds"' + (d.comboAdds ? ' checked' : '') + '> The combo item comes on top of the normal result instead of replacing it</label></fieldset>';
    h += '<div class="field"><label for="ed-notes">Notes <span class="opt">optional</span></label><textarea id="ed-notes" class="in" rows="2" data-inp="ed" data-k="notes">' + esc(d.notes) + '</textarea></div></section>';
    return h;
  }

  function sparkHTML(it) {
    const all = histOf(it);
    if (all.length < 2) return '<span class="muted">—</span>';
    const pts = all.slice(-30), W = 88, H = 24, P = 3;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    let lo = Infinity, hi = -Infinity;
    for (const x of pts) { lo = Math.min(lo, x.p); hi = Math.max(hi, x.p); }
    const X = t => t1 === t0 ? W / 2 : P + (t - t0) / (t1 - t0) * (W - 2 * P);
    const Y = v => hi === lo ? H / 2 : H - P - (v - lo) / (hi - lo) * (H - 2 * P);
    const d = pts.map((x, i) => (i ? 'L' : 'M') + X(x.t).toFixed(1) + ' ' + Y(x.p).toFixed(1)).join(' ');
    const last = pts[pts.length - 1], prev = pts[pts.length - 2];
    const ch = (last.p - prev.p) / prev.p;
    const chTxt = Math.abs(ch) < 0.0005 ? 'no change' : (ch > 0 ? '▲ ' : '▼ ') + Math.abs(ch * 100).toFixed(Math.abs(ch) < 0.1 ? 1 : 0) + '%';
    return '<span class="spark" title="Last ' + pts.length + ' readings"><svg viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true"><path class="s-line" d="' + d + '"/><circle class="s-dot" cx="' + X(last.t).toFixed(1) + '" cy="' + Y(last.p).toFixed(1) + '" r="2.5"/></svg><span class="sub">' + chTxt + '</span></span>';
  }
  function needsPrice(it, used, C, outputs) {
    if (!used.has(it.id)) return false;
    if (C.E.gather.unit(it.id).route === 'missing') return true;
    return outputs.has(it.id) && !it.bound && !(num(it.price) > 0);
  }
  // The Prices tab's rows for the current search, filter and sort.
  function priceItems(used, C, outputs) {
    const q = loose(UI.priceQuery);
    let items = UI.priceFilter === 'out' ? allItems().filter(it => it.unavailable) : allItems().filter(it => !it.virtual || used.has(it.id));
    if (UI.priceFilter === 'priced') items = items.filter(it => num(it.price) > 0 || num(it.vendor) > 0);
    else if (UI.priceFilter === 'needs') items = items.filter(it => needsPrice(it, used, C, outputs));
    else if (UI.priceFilter === 'gather') items = items.filter(isGathered);
    if (q) items = items.filter(it => loose(it.name).indexOf(q) >= 0);
    const byName = (a, b) => a.name.localeCompare(b.name);
    if (UI.priceSort === 'stale') items.sort((a, b) => ((a.updatedAt || 0) - (b.updatedAt || 0)) || byName(a, b));
    else if (UI.priceSort === 'used') items.sort((a, b) => ((used.get(b.id) || 0) - (used.get(a.id) || 0)) || byName(a, b));
    else items.sort(byName);
    return items;
  }
  function pricesView() {
    const used = usage();
    const C = buildCalc();
    const outputs = new Set(allRecipes().map(r => r.output));
    const items = priceItems(used, C, outputs);
    const now = Date.now();
    let h = '<div class="toolbar"><h2 class="sec-h">Prices</h2><div class="row-gap"><button class="btn" data-act="tab" data-tab="shots">Paste a price list</button></div></div>' +
      '<p class="help">Enter the lowest market price for one unit. You can type 1520, 1,520 or 1.5k. Every price you enter or paste is kept, so click an item’s name to see its price history. Tick <strong>Gather</strong> for anything you collect yourself' + (S.uid ? ' (your own list: friends tick theirs)' : '') + ', and <strong>Bound</strong> for items that can’t be sold on the market. Use the NPC column for vendor-only materials.</p>';
    h += '<section class="panel"><div class="addrow">' +
      '<input id="ni-name" class="in" list="dl-items" placeholder="New item name" value="' + esc(UI.newItem.name) + '" data-inp="ni" data-k="name" aria-label="New item name" autocomplete="off">' +
      '<input id="ni-price" class="in num" inputmode="decimal" placeholder="Market price" value="' + esc(UI.newItem.price) + '" data-inp="ni" data-k="price" aria-label="New item market price">' +
      '<label class="check"><input type="checkbox" id="ni-gather" data-chg="ni-gather"' + (UI.newItem.gather ? ' checked' : '') + '> I gather this</label>' +
      '<button class="btn primary" data-act="item-add">Add item</button></div></section>';
    const seg = (act, cur, opts) => '<div class="seg" role="group">' + opts.map(([v, l]) => '<button data-act="' + act + '" data-v="' + v + '" aria-pressed="' + (cur === v) + '">' + l + '</button>').join('') + '</div>';
    h += '<div class="filters"><div class="field"><label for="pq">Search</label><input id="pq" class="in" type="search" value="' + esc(UI.priceQuery) + '" data-inp="pq" placeholder="Filter items" autocomplete="off"></div>' +
      seg('price-filter', UI.priceFilter, [['all', 'All'], ['needs', 'Needs a price'], ['priced', 'Priced'], ['gather', 'Gathered'], ['out', 'Not in game']]) +
      seg('price-sort', UI.priceSort, [['name', 'A–Z'], ['used', 'Most used'], ['stale', 'Oldest price first']]) + '</div>';
    if (UI.priceQuery.trim() && items.length) {
      const allOut = items.every(it => it.unavailable);
      h += '<div class="row-gap"><button class="btn small" data-act="bulk-out" data-v="' + (allOut ? '0' : '1') + '">' + (allOut ? 'Mark these ' + plural(items.length, 'item') + ' as in the game' : 'Mark these ' + plural(items.length, 'item') + ' as not in the game') + '</button>' +
        '<span class="help">Recipes that use an item that isn’t in the game are left out of rankings.</span></div>';
    }
    if (!items.length) return h + '<section class="empty"><h2 class="sec-h">No items match</h2><p>' + (UI.priceQuery ? 'Nothing is named like “' + esc(UI.priceQuery) + '”.' : 'Try another filter.') + '</p></section>';
    const shown = items.slice(0, UI.priceShow);
    h += '<div class="well"><table class="grid prices"><thead><tr><th>Item</th><th class="num w-num">Market price</th><th>Trend</th><th class="num w-num">NPC price</th><th class="c">Gather</th><th class="c">Bound</th><th class="num">Used in</th><th>Updated</th><th><span class="sr">Delete</span></th></tr></thead><tbody>';
    for (const it of shown) {
      const id = esc(it.id), u = used.get(it.id) || 0, open = UI.priceOpen === it.id;
      const tags = [];
      if (it.example) tags.push(['ex', 'Example']);
      if (reg().unavail.has(it.id)) tags.push(['warn', 'Not in game']);
      if (priceInfo(it).doubtful) tags.push(['loss', 'Doubtful price']);
      else if (needsPrice(it, used, C, outputs)) tags.push(['warn', 'Needs a price']);
      const isStale = num(it.price) > 0 && it.updatedAt && now - it.updatedAt > DAY;
      const deletable = !it.virtual && !u && !reg().catNames.has(norm(it.name));
      h += '<tr class="' + (open ? 'open' : '') + '"><td class="c-name"><button class="name-btn" data-act="price-open" data-id="' + id + '" aria-expanded="' + open + '">' + nameHTML(it.id) + '</button>' + tagList(tags) + '</td>' +
        '<td class="num"><input id="pi-price-' + id + '" class="cell-in num" inputmode="decimal" value="' + (it.price != null ? NF0.format(it.price) : '') + '" placeholder="—" data-chg="item" data-id="' + id + '" data-f="price" aria-label="Market price of ' + esc(it.name) + '"' + (it.bound ? ' disabled title="Bound items can’t be sold on the market"' : '') + '></td>' +
        '<td>' + sparkHTML(it) + '</td>' +
        '<td class="num"><input id="pi-vendor-' + id + '" class="cell-in num" inputmode="decimal" value="' + (it.vendor != null ? NF0.format(it.vendor) : '') + '" placeholder="—" data-chg="item" data-id="' + id + '" data-f="vendor" aria-label="NPC price of ' + esc(it.name) + '"></td>' +
        '<td class="c"><input type="checkbox" class="check" id="pi-gather-' + id + '" data-chg="item" data-id="' + id + '" data-f="gather"' + (isGathered(it) ? ' checked' : '') + ' aria-label="I gather ' + esc(it.name) + '"></td>' +
        '<td class="c"><input type="checkbox" class="check" id="pi-bound-' + id + '" data-chg="item" data-id="' + id + '" data-f="bound"' + (it.bound ? ' checked' : '') + ' aria-label="' + esc(it.name) + ' is bound"></td>' +
        '<td class="num">' + u + '</td>' +
        '<td class="when">' + ago(it.updatedAt) + (isStale ? ' <span class="tag warn">Old</span>' : '') + '</td>' +
        '<td class="c">' + (deletable && canManage() ? '<button class="btn small ghost" data-act="item-del" data-id="' + id + '">Delete</button>' : '') + '</td></tr>';
      if (open) h += '<tr class="detail"><td colspan="9">' + priceDetail(it) + '</td></tr>';
    }
    return h + '</tbody></table></div>' + moreBtn('price-more', shown.length, items.length);
  }
  function priceDetail(it) {
    const hist = histOf(it);
    const flag = '<label class="check"><input type="checkbox" id="pu-' + esc(it.id) + '" data-chg="item" data-id="' + esc(it.id) + '" data-f="unavailable"' + (it.unavailable ? ' checked' : '') + '> ' +
      esc(it.name) + ' isn’t in the Global client yet. Leave out every recipe that uses it.</label>';
    if (!hist.length) return '<div class="ppanel">' + flag + '<p class="help">No prices recorded for ' + esc(it.name) + ' yet. Enter one above or paste a price list on the Import tab, and each new price is added here.</p></div>';
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (const x of hist) { lo = Math.min(lo, x.p); hi = Math.max(hi, x.p); sum += x.p; }
    const first = hist[0], last = hist[hist.length - 1];
    const ch = (last.p - first.p) / first.p;
    const stat = (l, v) => '<div class="stat"><dt>' + l + '</dt><dd>' + v + '</dd></div>';
    let h = '<div class="ppanel">' + flag + '<dl class="statrow">' + stat('Latest', k(last.p)) + stat('Lowest', k(lo)) + stat('Highest', k(hi)) + stat('Average', k(sum / hist.length)) +
      stat('Since first reading', hist.length > 1 ? (ch >= 0 ? '+' : '−') + Math.abs(ch * 100).toFixed(1) + '%' : '—') + stat('Readings', NF0.format(hist.length)) + '</dl>';
    h += '<div class="chart" data-item="' + esc(it.id) + '" tabindex="0" aria-label="Price history of ' + esc(it.name) + '. Use the arrow keys to step through readings."></div>';
    h += '<details class="hist"><summary>All ' + plural(hist.length, 'reading') + '</summary><div class="mini-well"><table class="mini"><thead><tr><th>When</th><th class="num">Price</th><th class="num">Change</th><th><span class="sr">Delete</span></th></tr></thead><tbody>' +
      hist.map((x, i) => ({ x: x, i: i })).reverse().map(({ x, i }) => {
        const prev = hist[i - 1];
        const c = prev ? (x.p - prev.p) / prev.p : null;
        return '<tr><td>' + esc(when(x.t)) + '</td><td class="num">' + k(x.p) + '</td><td class="num">' + (c == null ? '—' : (c >= 0 ? '+' : '−') + Math.abs(c * 100).toFixed(1) + '%') + '</td>' +
          '<td><button class="btn small ghost" data-act="hist-del" data-id="' + esc(it.id) + '" data-t="' + x.t + '" aria-label="Delete the reading from ' + esc(when(x.t)) + '">Delete</button></td></tr>';
      }).join('') + '</tbody></table></div><p class="note">Delete a reading if a price was entered or pasted wrong. Prices entered within 10 minutes of each other count as one reading.</p></details></div>';
    return h;
  }

  function niceTicks(min, max, n) {
    if (min === max) { const pad = Math.abs(min) * 0.1 || 1; min -= pad; max += pad; }
    const raw = (max - min) / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), e = raw / mag;
    const step = (e >= 7.5 ? 10 : e >= 3.5 ? 5 : e >= 1.5 ? 2 : 1) * mag;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
    return { lo: lo, hi: hi, ticks: ticks };
  }
  function drawCharts() {
    view.querySelectorAll('.chart[data-item]').forEach(host => { const it = getItem(host.dataset.item); if (it) drawChart(host, it); });
  }
  function drawChart(host, it) {
    const pts = histOf(it);
    if (pts.length < 2) {
      host.removeAttribute('tabindex');
      host.innerHTML = '<p class="help">The chart starts once there are two readings. Each new price you enter or read adds one.</p>';
      return;
    }
    const W = Math.max(280, Math.floor(host.clientWidth - 16)), H = 230, M = { l: 50, r: 20, t: 18, b: 28 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    let lo = Infinity, hi = -Infinity;
    for (const x of pts) { lo = Math.min(lo, x.p); hi = Math.max(hi, x.p); }
    const yt = niceTicks(lo, hi, 4);
    const X = t => M.l + (t1 === t0 ? iw / 2 : (t - t0) / (t1 - t0) * iw);
    const Y = v => M.t + ih - (v - yt.lo) / ((yt.hi - yt.lo) || 1) * ih;
    const span = t1 - t0;
    const tLabel = t => span > 2 * DAY ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" aria-hidden="true">';
    for (const v of yt.ticks) s += '<line class="c-grid" x1="' + M.l + '" x2="' + (W - M.r) + '" y1="' + Y(v).toFixed(1) + '" y2="' + Y(v).toFixed(1) + '"/><text class="c-axis" x="' + (M.l - 8) + '" y="' + (Y(v) + 4).toFixed(1) + '" text-anchor="end">' + esc(compact(v)) + '</text>';
    const nx = Math.min(4, pts.length);
    for (let i = 0; i < nx; i++) {
      const t = t0 + span * (nx === 1 ? 0.5 : i / (nx - 1));
      const anchor = nx > 1 && i === 0 ? 'start' : nx > 1 && i === nx - 1 ? 'end' : 'middle';
      s += '<text class="c-axis" x="' + X(t).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="' + anchor + '">' + esc(tLabel(t)) + '</text>';
    }
    const line = pts.map((x, i) => (i ? 'L' : 'M') + X(x.t).toFixed(1) + ' ' + Y(x.p).toFixed(1)).join(' ');
    s += '<path class="c-area" d="' + line + ' L' + X(t1).toFixed(1) + ' ' + Y(yt.lo).toFixed(1) + ' L' + X(t0).toFixed(1) + ' ' + Y(yt.lo).toFixed(1) + ' Z"/>';
    s += '<path class="c-line" d="' + line + '"/>';
    if (pts.length <= 60) for (const x of pts) s += '<circle class="c-dot" cx="' + X(x.t).toFixed(1) + '" cy="' + Y(x.p).toFixed(1) + '" r="4"/>';
    const last = pts[pts.length - 1];
    if (pts.length > 60) s += '<circle class="c-dot" cx="' + X(last.t).toFixed(1) + '" cy="' + Y(last.p).toFixed(1) + '" r="4"/>';
    const ly = Y(last.p) - 12 < M.t + 4 ? Y(last.p) + 22 : Y(last.p) - 12;
    s += '<text class="c-end" x="' + (X(last.t) - 4).toFixed(1) + '" y="' + ly.toFixed(1) + '" text-anchor="end">' + esc(k(last.p)) + '</text>';
    s += '<line class="c-cross" id="cx-line" y1="' + M.t + '" y2="' + (M.t + ih) + '" x1="-10" x2="-10" visibility="hidden"/>';
    s += '<circle class="c-dot" id="cx-dot" r="6" cx="-10" cy="-10" visibility="hidden"/>';
    s += '<rect class="c-hit" x="' + M.l + '" y="0" width="' + iw + '" height="' + H + '"/></svg><div class="tip" hidden><strong></strong><span></span></div>';
    host.innerHTML = s;
    const svg = host.querySelector('svg'), tip = host.querySelector('.tip'), cl = host.querySelector('#cx-line'), cd = host.querySelector('#cx-dot');
    let active = -1;
    function show(i) {
      active = i;
      const p = pts[i], px = X(p.t), py = Y(p.p);
      cl.setAttribute('x1', px); cl.setAttribute('x2', px); cl.setAttribute('visibility', 'visible');
      cd.setAttribute('cx', px); cd.setAttribute('cy', py); cd.setAttribute('visibility', 'visible');
      tip.firstElementChild.textContent = k(p.p) + ' Kina';
      tip.lastElementChild.textContent = when(p.t);
      tip.hidden = false;
      const scale = svg.getBoundingClientRect().width / W || 1;
      const tw = tip.offsetWidth, th = tip.offsetHeight, hw = host.clientWidth;
      let left = 8 + px * scale - tw / 2;
      left = Math.max(4, Math.min(hw - tw - 4, left));
      let top = 8 + py * scale - th - 12;
      if (top < 4) top = 8 + py * scale + 14;
      tip.style.left = left + 'px'; tip.style.top = top + 'px';
    }
    function hide() { active = -1; tip.hidden = true; cl.setAttribute('visibility', 'hidden'); cd.setAttribute('visibility', 'hidden'); }
    function nearest(clientX) {
      const r = svg.getBoundingClientRect();
      const x = (clientX - r.left) * (W / r.width);
      let best = 0, bd = Infinity;
      pts.forEach((p, i) => { const d = Math.abs(X(p.t) - x); if (d < bd) { bd = d; best = i; } });
      return best;
    }
    svg.addEventListener('pointermove', e => show(nearest(e.clientX)));
    svg.addEventListener('pointerdown', e => show(nearest(e.clientX)));
    svg.addEventListener('pointerleave', hide);
    host.onkeydown = e => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); show(Math.max(0, Math.min(pts.length - 1, (active < 0 ? pts.length : active) + (e.key === 'ArrowLeft' ? -1 : 1)))); }
      else if (e.key === 'Escape') hide();
    };
    host.onblur = hide;
  }

  function shotsView() {
    return '<div class="toolbar"><h2 class="sec-h">Import prices</h2></div>' + pasteHTML();
  }
  function pasteHTML() {
    const st = UI.shots;
    let h = '<p class="help">Copy a price list from any website, spreadsheet or chat message and paste it below. On aion2.exchange, select the table from the Item header down to the last row, then copy. Each item name is matched to your item list and the first price after it is used, skipping the 9-digit item ID. Items that aren’t on your list are ignored. If an item appears more than once, its lowest price is kept. Nothing is saved until you check the list and click Save.</p>' +
      '<div class="field"><label for="paste-in">Pasted prices</label><textarea id="paste-in" class="in" rows="8" data-inp="paste-text" placeholder="Odyle	1,520&#10;Fine Odyle	4,800&#10;Orichalcum Ore	2.1k">' + esc(st.pasteText || '') + '</textarea></div>' +
      '<div class="row-gap"><button class="btn primary" data-act="paste-read">Read prices</button>' + (st.pasteText ? '<button class="btn ghost" data-act="paste-clear">Clear</button>' : '') + '</div>';
    if (st.pasteNote) h += '<p class="help" role="status">' + esc(st.pasteNote) + '</p>';
    if (st.lastRead) {
      // A look inside the last read, for working out why a paste matched nothing.
      const lr = st.lastRead;
      h += '<details class="hist"><summary>What the page read</summary><p class="note">Version ' + esc(BUILD) + ' · ' +
        (lr.mode === 'db' ? 'shared price book' : 'this browser only (' + esc(lr.auth) + ')') + ' · ' + NF0.format(lr.known) + ' item names to match against · ' +
        NF0.format(lr.cells) + ' pieces of text read.</p><div class="mini-well"><table class="mini"><thead><tr><th>Text</th><th>Matched item</th></tr></thead><tbody>' +
        lr.seen.map(x => '<tr><td>' + esc(x.text.length > 70 ? x.text.slice(0, 70) + '…' : x.text) + '</td><td>' + (x.match ? esc(x.match) : '<span class="muted">—</span>') + '</td></tr>').join('') +
        '</tbody></table></div></details>';
    }
    if (st.market && st.market.length && st.source === 'paste') h += marketReview();
    return h;
  }
  // Finds known item names in pasted text and the first price that follows each one. A name must fill
  // its cell, or be followed directly by a number ("Odyle 1,520"), so "Odyle Pack" is never read as Odyle.
  function parsePaste(text) {
    const known = allItems().map(it => ({ it: it, key: loose(it.name) })).filter(x => x.key.length > 2).sort((a, b) => b.key.length - a.key.length);
    const byKey = new Map();
    for (const x of known) if (!byKey.has(x.key)) byKey.set(x.key, x.it);
    const itemIn = cell => {
      const lc = loose(cell);
      const exact = byKey.get(lc);
      if (exact) return { it: exact, rest: '' };
      for (const x of known) {
        if (!lc.startsWith(x.key + ' ')) continue;
        const rest = cell.slice(cellNameEnd(cell, x.it.name));
        if (!/^\s*[A-Za-z]/.test(rest)) return { it: x.it, rest: rest };
      }
      return null;
    };
    const isItemId = cell => /^\d{9}$/.test(cell);
    const cells = [];
    for (const line of String(text).split(/\r?\n/)) {
      for (const cell of line.split(/\t|\s{2,}|\|/)) {
        const v = cell.trim();
        if (!v) continue;
        // Some browsers copy a name and its 9-digit item ID as one piece: "True Dragon Lord Greaves210230015".
        const glued = v.match(/^(.*\D)\s*(\d{9})$/);
        if (glued && /\p{L}/u.test(glued[1])) { cells.push(glued[1].trim()); cells.push(glued[2]); } else cells.push(v);
      }
    }
    const best = new Map(), unknown = [], seen = [];
    const headers = /^(item|items|name|cheapest|price|listings?|change|sold|avg|average|vs|qty|quantity)\b/i;
    let found = 0;
    for (let i = 0; i < cells.length; i++) {
      const hit = itemIn(cells[i]);
      if (seen.length < 20) seen.push({ text: cells[i], match: hit ? hit.it.name : null });
      if (!hit) {
        // Remember a few names that weren't recognized, to explain an import that finds nothing.
        const c = cells[i];
        if (unknown.length < 5 && c.length >= 3 && c.length <= 60 && /\p{L}{2}/u.test(c) && !/%/.test(c) && !headers.test(c) && unknown.indexOf(c) < 0) unknown.push(c);
        continue;
      }
      found++;
      let price = priceIn(hit.rest);
      for (let j = i + 1; price == null && j < Math.min(cells.length, i + 8); j++) {
        if (isItemId(cells[j])) continue;
        if (itemIn(cells[j])) break;
        price = priceIn(cells[j]);
      }
      if (price == null) continue;
      const prev = best.get(hit.it.id);
      if (!prev || price < prev.price) best.set(hit.it.id, { read: cells[i], name: hit.it.name, price: price });
    }
    return { rows: [...best.values()], found: found, unknown: unknown, known: known.length, seen: seen, cells: cells.length };
  }
  function cellNameEnd(cell, name) {
    const i = cell.toLowerCase().indexOf(name.toLowerCase());
    return i >= 0 ? i + name.length : cell.length;
  }
  function priceIn(s) {
    const re = /(^|[^\d.,×xX#%])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kKmMbB](?![a-zA-Z]))?(?![\d%])/g;
    let m;
    while ((m = re.exec(String(s)))) {
      const v = num(m[2].replace(/,/g, '') + (m[3] || ''));
      if (v != null && v > 0) return v;
    }
    return null;
  }
  function marketReview() {
    const rows = UI.shots.market;
    const n = rows.filter(r => r.include).length;
    let h = '<section class="panel"><div class="toolbar"><h3 class="sec-h">' + 'Check the prices found' + '</h3><div class="row-gap"><button class="btn ghost" data-act="shot-discard">Discard</button>' +
      '<button class="btn primary" data-act="shot-apply"' + (n ? '' : ' disabled') + '>Save ' + plural(n, 'price') + '</button></div></div>' +
      '<p class="help">Fix any name that matched the wrong item, untick rows you don’t want, then save.</p>' +
      '<div class="well"><table class="grid prices" style="min-width:640px"><thead><tr><th class="c">Save</th><th>Item</th><th>Change</th><th class="num w-num">Price per unit</th></tr></thead><tbody>';
    rows.forEach((r, i) => {
      const match = findItem(r.name);
      const p = num(r.priceText);
      let change = '<span class="tag ex">New item</span>';
      if (match) {
        const old = num(match.price);
        const d = old > 0 && p > 0 ? (p - old) / old : null;
        change = old > 0 ? '<span class="muted">' + k(old) + ' → ' + k(p) + '</span>' + (d != null ? ' <span>' + (d >= 0 ? '▲ ' : '▼ ') + Math.abs(Math.round(d * 100)) + '%</span>' : '') : '<span class="tag">First price</span>';
      }
      if (r.doubt) change += '<div><span class="tag loss">Looks wrong</span> <span class="sub">' + esc(r.doubt) + '. Tick it only if the price is real.</span></div>';
      const readAs = r.read && norm(r.read) !== norm(r.name) ? '<div class="sub" style="padding:0 8px">Read as “' + esc(r.read) + '”</div>' : '';
      h += '<tr><td class="c"><input type="checkbox" class="check" id="sm-inc-' + i + '" data-chg="sm-inc" data-i="' + i + '"' + (r.include ? ' checked' : '') + ' aria-label="Save this row"></td>' +
        '<td><input id="sm-name-' + i + '" class="cell-in" list="dl-items" value="' + esc(r.name) + '" data-chg="sm-name" data-i="' + i + '" aria-label="Item name" autocomplete="off">' + readAs + '</td>' +
        '<td>' + change + '</td>' +
        '<td class="num"><input id="sm-price-' + i + '" class="cell-in num" inputmode="decimal" value="' + esc(r.priceText) + '" data-chg="sm-price" data-i="' + i + '" aria-label="Price per unit"></td></tr>';
    });
    return h + '</tbody></table></div></section>';
  }

  // Minutes from "45", "45m", "1h", "1h 20m" or "1:20".
  function minutesIn(s) {
    s = String(s || '').trim().toLowerCase();
    let m = s.match(/^(\d+):([0-5]?\d)$/);
    if (m) return +m[1] * 60 + +m[2];
    m = s.match(/^(?:(\d*\.?\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d*\.?\d+)\s*(?:m(?:ins?|inutes?)?)?)?$/);
    return m && (m[1] || m[2]) ? +(m[1] || 0) * 60 + +(m[2] || 0) : null;
  }
  function durTxt(min) {
    const t = Math.round(min || 0);
    if (t < 60) return NF1.format(min || 0) + ' min';
    return Math.floor(t / 60) + ' h' + (t % 60 ? ' ' + (t % 60) + ' min' : '');
  }
  function runDraft(f) {
    if (!UI.runDraft || UI.runDraft.f !== f) UI.runDraft = { f: f, m: '', n: {} };
    return UI.runDraft;
  }
  // A node always gives the plain (Common) material and can tier up to better grades of it.
  const GRADE_RE = /^(Fresh|Fine|Pure|Radiant) (.+)$/;
  const NODE_GRADES = ['Common', 'Fresh', 'Fine', 'Pure', 'Radiant'];
  function nodeGrade(name) { const m = String(name).match(GRADE_RE); return m ? m[1] : 'Common'; }
  // Raw materials (used by a recipe, made by none), grouped by the node that gives them: Fine Sapphire
  // Gemstone comes from the same node as Sapphire Gemstone. A node's hour is valued from your logged
  // sessions, sold as is or partly crafted. Crafts value their other materials as in "Gain vs selling
  // raw": bought, or gathered and counted at what they'd sell for.
  function gatherCalc(C) {
    const tC = myCraftMin(), B = myBudget();
    const levelsSet = Object.keys(myLevels()).length > 0;
    const made = new Set(C.prod.keys());
    for (const r of allRecipes()) if (r.comboItem) made.add(r.comboItem);
    const uses = new Map();
    for (const row of C.rows) {
      for (const m of row.opp.mats) {
        if (made.has(m.item)) continue;
        if (!uses.has(m.item)) uses.set(m.item, []);
        uses.get(m.item).push({ row: row, m: m });
      }
    }
    const mats = new Map();
    for (const [id, list] of uses) {
      const it = getItem(id);
      if (!it || it.bound || reg().unavail.has(id) || (num(it.vendor) > 0 && !isGathered(it))) continue;
      if (GATHERABLE && !GATHERABLE.has(norm(it.name))) continue; // drops and other crafting materials
      const net = C.E.opp.netSell(id), crafts = [];
      for (const { row, m } of list) {
        const rc = row.opp;
        if (!isFinite(rc.profit) || (levelsSet && !canCraft(row.r)) || priceDoubts(row).overCost) continue;
        if (B && !(outcomesOf(row.gather).stake <= B)) continue;
        const used = m.qty * rc.consume;
        // The craft's gain over selling the material it uses.
        if (used > 0) crafts.push({ row: row, qty: m.qty, used: used, gain: rc.profit + used * (m.cost - (net || 0)) });
      }
      crafts.sort((a, b) => b.gain - a.gain);
      mats.set(id, { id: id, it: it, net: net, crafts: crafts, best: crafts[0] || null });
    }
    const nodes = new Map();
    for (const g of mats.values()) {
      const m = g.it.name.match(GRADE_RE), base = m && findItem(m[2]);
      const key = base && mats.has(base.id) ? base.id : g.id;
      if (!nodes.has(key)) nodes.set(key, { key: key, name: itemName(key), grades: [] });
      nodes.get(key).grades.push(g);
    }
    const runs = myRuns(), out = [], odds = gatherOdds(), expected = UI.gatherOdds !== 'raw';
    // A session's minutes, less its breaks when you've chosen to leave them out.
    const mins = r => UI.gatherNoBreaks && r.st && r.st.brk ? Math.max(0.1, r.m - r.st.brk / 60) : r.m;
    for (const f of nodes.values()) {
      f.grades.sort((a, b) => NODE_GRADES.indexOf(nodeGrade(a.it.name)) - NODE_GRADES.indexOf(nodeGrade(b.it.name)));
      f.ids = f.grades.map(g => g.id);
      f.runs = runs.filter(r => r.f === f.key).sort((a, b) => b.t - a.t);
      f.minutes = f.runs.reduce((s, r) => s + mins(r), 0);
      f.got = 0;
      for (const g of f.grades) {
        g.got = f.runs.reduce((s, r) => s + (r.n[g.id] || 0), 0);
        g.perHour = g.perHourGot = f.minutes ? g.got * 60 / f.minutes : NaN;
        f.got += g.got;
      }
      f.unpriced = f.grades.filter(g => g.got > 0 && g.net == null);
      const tracked = f.runs.filter(r => r.st);
      f.track = tracked.length ? tracked.reduce((a, r) => {
        const g = Object.assign({}, a.g);
        for (const k of Object.keys(r.st.g || {})) g[k] = [(g[k] ? g[k][0] : 0) + r.st.g[k][0], (g[k] ? g[k][1] : 0) + r.st.g[k][1]];
        return { x: a.x + r.st.x, ok: a.ok + r.st.ok, d: a.d + r.st.d, u: a.u + r.st.u, sec: a.sec + r.st.sec, g: g,
          act: a.act + (r.st.act || 0), mov: a.mov + (r.st.mov || 0), brk: a.brk + (r.st.brk || 0), timed: a.timed + (r.st.act != null ? r.m * 60 : 0), min: a.min + mins(r) };
      }, { x: 0, ok: 0, d: 0, u: 0, sec: 0, g: {}, act: 0, mov: 0, brk: 0, timed: 0, min: 0 }) : null;
      // Expected: this node's extractions per hour (tracked) at your pooled odds for its kind, so a lucky
      // or unlucky rare grade doesn't swing the hour. As gathered: what your sessions actually got.
      f.kind = nodeKind(f.name);
      f.odds = odds[f.kind] && odds[f.kind].x >= ODDS_MIN ? odds[f.kind] : null;
      if (f.odds && f.track && f.track.x) {
        f.xHour = f.track.x * 60 / f.track.min;
        f.open = openOdds(f.key, f.kind);
        f.items = expectedItems(f.odds, f.open);
        f.expect = {};
        for (const g of f.grades) {
          const h = OPEN_GRADES.indexOf(nodeGrade(g.it.name) === 'Fresh' ? 'Fine' : nodeGrade(g.it.name));
          g.perHourExp = h >= 0 ? f.xHour * f.items[h] : 0;
          f.expect[g.id] = h >= 0 ? f.track.x * f.items[h] : 0;
          if (expected) g.perHour = g.perHourExp;
        }
        f.expected = expected;
      }
      f.sellHour = f.minutes ? f.grades.reduce((s, g) => s + (g.net == null ? 0 : g.perHour * g.net), 0) : NaN;
      f.plan = f.minutes && tC ? craftPlan(f, tC) : null;
      f.craftHour = f.plan ? f.plan.hour : NaN;
      out.push(f);
    }
    return out;
  }
  // Crafting part of an hour's haul: the crafts that pay most over selling their materials, taken while
  // each still earns more per hour of crafting than the hour so far. Crafting time is added to the hour.
  function craftPlan(f, tC) {
    const h = tC / 60, opts = [], seen = new Set(), steps = [];
    for (const g of f.grades) for (const c of g.crafts) if (c.gain > 0 && g.perHour > 0) opts.push({ g: g, c: c });
    opts.sort((a, b) => b.c.gain - a.c.gain);
    const left = new Map(f.grades.map(g => [g.id, g.perHour]));
    let kina = f.sellHour, hours = 1;
    for (const o of opts) {
      if (o.c.gain / h <= kina / hours) break;
      if (seen.has(o.c.row.r.id) || !(left.get(o.g.id) > 0)) continue;
      const n = left.get(o.g.id) / o.c.used;
      seen.add(o.c.row.r.id); left.set(o.g.id, 0);
      kina += n * o.c.gain; hours += n * h;
      steps.push({ g: o.g, c: o.c, n: n });
    }
    return { kina: kina, hours: hours, hour: kina / hours, steps: steps };
  }
  // The craft with the best expected profit when every material is bought, within your budget if you set one.
  function bestBuyCraft(C) {
    const levelsSet = Object.keys(myLevels()).length > 0, B = myBudget();
    let best = null;
    for (const row of C.rows) {
      if (!isFinite(row.buy.profit) || (levelsSet && !canCraft(row.r)) || priceDoubts(row).overCost) continue;
      if (B && !(outcomesOf(row.buy).stake <= B)) continue;
      if (!best || row.buy.profit > best.buy.profit) best = row;
    }
    return best;
  }
  function gatherLead(C, nodes, tC) {
    let sell = null, craft = null, minutes = 0;
    for (const f of nodes) {
      minutes += f.minutes;
      if (isFinite(f.sellHour) && (!sell || f.sellHour > sell.sellHour)) sell = f;
      if (isFinite(f.craftHour) && (!craft || f.craftHour > craft.craftHour)) craft = f;
    }
    const buy = bestBuyCraft(C), buyHour = buy && tC ? buy.buy.profit * 60 / tC : NaN;
    const crafted = craft && craft.plan.steps.length;
    const stat = (label, v, sub) => '<div><dt>' + label + '</dt><dd class="' + tone(v) + '">' + (isFinite(v) ? sk(v) : '—') + '</dd><dd class="sub">' + sub + '</dd></div>';
    const stats = '<dl class="lead-stats">' +
      stat('Gather and sell', sell ? sell.sellHour : NaN, sell ? nameHTML(sell.key) : 'Log a session') +
      stat('Gather and craft', crafted ? craft.craftHour : NaN, crafted ? nameHTML(craft.key) : !tC ? 'Enter minutes per craft' : craft ? 'Selling pays more' : 'Log a session') +
      stat('Buy and craft', buyHour, !buy ? 'No craft has all its prices' : tC ? nameHTML(buy.r.output) : 'Enter minutes per craft') +
      '<div><dt>Time logged</dt><dd>' + durTxt(minutes) + '</dd><dd class="sub">' + plural(myRuns().length, 'session') + '</dd></div></dl>';
    const opts = [];
    if (sell) opts.push({ v: sell.sellHour, route: 'Gather and sell', id: sell.key, how: 'gather ' + esc(sell.name) + ' and sell everything' });
    if (crafted) opts.push({ v: craft.craftHour, route: 'Gather and craft', id: craft.key, how: 'gather ' + esc(craft.name) + ' and craft ' + esc(itemName(craft.plan.steps[0].c.row.r.output)) + (craft.plan.steps.length > 1 ? ' and more' : '') });
    if (isFinite(buyHour)) opts.push({ v: buyHour, route: 'Buy and craft', id: buy.r.output, how: sk(buy.buy.profit) + ' a craft at ' + qfmt(tC) + ' min each, with ' + compact(outcomesOf(buy.buy).stake) + ' Kina of materials on the line' });
    opts.sort((a, b) => b.v - a.v);
    const w = opts[0];
    if (!w || (!sell && !crafted)) {
      return '<section class="lead"><div class="lead-main"><span class="eyebrow">Gathering</span><h2 class="lead-name">What’s an hour of gathering worth?</h2>' +
        '<p class="help">Open a node below, gather it for a while, and log how long it took and how many of each grade you got. This tab then compares gathering and selling, gathering and crafting, and buying the materials to craft.</p></div>' + stats + '</section>';
    }
    const next = opts[1];
    return '<section class="lead"><div class="lead-main"><span class="eyebrow">' + (w.v > 0 ? 'Best use of an hour' : 'Nothing here turns a profit') + ' · ' + w.route + '</span>' +
      '<h2 class="lead-name">' + nameHTML(w.id) + '</h2>' +
      '<div class="lead-figs"><span class="big ' + tone(w.v) + '">' + sk(w.v) + '</span><span>Kina per hour</span><span class="sep">|</span><span>' + w.how + '</span></div>' +
      (next ? '<p class="help">' + sk(w.v - next.v) + ' an hour more than ' + next.route.toLowerCase() + '.</p>' : '') + '</div>' + stats + '</section>';
  }
  // Your tracked crafting's average time per craft, offered for the minutes per craft.
  function trackedCraftHint(tC) {
    let sec = 0, n = 0;
    for (const c of myCrafts()) if (c.spc > 0) { sec += c.spc * c.x; n += c.x; }
    if (!n) return '';
    const min = sec / n / 60;
    return '<span class="help">Tracked: ' + NF1.format(sec / n) + ' s a craft' + (tC && Math.abs(tC - min) < 0.005 ? '' : ' <button class="linkbtn" data-act="craft-use" data-v="' + min.toFixed(3) + '">Use it</button>') + '</span>';
  }
  function gatherView() {
    const C = buildCalc(), nodes = gatherCalc(C), tC = myCraftMin();
    const mine = nodes.filter(f => f.runs.length || f.grades.some(g => isGathered(g.it)));
    const show = UI.gatherShow === 'all' || UI.gatherShow === 'mine' ? UI.gatherShow : mine.length ? 'mine' : 'all';
    const q = loose(UI.gatherQ);
    const top = f => Math.max(isFinite(f.sellHour) ? f.sellHour : -Infinity, isFinite(f.craftHour) ? f.craftHour : -Infinity);
    const bestNet = f => Math.max.apply(null, f.grades.map(g => g.net || 0));
    const rows = (show === 'mine' ? mine : nodes).filter(f => !q || f.grades.some(g => loose(g.it.name).indexOf(q) >= 0))
      .sort((a, b) => (top(b) - top(a)) || (bestNet(b) - bestNet(a)) || a.name.localeCompare(b.name));
    const B = myBudget(), levelsSet = Object.keys(myLevels()).length > 0;
    let h = (UI.live.mode !== 'craft' ? liveHTML() : '') + gatherLead(C, nodes, tC);
    h += '<p class="help">Gathering depends on things this page can’t know: how fast nodes respawn, other players taking them, failed extractions, double harvests and tier-ups. So it uses what you actually get. Open a node, then either track it live from a screen share, or gather for a while and log how long it took and how many of each grade you got. Every session adds to the averages. <strong>Expected</strong> uses this node’s extractions per hour, how often its extractions open at each grade (pooled from everyone in the price book, since that roll is the same for everyone), and your own success, tier-up and double rates from every tracked session of the same kind (ore, gems, Odyle, logs), so one lucky or unlucky Pure or Radiant doesn’t swing the hour; <strong>As gathered</strong> uses exactly what you got. <strong>Leave out breaks</strong> drops tracked gaps of over ' + BREAK_S / 60 + ' minutes without an extraction. ' +
      'Figures are Kina per hour of your time, after ' + feesTxt() + '. <strong>Craft the best</strong> crafts the grades worth more crafted and adds your minutes per craft to the hour. Each craft’s other materials are bought, or counted at their sell price if you gather them too. It assumes the market buys everything at today’s price.' +
      (levelsSet ? ' Only crafts your levels allow are counted' + (B ? ', and only ones your ' + compact(B) + ' budget covers.' : '.') : B ? ' Only crafts your ' + compact(B) + ' budget covers are counted.' : ' Set a budget on Rankings to count only crafts you can afford.') +
      (S.uid ? ' Your sessions and minutes per craft are yours alone.' : '') + '</p>';
    h += '<div class="filters"><div class="field"><label for="gq">Find a material</label><input id="gq" class="in" type="search" value="' + esc(UI.gatherQ) + '" data-inp="gq" placeholder="e.g. Odyle, Ore, Sapphire" autocomplete="off"></div>' +
      '<div class="field narrow"><label for="g-craft">My minutes per craft</label><input id="g-craft" class="in num" inputmode="decimal" value="' + (tC ? esc(NF2.format(tC)) : '') + '" data-chg="g-craft" placeholder="e.g. 2" autocomplete="off">' + trackedCraftHint(tC) + '</div>' +
      '<div class="seg" role="group" aria-label="Which nodes"><button data-act="g-show" data-v="mine" aria-pressed="' + (show === 'mine') + '">I gather</button><button data-act="g-show" data-v="all" aria-pressed="' + (show === 'all') + '">All gathering nodes</button></div>' +
      '<div class="seg" role="group" aria-label="Grades per hour"><button data-act="g-odds" data-v="exp" aria-pressed="' + (UI.gatherOdds !== 'raw') + '" title="Your odds from every tracked session of the same kind of node">Expected</button><button data-act="g-odds" data-v="raw" aria-pressed="' + (UI.gatherOdds === 'raw') + '" title="What your sessions here actually got">As gathered</button></div>' +
      '<label class="check"><input type="checkbox" id="g-breaks" data-chg="g-breaks"' + (UI.gatherNoBreaks ? ' checked' : '') + '> Leave out breaks</label>' +
      '<button class="btn primary" data-act="live-start"' + (!liveSupported() || UI.live.state !== 'off' ? ' disabled' : '') + ' title="' + (liveSupported() ? 'Counts every node you gather from a screen share' : 'Needs Edge or Chrome on a computer') + '">Track live</button></div>';
    if (show === 'all') h += '<p class="help">' + (GATHERABLE ? 'Every gathering node whose materials a recipe uses (the wiki’s Gatherable Materials), with the grades of one material together. Drops like Raw Leather aren’t listed. Tick the ones you gather.'
      : 'Every material a recipe uses that no recipe makes, with the grades of one material together. Some are drops rather than gathered, so tick the ones you gather.') + '</p>';
    if (!rows.length) {
      return h + everyoneHTML(nodes) + '<section class="empty"><h2 class="sec-h">' + (q ? 'No materials match' : show === 'mine' ? 'You don’t gather anything yet' : 'No raw materials yet') + '</h2><p>' +
        (q ? 'Clear the search to see every material.' : show === 'mine' ? 'Switch to <strong>All gathering nodes</strong> and tick what you gather, or open one to log a session or track it live.' : 'Raw materials show up here once a recipe uses them.') + '</p></section>';
    }
    h += '<div class="well"><table class="grid gath"><thead><tr><th scope="col">Node</th><th class="num" scope="col">Time logged</th><th class="num" scope="col">You get per hour</th>' +
      '<th class="num" scope="col">Sell it all</th><th class="num" scope="col">Craft the best</th></tr></thead><tbody>';
    for (const f of rows) {
      const key = esc(f.key), open = UI.gOpen === f.key;
      const tags = [];
      if (f.grades.some(g => priceInfo(g.it).doubtful)) tags.push(['warn', 'Ignoring a doubtful price']);
      if (f.unpriced.length) tags.push(['warn', plural(f.unpriced.length, 'grade') + ' without a price']);
      if (f.plan) tags.push(f.plan.steps.length ? ['craft', 'Craft some'] : ['gather', 'Sell it all']);
      const perH = f.grades.reduce((s, g) => s + (isFinite(g.perHour) ? g.perHour : 0), 0);
      const mix = perH && f.grades.length > 1 ? f.grades.filter(g => g.perHour > 0).map(g => nodeGrade(g.it.name) + ' ' + pct(g.perHour / perH, g.perHour / perH < 0.01 ? 1 : 0)).join(' · ') : '';
      h += '<tr class="row' + (open ? ' open' : '') + '">' +
        '<td class="c-name"><div class="gname"><input type="checkbox" class="check" data-chg="gather-node" data-ids="' + esc(f.ids.join(' ')) + '"' + (f.grades.some(g => isGathered(g.it)) ? ' checked' : '') +
          ' aria-label="I gather ' + esc(f.name) + '" title="I gather this myself">' +
        '<button class="rname" data-act="g-open" data-id="' + key + '" aria-expanded="' + open + '" aria-controls="gd-' + key + '">' + nameHTML(f.key) + '</button></div>' +
        '<div class="rmeta"><span>' + (f.grades.length > 1 ? esc(f.grades.map(g => nodeGrade(g.it.name)).join(', ')) : 'One grade') + '</span>' + tagList(tags) + '</div></td>' +
        '<td class="num" data-label="Time logged"><div class="v">' + (f.minutes ? durTxt(f.minutes) : '—') + '</div><div class="sub">' + (f.runs.length ? plural(f.runs.length, 'session') : 'open it to log one') + '</div></td>' +
        '<td class="num" data-label="You get per hour"><div class="v">' + (f.minutes ? qfmt(perH) + ' items' : '—') + '</div><div class="sub">' + esc(mix) + (f.expected ? ' · expected' : '') + '</div></td>' +
        '<td class="num" data-label="Sell it all"><div class="v ' + tone(f.sellHour) + '">' + (isFinite(f.sellHour) ? sk(f.sellHour) : '—') + '</div><div class="sub">' + (isFinite(f.sellHour) ? 'Kina per hour' : 'log a session') + '</div></td>' +
        '<td class="num" data-label="Craft the best"><div class="v ' + tone(f.plan && f.plan.steps.length ? f.craftHour : NaN) + '">' + (f.plan && f.plan.steps.length ? sk(f.craftHour) : '—') + '</div><div class="sub">' +
          (f.plan ? (f.plan.steps.length ? 'Kina per hour' : 'selling pays more') : !f.minutes ? 'log a session' : 'enter minutes per craft') + '</div></td></tr>';
      if (open) h += '<tr class="detail" id="gd-' + key + '"><td colspan="5">' + nodeDetail(f, tC) + '</td></tr>';
    }
    return h + '</tbody></table></div>' + everyoneHTML(nodes);
  }
  // Everyone in the price book who gathers, node by node: time, success by the grade extractions opened
  // at, doubles, tier-ups, time per extraction, and what an hour of their logged time sells for today.
  function evHour(f, a) {
    const hrs = a.m / 60;
    if (!(hrs > 0)) return { items: NaN, kina: NaN, mix: '' };
    let items = 0, kina = 0, priced = true;
    for (const g of f.grades) { const n = a.n[g.id] || 0; items += n; if (n) { if (g.net == null) priced = false; else kina += n * g.net; } }
    const mix = f.grades.length > 1 && items ? f.grades.filter(g => a.n[g.id]).map(g => nodeGrade(g.it.name) + ' ' + pct(a.n[g.id] / items, a.n[g.id] / items < 0.01 ? 1 : 0)).join(' · ') : '';
    return { items: items / hrs, kina: priced ? kina / hrs : NaN, mix: mix };
  }
  function everyoneHTML(nodes) {
    if (S.mode !== 'db' || !S.uid) return '';
    const all = communityStats(), byKey = new Map(nodes.map(f => [f.key, f])), me = S.pool.get(S.uid);
    const rows = [...all.entries()].filter(([key]) => byKey.has(key)).sort((p, q) => q[1].m - p[1].m || q[1].x - p[1].x);
    const people = new Set();
    for (const [uid, p] of S.pool) if (Object.values(p.st || {}).some(o => o.m > 0 || o.x > 0)) people.add(uid);
    if (Object.keys(myPoolStats()).length) people.add(S.uid);
    let h = '<section class="panel"><div class="toolbar"><h2 class="sec-h">Everyone’s gathering</h2><span class="help">' + (people.size ? (people.size === 1 ? '1 person' : NF0.format(people.size) + ' people') + ' so far' : '') + '</span></div>' +
      '<p class="help">Totals from everyone in the price book who gathers, with no names: time logged, what they got, and from tracked sessions how often extractions succeed (by the grade they opened at), double and tier up. Success depends on each person’s gathering level and skills, so this is the group’s average; yours is in each node above. Kina per hour is their logged time at today’s prices, after ' + feesTxt() + '.</p>' +
      '<label class="check"><input type="checkbox" data-chg="pool-share"' + (me && me.private ? '' : ' checked') + '> Share my gathering totals with the group</label>';
    // What the pool holds from the others, so it's clear why someone's missing.
    let totals = 0, counts = 0, off = 0;
    for (const [uid, p] of S.pool) {
      if (uid === S.uid) continue;
      if (p.private) off++;
      else if (Object.values(p.st || {}).some(o => o.m > 0 || o.x > 0)) totals++;
      else if (Object.values(p.nodes || {}).some(c => c.some(v => v))) counts++;
    }
    if (S.poolRefused) h += '<p class="note loss">Firestore turned down sharing totals: it still has the older rules. ' + (canManage() ? 'Publish the new <strong>firestore.rules</strong> in the Firebase console (Firestore, then Rules), then reload this page. Everyone else’s totals come in as they reload theirs.' : 'Let the owner know the price book’s rules need updating. Reload this page once they have.') + '</p>';
    if (totals + counts + off) h += '<p class="help"><strong>Other members:</strong> ' + [totals ? totals + ' sharing totals' : '', counts ? counts + ' sending only how often nodes open' : '', off ? off + ' with sharing off' : ''].filter(Boolean).join(' · ') + '.' +
      (counts ? ' Only how often nodes open comes from a page opened before this version, or before the rules were updated. Reloading the page fixes it.' : '') + '</p>';
    if (!rows.length) return h + '<p class="help">Nothing shared yet. Totals appear as members open this version of the page.</p></section>';
    h += '<div class="well"><table class="grid gath ev"><thead><tr><th scope="col">Node</th><th class="num" scope="col">Time</th><th class="num" scope="col">Succeeded</th>' +
      '<th class="num" scope="col">Doubled · tiered up</th><th class="num" scope="col">Per extraction</th><th class="num" scope="col">Items per hour</th><th class="num" scope="col">Sell it all</th></tr></thead><tbody>';
    for (const [key, a] of rows) {
      const f = byKey.get(key), hr = evHour(f, a), timed = a.act + a.mov + a.brk;
      h += '<tr class="row"><td class="c-name"><div class="gname">' + nameHTML(f.key) + '</div></td>' +
        '<td class="num" data-label="Time"><div class="v">' + durTxt(a.m) + '</div><div class="sub">' + (a.people === 1 ? '1 person' : NF0.format(a.people) + ' people') + ' · ' + (a.x ? plural(a.x, 'tracked extraction') : 'logged only') + '</div></td>' +
        '<td class="num" data-label="Succeeded"><div class="v">' + (a.x ? pct(a.ok / a.x, 0) : '—') + '</div><div class="sub">' + esc(openShort(a.g)) + '</div></td>' +
        '<td class="num" data-label="Doubled · tiered up"><div class="v">' + (a.ok ? pct(a.d / a.ok, 0) + ' · ' + pct(a.u / a.ok, 0) : '—') + '</div><div class="sub">' + (a.ok ? 'of successes' : '') + '</div></td>' +
        '<td class="num" data-label="Per extraction"><div class="v">' + (a.x ? NF1.format(a.sec / a.x) + ' s' : '—') + '</div><div class="sub">' + (timed ? pct(a.act / timed, 0) + ' of time active' : '') + '</div></td>' +
        '<td class="num" data-label="Items per hour"><div class="v">' + (isFinite(hr.items) ? qfmt(hr.items) : '—') + '</div><div class="sub">' + esc(hr.mix) + '</div></td>' +
        '<td class="num" data-label="Sell it all"><div class="v ' + tone(hr.kina) + '">' + sk(hr.kina) + '</div><div class="sub">' + (isFinite(hr.kina) ? 'Kina per hour' : 'a grade has no price') + '</div></td></tr>';
    }
    return h + '</tbody></table></div></section>';
  }
  // Where the expected rates come from, and how this node's tracked luck compares with them.
  function oddsNote(f) {
    if (!f.track || !f.track.x) return '';
    const kind = f.kind === 'Gemstone' ? 'gem' : f.kind === 'Other' ? 'other' : f.kind.toLowerCase(), all = gatherOdds()[f.kind];
    if (!f.odds) return '<p class="note">Expected rates start once ' + ODDS_MIN + ' extractions of ' + kind + ' nodes are tracked (' + (all ? all.x : 0) + ' so far). Until then this shows what you got.</p>';
    const tracked = f.runs.filter(r => r.st), luck = f.grades.map(g => {
      const got = tracked.reduce((s, r) => s + (r.n[g.id] || 0), 0), exp = f.expect[g.id] || 0;
      return got || exp >= 0.05 ? nodeGrade(g.it.name) + ' ' + NF0.format(got) + ' (expected ' + NF1.format(exp) + ')' : null;
    }).filter(Boolean);
    const op = f.open, opened = op ? OPEN_GRADES.map((g, i) => op.c[i] ? g + ' ' + pct(op.c[i] / op.n, op.c[i] / op.n < 0.01 ? 2 : 1) : null).filter(Boolean).join(', ') : '';
    const source = op ? 'Opening grades from ' + plural(op.n, 'extraction') + (op.scope === 'node' ? ' here' : ' of every ' + kind + ' node') +
        (op.people > 1 ? ' by ' + op.people + ' people in the price book' : '') + ' (' + opened + '). Success, tier-ups and doubles from your own ' + plural(f.odds.x, 'tracked ' + kind + ' extraction') + '. '
      : 'Odds from your ' + plural(f.odds.x, 'tracked ' + kind + ' extraction') + ' on ' + plural(f.odds.nodes.size, 'node') + '. ';
    return '<p class="note">' + (f.expected ? '<strong>Expected</strong> is ' + NF1.format(f.xHour) + ' extractions an hour here. ' + source
      : 'Showing what you got. <strong>Expected</strong> would use these odds. ' + source) +
      '<strong>Your luck here</strong> over ' + plural(f.track.x, 'tracked extraction') + ': ' + luck.join(' · ') + '.</p>';
  }
  function nodeDetail(f, tC) {
    const key = esc(f.key), name = esc(f.name), multi = f.grades.length > 1;
    const label = g => multi ? nodeGrade(g.it.name) : g.it.name;
    const d = UI.runDraft && UI.runDraft.f === f.key ? UI.runDraft : { m: '', n: {} };
    const log = '<div class="dcard"><h4>Log a session</h4><p class="help">Gather ' + name + ' for a while, then enter how long it took and how many ' + (multi ? 'of each grade ' : '') + 'you got. Failed extractions, contested nodes, travel, double harvests and tier-ups are all in that count.</p>' +
      '<div class="runform"><div class="field"><label for="rm-' + key + '">Time spent</label><input id="rm-' + key + '" class="in num" data-inp="run" data-f="' + key + '" data-k="m" value="' + esc(d.m) + '" placeholder="25 or 1h 10m" autocomplete="off"></div>' +
      f.grades.map((g, i) => '<div class="field"><label for="rn-' + key + '-' + i + '">' + nameHTML(g.id) + '</label><input id="rn-' + key + '-' + i + '" class="in num" inputmode="numeric" data-inp="run" data-f="' + key + '" data-k="' + esc(g.id) + '" value="' + esc(d.n[g.id] || '') + '" placeholder="0" autocomplete="off"></div>').join('') +
      '</div><div class="row-gap"><button class="btn primary" data-act="run-add" data-f="' + key + '" data-ids="' + esc(f.ids.join(' ')) + '">Add session</button>' +
      '<button class="btn" data-act="live-start" data-f="' + key + '"' + (!liveSupported() || UI.live.state !== 'off' ? ' disabled' : '') + '>Track live instead</button></div>' +
      '<p class="note">' + (liveSupported() ? '<strong>Track live</strong> shares your screen with this page, which counts each extraction as you gather. Nothing is recorded or sent anywhere.'
        : '<strong>Track live</strong> needs Edge or Chrome on a computer. This browser can’t read a screen share in the background.') + '</p></div>';
    const got = r => f.grades.filter(g => r.n[g.id]).map(g => NF0.format(r.n[g.id]) + ' ' + label(g)).join(', ') || 'nothing';
    const sessions = '<div class="dcard"><h4>Your sessions</h4>' + (f.runs.length
      ? '<div class="mini-well"><table class="mini"><thead><tr><th>When</th><th class="num">Time</th><th>You got</th><th><span class="sr">Delete</span></th></tr></thead><tbody>' +
        f.runs.map(r => '<tr><td>' + esc(r.t ? when(r.t) : '—') + (r.st ? ' <span class="tag gather">Tracked</span>' : '') + '</td><td class="num">' + durTxt(r.m) +
          (r.st && r.st.act != null && r.m ? '<div class="sub">' + pct(Math.min(1, r.st.act / (r.m * 60)), 0) + ' active</div>' : '') + '</td><td>' + esc(got(r)) + '</td>' +
          '<td><button class="btn small ghost" data-act="run-del" data-f="' + key + '" data-t="' + r.t + '" aria-label="Delete the session from ' + esc(r.t ? when(r.t) : 'an unknown date') + '">Delete</button></td></tr>').join('') +
        '</tbody></table></div><p class="note">' + plural(f.got, 'item') + ' in ' + durTxt(f.minutes) + '. When your gathering level or skills go up, delete older sessions so the averages match how you gather now.</p>' +
        (f.track && f.track.x ? '<p class="note"><strong>Tracked sessions:</strong> ' + pct(f.track.ok / f.track.x, 0) + ' of ' + plural(f.track.x, 'extraction') + ' succeeded' +
          (openRatesTxt(f.track.g) ? ' (by the grade they opened at: ' + openRatesTxt(f.track.g) + ')' : '') + '. ' +
          (f.track.ok ? 'Of the successes, ' + pct(f.track.d / f.track.ok, 0) + ' doubled and ' + pct(f.track.u / f.track.ok, 0) + ' tiered up. ' : '') + NF1.format(f.track.sec / f.track.x) + ' s per extraction.' +
          (f.track.timed ? ' <strong>Active ' + pct(f.track.act / f.track.timed, 0) + '</strong> of tracked time: gathering ' + durTxt(f.track.act / 60) + ', moving between nodes ' + durTxt(f.track.mov / 60) + ', breaks ' + durTxt(f.track.brk / 60) + '.' : '') + '</p>' : '')
      : '<p class="help">None yet. A session of 15 minutes or more gives a steadier average.</p>') + '</div>';
    let hour = '<div class="dcard"><h4>An hour of ' + name + '</h4>';
    if (!f.minutes) hour += '<p class="help">Log a session to see what an hour is worth.</p>';
    hour += '<div class="mini-well"><table class="mini wide"><thead><tr><th>' + (multi ? 'Grade' : 'Material') + '</th><th class="num">' + (f.expected ? 'Expected per hour' : 'Per hour') + '</th><th class="num">You got</th><th class="num">Each, after fees</th><th class="num">Kina per hour</th><th>Best craft for it</th></tr></thead><tbody>' +
      f.grades.map(g => '<tr><td>' + nameHTML(g.id) + '</td><td class="num">' + (f.minutes ? qfmt(g.perHour) : '—') + '</td><td class="num">' + NF0.format(g.got) + '</td><td class="num">' + (g.net != null ? k(g.net) : 'no price') + '</td>' +
        '<td class="num">' + (f.minutes && g.net != null ? sk(g.perHour * g.net) : '—') + '</td>' +
        '<td>' + (g.best ? '<button class="linkbtn" data-act="goto-recipe" data-id="' + esc(g.best.row.r.id) + '">' + nameHTML(g.best.row.r.output) + '</button><div class="sub ' + tone(g.best.gain) + '">' + sk(g.best.gain) + ' a craft over selling the ' + qfmt(g.best.qty) + ' it uses</div>' : '<span class="muted">no priced craft</span>') + '</td></tr>').join('') +
      (f.minutes ? '<tr><td><strong>Sell it all</strong></td><td class="num">' + qfmt(f.grades.reduce((s, g) => s + (isFinite(g.perHour) ? g.perHour : 0), 0)) + '</td><td class="num">' + NF0.format(f.got) + '</td><td></td><td class="num ' + tone(f.sellHour) + '"><strong>' + sk(f.sellHour) + '</strong></td><td></td></tr>' : '') +
      '</tbody></table></div>' + oddsNote(f);
    if (f.plan && f.plan.steps.length) {
      hour += '<p class="note"><strong>Craft the best:</strong> from an hour’s haul, craft ' + f.plan.steps.map(s => qfmt(s.n) + ' × <button class="linkbtn" data-act="goto-recipe" data-id="' + esc(s.c.row.r.id) + '">' + esc(itemName(s.c.row.r.output)) + '</button> from your ' + esc(label(s.g)) + ' (' + sk(s.c.gain) + ' each over selling)').join(', ') +
        ' and sell the rest. At ' + qfmt(tC) + ' min per craft that’s ' + sk(f.plan.kina) + ' Kina in ' + durTxt(f.plan.hours * 60) + ', or ' + sk(f.plan.hour) + ' an hour.</p>';
    } else if (f.plan) hour += '<p class="note">No craft earns more per hour of crafting than selling this haul does, so sell it all.</p>';
    else if (f.minutes) hour += '<p class="note">Enter your minutes per craft above to see whether crafting part of the haul pays more.</p>';
    hour += '</div>';
    return hour + '<div class="ngrid">' + log + sessions + everyoneCard(f) + '</div>';
  }
  // Everyone's totals for this node, next to your own sessions.
  function everyoneCard(f) {
    if (S.mode !== 'db' || !S.uid) return '';
    const a = communityStats().get(f.key);
    if (!a) return '';
    const hr = evHour(f, a);
    return '<div class="dcard"><h4>Everyone in the price book</h4><dl class="kv">' +
      '<dt>People</dt><dd>' + NF0.format(a.people) + '</dd><dt>Time logged</dt><dd>' + durTxt(a.m) + '</dd>' +
      (a.x ? '<dt>Succeeded</dt><dd>' + pct(a.ok / a.x, 0) + ' of ' + plural(a.x, 'extraction') + '</dd>' + (openRatesTxt(Object.fromEntries(OPEN_GRADES.map((g, i) => [g, a.g[i]]))) ? '<dd class="why">By the grade they opened at: ' + esc(openRatesTxt(Object.fromEntries(OPEN_GRADES.map((g, i) => [g, a.g[i]])))) + '.</dd>' : '') +
        (a.ok ? '<dt>Doubled</dt><dd>' + pct(a.d / a.ok, 0) + ' of successes</dd><dt>Tiered up</dt><dd>' + pct(a.u / a.ok, 0) + ' of successes</dd>' : '') +
        '<dt>Per extraction</dt><dd>' + NF1.format(a.sec / a.x) + ' s</dd>' : '') +
      (isFinite(hr.items) ? '<dt>Items per hour</dt><dd>' + qfmt(hr.items) + '</dd>' + (hr.mix ? '<dd class="why">' + esc(hr.mix) + '</dd>' : '') : '') +
      (isFinite(hr.kina) ? '<dt>Sell it all</dt><dd class="' + tone(hr.kina) + '"><strong>' + sk(hr.kina) + '</strong> an hour</dd>' : '') +
      '</dl><p class="note">Totals with no names. Success depends on each person’s level and skills.</p></div>';
  }

  /* ---------- live gathering tracker ---------- */
  // Watches a screen share for the gathering popup. gather-worker.js does the reading, and keeps getting
  // frames while the game covers this page; the page shows the totals and saves them as sessions. Each
  // extraction is matched to a kind of node by its item icon, so a route with several kinds of node is
  // saved as one session per node. The clock runs from the moment the screen is shared.
  // States: off, asking (share prompt), calibrate (find the popup), tracking, finishing, review.
  const LS_BOX = 'kina-ledger:livebox:v1', LS_BOX_CRAFT = 'kina-ledger:livebox-craft:v1';
  const LS_ICONS = 'kina-ledger:itemicons:v1';
  const LIVE_EMPTY = { stream: null, worker: null, ex: [], kinds: [], started: 0, ended: 0, pausedAt: 0, pausedMs: 0, reading: null, snap: null, rough: null, view: null, nodeOf: null, problems: [], count: 0, timer: null, countTimer: null, finTimer: null, save: false,
    firstSeen: 0, firstPaused: 0, fromFirst: false, lastFrameAt: 0, lastPresentAt: 0, trackingSince: 0, size: null, perf: null, limit: 0 };
  const LIVE = Object.assign({}, LIVE_EMPTY);
  function liveSupported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && window.MediaStreamTrackProcessor && window.Worker && window.OffscreenCanvas); }
  // Where the popup sits on your screen, as fractions of the shared screen. Kept in this browser.
  // The crafting popup sits elsewhere on screen, so it has its own.
  function liveBox(mode) {
    try {
      const b = JSON.parse(localStorage.getItem(mode === 'craft' ? LS_BOX_CRAFT : LS_BOX) || 'null');
      return b && ['x', 'y', 'w', 'h'].every(k => typeof b[k] === 'number' && b[k] >= 0 && b[k] <= 1) ? b : null;
    } catch (_) { return null; }
  }
  function saveLiveBox(b, mode) {
    const o = { x: b.x, y: b.y, w: b.w, h: b.h };
    if (b.fw > 0 && b.fh > 0) { o.fw = b.fw; o.fh = b.fh; }
    try { localStorage.setItem(mode === 'craft' ? LS_BOX_CRAFT : LS_BOX, JSON.stringify(o)); } catch (_) {}
  }
  // The gathering timer: minutes of gathering after which tracking stops and saves itself. Remembered in
  // this browser; 0 for none.
  const LS_LIMIT = 'kina-ledger:livelimit:v1';
  function liveLimit() { try { const v = Math.round(+localStorage.getItem(LS_LIMIT)); return v >= 1 && v <= 600 ? v : 0; } catch (_) { return 0; } }
  function saveLiveLimit(v) { try { if (v) localStorage.setItem(LS_LIMIT, String(v)); else localStorage.removeItem(LS_LIMIT); } catch (_) {} }
  // Item icons you've named, and their node. Kept in this browser.
  function knownIcons() {
    try {
      const a = JSON.parse(localStorage.getItem(LS_ICONS) || '[]');
      return Array.isArray(a) ? a.filter(x => x && typeof x.f === 'string' && Array.isArray(x.icon) && x.icon.length === 48) : [];
    } catch (_) { return []; }
  }
  function rememberIcon(f, icon) {
    const list = knownIcons().filter(x => GatherReader.iconDist(x.icon, icon) >= GatherReader.ICON_SAME);
    list.push({ f: f, icon: icon });
    try { localStorage.setItem(LS_ICONS, JSON.stringify(list.slice(-100))); } catch (_) {}
  }
  function iconNode(icon) {
    let best = null, bd = GatherReader.ICON_SAME;
    for (const x of knownIcons()) { const d = GatherReader.iconDist(x.icon, icon); if (d < bd) { bd = d; best = x.f; } }
    return best;
  }
  function iconURL(px) {
    if (!px) return null;
    try {
      const c = document.createElement('canvas');
      c.width = px.w; c.height = px.h;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.data), px.w, px.h), 0, 0);
      return c.toDataURL();
    } catch (_) { return null; }
  }
  // An item the icon matched: the first of its names that's in the game (two items can share an icon).
  function liveItem(names) {
    if (!names || !names.length) return null;
    const its = names.map(n => findItem(n)).filter(Boolean);
    return its.find(it => !reg().unavail.has(it.id)) || its[0] || null;
  }
  // The node an item comes from, as the Gathering tab groups grades.
  function liveNodeOf(it) {
    if (!it) return null;
    if (!LIVE.nodeOf) { LIVE.nodeOf = new Map(); for (const f of gatherCalc(buildCalc())) for (const g of f.grades) LIVE.nodeOf.set(g.id, f.key); }
    return LIVE.nodeOf.get(it.id) || null;
  }
  // The item as read: its name when the icon was sure, else its grade and material, else just the grade.
  function itemTxt(names, grade, material) {
    const it = liveItem(names);
    if (it) return it.name;
    const m = liveItem(material);
    if (m) { const base = m.name.replace(GRADE_RE, '$2'); return grade && grade !== 'Common' ? grade + ' ' + base : base; }
    return grade || 'Unrecognized grade';
  }
  // The kind of node an extraction came from. An icon that matched a known material gives its node
  // outright; otherwise kinds are told apart by the icon itself (against every icon a kind has shown,
  // since the icon changes with grade), and take the node the icon was named as before.
  function kindFor(ex, px) {
    const node = liveNodeOf(liveItem(ex.item || ex.openItem || ex.material));
    const keep = k => { if (ex.icon && k.icons.length < 8 && !k.icons.some(ic => GatherReader.iconDist(ic, ex.icon) < 2)) k.icons.push(ex.icon); if (!k.img) k.img = iconURL(px); return k; };
    if (node) {
      let k = LIVE.kinds.find(x => x.auto && x.f === node);
      if (!k) { k = { id: LIVE.kinds.length, icon: ex.icon, icons: [], img: null, f: node, sure: true, picked: true, auto: true }; LIVE.kinds.push(k); }
      // Earlier extractions of the same icon that couldn't be named (Aria and Azpha look alike until
      // Fresh) join it.
      if (ex.icon) for (const o of LIVE.kinds) {
        if (o === k || o.f || o.picked || !o.icons.some(ic => GatherReader.iconDist(ic, ex.icon) < GatherReader.ICON_SAME)) continue;
        for (const e of LIVE.ex) if (e.kind === o.id) e.kind = k.id;
        for (const ic of o.icons) if (k.icons.length < 8) k.icons.push(ic);
        if (!k.img) k.img = o.img;
        o.icons = [];
      }
      return keep(k);
    }
    let k = ex.icon ? LIVE.kinds.find(x => x.icons.some(ic => GatherReader.iconDist(ic, ex.icon) < GatherReader.ICON_SAME)) : LIVE.kinds[LIVE.kinds.length - 1];
    if (!k) {
      const known = ex.icon ? iconNode(ex.icon) : null;
      k = { id: LIVE.kinds.length, icon: ex.icon, icons: [], img: null, f: known, sure: !!known, picked: false };
      LIVE.kinds.push(k);
    }
    return keep(k);
  }
  // Kinds that finished at least one extraction, with their totals. Tracking started from a node gives that
  // node to the unnamed kind with the most extractions, unless another kind is already that node. It's
  // still shown for you to confirm the first time.
  function liveKinds() {
    const kinds = LIVE.kinds.map(k => ({ k: k, sum: GatherReader.summarize({ extractions: LIVE.ex.filter(e => e.kind === k.id), nodes: [] }, 0) })).filter(x => x.sum.x > 0);
    if (UI.live.f && !kinds.some(x => x.k.f === UI.live.f)) {
      const open = kinds.filter(x => !x.k.f && !x.k.picked).sort((a, b) => b.sum.x - a.sum.x)[0];
      if (open) open.k.f = UI.live.f;
    }
    return kinds;
  }
  function liveName() {
    if (UI.live.mode === 'craft') { const r = getRecipe(UI.live.r); return r ? itemName(r.output) : 'crafting'; }
    return UI.live.f ? itemName(UI.live.f) : 'gathering';
  }
  // mode 'craft' tracks crafting of recipe r instead of gathering.
  async function liveStart(f, mode, r) {
    if (!liveSupported()) { toast('Live tracking needs Edge or Chrome on a computer.'); return; }
    if (UI.live.state !== 'off') return;
    UI.live = { state: 'asking', mode: mode === 'craft' ? 'craft' : 'gather', f: f || null, r: r || null, found: null, locating: false };
    render();
    let stream;
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 8, max: 8 } }, audio: false, selfBrowserSurface: 'exclude' }); }
    catch (_) { liveReset(); toast('Screen sharing was cancelled, so tracking didn’t start.'); render(); return; }
    if (UI.live.state !== 'asking') { for (const t of stream.getTracks()) t.stop(); return; }
    const track = stream.getVideoTracks()[0], worker = new Worker('gather-worker.js');
    const processor = new MediaStreamTrackProcessor({ track: track });
    Object.assign(LIVE, LIVE_EMPTY, { stream: stream, worker: worker, ex: [], kinds: [], problems: [], started: Date.now(), limit: UI.live.mode === 'gather' ? liveLimit() : 0 });
    LIVE.timer = setInterval(liveTick, 1000);
    worker.onmessage = e => liveMsg(e.data);
    // "Stop sharing" in the browser's own bar ends the session too.
    track.addEventListener('ended', () => { if (UI.live.state === 'tracking' || UI.live.state === 'calibrate') liveStop(false); });
    const box = liveBox(UI.live.mode);
    worker.postMessage({ type: 'start', readable: processor.readable, box: box, version: BUILD, mode: UI.live.mode }, [processor.readable]);
    if (box) liveTracking(); else { UI.live.state = 'calibrate'; render(); }
  }
  function liveTracking() {
    UI.live.state = 'tracking';
    LIVE.trackingSince = Date.now();
    render();
  }
  // With a timer, the session runs from the first gather, so setting up doesn't count.
  function liveTimerFrom() {
    if (!LIVE.limit || !LIVE.firstSeen || LIVE.fromFirst) return;
    LIVE.fromFirst = true; LIVE.started = LIVE.firstSeen; LIVE.pausedMs -= LIVE.firstPaused;
  }
  function liveLeft() { return LIVE.limit && LIVE.firstSeen ? LIVE.limit * 60 - liveSecs() : Infinity; }
  function liveClockTxt() {
    if (UI.live.mode === 'gather' && LIVE.limit && UI.live.state === 'tracking') return clockTxt(LIVE.firstSeen ? liveSecs() : 0) + ' / ' + clockTxt(LIVE.limit * 60);
    return clockTxt(liveSecs());
  }
  // What the status line says: the reading, unless the picture has stopped or the popup's been missing.
  function liveStatusTxt() {
    const now = Date.now();
    if (UI.live.state === 'tracking' && !LIVE.pausedAt) {
      if (LIVE.lastFrameAt && now - LIVE.lastFrameAt > 8000) return 'The shared picture stopped updating. If you shared the game’s window, it may be minimized, or the game may not allow window sharing: stop, and share the entire screen instead.';
      const since = LIVE.lastPresentAt || LIVE.trackingSince;
      if (LIVE.lastFrameAt && since && now - since > 120000) return 'No popup for ' + Math.floor((now - since) / 60000) + ' minutes. If the game window moved, use Find the popup again.';
      if (LIVE.limit && !LIVE.firstSeen) return 'Your ' + LIVE.limit + '-minute timer starts at your first gather.';
    }
    return readingTxt(LIVE.reading);
  }
  function perfTxt() {
    const p = LIVE.perf;
    return p && p.fps > 0 ? 'Reading the popup takes ' + NF1.format(p.ms) + ' ms a frame at ' + Math.round(p.fps) + ' frames a second: about ' + Math.max(1, Math.round(p.fps * p.ms / 10)) + '% of one processor core.' : '';
  }
  // A short two-note chime when the timer ends, since you're likely in the game.
  function chime() {
    try {
      const A = window.AudioContext || window.webkitAudioContext;
      if (!A) return;
      const ctx = new A(), now = ctx.currentTime;
      [660, 880].forEach((hz, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain(), t = now + i * 0.25;
        o.frequency.value = hz; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.2, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
        o.start(t); o.stop(t + 0.45);
      });
      setTimeout(() => ctx.close(), 1500);
    } catch (_) {}
  }
  function liveTimeUp() {
    chime();
    toast('Time’s up: ' + plural(LIVE.limit, 'minute') + ' of gathering.');
    liveStop(true);
  }
  // Seconds since the screen was shared, leaving out pauses.
  function liveSecs() {
    if (!LIVE.started) return 0;
    const end = LIVE.ended || Date.now();
    return Math.max(0, (end - LIVE.started - LIVE.pausedMs - (LIVE.pausedAt ? end - LIVE.pausedAt : 0)) / 1000);
  }
  function clockTxt(sec) {
    const s = Math.floor(sec), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, pad = n => String(n).padStart(2, '0');
    return (h ? h + ':' + pad(m) : m) + ':' + pad(s % 60);
  }
  function readingTxt(r) {
    if (!r) return 'Waiting for the first frame…';
    if (!r.present) return 'No gathering popup on screen right now.';
    if (UI.live.mode === 'craft') return 'Crafting: Success ' + pct(r.s, 0) + ' · Fail ' + pct(r.f, 0) + (r.blue ? ' · Splendent craft' : '');
    return 'Gathering: Success ' + pct(r.s, 0) + ' · Fail ' + pct(r.f, 0) + ' · ' + (r.grade || 'grade not recognized') + (r.orb ? ' · ×2' : '');
  }
  function liveTick() {
    const t = document.getElementById('live-elapsed'), s = document.getElementById('live-status'), p = document.getElementById('live-perf');
    if (t) t.textContent = liveClockTxt();
    if (s) s.textContent = liveStatusTxt();
    if (p) p.textContent = perfTxt();
    if (UI.live.state === 'tracking' && !LIVE.pausedAt && liveLeft() <= 0) liveTimeUp();
  }
  function liveMsg(m) {
    if (m.type === 'snapshot') {
      if (LIVE.snap) LIVE.snap.bmp.close();
      LIVE.snap = { bmp: m.bitmap, w: m.w, h: m.h }; LIVE.rough = null; LIVE.view = null; UI.live.found = null;
      render();
    } else if (m.type === 'located') {
      UI.live.locating = false;
      UI.live.found = m.box ? { box: m.box, match: m.match, r: m.reading } : null;
      render();
    } else if (m.type === 'reading') {
      LIVE.reading = m.r; LIVE.perf = m.perf || LIVE.perf; LIVE.lastFrameAt = Date.now();
      if (m.r.present && UI.live.state === 'tracking') {
        LIVE.lastPresentAt = Date.now();
        if (!LIVE.firstSeen) { LIVE.firstSeen = Date.now(); LIVE.firstPaused = LIVE.pausedMs; liveTimerFrom(); }
      }
      liveTick();
    } else if (m.type === 'size') {
      // A box found on a different size of picture (a window shared instead of the screen) is in the wrong
      // place, so find the popup again.
      LIVE.size = { w: m.w, h: m.h };
      const b = liveBox(UI.live.mode);
      if (UI.live.state === 'tracking' && LIVE.worker && b && b.fw && (Math.abs(b.fw - m.w) > 2 || Math.abs(b.fh - m.h) > 2)) {
        LIVE.worker.postMessage({ type: 'box', box: null });
        UI.live.state = 'calibrate'; UI.live.found = null;
        toast('What you shared is a different size from last time (a window instead of the whole screen?), so find the popup once more.');
        render();
      }
    } else if (m.type === 'extraction') {
      if (UI.live.mode !== 'craft') m.ex.kind = kindFor(m.ex, m.icon).id;
      LIVE.ex.push(m.ex);
      if (UI.live.state === 'tracking') scheduleRender();
    } else if (m.type === 'problem') {
      const p = { reasons: m.reasons, ex: m.ex, url: null, send: true, sent: false, byPlayer: !!m.byPlayer };
      LIVE.problems.push(p);
      const fr = new FileReader();
      fr.onload = () => { p.url = fr.result; scheduleRender(); if (p.byPlayer) sendReport(p); };
      fr.readAsDataURL(m.sheet);
    } else if (m.type === 'report-full') {
      toast('That’s five reports this session already. Stop and track again to send more.');
    } else if (m.type === 'ended') liveFinished();
  }
  // Stops sharing. The worker then closes the extraction in progress and says it has ended.
  function liveStop(save) {
    if (!LIVE.stream) { liveReset(); render(); return; }
    LIVE.ended = Date.now(); LIVE.save = save;
    UI.live.state = 'finishing';
    clearInterval(LIVE.timer);
    for (const t of LIVE.stream.getTracks()) t.stop();
    LIVE.finTimer = setTimeout(liveFinished, 2000);
    render();
  }
  // Saves straight away when every kind of node is one you've named before; otherwise asks first.
  function liveFinished() {
    if (UI.live.state !== 'finishing') return;
    clearTimeout(LIVE.finTimer);
    if (LIVE.worker) { LIVE.worker.terminate(); LIVE.worker = null; }
    if (UI.live.mode === 'craft') {
      const cs = GatherReader.craftSummary(GatherReader.crafts(LIVE.ex));
      if (!cs.x && !LIVE.problems.length) { liveReset(); toast('Tracking stopped. No crafting was seen.'); }
      else if (LIVE.save && cs.x && !LIVE.problems.some(p => !p.sent)) { liveSaveCraft(); liveReset(); }
      else UI.live.state = 'review';
      render();
      return;
    }
    const kinds = liveKinds();
    if (!kinds.length && !LIVE.problems.length) { liveReset(); toast('Tracking stopped. No gathering was seen.'); }
    else if (LIVE.save && kinds.every(x => x.k.sure && x.k.f) && !LIVE.problems.some(p => !p.sent)) { liveSave(); liveReset(); }
    else UI.live.state = 'review';
    render();
  }
  // How tracked time was spent, from the gaps between extractions. An extraction, and a short gap before
  // it at the same node, count as gathering; a short gap from another node as moving; a gap over BREAK_S,
  // and the time before the first and after the last extraction, as a break. Each part goes to the group
  // (keyOf) of the extraction after it. Pauses show up as long gaps, so they're taken back out of breaks.
  function timeSplit(list, total, keyOf) {
    const ex = list.slice().sort((a, b) => a.start - b.start), by = new Map();
    const at = k => { if (!by.has(k)) by.set(k, { act: 0, mov: 0, brk: 0 }); return by.get(k); };
    let prev = null, sum = 0;
    for (const e of ex) {
      const p = at(keyOf(e)), len = Math.max(0, e.end - e.start);
      p.act += len; sum += len;
      if (prev) {
        const gap = Math.max(0, e.start - prev.end);
        if (gap > BREAK_S) p.brk += gap; else if (e.node === prev.node && keyOf(e) === keyOf(prev)) p.act += gap; else p.mov += gap;
        sum += gap;
      }
      prev = e;
    }
    const parts = [...by.values()], brk = parts.reduce((s, p) => s + p.brk, 0), busy = parts.reduce((s, p) => s + p.act + p.mov, 0);
    if (sum > total && brk > 0) { const cut = Math.min(brk, sum - total); for (const p of parts) p.brk -= cut * p.brk / brk; }
    const rest = Math.max(0, total - Math.min(sum, total));
    for (const p of parts) p.brk += busy ? rest * (p.act + p.mov) / busy : rest / parts.length;
    return by;
  }
  // Saves one session per node: its items by grade, its share of the time, and the counts behind its rates
  // (by the grade each extraction opened and ended at) and its uptime.
  function liveSave() {
    const secs = liveSecs(), nodes = gatherCalc(buildCalc());
    const ex = LIVE.ex.slice().sort((a, b) => a.start - b.start), kindOf = new Map(LIVE.kinds.map(k => [k.id, k]));
    const nodeOf = e => { const k = kindOf.get(e.kind); return k && k.f && k.f !== '-' ? k.f : '?'; };
    const times = timeSplit(ex, secs, nodeOf), byNode = new Map();
    let lost = 0;
    for (const e of ex) {
      const f = nodeOf(e), k = kindOf.get(e.kind);
      if (f === '?') continue;
      if (!byNode.has(f)) byNode.set(f, { ex: [], icons: [] });
      const b = byNode.get(f);
      b.ex.push(e);
      for (const ic of k.icons && k.icons.length ? k.icons : [k.icon]) if (ic && b.icons.indexOf(ic) < 0) b.icons.push(ic);
    }
    const runs = myRuns().slice(), saved = [], now = Date.now();
    let i = 0;
    for (const [f, b] of byNode) {
      const sum = GatherReader.summarize({ extractions: b.ex, nodes: [] }, 0), tm = times.get(f);
      if (!sum.x) continue;
      // Each success counts toward the item its icon named, or else the node's item of its grade
      // (herbs call their second grade Fresh where the popup says Fine).
      const node = nodes.find(x => x.key === f), n = {};
      for (const e of b.ex) {
        if (e.result !== 'success' || !e.qty) continue;
        const named = liveItem(e.item), mine = named && node && node.grades.find(x => x.id === named.id);
        const it = mine || (node && node.grades.find(x => { const ng = nodeGrade(x.it.name); return ng === e.grade || (ng === 'Fresh' && e.grade === 'Fine'); }));
        if (it) n[it.id] = (n[it.id] || 0) + e.qty; else lost += e.qty;
      }
      const min = Math.min(1440, Math.max(0.1, Math.round((tm.act + tm.mov + tm.brk) / 6) / 10));
      const g = {}, t = Array(16).fill(0);
      for (const k of OPEN_GRADES) if (sum.byOpen[k]) g[k] = [sum.byOpen[k].x, sum.byOpen[k].ok];
      for (const e of b.ex) {
        const o = OPEN_GRADES.indexOf(e.openGrade), h = OPEN_GRADES.indexOf(e.grade);
        if (e.result === 'success' && o >= 0 && h >= 0) t[o * 4 + h]++;
      }
      runs.push({ f: f, m: min, n: n, t: now + i++, st: { x: sum.x, ok: sum.ok, d: sum.d, u: sum.u, sec: Math.round(sum.sec), g: g, t: t, act: Math.round(tm.act), mov: Math.round(tm.mov), brk: Math.round(tm.brk) } });
      for (const icon of b.icons) rememberIcon(f, icon);
      saved.push(durTxt(min) + ' of ' + itemName(f) + ' (' + plural(sum.items, 'item') + ')');
    }
    if (!saved.length) { toast('Nothing was saved.'); return; }
    setRuns(runs);
    toast('Saved ' + saved.join(' and ') + (lost ? '. ' + plural(lost, 'item') + ' of a grade this page didn’t recognize weren’t counted.' : '.'));
  }
  // Normal items made: a landed combo replaces the normal item unless the recipe gives it on top.
  function craftNormal(cs, r) { return r && r.comboAdds ? cs.ok : cs.normal; }
  // Saves tracked crafting as a session on the recipe.
  function liveSaveCraft() {
    const cs = GatherReader.craftSummary(GatherReader.crafts(LIVE.ex)), r = getRecipe(UI.live.r);
    if (!cs.x || !r) { toast('Nothing was saved.'); return; }
    const min = Math.min(1440, Math.max(0.1, Math.round(liveSecs() / 6) / 10));
    setCrafts(myCrafts().concat({ r: r.id, t: Date.now(), m: min, x: cs.x, ok: cs.ok, cp: cs.cp, cok: cs.cok, spc: isFinite(cs.perCraft) ? Math.round(cs.perCraft * 10) / 10 : 0, lv: num(myLevels()[r.profession]) || 0 }));
    toast('Saved ' + plural(cs.x, 'craft') + ' of ' + itemName(r.output) + ': ' + craftNormal(cs, r) + ' normal, ' + cs.splendent + ' Splendent.');
  }
  function liveReset() {
    clearInterval(LIVE.timer); clearInterval(LIVE.countTimer); clearTimeout(LIVE.finTimer);
    if (LIVE.stream) for (const t of LIVE.stream.getTracks()) t.stop();
    if (LIVE.worker) LIVE.worker.terminate();
    if (LIVE.snap) LIVE.snap.bmp.close();
    Object.assign(LIVE, LIVE_EMPTY, { ex: [], kinds: [], problems: [] });
    UI.live = { state: 'off' };
  }
  // A snapshot five seconds from now, so there's time to switch back to the game.
  function liveSnapSoon() {
    if (!LIVE.worker || LIVE.count) return;
    LIVE.count = 5;
    LIVE.countTimer = setInterval(() => {
      LIVE.count--;
      if (LIVE.count <= 0) { clearInterval(LIVE.countTimer); LIVE.count = 0; if (LIVE.worker) LIVE.worker.postMessage({ type: 'snapshot' }); }
      scheduleRender();
    }, 1000);
    render();
  }
  function liveNotice() {
    if (UI.live.state === 'off') return '';
    if (UI.live.mode === 'craft') {
      if (UI.tab === 'rank') return '';
      return '<div class="notice"><span>' + (UI.live.state === 'review' ? 'Your tracked crafting isn’t saved yet.' : 'Tracking crafts of ' + esc(liveName()) + ' live.') + '</span><button class="btn small" data-act="tab" data-tab="rank">Open Rankings</button></div>';
    }
    if (UI.tab === 'gather') return '';
    return '<div class="notice"><span>' + (UI.live.state === 'review' ? 'Your tracked gathering isn’t saved yet.' : 'Tracking ' + esc(liveName()) + ' live.') + '</span><button class="btn small" data-act="tab" data-tab="gather">Open Gathering</button></div>';
  }
  function liveHTML() {
    const st = UI.live.state, name = esc(liveName()), clock = '<span class="live-time" id="live-elapsed">' + liveClockTxt() + '</span>';
    if (st === 'off') return '';
    if (st === 'asking') {
      return '<section class="panel live"><h2 class="sec-h">Track ' + name + ' live</h2><p class="help">In your browser’s sharing window, choose <strong>Window</strong> and pick the game, so only the game is shared and nothing else on your screen is seen. If the snapshot comes out black or the picture freezes, stop and choose <strong>Entire screen</strong> instead. Either way it’s read in this browser only.</p>' +
        '<div class="row-gap"><button class="btn ghost" data-act="live-discard">Cancel</button></div></section>';
    }
    if (st === 'calibrate') {
      const fd = UI.live.found, ok = !!(fd && fd.match >= 0.5 && fd.r && fd.r.present);
      const craft = UI.live.mode === 'craft';
      return '<section class="panel live"><div class="toolbar"><h2 class="sec-h">Show the page where the ' + (craft ? 'crafting' : 'gathering') + ' popup is</h2>' + clock + '</div>' +
        '<ol class="steps"><li>In the game, ' + (craft ? 'start crafting so the crafting popup is showing.' : 'start gathering a node so the gathering popup is showing.') + '</li><li>Click <strong>Snapshot in 5 seconds</strong> and switch back to the game.</li>' +
        '<li>Back here, click the popup on the snapshot to zoom in, then drag a box around it, from ' + (craft ? '“Crafting in Progress”' : '“Professional Lv.”') + ' down to the Fail bar. It doesn’t need to be exact. This is remembered in this browser' + (craft ? ', apart from the gathering popup’s place.' : '.') + '</li></ol>' +
        '<div class="row-gap"><button class="btn primary" data-act="live-snap"' + (LIVE.count ? ' disabled' : '') + '>' + (LIVE.count ? 'Snapshot in ' + LIVE.count + '…' : LIVE.snap ? 'New snapshot in 5 seconds' : 'Snapshot in 5 seconds') + '</button>' +
        (LIVE.view ? '<button class="btn" data-act="live-unzoom">Zoom out</button>' : '') +
        '<button class="btn ghost" data-act="live-discard">Cancel</button></div>' +
        (LIVE.snap && !LIVE.view ? '<p class="help">Click the popup to zoom in.</p>' : '') +
        (LIVE.snap ? '<canvas id="live-snap" class="live-snap" aria-label="Snapshot of your screen. Drag a box around the popup."></canvas>' : '') +
        (UI.live.locating ? '<p class="help">Looking for the popup…</p>' : '') +
        (fd ? (ok ? '<div class="live-found"><canvas id="live-zoom" class="live-zoom" width="380" height="110" aria-hidden="true"></canvas><div class="live-found-txt"><p><strong>Found it.</strong> ' + esc(readingTxt(fd.r)) + '</p>' +
            '<div class="row-gap"><button class="btn primary" data-act="live-use">Use this and start tracking</button></div></div></div>'
          : '<p class="note loss">Couldn’t find the popup in that box. Check that it shows in the snapshot, then drag again or take a new snapshot.</p>') : '') +
        '<p class="note">' + (LIVE.limit ? 'Your ' + LIVE.limit + '-minute timer starts at your first gather.' : 'The clock started when you shared your screen.') + ' What you share is read in this browser only; nothing is recorded or sent anywhere.</p></section>';
    }
    if (UI.live.mode === 'craft') return liveCraftHTML(st, name, clock);
    const kinds = liveKinds(), sum = GatherReader.summarize({ extractions: LIVE.ex, nodes: [] }, liveSecs()), paused = !!LIVE.pausedAt;
    const naming = st === 'review' && kinds.some(x => !x.k.sure || !x.k.f);
    const stat = (l, v) => '<div class="stat"><dt>' + l + '</dt><dd>' + v + '</dd></div>';
    const items = s => Object.keys(s.byGrade).map(g => NF0.format(s.byGrade[g]) + ' ' + esc(g)).join(' · ') || '0 items';
    const icon = k => k.img ? '<img class="kind-icon" src="' + esc(k.img) + '" alt="">' : '<span class="kind-icon"></span>';
    const recent = LIVE.ex.slice(-5).reverse().map(e => '<li>' + (kinds.length > 1 ? esc(kindLabel(LIVE.kinds[e.kind])) + ': ' : '') +
      (e.result === 'success' ? (e.tierUp ? esc(itemTxt(e.openItem, e.openGrade, e.material)) + ' → ' + esc(itemTxt(e.item, e.grade, e.material)) + ' (Appraiser)'
        : esc(itemTxt(e.item, e.grade, e.material)) + (!e.item && !e.grade && e.titleColor ? ', title color ' + e.titleColor : '')) + ' ×' + e.qty
        : e.result === 'fail' ? '<span class="loss">Failed</span>' + (e.openGrade ? ' (' + esc(e.openGrade) + ')' : '') : 'Stopped early') +
      ' · ' + NF1.format(e.end - e.start) + ' s</li>').join('');
    const opened = {};
    for (const k of Object.keys(sum.byOpen)) opened[k] = [sum.byOpen[k].x, sum.byOpen[k].ok];
    const upTotal = liveSecs(), up = LIVE.ex.length && upTotal > 0 ? Object.assign({ total: upTotal }, timeSplit(LIVE.ex, upTotal, () => 1).get(1)) : null;
    const title = st === 'review' ? (naming ? 'Which node was each?' : 'Sharing stopped. Save this session?') : st === 'finishing' ? 'Finishing…' : (paused ? 'Paused: ' : 'Tracking ') + (kinds.length > 1 ? 'a mixed route' : name);
    let h = '<section class="panel live"><div class="toolbar"><h2 class="sec-h">' + title + '</h2>' + clock + '</div>' +
      (st === 'tracking' ? '<p class="live-status" id="live-status">' + esc(liveStatusTxt()) + '</p><p class="help" id="live-perf">' + esc(perfTxt()) + '</p>' : '') +
      '<dl class="statrow">' + stat('Extractions', NF0.format(sum.x)) + stat('Succeeded', sum.x ? pct(sum.ok / sum.x, 0) : '—') + stat('Doubled', sum.ok ? pct(sum.d / sum.ok, 0) : '—') +
      stat('Tiered up', sum.ok ? pct(sum.u / sum.ok, 0) : '—') + stat('Per extraction', sum.x ? NF1.format(sum.sec / sum.x) + ' s' : '—') +
      stat('Active', up ? pct(up.act / up.total, 0) : '—') + stat('Items', items(sum)) + '</dl>' +
      (up ? '<p class="help"><strong>Time:</strong> gathering ' + clockTxt(up.act) + ', moving between nodes ' + clockTxt(up.mov) + ', breaks ' + clockTxt(up.brk) +
        ' (gaps over ' + BREAK_S / 60 + ' minutes, and before the first and after the last extraction).</p>' : '') +
      (openRatesTxt(opened) ? '<p class="help"><strong>Succeeded by the grade each opened at:</strong> ' + esc(openRatesTxt(opened)) + '. Doubled and tiered up are shares of successes.</p>' : '');
    if (st === 'review') {
      const opts = gatherCalc(buildCalc()).map(f => [f.key, f.name]).sort((a, b) => a[1].localeCompare(b[1]));
      h += (naming ? '<p class="help">Pick the node for each item icon. It’s remembered in this browser, so next time these save on their own.</p>' : '') +
        '<ul class="kinds">' + kinds.map(x => '<li>' + icon(x.k) + '<div class="kind-txt"><strong>' + plural(x.sum.x, 'extraction') + '</strong><span class="help">' + items(x.sum) + '</span></div>' +
          '<select class="in" data-chg="live-kind" data-k="' + x.k.id + '" aria-label="Node for this icon"><option value="">Choose a node</option>' +
          opts.map(([key, nm]) => '<option value="' + esc(key) + '"' + (x.k.f === key ? ' selected' : '') + '>' + esc(nm) + '</option>').join('') +
          '<option value="-"' + (x.k.f === '-' ? ' selected' : '') + '>Don’t save these</option></select></li>').join('') + '</ul>';
    } else if (kinds.length) {
      h += '<ul class="kinds">' + kinds.map(x => '<li>' + icon(x.k) + '<div class="kind-txt"><strong>' + esc(kindLabel(x.k)) + '</strong><span class="help">' + plural(x.sum.x, 'extraction') + ' · ' + items(x.sum) + '</span></div></li>').join('') + '</ul>';
    }
    if (recent) h += '<div><span class="lbl">Latest</span><ul class="live-recent">' + recent + '</ul></div>';
    if (st === 'tracking') {
      h += '<div class="row-gap"><button class="btn primary" data-act="live-stop">Stop and save</button><button class="btn" data-act="live-pause">' + (paused ? 'Resume' : 'Pause') + '</button>' +
        '<button class="btn ghost" data-act="live-recal">Find the popup again</button><button class="btn ghost" data-act="live-report">Report a problem</button>' +
        '<button class="btn ghost danger' + (UI.confirm === 'live-discard' ? ' armed' : '') + '" data-act="live-discard">' + (UI.confirm === 'live-discard' ? 'Click again to discard' : 'Discard') + '</button></div>' +
        problemsLine() +
        '<div class="live-limit"><label for="live-limit">Stop after</label><input id="live-limit" class="in num" inputmode="numeric" maxlength="3" value="' + (LIVE.limit || '') + '" placeholder="—" data-chg="live-limit" aria-describedby="live-limit-help"><span>minutes of gathering</span></div>' +
        '<p class="help" id="live-limit-help">The timer starts at your first gather. When it ends, tracking stops and saves by itself, with a chime. It’s remembered in this browser; leave it empty to stop yourself.</p>' +
        '<p class="note">Switch to the game whenever you like: tracking keeps going in the background, and closing this tab stops it. Gathering more than one kind of node? Each is told apart by its item icon and saved to its own node. If something reads wrong, <strong>Report a problem</strong> sends the owner a picture of the last 15 seconds of the popup' + (liveCanSend() ? '' : ' (here it’s kept for you to download when you stop)') + '.</p>';
    } else if (st === 'review') {
      const ready = kinds.every(x => x.k.f), unsent = S.mode === 'db' && LIVE.problems.some(p => p.send && !p.sent);
      h += problemsHTML() +
        '<div class="row-gap"><button class="btn primary' + (UI.confirm === 'live-save' ? ' armed' : '') + '" data-act="live-save"' + (ready ? '' : ' disabled') + '>' + (UI.confirm === 'live-save' && unsent ? 'Click again to save without sending' : 'Save') + '</button>' +
        '<button class="btn ghost danger' + (UI.confirm === 'live-discard' ? ' armed' : '') + '" data-act="live-discard">' + (UI.confirm === 'live-discard' ? 'Click again to discard' : 'Discard') + '</button>' +
        (ready ? '' : '<span class="help">Choose a node for each icon first.</span>') + '</div>';
    }
    return h + '</section>';
  }
  // Live crafting: each craft of a batch counts on its own, and a combo's Splendent craft counts with the
  // craft it came from.
  function liveCraftHTML(st, name, clock) {
    const items = GatherReader.crafts(LIVE.ex), cs = GatherReader.craftSummary(items), paused = !!LIVE.pausedAt;
    const stat = (l, v) => '<div class="stat"><dt>' + l + '</dt><dd>' + v + '</dd></div>';
    const recent = items.slice(-5).reverse().map(c => '<li>' + (c.result === 'success' ? 'Success' + (c.combo === 'success' ? ' · combo → <strong>Splendent</strong>' : c.combo === 'fail' ? ' · combo failed, kept the normal one' : '')
      : c.result === 'fail' ? '<span class="loss">Failed</span>' : 'Stopped early') + '</li>').join('');
    let h = '<section class="panel live"><div class="toolbar"><h2 class="sec-h">' + (st === 'review' ? 'Sharing stopped. Save these crafts?' : st === 'finishing' ? 'Finishing…' : (paused ? 'Paused: ' : 'Tracking crafts of ') + name) + '</h2>' + clock + '</div>' +
      (st === 'tracking' ? '<p class="live-status" id="live-status">' + esc(liveStatusTxt()) + '</p><p class="help" id="live-perf">' + esc(perfTxt()) + '</p>' : '') +
      '<dl class="statrow">' + stat('Crafts', NF0.format(cs.x)) + stat('Succeeded', cs.x ? pct(cs.ok / cs.x, 0) : '—') + stat('Combos', cs.ok ? cs.cp + ' (' + pct(cs.cp / cs.ok, 0) + ')' : '—') +
      stat('Combo landed', cs.cp ? cs.cok + ' of ' + cs.cp : '—') + stat('Per craft', isFinite(cs.perCraft) ? NF1.format(cs.perCraft) + ' s' : '—') + stat('Made', craftNormal(cs, getRecipe(UI.live.r)) + ' normal · ' + cs.splendent + ' Splendent') + '</dl>' +
      (recent ? '<div><span class="lbl">Latest</span><ul class="live-recent">' + recent + '</ul></div>' : '');
    if (st === 'tracking') {
      h += '<div class="row-gap"><button class="btn primary" data-act="live-stop">Stop and save</button><button class="btn" data-act="live-pause">' + (paused ? 'Resume' : 'Pause') + '</button>' +
        '<button class="btn ghost" data-act="live-recal">Find the popup again</button><button class="btn ghost" data-act="live-report">Report a problem</button>' +
        '<button class="btn ghost danger' + (UI.confirm === 'live-discard' ? ' armed' : '') + '" data-act="live-discard">' + (UI.confirm === 'live-discard' ? 'Click again to discard' : 'Discard') + '</button></div>' +
        problemsLine() +
        '<p class="note">Crafts in a batch each count on their own, and a combo’s Splendent craft counts with the craft it came from. Only crafts of ' + name + ' are counted, so stop before crafting something else.</p>';
    } else if (st === 'review') {
      const unsent = S.mode === 'db' && LIVE.problems.some(p => p.send && !p.sent);
      h += problemsHTML() + '<div class="row-gap"><button class="btn primary' + (UI.confirm === 'live-save' ? ' armed' : '') + '" data-act="live-save"' + (cs.x ? '' : ' disabled') + '>' + (UI.confirm === 'live-save' && unsent ? 'Click again to save without sending' : 'Save') + '</button>' +
        '<button class="btn ghost danger' + (UI.confirm === 'live-discard' ? ' armed' : '') + '" data-act="live-discard">' + (UI.confirm === 'live-discard' ? 'Click again to discard' : 'Discard') + '</button></div>';
    }
    return h + '</section>';
  }
  function liveCanSend() { return S.mode === 'db' && !!S.email && !!DB; }
  // Sends problem pictures to the owner. Each counts as sent once the database has it; a refused one stays
  // ticked, to send again or download. Resolves to how many were sent, how many were too large, and the
  // first error.
  async function sendProblems(list) {
    const go = list.filter(p => p.url && !p.sent && !p.sending && p.url.length <= 990000), big = list.filter(p => p.url && p.url.length > 990000).length;
    for (const p of go) p.sending = true;
    scheduleRender();
    const errs = await Promise.all(go.map(p => new Promise(res => res(DB.doc('reports/' + uid('rp')).set({ by: S.email, at: Date.now(), version: BUILD, reasons: p.reasons.join(', ').slice(0, 300),
      note: String(UI.live.note || '').slice(0, 1000), ex: JSON.stringify(p.ex || {}).slice(0, 4000), sheet: p.url })))
      .then(() => { p.sent = true; return null; }, e => e || new Error('refused')).then(e => { p.sending = false; return e; })));
    const failed = errs.filter(Boolean);
    scheduleRender();
    return { sent: go.length - failed.length, big: big, err: failed[0] || null };
  }
  // A report the player asked for goes to the owner as soon as its picture is ready.
  async function sendReport(p) {
    if (!liveCanSend()) return;
    const r = await sendProblems([p]);
    if (r.err) writeFailed(r.err, 'reports/');
    else if (r.big) toast('That picture is too large to send. Download it when you stop.');
    else if (r.sent) toast('Sent a picture of the last 15 seconds to the owner. Thanks!');
  }
  // What's happened to the pictures so far, for the tracking panels.
  function problemsLine() {
    const mine = LIVE.problems.filter(p => p.byPlayer), auto = LIVE.problems.length - mine.length, out = [];
    if (mine.length) {
      const sent = mine.filter(p => p.sent).length, going = mine.filter(p => !p.sent && (p.sending || !p.url)).length, stuck = mine.length - sent - going;
      if (!liveCanSend()) out.push(plural(mine.length, 'report') + ' kept as pictures. Download them when you stop, and send them to the owner.');
      else {
        if (sent) out.push(plural(sent, 'report') + ' sent to the owner.');
        if (going) out.push('Sending ' + (going === 1 ? 'a report' : going + ' reports') + '…');
        if (stuck) out.push((stuck === 1 ? 'A report' : stuck + ' reports') + ' didn’t send. You can send or download ' + (stuck === 1 ? 'it' : 'them') + ' when you stop.');
      }
    }
    if (auto) out.push(plural(auto, 'odd moment') + ' saved as pictures of the popup. You can send them when you stop.');
    return out.length ? '<p class="help">' + out.join(' ') + '</p>' : '';
  }
  // Pictures of odd moments, to send to the owner (or download) so misreads can be fixed.
  function problemsHTML() {
    const list = LIVE.problems, shared = S.mode === 'db';
    if (!list.length) return '';
    return '<div class="probs"><span class="lbl">Problem pictures</span><p class="help">' + plural(list.length, 'picture') + ' of the popup from moments worth a second look. Each shows the frames and what the tracker read on them. ' +
      (shared ? 'Sending them to the owner helps fix the tracker.' : 'Download them and send them to the owner to help fix the tracker.') + ' Only the popup’s part of your screen is in them, so if another window covered the game there, it shows too.</p><ul class="prob-list">' +
      list.map((p, i) => '<li><label class="check"><input type="checkbox" data-chg="live-prob" data-i="' + i + '"' + (p.send ? ' checked' : '') + (p.sent || p.sending || !shared ? ' disabled' : '') + '> ' + esc(p.reasons.join(', ')) + '</label>' +
        (p.sent ? ' <span class="tag gather">Sent</span>' : p.sending ? ' <span class="help">Sending…</span>' : '') +
        (p.url ? '<details><summary>Show the picture</summary><img class="prob-img" src="' + esc(p.url) + '" alt="Popup frames for: ' + esc(p.reasons.join(', ')) + '"></details><a class="btn small" href="' + esc(p.url) + '" download="kina-tracker-' + (i + 1) + '.jpg">Download</a>'
          : '<span class="help">Preparing…</span>') + '</li>').join('') + '</ul>' +
      (shared ? '<div class="field"><label for="live-note">Anything to add? (optional)</label><textarea id="live-note" class="in" rows="2" maxlength="1000" data-inp="live-note" placeholder="e.g. it was a Radiant but said Fine">' + esc(UI.live.note || '') + '</textarea></div>' +
        '<div class="row-gap"><button class="btn" data-act="live-send"' + (list.some(p => p.sending) ? ' disabled' : '') + '>Send the ticked pictures to the owner</button></div>' : '') + '</div>';
  }
  function kindLabel(k) { return !k ? '' : k.f && k.f !== '-' ? itemName(k.f) : k.f === '-' ? 'Not saved' : 'New node, named when you stop'; }
  // The snapshot, or the part of it you zoomed into, with the box you're drawing (gold) and the popup it
  // found (green), plus a close-up.
  function drawLive() {
    const s = LIVE.snap, cv = document.getElementById('live-snap');
    if (!s || !cv) return;
    const v = LIVE.view || { x: 0, y: 0, w: s.w, h: s.h };
    const w = Math.min(v.w, 1800), h = Math.round(v.h * w / v.w);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const c = cv.getContext('2d'), k = cv.width / v.w, css = getComputedStyle(document.documentElement);
    const lw = cv.clientWidth ? 2 * cv.width / cv.clientWidth : 2;
    c.drawImage(s.bmp, v.x, v.y, v.w, v.h, 0, 0, cv.width, cv.height);
    if (LIVE.rough) {
      c.setLineDash([3 * lw, 2 * lw]); c.lineWidth = lw; c.strokeStyle = css.getPropertyValue('--gold').trim() || '#c89b3c';
      c.strokeRect((LIVE.rough.x - v.x) * k, (LIVE.rough.y - v.y) * k, LIVE.rough.w * k, LIVE.rough.h * k);
    }
    const fd = UI.live.found;
    if (fd && fd.box) {
      c.setLineDash([]); c.lineWidth = lw; c.strokeStyle = css.getPropertyValue('--gain').trim() || '#2e9e4f';
      c.strokeRect((fd.box.x * s.w - v.x) * k, (fd.box.y * s.h - v.y) * k, fd.box.w * s.w * k, fd.box.h * s.h * k);
      const z = document.getElementById('live-zoom');
      if (z) z.getContext('2d').drawImage(s.bmp, fd.box.x * s.w, fd.box.y * s.h, fd.box.w * s.w, fd.box.h * s.h, 0, 0, z.width, z.height);
    }
  }
  // Drawing the rough box on the snapshot. A click without a drag zooms in around that spot, since the
  // popup is small on a wide screen.
  let liveDrag = null;
  function snapPoint(cv, e) {
    const r = cv.getBoundingClientRect(), v = LIVE.view || { x: 0, y: 0, w: LIVE.snap.w, h: LIVE.snap.h };
    return { x: v.x + (e.clientX - r.left) / r.width * v.w, y: v.y + (e.clientY - r.top) / r.height * v.h };
  }
  function liveZoom(p) {
    const s = LIVE.snap, w = Math.min(s.w, Math.max(480, Math.round(s.w * 0.28))), h = Math.min(s.h, Math.round(w / 2));
    LIVE.view = { x: Math.max(0, Math.min(s.w - w, Math.round(p.x - w / 2))), y: Math.max(0, Math.min(s.h - h, Math.round(p.y - h / 2))), w: w, h: h };
  }
  document.addEventListener('pointerdown', e => {
    if (!e.target || e.target.id !== 'live-snap' || !LIVE.snap) return;
    e.preventDefault();
    e.target.setPointerCapture(e.pointerId);
    liveDrag = snapPoint(e.target, e);
    LIVE.rough = { x: liveDrag.x, y: liveDrag.y, w: 0, h: 0 }; UI.live.found = null;
    drawLive();
  });
  document.addEventListener('pointermove', e => {
    if (!liveDrag || !e.target || e.target.id !== 'live-snap') return;
    const p = snapPoint(e.target, e);
    LIVE.rough = { x: Math.min(liveDrag.x, p.x), y: Math.min(liveDrag.y, p.y), w: Math.abs(p.x - liveDrag.x), h: Math.abs(p.y - liveDrag.y) };
    drawLive();
  });
  document.addEventListener('pointerup', () => {
    if (!liveDrag) return;
    const start = liveDrag;
    liveDrag = null;
    const r = LIVE.rough;
    if (!r || r.w < 12 || r.h < 6) {
      LIVE.rough = null;
      if (!LIVE.view) { liveZoom(start); render(); } else drawLive();
      return;
    }
    if (r.w < 30 || r.h < 10 || !LIVE.worker) { LIVE.rough = null; drawLive(); return; }
    UI.live.locating = true; UI.live.found = null;
    LIVE.worker.postMessage({ type: 'locate', rough: r });
    render();
  });
  window.addEventListener('beforeunload', e => { if (LIVE.ex.length && UI.live.state !== 'off') { e.preventDefault(); e.returnValue = ''; } });

  // The owner's view of problem reports sent from live tracking. Members write them; only the owner reads.
  async function loadReports() {
    if (!DB || S.role !== 'owner') return;
    UI.reports = { loading: true, list: [] };
    render();
    try {
      const snap = await DB.collection('reports').orderBy('at', 'desc').limit(25).get();
      UI.reports = { list: snap.docs.map(d => Object.assign({ id: d.id }, d.data())) };
    } catch (_) { UI.reports = { list: [], err: 'Couldn’t load reports. Make sure Firestore is using the latest firestore.rules.' }; }
    render();
  }
  const JPEG_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
  // Saving every report into a folder at once (Edge and Chrome): each picture, and beside it a text file
  // with who sent it, when, the build, their note and what the tracker read. The folder is remembered in
  // this browser, and reports already in it are skipped.
  const canSaveFolder = () => typeof window.showDirectoryPicker === 'function';
  function folderStore(op, val) {
    return new Promise((res, rej) => {
      const rq = indexedDB.open('kina-ledger', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
      rq.onerror = () => rej(rq.error);
      rq.onsuccess = () => {
        const st = rq.result.transaction('kv', op === 'get' ? 'readonly' : 'readwrite').objectStore('kv');
        const r = op === 'get' ? st.get('reportsDir') : op === 'del' ? st.delete('reportsDir') : st.put(val, 'reportsDir');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      };
    });
  }
  let folderAsked = false;
  function reportsFolderName() {
    if (folderAsked || !canSaveFolder()) return;
    folderAsked = true;
    folderStore('get').then(d => { if (d && d.name && !(UI.reportsSave && UI.reportsSave.folder)) { UI.reportsSave = Object.assign({}, UI.reportsSave, { folder: d.name }); scheduleRender(); } }, () => {});
  }
  function reportName(id, x) {
    const d = new Date(num(x.at) || 0), p = n => String(n).padStart(2, '0');
    const what = String(x.reasons || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    return 'kina-report-' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '-' + what + '-' + String(id).replace(/[^A-Za-z0-9]/g, '').slice(-6);
  }
  function reportText(id, x) {
    let ex = x.ex;
    try { ex = JSON.stringify(JSON.parse(x.ex), null, 2); } catch (_) {}
    return ['Kina Ledger problem report', 'Sent: ' + (num(x.at) ? new Date(num(x.at)).toString() : 'unknown'), 'By: ' + String(x.by || ''), 'Build: ' + String(x.version || ''),
      'Reasons: ' + String(x.reasons || ''), 'Note: ' + (x.note ? String(x.note) : '(none)'), 'Read as: ' + (ex && ex !== '{}' ? String(ex) : '(nothing: the player reported it)'), 'Report id: ' + id, ''].join('\n');
  }
  async function writeFile(dir, name, data) {
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(data); await w.close();
  }
  function jpegBytes(url) {
    const bin = atob(url.slice(url.indexOf(',') + 1)), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // pick: choose a folder even when one is remembered.
  async function saveReports(pick) {
    if (!DB || S.role !== 'owner' || !canSaveFolder() || (UI.reportsSave && UI.reportsSave.busy)) return;
    let dir = null;
    if (!pick) try { dir = await folderStore('get'); } catch (_) {}
    try {
      if (dir && (await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') dir = null;
      if (!dir) { dir = await window.showDirectoryPicker({ id: 'kina-reports', mode: 'readwrite' }); try { await folderStore('put', dir); } catch (_) {} }
    } catch (e) {
      if (!(e && e.name === 'AbortError')) { UI.reportsSave = { err: 'Couldn’t open that folder. Choose it again.' }; render(); }
      return;
    }
    const del = !!UI.reportsDel;
    UI.reportsSave = { busy: true, folder: dir.name };
    render();
    let docs;
    try { docs = (await DB.collection('reports').orderBy('at', 'desc').limit(300).get()).docs; }
    catch (_) { UI.reportsSave = { folder: dir.name, err: 'Couldn’t load reports. Make sure Firestore is using the latest firestore.rules.' }; render(); return; }
    let saved = 0, had = 0, failed = 0, removed = 0;
    const deleted = [];
    for (const d of docs) {
      const x = d.data(), base = reportName(d.id, x);
      // The text file is written last, so it being there means the report was saved whole.
      let there = false;
      try { await dir.getFileHandle(base + '.txt'); there = true; } catch (_) {}
      if (there) had++;
      else {
        try {
          if (typeof x.sheet === 'string' && JPEG_URL.test(x.sheet)) await writeFile(dir, base + '.jpg', jpegBytes(x.sheet));
          await writeFile(dir, base + '.txt', reportText(d.id, x));
          saved++;
        } catch (_) { failed++; continue; }
      }
      if (del) try { await DB.doc('reports/' + d.id).delete(); removed++; deleted.push(d.id); } catch (_) {}
    }
    if (UI.reports && UI.reports.list) UI.reports.list = UI.reports.list.filter(r => !deleted.includes(r.id));
    const parts = [saved ? 'Saved ' + plural(saved, 'report') + ' to ' + dir.name + '.' : 'Nothing new to save' + (docs.length ? '.' : ': there are no reports.'),
      had ? (had === 1 ? 'One was' : had + ' were') + ' already there.' : '', removed ? 'Deleted ' + removed + ' from the database.' : ''].filter(Boolean);
    UI.reportsSave = { folder: dir.name, msg: parts.join(' '), err: failed ? (failed === 1 ? 'One report' : failed + ' reports') + ' couldn’t be written to the folder' + (del ? ', so ' + (failed === 1 ? 'it was' : 'they were') + ' kept in the database' : '') + '.' : '' };
    render();
  }
  function reportsHTML() {
    if (S.mode !== 'db' || S.role !== 'owner') return '';
    const r = UI.reports;
    let h = '<section class="panel"><h2 class="sec-h">Tracker problem reports</h2><p class="help">Pictures of the gathering or crafting popup that members sent from live tracking, with what the tracker read on each frame. Save them to a folder to share them when fixing the tracker.</p>';
    reportsFolderName();
    const sv = UI.reportsSave || {};
    h += canSaveFolder()
      ? '<div class="row-gap"><button class="btn primary" data-act="reports-save"' + (sv.busy ? ' disabled' : '') + '>' + (sv.busy ? 'Saving…' : sv.folder ? 'Save all to ' + esc(sv.folder) : 'Save all to a folder…') + '</button>' +
        (sv.folder && !sv.busy ? '<button class="btn ghost" data-act="reports-save" data-pick="1">Choose another folder</button>' : '') + '</div>' +
        '<label class="check"><input type="checkbox" data-chg="reports-del-after"' + (UI.reportsDel ? ' checked' : '') + (sv.busy ? ' disabled' : '') + '> Delete each report from the database once it’s saved</label>' +
        (sv.msg ? '<p class="help" role="status">' + esc(sv.msg) + '</p>' : '') + (sv.err ? '<p class="note loss">' + esc(sv.err) + '</p>' : '')
      : '<p class="help">Saving them all at once needs Edge or Chrome on a computer. You can still download them one at a time.</p>';
    if (!r) return h + '<div class="row-gap"><button class="btn" data-act="reports-load">Show reports</button></div></section>';
    if (r.loading) return h + '<p class="help">Loading…</p></section>';
    if (r.err) h += '<p class="note loss">' + esc(r.err) + '</p>';
    else if (!r.list.length) h += '<p class="help">None yet.</p>';
    h += '<ul class="prob-list">' + r.list.map(x => {
      const pic = typeof x.sheet === 'string' && JPEG_URL.test(x.sheet) ? x.sheet : null;
      return '<li><div><strong>' + esc(x.reasons) + '</strong> <span class="help">' + esc(num(x.at) ? when(num(x.at)) : '') + ' · ' + esc(x.by) + ' · ' + esc(x.version) + '</span></div>' +
        (x.note ? '<p class="help">“' + esc(x.note) + '”</p>' : '') + (x.ex ? '<p class="help">Read as: ' + esc(x.ex) + '</p>' : '') +
        (pic ? '<details><summary>Show the picture</summary><img class="prob-img" src="' + esc(pic) + '" alt="Popup frames for: ' + esc(x.reasons) + '"></details>' : '<p class="help">No picture.</p>') +
        '<div class="row-gap">' + (pic ? '<a class="btn small" href="' + esc(pic) + '" download="kina-report-' + esc(String(num(x.at) || x.id)) + '.jpg">Download</a>' : '') +
        '<button class="btn small ghost danger' + (UI.confirm === 'rdel-' + x.id ? ' armed' : '') + '" data-act="report-del" data-id="' + esc(x.id) + '">' + (UI.confirm === 'rdel-' + x.id ? 'Click again to delete' : 'Delete') + '</button></div></li>';
    }).join('') + '</ul>';
    return h + '<div class="row-gap"><button class="btn small" data-act="reports-load">Refresh</button></div></section>';
  }

  function settingsView() {
    const s = S.settings, lock = canManage() ? '' : ' disabled';
    let h = '<section class="panel"><h2 class="sec-h">Market and recipes</h2><div class="fgrid">' +
      '<div class="field"><label for="set-tax">Sales fee %</label><input id="set-tax" class="in num" inputmode="decimal" value="' + esc(s.tax) + '" data-chg="set" data-k="tax"' + lock + '><span class="help">Taken from the Kina you get when an item sells. Guides report 10%. The Market screen shows the current rate.</span></div>' +
      '<div class="field"><label for="set-list">Listing fee %</label><input id="set-list" class="in num" inputmode="decimal" value="' + esc(s.listFee) + '" data-chg="set" data-k="listFee"' + lock + '><span class="help">Paid when you list an item, as a share of its price, and not refunded if you cancel or relist. Guides report about 2%, and some say it’s paid in Bound Kina. Set it to 0 if you don’t want to count it.</span></div>' +
      '<div class="field"><label for="set-loss">Materials lost on a failed craft %</label><input id="set-loss" class="in num" inputmode="decimal" value="' + esc(s.failLoss) + '" data-chg="set" data-k="failLoss"' + lock + '><span class="help">Guides say a failed craft uses up the materials. Lower this if your client returns some.</span></div>' +
      '</div>' +
      '<label class="check"><input type="checkbox" id="set-pending" data-chg="set-pending"' + (s.showPending ? ' checked' : '') + lock + '> Include recipes the Global client doesn’t have yet</label>' +
      (canManage() ? '' : '<p class="help">Only the owner can change these shared settings.</p>') +
      '<p class="help">That’s the White, Wise, Dark and Ebony Dragon Lord tiers, which AION2 Hub lists without a mastery level, plus any recipe that uses an item you’ve marked as not in the game on the Prices tab.</p></section>';
    const lv = myLevels();
    h += '<section class="panel"><h2 class="sec-h">Your crafting levels</h2><p class="help">Used with each recipe’s level to look up its success rate. Enter them as the game shows them, Novice or Professional. Leave blank for professions you don’t craft.' +
      (S.uid ? ' These are yours alone: everyone who uses this page keeps their own levels.' : '') + '</p><div class="fgrid">' +
      PROFESSIONS.map(p => {
        const total = num(lv[p]), pro = total != null && total > 50;
        return '<div class="field"><label for="lvl-' + p + '">' + p + '</label><div class="lvl-in">' +
          '<select id="lvt-' + p + '" class="in" data-chg="lvl" data-p="' + p + '" aria-label="' + p + ' rank"><option value="n"' + (pro ? '' : ' selected') + '>Novice</option><option value="p"' + (pro ? ' selected' : '') + '>Professional</option></select>' +
          '<input id="lvl-' + p + '" class="in num" inputmode="numeric" value="' + (total == null ? '' : (pro ? total - 50 : total)) + '" data-chg="lvl" data-p="' + p + '" placeholder="—" aria-label="' + p + ' level"></div>' +
          (total != null ? '<span class="help">Total ' + total + '</span>' : '') + '</div>';
      }).join('') +
      '</div><details class="ref" id="rate-ref"' + (UI.rateOpen ? ' open' : '') + '><summary>Success rates by level difference</summary><p class="note" style="margin-top:8px">From the Global client’s Crafting Chance window (Expected Probability). Each item grade has its own table. Rows marked ≈ haven’t been read from the game yet. They follow the same curve as the measured rows, and Combo assumes a combo craft fails half as often as a normal one, which is what the measured rows show. To override one recipe, set its success % in Edit recipe.</p>' +
      '<div class="seg" role="group" aria-label="Which craft"><button data-act="rate-col" data-v="basic" aria-pressed="' + (UI.rateCol !== 'combo') + '">Normal craft</button><button data-act="rate-col" data-v="combo" aria-pressed="' + (UI.rateCol === 'combo') + '">Combo craft</button></div>' +
      '<div class="mini-well"><table class="mini"><thead><tr><th>Your level − recipe level</th>' + GRADES.map(g => '<th class="num">' + g + '</th>').join('') + '</tr></thead><tbody>' +
      RATES.Unique.map((_, g) => '<tr><td>' + g + (g === MAX_GAP ? ' or more' : '') + '</td>' + GRADES.map(grade => {
        const row = RATES[grade][g], combo = UI.rateCol === 'combo';
        return '<td class="num">' + ((combo ? row.cKnown : row.known) ? '' : '≈ ') + (combo ? row.combo : row.basic).toFixed(2) + '%</td>';
      }).join('') + '</tr>').join('') +
      '</tbody></table></div></details></section>';
    const exists = hasExamples();
    h += '<section class="panel"><h2 class="sec-h">Your data</h2><p class="help">' +
      (S.mode === 'db' ? 'Prices, price history and recipe edits are saved in the shared price book, so every member sees the same prices. Your crafting levels, what you gather, your gathering sessions and your minutes per craft are saved to your own account.' : 'Prices, price history, recipe edits, crafting levels and gathering sessions are saved in this browser only. Export them to keep a copy or move them to another device.') +
      (CAT.recipes.length ? ' The ' + NF0.format(CAT.recipes.length) + ' built-in recipes come from AION2 Hub’s Global client pages' + (CAT.built ? ', read ' + esc(CAT.built) : '') + '.' : '') + '</p>' +
      '<div class="io"><div class="field"><span class="lbl">Export</span>' +
      (UI.io.exportText ? '<textarea id="io-out" class="in" rows="7" readonly>' + esc(UI.io.exportText) + '</textarea><div class="row-gap"><button class="btn" data-act="io-copy">Copy</button><button class="btn ghost" data-act="io-hide">Hide</button></div>'
        : '<p class="help">A JSON copy of your prices, history, recipe edits and settings.</p><div><button class="btn" data-act="io-export">Show export</button></div>') + '</div>' +
      (canManage() ? '<div class="field"><label for="io-in">Import</label><textarea id="io-in" class="in" rows="7" placeholder="Paste a Kina Ledger export" data-inp="io-text">' + esc(UI.io.importText) + '</textarea>' +
        '<div class="row-gap"><button class="btn" data-act="io-import">Import</button>' + (UI.io.msg ? '<span class="help">' + esc(UI.io.msg) + '</span>' : '') + '</div></div>'
        : '<div class="field"><span class="lbl">Import</span><p class="help">Only the owner can import a full export into the shared price book. To add prices, use the Import tab.</p></div>') + '</div>' +
      (exists && canManage() ?'<div class="row-gap"><button class="btn danger' + (UI.confirm === 'rmx' ? ' armed' : '') + '" data-act="rm-examples">' + (UI.confirm === 'rmx' ? 'Click again to remove' : 'Remove example data') + '</button><span class="help">Deletes example recipes, and example items whose made-up prices you never changed.</span></div>' : '') +
      '</section>';
    h += reportsHTML();
    h += '<section class="panel"><div class="prose"><h2 class="sec-h">How the math works</h2>' +
      '<p>Every figure is an expected value for one craft attempt, so failures and combos are priced in.</p>' +
      '<h3>Odds</h3><ul><li><strong>Success</strong> comes from the level table above for the item’s grade (Common, Rare, Epic or Unique), looked up by your level minus the recipe level, unless the recipe has its own success %.</li>' +
      '<li><strong>Combo:</strong> a successful craft procs the combo at its chance (25% for gear). A proc means crafting again at the COMBO rate from the table, so the Splendent chance per craft is your normal success × 25% × your combo success. For gear it replaces the normal item with the Splendent version, which is the only way to get a Splendent item you can sell. If that second craft fails, you keep the normal item. For food it makes another batch on top.</li>' +
      '<li><strong>Transfer Crafting</strong> is guaranteed but its result is bound to your character, so it’s shown on the recipe for reference and left out of profits.</li>' +
      '<li><strong>Failure</strong> loses the share of materials set above. The crafting fee is paid on every attempt.</li></ul>' +
      '<h3>Money</h3><ul><li><strong>Sales</strong> = market price × (1 − sales fee − listing fee) × expected items made. With the defaults you keep 88% of the listed price.</li>' +
      '<li>Each material uses its cheapest source: market price, NPC price, or the cost of crafting it yourself, worked out the same way and including that craft’s own failures.</li>' +
      '<li>A Splendent material can also come from a combo: craft its base item until it procs, and sell the normal items made along the way. Its cost is the materials for those crafts, minus what the normal items sell for, divided by the Splendent chance per craft. The Splendent view in Rankings lists these costs.</li>' +
      '<li><strong>Buying all mats</strong> ignores gathering. <strong>With own gathering</strong> sets gatherable materials to 0 Kina. <strong>Gain vs selling raw</strong> sets them to what they would sell for after the fee. If it’s above zero, crafting is worth more than selling the materials.</li>' +
      '<li><strong>Break-even list price</strong> is the lowest price you can list the item at without losing Kina.</li></ul>' +
      '<h3>Gathering</h3><ul><li>A node’s grades are counted together, since one node can give any of them. <strong>Per hour</strong> = what your logged sessions got ÷ the time they took.</li>' +
      '<li><strong>Sell it all</strong> = each grade per hour × its market price after fees.</li>' +
      '<li><strong>Craft the best</strong> takes the crafts that pay most over selling their materials, and adds them while each earns more per hour of crafting than the hour so far. Your minutes per craft are added to the hour. A craft’s other materials are bought, or counted at their sell price if you gather them too.</li>' +
      '<li><strong>Buy and craft</strong> = the best expected profit with every material bought, × 60 ÷ your minutes per craft.</li>' +
      '<li><strong>Track live</strong> reads the gathering popup from a screen share, in this browser only: when each extraction ends, whether the Success or Fail bar filled, the grade from the title color, and the ×2 orb of a double harvest. The item icon is matched against the gathering icons from wikily.gg to name the item and its grade, so Pure and Radiant are told apart even when the title color isn’t, and a route with several kinds of node is saved as one session per node, with the time split by when each extraction happened. The clock runs from when you share your screen. Tracked sessions also give the node its success, double and tier-up rates.</li>' +
      '<li><strong>Expected per hour</strong> = the node’s tracked extractions per hour × the chance an extraction opens at each grade × your success rate from that grade × your chance it tiers up to each grade × (1 + your double rate), then × each grade’s price. The opening grades are pooled from everyone in the shared price book, since a node’s roll is the same for everyone; only those counts are shared. The other rates are yours alone, from your tracked sessions of the same kind of node.</li></ul>' +
      '<h3>Not counted</h3><ul><li>Listing fees paid in bound Kina. Your time, except on the Gathering tab. Price drops when you list many items at once, which matters most when you sell a lot of gathered materials.</li></ul></div></section>';
    return h;
  }

  const VIEWS = { rank: rankView, gather: gatherView, recipes: recipesView, prices: pricesView, shots: shotsView, settings: settingsView };

  function render() {
    const a = document.activeElement;
    let fid = null, sel = null;
    if (a && a.id && view.contains(a)) {
      fid = a.id;
      try { if (typeof a.selectionStart === 'number') sel = [a.selectionStart, a.selectionEnd]; } catch (_) {}
    }
    renderChrome();
    let html;
    try { html = S.ready ? accountNotice() + liveNotice() + (VIEWS[UI.tab] || VIEWS.rank)() : loadingView(); }
    catch (err) { console.error(err); html = '<section class="panel"><h2 class="sec-h">This tab hit an error</h2><p class="help">' + esc(err && err.message) + '</p></section>'; }
    view.innerHTML = html;
    renderDatalist();
    try { drawCharts(); drawLive(); } catch (err) { console.error(err); }
    if (fid) {
      const el = document.getElementById(fid);
      if (el) { el.focus({ preventScroll: true }); if (sel) { try { el.setSelectionRange(sel[0], sel[1]); } catch (_) {} } }
    }
  }
  let deferred = false;
  function editing() {
    const a = document.activeElement;
    return !!(a && view.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'checkbox');
  }
  function scheduleRender() { if (editing()) { deferred = true; return; } render(); }
  function later() { setTimeout(render, 0); }
  view.addEventListener('focusout', () => setTimeout(() => { if (deferred && !editing()) { deferred = false; render(); } }, 0));
  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { try { drawCharts(); } catch (_) {} }, 150); });

  let toastTimer = null;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3600);
  }
  function arm(key) {
    if (UI.confirm === key) { UI.confirm = null; return true; }
    UI.confirm = key; render();
    setTimeout(() => { if (UI.confirm === key) { UI.confirm = null; scheduleRender(); } }, 4000);
    return false;
  }

  /* ---------- actions ---------- */
  function setTab(tab) { UI.tab = tab; UI.confirm = null; saveUI(); render(); window.scrollTo({ top: 0 }); }
  function openEditor(id, draft) {
    if (!canManage()) { toast('Only the owner can change recipes.'); return; }
    UI.editorFrom = UI.tab;
    const r = id ? getRecipe(id) : null;
    UI.editor = draft || (r ? draftFrom(r) : blankDraft());
    if (!UI.editor.mats.length) UI.editor.mats.push({ name: '', qty: '1' });
    UI.editorErr = [];
    UI.tab = 'recipes'; saveUI(); render(); window.scrollTo({ top: 0 });
    const el = document.getElementById('ed-output'); if (el && !UI.editor.output) el.focus();
  }
  function closeEditor() { UI.editor = null; UI.editorErr = []; UI.tab = UI.editorFrom; saveUI(); }
  function draftMats(list, errs, label) {
    const mats = list.filter(m => m.name.trim()).map(m => ({ name: m.name.trim(), qty: num(m.qty) }));
    if (mats.some(m => !(m.qty > 0))) errs.push('Every ' + label + ' needs a quantity above 0.');
    return mats;
  }
  function saveDraft() {
    const d = UI.editor, errs = [];
    const outName = d.output.trim();
    if (!outName) errs.push('Name the item this recipe makes.');
    const mats = draftMats(d.mats, errs, 'material');
    const cmats = draftMats(d.cmats, errs, 'combo material');
    if (!mats.length) errs.push('Add at least one material.');
    if (outName && mats.some(m => norm(m.name) === norm(outName))) errs.push('A recipe can’t use the item it makes.');
    const checks = [['outQty', 'Quantity made', 1e9, true], ['level', 'Recipe level', 999], ['success', 'Success %', 100], ['fee', 'Kina fee', 1e12], ['combo', 'Combo chance %', 100], ['comboQty', 'Combo quantity', 1e9], ['comboSuccess', 'Combo success %', 100]];
    for (const [key, label, max, positive] of checks) {
      const raw = String(d[key] || '').trim(); if (!raw) continue;
      const v = num(raw);
      if (v == null || v < 0 || v > max || (positive && v <= 0)) errs.push(label + ' must be a number' + (max <= 100 ? ' from 0 to ' + max : '') + '.');
    }
    if (errs.length) { UI.editorErr = errs; render(); window.scrollTo({ top: 0 }); return; }
    const out = ensureItem(outName);
    const comboName = d.comboItem.trim();
    const comboItem = comboName && norm(comboName) !== norm(outName) ? ensureItem(comboName).id : null;
    const merge = list => { const m = new Map(); for (const x of list) { const id = ensureItem(x.name).id; m.set(id, (m.get(id) || 0) + x.qty); } return [...m].map(([item, qty]) => ({ item: item, qty: qty })); };
    const r = {
      id: d.id || uid('r'), output: out.id, outQty: num(d.outQty) || 1, profession: d.profession, grade: d.grade || '', level: num(d.level), success: num(d.success), fee: num(d.fee) || 0,
      combo: num(d.combo) || 0, comboItem: comboItem, comboQty: num(d.comboQty), comboSuccess: num(d.comboSuccess), comboAdds: !!d.comboAdds,
      mats: merge(mats), comboMats: merge(cmats), notes: d.notes.trim(), updatedAt: Date.now(), example: false
    };
    Store.putRecipe(r);
    closeEditor();
    UI.open = r.id;
    toast('Saved ' + out.name + '.');
    render(); window.scrollTo({ top: 0 });
  }
  function addItem() {
    const name = UI.newItem.name.trim();
    if (!name) { toast('Type the item’s name first.'); return; }
    const found = findItem(name);
    if (found && !found.virtual) { toast(found.name + ' is already on the list.'); return; }
    const p = UI.newItem.price.trim() ? num(UI.newItem.price) : null;
    if (UI.newItem.price.trim() && !(p >= 0)) { toast('Enter a price like 1520, 1,520 or 1.5k.'); return; }
    const base = found || { id: S.items.has(slugId(name)) ? uid('i') : slugId(name), name: name, price: null, vendor: null, gather: false, bound: /\(bound\)/i.test(name), updatedAt: null, hist: [] };
    const it = withPrice(Object.assign({}, base, S.uid ? {} : { gather: !!UI.newItem.gather }), p);
    Store.putItem(it);
    if (S.uid && UI.newItem.gather) setGather([it.id], true);
    UI.newItem = { name: '', price: '', gather: UI.newItem.gather };
    toast((found ? 'Priced ' : 'Added ') + it.name + '.');
    render();
    const el = document.getElementById('ni-name'); if (el) el.focus();
  }
  function removeExamples() {
    let nr = 0, ni = 0;
    for (const r of [...S.recipes.values()]) if (r.example) { Store.delRecipe(r.id); nr++; }
    for (const it of [...S.items.values()]) if (it.example) { Store.delItem(it.id); ni++; }
    if (UI.open && !getRecipe(UI.open)) UI.open = null;
    toast('Removed ' + plural(nr, 'example recipe') + ' and ' + plural(ni, 'example item') + '.');
    render();
  }
  function importData(text) {
    let d;
    try { d = JSON.parse(text); } catch (_) { return 'That isn’t valid JSON. Paste the whole export, from the first { to the last }.'; }
    if (!d || !Array.isArray(d.items) || !Array.isArray(d.recipes)) return 'That doesn’t look like a Kina Ledger export.';
    const idMap = new Map(), gathered = [];
    let ni = 0, nr = 0;
    for (const raw of d.items) {
      if (!raw || typeof raw !== 'object') continue;
      const x = readItem(String(raw.id || ''), raw);
      if (!x.name) continue;
      const ex = findItem(x.name);
      if (x.gather) gathered.push(ex ? ex.id : null);
      if (ex) {
        idMap.set(x.id, ex.id);
        const seen = new Set(), hist = [];
        for (const p of histOf(ex).concat(x.hist)) if (!seen.has(p.t)) { seen.add(p.t); hist.push(p); }
        hist.sort((a, b) => a.t - b.t);
        const newer = x.price != null && ((x.updatedAt || 0) > (ex.updatedAt || 0) || ex.price == null);
        const next = Object.assign({}, ex, { price: newer ? x.price : ex.price, updatedAt: newer ? x.updatedAt : ex.updatedAt, vendor: ex.vendor != null ? ex.vendor : x.vendor, gather: ex.gather || x.gather, bound: ex.bound || x.bound, unavailable: !!(ex.unavailable || x.unavailable), hist: hist.slice(-HIST_MAX) });
        delete next.virtual;
        Store.putItem(next);
      } else {
        const id = ID_RE.test(x.id) && !S.items.has(x.id) ? x.id : uid('i');
        idMap.set(x.id, id);
        Store.putItem(Object.assign({}, x, { id: id }));
        if (x.gather) gathered[gathered.length - 1] = id;
        ni++;
      }
    }
    const mapId = id => idMap.get(id) || (getItem(id) ? id : null);
    for (const raw of d.recipes) {
      if (!raw || typeof raw !== 'object') continue;
      const x = readRecipe(String(raw.id || ''), raw);
      x.output = mapId(x.output);
      if (!x.output) continue;
      x.comboItem = x.comboItem ? mapId(x.comboItem) : null;
      x.mats = x.mats.map(m => ({ item: mapId(m.item), qty: m.qty })).filter(m => m.item);
      x.comboMats = x.comboMats.map(m => ({ item: mapId(m.item), qty: m.qty })).filter(m => m.item);
      x.id = ID_RE.test(x.id) ? x.id : uid('r');
      Store.putRecipe(x);
      nr++;
    }
    if (d.settings) Store.putSettings(mergeSettings(d.settings));
    const lv = readLevels(d.myLevels);
    for (const p of Object.keys(lv)) setLevel(p, lv[p]);
    if (Array.isArray(d.myGather)) for (const id of d.myGather) gathered.push(idMap.get(String(id)) || null);
    if (S.uid) setGather(gathered.filter(Boolean), true);
    const have = myRuns(), runs = [];
    for (const r of readRuns(d.myRuns)) {
      const f = mapId(r.f), n = {};
      for (const id of Object.keys(r.n)) { const to = mapId(id); if (to) n[to] = r.n[id]; }
      if (f && !have.some(x => x.f === f && x.t === r.t)) runs.push(Object.assign({ f: f, m: r.m, n: n, t: r.t }, r.st ? { st: r.st } : {}));
    }
    if (runs.length) setRuns(have.concat(runs));
    const hadCrafts = myCrafts(), crafts = readCrafts(d.myCrafts).filter(c => getRecipe(c.r) && !hadCrafts.some(x => x.r === c.r && x.t === c.t));
    if (crafts.length) setCrafts(hadCrafts.concat(crafts));
    if (num(d.myCraftMin) > 0) setCraftMin(num(d.myCraftMin));
    return 'Imported' + plural(ni, 'new item') + ' and ' + plural(nr, 'recipe') + '.';
  }

  const ACTIONS = {
    tab: t => setTab(t.dataset.tab),
    metric: t => { UI.metric = t.dataset.m; saveUI(); render(); },
    per: t => { UI.per = t.dataset.v; saveUI(); render(); },
    goal: t => { UI.goal = t.dataset.v; UI.open = null; UI.rankShow = PAGE; saveUI(); render(); },
    'rate-col': t => { UI.rateCol = t.dataset.v; UI.rateOpen = true; render(); },
    'goto-recipe': t => { const r = getRecipe(t.dataset.id); if (!r) return; UI.tab = 'rank'; UI.goal = 'normal'; UI.prof = 'all'; UI.rankQ = itemName(r.output); UI.open = r.id; UI.rankShow = PAGE; saveUI(); render(); window.scrollTo({ top: 0 }); },
    'g-show': t => { UI.gatherShow = t.dataset.v; UI.gOpen = null; saveUI(); render(); },
    'g-odds': t => { UI.gatherOdds = t.dataset.v === 'raw' ? 'raw' : 'exp'; saveUI(); render(); },
    'g-open': t => { UI.gOpen = UI.gOpen === t.dataset.id ? null : t.dataset.id; render(); },
    'run-add': t => {
      const f = t.dataset.f, d = runDraft(f), m = minutesIn(d.m), n = {};
      if (!(m > 0 && m <= 1440)) { toast('Enter how long you gathered, like 25, 1h or 1h 20m.'); return; }
      for (const id of t.dataset.ids.split(' ')) {
        const raw = String(d.n[id] || '').trim(), c = raw === '' ? 0 : num(raw);
        if (!(c >= 0 && c < 1e6)) { toast('Enter how many of each grade you got, or leave it blank for none.'); return; }
        if (c > 0) n[id] = Math.round(c);
      }
      setRuns(myRuns().concat({ f: f, m: m, n: n, t: Date.now() }));
      UI.runDraft = null;
      toast('Logged ' + durTxt(m) + ' of ' + itemName(f) + '.');
      render();
    },
    'live-start': t => liveStart(t.dataset.f),
    'live-craft': t => liveStart(null, 'craft', t.dataset.r),
    'craft-del': t => { const ts = +t.dataset.t; setCrafts(myCrafts().filter(c => !(c.r === t.dataset.r && c.t === ts))); toast('Deleted that crafting session.'); render(); },
    'craft-use': t => { setCraftMin(Math.round(+t.dataset.v * 100) / 100); render(); },
    'live-snap': () => liveSnapSoon(),
    'live-unzoom': () => { LIVE.view = null; LIVE.rough = null; render(); },
    'live-use': () => {
      const fd = UI.live.found;
      if (!fd || !fd.box || !LIVE.worker) return;
      saveLiveBox(Object.assign({}, fd.box, LIVE.snap ? { fw: LIVE.snap.w, fh: LIVE.snap.h } : {}), UI.live.mode);
      LIVE.worker.postMessage({ type: 'box', box: fd.box });
      liveTracking();
    },
    'live-recal': () => {
      if (!LIVE.worker) return;
      LIVE.worker.postMessage({ type: 'box', box: null });
      UI.live.state = 'calibrate'; UI.live.found = null;
      render();
    },
    'live-pause': () => {
      if (!LIVE.worker) return;
      if (LIVE.pausedAt) { LIVE.pausedMs += Date.now() - LIVE.pausedAt; LIVE.pausedAt = 0; } else LIVE.pausedAt = Date.now();
      LIVE.worker.postMessage({ type: 'pause', on: !!LIVE.pausedAt });
      render();
    },
    'live-stop': () => liveStop(true),
    'live-save': () => {
      if (UI.live.mode === 'craft') {
        if (S.mode === 'db' && LIVE.problems.some(p => p.send && !p.sent) && !arm('live-save')) return;
        liveSaveCraft(); liveReset(); render(); return;
      }
      if (!liveKinds().every(x => x.k.f)) { toast('Choose a node for each icon first.'); return; }
      if (S.mode === 'db' && LIVE.problems.some(p => p.send && !p.sent) && !arm('live-save')) return;
      liveSave(); liveReset(); render();
    },
    'live-report': () => {
      if (!LIVE.worker) return;
      LIVE.worker.postMessage({ type: 'report' });
      toast(liveCanSend() ? 'Sending a picture of the last 15 seconds of the popup to the owner…' : 'Keeping a picture of the last 15 seconds of the popup. Download it when you stop, and send it to the owner.');
    },
    'live-send': async () => {
      if (!liveCanSend()) return;
      const todo = LIVE.problems.filter(p => p.send && !p.sent && !p.sending && p.url);
      if (!todo.length) { toast('Tick at least one picture to send.'); return; }
      const r = await sendProblems(todo);
      if (r.err) writeFailed(r.err, 'reports/');
      else if (!r.sent) toast('Those pictures are too large to send. Download them instead.');
      else toast('Sent ' + plural(r.sent, 'picture') + ' to the owner. Thanks!' + (r.big ? ' ' + (r.big === 1 ? 'One was' : r.big + ' were') + ' too large; download ' + (r.big === 1 ? 'it' : 'them') + ' instead.' : ''));
      render();
    },
    'reports-load': () => loadReports(),
    'reports-save': t => saveReports(!!t.dataset.pick),
    'report-del': t => {
      const id = t.dataset.id;
      if (!arm('rdel-' + id)) return;
      dbWrite('reports/' + id, DEL);
      UI.reports.list = UI.reports.list.filter(r => r.id !== id);
      render();
    },
    'live-discard': () => { if (LIVE.ex.length && !arm('live-discard')) return; liveReset(); render(); },
    'run-del': t => { const ts = +t.dataset.t; setRuns(myRuns().filter(r => !(r.f === t.dataset.f && r.t === ts))); toast('Deleted that session.'); render(); },
    prof: t => { UI.prof = t.dataset.p; UI.rankShow = PAGE; saveUI(); render(); },
    toggle: t => { const id = t.dataset.id; UI.open = UI.open === id ? null : id; render(); },
    'rank-more': () => { UI.rankShow += PAGE; render(); },
    'find-price': t => { const it = getItem(t.dataset.id); if (!it) return; UI.priceQuery = it.name; UI.priceFilter = 'all'; UI.priceOpen = it.id; UI.priceShow = 100; setTab('prices'); },
    'new-recipe': () => openEditor(null),
    edit: t => openEditor(t.dataset.id),
    'rec-prof': t => { UI.recProf = t.dataset.p; UI.recShow = PAGE; saveUI(); render(); },
    'rec-src': t => { UI.recSrc = t.dataset.v; UI.recShow = PAGE; saveUI(); render(); },
    'rec-more': () => { UI.recShow += PAGE; render(); },
    'ed-add-mat': t => { const l = t.dataset.l; UI.editor[l].push({ name: '', qty: '1' }); render(); const el = document.getElementById('ed-' + l + '-name-' + (UI.editor[l].length - 1)); if (el) el.focus(); },
    'ed-del-mat': t => { const l = t.dataset.l; UI.editor[l].splice(+t.dataset.i, 1); if (l === 'mats' && !UI.editor.mats.length) UI.editor.mats.push({ name: '', qty: '1' }); render(); },
    'ed-save': () => saveDraft(),
    'ed-cancel': () => { closeEditor(); render(); },
    'ed-delete': () => {
      const id = UI.editor && UI.editor.id; if (!id) return;
      if (!arm('del-' + id)) return;
      const name = UI.editor.output;
      Store.delRecipe(id);
      if (UI.open === id) UI.open = null;
      closeEditor(); toast('Deleted the ' + name + ' recipe.'); render();
    },
    'ed-restore': () => {
      const id = UI.editor && UI.editor.id; if (!id) return;
      if (!arm('restore-' + id)) return;
      Store.delRecipe(id);
      closeEditor(); toast('Restored the original ' + itemName(getRecipe(id) ? getRecipe(id).output : '') + ' recipe.'); render();
    },
    'item-add': () => addItem(),
    'item-del': t => { const it = S.items.get(t.dataset.id); if (!it || usage().has(it.id) || !canManage()) return; Store.delItem(it.id); toast('Deleted ' + it.name + '.'); render(); },
    'price-sort': t => { UI.priceSort = t.dataset.v; UI.priceShow = 100; saveUI(); render(); },
    'price-filter': t => { UI.priceFilter = t.dataset.v; UI.priceShow = 100; saveUI(); render(); },
    'price-more': () => { UI.priceShow += 100; render(); },
    'bulk-out': t => {
      const out = t.dataset.v === '1';
      const used = usage(), C = buildCalc(), outputs = new Set(allRecipes().map(r => r.output));
      const items = priceItems(used, C, outputs).filter(it => !!it.unavailable !== out);
      for (const it of items) { const next = Object.assign({}, it, { unavailable: out }); delete next.virtual; Store.putItem(next); }
      toast('Marked ' + plural(items.length, 'item') + (out ? ' as not in the game.' : ' as in the game.'));
      render();
    },
    'price-open': t => { UI.priceOpen = UI.priceOpen === t.dataset.id ? null : t.dataset.id; render(); },
    'hist-del': t => {
      const it = getItem(t.dataset.id); if (!it) return;
      const ts = +t.dataset.t;
      const hist = histOf(it).filter(p => p.t !== ts);
      const last = hist[hist.length - 1];
      const next = Object.assign({}, it, { hist: hist, price: last ? last.p : null, updatedAt: last ? last.t : null });
      delete next.virtual;
      Store.putItem(next); toast('Deleted that reading.'); render();
    },
    'sign-in': () => {
      if (!AUTH) return;
      AUTH.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(e => {
        const code = e && e.code;
        if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request') toast('Sign-in didn’t finish. Allow pop-ups for this site and try again.');
      });
    },
    'sign-out': () => { if (AUTH) AUTH.signOut(); },
    'paste-read': () => {
      const st = UI.shots, text = st.pasteText || '';
      if (!text.trim()) { st.pasteNote = 'Paste a price list first.'; render(); return; }
      const res = parsePaste(text);
      st.lastRead = { known: res.known, cells: res.cells, seen: res.seen, mode: S.mode, auth: S.auth };
      st.source = 'paste';
      const C = buildCalc();
      st.market = res.rows.map(r => {
        const doubt = newPriceDoubt(findItem(r.name), r.price, C);
        return { read: null, name: r.name, include: !doubt, priceText: NF0.format(r.price), doubt: doubt };
      });
      const doubtful = st.market.filter(r => r.doubt).length;
      st.pasteNote = res.rows.length ? 'Found ' + plural(res.rows.length, 'price') + ' for items on your list.' +
        (doubtful ? ' ' + plural(doubtful, 'price') + ' looked wrong and ' + (doubtful === 1 ? 'is' : 'are') + ' unticked.' : '') + ' Check them below, then save.'
        : res.found ? 'Found item names but no prices next to them. Try copying the price column too.'
        : !res.known ? 'There’s no item list to match against, because the recipe list didn’t load. Reload the page and try again.'
        : 'None of the item names on your list were found in that text.' + (res.unknown.length
          ? ' It has names like ' + res.unknown.map(n => '“' + n + '”').join(', ') + '. If those are in another language, switch aion2.exchange (and any translate extension) to English. If they’re items no recipe uses, like drop-only gear or skins, there’s nothing to update.'
          : ' Copy the table including the item names, then paste again.');
      render();
    },
    'paste-clear': () => { UI.shots.pasteText = ''; UI.shots.pasteNote = ''; if (UI.shots.source === 'paste') UI.shots.market = null; render(); },
    'shot-discard': () => { UI.shots.market = null; UI.shots.error = ''; render(); },
    'shot-apply': () => applyMarket(),
    'io-export': () => { UI.io.exportText = JSON.stringify({ app: 'kina-ledger', version: 3, exportedAt: new Date().toISOString(), settings: S.settings, myLevels: myLevels(), myGather: S.uid ? [...myGather()] : null, myRuns: myRuns(), myCrafts: myCrafts(), myCraftMin: myCraftMin(), items: [...S.items.values()], recipes: [...S.recipes.values()] }, null, 2); render(); },
    'io-hide': () => { UI.io.exportText = ''; render(); },
    'io-copy': () => {
      const fallback = () => { const ta = document.getElementById('io-out'); if (ta) { ta.focus(); ta.select(); } toast('Press Ctrl+C to copy the selected text.'); };
      try { navigator.clipboard.writeText(UI.io.exportText).then(() => toast('Copied the export.'), fallback); } catch (_) { fallback(); }
    },
    'io-import': () => { if (!canManage()) return; if (!UI.io.importText.trim()) { UI.io.msg = 'Paste an export first.'; render(); return; } UI.io.msg = importData(UI.io.importText); if (/^Imported/.test(UI.io.msg)) UI.io.importText = ''; render(); },
    'rm-examples': () => { if (canManage() && arm('rmx')) removeExamples(); }
  };

  const CHANGES = {
    item: t => {
      const it = getItem(t.dataset.id); if (!it) return;
      const f = t.dataset.f;
      let next;
      if (f === 'price' || f === 'vendor') {
        const raw = t.value.trim(), v = raw === '' ? null : num(raw);
        if (raw !== '' && (v == null || v < 0)) { toast('Enter a price like 1520, 1,520 or 1.5k.'); t.value = it[f] != null ? NF0.format(it[f]) : ''; return; }
        if (v === it[f]) { t.value = v != null ? NF0.format(v) : ''; return; }
        const doubt = f === 'price' ? newPriceDoubt(it, v, buildCalc()) : null;
        if (doubt) toast('Saved, but it’s ' + doubt + '. The rankings keep using the usual price until more readings agree.');
        next = f === 'price' ? withPrice(it, v) : Object.assign({}, it, { vendor: v, example: false });
      } else if (f === 'gather') { setGather([it.id], t.checked); later(); return; }
      else if (f === 'bound' || f === 'unavailable') next = Object.assign({}, it, { [f]: t.checked, example: false });
      if (!next) return;
      delete next.virtual;
      Store.putItem(next); later();
    },
    'plan-n': t => { const v = num(t.value); UI.crafts = v > 0 ? String(Math.round(v)) : '1'; saveUI(); later(); },
    'plan-w': t => { const v = num(t.value); UI.wanted = v > 0 ? String(Math.round(v)) : '1'; saveUI(); later(); },
    'plan-g': t => { UI.planGather = t.checked; saveUI(); later(); },
    'rk-craft': t => { UI.canCraft = t.checked; UI.rankShow = PAGE; saveUI(); later(); },
    'rk-afford': t => { UI.affordOnly = t.checked; UI.rankShow = PAGE; saveUI(); later(); },
    budget: t => {
      const raw = t.value.trim(), v = num(raw);
      if (raw && !(v > 0)) toast('Enter a budget like 10m, 500k or 10,000,000.');
      UI.budget = raw && v > 0 ? raw : '';
      if (!UI.budget && UI.per === 'budget') UI.per = 'kina';
      saveUI(); later();
    },
    'gather-toggle': t => { setGather([t.dataset.id], t.checked); later(); },
    'g-breaks': t => { UI.gatherNoBreaks = t.checked; saveUI(); later(); },
    'gather-node': t => { setGather(t.dataset.ids.split(' '), t.checked); later(); },
    'live-kind': t => { const k = LIVE.kinds[+t.dataset.k]; if (k) { k.f = t.value || null; k.sure = !!t.value; k.picked = true; } later(); },
    'pool-share': t => {
      if (!S.uid || !DB) return;
      const had = S.pool.get(S.uid) || { nodes: {}, st: {}, private: false };
      S.pool.set(S.uid, Object.assign({}, had, { private: !t.checked, st: t.checked ? had.st : {} }));
      writePool(true, true);
      toast(t.checked ? 'Your gathering totals are shared with the group, with no names.' : 'Your gathering totals aren’t shared any more. How often nodes open at each grade still is, for everyone’s odds.');
      render();
    },
    'live-limit': t => {
      const v = Math.round(num(t.value) || 0);
      LIVE.limit = v >= 1 && v <= 600 ? v : 0;
      saveLiveLimit(LIVE.limit);
      t.value = LIVE.limit || '';
      liveTimerFrom(); liveTick();
    },
    'live-prob': t => { const p = LIVE.problems[+t.dataset.i]; if (p) p.send = t.checked; },
    'reports-del-after': t => { UI.reportsDel = t.checked; },
    'g-craft': t => {
      const raw = t.value.trim(), v = raw === '' ? null : num(raw);
      if (raw !== '' && !(v > 0 && v <= 10000)) { toast('Enter the minutes one craft takes you, like 2 or 0.5.'); later(); return; }
      setCraftMin(v);
      later();
    },
    'rk-all': t => { UI.rankAll = t.checked; UI.rankShow = PAGE; saveUI(); later(); },
    'set-pending': t => { if (!canManage()) return; Store.putSettings(Object.assign({}, S.settings, { levels: Object.assign({}, S.settings.levels), showPending: t.checked })); recipesVer++; later(); },
    set: t => {
      if (!canManage()) return;
      const key = t.dataset.k, v = num(t.value);
      if (v == null || v < 0 || v > 100) { toast('Enter a percentage from 0 to 100.'); t.value = S.settings[key]; return; }
      Store.putSettings(Object.assign({}, S.settings, { levels: Object.assign({}, S.settings.levels), [key]: v })); later();
    },
    lvl: t => {
      const p = t.dataset.p;
      const tier = document.getElementById('lvt-' + p), box = document.getElementById('lvl-' + p);
      const raw = box ? box.value.trim() : '', v = raw === '' ? null : num(raw);
      if (raw !== '' && (v == null || v < 1 || v > 50)) { toast('Enter a level from 1 to 50, as the game shows it.'); later(); return; }
      setLevel(p, v == null ? null : Math.round(v) + (tier && tier.value === 'p' ? 50 : 0));
      later();
    },
    'ed-check': t => { UI.editor[t.dataset.k] = t.checked; },
    'ni-gather': t => { UI.newItem.gather = t.checked; },
    'sm-inc': t => { UI.shots.market[+t.dataset.i].include = t.checked; later(); },
    'sm-name': t => { const r = UI.shots.market[+t.dataset.i]; r.name = t.value.trim(); r.doubt = newPriceDoubt(findItem(r.name), num(r.priceText), buildCalc()); later(); },
    'sm-price': t => {
      const r = UI.shots.market[+t.dataset.i], v = num(t.value);
      r.priceText = v != null ? NF0.format(v) : t.value.trim();
      if (!(v > 0)) r.include = false;
      r.doubt = newPriceDoubt(findItem(r.name), v, buildCalc());
      later();
    }
  };

  const INPUTS = {
    ed: t => {
      UI.editor[t.dataset.k] = t.value;
      if (t.dataset.k === 'level' || t.dataset.k === 'profession' || t.dataset.k === 'grade') {
        const hint = draftHint(UI.editor);
        const s = document.getElementById('ed-success'), hp = document.getElementById('ed-success-help');
        if (s) s.placeholder = hint.ph;
        if (hp) hp.textContent = hint.help;
      }
    },
    'ed-mat': t => { const m = UI.editor[t.dataset.l][+t.dataset.i]; if (m) m[t.dataset.k] = t.value; },
    ni: t => { UI.newItem[t.dataset.k] = t.value; },
    pq: t => { UI.priceQuery = t.value; UI.priceShow = 100; render(); },
    rq: t => { UI.rankQ = t.value; UI.rankShow = PAGE; render(); },
    gq: t => { UI.gatherQ = t.value; render(); },
    run: t => { const d = runDraft(t.dataset.f); if (t.dataset.k === 'm') d.m = t.value; else d.n[t.dataset.k] = t.value; },
    'live-note': t => { UI.live.note = t.value; },
    recq: t => { UI.recQ = t.value; UI.recShow = PAGE; render(); },
    'io-text': t => { UI.io.importText = t.value; },
    'paste-text': t => { UI.shots.pasteText = t.value; }
  };

  document.addEventListener('click', e => {
    const t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    const fn = ACTIONS[t.dataset.act];
    if (fn) { e.preventDefault(); fn(t, e); }
  });
  document.addEventListener('change', e => { const t = e.target.closest('[data-chg]'); if (t && CHANGES[t.dataset.chg]) CHANGES[t.dataset.chg](t, e); });
  document.addEventListener('input', e => { const t = e.target.closest('[data-inp]'); if (t && INPUTS[t.dataset.inp]) INPUTS[t.dataset.inp](t, e); });
  document.addEventListener('toggle', e => { if (e.target && e.target.id === 'rate-ref') UI.rateOpen = e.target.open; }, true);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !e.target || !e.target.id) return;
    if (e.target.id === 'ni-name' || e.target.id === 'ni-price') { e.preventDefault(); addItem(); }
    if (e.target.dataset && e.target.dataset.inp === 'run') { e.preventDefault(); const b = view.querySelector('button[data-act="run-add"]'); if (b) ACTIONS['run-add'](b); }
  });

  /* ---------- importing prices ---------- */

  function applyMarket() {
    const rows = UI.shots.market || [];
    let upd = 0, add = 0;
    const ts = Date.now();
    for (const r of rows) {
      if (!r.include) continue;
      const p = num(r.priceText), name = r.name.trim();
      if (!(p > 0) || !name) continue;
      const it = findItem(name);
      if (it) { Store.putItem(withPrice(it, p, ts)); upd++; }
      else {
        const id = S.items.has(slugId(name)) ? uid('i') : slugId(name);
        Store.putItem(withPrice({ id: id, name: name, price: null, vendor: null, gather: false, bound: /\(bound\)/i.test(name), updatedAt: null, hist: [] }, p, ts));
        add++;
      }
    }
    UI.shots.market = null; UI.shots.status = 'idle';
    toast('Saved ' + plural(upd, 'price') + (add ? ' and added ' + plural(add, 'new item') : '') + '.');
    render();
  }


  /* ---------- boot ---------- */
  async function loadCatalog() {
    try {
      const res = await fetch('data/catalog.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      CAT = await res.json();
    } catch (_) {
      CAT = { recipes: [] };
      toast('The recipe list didn’t load. Open the page through a web server, not as a file.');
    }
    if (!CAT || !Array.isArray(CAT.recipes)) CAT = { recipes: [] };
    // Which materials are gathered from nodes, for the Gathering tab. Without it the tab lists every raw material.
    try {
      const res = await fetch('data/gather-icons.json', { cache: 'no-cache' }), d = res.ok ? await res.json() : null;
      GATHERABLE = d && Array.isArray(d.gatherable) ? new Set(d.gatherable.map(norm)) : null;
    } catch (_) { GATHERABLE = null; }
    itemsVer++; recipesVer++;
    const foot = document.getElementById('foot');
    if (CAT.recipes.length) {
      const s = document.createElement('span');
      s.textContent = 'Recipes: AION2 Hub, Global client' + (CAT.built ? ' (read ' + CAT.built + ')' : '') + '.';
      foot.appendChild(s);
    }
    const v = document.createElement('span');
    v.textContent = 'Version ' + BUILD + (CAT.recipes.length ? '' : ' · recipe list not loaded');
    foot.appendChild(v);
  }
  // Prices kept in this browser: used when the page isn't connected to Firebase, or you're not signed in as a member.
  function useLocal() {
    for (const stop of unsubs) stop();
    unsubs = [];
    DB = null; S.mode = 'local'; S.role = 'owner'; S.uid = null; S.mine = null; S.myGather = null; S.myRuns = null; S.myCrafts = null; S.myCraftMin = null; S.pool = new Map(); S.poolLoaded = false; poolSent = '';
    S.items = new Map(); S.recipes = new Map(); S.settings = mergeSettings(null);
    loadLocal();
    itemsVer++; recipesVer++;
    S.ready = true;
    scheduleRender();
  }
  // Signed in and listed in members/{email}: the shared price book in Firestore.
  async function useShared(fs, user) {
    let member = null;
    try {
      const snap = await fs.doc('members/' + String(user.email || '').toLowerCase()).get();
      member = snap.exists ? snap.data() : null;
    } catch (_) { member = null; }
    if (!member) { S.auth = 'notmember'; useLocal(); return; }
    for (const stop of unsubs) stop();
    unsubs = [];
    S.auth = 'member'; S.role = member.role === 'owner' ? 'owner' : 'member';
    DB = fs; S.mode = 'db'; S.uid = user.uid; S.mine = null; S.myGather = null; S.myRuns = null; S.myCrafts = null; S.myCraftMin = null; S.pool = new Map(); S.poolLoaded = false; poolSent = ''; S.ready = false;
    S.items = new Map(); S.recipes = new Map();
    render();
    subscribe();
    unsubs.push(DB.collection('pool').limit(200).onSnapshot(snap => {
      S.pool = new Map(snap.docs.map(d => [d.id, readPool(d.data())]));
      if (!S.poolLoaded) { S.poolLoaded = true; writePool(); }
      scheduleRender();
    }, () => {}));
    unsubs.push(DB.doc('users/' + user.uid).onSnapshot(d => {
      const x = d.exists ? d.data() : null;
      S.mine = readLevels(x && x.levels);
      S.myGather = x && Array.isArray(x.gather) ? new Set(x.gather.filter(v => typeof v === 'string')) : null;
      S.myRuns = readRuns(x && x.runs);
      S.myCrafts = readCrafts(x && x.crafts);
      writePool();
      S.myCraftMin = x && num(x.craftMin) > 0 ? num(x.craftMin) : null;
      itemsVer++;
      scheduleRender();
    }, () => {}));
  }
  async function boot() {
    render();
    await loadCatalog();
    const cfg = window.KINA_CONFIG && window.KINA_CONFIG.firebase;
    if (!cfg || !window.firebase) { S.auth = 'off'; useLocal(); return; }
    try {
      firebase.initializeApp(cfg);
      AUTH = firebase.auth();
    } catch (e) {
      console.error(e);
      S.auth = 'off'; useLocal();
      toast('Couldn’t connect to the shared price book. Check config.js.');
      return;
    }
    const fs = firebase.firestore();
    S.auth = 'pending';
    useLocal();
    AUTH.onAuthStateChanged(user => {
      if (!user) { S.auth = 'out'; S.email = null; useLocal(); return; }
      S.email = user.email || '';
      useShared(fs, user);
    });
  }
  boot();
})();
