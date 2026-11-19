'use strict';
/* global ecast, QUALITY, preferH264, tuneAnswer */

const $ = (id) => document.getElementById(id);
const state = {
  settings: null,
  sources: [],
  kind: 'screen',
  selectedId: null,
  stream: null,
  sharing: false,
  title: '',
  viewers: new Map(), // id -> { id, name, ip, kind, pc, retries, stats, last }
};

// ---------- sources ----------
async function loadSources() {
  try {
    state.sources = await ecast.sources();
  } catch (e) {
    console.error(e);
    state.sources = [];
  }
  if (!state.sources.some((s) => s.id === state.selectedId)) {
    const saved = state.sources.find((s) => s.id === state.settings.sourceId);
    const firstScreen = state.sources.find((s) => s.screen);
    state.selectedId = (saved || firstScreen || {}).id || null;
  }
  renderSources();
}

function renderSources() {
  const grid = $('grid');
  grid.textContent = '';
  const list = state.sources.filter((s) => (state.kind === 'screen' ? s.screen : !s.screen));
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = state.kind === 'screen' ? 'No screens found.' : 'No open windows found.';
    grid.append(p);
  }
  list.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'card' + (s.id === state.selectedId ? ' selected' : '');
    if (s.thumb) {
      const img = document.createElement('img');
      img.src = s.thumb;
      img.alt = '';
      b.append(img);
    } else {
      const d = document.createElement('div');
      d.className = 'noimg';
      b.append(d);
    }
    const n = document.createElement('div');
    n.className = 'name';
    n.textContent = s.screen ? (state.sources.filter((x) => x.screen).length > 1 ? `Screen ${i + 1}` : 'Entire screen') : s.name;
    n.title = s.name;
    b.append(n);
    b.addEventListener('click', () => selectSource(s.id));
    grid.append(b);
  });
  updateShareButton();
}

async function selectSource(id) {
  state.selectedId = id;
  renderSources();
  ecast.setSettings({ sourceId: id });
  if (state.sharing) await switchSource();
}

function sourceTitle(id) {
  const s = state.sources.find((x) => x.id === id);
  if (!s) return '';
  return s.screen ? 'Screen' : s.name;
}

// ---------- capture ----------
async function capture() {
  const q = QUALITY[$('quality').value] || QUALITY['1080p60'];
  const wantAudio = $('audio').checked;
  await ecast.selectSource(state.selectedId, wantAudio);
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: q.fps, max: q.fps }, width: { max: q.w }, height: { max: q.h } },
    audio: wantAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
  });
  const vt = stream.getVideoTracks()[0];
  if (vt) {
    vt.contentHint = 'motion';
    vt.addEventListener('ended', () => { if (state.stream === stream) stopShare(); });
  }
  const note = $('shareNote');
  if (wantAudio && !stream.getAudioTracks().length) {
    note.textContent = 'Sound could not be captured. Sharing picture only.';
    note.className = 'note warn';
  } else {
    note.textContent = '';
    note.className = 'note';
  }
  return stream;
}

async function startShare() {
  if (!state.selectedId || state.sharing) return;
  const btn = $('share');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  try {
    state.stream = await capture();
  } catch (e) {
    console.error(e);
    $('shareNote').textContent = `Couldn't start sharing: ${e.message}`;
    $('shareNote').className = 'note warn';
    btn.disabled = false;
    updateShareButton();
    return;
  }
  state.sharing = true;
  state.title = sourceTitle(state.selectedId);
  ecast.shareState({ active: true, title: state.title });
  for (const v of state.viewers.values()) startPeer(v);
  updateShareButton();
  renderStatus();
}

function stopShare() {
  if (!state.sharing) return;
  state.sharing = false;
  for (const v of state.viewers.values()) closePeer(v, true);
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  ecast.shareState({ active: false, title: '' });
  updateShareButton();
  renderStatus();
  renderViewers();
}

