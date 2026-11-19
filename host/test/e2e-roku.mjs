// Roku path test: the host's HLS output, checked with ffprobe/ffmpeg standing in
// for the Roku player. Run: npm run test:roku   (needs ffmpeg + ffprobe on PATH)
import { _electron as electron } from 'playwright-core';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const PORT = 47871;
const BASE = `http://127.0.0.1:${PORT}`;
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'ecast-roku-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (u) => { const r = await fetch(u); return { status: r.status, body: await r.json().catch(() => null) }; };

const exe = process.env.ECAST_EXE; // test a packaged build instead of the source
const app = await electron.launch({
  ...(exe ? { executablePath: exe, args: [] } : { args: [appDir] }),
  env: {
    ...process.env, ESTEEFCAST_TEST: '1', ESTEEFCAST_PORT: String(PORT), ESTEEFCAST_DISCOVERY_PORT: '47870',
    ESTEEFCAST_USERDATA: ud, ESTEEFCAST_TEST_PATTERN: '1', ESTEEFCAST_PATTERN_FILE: path.join(here, 'pattern.html'),
    ESTEEFCAST_AUTOSHARE: 'EsteefCast Test Pattern',
  },
});

try {
  await sleep(5000);
  const denied = await getJson(`${BASE}/hls/live.m3u8`);
  check('stream refused without a key', denied.status === 403, String(denied.status));

  const hello = await getJson(`${BASE}/roku/hello?id=test-roku-1&name=${encodeURIComponent('Test Roku')}`);
  check('Roku hello approved', hello.body && hello.body.ok && hello.body.token, JSON.stringify(hello.body).slice(0, 80));
  const t = hello.body.token;

  const st = await getJson(`${BASE}/roku/state?t=${t}`);
  check('state says sharing', st.body && st.body.sharing === true, JSON.stringify(st.body).slice(0, 100));

  const t0 = Date.now();
  const pl = await fetch(`${BASE}/hls/live.m3u8?t=${t}`);
  const text = await pl.text();
  check('playlist served', pl.status === 200 && text.startsWith('#EXTM3U'), `${pl.status} after ${Date.now() - t0} ms`);
  console.log(text.split('\n').slice(0, 9).join(' | '));

  await sleep(4000); // let a few more chunks build up
  const url = `${BASE}/hls/live.m3u8?t=${t}`;
  const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,profile,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels', '-of', 'json', url], { timeout: 60000 });
  const streams = JSON.parse(probe.stdout).streams || [];
  const v = streams.find((x) => x.codec_name === 'h264');
  const a = streams.find((x) => x.codec_name === 'aac');
  check('video is H.264 High', v && /High/.test(v.profile), v ? `${v.profile} ${v.width}x${v.height} ${v.r_frame_rate}` : JSON.stringify(streams));
  check('audio is AAC stereo 48 kHz', a && a.channels === 2 && a.sample_rate === '48000', a ? `${a.sample_rate} Hz ${a.channels} ch` : 'none');

  // Decode 8 s of the live stream and count errors. ffmpeg's null output writes on a
  // 1/60 s clock, so two captured frames 14 ms apart round to the same tick and it
  // prints "non monotonically increasing dts to muxer" for a clean stream; that line
  // is ignored here and the stream's own timestamps are checked below instead.
  const dec = await run('ffmpeg', ['-hide_banner', '-v', 'error', '-stats_period', '1', '-i', url, '-t', '8', '-fps_mode', 'passthrough', '-f', 'null', '-'], { timeout: 90000 }).catch((e) => e);
  const errText = String(dec.stderr || '');
  const errors = errText.split('\n').filter((l) => /error|corrupt|non-existing|missing|discontinuity|Invalid|concealing/i.test(l) && !/mean_volume|max_volume|dts to muxer/.test(l));
  check('8 s decode without errors', errors.length === 0, errors.slice(0, 3).join(' / ') || 'clean');

  const pk = await run('ffprobe', ['-v', 'error', '-read_intervals', '%+4', '-show_entries', 'packet=stream_index,dts', '-of', 'csv=p=0', url], { timeout: 60000, maxBuffer: 1 << 26 });
  const lastDts = {};
  let backwards = 0, packets = 0;
  for (const line of pk.stdout.split(/\r?\n/)) {
    const [si, d] = line.split(',').map(Number);
    if (!Number.isFinite(d)) continue;
    packets++;
    if (lastDts[si] != null && d <= lastDts[si]) backwards++;
    lastDts[si] = d;
  }
  check('timestamps always increase', packets > 100 && backwards === 0, `${backwards} of ${packets} packets out of order`);

  const count = await run('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-read_intervals', '%+5', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', url], { timeout: 60000 });
  const frames = parseInt(count.stdout, 10);
  check('about 60 fps', frames >= 5 * 50, `${frames} frames in 5 s`);

  const vol = await run('ffmpeg', ['-hide_banner', '-i', url, '-t', '4', '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { timeout: 60000 }).catch((e) => e);
  const mean = (String(vol.stderr).match(/mean_volume: (-?[\d.]+) dB/) || [])[1];
  check('sound present', mean != null && Number(mean) > -60, `mean ${mean} dB`);

  const durs = [...text.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
  check('chunks are about 1 s', durs.length > 0 && durs.every((d) => d > 0.5 && d < 2.1), durs.map((d) => d.toFixed(2)).join(' '));

  const log = await fetch(`${BASE}/roku/log?t=${t}`, { method: 'POST', body: 'hello from the test\nsecond line' });
  const logFile = path.join(ud, 'roku-log.txt');
  check('Roku log saved', log.status === 200 && fs.existsSync(logFile) && /second line/.test(fs.readFileSync(logFile, 'utf8')));

  // Stops by itself when no Roku asks for 20 s.
  await sleep(24000);
  const main = app.windows().find((w) => w.url().endsWith('index.html'));
  const running = await main.evaluate(() => window.ecastHls.running);
  check('Roku encoder stops when nobody watches', running === false, String(running));
} catch (e) {
  check('test ran', false, e.stack || e.message);
} finally {
  await app.close().catch(() => {});
  fs.rmSync(ud, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
