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
  const TABS = [['rank', 'Rankings'], ['recipes', 'Recipes'], ['prices', 'Prices'], ['shots', 'Import'], ['settings', 'Settings']];
  const METRIC = {
    buy: { short: 'Buying all mats', hint: 'Every material bought at its cheapest source: the market, an NPC vendor, or crafting it from bought parts.' },
    gather: { short: 'With own gathering', hint: 'Materials you mark as gatherable cost nothing. This is the Kina you actually take home.' },
    opp: { short: 'Gain vs selling raw', hint: 'Gathered materials count at what they would sell for after the fee. Above zero means crafting beats selling the raw materials.' }
  };
  const ROUTE = { buy: 'Market', vendor: 'NPC', gather: 'Gather', craft: 'Craft', combo: 'Combo', missing: 'No price' };
  const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,160}$/;

  let CAT = { recipes: [] }; // loaded from data/catalog.json at startup

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
    const s = { tax: 10, failLoss: 100, levels: {}, showPending: false };
    if (d && typeof d === 'object') {
      s.showPending = !!d.showPending;
      if (num(d.tax) != null) s.tax = num(d.tax);
      if (num(d.failLoss) != null) s.failLoss = num(d.failLoss);
      s.levels = readLevels(d.levels);
    }
    return s;
  }
  const UI_KEYS = { tab: 's', goal: 's', metric: 's', per: 's', prof: 's', crafts: 's', wanted: 's', planGather: 'b', priceSort: 's', priceFilter: 's', rankAll: 'b', canCraft: 'b', recProf: 's', recSrc: 's', budget: 's', affordOnly: 'b' };
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
  const S = { items: new Map(), recipes: new Map(), settings: mergeSettings(null), ready: false, mode: 'pending', auth: 'pending', role: 'owner', email: null, uid: null, mine: null, myGather: null };
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
  function writePrefs() { if (S.uid && DB) dbWrite('users/' + S.uid, { levels: myLevels(), gather: [...myGather()] }); }
  const UI = Object.assign({
    tab: 'rank', goal: 'normal', metric: 'buy', per: 'kina', prof: 'all', open: null, crafts: '1', wanted: '1', planGather: true,
    priceQuery: '', priceSort: 'name', priceFilter: 'all', priceShow: 100, priceOpen: null,
    rankQ: '', rankAll: false, canCraft: false, rankShow: PAGE,
    recQ: '', recProf: 'all', recSrc: 'all', recShow: PAGE, budget: '', affordOnly: false
  }, readUI());
  UI.editor = null; UI.editorErr = []; UI.editorFrom = 'recipes';
  UI.shots = { status: 'idle', market: null, source: null, pasteText: '', pasteNote: '' };
  UI.newItem = { name: '', price: '', gather: false };
  UI.io = { exportText: '', importText: '', msg: '' };
  UI.confirm = null;

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
      } catch (e) { writeFailed(e); }
    }
    q.busy = false;
  }
  function writeFailed(e) {
    const code = e && e.code;
    if (code === 'permission-denied') toast(canManage() ? 'The database refused that change. Make sure Firestore is using the latest firestore.rules.' : 'That change wasn’t saved: only the owner can make it.');
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
    putSettings(s) { S.settings = s; if (DB) dbWrite('config/settings', clean(s)); else saveLocal(); }
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
  function canCraft(r) {
    if (r.level == null) return true;
    const lvl = num(myLevels()[r.profession]);
    return lvl != null && lvl >= r.level;
  }

  // scn: 'buy' = purchase everything, 'gather' = gatherable mats are free, 'opp' = gatherable mats cost their after-fee sell value
  function engine(scn, prod, comboMakers) {
    const tax = clamp01((num(S.settings.tax) == null ? 10 : num(S.settings.tax)) / 100);
    const loss = clamp01((num(S.settings.failLoss) == null ? 100 : num(S.settings.failLoss)) / 100);
    const mu = new Map(), mr = new Map(), stack = new Set();
    function netSell(id) {
      const it = getItem(id);
      if (!it || it.bound) return null;
      const p = num(it.price);
      return p > 0 ? p * (1 - tax) : null;
    }
    function unit(id) {
      if (mu.has(id)) return mu.get(id);
      const it = getItem(id);
      const opts = [];
      if (it) {
        if (scn !== 'buy' && isGathered(it)) opts.push({ route: 'gather', cost: scn === 'gather' ? 0 : (netSell(id) || 0) });
        const p = num(it.price); if (p > 0 && !it.bound) opts.push({ route: 'buy', cost: p });
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
    const rankable = rows.filter(x => sortKey(x) > -Infinity);
    const hidden = rows.length - rankable.length;
    if (!UI.rankAll) rows = rankable;
    rows = rows.slice().sort((a, b) => (sortKey(b) - sortKey(a)) || itemName(a.r.output).localeCompare(itemName(b.r.output)));

    let h = leadHTML(C, rankable);
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
      ? 'Each row is one Splendent item: what it costs to get by crafting its base item until it procs, after selling the normal items made along the way, and what it sells for after the ' + k(S.settings.tax) + '% fee. Open a row to see what it crafts if you keep it. Recipes that need a Splendent use this cost whenever making one is cheaper than buying it. ' + esc(METRIC[UI.metric].hint)
      : esc(METRIC[UI.metric].hint) + ' All figures are expected values per craft attempt, after the ' + k(S.settings.tax) + '% market fee. Click a row for the breakdown.') +
      (UI.per === 'budget' ? ' <strong>With my budget</strong> shows the profit you’d expect from spending your whole budget on that craft, one craft after another without reinvesting, and your chance to finish ahead.' : '') + '</p>';
    h += '<div class="filters"><div class="field"><label for="rq">Find a recipe</label><input id="rq" class="in" type="search" value="' + esc(UI.rankQ) + '" data-inp="rq" placeholder="e.g. Orb, Tea, Longsword" autocomplete="off"></div>' +
      '<div class="field budget"><label for="budget">My budget (Kina)</label><input id="budget" class="in num" inputmode="decimal" value="' + esc(UI.budget) + '" data-chg="budget" placeholder="e.g. 10m" autocomplete="off"></div>' +
      '<label class="check"><input type="checkbox" id="rk-craft" data-chg="rk-craft"' + (UI.canCraft ? ' checked' : '') + '> Only what my levels can craft</label>' +
      '<label class="check"><input type="checkbox" id="rk-afford" data-chg="rk-afford"' + (UI.affordOnly ? ' checked' : '') + (B ? '' : ' disabled') + '> Only what my budget covers</label>' +
      '<label class="check"><input type="checkbox" id="rk-all" data-chg="rk-all"' + (UI.rankAll ? ' checked' : '') + '> Include recipes still missing prices' + (hidden ? ' <span class="muted">(' + NF0.format(hidden) + ')</span>' : '') + '</label></div>';
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
        '<td class="c-name"><button class="rname" data-act="toggle" data-id="' + esc(r.id) + '" aria-expanded="' + open + '" aria-controls="d-' + esc(r.id) + '">' + esc(itemName(r.output)) +
        (b.outQty > 1 ? ' <span class="x">×' + qfmt(b.outQty) + '</span>' : '') + '</button>' +
        '<div class="rmeta"><span>' + esc(meta) + '</span>' + tagList(rowFlags(row)) + '</div></td>' +
        '<td class="num" data-label="' + (row.kind === 'combo' ? 'Chance per craft' : 'Success') + '"><div class="v">' + pct(b.pS) + '</div><div class="sub">' + odds + '</div></td>' +
        '<td class="num" data-label="Sells for"><div class="v">' + (out && out.bound ? '—' : k(b.revenue)) + '</div><div class="sub">' + (out && out.bound ? 'not sold' : (out && num(out.price) > 0 ? k(out.price) + ' ea listed' : 'no price')) + '</div></td>' +
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
        '<h2 class="lead-name">' + esc(itemName(best.r.output)) + '</h2>' +
        '<div class="lead-figs"><span class="big ' + tone(bd.total) + '">' + sk(bd.total) + '</span><span>Kina expected from ' + plural(bd.n, 'craft') + '</span><span class="sep">|</span><span>' + pct(bd.ahead) + ' chance to finish ahead</span>' +
        (isFinite(bd.anyCombo) ? '<span class="sep">|</span><span>' + pct(bd.anyCombo) + ' chance of a combo</span>' : '') + '</div>' +
        tagList(rowFlags(best)) + needHTML + '</div>' + stats + '</section>';
    }
    const positive = rc.profit > 0;
    return '<section class="lead"><div class="lead-main"><span class="eyebrow">' + (positive ? 'Most profitable right now' : 'Nothing turns a profit right now') + ' · ' + METRIC[UI.metric].short + '</span>' +
      '<h2 class="lead-name">' + esc(itemName(best.r.output)) + '</h2>' +
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
      '<dt>Current list price</dt><dd>' + (out && num(out.price) > 0 ? k(out.price) : '—') + '</dd>' +
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
      '</div><div class="dcard dwide"><h4>Risk and reward · ' + METRIC[scn].short + '</h4>' + riskHTML(rc) + '</div>' +
      '<div class="row-gap dfoot">' + (canManage() ? '<button class="btn" data-act="edit" data-id="' + esc(r.id) + '">Edit recipe</button>' : '') +
      '<button class="btn ghost" data-act="find-price" data-id="' + esc(r.output) + '">Price history</button>' + (r.notes ? '<span class="note">' + esc(r.notes) + '</span>' : '') + '</div>';
  }
  function treeRows(E, list, rcParent, depth, mult, path) {
    const rcList = E.recipe(rcParent.r);
    const priced = list === rcParent.r.comboMats ? rcList.cmats : list === rcParent.r.mats ? rcList.mats : null;
    let h = '';
    for (const m of priced || []) {
      const q = m.qty * mult;
      const batch = m.route === 'craft' && getRecipe(m.recipe) && getRecipe(m.recipe).outQty > 1 ? getRecipe(m.recipe).outQty : 0;
      h += '<tr class="' + (depth ? 'subrow' : '') + '"><td><span class="indent" style="--d:' + depth + '"></span>' + (depth ? '↳ ' : '') + esc(itemName(m.item)) +
        (batch ? ' <span class="muted">(made ' + batch + ' per craft; ↳ rows are this craft’s share)</span>' : '') + '</td>' +
        '<td class="num">' + qfmt(q) + '</td><td>' + routeTag(m.route) + '</td><td class="num">' + k(m.cost) + '</td><td class="num">' + k(q * m.cost) + '</td><td class="c">' + gatherBox(m.item, m.route) + '</td></tr>';
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
      body += '<tr><td>' + esc(itemName(L.item)) + '</td><td class="num">' + NF0.format(qty) + '</td><td>' + routeTag(L.route) + '</td><td class="num">' + (pays ? k(kin) : L.route === 'gather' ? '0' : '—') + '</td><td class="c">' + gatherBox(L.item, L.route) + '</td></tr>';
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
      h += '<li><div class="rc-main"><div class="rc-name">' + esc(itemName(r.output)) + (r.outQty > 1 ? ' <span class="muted">×' + qfmt(r.outQty) + '</span>' : '') + tagList(tags) + '</div>' +
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
      else if (needsPrice(it, used, C, outputs)) tags.push(['warn', 'Needs a price']);
      const isStale = num(it.price) > 0 && it.updatedAt && now - it.updatedAt > DAY;
      const deletable = !it.virtual && !u && !reg().catNames.has(norm(it.name));
      h += '<tr class="' + (open ? 'open' : '') + '"><td class="c-name"><button class="name-btn" data-act="price-open" data-id="' + id + '" aria-expanded="' + open + '">' + esc(it.name) + '</button>' + tagList(tags) + '</td>' +
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
    for (const line of String(text).split(/\r?\n/)) for (const cell of line.split(/\t|\s{2,}|\|/)) { const v = cell.trim(); if (v) cells.push(v); }
    const best = new Map();
    let found = 0;
    for (let i = 0; i < cells.length; i++) {
      const hit = itemIn(cells[i]);
      if (!hit) continue;
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
    return { rows: [...best.values()], found: found };
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
      const readAs = r.read && norm(r.read) !== norm(r.name) ? '<div class="sub" style="padding:0 8px">Read as “' + esc(r.read) + '”</div>' : '';
      h += '<tr><td class="c"><input type="checkbox" class="check" id="sm-inc-' + i + '" data-chg="sm-inc" data-i="' + i + '"' + (r.include ? ' checked' : '') + ' aria-label="Save this row"></td>' +
        '<td><input id="sm-name-' + i + '" class="cell-in" list="dl-items" value="' + esc(r.name) + '" data-chg="sm-name" data-i="' + i + '" aria-label="Item name" autocomplete="off">' + readAs + '</td>' +
        '<td>' + change + '</td>' +
        '<td class="num"><input id="sm-price-' + i + '" class="cell-in num" inputmode="decimal" value="' + esc(r.priceText) + '" data-chg="sm-price" data-i="' + i + '" aria-label="Price per unit"></td></tr>';
    });
    return h + '</tbody></table></div></section>';
  }

  function settingsView() {
    const s = S.settings, lock = canManage() ? '' : ' disabled';
    let h = '<section class="panel"><h2 class="sec-h">Market and recipes</h2><div class="fgrid">' +
      '<div class="field"><label for="set-tax">Sales fee %</label><input id="set-tax" class="in num" inputmode="decimal" value="' + esc(s.tax) + '" data-chg="set" data-k="tax"' + lock + '><span class="help">Taken from every sale. Guides report 8–10% on your own server. Check the fee on your sale confirmation.</span></div>' +
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
      (S.mode === 'db' ? 'Prices, price history and recipe edits are saved in the shared price book, so every member sees the same prices. Your crafting levels are saved to your own account.' : 'Prices, price history, recipe edits and crafting levels are saved in this browser only. Export them to keep a copy or move them to another device.') +
      (CAT.recipes.length ? ' The ' + NF0.format(CAT.recipes.length) + ' built-in recipes come from AION2 Hub’s Global client pages' + (CAT.built ? ', read ' + esc(CAT.built) : '') + '.' : '') + '</p>' +
      '<div class="io"><div class="field"><span class="lbl">Export</span>' +
      (UI.io.exportText ? '<textarea id="io-out" class="in" rows="7" readonly>' + esc(UI.io.exportText) + '</textarea><div class="row-gap"><button class="btn" data-act="io-copy">Copy</button><button class="btn ghost" data-act="io-hide">Hide</button></div>'
        : '<p class="help">A JSON copy of your prices, history, recipe edits and settings.</p><div><button class="btn" data-act="io-export">Show export</button></div>') + '</div>' +
      (canManage() ? '<div class="field"><label for="io-in">Import</label><textarea id="io-in" class="in" rows="7" placeholder="Paste a Kina Ledger export" data-inp="io-text">' + esc(UI.io.importText) + '</textarea>' +
        '<div class="row-gap"><button class="btn" data-act="io-import">Import</button>' + (UI.io.msg ? '<span class="help">' + esc(UI.io.msg) + '</span>' : '') + '</div></div>'
        : '<div class="field"><span class="lbl">Import</span><p class="help">Only the owner can import a full export into the shared price book. To add prices, use the Import tab.</p></div>') + '</div>' +
      (exists && canManage() ?'<div class="row-gap"><button class="btn danger' + (UI.confirm === 'rmx' ? ' armed' : '') + '" data-act="rm-examples">' + (UI.confirm === 'rmx' ? 'Click again to remove' : 'Remove example data') + '</button><span class="help">Deletes example recipes, and example items whose made-up prices you never changed.</span></div>' : '') +
      '</section>';
    h += '<section class="panel"><div class="prose"><h2 class="sec-h">How the math works</h2>' +
      '<p>Every figure is an expected value for one craft attempt, so failures and combos are priced in.</p>' +
      '<h3>Odds</h3><ul><li><strong>Success</strong> comes from the level table above for the item’s grade (Common, Rare, Epic or Unique), looked up by your level minus the recipe level, unless the recipe has its own success %.</li>' +
      '<li><strong>Combo:</strong> a successful craft procs the combo at its chance (25% for gear). A proc means crafting again at the COMBO rate from the table, so the Splendent chance per craft is your normal success × 25% × your combo success. For gear it replaces the normal item with the Splendent version, which is the only way to get a Splendent item you can sell. If that second craft fails, you keep the normal item. For food it makes another batch on top.</li>' +
      '<li><strong>Transfer Crafting</strong> is guaranteed but its result is bound to your character, so it’s shown on the recipe for reference and left out of profits.</li>' +
      '<li><strong>Failure</strong> loses the share of materials set above. The crafting fee is paid on every attempt.</li></ul>' +
      '<h3>Money</h3><ul><li><strong>Sales</strong> = market price × (1 − sales fee) × expected items made.</li>' +
      '<li>Each material uses its cheapest source: market price, NPC price, or the cost of crafting it yourself, worked out the same way and including that craft’s own failures.</li>' +
      '<li>A Splendent material can also come from a combo: craft its base item until it procs, and sell the normal items made along the way. Its cost is the materials for those crafts, minus what the normal items sell for, divided by the Splendent chance per craft. The Splendent view in Rankings lists these costs.</li>' +
      '<li><strong>Buying all mats</strong> ignores gathering. <strong>With own gathering</strong> sets gatherable materials to 0 Kina. <strong>Gain vs selling raw</strong> sets them to what they would sell for after the fee. If it’s above zero, crafting is worth more than selling the materials.</li>' +
      '<li><strong>Break-even list price</strong> is the lowest price you can list the item at without losing Kina.</li></ul>' +
      '<h3>Not counted</h3><ul><li>Listing fees paid in bound Kina, your time, and gathering energy. Price drops when you list many items at once.</li></ul></div></section>';
    return h;
  }

  const VIEWS = { rank: rankView, recipes: recipesView, prices: pricesView, shots: shotsView, settings: settingsView };

  function render() {
    const a = document.activeElement;
    let fid = null, sel = null;
    if (a && a.id && view.contains(a)) {
      fid = a.id;
      try { if (typeof a.selectionStart === 'number') sel = [a.selectionStart, a.selectionEnd]; } catch (_) {}
    }
    renderChrome();
    let html;
    try { html = S.ready ? accountNotice() + (VIEWS[UI.tab] || VIEWS.rank)() : loadingView(); }
    catch (err) { console.error(err); html = '<section class="panel"><h2 class="sec-h">This tab hit an error</h2><p class="help">' + esc(err && err.message) + '</p></section>'; }
    view.innerHTML = html;
    renderDatalist();
    try { drawCharts(); } catch (err) { console.error(err); }
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
        const next = Object.assign({}, ex, { price: newer ? x.price : ex.price, updatedAt: newer ? x.updatedAt : ex.updatedAt, vendor: ex.vendor != null ? ex.vendor : x.vendor, gather: ex.gather || x.gather, bound: ex.bound || x.bound, hist: hist.slice(-HIST_MAX) });
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
    return 'Imported ' + plural(ni, 'new item') + ' and ' + plural(nr, 'recipe') + '.';
  }

  const ACTIONS = {
    tab: t => setTab(t.dataset.tab),
    metric: t => { UI.metric = t.dataset.m; saveUI(); render(); },
    per: t => { UI.per = t.dataset.v; saveUI(); render(); },
    goal: t => { UI.goal = t.dataset.v; UI.open = null; UI.rankShow = PAGE; saveUI(); render(); },
    'rate-col': t => { UI.rateCol = t.dataset.v; UI.rateOpen = true; render(); },
    'goto-recipe': t => { const r = getRecipe(t.dataset.id); if (!r) return; UI.goal = 'normal'; UI.rankQ = itemName(r.output); UI.open = r.id; UI.rankShow = PAGE; saveUI(); render(); window.scrollTo({ top: 0 }); },
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
      st.source = 'paste';
      st.market = res.rows.map(r => ({ read: null, name: r.name, include: true, priceText: NF0.format(r.price) }));
      st.pasteNote = res.rows.length ? 'Found ' + plural(res.rows.length, 'price') + ' for items on your list. Check them below, then save.'
        : res.found ? 'Found item names but no prices next to them. Try copying the price column too.' : 'None of the item names on your list were found in that text.';
      render();
    },
    'paste-clear': () => { UI.shots.pasteText = ''; UI.shots.pasteNote = ''; if (UI.shots.source === 'paste') UI.shots.market = null; render(); },
    'shot-discard': () => { UI.shots.market = null; UI.shots.error = ''; render(); },
    'shot-apply': () => applyMarket(),
    'io-export': () => { UI.io.exportText = JSON.stringify({ app: 'kina-ledger', version: 3, exportedAt: new Date().toISOString(), settings: S.settings, myLevels: myLevels(), myGather: S.uid ? [...myGather()] : null, items: [...S.items.values()], recipes: [...S.recipes.values()] }, null, 2); render(); },
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
    'sm-name': t => { UI.shots.market[+t.dataset.i].name = t.value.trim(); later(); },
    'sm-price': t => { const r = UI.shots.market[+t.dataset.i]; const v = num(t.value); r.priceText = v != null ? NF0.format(v) : t.value.trim(); if (!(v > 0)) r.include = false; later(); }
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
    itemsVer++; recipesVer++;
    if (CAT.recipes.length) {
      const s = document.createElement('span');
      s.textContent = 'Recipes: AION2 Hub, Global client' + (CAT.built ? ' (read ' + CAT.built + ')' : '') + '.';
      document.getElementById('foot').appendChild(s);
    }
  }
  // Prices kept in this browser: used when the page isn't connected to Firebase, or you're not signed in as a member.
  function useLocal() {
    for (const stop of unsubs) stop();
    unsubs = [];
    DB = null; S.mode = 'local'; S.role = 'owner'; S.uid = null; S.mine = null; S.myGather = null;
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
    DB = fs; S.mode = 'db'; S.uid = user.uid; S.mine = null; S.myGather = null; S.ready = false;
    S.items = new Map(); S.recipes = new Map();
    render();
    subscribe();
    unsubs.push(DB.doc('users/' + user.uid).onSnapshot(d => {
      const x = d.exists ? d.data() : null;
      S.mine = readLevels(x && x.levels);
      S.myGather = x && Array.isArray(x.gather) ? new Set(x.gather.filter(v => typeof v === 'string')) : null;
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
