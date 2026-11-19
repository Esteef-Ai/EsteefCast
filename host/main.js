'use strict';
// EsteefCast host — main process.
// Tray app that serves viewers on the local network: UDP discovery, HTTP + WebSocket
// signaling, and the approval prompt. The WebRTC work happens in the renderer.

const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, desktopCapturer, session, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');
const { WebSocketServer, WebSocket: WsClient } = require('ws');

// Local addresses must stay visible in ICE candidates: TVs can't resolve the
// random ".local" names Chromium uses to hide them.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns,CalculateNativeWinOcclusion');
// Keep capture and encoding at full speed while the window is hidden in the tray.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const APP_NAME = 'EsteefCast';
const env = process.env;
const TEST = env.ESTEEFCAST_TEST === '1';
const WEB_PORT = Number(env.ESTEEFCAST_PORT) || 47801;
const DISCOVERY_PORT = Number(env.ESTEEFCAST_DISCOVERY_PORT) || 47800;
const DISCOVER_MAGIC = 'ESTEEFCAST_DISCOVER';

if (env.ESTEEFCAST_USERDATA) app.setPath('userData', env.ESTEEFCAST_USERDATA);

let win = null;
let tray = null;
let quitting = false;
let settings = null;
let allowed = {};
let share = { active: false, title: '' };
let selected = { sourceId: null, audio: true };
const viewers = new Map(); // id -> { id, ws, ip, deviceId, name, kind, approved }

// ---------- persistence ----------
const dataFile = (n) => path.join(app.getPath('userData'), n);
function readJson(name, fallback) {
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(dataFile(name), 'utf8')) }; }
  catch { return { ...fallback }; }
}
function writeJson(name, value) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(dataFile(name), JSON.stringify(value, null, 2));
  } catch (e) { console.error('[save]', name, e.message); }
}

function localAddresses() {
  const out = [];
  for (const [ifname, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^169\.254\./.test(a.address)) continue;
      if (/vEthernet|VirtualBox|VMware|WSL|Hyper-V/i.test(ifname)) continue;
      out.push(a.address);
    }
  }
  // Typical home ranges first.
  return out.sort((a, b) => rankIp(a) - rankIp(b));
}
function rankIp(ip) {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 3;
}

function toRenderer(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}
function send(v, msg) {
  v.send(msg);
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function sameHash(a, b) {
  const x = Buffer.from(String(a), 'hex'); const y = Buffer.from(String(b), 'hex');
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}
function removeViewer(v) {
  if (!viewers.has(v.id)) return;
  viewers.delete(v.id);
  if (v.sid) svcSessions.delete(v.sid);
  if (v.approved) toRenderer('viewer-leave', { id: v.id });
  updateTray();
}
function approvedViewers() {
  return [...viewers.values()].filter((v) => v.approved);
}

// ---------- web server + signaling ----------
const WEB_DIR = path.join(__dirname, 'web');
const WEB_FILES = {
  '/': ['viewer.html', 'text/html; charset=utf-8'],
  '/viewer.js': ['viewer.js', 'text/javascript; charset=utf-8'],
  '/viewer.css': ['viewer.css', 'text/css; charset=utf-8'],
  '/icon.png': ['../assets/icon.png', 'image/png'],
};

function hostInfo() {
  return {
    app: APP_NAME, v: 1, id: settings.hostId, name: settings.name, port: WEB_PORT,
    sharing: share.active, title: share.title, viewers: approvedViewers().length,
  };
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    if (url.pathname === '/info') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(hostInfo()));
    }
    const f = WEB_FILES[url.pathname];
    if (!f) { res.writeHead(404); return res.end('Not found'); }
    fs.readFile(path.join(WEB_DIR, f[0]), (err, buf) => {
      if (err) { res.writeHead(500); return res.end('Error'); }
      res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
  wss.on('connection', (ws, req) => {
    const id = crypto.randomUUID();
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const v = {
      id, ip, deviceId: null, name: 'TV', kind: 'tv', approved: false, remote: false,
      send: (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); },
      close: () => ws.close(),
      isOpen: () => ws.readyState === 1,
    };
    viewers.set(id, v);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg && typeof msg.type === 'string') onViewerMessage(v, msg);
    });
    ws.on('close', () => removeViewer(v));
    ws.on('error', () => {});
  });
  // Drop TVs that vanished without closing (sleep, Wi-Fi drop).
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, 10000);

  server.on('error', (e) => {
    const msg = e.code === 'EADDRINUSE'
      ? `Port ${WEB_PORT} is already in use. Is EsteefCast already running?`
      : e.message;
    dialog.showErrorBox(APP_NAME, `TVs can't connect: ${msg}`);
  });
  server.listen(WEB_PORT, '0.0.0.0', () => console.log(`[web] listening on ${WEB_PORT}`));
}

