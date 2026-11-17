
// ---------- Shop Welds push notifications ----------
// Ian's tablet signs up (weldpushsub). About once a minute, when any shop tablet checks in, weldPushTick_ compares the shop
// with what it saw last time: a job assembled (ready to weld), the priority list changing, a remake sent or finished, a gate
// drawing added. Each change is added to a short list of notes, and every signed-up tablet gets an empty push. The tablet's
// service worker then fetches the notes (weldpushnotes) and shows them, so no message text is sent through Google's push service.
// The push service needs each request signed with the app's key (VAPID, ES256); Apps Script has no ECDSA, so the signing is below.
const WELD_PUSH_PUB = 'BGfucHXMDwibX65-WqRBVeJiksPYCKjTcJdZTe-YwkZ3SiygQyQlCew440JQLxpNu08JADSW68PAQLFYtHyTGcM';   // the private half is the Script Property weldVapidD
const WELD_PUSH_SUBJECT = 'https://mlieuwen-code.github.io/shop-cuts/weld/';

function weldPushAction_(req) {
  const sp = PropertiesService.getScriptProperties();
  switch (req.action) {
    case 'weldpushsub': {
      const s = req.sub || {}, ep = String(s.endpoint || '');
      if (!/^https:\/\/[\w.-]+\//.test(ep) || ep.length > 900) throw new Error('Bad subscription');
      const subs = wpSubs_().filter(function (x) { return x.endpoint !== ep; });
      subs.push({ endpoint: ep, at: Date.now(), who: String(req.who || '').slice(0, 40) });
      sp.setProperty('weldPushSubs', JSON.stringify(subs.slice(-8)));
      return { ok: true, pub: WELD_PUSH_PUB };
    }
    case 'weldpushunsub': {
      const ep = String((req.sub && req.sub.endpoint) || req.endpoint || '');
      sp.setProperty('weldPushSubs', JSON.stringify(wpSubs_().filter(function (x) { return x.endpoint !== ep; })));
      return { ok: true };
    }
    case 'weldpushnotes': {
      const since = +req.since || 0;
      return { ok: true, notes: wpNotes_().filter(function (n) { return n.at > since; }) };
    }
    case 'weldpushtest': {
      wpAddNotes_(['Alerts are on. Ian’s tablet will get a notification when a job is ready to weld or the priority changes.']);
      return { ok: true, sent: wpSend_() };
    }
    case 'weldpushkey': {   // one time: stores the private key, never overwrites one that's there
      if (sp.getProperty('weldVapidD')) return { ok: true, had: true };
      if (!/^[\w-]{43}$/.test(String(req.d || ''))) throw new Error('Bad key');
      sp.setProperty('weldVapidD', String(req.d));
      return { ok: true, had: false };
    }
    case 'weldpushtick': {   // for checking by hand
      return { ok: true, notes: weldPushTick_(true) };
    }
  }
  return null;
}
function wpSubs_() { try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('weldPushSubs') || '[]'); } catch (e) { return []; } }
function wpNotes_() { try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('weldPushNotes') || '[]'); } catch (e) { return []; } }
function wpAddNotes_(texts) {
  let at = Date.now();
  const notes = wpNotes_().concat(texts.map(function (t) { return { t: String(t).slice(0, 200), at: at++ }; }));
  PropertiesService.getScriptProperties().setProperty('weldPushNotes', JSON.stringify(notes.slice(-25)));
}

