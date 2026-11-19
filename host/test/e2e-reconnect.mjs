// Reconnect test: a viewer watches, leaves, and a new viewer joins the same
// share. Repeats a few times. The second and later viewers must get video too.
// Run: node test/e2e-reconnect.mjs
import { _electron as electron } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const PORT = 47841;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ecast-reconnect-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const exe = process.env.ECAST_EXE;
const app = await electron.launch({
  ...(exe ? { executablePath: exe, args: [] } : { args: [appDir] }),
  env: {
    ...process.env, ESTEEFCAST_TEST: '1', ESTEEFCAST_PORT: String(PORT), ESTEEFCAST_DISCOVERY_PORT: '47840',
    ESTEEFCAST_USERDATA: userData, ESTEEFCAST_TEST_PATTERN: '1', ESTEEFCAST_PATTERN_FILE: path.join(here, 'pattern.html'),
    ESTEEFCAST_AUTOSHARE: process.env.SHARE || 'EsteefCast Test Pattern',
    ESTEEFCAST_PATTERN_STATIC: process.env.STATIC === '1' ? '1' : '',
  },
});

async function watch(round, closeHow) {
  const tag = `r${round}`;
  await app.evaluate(({ BrowserWindow }, [port, t]) => {
    const w = new BrowserWindow({ width: 800, height: 450, title: `viewer ${t}`, webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
    w.loadURL(`http://127.0.0.1:${port}/?test=1&tag=${t}`);
  }, [PORT, tag]);
  let win = null;
  for (let i = 0; i < 40 && !win; i++) { win = app.windows().find((w) => w.url().includes(`tag=${tag}`)); if (!win) await sleep(250); }
  let st = null;
  for (let i = 0; i < 40; i++) {
    st = await win.evaluate(() => window.__viewer).catch(() => null);
    if (st && st.stats && st.stats.framesDecoded > (process.env.STATIC === '1' ? 0 : 60)) break;
    await sleep(250);
  }
  const ok = !!(st && st.stats && st.stats.framesDecoded > (process.env.STATIC === '1' ? 0 : 60));
  check(`viewer ${round} gets video`, ok, st ? `${st.state}, frames ${st.stats ? st.stats.framesDecoded : 0}, ${st.stats ? st.stats.mbps : 0} Mbps` : 'no state');
  // Leave the way a TV does: close the page (socket drops) or go away abruptly.
  if (closeHow === 'close') await win.close();
  else await win.evaluate(() => { window.stop(); location.href = 'about:blank'; });
  await sleep(closeHow === 'close' ? 500 : 3000);
}

try {
  for (let round = 1; round <= 4; round++) await watch(round, round % 2 ? 'close' : 'navigate');
  const host = await app.windows().find((w) => w.url().endsWith('index.html')).evaluate(() => window.__ecastStats);
  console.log('host viewers left:', JSON.stringify(host));
} catch (e) {
  check('test ran', false, e.stack);
} finally {
  await app.close().catch(() => {});
  fs.rmSync(userData, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
