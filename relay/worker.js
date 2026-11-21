// Kina Ledger's relay to aion2.exchange, a Cloudflare Worker.
//
// Every hour it reads the market price of each item in the shared price book that has an aion2.exchange
// key, saves the prices that changed (the page labels any that look off), notes when it checked, and
// sends members the price alerts they set. A member can also ask for a check now (at most every 10
// minutes) and send a test message to their Discord webhook.
//
// It writes to Firestore with the project's service account key, kept as the FIREBASE_SA secret.
// aion2.exchange's owner agreed to this use; the page credits the site.
const UPSTREAM = 'https://aion2.exchange/api/';
const UA = 'KinaLedger/1.0 (personal crafting calculator; https://github.com/Shotyu0/KinaCalc)';
const PROJECT = 'kina-ledger';
const DOCS = 'projects/' + PROJECT + '/databases/(default)/documents/';
const FS = 'https://firestore.googleapis.com/v1/' + DOCS.slice(0, -1);
const ORIGINS = /^(https:\/\/shotyu0\.github\.io|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
const KEY = /^\d{9}$/, SERVER = /^[A-Za-z0-9_-]{1,40}$/;
const WEBHOOK = /^https:\/\/((canary|ptb)\.)?discord(app)?\.com\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,100}$/;
const BATCH = 25;          // items asked at a time (aion2.exchange allows 50, but big asks can time out there)
const SMALLEST = 5;        // a group this small that still fails means aion2.exchange is down
const ASKS = 40;           // most requests to aion2.exchange in one check
const KEEP = 1800;         // seconds an answer is kept for members asking close together
const AGAIN = 10 * 60e3;   // a member's check runs at most this often
const HITS = 30;           // fired alerts kept per member
const JUMP = 5;            // a price this many times off its usual one is labelled, as on the page
const WAIT = 20e3;         // how long to wait for aion2.exchange's answer

// Without the PRICES store, answers are kept in this copy of the Worker only.
const memo = new Map(), members = new Map();
let google = null;

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin') || '';
    const cors = ORIGINS.test(origin) ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {};
    const reply = (status, body) => new Response(JSON.stringify(body),
      { status: status, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, cors) });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: Object.assign({ 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400' }, cors) });
    const path = new URL(req.url).pathname;
    if (path !== '/refresh' && path !== '/discord-test') return reply(404, { error: 'Not found.' });
    if (req.method !== 'POST') return reply(405, { error: 'Only POST is answered.' });

    const who = await member(req.headers.get('Authorization') || '');
    if (who !== true) return reply(who, { error: who === 401 ? 'Sign in again.' : 'Only members of the shared price book can use this.' });

    try {
      if (path === '/discord-test') {
        let url = '';
        try { url = String((JSON.parse((await req.text()).slice(0, 2000)) || {}).url || ''); } catch (_) {}
        if (!WEBHOOK.test(url)) return reply(400, { error: 'That isn’t a Discord webhook link.' });
        const r = await discord(url, '**Kina Ledger** is connected. Your price alerts will be posted here.');
        return r.ok ? reply(200, { ok: true }) : reply(502, { error: 'Discord answered ' + r.status + '. Check the webhook link.' });
      }
      const token = await googleToken(env), now = Date.now();
      const last = (await fsGet(token, [DOCS + 'market/status'], ['at', 'failedAt', 'failed'])).get(DOCS + 'market/status') || {};
      if (last.at > now - AGAIN) return reply(200, { skipped: true, at: last.at });
      // aion2.exchange failed moments ago: say why instead of asking it again while it's down.
      if (last.failedAt > now - AGAIN && !(last.at > last.failedAt)) return reply(200, { skipped: true, at: last.at || null, failedAt: last.failedAt, failed: String(last.failed || '') });
      return reply(200, await run(env, ctx, 'member'));
    } catch (e) {
      console.error((path === '/refresh' ? 'Check' : 'Discord test') + ' failed: ' + e.message);
      return reply(502, { error: e.message });
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, ctx, 'hourly').catch(e => console.error('Hourly check failed: ' + e.message)));
  }
};