function onViewerMessage(v, msg) {
  if (msg.type === 'hello') {
    // Viewers from outside the home were checked by token when the session opened.
    if (v.remote) { if (!v.approved) approve(v); return; }
    if (v.deviceId) return;
    v.deviceId = String(msg.deviceId || '').slice(0, 64) || `anon-${v.id}`;
    v.name = String(msg.name || 'TV').replace(/[\r\n]/g, ' ').slice(0, 60);
    v.kind = msg.kind === 'web' ? 'web' : 'tv';
    if (TEST || allowed[v.deviceId]) return approve(v);
    send(v, { type: 'pending', hostName: settings.name });
    askApproval(v);
    return;
  }
  if (!v.approved) return;
  if (msg.type === 'answer' || msg.type === 'candidate' || msg.type === 'request' || msg.type === 'stats') {
    toRenderer('signal-in', { id: v.id, msg });
  }
}

let approvalChain = Promise.resolve();
function askApproval(v) {
  approvalChain = approvalChain.then(async () => {
    if (!v.isOpen()) return;
    if (allowed[v.deviceId]) return approve(v);
    showWindow();
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      title: APP_NAME,
      message: `"${v.name}" wants to watch this PC.`,
      detail: `It is at ${v.ip} on your network.\nIf you allow it, it will be remembered and won't ask again.`,
      buttons: ['Allow', 'Deny'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (!v.isOpen()) return;
    if (r.response === 0) {
      allowed[v.deviceId] = { name: v.name, added: new Date().toISOString() };
      writeJson('allowed.json', allowed);
      toRenderer('allowed-changed');
      approve(v);
    } else {
      send(v, { type: 'denied' });
      setTimeout(() => v.close(), 300);
    }
  }).catch((e) => console.error('[approve]', e));
}

function approve(v) {
  v.approved = true;
  send(v, { type: 'welcome', hostName: settings.name, sharing: share.active, title: share.title });
  toRenderer('viewer-join', {
    id: v.id, name: v.name, ip: v.ip, kind: v.kind, remote: !!v.remote,
    iceServers: v.remote && svc.stun.length ? [{ urls: svc.stun }] : [],
    remoteKbps: Number(settings.remoteKbps) || 8000,
  });
  updateTray();
}

// ---------- discovery ----------
function startDiscovery() {
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('message', (buf, rinfo) => {
    if (!buf.toString('utf8', 0, DISCOVER_MAGIC.length).startsWith(DISCOVER_MAGIC)) return;
    const reply = Buffer.from(JSON.stringify(hostInfo()));
    udp.send(reply, rinfo.port, rinfo.address, () => {});
  });
  udp.on('error', (e) => console.error('[discovery]', e.message));
  udp.bind(DISCOVERY_PORT, '0.0.0.0', () => {
    try { udp.setBroadcast(true); } catch {}
    console.log(`[discovery] listening on udp ${DISCOVERY_PORT}`);
  });
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('sources', async () => {
    const list = await desktopCapturer.getSources({
      types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 },
    });
    return list
      .filter((s) => s.name !== APP_NAME && s.name.trim() !== '')
      .map((s) => ({
        id: s.id, name: s.name, screen: s.id.startsWith('screen:'),
        thumb: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
      }));
  });
  ipcMain.handle('select-source', (_e, sourceId, audio) => {
    selected = { sourceId: String(sourceId || ''), audio: !!audio };
    return true;
  });
  ipcMain.handle('settings-get', () => ({
    ...settings, ips: localAddresses(), port: WEB_PORT, version: app.getVersion(),
    test: TEST ? { autoshare: env.ESTEEFCAST_AUTOSHARE || '', quality: env.ESTEEFCAST_QUALITY || '' } : null,
  }));
  ipcMain.handle('settings-set', (_e, patch) => {
    const keys = ['name', 'quality', 'audio', 'sourceId'];
    for (const k of keys) if (patch && k in patch) settings[k] = patch[k];
    settings.name = String(settings.name || os.hostname()).slice(0, 40);
    writeJson('settings.json', settings);
    svcSend({ type: 'state', sharing: share.active, title: share.title, name: settings.name });
    return settings;
  });
  ipcMain.handle('remote-get', () => remoteStatus());
  ipcMain.handle('remote-set', (_e, patch) => {
    const p = patch || {};
    let reconnect = false;
    if ('remoteKbps' in p) settings.remoteKbps = Number(p.remoteKbps) || 8000;
    if ('serviceUrl' in p && String(p.serviceUrl || '').trim() !== (settings.serviceUrl || '')) {
      settings.serviceUrl = String(p.serviceUrl || '').trim();
      reconnect = true;
    }
    if ('enabled' in p && !!p.enabled !== !!settings.remoteEnabled) {
      settings.remoteEnabled = !!p.enabled;
      reconnect = true;
    }
    writeJson('settings.json', settings);
    if (reconnect) { serviceDisconnect(); serviceConnect(); }
    return remoteStatus();
  });
  ipcMain.handle('invite-create', () => new Promise((resolve) => {
    if (svc.state !== 'online') return resolve({ error: 'offline' });
    const done = (m) => { clearTimeout(timer); resolve(m); };
    const timer = setTimeout(() => { svc.inviteWaiters = svc.inviteWaiters.filter((w) => w !== done); resolve({ error: 'timeout' }); }, 8000);
    svc.inviteWaiters.push(done);
    svcSend({ type: 'invite' });
  }));
  ipcMain.on('share-state', (_e, state) => {
    share = { active: !!state.active, title: String(state.title || '') };
    for (const v of approvedViewers()) send(v, { type: 'state', sharing: share.active, title: share.title });
    svcSend({ type: 'state', sharing: share.active, title: share.title, name: settings.name });
    updateTray();
  });
  ipcMain.on('signal-out', (_e, id, msg) => {
    const v = viewers.get(id);
    if (v && v.approved) send(v, msg);
  });
  ipcMain.on('kick', (_e, id) => {
    const v = viewers.get(id);
    if (v) v.close();
  });
  ipcMain.handle('allowed-list', () => allowed);
  ipcMain.handle('allowed-forget', (_e, deviceId) => {
    delete allowed[deviceId];
    writeJson('allowed.json', allowed);
    for (const v of [...viewers.values()]) if (v.deviceId === deviceId) v.close();
    return allowed;
  });
}

