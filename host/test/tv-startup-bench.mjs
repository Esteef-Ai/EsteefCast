// Start-up benchmark on a real TV. For each variant, runs a test host with a
// 1920x1080 moving pattern and the given bitrate settings, has the TV (over adb)
// open the test host, and scores the first 30 s from the TV's own stats.
//
// The TV must list "<this PC>:47851" (Enter address once; remove it afterwards
// with the remote's menu button).
//
// Usage: node test/tv-startup-bench.mjs <adb-device> <runs> '<variants json>'
//   variants: {"name": {"start":0.6,"min":0,"degrade":"maintain-framerate"}, ...}
import { _electron as electron } from 'playwright-core';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const [device, runsArg, variantsArg] = process.argv.slice(2);
const runs = Number(runsArg) || 3;
const variants = JSON.parse(variantsArg || '{"current":{}}');
const ADB = process.env.ADB || 'adb';
const SECONDS = 30;
const FULL_W = 1800; // the pattern is 1920 wide; anything above this is "full sharpness"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...a) => execFileSync(ADB, ['-s', device, ...a], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });

async function runOnce(tune) {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'ecast-bench-'));
  const app = await electron.launch({
    args: [appDir],
    env: {
      ...process.env, ESTEEFCAST_TEST: '1', ESTEEFCAST_PORT: '47851', ESTEEFCAST_DISCOVERY_PORT: '47850',
      ESTEEFCAST_USERDATA: ud, ESTEEFCAST_TEST_PATTERN: '1', ESTEEFCAST_PATTERN_FILE: path.join(here, 'pattern.html'),
      ESTEEFCAST_PATTERN_SIZE: '1920x1080', ESTEEFCAST_AUTOSHARE: 'EsteefCast Test Pattern', ESTEEFCAST_PATTERN_TONE: '0', ESTEEFCAST_QUALITY: '1080p60',
      ESTEEFCAST_TUNE: JSON.stringify(tune),
    },
  });
  try {
    await sleep(6000);
    // Record the PC's side every second while the TV watches.
    const hostLog = [];
    let watching = true;
    const main = app.windows().find((w) => w.url().endsWith('index.html'));
    const poll = (async () => {
      while (watching) {
        const st = await main.evaluate(() => window.__ecastStats).catch(() => null);
        if (st && st[0]) hostLog.push(st[0]);
        await sleep(1000);
      }
    })();
    const { stdout: out } = await execFileP('sh', [path.resolve(appDir, '..', 'tv', 'tools', 'tv-watch-test.sh'), device, 'EsteefCast Test Pattern', String(SECONDS + 4)],
      { encoding: 'utf8', env: { ...process.env, ADB, MSYS_NO_PATHCONV: '1' }, maxBuffer: 1 << 24 });
    watching = false;
    await poll;
    lastHost = hostLog;
    lastTv = out;
    const rows = [];
    for (const line of out.split('\n')) {
      const m = line.match(/stats (\d+)×(\d+)\s+(\d+) fps\s+([\d.]+) Mbps.*dropped (\d+)/);
      if (m) rows.push({ w: +m[1], h: +m[2], fps: +m[3], mbps: +m[4], dropped: +m[5] });
    }
    return rows.slice(0, SECONDS);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(ud, { recursive: true, force: true });
  }
}

function score(rows) {
  if (rows.length < 10) return null;
  const tFull = rows.findIndex((r) => r.w >= FULL_W);
  const after = rows.slice(2);
  const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
  return {
    tFull: tFull < 0 ? `>${rows.length}` : tFull,
    minW: Math.min(...after.map((r) => r.w)),
    dropped: rows[rows.length - 1].dropped,
    fps: +mean(rows.slice(5).map((r) => r.fps)).toFixed(1),
    slowSecs: rows.slice(3).filter((r) => r.fps < 45).length,
    // resolution changes after the first 2 s: each one costs ~30-40 dropped frames on Fire TV
    switches: rows.slice(2).filter((r, i, a) => i > 0 && r.w !== a[i - 1].w).length,
    mbpsEnd: +mean(rows.slice(-5).map((r) => r.mbps)).toFixed(1),
  };
}

let lastHost = [];
let lastTv = '';
const all = {};
for (let i = 0; i < runs; i++) {
  for (const [name, tune] of Object.entries(variants)) { // interleave variants so Wi-Fi drift hits all equally
    const s = score(await runOnce(tune));
    (all[name] ||= []).push(s);
    console.log(`${name} run ${i + 1}:`, JSON.stringify(s));
    // The PC's own view of the same run, so a missing TV log can't pass for a stall.
    const hs = lastHost.filter((h) => h.state === 'connected' && h.mbps != null).slice(3);
    const pcFps = hs.length ? +(hs.reduce((t, h) => t + (h.fps || 0), 0) / hs.length).toFixed(1) : 0;
    console.log(`  PC side: ${hs.length} s connected, mean ${pcFps} fps sent, ${(hs[hs.length - 1] || {}).mbps?.toFixed?.(1) ?? 0} Mbps at the end`);
    if (!s) console.log('  TV log: ' + (lastTv.split(/\r?\n/).find((l) => /selected|not listed/.test(l)) || 'nothing captured'));
    if (!s || s.fps < 20) { // a stall: keep both sides' evidence
      const f = path.join(os.tmpdir(), `ecast-stall-${name}-${i + 1}.json`);
      fs.writeFileSync(f, JSON.stringify({ host: lastHost, tv: lastTv.split(/\r?\n/).filter((l) => /EsteefCast|Frames received/.test(l)) }, null, 1));
      console.log('  stall evidence:', f);
    }
  }
}
console.log('\n=== summary (per run: lowest width after 2 s, resolution switches, dropped frames, mean fps, seconds under 45 fps, Mbps at the end)');
for (const [name, list] of Object.entries(all)) {
  console.log(name.padEnd(14), list.map((s) => (s ? `${s.minW}w/${s.switches}sw/${s.dropped}d/${s.fps}fps/${s.slowSecs}slow/${s.mbpsEnd}M` : 'no data')).join('   '));
  const ok = list.filter(Boolean);
  const avg = (k) => (ok.reduce((t, s) => t + s[k], 0) / Math.max(1, ok.length)).toFixed(1);
  console.log(''.padEnd(14), `mean: lowest width ${avg('minW')}, switches ${avg('switches')}, dropped ${avg('dropped')}, fps ${avg('fps')}, slow seconds ${avg('slowSecs')}`);
}
try { adb('shell', 'am', 'force-stop', 'ai.esteef.esteefcast'); } catch {}