// One check of the market: every keyed item's price, saved where it changed, then the alerts it set off.
async function run(env, ctx, why) {
  const server = String(env.MARKET_SERVER || ''), serverName = String(env.MARKET_SERVER_NAME || server);
  if (!SERVER.test(server)) throw new Error('MARKET_SERVER isn’t set in wrangler.toml.');
  const token = await googleToken(env), now = Date.now();
  const items = await fsList(token, 'items', ['name', 'price', 'updatedAt', 'marketKey', 'unavailable']);
  const keyed = items.filter(it => typeof it.marketKey === 'string' && KEY.test(it.marketKey) && !it.unavailable);
  const keys = [...new Set(keyed.map(it => it.marketKey))].sort();
  const seen = new Map(), plan = { size: BATCH, left: ASKS };
  try {
    for (let i = 0; i < keys.length;) {
      const part = keys.slice(i, i + plan.size);
      for (const d of await askGroup(env, ctx, server, part, why === 'hourly', plan)) {
        for (const x of d && Array.isArray(d.items) ? d.items : []) {
          const k = String(x && x.item_key), p = Number(x && x.price);
          if (KEY.test(k) && x.listed !== false && p > 0 && isFinite(p)) seen.set(k, p);
        }
      }
      i += part.length;
    }
  } catch (e) {
    // Nothing is saved from a check that didn't get every price. The page shows why it failed.
    if (e.market) await gfetch(token, FS + ':commit', { method: 'POST', body: JSON.stringify({ writes: [{
      update: { name: DOCS + 'market/status', fields: fields({ failedAt: Date.now(), failed: e.message }) },
      updateMask: { fieldPaths: ['failedAt', 'failed'] } }] }) }).catch(() => {});
    throw e;
  }
  const changed = keyed.filter(it => seen.has(it.marketKey) && seen.get(it.marketKey) !== it.price)
    .map(it => ({ id: it.id, path: it.path, name: String(it.name || it.id), old: it.price > 0 ? it.price : null, at: it.updatedAt, p: seen.get(it.marketKey) }));
  const missing = keys.filter(k => !seen.has(k));

  // Each price is added to the item's history. The old reading goes in too, for an item that had a
  // price but no history yet; one already there isn't added twice.
  const writes = changed.map(c => ({
    update: { name: c.path, fields: fields({ price: c.p, updatedAt: now, example: false }) },
    updateMask: { fieldPaths: ['price', 'updatedAt', 'example'] },
    updateTransforms: [{ fieldPath: 'hist', appendMissingElements: { values: (c.old && c.at > 0 ? [{ t: c.at, p: c.old }] : []).concat([{ t: now, p: c.p }]).map(value) } }],
    currentDocument: { exists: true }
  }));
  writes.push({ update: { name: DOCS + 'market/status', fields: fields({ at: now, server: server, serverName: serverName, checked: keys.length, changed: changed.length, missing: missing, by: why }) } });

  // Alerts: a price that crossed a member's line since the last reading.
  const byId = new Map(changed.map(c => [c.id, c]));
  const fired = [];
  if (changed.length) {
    for (const a of await fsList(token, 'alerts', ['rules', 'discord'])) {
      const hits = [];
      for (const [id, r] of Object.entries(a.rules && typeof a.rules === 'object' ? a.rules : {})) {
        const c = byId.get(id), below = r && Number(r.below), above = r && Number(r.above);
        if (!c) continue;
        if (below > 0 && c.p <= below && !(c.old > 0 && c.old <= below)) hits.push({ i: id, n: c.name, p: c.p, k: 'below', v: below, at: now });
        if (above > 0 && c.p >= above && !(c.old > 0 && c.old >= above)) hits.push({ i: id, n: c.name, p: c.p, k: 'above', v: above, at: now });
      }
      if (hits.length) fired.push({ uid: a.id, discord: typeof a.discord === 'string' && WEBHOOK.test(a.discord) ? a.discord : null, hits: hits });
    }
  }
  if (fired.length) {
    const ids = [...new Set(fired.flatMap(f => f.hits.map(h => h.i)))];
    const got = await fsGet(token, ids.map(id => byId.get(id).path).concat(fired.map(f => DOCS + 'alertHits/' + f.uid)), ['hist', 'hits']);
    for (const f of fired) {
      for (const h of f.hits) {
        const hist = ((got.get(byId.get(h.i).path) || {}).hist || []).filter(x => x && x.p > 0).sort((a, b) => a.t - b.t).slice(-10).map(x => x.p);
        const usual = hist.length ? median(hist) : null;
        if (usual > 0 && (h.p >= usual * JUMP || h.p <= usual / JUMP)) { h.off = true; h.u = usual; }
      }
      const before = ((got.get(DOCS + 'alertHits/' + f.uid) || {}).hits || []).filter(x => x && typeof x === 'object');
      writes.push({ update: { name: DOCS + 'alertHits/' + f.uid, fields: fields({ hits: before.concat(f.hits).slice(-HITS), at: now }) } });
    }
  }
  for (let i = 0; i < writes.length; i += 400) await gfetch(token, FS + ':commit', { method: 'POST', body: JSON.stringify({ writes: writes.slice(i, i + 400) }) });

  const sent = await Promise.allSettled(fired.filter(f => f.discord).map(f => discord(f.discord, alertText(f.hits, serverName))));
  const failed = sent.filter(s => s.status === 'rejected' || !s.value.ok).length;
  if (failed) console.error(failed + ' Discord alert(s) didn’t send.');
  return { at: now, checked: keys.length, changed: changed.length, missing: missing.length, alerts: fired.reduce((n, f) => n + f.hits.length, 0) };
}

