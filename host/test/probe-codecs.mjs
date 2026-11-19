// Asks this PC's Electron which encoders WebCodecs offers for a Roku (HLS) stream.
import { _electron as electron } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const app = await electron.launch({ args: [path.resolve(here, '..')], env: { ...process.env, ESTEEFCAST_TEST: '1', ESTEEFCAST_PORT: '47861', ESTEEFCAST_DISCOVERY_PORT: '47860', ESTEEFCAST_HIDE: '1' } });
const win = await app.firstWindow();
const res = await win.evaluate(async () => {
  const out = {};
  const v = async (codec, hw) => {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width: 1920, height: 1080, bitrate: 8e6, framerate: 60, hardwareAcceleration: hw, avc: { format: 'annexb' }, latencyMode: 'realtime' });
      return r.supported;
    } catch (e) { return 'error ' + e.message; }
  };
  out.h264HighHW = await v('avc1.640028', 'prefer-hardware');
  out.h264HighSW = await v('avc1.640028', 'prefer-software');
  out.h264MainHW = await v('avc1.4d0028', 'prefer-hardware');
  const a = async (codec) => {
    try { return (await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 })).supported; } catch (e) { return 'error ' + e.message; }
  };
  out.aacLC = await a('mp4a.40.2');
  out.opus = await a('opus');
  out.trackProcessor = typeof MediaStreamTrackProcessor;
  return out;
});
console.log(JSON.stringify(res, null, 1));
await app.close();
