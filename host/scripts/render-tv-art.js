'use strict';
// Renders the Android TV launcher banner (640x360, xhdpi) and copies the icon
// into the TV project. Run: npx electron scripts/render-tv-art.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const res = path.join(root, 'tv', 'app', 'src', 'main', 'res');
const icon = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.png')).toString('base64');

const html = `<!doctype html><html><body style="margin:0;width:640px;height:360px;overflow:hidden;
background:linear-gradient(135deg,#1d2024 0%,#141619 100%);font-family:'Segoe UI',sans-serif;display:flex;align-items:center;gap:30px;padding:0 48px;box-sizing:border-box">
<img src="data:image/png;base64,${icon}" style="width:150px;height:150px">
<div><div style="color:#e4e0d8;font-size:62px;font-weight:600;letter-spacing:1px;line-height:1">EsteefCast</div>
<div style="color:#c4a062;font-size:22px;letter-spacing:4px;margin-top:14px">BY ESTEEF.AI</div></div>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 640, height: 360, show: false, useContentSize: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 640, height: 360 });
  const banner = img.resize({ width: 640, height: 360 });
  fs.mkdirSync(path.join(res, 'drawable-xhdpi'), { recursive: true });
  fs.mkdirSync(path.join(res, 'drawable-nodpi'), { recursive: true });
  fs.writeFileSync(path.join(res, 'drawable-xhdpi', 'banner.png'), banner.toPNG());
  fs.copyFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), path.join(res, 'drawable-nodpi', 'ic_launcher.png'));
  console.log('TV art written to', res);
  app.quit();
});
