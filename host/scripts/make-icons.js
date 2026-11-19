'use strict';
// Draws the EsteefCast icon (a TV with a broadcast arc, brass on charcoal) into
// PNG files with no image libraries. Run: npm run icons
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CHARCOAL = [29, 32, 36];
const BRASS = [196, 160, 98];
const CREAM = [228, 224, 216];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Signed distance to a rounded box centred at (cx, cy).
function sdRoundBox(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Colour of one sample point in a 0..1 unit square. Returns [r,g,b,a] or null.
function sample(u, v, bg) {
  let col = null;
  if (bg) {
    if (sdRoundBox(u, v, 0.5, 0.5, 0.5, 0.5, 0.2) <= 0) col = CHARCOAL;
    else return null;
  }
  // TV body outline
  const d = sdRoundBox(u, v, 0.5, 0.47, 0.32, 0.22, 0.05);
  if (Math.abs(d) <= 0.035) col = BRASS;
  // Stand
  if (Math.abs(u - 0.5) < 0.12 && Math.abs(v - 0.8) < 0.025) col = BRASS;
  // Broadcast arcs inside the screen, centred low-left like a cast symbol
  const r = Math.hypot(u - 0.36, v - 0.58);
  const inside = u >= 0.36 && v <= 0.58;
  if (inside && Math.abs(r - 0.1) < 0.025) col = CREAM;
  if (inside && Math.abs(r - 0.19) < 0.025) col = CREAM;
  if (r < 0.035) col = CREAM;
  return col;
}

function draw(size, bg) {
  const ss = 4; // supersampling for smooth edges
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size, bg);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
        }
      }
      const i = (y * size + x) * 4;
      const n = ss * ss;
      if (a) { buf[i] = r / a; buf[i + 1] = g / a; buf[i + 2] = b / a; }
      buf[i + 3] = Math.round((a / n) * 255);
    }
  }
  return png(size, size, buf);
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), draw(256, true));
fs.writeFileSync(path.join(out, 'tray.png'), draw(32, true));
fs.writeFileSync(path.join(out, 'tray@2x.png'), draw(64, true));
console.log('icons written to', out);
