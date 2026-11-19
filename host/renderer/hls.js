'use strict';
/* global ecast */
// Roku output: a second, independent encode of the shared screen, packed as
// MPEG-TS chunks for HLS (the only live format a Roku plays). Runs only while
// a Roku is watching. Video: H.264 High on the hardware encoder; audio: AAC-LC.

const HLS_PRESETS = {
  '1080p60': { w: 1920, h: 1080, fps: 60, kbps: 10000, codec: 'avc1.64002A' },
  '1080p30': { w: 1920, h: 1080, fps: 30, kbps: 7000, codec: 'avc1.640028' },
  '720p60': { w: 1280, h: 720, fps: 60, kbps: 6000, codec: 'avc1.640020' },
};
const SEGMENT_SECONDS = 1;

// ---------- MPEG-TS muxer ----------
const TS = 188;
const PID_PMT = 0x1000;
const PID_VIDEO = 0x100;
const PID_AUDIO = 0x101;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32mpeg(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  return crc >>> 0;
}

class TsMuxer {
  constructor(hasAudio) {
    this.hasAudio = hasAudio;
    this.cc = {};
    this.out = [];
  }

  takeBytes() {
    const total = this.out.reduce((n, p) => n + p.length, 0);
    const buf = new Uint8Array(total);
    let o = 0;
    for (const p of this.out) { buf.set(p, o); o += p.length; }
    this.out = [];
    return buf;
  }

  nextCc(pid) {
    const c = this.cc[pid] || 0;
    this.cc[pid] = (c + 1) & 0x0f;
    return c;
  }

  // One section (PAT/PMT) in a single packet.
  section(pid, body) {
    const p = new Uint8Array(TS).fill(0xff);
    p[0] = 0x47; p[1] = 0x40 | (pid >> 8); p[2] = pid & 0xff; p[3] = 0x10 | this.nextCc(pid);
    p[4] = 0; // pointer field
    const crc = crc32mpeg(body);
    p.set(body, 5);
    const e = 5 + body.length;
    p[e] = crc >>> 24; p[e + 1] = (crc >>> 16) & 0xff; p[e + 2] = (crc >>> 8) & 0xff; p[e + 3] = crc & 0xff;
    this.out.push(p);
  }

  writeTables() {
    // PAT: program 1 -> PMT PID
    const pat = [0x00, 0xb0, 13, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (PID_PMT >> 8), PID_PMT & 0xff];
    pat[2] = pat.length - 3 + 4;
    this.section(0, pat);
    // PMT: H.264 video (0x1B, also the PCR PID), optional AAC/ADTS audio (0x0F)
    const streams = [0x1b, 0xe0 | (PID_VIDEO >> 8), PID_VIDEO & 0xff, 0xf0, 0x00];
    if (this.hasAudio) streams.push(0x0f, 0xe0 | (PID_AUDIO >> 8), PID_AUDIO & 0xff, 0xf0, 0x00);
    const pmt = [0x02, 0xb0, 0, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe0 | (PID_VIDEO >> 8), PID_VIDEO & 0xff, 0xf0, 0x00, ...streams];
    pmt[2] = pmt.length - 3 + 4;
    this.section(PID_PMT, pmt);
  }

  // 33-bit PTS in the 5-byte PES layout.
  static pts(bytes, at, marker, t) {
    bytes[at] = (marker << 4) | ((Math.floor(t / 2 ** 30) & 7) << 1) | 1;
    bytes[at + 1] = (t >>> 22) & 0xff;
    bytes[at + 2] = ((t >>> 14) & 0xfe) | 1;
    bytes[at + 3] = (t >>> 7) & 0xff;
    bytes[at + 4] = ((t << 1) & 0xfe) | 1;
  }