// what changed in the shop since last time (at most about once a minute, whoever's tablet is asking)
function weldPushTick_(force) {
  const cache = CacheService.getScriptCache();
  if (!force && cache.get('wpTick')) return null;
  cache.put('wpTick', '1', 50);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(200)) return null;
  try {
    const sp = PropertiesService.getScriptProperties(), all = sp.getProperties(), now = Date.now();
    const st0 = all.weldPushState ? JSON.parse(all.weldPushState) : null;
    const st = st0 || { asm: {}, prio: null, rm: {}, rmDone: {}, gates: {} };
    const msgs = [], remakes = shopRemakeGet_(), names = {};
    const clean = function (n) { return String(n || '').replace(/\.(xls[xm]|pdf)$/i, ''); };
    remakes.concat(shopRemakeLogGet_()).forEach(function (r) { names['rm' + r.id] = 'Remake · ' + clean(r.name) + ' · ' + (r.tags || []).join(', '); });
    const nameOf = function (id) {
      if (names[id]) return names[id];
      try { const p = JSON.parse(all['prog:' + id] || 'null'); if (p && p.name) return (names[id] = clean(p.name)); } catch (e) {}
      try { return (names[id] = clean(DriveApp.getFileById(id).getName())); } catch (e) { return 'a job'; }
    };
    // jobs assembled (Jim's sign-off) and not welded yet
    Object.keys(all).forEach(function (k) {
      if (k.indexOf('prog:') !== 0 || /\.w$/.test(k) || k.indexOf('prog:rm') === 0) return;
      const id = k.slice(5); let p = null; try { p = JSON.parse(all[k]); } catch (e) {}
      if (!p || !p.asm || st.asm[id]) return;
      st.asm[id] = now;
      let w = null; try { w = JSON.parse(all['prog:' + id + '.w'] || 'null'); } catch (e) {}
      if (st0 && !(w && w.fin)) msgs.push('New job ready to weld: ' + clean(p.name));
    });
    // the priority list: a job added, or the order of the others changed (a job leaving it isn't news)
    const prio = shopPrioGet_();
    if (st.prio) {
      const added = prio.filter(function (id) { return st.prio.indexOf(id) < 0; });
      const keptNow = prio.filter(function (id) { return st.prio.indexOf(id) >= 0; }), keptBefore = st.prio.filter(function (id) { return prio.indexOf(id) >= 0; });
      added.forEach(function (id) { msgs.push('New priority: ' + nameOf(id) + ' is #' + (prio.indexOf(id) + 1)); });
      if (!added.length && prio.length && keptNow.join('|') !== keptBefore.join('|')) msgs.push('Priority order changed: #1 is now ' + nameOf(prio[0]) + (prio[1] ? ', #2 ' + nameOf(prio[1]) : ''));
    }
    st.prio = prio;
    // remakes sent to the shop, and remakes finished (every box ticked) that come off the list
    remakes.forEach(function (r) { if (!st.rm[r.id]) { st.rm[r.id] = now; if (st0) msgs.push('Remake coming up: ' + names['rm' + r.id]); } });
    shopRemakeLogGet_().forEach(function (g) {
      if (st.rmDone[g.id]) return; st.rmDone[g.id] = now;
      if (st0 && wpFinished_(all['prog:rm' + g.id])) msgs.push('Remake ready to weld: ' + names['rm' + g.id]);
    });
    // gate drawings put in Ready To Weld
    try { weldList_(WELD_READY_FOLDER_ID, false).forEach(function (g) { if (!st.gates[g.id]) { st.gates[g.id] = now; if (st0) msgs.push('New gate drawing ready to weld: ' + clean(g.name)); } }); } catch (e) {}
    // forget things after 60 days
    ['asm', 'rm', 'rmDone', 'gates'].forEach(function (k) { Object.keys(st[k]).forEach(function (id) { if (now - st[k][id] > 60 * 864e5) delete st[k][id]; }); });
    sp.setProperty('weldPushState', JSON.stringify(st));
    if (msgs.length) { wpAddNotes_(msgs); wpSend_(); }
    return msgs;
  } finally { lock.releaseLock(); }
}
// a remake's progress: every box ticked (a tick counts unless it was unticked later)
function wpFinished_(json) {
  let p = null; try { p = JSON.parse(json || 'null'); } catch (e) {}
  if (!p || !p.tot) return false;
  const done = p.done || {}, un = p.un || {};
  const n = Object.keys(done).filter(function (k) { return !(k in un) || parseInt(done[k], 36) > parseInt(un[k], 36); }).length;
  return n >= p.tot;
}
// an empty push to every signed-up tablet; ones the push service says are gone are dropped
function wpSend_() {
  const subs = wpSubs_(), d = PropertiesService.getScriptProperties().getProperty('weldVapidD');
  if (!subs.length || !d) return 0;
  const jwts = {};
  const reqs = subs.map(function (s) {
    const aud = s.endpoint.match(/^https:\/\/[^\/]+/)[0];
    if (!jwts[aud]) jwts[aud] = wpJwt_(aud, d);
    return { url: s.endpoint, method: 'post', headers: { Authorization: 'vapid t=' + jwts[aud] + ', k=' + WELD_PUSH_PUB, TTL: '86400', Urgency: 'high' }, payload: '', muteHttpExceptions: true };
  });
  const res = UrlFetchApp.fetchAll(reqs), gone = {};
  let sent = 0;
  res.forEach(function (r, i) { const c = r.getResponseCode(); if (c >= 200 && c < 300) sent++; else if (c === 404 || c === 410) gone[subs[i].endpoint] = 1; });
  if (Object.keys(gone).length) PropertiesService.getScriptProperties().setProperty('weldPushSubs', JSON.stringify(subs.filter(function (s) { return !gone[s.endpoint]; })));
  return sent;
}

