'use strict';
// EsteefCast browser viewer. Same protocol as the TV app.

const params = new URLSearchParams(location.search);
const TEST = params.get('test') === '1';
const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const message = document.getElementById('message');
const unmute = document.getElementById('unmute');
const statsEl = document.getElementById('stats');

let ws = null;
let pc = null;
let hostName = 'the PC';
let lastStats = null;
// Away mode (?rv=wss://service:47900&code=BEAR-1234): reach the PC through the
// EsteefCast service, like a TV at a friend's house.
const RV = params.get('rv');
let remoteStun = [];
window.__viewer = { state: 'connecting', stats: null };

function deviceId() {
  try {
    let id = localStorage.getItem('ecastDeviceId');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('ecastDeviceId', id); }
    return id;
  } catch { return 'web-' + Math.random().toString(36).slice(2); }
}

function show(text) {
  message.textContent = text;
  overlay.classList.remove('hidden');
  window.__viewer.state = text;
}
function hide() { overlay.classList.add('hidden'); }
function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function connect() {
  if (RV) return connectRemote();
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    const ua = navigator.userAgent;
    const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : 'device';
    send({ type: 'hello', deviceId: deviceId(), name: TEST ? 'Test viewer' : `Browser on ${os}`, kind: 'web' });
    show('Waiting for the PC…');
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    onMessage(msg);
  };
  ws.onclose = () => {
    closePeer();
    show('Lost the connection to the PC. Retrying…');
    setTimeout(connect, 2000);
  };
}

const REASONS = {
  offline: 'The PC is off, or EsteefCast is not running on it. Trying again…',
  unauthorized: 'That PC no longer allows this screen. Ask for a new invite code.',
  'bad-code': 'That code is not valid or has expired.',
  'host-offline': 'The PC that made this code is off right now.',
  'slow-down': 'Too many tries. Wait a minute and try again.',
};

function connectRemote() {
  const saved = (() => { try { return JSON.parse(localStorage.getItem('ecastRemote') || 'null'); } catch { return null; } })();
  if (saved && saved.token) return openRemote(saved);
  const code = params.get('code');
  if (!code) return show('Add an invite code to the address (&code=…).');
  const pair = new WebSocket(`${RV}/viewer`);
  pair.onopen = () => pair.send(JSON.stringify({ type: 'redeem', code, deviceId: deviceId(), name: TEST ? 'Test viewer (away)' : 'Browser (away)' }));
  pair.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'paired') {
      const rec = { hostId: m.hostId, hostName: m.hostName, token: m.token };
      try { localStorage.setItem('ecastRemote', JSON.stringify(rec)); } catch {}
      window.__viewer.paired = rec.hostName;
      pair.close();
      openRemote(rec);
    } else if (m.type === 'error') {
      show(REASONS[m.reason] || `Pairing failed (${m.reason}).`);
      pair.close();
    }
  };
  show('Pairing…');
}

function openRemote(rec) {
  hostName = rec.hostName || hostName;
  let opened = false;
  ws = new WebSocket(`${RV}/viewer`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'open', hostId: rec.hostId, token: rec.token, deviceId: deviceId(), name: 'Browser (away)' }));
    show(`Contacting ${hostName}…`);
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'opened') {
      opened = true;
      remoteStun = Array.isArray(msg.stun) ? msg.stun : [];
      send({ type: 'hello', deviceId: deviceId(), name: 'Browser (away)', kind: 'web' });
      return;
    }
    if (msg.type === 'relay-error') {
      show(REASONS[msg.reason] || `Can't connect (${msg.reason}).`);
      if (msg.reason === 'unauthorized') { try { localStorage.removeItem('ecastRemote'); } catch {} }
      return;
    }
    if (opened) onMessage(msg);
  };
  ws.onclose = () => {
    closePeer();
    setTimeout(() => openRemote(rec), 3000);
  };
}

function onMessage(msg) {
  switch (msg.type) {
    case 'pending':
      hostName = msg.hostName || hostName;
      show(`Waiting for someone at ${hostName} to allow this screen…`);
      break;
    case 'denied':
      show(`${hostName} said no.`);
      break;
    case 'full':
      show(`${msg.hostName || hostName} already has ${msg.max} screens watching. Try again later.`);
      break;
    case 'welcome':
    case 'state':
      if (msg.hostName) hostName = msg.hostName;
      if (!msg.sharing) { closePeer(); show(`${hostName} isn't sharing right now. It will appear here when it starts.`); }
      break;
    case 'offer':
      answer(msg.sdp);
      break;
    case 'candidate':
      if (pc && msg.candidate) pc.addIceCandidate({ candidate: msg.candidate, sdpMid: msg.sdpMid, sdpMLineIndex: msg.sdpMLineIndex }).catch(() => {});
      break;
    case 'stopped':
      closePeer();
      show(`${hostName} stopped sharing.`);
      break;
  }
}

