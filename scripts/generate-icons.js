#!/usr/bin/env node
/**
 * Generate tray + app icons from scratch using a pure-Node PNG encoder.
 *
 * No native deps (no `canvas`, no `sharp`) — just zlib + a hand-rolled CRC32
 * so this works during `npm install` on every platform without prebuilt
 * binaries. Output:
 *   assets/tray-green.png  32x32 anti-aliased green circle (transparent bg)
 *   assets/tray-red.png    32x32 anti-aliased red circle   (transparent bg)
 *   assets/icon.png        512x512 rounded-square app icon
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// ── CRC32 (PNG spec polynomial 0xedb88320) ──────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── Minimal PNG (RGBA, 8-bit) ───────────────────────────────────────────────
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Each scanline gets a leading filter byte (0 = none)
  const rowLen = width * 4;
  const raw = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowLen + 1)] = 0;
    rgba.copy(raw, y * (rowLen + 1) + 1, y * rowLen, (y + 1) * rowLen);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Drawers ────────────────────────────────────────────────────────────────
function makeCircle(size, r, g, b) {
  const data = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  // Slight inset so the AA edge doesn't touch the bitmap border.
  const radius = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const i = (y * size + x) * 4;
      let a = 0;
      if (d <= radius - 0.5) a = 255;
      else if (d <= radius + 0.5) a = Math.round(255 * (radius + 0.5 - d));
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return encodePng(size, size, data);
}

function insideRoundedRect(x, y, w, h, r) {
  // Closest point to corner; clamp to 0 in straight regions.
  const dx = x < r ? r - x : x > w - 1 - r ? x - (w - 1 - r) : 0;
  const dy = y < r ? r - y : y > h - 1 - r ? y - (h - 1 - r) : 0;
  return Math.sqrt(dx * dx + dy * dy);
}

function makeAppIcon(size) {
  const data = Buffer.alloc(size * size * 4);
  const corner = size * 0.22;
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const innerR = size * 0.32;
  const ringR = size * 0.40;

  // Stagship colors (matching brand): navy bg, emerald accent
  const BG = [15, 23, 42];        // navy-950
  const ACCENT = [16, 185, 129];  // emerald-500
  const RING = [56, 189, 248];    // sky-400

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dEdge = insideRoundedRect(x, y, size, size, corner);
      // Anti-alias the rounded square edge.
      let bgA = 0;
      if (dEdge <= corner - 0.5) bgA = 255;
      else if (dEdge <= corner + 0.5) bgA = Math.round(255 * (corner + 0.5 - dEdge));
      if (bgA === 0) {
        data[i + 3] = 0;
        continue;
      }

      const dC = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);

      let r = BG[0], g = BG[1], b = BG[2];
      // Outer thin ring
      if (dC > ringR - 1.5 && dC <= ringR + 0.5) {
        const t = Math.max(0, Math.min(1, ringR + 0.5 - dC));
        r = Math.round(BG[0] * (1 - t) + RING[0] * t);
        g = Math.round(BG[1] * (1 - t) + RING[1] * t);
        b = Math.round(BG[2] * (1 - t) + RING[2] * t);
      }
      // Solid filled inner circle
      if (dC <= innerR - 0.5) {
        r = ACCENT[0]; g = ACCENT[1]; b = ACCENT[2];
      } else if (dC <= innerR + 0.5) {
        const t = innerR + 0.5 - dC;
        r = Math.round(r * (1 - t) + ACCENT[0] * t);
        g = Math.round(g * (1 - t) + ACCENT[1] * t);
        b = Math.round(b * (1 - t) + ACCENT[2] * t);
      }

      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = bgA;
    }
  }
  return encodePng(size, size, data);
}

// ── Write ─────────────────────────────────────────────────────────────────
const assetsDir = path.join(__dirname, "..", "assets");
fs.mkdirSync(assetsDir, { recursive: true });

const outputs = [
  ["tray-green.png", makeCircle(32, 16, 185, 129)],   // emerald-500
  ["tray-red.png",   makeCircle(32, 220, 38, 38)],    // red-600
  ["icon.png",       makeAppIcon(512)],
];

for (const [name, buf] of outputs) {
  const p = path.join(assetsDir, name);
  fs.writeFileSync(p, buf);
  console.log(`  wrote ${name.padEnd(18)} ${buf.length.toString().padStart(6)} bytes`);
}