  // Packetize one PES (a whole video access unit, or a run of AAC frames).
  pes(pid, streamId, payload, pts90k, { pcr = false, key = false } = {}) {
    const t = Math.round(pts90k) % 2 ** 33;
    const header = new Uint8Array(14);
    header[0] = 0; header[1] = 0; header[2] = 1; header[3] = streamId;
    const len = payload.length + 8;
    const plen = streamId === 0xe0 || len > 0xffff ? 0 : len; // 0 = unbounded (allowed for video)
    header[4] = plen >> 8; header[5] = plen & 0xff;
    header[6] = 0x80; header[7] = 0x80; header[8] = 5;
    TsMuxer.pts(header, 9, 0b0010, t);
    const data = new Uint8Array(header.length + payload.length);
    data.set(header, 0);
    data.set(payload, header.length);

    let off = 0;
    let first = true;
    while (off < data.length) {
      const p = new Uint8Array(TS);
      p[0] = 0x47;
      p[1] = (first ? 0x40 : 0) | (pid >> 8);
      p[2] = pid & 0xff;
      // Adaptation field body (the bytes after its length byte), if any.
      let af = null;
      if (first && (pcr || key)) {
        af = [(key ? 0x40 : 0) | (pcr ? 0x10 : 0)];
        if (pcr) af.push(Math.floor(t / 2 ** 25) & 0xff, (t >>> 17) & 0xff, (t >>> 9) & 0xff, (t >>> 1) & 0xff, ((t & 1) << 7) | 0x7e, 0x00);
      }
      const remain = data.length - off;
      const used = af ? 1 + af.length : 0;
      if (remain < 184 - used) {
        // Not enough payload to fill the packet: pad with adaptation-field stuffing.
        const need = 184 - remain; // bytes the adaptation field must take, incl. its length byte
        if (!af) af = need >= 2 ? [0x00] : [];
        while (1 + af.length < need) af.push(0xff);
      }
      let i = 4;
      if (af) {
        p[3] = 0x30 | this.nextCc(pid);
        p[4] = af.length;
        p.set(af, 5);
        i = 5 + af.length;
      } else {
        p[3] = 0x10 | this.nextCc(pid);
      }
      const n = Math.min(TS - i, remain);
      p.set(data.subarray(off, off + n), i);
      off += n;
      first = false;
      this.out.push(p);
    }
  }
}

// ADTS header for one AAC-LC frame (48 kHz index 3; channel config 1 or 2).
function adts(frameLen, channels, sampleIndex = 3) {
  const len = frameLen + 7;
  return new Uint8Array([
    0xff, 0xf1,
    (1 << 6) | (sampleIndex << 2) | ((channels >> 2) & 1),
    ((channels & 3) << 6) | ((len >> 11) & 3),
    (len >> 3) & 0xff,
    ((len & 7) << 5) | 0x1f,
    0xfc,
  ]);
}

// ---------- the Roku pipeline ----------
class HlsOutput {
  constructor() {
    this.running = false;
    this.seq = 0;
    this.everRan = false;
  }

