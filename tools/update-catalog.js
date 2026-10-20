#!/usr/bin/env node
// Builds data/catalog.json (every Global crafting recipe) from AION2 Hub's public recipe pages.
// The page loads that file at startup. Re-run after a game patch: node tools/update-catalog.js
// Pages already read are cached in tools/.cache/pages.json, so a rerun only fetches new ones.
// Pass --refresh to re-read everything.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(__dirname, '.cache');
const CACHE = path.join(CACHE_DIR, 'pages.json');
const OUT = path.join(ROOT, 'data', 'catalog.json');
const SITE = 'https://aion2hub.com';
const UA = 'KinaLedger/1.0 (personal crafting calculator; recipe import)';
const WORKERS = 3;
const GAP_MS = 300;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const decode = s => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

async function get(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(2000 * i);
    }
  }
}

// The recipe block's visible text, one token per text node.
function pageTokens(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  const t = body.replace(/<[^>]+>/g, '\n').split('\n').map(s => decode(s.trim())).filter(Boolean);
  const start = t.indexOf('— Crafting Recipe & Materials');
  const end = t.findIndex((x, i) => i > start && x.startsWith('Want to craft more than one'));
  if (start < 1 || end < 0) return null;
  return t.slice(start - 1, end);
}

function parse(slug, t) {
  const after = label => { const i = t.indexOf(label); return i >= 0 ? t[i + 1] : null; };
  const gradeAt = t.indexOf('Grade:');
  const r = {
    id: slug.match(/(\d+)$/)[1],
    name: t[0],
    kr: t.slice(0, gradeAt < 0 ? 12 : gradeAt).some(x => x.startsWith('Korea/Taiwan data')),
    grade: after('Grade:'),
    profession: after('Profession:'),
    level: after('Mastery level:') != null ? +after('Mastery level:') : null,
    yield: after('Yield per craft:') != null ? +after('Yield per craft:') : 1,
    mats: []
  };
  const ci = t.indexOf('Splendent / combo craft:');
  if (ci >= 0) {
    const pi = t.findIndex((x, i) => i > ci && x.startsWith('% chance each time you craft'));
    if (pi > 0) r.procFrom = { base: t[pi + 1], pct: +t[pi - 1], direct: !/not crafted directly/.test(t[ci + 2] || '') };
  }
  const a = t.findIndex(x => x.endsWith('recipe — direct components'));
  const b = t.findIndex((x, i) => i > a && x === 'All base materials for');
  if (a >= 0 && b > a) {
    for (let i = a + 1; i + 2 < b + 1; i++) {
      if (t[i + 1] === '×' && /^\d+(\.\d+)?$/.test(t[i + 2])) { r.mats.push([t[i], +t[i + 2]]); i += 2; }
    }
  }
  return r;
}

async function main() {
  const refresh = process.argv.includes('--refresh');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cache = !refresh && fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};

  const sitemap = await get(SITE + '/sitemap.xml');
  const slugs = [...new Set([...sitemap.matchAll(/\/tools\/crafting-calculator\/([a-z0-9-]+-\d+)</g)].map(m => m[1]))];
  const todo = slugs.filter(s => !cache[s]);
  console.log(slugs.length + ' recipe pages, ' + todo.length + ' to read');

  let done = 0, failed = 0;
  const save = () => fs.writeFileSync(CACHE, JSON.stringify(cache));
  async function worker() {
    while (todo.length) {
      const slug = todo.shift();
      try {
        const html = await get(SITE + '/tools/crafting-calculator/' + slug);
        const tokens = html && pageTokens(html);
        cache[slug] = tokens || [];
      } catch (e) { failed++; console.warn('failed ' + slug + ': ' + e.message); }
      if (++done % 50 === 0) { save(); console.log(done + ' read'); }
      await sleep(GAP_MS);
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker));
  save();

  const all = Object.entries(cache).filter(([, t]) => t.length).map(([slug, t]) => parse(slug, t));
  const global = all.filter(r => !r.kr && r.mats.length);

  // One recipe per distinct (item, materials) pair; faction copies of a recipe are identical.
  const seen = new Map();
  for (const r of global) {
    const key = r.name + '|' + JSON.stringify(r.mats);
    if (!seen.has(key)) seen.set(key, r);
  }
  const recipes = [...seen.values()];
  const byName = new Map();
  for (const r of recipes) { if (!byName.has(r.name)) byName.set(r.name, []); byName.get(r.name).push(r); }

  // Combos. An item that procs from itself (mostly food) makes another batch on top. A Splendent item
  // procs from its base recipe (usually 25%) and replaces the normal result; that proc is the only way
  // to get a Splendent item you can sell.
  const combos = [];
  const comboNames = new Set();
  for (const r of recipes) {
    if (!r.procFrom) continue;
    const self = r.procFrom.base === r.name;
    if (!self) comboNames.add(r.name);
    for (const base of self ? [r] : byName.get(r.procFrom.base) || []) combos.push({ base: base.id, item: self ? null : r.name, pct: r.procFrom.pct, adds: self, grade: r.grade });
  }
  // Transfer Crafting: a Splendent item's page that lists its own smaller material set is the guaranteed,
  // character-bound upgrade of an item you already own. Its result can't be sold, so it isn't a recipe here;
  // the base recipe just notes it.
  const transfers = new Map();
  for (const r of recipes) {
    if (!comboNames.has(r.name)) continue;
    const baseName = r.procFrom && r.procFrom.base !== r.name ? r.procFrom.base : r.name.replace(/^Splendent /, '');
    const bases = byName.get(baseName) || [];
    if (bases.some(b => JSON.stringify(b.mats) === JSON.stringify(r.mats))) continue;
    for (const b of bases) if (!transfers.has(b.id)) transfers.set(b.id, r.mats);
  }

  const out = {
    source: 'AION2 Hub (aion2hub.com), Global client recipe pages',
    built: new Date().toISOString().slice(0, 10),
    recipes: recipes.filter(r => !comboNames.has(r.name)).map(r => {
      const c = combos.find(x => x.base === r.id && x.item) || combos.find(x => x.base === r.id);
      const o = { id: 'c' + r.id, out: r.name, prof: r.profession, grade: r.grade, mats: r.mats };
      if (r.level != null) o.lvl = r.level;
      else o.pending = 1; // pages without a mastery level are tiers the Global client doesn't have yet
      if (r.yield > 1) o.qty = r.yield;
      if (c) { o.combo = c.pct; if (c.item) { o.comboItem = c.item; if (c.grade) o.comboGrade = c.grade; } if (c.adds) o.comboAdds = 1; }
      if (transfers.has(r.id)) o.transfer = transfers.get(r.id);
      return o;
    })
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('Pages read: ' + all.length + ', failed: ' + failed + ', Global recipes: ' + out.recipes.length + ', combos linked: ' + combos.length);
}

main().catch(e => { console.error(e); process.exit(1); });