// ---------- capture source ----------
function registerDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const src = sources.find((s) => s.id === selected.sourceId)
        || sources.find((s) => s.id.startsWith('screen:')) || sources[0];
      const result = { video: src };
      // Windows only: capture everything the PC plays (WASAPI loopback).
      if (selected.audio && process.platform === 'win32') result.audio = 'loopback';
      callback(result);
    } catch (e) {
      console.error('[capture]', e);
      callback({});
    }
  });
}

// ---------- EsteefCast service (friends outside the home) ----------
const SERVICE_DEFAULT = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'service.json'), 'utf8')).url || ''; } catch { return ''; }
})();
const SERVICE_CERT_FILE = env.ESTEEFCAST_SERVICE_CERT || path.join(__dirname, 'assets', 'service-cert.pem');
const svc = { ws: null, state: 'off', error: '', stun: [], retry: 0, timer: null, inviteWaiters: [], registered: false };
const svcSessions = new Map(); // sid -> viewer

function serviceUrl() {
  return String(env.ESTEEFCAST_SERVICE || settings.serviceUrl || SERVICE_DEFAULT || '').trim();
}
function remoteStatus() {
  return {
    enabled: !!settings.remoteEnabled, state: svc.state, error: svc.error,
    url: serviceUrl(), defaultUrl: SERVICE_DEFAULT, remoteKbps: Number(settings.remoteKbps) || 8000,
  };
}
function setServiceState(state, error = '') {
  svc.state = state;
  svc.error = error;
  toRenderer('remote-status', remoteStatus());
}
function svcSend(m) {
  if (svc.ws && svc.ws.readyState === 1 && (svc.registered || m.type === 'register')) svc.ws.send(JSON.stringify(m));
}

