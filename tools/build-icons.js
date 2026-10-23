#!/usr/bin/env node
// Builds data/gather-icons.json: an 8x8 grid of color and coverage for each gatherable material's icon,
// from wikily.gg's Gatherable Materials page. The live tracker compares the icon in the gathering popup
// against these to tell the material and its grade apart. Only these small grids are kept, not the images.
// Re-run after a patch adds materials: node tools/build-icons.js
//
// Only the first page of the list is read: the site loads later pages from its /api/ path, which its
// robots.txt asks crawlers to leave alone. So every raw material the recipes use (made by no recipe) is
// also looked up on its own wiki page, and kept in the gatherable list when that page calls it a
// Gatherable Material (drops like Raw Leather are Crafting Materials). Pages read are cached in
// tools/.cache/wikily.json; pass --refresh to read them again.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PAGE = 'https://wikily.gg/aion-2/materials/gatherable';
const ITEM = 'https://wikily.gg/aion-2/materials/';
const OUT = path.join(__dirname, '..', 'data', 'gather-icons.json');
const CATALOG = path.join(__dirname, '..', 'data', 'catalog.json');
const CACHE = path.join(__dirname, '.cache', 'wikily.json');
const UA = 'KinaLedger/1.0 (personal crafting calculator; icon matching)';
const G = 8;
// The site's grade names, as the gathering popup words them.
const GRADE = { Common: 'Common', Rare: 'Fine', Epic: 'Pure', Unique: 'Radiant' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, binary) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(url + ': HTTP ' + res.status);
  return binary ? Buffer.from(await res.arrayBuffer()) : res.text();
}
// The wiki's page name for an item: lower case, words joined by hyphens.
const slug = name => name.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// Raw materials: used by a catalog recipe and made by none.
function rawMaterials() {
  const cat = JSON.parse(fs.readFileSync(CATALOG, 'utf8')), made = new Set(), used = new Set();
  for (const r of cat.recipes) { made.add(r.out); if (r.comboItem) made.add(r.comboItem); for (const m of r.mats || []) used.add(m[0]); }
  return [...used].filter(n => !made.has(n) && !/\(bound\)/i.test(n)).sort();
}
const decode = s => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();

// Decodes an 8-bit, non-interlaced RGB or RGBA PNG to RGBA bytes.
function png(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let w = 0, h = 0, type = 0, idat = [];
  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p), kind = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = data[9];
      if (data[8] !== 8 || data[12] !== 0 || (type !== 6 && type !== 2)) throw new Error('unsupported PNG');
    } else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    p += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3, stride = w * bpp, raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      out[o] = line[x * bpp]; out[o + 1] = line[x * bpp + 1]; out[o + 2] = line[x * bpp + 2]; out[o + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    prev = line;
  }
  return { w: w, h: h, data: out };
}
// Each cell's average color, premultiplied by coverage, then the coverage: 4 numbers per cell, 0-255.
function grid(img) {
  const out = [], cw = img.w / G, ch = img.h / G;
  for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
    let r = 0, g = 0, b = 0, a = 0, k = 0;
    for (let y = Math.floor(gy * ch); y < (gy + 1) * ch; y++) for (let x = Math.floor(gx * cw); x < (gx + 1) * cw; x++) {
      const i = (y * img.w + x) * 4, al = img.data[i + 3] / 255;
      r += img.data[i] * al; g += img.data[i + 1] * al; b += img.data[i + 2] * al; a += al; k++;
    }
    out.push(Math.round(r / k), Math.round(g / k), Math.round(b / k), Math.round(a / k * 255));
  }
  return out;
}

async function main() {
  const html = await get(PAGE);
  const re = /<a class="ds-rcard[^"]*"[^>]*data-row-key="([^"]+)" data-grade="([^"]+)"[^>]*><span[^>]*><img class="ds-rcard-art" src="([^"]+)"[^>]*\/><\/span><b class="ds-rcard-title"[^>]*>([^<]+)<\/b><small[^>]*>([^<]+)<\/small>/g;
  const byIcon = new Map();
  for (const m of html.matchAll(re)) {
    if (decode(m[5]) !== 'Gatherable Material' || !GRADE[m[2]]) continue;
    const file = Buffer.from(m[3].split('/').pop(), 'base64').toString('utf8').split('/').pop();
    if (!byIcon.has(file)) byIcon.set(file, { url: m[3], grade: GRADE[m[2]], names: [] });
    const e = byIcon.get(file);
    if (e.names.indexOf(decode(m[4])) < 0) e.names.push(decode(m[4]));
  }
  if (!byIcon.size) throw new Error('no gatherable materials found; the page layout may have changed');
  const icons = [];
  for (const [file, e] of byIcon) {
    const img = png(await get(e.url, true));
    icons.push({ names: e.names, grade: e.grade, g: grid(img) });
    console.log(e.grade.padEnd(8) + e.names.join(' / ') + '  (' + file.replace(/^[0-9a-f-]+-/, '') + ')');
    await sleep(800);
  }
  // Which raw materials are gathered from nodes, from each one's own page.
  const cache = !process.argv.includes('--refresh') && fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
  const gatherable = new Set(icons.flatMap(i => i.names)), missing = [], drops = [];
  for (const name of rawMaterials()) {
    if (gatherable.has(name)) continue;
    const key = slug(name);
    if (!(key in cache)) {
      const html = await get(ITEM + key);
      const kind = html && html.match(/ext-gwe-dossier-kind">([^<]*)</);
      cache[key] = html ? (kind ? decode(kind[1]) : '') : null;
      fs.mkdirSync(path.dirname(CACHE), { recursive: true });
      fs.writeFileSync(CACHE, JSON.stringify(cache));
      await sleep(800);
    }
    if (cache[key] == null) missing.push(name);
    else if (/Gatherable Material/.test(cache[key])) gatherable.add(name);
    else drops.push(name + ' (' + (cache[key] || 'no type') + ')');
  }
  console.log('Not gathered: ' + drops.join(', '));
  if (missing.length) console.log('No wiki page found, left out: ' + missing.join(', '));
  fs.writeFileSync(OUT, JSON.stringify({ source: 'wikily.gg, Aion 2 Gatherable Materials', built: new Date().toISOString().slice(0, 10), size: G, icons: icons, gatherable: [...gatherable].sort() }));
  console.log(icons.length + ' icons for ' + icons.reduce((s, i) => s + i.names.length, 0) + ' materials, and ' + gatherable.size + ' gatherable materials, written to data/gather-icons.json');
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
