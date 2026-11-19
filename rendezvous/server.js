'use strict';
// EsteefCast rendezvous service.
// Introduces TVs to PCs across the internet: pairing by invite code, presence,
// and a relay for connection setup messages. It never carries video or sound.
// It also answers STUN requests so each side can learn its public address.
//
//   node server.js                 uses config.json, cert.pem and key.pem next to this file
//   ECAST_RZ_DIR=<dir> node server.js   (tests) read config/cert/data from <dir>

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dgram = require('dgram');
const { WebSocketServer } = require('ws');

const DIR = process.env.ECAST_RZ_DIR || __dirname;
const file = (n) => path.join(DIR, n);
const config = { port: 47900, stunPort: 3478, publicHost: '', ...readJson('config.json', {}) };
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_INVITES_PER_HOST = 10;

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
}
function writeJson(name, value) {
  try { fs.writeFileSync(file(name), JSON.stringify(value, null, 2)); } catch (e) { log('save failed', name, e.message); }
}
function log(...a) { console.log(new Date().toISOString(), ...a); }
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function sameHash(a, b) {
  const x = Buffer.from(a, 'hex'); const y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Registered PCs: hostId -> { secretHash, name, lastSeen }. Kept across restarts.
const registry = readJson('hosts.json', {});
// Invite codes: code -> { hostId, expires }. Kept across restarts.
const invites = readJson('invites.json', {});
const online = new Map();   // hostId -> { ws, name, sharing, title, sessions: Map<sid, viewerWs> }
const redeems = new Map();  // rid -> viewerWs

function saveRegistry() { writeJson('hosts.json', registry); }
function saveInvites() {
  const now = Date.now();
  for (const [c, i] of Object.entries(invites)) if (i.expires < now) delete invites[c];
  writeJson('invites.json', invites);
}

// ---------- rate limiting (per IP, per minute) ----------
const buckets = new Map();
function allow(ip, kind, perMinute) {
  const key = `${kind}:${ip}`;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + 60000 }; buckets.set(key, b); }
  b.n += 1;
  return b.n <= perMinute;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60000);

// ---------- invite codes ----------
const WORDS = ['AMBER', 'ASPEN', 'BEAR', 'BIRCH', 'BISON', 'CEDAR', 'CLOUD', 'CORAL', 'CRANE', 'DELTA', 'EAGLE', 'EMBER',
  'FERN', 'FJORD', 'FOX', 'GROVE', 'HAWK', 'HERON', 'IVORY', 'JADE', 'KITE', 'LARCH', 'LINEN', 'LOTUS', 'MAPLE', 'MESA',
  'MOOSE', 'NOVA', 'OAK', 'OLIVE', 'ONYX', 'OTTER', 'PEARL', 'PINE', 'PLUM', 'QUAIL', 'RAVEN', 'REED', 'RIVER', 'SAGE',
  'SLATE', 'SPRUCE', 'STONE', 'TIDE', 'TULIP', 'VALE', 'WILLOW', 'WREN'];
function newCode() {
  for (;;) {
    const word = WORDS[crypto.randomInt(WORDS.length)];
    const code = `${word}-${String(crypto.randomInt(10000)).padStart(4, '0')}`;
    if (!invites[code]) return code;
  }
}
function normalizeCode(c) {
  const t = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = t.match(/^([A-Z]+)(\d{4})$/);
  return m ? `${m[1]}-${m[2]}` : '';
}

// ---------- WebSocket server ----------
const server = https.createServer({
  cert: fs.readFileSync(file('cert.pem')),
  key: fs.readFileSync(file('key.pem')),
}, (req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, maxPayload: 128 * 1024 });
const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

wss.on('connection', (ws, req) => {
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const hostHeader = String(req.headers.host || '').replace(/:\d+$/, '');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});
  const route = (req.url || '').split('?')[0];
  if (route === '/host') return hostConnection(ws, ip, hostHeader);
  if (route === '/viewer') return viewerConnection(ws, ip);
  ws.close(1008, 'unknown path');
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 15000);

function parse(data) {
  try { const m = JSON.parse(String(data)); return m && typeof m.type === 'string' ? m : null; } catch { return null; }
}

function stunUrls(hostHeader) {
  const h = config.publicHost || hostHeader;
  return h ? [`stun:${h}:${config.stunPort}`] : [];
}

