// Runs a test host sharing the moving test pattern for a while, so a real TV can
// connect to it ("Enter address" → <this PC>:47851). Prints the host's stats
// every 2 s. Usage: node test/serve-pattern.mjs [seconds] [quality]
import { _electron as electron } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const seconds = Number(process.argv[2]) || 90;
const quality = process.argv[3] || '1080p60';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ecast-serve-'));
const app = await electron.launch({
  args: [appDir],
  env: {
    ...process.env, ESTEEFCAST_TEST: '1', ESTEEFCAST_PORT: '47851', ESTEEFCAST_DISCOVERY_PORT: '47850',
    ESTEEFCAST_USERDATA: userData, ESTEEFCAST_TEST_PATTERN: '1', ESTEEFCAST_PATTERN_FILE: path.join(here, 'pattern.html'),
    ESTEEFCAST_AUTOSHARE: 'EsteefCast Test Pattern', ESTEEFCAST_QUALITY: quality,
  },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log(`serving on :47851 for ${seconds}s at ${quality}`);
const end = Date.now() + seconds * 1000;
while (Date.now() < end) {
  await sleep(2000);
  const main = app.windows().find((w) => w.url().endsWith('index.html'));
  const st = main ? await main.evaluate(() => window.__ecastStats).catch(() => null) : null;
  console.log(new Date().toISOString().slice(11, 19), JSON.stringify(st));
}
const main = app.windows().find((w) => w.url().endsWith('index.html'));
const dbg = await main.evaluate(() => window.__ecastDebug).catch(() => null);
fs.writeFileSync(path.join(os.tmpdir(), 'ecast-debug.json'), JSON.stringify(dbg, null, 2));
console.log('debug written to', path.join(os.tmpdir(), 'ecast-debug.json'));
await app.close();
fs.rmSync(userData, { recursive: true, force: true });