  async start(stream, presetKey) {
    if (this.running) this.stop();
    const preset = HLS_PRESETS[presetKey] || HLS_PRESETS['1080p60'];
    const srcVideo = stream.getVideoTracks()[0];
    if (!srcVideo) throw new Error('nothing is being shared');
    this.running = true;
    this.preset = preset;
    // Restarting (new source): keep numbering going and mark the break for the player.
    this.discontinuity = this.everRan;
    this.everRan = true;
    this.segStartPts = null;
    this.lastKeyAt = 0;
    this.audioQueue = [];
    this.wallStart = performance.now();

    // Our own copy of the tracks, sized for the Roku, independent of the TVs' WebRTC streams.
    this.vTrack = srcVideo.clone();
    try { await this.vTrack.applyConstraints({ width: { max: preset.w }, height: { max: preset.h }, frameRate: { max: preset.fps } }); } catch {}
    const srcAudio = stream.getAudioTracks()[0];
    this.aTrack = srcAudio ? srcAudio.clone() : null;
    this.mux = new TsMuxer(!!this.aTrack);

    const s = this.vTrack.getSettings();
    const width = Math.min(preset.w, (s.width || preset.w)) & ~1;
    const height = Math.min(preset.h, (s.height || preset.h)) & ~1;
    this.info = { width, height, fps: preset.fps, kbps: preset.kbps, audio: !!this.aTrack };

    this.venc = new VideoEncoder({
      output: (chunk) => this.onVideo(chunk),
      error: (e) => this.fail('video encoder: ' + e.message),
    });
    this.venc.configure({
      codec: preset.codec, width, height, framerate: preset.fps, bitrate: preset.kbps * 1000,
      bitrateMode: 'constant', hardwareAcceleration: 'prefer-hardware', latencyMode: 'realtime',
      avc: { format: 'annexb' },
    });
    this.pumpVideo();

    if (this.aTrack) {
      this.aenc = new AudioEncoder({
        output: (chunk) => this.onAudio(chunk),
        error: (e) => this.fail('audio encoder: ' + e.message),
      });
      const as = this.aTrack.getSettings();
      this.channels = Math.min(2, as.channelCount || 2);
      this.aenc.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: this.channels, bitrate: 160000 });
      this.pumpAudio();
    }
  }

  // Map each track's own timestamps onto one shared clock (90 kHz), anchored at arrival.
  clock(kind, tsMicros) {
    const k = kind + 'Base';
    if (this[k] == null) this[k] = { ts: tsMicros, wall: performance.now() - this.wallStart };
    return 90000 + ((tsMicros - this[k].ts) / 1000 + this[k].wall) * 90;
  }

  async pumpVideo() {
    const reader = new MediaStreamTrackProcessor({ track: this.vTrack }).readable.getReader();
    this.vReader = reader;
    while (this.running) {
      const { value: frame, done } = await reader.read().catch(() => ({ done: true }));
      if (done || !frame) break;
      if (!this.running || this.venc.state !== 'configured' || this.venc.encodeQueueSize > 4) { frame.close(); continue; }
      const now = performance.now();
      const key = now - this.lastKeyAt >= SEGMENT_SECONDS * 1000;
      if (key) this.lastKeyAt = now;
      try { this.venc.encode(frame, { keyFrame: key }); } catch (e) { this.fail(e.message); }
      frame.close();
    }
  }

  async pumpAudio() {
    const reader = new MediaStreamTrackProcessor({ track: this.aTrack }).readable.getReader();
    this.aReader = reader;
    while (this.running) {
      const { value: data, done } = await reader.read().catch(() => ({ done: true }));
      if (done || !data) break;
      if (this.running && this.aenc.state === 'configured') {
        try { this.aenc.encode(data); } catch (e) { this.fail(e.message); }
      }
      data.close();
    }
  }

  onAudio(chunk) {
    const raw = new Uint8Array(chunk.byteLength);
    chunk.copyTo(raw);
    const frame = new Uint8Array(raw.length + 7);
    frame.set(adts(raw.length, this.channels), 0);
    frame.set(raw, 7);
    this.audioQueue.push({ pts: this.clock('audio', chunk.timestamp), frame });
  }

  // Write queued AAC frames up to a time, a few frames per PES.
  flushAudio(uptoPts) {
    while (this.audioQueue.length && this.audioQueue[0].pts <= uptoPts) {
      const run = [];
      while (run.length < 5 && this.audioQueue.length && this.audioQueue[0].pts <= uptoPts) run.push(this.audioQueue.shift());
      const size = run.reduce((n, f) => n + f.frame.length, 0);
      const buf = new Uint8Array(size);
      let o = 0;
      for (const f of run) { buf.set(f.frame, o); o += f.frame.length; }
      this.mux.pes(PID_AUDIO, 0xc0, buf, run[0].pts);
    }
  }

  onVideo(chunk) {
    if (!this.running) return;
    const pts = this.clock('video', chunk.timestamp);
    const key = chunk.type === 'key';
    if (this.segStartPts == null && !key) return; // a segment must start on a keyframe
    if (key && (this.segStartPts == null || pts - this.segStartPts >= SEGMENT_SECONDS * 90000 * 0.9)) {
      if (this.segStartPts != null) this.closeSegment(pts);
      this.segStartPts = pts;
      this.mux.writeTables();
    }
    this.flushAudio(pts);
    const data = new Uint8Array(chunk.byteLength + 6);
    data.set([0, 0, 0, 1, 0x09, 0xf0], 0); // access unit delimiter
    chunk.copyTo(data.subarray(6));
    this.mux.pes(PID_VIDEO, 0xe0, data, pts, { pcr: true, key });
  }

  closeSegment(nextPts) {
    const bytes = this.mux.takeBytes();
    const duration = (nextPts - this.segStartPts) / 90000;
    ecast.hlsSegment({ seq: this.seq++, duration, bytes, info: this.info, discontinuity: this.discontinuity });
    this.discontinuity = false;
  }

  fail(msg) {
    console.error('[hls]', msg);
    ecast.hlsError(msg);
    this.stop();
  }

  stop() {
    this.running = false;
    for (const r of [this.vReader, this.aReader]) { try { r && r.cancel(); } catch {} }
    for (const e of [this.venc, this.aenc]) { try { e && e.state !== 'closed' && e.close(); } catch {} }
    for (const t of [this.vTrack, this.aTrack]) { try { t && t.stop(); } catch {} }
    this.venc = this.aenc = this.vTrack = this.aTrack = this.vReader = this.aReader = null;
    this.videoBase = this.audioBase = null;
  }
}

window.ecastHls = new HlsOutput();