// ---------- PCs ----------
function hostConnection(ws, ip, hostHeader) {
  let hostId = null;
  const timer = setTimeout(() => { if (!hostId) ws.close(1008, 'register first'); }, 10000);

  ws.on('message', (data) => {
    const m = parse(data);
    if (!m) return;
    if (!hostId) {
      if (m.type !== 'register') return;
      if (!allow(ip, 'register', 30)) return ws.close(1008, 'slow down');
      const id = String(m.hostId || '');
      const secret = String(m.secret || '');
      if (!/^[0-9a-f-]{36}$/i.test(id) || secret.length < 32) return send(ws, { type: 'error', reason: 'bad-register' });
      const known = registry[id];
      if (known && !sameHash(known.secretHash, sha256(secret))) return send(ws, { type: 'error', reason: 'bad-secret' });
      hostId = id;
      clearTimeout(timer);
      registry[id] = { secretHash: sha256(secret), name: String(m.name || 'PC').slice(0, 40), lastSeen: new Date().toISOString() };
      saveRegistry();
      const old = online.get(id);
      if (old && old.ws !== ws) { dropSessions(old); old.ws.close(1000, 'replaced'); }
      online.set(id, { ws, name: registry[id].name, sharing: !!m.sharing, title: String(m.title || ''), sessions: new Map() });
      send(ws, { type: 'registered', stun: stunUrls(hostHeader), ip });
      log('host online', id.slice(0, 8));
      return;
    }
    const h = online.get(hostId);
    if (!h || h.ws !== ws) return;
    switch (m.type) {
      case 'state':
        h.sharing = !!m.sharing;
        h.title = String(m.title || '').slice(0, 120);
        if (m.name) { h.name = String(m.name).slice(0, 40); registry[hostId].name = h.name; }
        break;
      case 'invite': {
        const mine = Object.values(invites).filter((i) => i.hostId === hostId && i.expires > Date.now());
        if (mine.length >= MAX_INVITES_PER_HOST) return send(ws, { type: 'invite', error: 'too-many' });
        const code = newCode();
        invites[code] = { hostId, expires: Date.now() + INVITE_TTL_MS };
        saveInvites();
        send(ws, { type: 'invite', code, expires: invites[code].expires });
        break;
      }
      case 'redeem-result': {
        const v = redeems.get(m.rid);
        redeems.delete(m.rid);
        if (!v) return;
        if (m.ok && typeof m.token === 'string') {
          if (invites[m.code] && invites[m.code].hostId === hostId) { delete invites[m.code]; saveInvites(); }
          send(v, { type: 'paired', hostId, hostName: h.name, token: m.token });
        } else {
          send(v, { type: 'error', reason: m.reason || 'refused' });
        }
        break;
      }
      case 'accept': {
        const v = h.sessions.get(m.sid);
        if (!v) return;
        v.accepted = true;
        send(v, { type: 'opened', hostName: h.name, stun: stunUrls(hostHeader) });
        break;
      }
      case 'reject': {
        const v = h.sessions.get(m.sid);
        if (!v) return;
        send(v, { type: 'relay-error', reason: m.reason || 'unauthorized' });
        h.sessions.delete(m.sid);
        v.close(1000);
        break;
      }
      case 'msg': {
        const v = h.sessions.get(m.sid);
        if (v && v.accepted && m.msg && typeof m.msg === 'object') send(v, m.msg);
        break;
      }
      case 'close': {
        const v = h.sessions.get(m.sid);
        if (v) { h.sessions.delete(m.sid); v.close(1000); }
        break;
      }
    }
  });

  ws.on('close', () => {
    clearTimeout(timer);
    const h = hostId && online.get(hostId);
    if (h && h.ws === ws) {
      dropSessions(h);
      online.delete(hostId);
      log('host offline', hostId.slice(0, 8));
    }
  });
}

function dropSessions(h) {
  for (const v of h.sessions.values()) {
    send(v, { type: 'relay-error', reason: 'offline' });
    v.close(1000);
  }
  h.sessions.clear();
}

