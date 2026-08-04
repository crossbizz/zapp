#!/usr/bin/env node
// zapp: generates the placeholder application icon set (MAC-2).
//
// Deliberately dependency-free: it rasterises the mark itself (a rounded
// squircle-ish tile with a geometric "z") and encodes PNG/ICO by hand, so
// regenerating the icons needs nothing but node + macOS `iconutil`. The mark is
// a placeholder — a real design pass replaces the geometry in `drawMark`, not
// the pipeline around it.
//
//   node scripts/zapp/generate-icons.mjs
//
// Writes assets/zapp/{icon.icns,icon.png,icon.ico}. forge.config.ts points at
// `./assets/zapp/icon`; @electron/packager appends the per-platform extension.

import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..", "..");
const outputDir = path.join(desktopRoot, "assets", "zapp");

// -- palette ---------------------------------------------------------------

// Indigo -> violet tile, white mark. Placeholder brand colours.
const GRADIENT_TOP = [129, 140, 248]; // #818CF8
const GRADIENT_BOTTOM = [67, 56, 202]; // #4338CA
const MARK = [255, 255, 255];

// -- geometry (all fractions of the canvas edge) ---------------------------

const TILE_INSET = 0.085; // transparent margin, matching macOS app icons
const TILE_RADIUS = 0.2;
const MARK_LEFT = 0.3;
const MARK_RIGHT = 0.7;
const MARK_TOP = 0.305;
const MARK_BOTTOM = 0.695;
const BAR_THICKNESS = 0.072;
const SAMPLES_PER_AXIS = 4; // 16x supersampling

function insideRoundedRect(x, y, min, max, radius) {
  if (x < min || x > max || y < min || y > max) return false;
  const cx = Math.min(Math.max(x, min + radius), max - radius);
  const cy = Math.min(Math.max(y, min + radius), max - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

// The "z": two horizontal bars joined by a diagonal band. The band is measured
// horizontally so its ends meet the bars flush, with the horizontal width
// derived from the desired perpendicular thickness.
function insideMark(x, y) {
  if (y >= MARK_TOP && y <= MARK_TOP + BAR_THICKNESS) {
    if (x >= MARK_LEFT && x <= MARK_RIGHT) return true;
  }
  if (y >= MARK_BOTTOM - BAR_THICKNESS && y <= MARK_BOTTOM) {
    if (x >= MARK_LEFT && x <= MARK_RIGHT) return true;
  }
  if (y < MARK_TOP || y > MARK_BOTTOM) return false;

  if (x < MARK_LEFT || x > MARK_RIGHT) return false;

  const yStart = MARK_TOP + BAR_THICKNESS / 2;
  const yEnd = MARK_BOTTOM - BAR_THICKNESS / 2;
  const dy = yEnd - yStart;
  const dx = MARK_RIGHT - MARK_LEFT;
  const halfWidth = (BAR_THICKNESS * Math.hypot(dx, dy)) / dy / 2;
  const t = (y - yStart) / dy;
  const centerX = MARK_RIGHT - t * dx;
  return Math.abs(x - centerX) <= halfWidth;
}

/** Render one square RGBA bitmap of `size` px. */
function drawMark(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SAMPLES_PER_AXIS);
  const tileMin = TILE_INSET;
  const tileMax = 1 - TILE_INSET;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tileCoverage = 0;
      let markCoverage = 0;

      for (let sy = 0; sy < SAMPLES_PER_AXIS; sy++) {
        for (let sx = 0; sx < SAMPLES_PER_AXIS; sx++) {
          const x = (px * SAMPLES_PER_AXIS + sx + 0.5) * step;
          const y = (py * SAMPLES_PER_AXIS + sy + 0.5) * step;
          if (insideRoundedRect(x, y, tileMin, tileMax, TILE_RADIUS)) {
            tileCoverage++;
            if (insideMark(x, y)) markCoverage++;
          }
        }
      }

      const samples = SAMPLES_PER_AXIS * SAMPLES_PER_AXIS;
      const alpha = tileCoverage / samples;
      const markAlpha = markCoverage / samples;
      const offset = (py * size + px) * 4;

      if (alpha === 0) continue;

      // Vertical gradient across the tile, then the mark composited on top.
      const gradientT = (py + 0.5) / size;
      const mix = markAlpha / alpha;
      for (let channel = 0; channel < 3; channel++) {
        const background =
          GRADIENT_TOP[channel] +
          (GRADIENT_BOTTOM[channel] - GRADIENT_TOP[channel]) * gradientT;
        pixels[offset + channel] = Math.round(
          background + (MARK[channel] - background) * mix,
        );
      }
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }

  return pixels;
}

// -- PNG encoding ----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // 10..12: deflate / adaptive filtering / no interlace, all zero.

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// -- ICO encoding ----------------------------------------------------------

// PNG-compressed ICO entries (Vista+). Windows is not a MAC-2 target, but the
// Squirrel maker needs a branded icon rather than Dyad's.
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;

  entries.forEach((entry, index) => {
    const at = index * 16;
    directory[at] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 2] = 0; // palette size
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32BE(0, at + 8);
    directory.writeUInt32LE(entry.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([
    header,
    directory,
    ...entries.map((entry) => entry.png),
  ]);
}

// -- output ----------------------------------------------------------------

const ICONSET_ENTRIES = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

const ICO_SIZES = [16, 32, 48, 64, 128, 256];

function main() {
  fs.mkdirSync(outputDir, { recursive: true });

  const pngCache = new Map();
  const pngFor = (size) => {
    if (!pngCache.has(size)) {
      pngCache.set(size, encodePng(size, drawMark(size)));
    }
    return pngCache.get(size);
  };

  // .icns via iconutil (macOS only; the committed .icns covers other hosts).
  if (process.platform === "darwin") {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "zapp-iconset-"));
    const iconsetDir = path.join(workDir, "icon.iconset");
    fs.mkdirSync(iconsetDir);
    for (const [name, size] of ICONSET_ENTRIES) {
      fs.writeFileSync(path.join(iconsetDir, name), pngFor(size));
    }
    const icnsPath = path.join(outputDir, "icon.icns");
    execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", icnsPath]);
    fs.rmSync(workDir, { recursive: true, force: true });
    console.log(`wrote ${path.relative(desktopRoot, icnsPath)}`);
  } else {
    console.warn("skipping icon.icns: iconutil is macOS-only");
  }

  const pngPath = path.join(outputDir, "icon.png");
  fs.writeFileSync(pngPath, pngFor(1024));
  console.log(`wrote ${path.relative(desktopRoot, pngPath)}`);

  const icoPath = path.join(outputDir, "icon.ico");
  fs.writeFileSync(
    icoPath,
    encodeIco(ICO_SIZES.map((size) => ({ size, png: pngFor(size) }))),
  );
  console.log(`wrote ${path.relative(desktopRoot, icoPath)}`);
}

main();