function alertText(hits, serverName) {
  const n = v => Math.round(v).toLocaleString('en-US');
  const lines = hits.map(h => (h.n.replace(/[*_~`|>]/g, '') + (h.k === 'below' ? ' is down to **' : ' is up to **') + n(h.p) + '** Kina (your alert: ' + n(h.v) + (h.k === 'below' ? ' or less)' : ' or more)') +
    (h.off ? '. Looks off: ' + (h.p >= h.u ? n(h.p / h.u) + '× its usual ' : 'under a fifth of its usual ') + n(h.u) + '.' : '.')));
  return ('**Kina Ledger price alert** · ' + serverName + '\n' + lines.join('\n')).slice(0, 1900);
}
function discord(url, content) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Kina Ledger', content: content, allowed_mentions: { parse: [] } }) });
}

// aion2.exchange's answers for a group of keys. When it's too busy for the group, it asks for each half
// after a short pause, and keeps to that smaller size for the rest of the check.
async function askGroup(env, ctx, server, keys, fresh, plan) {
  try { return [await askMarket(env, ctx, server, keys, fresh, plan)]; }
  catch (e) {
    if (!e.busy || keys.length <= SMALLEST || plan.left < 2) throw e;
    const half = Math.ceil(keys.length / 2);
    console.warn('aion2.exchange couldn’t answer for ' + keys.length + ' items; asking ' + half + ' at a time.');
    plan.size = Math.min(plan.size, half);
    await new Promise(r => setTimeout(r, Math.min(Math.max(e.retry || 1, 1), 5) * 1000));
    return (await askGroup(env, ctx, server, keys.slice(0, half), fresh, plan)).concat(await askGroup(env, ctx, server, keys.slice(half), fresh, plan));
  }
}

// aion2.exchange's prices for up to 50 keys. The hourly check always asks; a member's check may use an
// answer from the last 30 minutes.
async function askMarket(env, ctx, server, keys, fresh, plan) {
  const path = 'items?server=' + encodeURIComponent(server) + '&keys=' + keys.slice().sort().join(',');
  const id = await sha(path), kv = env.PRICES;
  let body = null;
  if (!fresh) {
    const kept = memo.get(id);
    body = kept && kept.until > Date.now() ? kept.body : null;
    if (!body && kv) body = await kv.get(id);
  }
  if (body) return JSON.parse(body);
  if (plan.left-- <= 0) throw marketError('aion2.exchange couldn’t answer after ' + ASKS + ' tries.');
  let r;
  try { r = await fetch(UPSTREAM + path, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(WAIT) }); }
  catch (e) {
    const late = e && e.name === 'TimeoutError';
    throw marketError('aion2.exchange didn’t answer' + (late ? ' within ' + WAIT / 1000 + ' seconds' : ' (' + (e && e.message) + ')') + '.', late);
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    const gate = r.headers.get('cf-mitigated') === 'challenge' || /<title>Just a moment|challenge-platform/i.test(text);
    console.error('aion2.exchange answered ' + r.status + ' for ' + keys.length + ' items (cf-ray ' + (r.headers.get('cf-ray') || '-') + ', retry-after ' + (r.headers.get('retry-after') || '-') + '): ' + text.replace(/\s+/g, ' ').slice(0, 300));
    const e = marketError(gate ? 'aion2.exchange asked for a browser check, which the relay can’t pass.'
      : r.status === 429 ? 'aion2.exchange says it has had too many requests (429).'
      : 'aion2.exchange answered ' + r.status + (r.status >= 500 ? ': the site is down or overloaded right now' : '') + '.', !gate && [500, 502, 503, 504].includes(r.status));
    e.retry = parseInt(r.headers.get('retry-after'), 10) || 0;
    throw e;
  }
  body = await r.text();
  let d;
  try { d = JSON.parse(body); } catch (_) { throw marketError('aion2.exchange sent something other than prices.'); }
  if (kv) ctx.waitUntil(kv.put(id, body, { expirationTtl: KEEP }));
  if (memo.size > 200) memo.clear();
  memo.set(id, { body: body, until: Date.now() + KEEP * 1000 });
  return d;
}
function marketError(message, busy) { const e = new Error(message); e.market = true; e.busy = !!busy; return e; }

// A member is someone signed in whose own record in `members` they can read. Firestore checks the
// token's signature and the access rules. A token that passed is remembered until it expires.
async function member(auth) {
  const token = (auth.match(/^Bearer (\S+)$/) || [])[1];
  if (!token) return 401;
  let claims;
  try { claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (_) { return 401; }
  if (claims.aud !== PROJECT || !claims.email || !(claims.exp * 1000 > Date.now())) return 401;
  if (members.get(token) > Date.now()) return true;
  const r = await fetch(FS + '/members/' + encodeURIComponent(claims.email), { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 401) return 401;
  if (!r.ok) return 403;
  if (members.size > 100) members.clear();
  members.set(token, claims.exp * 1000);
  return true;
}

// An access token for Firestore from the service account key, kept until shortly before it expires.
async function googleToken(env) {
  if (google && google.until > Date.now() + 60e3) return google.token;
  if (!env.FIREBASE_SA) throw new Error('The relay has no Firebase key yet (the FIREBASE_SA secret).');
  const sa = JSON.parse(env.FIREBASE_SA), now = Math.floor(Date.now() / 1000), te = new TextEncoder();
  const part = o => b64url(te.encode(JSON.stringify(o)));
  const unsigned = part({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id }) + '.' +
    part({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const der = Uint8Array.from(atob(String(sa.private_key).replace(/-----[^-]+-----|\s/g, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, te.encode(unsigned)));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + unsigned + '.' + b64url(sig) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error('Google refused the Firebase key (' + (d.error_description || d.error || r.status) + ').');
  google = { token: d.access_token, until: Date.now() + (d.expires_in || 3600) * 1000 };
  return google.token;
}

/* Firestore's REST API, with its typed values turned into plain ones and back. */
async function gfetch(token, url, opt) {
  const r = await fetch(url, Object.assign({}, opt, { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }));
  if (!r.ok) throw new Error('Firestore answered ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return r.json();
}
async function fsList(token, col, mask) {
  const out = [];
  let page = '';
  do {
    const q = new URLSearchParams({ pageSize: '300' });
    for (const f of mask) q.append('mask.fieldPaths', f);
    if (page) q.set('pageToken', page);
    const d = await gfetch(token, FS + '/' + col + '?' + q);
    for (const doc of d.documents || []) out.push(Object.assign(plain({ mapValue: { fields: doc.fields } }), { id: doc.name.slice(doc.name.lastIndexOf('/') + 1), path: doc.name }));
    page = d.nextPageToken || '';
  } while (page);
  return out;
}
async function fsGet(token, paths, mask) {
  const got = new Map();
  if (!paths.length) return got;
  for (const x of await gfetch(token, FS + ':batchGet', { method: 'POST', body: JSON.stringify({ documents: paths, mask: { fieldPaths: mask } }) })) {
    if (x.found) got.set(x.found.name, plain({ mapValue: { fields: x.found.fields } }));
  }
  return got;
}
function plain(v) {
  if (!v || typeof v !== 'object') return null;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(plain);
  if ('mapValue' in v) { const o = {}; for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = plain(x); return o; }
  return null;
}
function value(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === 'number') return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (typeof x === 'string') return { stringValue: x };
  if (typeof x === 'boolean') return { booleanValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(value) } };
  return { mapValue: { fields: fields(x) } };
}
function fields(o) { const f = {}; for (const [k, x] of Object.entries(o)) if (x !== undefined) f[k] = value(x); return f; }

function median(list) { const s = list.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function b64url(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function sha(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