async function answer(sdp) {
  closePeer();
  pc = new RTCPeerConnection({ iceServers: RV && remoteStun.length ? [{ urls: remoteStun }] : [] });
  pc.ontrack = (e) => {
    try { e.receiver.jitterBufferTarget = 0; } catch {}
    if (video.srcObject !== e.streams[0]) video.srcObject = e.streams[0];
    if (TEST && e.track.kind === 'audio') measureAudio(e.streams[0]);
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'candidate', candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex });
  };
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'connected') { hide(); window.__viewer.state = 'playing'; tryPlay(); }
    if (pc.connectionState === 'failed') { show('Connection failed. Retrying…'); setTimeout(() => send({ type: 'request' }), 1500); }
  };
  await pc.setRemoteDescription({ type: 'offer', sdp });
  const ans = await pc.createAnswer();
  await pc.setLocalDescription(ans);
  send({ type: 'answer', sdp: pc.localDescription.sdp });
}

// Test only: measure the loudness of the received sound (the video is muted in
// tests, so the stats' audioLevel stays at 0).
function measureAudio(stream) {
  try {
    const ac = new AudioContext();
    const an = ac.createAnalyser();
    ac.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const x of buf) sum += x * x;
      window.__viewer.audioRms = Math.sqrt(sum / buf.length);
    }, 250);
  } catch (e) { console.warn(e); }
}

function closePeer() {
  if (pc) { try { pc.close(); } catch {} pc = null; }
  video.srcObject = null;
}

async function tryPlay() {
  // Browsers block sound until the viewer clicks; TV app has no such limit.
  video.muted = TEST;
  try { await video.play(); unmute.hidden = true; }
  catch {
    video.muted = true;
    try { await video.play(); } catch {}
    unmute.hidden = TEST;
  }
}
unmute.addEventListener('click', () => { video.muted = false; video.play(); unmute.hidden = true; });

// Press S (or tap the top-left corner) for stats.
document.addEventListener('keydown', (e) => { if (e.key === 's' || e.key === 'S') statsEl.hidden = !statsEl.hidden; });

setInterval(async () => {
  if (!pc || pc.connectionState !== 'connected') return;
  const r = await pc.getStats();
  let v = null; let a = null;
  r.forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === 'video') v = s;
    if (s.type === 'inbound-rtp' && s.kind === 'audio') a = s;
  });
  if (!v) return;
  let mbps = 0;
  if (lastStats && v.timestamp > lastStats.t) mbps = ((v.bytesReceived - lastStats.b) * 8) / ((v.timestamp - lastStats.t) / 1000) / 1e6;
  lastStats = { t: v.timestamp, b: v.bytesReceived };
  const codec = r.get(v.codecId);
  const delay = v.jitterBufferEmittedCount ? Math.round((v.jitterBufferDelay / v.jitterBufferEmittedCount) * 1000) : null;
  const s = {
    width: v.frameWidth || 0, height: v.frameHeight || 0, fps: Math.round(v.framesPerSecond || 0),
    mbps: +mbps.toFixed(1), codec: codec ? codec.mimeType : '', decoder: v.decoderImplementation || '',
    framesDecoded: v.framesDecoded || 0, framesDropped: v.framesDropped || 0, jitterBufferMs: delay,
    audioBytes: a ? a.bytesReceived : 0, audioLevel: a ? a.audioLevel || 0 : 0, audioChannels: null,
  };
  if (a) { const ac = r.get(a.codecId); if (ac) s.audioChannels = ac.channels; s.audioCodec = ac ? ac.mimeType : ''; }
  window.__viewer.stats = s;
  statsEl.textContent = `${s.width}×${s.height}  ${s.fps} fps  ${s.mbps} Mbps\n${s.codec} ${s.decoder}\nbuffer ${delay} ms  dropped ${s.framesDropped}\naudio ${s.audioCodec || 'none'} ${s.audioChannels || ''}ch`;
}, 1000);

connect();
