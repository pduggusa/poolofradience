// Usage: npm run art:preview            -> writes art-preview.png (a contact sheet of every sprite, 8x scale)
// Dependency-free PNG writer so modders can check their pixel art without a browser.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { loadWorld } from "../engine/world.js";
import { EGA } from "../engine/ega.js";

const world = loadWorld(join(import.meta.dirname, "..", "packs"));
const SCALE = 8, PAD = 4, BG = [0x22, 0x22, 0x44];
const sprites = [...world.sprites.entries()];
const cell = (rows: string[]) => ({ w: rows[0]!.length * SCALE, h: rows.length * SCALE });
const perRow = 4, cw = Math.max(...sprites.map(([, r]) => cell(r).w)) + PAD * 2, ch = Math.max(...sprites.map(([, r]) => cell(r).h)) + PAD * 2;
const W = cw * perRow, H = ch * Math.ceil(sprites.length / perRow);
const px = Buffer.alloc(W * H * 3); for (let i = 0; i < W * H; i++) px.set(BG, i * 3);
sprites.forEach(([, rows], n) => {
  const ox = (n % perRow) * cw + PAD, oy = Math.floor(n / perRow) * ch + PAD;
  rows.forEach((row, y) => [...row].forEach((c, x) => {
    if (c === ".") return;
    const rgb = EGA[parseInt(c, 16)]!;
    for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) px.set(rgb, ((oy + y * SCALE + dy) * W + ox + x * SCALE + dx) * 3);
  }));
});
// --- minimal PNG encoder ---
const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const raw = Buffer.alloc((W * 3 + 1) * H); for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
const out = process.argv[2] ?? "art-preview.png";
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
console.log(`${sprites.length} sprites -> ${out} (${sprites.map(([k]) => k).join(", ")})`);
