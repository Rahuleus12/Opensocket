/**
 * Generate apps/mobile/app-icon.png — the 1024x1024 source icon that
 * `tauri icon` turns into the full icon set. Dependency-free PNG writer
 * (no ImageMagick on the dev box): dark rounded square, light-blue "socket"
 * disc with a dark center dot.
 *
 *   node scripts/gen-app-icon.ts [outfile]
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const S = 1024;
const out = process.argv[2] ?? "apps/mobile/app-icon.png";

/** Coverage of the rounded-square background at (x, y), 0..1 (AA edges). */
function coverage(x: number, y: number): number {
  const r = 230;
  const rx = Math.min(x, S - 1 - x);
  const ry = Math.min(y, S - 1 - y);
  if (rx >= r && ry >= r) return 1;
  const dx = Math.max(0, r - rx);
  const dy = Math.max(0, r - ry);
  const d = Math.hypot(dx, dy);
  return Math.max(0, Math.min(1, r - d + 0.5));
}

function pixel(x: number, y: number): [number, number, number, number] {
  const bg = coverage(x, y);
  if (bg <= 0) return [0, 0, 0, 0];
  let [r, g, b] = [15, 17, 21]; // #0f1115
  const d = Math.hypot(x - S / 2, y - S / 2);
  if (d < 128) [r, g, b] = [15, 17, 21]; // dark center dot
  else if (d < 264) [r, g, b] = [125, 211, 252]; // #7dd3fc disc
  else if (d < 336) [r, g, b] = [35, 38, 46]; // #23262e ring
  return [r, g, b, Math.round(bg * 255)];
}

// --- minimal PNG encoder (color type 6, 8-bit, filter 0) ---

const raw = Buffer.alloc(S * (1 + S * 4));
let o = 0;
for (let y = 0; y < S; y++) {
  raw[o++] = 0; // filter: none
  for (let x = 0; x < S; x++) {
    const [r, g, b, a] = pixel(x, y);
    raw[o++] = r;
    raw[o++] = g;
    raw[o++] = b;
    raw[o++] = a;
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
