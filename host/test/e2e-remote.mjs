// End-to-end test of watching from outside the home: runs a local copy of the
// EsteefCast service with a throwaway certificate, makes an invite code on the
// host, pairs a viewer through the service and plays the stream through it.
// Run: npm run test:remote
import { _electron as electron } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const rzDir = path.resolve(appDir, '..', 'rendezvous');
const PORT = 47821;
const DPORT = 47820;
const RZ_PORT = 47912;
const STUN_PORT = 47913;
const RV = `wss://127.0.0.1:${RZ_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecast-remote-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000, step = 250) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(step);
  }
}

// Throwaway certificate for the local service.
const ssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '2',
  '-subj', '/CN=EsteefCast Test', '-addext', 'basicConstraints=critical,CA:TRUE',
  '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem')],
{ env: { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' }, encoding: 'utf8' });
if (ssl.status !== 0) { console.error(ssl.stderr); process.exit(1); }
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: RZ_PORT, stunPort: STUN_PORT }));
const ca = fs.readFileSync(path.join(tmp, 'cert.pem'));

const rz = spawn(process.execPath, [path.join(rzDir, 'server.js')], { env: { ...process.env, ECAST_RZ_DIR: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
let rzLog = '';
rz.stdout.on('data', (d) => { rzLog += d; });
rz.stderr.on('data', (d) => { rzLog += d; });

// One request/response over a viewer connection to the service.
function ask(msg, until) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${RV}/viewer`, { ca, checkServerIdentity: () => undefined });
    const t = setTimeout(() => { ws.terminate(); resolve(null); }, 8000);
    ws.on('open', () => ws.send(JSON.stringify(msg)));
    ws.on('message', (d) => { const m = JSON.parse(String(d)); if (until(m)) { clearTimeout(t); ws.close(); resolve(m); } });
    ws.on('error', () => { clearTimeout(t); resolve(null); });
  });
}