// ---- VAPID: a JWT signed with ECDSA P-256 / SHA-256 (ES256), deterministic nonce (RFC 6979) ----
function wpB64u_(bytes) { return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, ''); }
function wpUnB64u_(s) { s = String(s); return Utilities.base64DecodeWebSafe(s + '==='.slice(0, (4 - s.length % 4) % 4)); }
function wpUtf8_(s) { return Utilities.newBlob(s).getBytes(); }
function wpJwt_(aud, dB64) {
  const head = wpB64u_(wpUtf8_(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = wpB64u_(wpUtf8_(JSON.stringify({ aud: aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: WELD_PUSH_SUBJECT })));
  const sig = wpSign_(wpUtf8_(head + '.' + body), wpUnB64u_(dB64));
  return head + '.' + body + '.' + wpB64u_(sig);
}
const WP_P = BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
const WP_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const WP_G = [BigInt('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'), BigInt('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5')];
function wpMod_(a, m) { const r = a % m; return r < BigInt(0) ? r + m : r; }
function wpPow_(b, e, m) { let r = BigInt(1); b = wpMod_(b, m); while (e > BigInt(0)) { if (e & BigInt(1)) r = r * b % m; b = b * b % m; e >>= BigInt(1); } return r; }
function wpInv_(a, m) { return wpPow_(a, m - BigInt(2), m); }
// Jacobian coordinates [X, Y, Z]; a = -3
function wpDbl_(P) {
  const X = P[0], Y = P[1], Z = P[2], p = WP_P;
  if (Y === BigInt(0) || Z === BigInt(0)) return [BigInt(0), BigInt(1), BigInt(0)];
  const YY = Y * Y % p, S = BigInt(4) * X * YY % p, ZZ = Z * Z % p, M = BigInt(3) * (X - ZZ) * (X + ZZ) % p;
  const X3 = wpMod_(M * M - BigInt(2) * S, p), Y3 = wpMod_(M * (S - X3) - BigInt(8) * YY * YY, p), Z3 = BigInt(2) * Y * Z % p;
  return [X3, Y3, Z3];
}
function wpAdd_(P, Q) {
  const p = WP_P;
  if (P[2] === BigInt(0)) return Q; if (Q[2] === BigInt(0)) return P;
  const Z1Z1 = P[2] * P[2] % p, Z2Z2 = Q[2] * Q[2] % p;
  const U1 = P[0] * Z2Z2 % p, U2 = Q[0] * Z1Z1 % p, S1 = P[1] * Q[2] % p * Z2Z2 % p, S2 = Q[1] * P[2] % p * Z1Z1 % p;
  if (U1 === U2) return S1 === S2 ? wpDbl_(P) : [BigInt(0), BigInt(1), BigInt(0)];
  const H = wpMod_(U2 - U1, p), R = wpMod_(S2 - S1, p), HH = H * H % p, HHH = H * HH % p, V = U1 * HH % p;
  const X3 = wpMod_(R * R - HHH - BigInt(2) * V, p), Y3 = wpMod_(R * (V - X3) - S1 * HHH, p), Z3 = P[2] * Q[2] % p * H % p;
  return [X3, Y3, Z3];
}
function wpMul_(k) {
  let R = [BigInt(0), BigInt(1), BigInt(0)], A = [WP_G[0], WP_G[1], BigInt(1)];
  while (k > BigInt(0)) { if (k & BigInt(1)) R = wpAdd_(R, A); A = wpDbl_(A); k >>= BigInt(1); }
  const zi = wpInv_(R[2], WP_P), zi2 = zi * zi % WP_P;
  return [R[0] * zi2 % WP_P, R[1] * zi2 % WP_P * zi % WP_P];
}
function wpBytesToInt_(b) { let x = BigInt(0); for (let i = 0; i < b.length; i++) x = (x << BigInt(8)) | BigInt(b[i] & 255); return x; }
function wpIntToBytes_(x) { const out = new Array(32); for (let i = 31; i >= 0; i--) { out[i] = Number(x & BigInt(255)); x >>= BigInt(8); } return out; }
function wpHmac_(key, data) { return Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_256, data.map(function (v) { return v > 127 ? v - 256 : v; }), key.map(function (v) { return v > 127 ? v - 256 : v; })).map(function (v) { return v & 255; }); }
function wpSign_(msg, dBytes) {
  const d = wpBytesToInt_(dBytes), h = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, msg).map(function (v) { return v & 255; });
  const z = wpBytesToInt_(h), x = wpIntToBytes_(d), h1 = wpIntToBytes_(wpMod_(z, WP_N));
  let V = new Array(32).fill(1), K = new Array(32).fill(0);
  K = wpHmac_(K, V.concat([0], x, h1)); V = wpHmac_(K, V);
  K = wpHmac_(K, V.concat([1], x, h1)); V = wpHmac_(K, V);
  for (;;) {
    V = wpHmac_(K, V);
    const k = wpBytesToInt_(V);
    if (k >= BigInt(1) && k < WP_N) {
      const r = wpMod_(wpMul_(k)[0], WP_N);
      const s = wpMod_(wpInv_(k, WP_N) * (z + r * d), WP_N);
      if (r !== BigInt(0) && s !== BigInt(0)) return wpIntToBytes_(r).concat(wpIntToBytes_(s)).map(function (v) { return v > 127 ? v - 256 : v; });
    }
    K = wpHmac_(K, V.concat([0])); V = wpHmac_(K, V);
  }
}