function serviceConnect() {
  clearTimeout(svc.timer);
  if (!settings.remoteEnabled) return setServiceState('off');
  const base = serviceUrl();
  if (!/^wss:\/\/[^/]+/i.test(base) || /YOUR-/i.test(base)) return setServiceState('error', 'No EsteefCast service address is set.');
  let ca;
  try { ca = fs.readFileSync(SERVICE_CERT_FILE); } catch { return setServiceState('error', 'This copy of EsteefCast is missing its service certificate.'); }
  setServiceState('connecting', svc.error);
  svc.registered = false;
  const ws = new WsClient(base.replace(/\/+$/, '') + '/host', {
    ca, checkServerIdentity: () => undefined, handshakeTimeout: 8000,
  });
  svc.ws = ws;
  ws.on('open', () => svcSend({
    type: 'register', hostId: settings.hostId, secret: settings.hostSecret,
    name: settings.name, sharing: share.active, title: share.title,
  }));
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (m && typeof m.type === 'string') onServiceMessage(m);
  });
  ws.on('error', (e) => { svc.error = `Can't reach the EsteefCast service (${e.code || e.message}). Retrying…`; });
  ws.on('close', () => {
    if (svc.ws !== ws) return;
    svc.ws = null;
    svc.registered = false;
    for (const v of [...viewers.values()]) if (v.remote) v.drop();
    if (!settings.remoteEnabled) return setServiceState('off');
    if (svc.state === 'error') return;
    setServiceState('connecting', svc.error || 'Lost the EsteefCast service. Reconnecting…');
    svc.retry = Math.min(svc.retry + 1, 5);
    svc.timer = setTimeout(serviceConnect, 1000 * 2 ** svc.retry);
  });
}

function serviceDisconnect() {
  clearTimeout(svc.timer);
  const ws = svc.ws;
  svc.ws = null;
  svc.registered = false;
  svc.error = '';
  for (const v of [...viewers.values()]) if (v.remote) v.drop();
  if (ws) ws.close();
  setServiceState('off');
}

function onServiceMessage(m) {
  switch (m.type) {
    case 'registered':
      svc.retry = 0;
      svc.registered = true;
      svc.stun = Array.isArray(m.stun) ? m.stun.filter((u) => typeof u === 'string') : [];
      setServiceState('online');
      break;
    case 'error':
      if (m.reason === 'bad-secret') {
        setServiceState('error', 'The service already knows this PC with a different key.');
        if (svc.ws) svc.ws.close();
      }
      break;
    case 'invite': {
      const w = svc.inviteWaiters.shift();
      if (w) w(m);
      break;
    }
    case 'redeem': {
      // A friend's TV typed an invite code we made: remember it, with its own key.
      const deviceId = String(m.deviceId || '').slice(0, 64);
      const name = String(m.name || 'TV').replace(/[\r\n]/g, ' ').slice(0, 60);
      if (!deviceId) return svcSend({ type: 'redeem-result', rid: m.rid, ok: false, reason: 'bad-device' });
      const token = crypto.randomBytes(32).toString('base64url');
      allowed[deviceId] = { name, remote: true, tokenHash: sha256(token), added: new Date().toISOString() };
      writeJson('allowed.json', allowed);
      svcSend({ type: 'redeem-result', rid: m.rid, code: m.code, ok: true, token });
      toRenderer('allowed-changed');
      toRenderer('invite-used', { code: m.code, name });
      if (tray && process.platform === 'win32') tray.displayBalloon({ title: APP_NAME, content: `${name} can now watch from their home.`, iconType: 'info' });
      break;
    }
    case 'open': {
      const a = allowed[m.deviceId];
      if (!a || !a.remote || !sameHash(a.tokenHash, sha256(m.token || ''))) {
        return svcSend({ type: 'reject', sid: m.sid, reason: 'unauthorized' });
      }
      const sid = String(m.sid);
      const v = {
        id: crypto.randomUUID(), sid, remote: true, ip: String(m.ip || 'internet'),
        deviceId: m.deviceId, name: a.name, kind: 'tv', approved: false, open: true,
        send: (msg) => { if (v.open) svcSend({ type: 'msg', sid, msg }); },
        close: () => { if (!v.open) return; v.open = false; svcSend({ type: 'close', sid }); removeViewer(v); },
        drop: () => { v.open = false; removeViewer(v); },
        isOpen: () => v.open,
      };
      viewers.set(v.id, v);
      svcSessions.set(sid, v);
      svcSend({ type: 'accept', sid });
      break;
    }
    case 'msg': {
      const v = svcSessions.get(m.sid);
      if (v && m.msg && typeof m.msg.type === 'string') onViewerMessage(v, m.msg);
      break;
    }
    case 'close': {
      const v = svcSessions.get(m.sid);
      if (v) v.drop();
      break;
    }
  }
}