// Switch what is shared without dropping the TVs.
async function switchSource() {
  let next;
  try { next = await capture(); } catch (e) { console.error(e); return; }
  const old = state.stream;
  state.stream = next;
  const vt = next.getVideoTracks()[0] || null;
  const at = next.getAudioTracks()[0] || null;
  for (const v of state.viewers.values()) {
    if (!v.pc) continue;
    for (const t of v.pc.getTransceivers()) {
      const kind = t.receiver.track.kind;
      if (kind === 'video') t.sender.replaceTrack(vt).catch(() => {});
      if (kind === 'audio') t.sender.replaceTrack(at).catch(() => {});
    }
  }
  if (old) old.getTracks().forEach((t) => t.stop());
  state.title = sourceTitle(state.selectedId);
  ecast.shareState({ active: true, title: state.title });
  renderStatus();
}

async function applyQuality() {
  const key = $('quality').value;
  ecast.setSettings({ quality: key });
  if (!state.sharing || !state.stream) return;
  const q = QUALITY[key];
  const vt = state.stream.getVideoTracks()[0];
  try {
    await vt.applyConstraints({ frameRate: { ideal: q.fps, max: q.fps }, width: { max: q.w }, height: { max: q.h } });
  } catch (e) { console.warn('applyConstraints', e); }
  for (const v of state.viewers.values()) if (v.pc) setVideoParams(v.pc, q);
}

// ---------- peers ----------
async function setVideoParams(pc, q) {
  for (const t of pc.getTransceivers()) {
    const s = t.sender;
    const kind = t.receiver.track.kind;
    const p = s.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    if (kind === 'video') {
      p.encodings[0].maxBitrate = q.kbps * 1000;
      p.encodings[0].maxFramerate = q.fps;
      p.encodings[0].networkPriority = 'high';
      p.encodings[0].priority = 'high';
      p.degradationPreference = 'maintain-framerate';
    } else if (kind === 'audio') {
      p.encodings[0].maxBitrate = 510000;
      p.encodings[0].networkPriority = 'high';
    }
    try { await s.setParameters(p); } catch (e) { console.warn('setParameters', kind, e.message); }
  }
}

async function startPeer(v) {
  closePeer(v, false);
  if (!state.sharing || !state.stream) return;
  const q = QUALITY[$('quality').value] || QUALITY['1080p60'];
  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  v.pc = pc;
  v.stats = null;
  v.last = null;
  const vt = state.stream.getVideoTracks()[0];
  const at = state.stream.getAudioTracks()[0];
  const vtx = pc.addTransceiver(vt, { direction: 'sendonly', streams: [state.stream] });
  preferH264(vtx);
  // Always add an audio line so a later switch to a source with sound works.
  pc.addTransceiver(at || 'audio', { direction: 'sendonly', streams: [state.stream] });

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      ecast.signalOut(v.id, { type: 'candidate', candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex });
    }
  };
  pc.onconnectionstatechange = () => {
    if (v.pc !== pc) return;
    if (pc.connectionState === 'connected') v.retries = 0;
    if (pc.connectionState === 'failed') {
      v.retries = (v.retries || 0) + 1;
      if (v.retries <= 5 && state.sharing && state.viewers.has(v.id)) setTimeout(() => startPeer(v), 1000 * v.retries);
    }
    renderViewers();
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await setVideoParams(pc, q);
    ecast.signalOut(v.id, { type: 'offer', sdp: pc.localDescription.sdp, quality: $('quality').value });
  } catch (e) {
    console.error('offer failed', e);
  }
  renderViewers();
}

function closePeer(v, tell) {
  if (v.pc) {
    try { v.pc.close(); } catch {}
    v.pc = null;
  }
  if (tell) ecast.signalOut(v.id, { type: 'stopped' });
}

