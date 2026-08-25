/*
 * Generates the app icons from the "The Wager" mark — a bold gold $ on betting
 * felt, ringed by a cream chip edge and a dashed gold inner ring. Matches the
 * Golf Bets Tracker home-screen icon.
 *
 * The mark is defined once as SVG (below) and rasterized with a headless Chrome
 * (no npm image dependencies). It renders a 1024px master, then area-downsamples
 * to each target size for smooth edges. If no Chrome/Chromium is found the script
 * exits without touching the existing PNGs, so it never overwrites them with a
 * half-rendered fallback.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'public');

// --- the mark, as a self-contained SVG (1024px, full-bleed) ---
const SVG = `<svg width="1024" height="1024" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="felt" cx="50%" cy="38%" r="78%">
      <stop offset="0" stop-color="#1C7049"/>
      <stop offset="1" stop-color="#0B3D28"/>
    </radialGradient>
  </defs>
  <rect width="100" height="100" fill="url(#felt)"/>
  <circle cx="50" cy="50" r="39" fill="none" stroke="#EFEAD9" stroke-width="1.6" opacity="0.55"/>
  <circle cx="50" cy="50" r="33" fill="none" stroke="#E7B23C" stroke-width="1.4" stroke-dasharray="2 4.4" opacity="0.9"/>
  <text x="50" y="51.5" text-anchor="middle" dominant-baseline="central"
        font-family="'Liberation Sans','Arial','Helvetica',sans-serif" font-weight="700" font-size="56"
        fill="#E7B23C" stroke="#E7B23C" stroke-width="2.4" paint-order="stroke" stroke-linejoin="round">$</text>
</svg>`;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#0B3D28}
  svg{display:block;position:fixed;top:0;left:0}
</style></head><body>${SVG}</body></html>`;

// --- find a Chrome/Chromium binary ---
function findChrome() {
  const cands = [];
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (pw) {
    try {
      for (const d of fs.readdirSync(pw)) {
        if (/^chromium-\d+$/.test(d)) cands.push(path.join(pw, d, 'chrome-linux', 'chrome'));
      }
    } catch {}
  }
  cands.push(
    process.env.CHROME_PATH || '',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  );
  return cands.find((c) => c && fs.existsSync(c));
}

// --- PNG decode (8-bit, color type 2/6, no interlace) ---
function paeth(a, b, c) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
function decodePNG(buf) {
  let p = 8, width = 0, height = 0, depth = 0, ctype = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString('latin1', p + 4, p + 8); const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || (ctype !== 2 && ctype !== 6)) throw new Error(`unsupported PNG depth=${depth} ctype=${ctype}`);
  const ch = ctype === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch; const out = Buffer.alloc(height * stride); let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)]; const row = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride); const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0; let v = row[i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1; else if (ft === 4) v += paeth(a, b, c);
      cur[i] = v & 255;
    }
    cur.copy(out, y * stride); prev = cur;
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++) { rgba[j++] = out[i * ch]; rgba[j++] = out[i * ch + 1]; rgba[j++] = out[i * ch + 2]; rgba[j++] = ch === 4 ? out[i * ch + 3] : 255; }
  return { width, height, rgba };
}

// --- area-average downsample ---
function resample(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * sh / dh), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sh / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sw / dw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sw / dw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) { const i = (sy * sw + sx) * 4; r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++; }
      const o = (y * dw + x) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

// --- PNG encode (RGBA) ---
function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const body = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0); return Buffer.concat([len, body, crc]); }
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = width * 4; const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// --- run ---
const chrome = findChrome();
if (!chrome) {
  console.error('No Chrome/Chromium found — set CHROME_PATH to a Chrome binary and re-run.');
  console.error('Existing icons in public/ were left untouched.');
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbt-icons-'));
const htmlPath = path.join(tmp, 'icon.html');
const masterPath = path.join(tmp, 'master.png');
fs.writeFileSync(htmlPath, HTML);

const res = spawnSync(chrome, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--window-size=1024,1024',
  '--default-background-color=00000000',
  '--screenshot=' + masterPath, 'file://' + htmlPath,
], { stdio: 'ignore' });

if (res.status !== 0 || !fs.existsSync(masterPath)) {
  console.error('Chrome failed to render the icon; existing PNGs left untouched.');
  process.exit(1);
}

const { width, height, rgba } = decodePNG(fs.readFileSync(masterPath));
for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512], ['favicon-32.png', 32]]) {
  fs.writeFileSync(path.join(OUT, name), encodePNG(size, size, resample(rgba, width, height, size, size)));
  console.log('wrote', name, size + 'x' + size);
}
fs.rmSync(tmp, { recursive: true, force: true });
