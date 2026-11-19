'use strict';
// Media settings shared by the host renderer.

const QUALITY = {
  '720p60': { w: 1280, h: 720, fps: 60, kbps: 10000 },
  '1080p60': { w: 1920, h: 1080, fps: 60, kbps: 20000 },
  '1440p60': { w: 2560, h: 1440, fps: 60, kbps: 35000 },
  '2160p60': { w: 3840, h: 2160, fps: 60, kbps: 60000 },
};
const MAX_KBPS = 60000;

// H.264 first: TV chips decode it in hardware. High profile before baseline,
// packetization-mode=1 first. Everything else keeps its relative order.
function preferH264(transceiver) {
  if (!transceiver.setCodecPreferences || !RTCRtpReceiver.getCapabilities) return;
  const caps = RTCRtpReceiver.getCapabilities('video');
  if (!caps) return;
  const rank = (c) => {
    const mime = c.mimeType.toLowerCase();
    const fmtp = c.sdpFmtpLine || '';
    if (mime === 'video/h264') {
      const pm1 = fmtp.includes('packetization-mode=1');
      const high = /profile-level-id=64/i.test(fmtp);
      return (pm1 ? 0 : 2) + (high ? 0 : 1);
    }
    if (mime === 'video/rtx' || mime === 'video/red' || mime === 'video/ulpfec' || mime === 'video/flexfec-03') return 5;
    if (mime === 'video/vp8') return 6;
    if (mime === 'video/vp9') return 7;
    return 8;
  };
  const sorted = caps.codecs.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c);
  try { transceiver.setCodecPreferences(sorted); } catch (e) { console.warn('codec prefs', e); }
}

// Edit the viewer's answer before applying it: start the video at a high bitrate
// instead of ramping up from ~300 kbps, and send Opus in stereo at full quality.
function tuneAnswer(sdp, startKbps, minKbps = 0) {
  const lines = sdp.split('\r\n');
  const codecOf = {};
  for (const l of lines) {
    const m = l.match(/^a=rtpmap:(\d+) ([^/]+)\//);
    if (m) codecOf[m[1]] = m[2].toUpperCase();
  }
  return lines.map((l) => {
    const m = l.match(/^a=fmtp:(\d+) (.*)$/);
    if (!m) return l;
    const codec = codecOf[m[1]];
    if (['H264', 'VP8', 'VP9', 'AV1'].includes(codec)) {
      const parts = m[2].split(';').filter((p) => !/^x-google-(start|max|min)-bitrate=/.test(p));
      parts.push(`x-google-start-bitrate=${startKbps}`, `x-google-max-bitrate=${MAX_KBPS}`);
      if (minKbps > 0) parts.push(`x-google-min-bitrate=${minKbps}`);
      return `a=fmtp:${m[1]} ${parts.join(';')}`;
    }
    if (codec === 'OPUS') {
      const parts = m[2].split(';').filter((p) => !/^(stereo|sprop-stereo|maxaveragebitrate|usedtx)=/.test(p));
      parts.push('stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=510000', 'usedtx=0');
      return `a=fmtp:${m[1]} ${parts.join(';')}`;
    }
    return l;
  }).join('\r\n');
}