async function onSignal({ id, msg }) {
  const v = state.viewers.get(id);
  if (!v) return;
  if (msg.type === 'request') { if (state.sharing) startPeer(v); return; }
  if (!v.pc) return;
  try {
    if (msg.type === 'answer' && typeof msg.sdp === 'string') {
      const q = QUALITY[$('quality').value] || QUALITY['1080p60'];
      await v.pc.setRemoteDescription({ type: 'answer', sdp: tuneAnswer(msg.sdp, Math.round(q.kbps * 0.6)) });
    } else if (msg.type === 'candidate' && msg.candidate) {
      await v.pc.addIceCandidate({ candidate: msg.candidate, sdpMid: msg.sdpMid, sdpMLineIndex: msg.sdpMLineIndex });
    } else if (msg.type === 'stats') {
      v.tvStats = msg;
    }
  } catch (e) {
    console.warn('signal', msg.type, e.message);
  }
}

// ---------- stats ----------
async function pollStats() {
  for (const v of state.viewers.values()) {
    if (!v.pc || v.pc.connectionState !== 'connected') { v.stats = null; continue; }
    try {
      const report = await v.pc.getStats();
      let out = null;
      let rtt = null;
      let codec = '';
      const codecs = {};
      report.forEach((r) => { if (r.type === 'codec') codecs[r.id] = r.mimeType; });
      report.forEach((r) => {
        if (r.type === 'outbound-rtp' && r.kind === 'video') { out = r; codec = (codecs[r.codecId] || '').replace('video/', ''); }
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && r.currentRoundTripTime != null) rtt = r.currentRoundTripTime;
      });
      if (!out) continue;
      const now = out.timestamp;
      let mbps = 0;
      if (v.last && now > v.last.t) mbps = ((out.bytesSent - v.last.bytes) * 8) / ((now - v.last.t) / 1000) / 1e6;
      v.last = { t: now, bytes: out.bytesSent };
      v.stats = {
        w: out.frameWidth || 0, h: out.frameHeight || 0, fps: Math.round(out.framesPerSecond || 0),
        mbps, codec, encoder: out.encoderImplementation || '', limit: out.qualityLimitationReason || 'none',
        rtt: rtt == null ? null : Math.round(rtt * 1000),
      };
    } catch {}
  }
  renderViewers();
  window.__ecastStats = [...state.viewers.values()].map((v) => ({ id: v.id, name: v.name, state: v.pc ? v.pc.connectionState : 'idle', ...v.stats }));
}

// ---------- rendering ----------
function renderStatus() {
  const el = $('status');
  const n = [...state.viewers.values()].filter((v) => v.pc && v.pc.connectionState === 'connected').length;
  if (state.sharing) {
    el.className = 'status live';
    el.textContent = `Sharing ${state.title ? `“${state.title}”` : ''} · ${n} watching`;
  } else {
    el.className = 'status idle';
    el.textContent = 'Not sharing';
  }
}

function updateShareButton() {
  const btn = $('share');
  if (state.sharing) {
    btn.disabled = false;
    btn.className = 'primary stop';
    btn.textContent = 'Stop sharing';
  } else {
    btn.className = 'primary';
    btn.disabled = !state.selectedId;
    btn.textContent = state.selectedId ? 'Share to TVs' : 'Choose something to share';
  }
}

function renderViewers() {
  const ul = $('viewers');
  ul.textContent = '';
  $('viewerCount').textContent = String(state.viewers.size);
  if (!state.viewers.size) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No TVs connected yet.';
    ul.append(li);
  }
  for (const v of state.viewers.values()) {
    const li = document.createElement('li');
    li.className = 'item';
    const t = document.createElement('div');
    t.className = 'title';
    t.textContent = v.name;
    const b = document.createElement('button');
    b.textContent = 'Disconnect';
    b.addEventListener('click', () => ecast.kick(v.id));
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = describe(v);
    li.append(t, b, sub);
    ul.append(li);
  }
  renderStatus();
}