let app;
try {
  await waitFor(async () => rzLog.includes('rendezvous on tcp'), 8000);
  check('service started', rzLog.includes('rendezvous on tcp'));

  // STUN answers with our own address.
  const stun = await new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const req = Buffer.alloc(20);
    req.writeUInt16BE(0x0001, 0); req.writeUInt32BE(0x2112a442, 4); crypto.randomBytes(12).copy(req, 8);
    const t = setTimeout(() => { s.close(); resolve(null); }, 3000);
    s.on('message', (m) => {
      clearTimeout(t);
      const port = s.address().port;
      s.close();
      let i = 20; let addr = null;
      while (i + 4 <= m.length) {
        const type = m.readUInt16BE(i); const len = m.readUInt16BE(i + 2);
        if (type === 0x0020) {
          const p = m.readUInt16BE(i + 6) ^ 0x2112;
          const ip = (m.readUInt32BE(i + 8) ^ 0x2112a442) >>> 0;
          addr = { ip: [ip >>> 24, (ip >> 16) & 255, (ip >> 8) & 255, ip & 255].join('.'), port: p, expected: port };
        }
        i += 4 + len + ((4 - (len % 4)) % 4);
      }
      resolve(addr);
    });
    s.bind(0, '127.0.0.1', () => s.send(req, STUN_PORT, '127.0.0.1'));
  });
  check('STUN reports our address', !!stun && stun.ip === '127.0.0.1' && stun.port === stun.expected, stun ? `${stun.ip}:${stun.port}` : 'no answer');

  app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: {
      ...process.env,
      ESTEEFCAST_TEST: '1',
      ESTEEFCAST_PORT: String(PORT),
      ESTEEFCAST_DISCOVERY_PORT: String(DPORT),
      ESTEEFCAST_USERDATA: path.join(tmp, 'host'),
      ESTEEFCAST_TEST_PATTERN: '1',
      ESTEEFCAST_PATTERN_FILE: path.join(here, 'pattern.html'),
      ESTEEFCAST_AUTOSHARE: 'EsteefCast Test Pattern',
      ESTEEFCAST_REMOTE: '1',
      ESTEEFCAST_SERVICE: RV,
      ESTEEFCAST_SERVICE_CERT: path.join(tmp, 'cert.pem'),
    },
  });
  const main = await waitFor(async () => app.windows().find((w) => w.url().endsWith('index.html')));
  const online = await waitFor(async () => (await main.evaluate(() => ecast.remoteGet())).state === 'online', 15000);
  check('host registered with the service', !!online);

  const inv = await main.evaluate(() => ecast.inviteCreate());
  check('invite code created', !!inv && /^[A-Z]+-\d{4}$/.test(inv.code || ''), inv && (inv.code || inv.error));

  const bad = await ask({ type: 'redeem', code: 'NOPE-0000', deviceId: 'x', name: 'x' }, (m) => m.type === 'error');
  check('wrong code refused', bad && bad.reason === 'bad-code', bad && bad.reason);

  const hostId = (await main.evaluate(() => ecast.getSettings())).hostId;
  const forged = await ask({ type: 'open', hostId, deviceId: 'intruder', name: 'x', token: 'guess' }, (m) => m.type === 'relay-error');
  check('unknown TV with a made-up key refused', forged && forged.reason === 'unauthorized', forged && forged.reason);

  // Pair and watch through the service.
  const url = `http://127.0.0.1:${PORT}/?test=1&rv=${encodeURIComponent(RV)}&code=${inv.code}`;
  await app.evaluate(({ BrowserWindow }, u) => {
    const w = new BrowserWindow({ width: 960, height: 540, x: 360, y: 300, title: 'Away viewer', webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
    w.loadURL(u);
  }, url);
  const viewer = await waitFor(async () => app.windows().find((w) => w.url().includes('rv=')));
  const paired = await waitFor(async () => viewer.evaluate(() => window.__viewer.paired), 10000);
  check('viewer paired with the code', !!paired, paired || '');

  const allowedList = await main.evaluate(() => ecast.allowedList());
  check('host remembers the friend', Object.values(allowedList).some((a) => a.remote && a.tokenHash && !('token' in a)));

  const reused = await ask({ type: 'redeem', code: inv.code, deviceId: 'second', name: 'x' }, (m) => m.type === 'error' || m.type === 'paired');
  check('code works only once', reused && reused.type === 'error', reused && (reused.reason || reused.type));

  const playing = await waitFor(async () => {
    const st = await viewer.evaluate(() => window.__viewer);
    return st.state === 'playing' && st.stats && st.stats.framesDecoded > 30 ? st : null;
  }, 20000);
  check('stream plays through the service', !!playing, playing ? '' : JSON.stringify(await viewer.evaluate(() => window.__viewer.state)));

  await sleep(5000);
  const st = await viewer.evaluate(() => window.__viewer.stats);
  const host = await main.evaluate(() => window.__ecastStats);
  console.log('viewer stats:', JSON.stringify(st));
  console.log('host stats:', JSON.stringify(host));
  check('away viewer gets H.264 at ~60 fps', st && /h264/i.test(st.codec) && st.fps >= 50, st && `${st.codec} ${st.fps} fps`);
  check('away viewer gets stereo sound', st && st.audioChannels === 2 && st.audioBytes > 10000, st && `${st.audioChannels} ch`);
  const remoteRow = (host || []).find((h) => h.state === 'connected');
  check('upload limit applied (8 Mbps)', remoteRow && remoteRow.mbps <= 9, remoteRow && `${remoteRow.mbps.toFixed(1)} Mbps`);

  // Service goes away: host notices and keeps retrying.
  rz.kill();
  const lost = await waitFor(async () => (await main.evaluate(() => ecast.remoteGet())).state !== 'online', 10000);
  check('host notices the service went away', !!lost);
} catch (e) {
  check('test ran', false, e.stack || e.message);
} finally {
  if (app) await app.close().catch(() => {});
  rz.kill();
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log('--- service log ---\n' + rzLog);
process.exit(failed.length ? 1 : 0);