// ---------- TVs ----------
function viewerConnection(ws, ip) {
  let session = null; // { hostId, sid }

  ws.on('message', (data) => {
    const m = parse(data);
    if (!m) return;

    if (session) {
      const h = online.get(session.hostId);
      if (h && ws.accepted) send(h.ws, { type: 'msg', sid: session.sid, msg: m });
      return;
    }

    switch (m.type) {
      case 'redeem': {
        if (!allow(ip, 'redeem', 10)) return send(ws, { type: 'error', reason: 'slow-down' });
        const code = normalizeCode(m.code);
        const inv = code && invites[code];
        if (!inv || inv.expires < Date.now()) return send(ws, { type: 'error', reason: 'bad-code' });
        const h = online.get(inv.hostId);
        if (!h) return send(ws, { type: 'error', reason: 'host-offline' });
        const rid = crypto.randomUUID();
        redeems.set(rid, ws);
        setTimeout(() => { if (redeems.delete(rid)) send(ws, { type: 'error', reason: 'timeout' }); }, 20000);
        send(h.ws, {
          type: 'redeem', rid, code,
          deviceId: String(m.deviceId || '').slice(0, 64), name: String(m.name || 'TV').slice(0, 60), ip,
        });
        break;
      }
      case 'status': {
        if (!allow(ip, 'status', 120)) return;
        const ids = Array.isArray(m.hostIds) ? m.hostIds.slice(0, 50).map(String) : [];
        const hosts = {};
        for (const id of ids) {
          const h = online.get(id);
          hosts[id] = h ? { online: true, name: h.name, sharing: h.sharing, title: h.title } : { online: false };
        }
        send(ws, { type: 'status', hosts });
        break;
      }
      case 'open': {
        if (!allow(ip, 'open', 30)) return send(ws, { type: 'relay-error', reason: 'slow-down' });
        const hostId = String(m.hostId || '');
        const h = online.get(hostId);
        if (!h) return send(ws, { type: 'relay-error', reason: 'offline' });
        const sid = crypto.randomUUID();
        session = { hostId, sid };
        h.sessions.set(sid, ws);
        send(h.ws, {
          type: 'open', sid, ip,
          deviceId: String(m.deviceId || '').slice(0, 64), name: String(m.name || 'TV').slice(0, 60), token: String(m.token || ''),
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!session) return;
    const h = online.get(session.hostId);
    if (h && h.sessions.get(session.sid) === ws) {
      h.sessions.delete(session.sid);
      send(h.ws, { type: 'close', sid: session.sid });
    }
  });
}

// ---------- STUN (RFC 5389 binding requests only) ----------
const MAGIC = 0x2112a442;
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function stunResponse(req, rinfo) {
  if (req.length < 20 || req.readUInt16BE(0) !== 0x0001 || req.readUInt32BE(4) !== MAGIC) return null;
  const txid = req.subarray(8, 20);
  const ip = rinfo.address.split('.').map(Number);
  if (ip.length !== 4) return null;
  // XOR-MAPPED-ADDRESS
  const xma = Buffer.alloc(12);
  xma.writeUInt16BE(0x0020, 0); xma.writeUInt16BE(8, 2);
  xma.writeUInt8(0, 4); xma.writeUInt8(0x01, 5);
  xma.writeUInt16BE(rinfo.port ^ (MAGIC >>> 16), 6);
  const ipNum = ((ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]) >>> 0;
  xma.writeUInt32BE((ipNum ^ MAGIC) >>> 0, 8);
  // MAPPED-ADDRESS (older clients)
  const ma = Buffer.alloc(12);
  ma.writeUInt16BE(0x0001, 0); ma.writeUInt16BE(8, 2);
  ma.writeUInt8(0, 4); ma.writeUInt8(0x01, 5);
  ma.writeUInt16BE(rinfo.port, 6); ma.writeUInt32BE(ipNum, 8);
  const body = Buffer.concat([xma, ma]);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(0x0101, 0);
  header.writeUInt16BE(body.length + 8, 2); // + FINGERPRINT
  header.writeUInt32BE(MAGIC, 4);
  txid.copy(header, 8);
  const msg = Buffer.concat([header, body]);
  const fp = Buffer.alloc(8);
  fp.writeUInt16BE(0x8028, 0); fp.writeUInt16BE(4, 2);
  fp.writeUInt32BE((crc32(msg) ^ 0x5354554e) >>> 0, 4);
  return Buffer.concat([msg, fp]);
}

const stun = dgram.createSocket('udp4');
stun.on('message', (m, rinfo) => {
  const r = stunResponse(m, rinfo);
  if (r) stun.send(r, rinfo.port, rinfo.address, () => {});
});
stun.on('error', (e) => log('stun error', e.message));
stun.bind(config.stunPort, () => log(`stun on udp ${config.stunPort}`));

server.listen(config.port, '0.0.0.0', () => log(`EsteefCast rendezvous on tcp ${config.port} (wss)`));
setInterval(saveInvites, 60 * 60 * 1000);
module.exports = { stunResponse, normalizeCode };