function describe(v) {
  if (!state.sharing) return `${v.ip} · waiting for you to share`;
  if (!v.pc) return `${v.ip} · connecting…`;
  const cs = v.pc.connectionState;
  if (cs !== 'connected') return `${v.ip} · ${cs === 'failed' ? 'connection failed, retrying' : 'connecting…'}`;
  const s = v.stats;
  if (!s) return `${v.ip} · connected`;
  const parts = [`${s.w}×${s.h}`, `${s.fps} fps`, `${s.mbps.toFixed(1)} Mbps`];
  if (s.codec) parts.push(s.encoder ? `${s.codec} (${s.encoder})` : s.codec);
  if (s.rtt != null) parts.push(`${s.rtt} ms`);
  if (s.limit && s.limit !== 'none') parts.push(`limited by ${s.limit}`);
  return parts.join(' · ');
}

async function renderAllowed() {
  const list = await ecast.allowedList();
  const ul = $('allowed');
  ul.textContent = '';
  const ids = Object.keys(list);
  if (!ids.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'None yet.';
    ul.append(li);
  }
  for (const id of ids) {
    const li = document.createElement('li');
    li.className = 'item';
    const t = document.createElement('div');
    t.className = 'title';
    t.textContent = list[id].name;
    const b = document.createElement('button');
    b.textContent = 'Forget';
    b.title = 'This TV will have to ask again next time';
    b.addEventListener('click', async () => { await ecast.allowedForget(id); renderAllowed(); });
    li.append(t, b);
    ul.append(li);
  }
}

// ---------- wiring ----------
async function init() {
  state.settings = await ecast.getSettings();
  const s = state.settings;
  $('quality').value = QUALITY[s.quality] ? s.quality : '1080p60';
  $('audio').checked = s.audio !== false;
  $('pcName').value = s.name;
  const addr = $('addresses');
  addr.textContent = '';
  for (const ip of s.ips.slice(0, 3)) {
    const c = document.createElement('code');
    c.textContent = s.port === 47801 ? ip : `${ip}:${s.port}`;
    addr.append(c);
  }
  if (!s.ips.length) addr.textContent = 'This PC is not on a network.';

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    state.kind = t.dataset.kind;
    renderSources();
  }));
  $('refresh').addEventListener('click', loadSources);
  $('share').addEventListener('click', () => (state.sharing ? stopShare() : startShare()));
  $('quality').addEventListener('change', applyQuality);
  $('audio').addEventListener('change', async () => {
    ecast.setSettings({ audio: $('audio').checked });
    if (state.sharing) await switchSource();
  });
  $('pcName').addEventListener('change', () => ecast.setSettings({ name: $('pcName').value.trim() || 'My PC' }));

  ecast.on('viewer-join', (d) => {
    const v = { ...d, pc: null, retries: 0, stats: null, last: null };
    state.viewers.set(d.id, v);
    if (state.sharing) startPeer(v);
    renderViewers();
  });
  ecast.on('viewer-leave', ({ id }) => {
    const v = state.viewers.get(id);
    if (v) closePeer(v, false);
    state.viewers.delete(id);
    renderViewers();
  });
  ecast.on('signal-in', onSignal);
  ecast.on('allowed-changed', renderAllowed);
  ecast.on('tray-stop', stopShare);

  await loadSources();
  renderAllowed();
  renderViewers();
  setInterval(pollStats, 1000);

  // Test mode: share a named window straight away.
  if (s.test && s.test.autoshare) {
    if (s.test.quality && QUALITY[s.test.quality]) $('quality').value = s.test.quality;
    const want = s.test.autoshare;
    for (let i = 0; i < 20; i++) {
      const hit = state.sources.find((x) => x.name === want);
      if (hit) { state.selectedId = hit.id; renderSources(); break; }
      await new Promise((r) => setTimeout(r, 500));
      await loadSources();
    }
    await startShare();
  }
}

init();