// ---------- window + tray ----------
const ICON = path.join(__dirname, 'assets', 'icon.png');
const TRAY_ICON = path.join(__dirname, 'assets', 'tray.png');

function createWindow() {
  win = new BrowserWindow({
    width: 1040, height: 720, minWidth: 780, minHeight: 560,
    title: APP_NAME, backgroundColor: '#141619', icon: ICON, autoHideMenuBar: true,
    show: !(TEST && env.ESTEEFCAST_HIDE === '1'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (tray && !settings.trayHintShown && process.platform === 'win32') {
      tray.displayBalloon({ title: APP_NAME, content: 'EsteefCast is still running here. TVs can keep watching.', iconType: 'info' });
      settings.trayHintShown = true;
      writeJson('settings.json', settings);
    }
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function updateTray() {
  if (!tray) return;
  const n = approvedViewers().length;
  const status = share.active
    ? `Sharing${share.title ? ` "${share.title}"` : ''} · ${n} watching`
    : `Not sharing · ${n} connected`;
  tray.setToolTip(`${APP_NAME} — ${status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status, enabled: false },
    { type: 'separator' },
    { label: 'Open EsteefCast', click: showWindow },
    { label: 'Stop sharing', enabled: share.active, click: () => toRenderer('tray-stop') },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const img = nativeImage.createFromPath(TRAY_ICON);
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.on('click', showWindow);
  updateTray();
}

// ---------- test helpers ----------
function openTestWindows() {
  if (env.ESTEEFCAST_TEST_PATTERN === '1') {
    const pat = new BrowserWindow({
      width: 1280, height: 720, x: 40, y: 40, title: 'EsteefCast Test Pattern',
      backgroundColor: '#000000', autoHideMenuBar: true,
      webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
    });
    // The packaged app has no test folder; the test passes the file's path in.
    pat.loadFile(env.ESTEEFCAST_PATTERN_FILE || path.join(__dirname, 'test', 'pattern.html'));
  }
  if (env.ESTEEFCAST_TEST_VIEWER === '1') {
    const viewer = new BrowserWindow({
      width: 960, height: 540, x: 360, y: 300, title: 'EsteefCast Test Viewer',
      autoHideMenuBar: true,
      webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
    });
    viewer.loadURL(`http://127.0.0.1:${WEB_PORT}/?test=1`);
  }
}

// ---------- start ----------
const gotLock = TEST || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    app.setAppUserModelId('ai.esteef.esteefcast');
    settings = readJson('settings.json', {
      hostId: crypto.randomUUID(), name: os.hostname(), quality: '1080p60', audio: true, sourceId: null,
      remoteEnabled: false, remoteKbps: 8000, serviceUrl: '',
    });
    if (!settings.hostSecret) settings.hostSecret = crypto.randomBytes(32).toString('base64url');
    if (TEST && env.ESTEEFCAST_REMOTE === '1') settings.remoteEnabled = true;
    writeJson('settings.json', settings);
    allowed = TEST ? {} : readJson('allowed.json', {});
    registerIpc();
    registerDisplayMedia();
    startServer();
    startDiscovery();
    createWindow();
    createTray();
    serviceConnect();
    if (TEST) setTimeout(openTestWindows, 300);
  });
  app.on('before-quit', () => { quitting = true; });
  // Tests run their own service with a throwaway certificate.
  app.on('certificate-error', (event, _wc, _url, _err, _cert, callback) => {
    if (TEST) { event.preventDefault(); callback(true); } else callback(false);
  });
  app.on('window-all-closed', () => { /* stay in the tray */ });
}
