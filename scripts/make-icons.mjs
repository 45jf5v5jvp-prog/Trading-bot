/*
 * Generates the app icons from scratch — no image dependencies.
 * A gold golf ball on the app's dark-green ink, matching the Side Action palette.
 * Renders at 4x and box-downsamples for smooth, anti-aliased edges.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'public');

// Palette (from the app's day theme)
const BG = [0x17, 0x29, 0x1f];   // chalk / ink green
const BALL = [0xf2, 0xc2, 0x30]; // ball gold
const HI = [0xff, 0xff, 0xff];   // specular highlight
const RING = [0x0c, 0x1b, 0x14]; // felt-dark ring around the ball

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Render one icon at the given size, supersampled by `ss` for smooth edges.
function render(size, { fullBleed = true } = {}) {
  const ss = 4;
  const S = size * ss;
  const buf = Buffer.alloc(S * S * 4);

  const cx = S / 2;
  const cy = S / 2;
  const ballR = S * 0.30;
  const ringR = ballR + S * 0.028;
  const hiR = ballR * 0.30;
  const hiX = cx - ballR * 0.34;
  const hiY = cy - ballR * 0.34;
  const corner = fullBleed ? 0 : S * 0.22; // iOS masks corners itself; keep full-bleed

  const put = (i, [r, g, b], a = 255) => {
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      // rounded-corner alpha (only used when fullBleed=false)
      let a = 255;
      if (corner > 0) {
        const dxC = Math.max(corner - x, x - (S - corner), 0);
        const dyC = Math.max(corner - y, y - (S - corner), 0);
        if (dxC > 0 && dyC > 0 && Math.hypot(dxC, dyC) > corner) a = 0;
      }
      let col = BG;
      const d = Math.hypot(x - cx, y - cy);
      if (d <= hiR && Math.hypot(x - hiX, y - hiY) <= hiR) col = HI;
      else if (d <= ballR) col = BALL;
      else if (d <= ringR) col = RING;
      put(i, col, a);
    }
  }

  // box downsample
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const i = ((y * ss + dy) * S + (x * ss + dx)) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      }
      const n = ss * ss;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, size, out);
}

const targets = [
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['favicon-32.png', 32],
];

for (const [name, size] of targets) {
  fs.writeFileSync(path.join(OUT, name), render(size));
  console.log('wrote', name, size + 'x' + size);
}
