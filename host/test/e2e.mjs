// End-to-end test: start the host in test mode, share an animated test window,
// connect the built-in browser viewer, and check discovery, video and audio.
// Run: npm test           (1080p60)
//      npm test -- 2160p60
import { _electron as electron } from 'playwright-core';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const quality = process.argv[2] || '1080p60';
const PORT = 47811;
const DPORT = 47810;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ecast-test-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ECAST_EXE=path\to\EsteefCast.exe tests a packaged build instead of the source.
const exe = process.env.ECAST_EXE;
const app = await electron.launch({
  ...(exe ? { executablePath: exe, args: [] } : { args: [appDir] }),
  cwd: appDir,
  env: {
    ...process.env,
    ESTEEFCAST_PATTERN_FILE: path.join(here, 'pattern.html'),
    ESTEEFCAST_TEST: '1',
    ESTEEFCAST_PORT: String(PORT),
    ESTEEFCAST_DISCOVERY_PORT: String(DPORT),
    ESTEEFCAST_USERDATA: userData,
    ESTEEFCAST_TEST_PATTERN: '1',
    ESTEEFCAST_TEST_VIEWER: '1',
    ESTEEFCAST_AUTOSHARE: 'EsteefCast Test Pattern',
    ESTEEFCAST_QUALITY: quality,
  },
});

try {
  // Discovery
  const reply = await new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    let open = true;
    const done = (v) => { if (!open) return; open = false; clearTimeout(timer); s.close(); resolve(v); };
    const timer = setTimeout(() => done(null), 4000);
    s.on('message', (m) => done(JSON.parse(String(m))));
    s.bind(0, () => {
      const ask = () => { if (open) s.send('ESTEEFCAST_DISCOVER', DPORT, '127.0.0.1'); };
      ask(); setTimeout(ask, 1000); setTimeout(ask, 2000);
    });
  });
  check('discovery reply', !!reply && reply.app === 'EsteefCast' && reply.port === PORT, reply ? `${reply.name}, port ${reply.port}` : 'no reply');

  // Find the viewer window
  let viewer = null;
  for (let i = 0; i < 40 && !viewer; i++) {
    viewer = app.windows().find((w) => w.url().includes(`:${PORT}/`));
    if (!viewer) await sleep(250);
  }
  check('viewer window opened', !!viewer);
  if (!viewer) throw new Error('no viewer');

  // Wait for playback
  let st = null;
  for (let i = 0; i < 40; i++) {
    st = await viewer.evaluate(() => window.__viewer);
    if (st.state === 'playing' && st.stats && st.stats.framesDecoded > 30) break;
    await sleep(500);
  }
  check('viewer connected and playing', st && st.state === 'playing', st ? st.state : '');

  // Let bitrate settle, then measure
  await sleep(5000);
  const samples = [];
  for (let i = 0; i < 5; i++) { samples.push(await viewer.evaluate(() => window.__viewer.stats)); await sleep(1000); }
  const last = samples[samples.length - 1];
  const fps = Math.max(...samples.map((s) => s.fps));
  const mbps = Math.max(...samples.map((s) => s.mbps));
  console.log('viewer stats:', JSON.stringify(last));
  const host = await app.windows()[0].evaluate(() => window.__ecastStats);
  console.log('host stats:', JSON.stringify(host));

  check('codec is H.264', /h264/i.test(last.codec), last.codec);
  const full = await app.windows().find((w) => w.url().includes('pattern.html')).evaluate(() => [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio]);
  check('video has a picture', last.width > 0 && last.height > 0, `${last.width}x${last.height}`);
  check('full resolution kept', last.width >= full[0] * 0.95, `${last.width}x${last.height} of ${full[0]}x${full[1]}`);
  check('frame rate near 60', fps >= 50, `${fps} fps (best of 5 s)`);
  check('bitrate above 3 Mbps', mbps >= 3, `${mbps} Mbps`);
  check('audio arriving', last.audioBytes > 10000, `${last.audioBytes} bytes, level ${last.audioLevel}, ${last.audioChannels} ch`);
  check('audio is stereo', last.audioChannels === 2, String(last.audioChannels));
  const rms = await viewer.evaluate(() => window.__viewer.audioRms || 0);
  check('test tone audible on viewer', rms > 0.005, `rms ${rms.toFixed(4)}`);
  const enc = host && host[0] ? host[0].encoder : '';
  check('encoder reported', !!enc, enc);
} catch (e) {
  check('test ran', false, e.message);
} finally {
  await app.close().catch(() => {});
  fs.rmSync(userData, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
