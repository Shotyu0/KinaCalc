// Kina Ledger's relay to aion2.exchange, a Cloudflare Worker. The page can't read aion2.exchange
// directly (the browser blocks it), so members of the shared price book ask here instead. Only two
// questions are passed on: the server list, and the market prices of up to 50 items (one page of its answer) by their
// 9-digit keys. Answers are kept for 30 minutes, so members refreshing close together ask once.
// aion2.exchange's owner agreed to this use; the page credits the site.
const UPSTREAM = 'https://aion2.exchange/api/';
const UA = 'KinaLedger/1.0 (personal crafting calculator; https://github.com/Shotyu0/KinaCalc)';
const PROJECT = 'kina-ledger';
const ORIGINS = /^(https:\/\/shotyu0\.github\.io|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
const KEY = /^\d{9}$/, SERVER = /^[A-Za-z0-9_-]{1,40}$/;
const KEEP = { servers: 6 * 3600, items: 1800 };

// Without the PRICES store, answers are kept in this copy of the Worker only.
const memo = new Map(), members = new Map();

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin') || '';
    const cors = ORIGINS.test(origin) ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {};
    const reply = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
      { status: status, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, cors) });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: Object.assign({ 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Authorization', 'Access-Control-Max-Age': '86400' }, cors) });
    if (req.method !== 'GET') return reply(405, { error: 'Only GET is answered.' });

    const url = new URL(req.url);
    let kind, path;
    if (url.pathname === '/servers') { kind = 'servers'; path = 'servers'; }
    else if (url.pathname === '/items') {
      const server = url.searchParams.get('server') || '', keys = [...new Set((url.searchParams.get('keys') || '').split(',').filter(Boolean))].sort();
      if (!SERVER.test(server)) return reply(400, { error: 'Unknown server.' });
      if (!keys.length || keys.length > 50 || !keys.every(k => KEY.test(k))) return reply(400, { error: 'Send 1 to 50 nine-digit item keys.' });
      kind = 'items'; path = 'items?server=' + encodeURIComponent(server) + '&keys=' + keys.join(',');
    } else return reply(404, { error: 'Not found.' });

    const who = await member(req.headers.get('Authorization') || '');
    if (who !== true) return reply(who, { error: who === 401 ? 'Sign in again.' : 'Only members of the shared price book can use this.' });

    const id = await sha(path), kv = env.PRICES, kept = memo.get(id);
    let body = kept && kept.until > Date.now() ? kept.body : null;
    if (!body && kv) body = await kv.get(id);
    if (!body) {
      const r = await fetch(UPSTREAM + path, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
      if (!r.ok) return reply(502, { error: 'aion2.exchange answered ' + r.status + '.' });
      body = await r.text();
      if (kv) ctx.waitUntil(kv.put(id, body, { expirationTtl: KEEP[kind] }));
      if (memo.size > 200) memo.clear();
      memo.set(id, { body: body, until: Date.now() + KEEP[kind] * 1000 });
    }
    return reply(200, body);
  }
};

// A member is someone signed in whose own record in `members` they can read. Firestore checks the
// token's signature and the access rules, so this Worker holds no keys. A token that passed is
// remembered until it expires, about an hour.
async function member(auth) {
  const token = (auth.match(/^Bearer (\S+)$/) || [])[1];
  if (!token) return 401;
  let claims;
  try { claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (_) { return 401; }
  if (claims.aud !== PROJECT || !claims.email || !(claims.exp * 1000 > Date.now())) return 401;
  if (members.get(token) > Date.now()) return true;
  const r = await fetch('https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents/members/' + encodeURIComponent(claims.email), { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 401) return 401;
  if (!r.ok) return 403;
  if (members.size > 100) members.clear();
  members.set(token, claims.exp * 1000);
  return true;
}

async function sha(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
