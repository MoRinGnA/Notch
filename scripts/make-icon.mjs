// 노치 눈 모양 아이콘을 코드로 그려 assets/icon.ico·icon.png·tray.png를 만든다.
// 외부 이미지 도구 없이 Node 표준 모듈(zlib)만 쓴다: node scripts/make-icon.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const OUT_DIR = path.join(process.cwd(), "assets");

const BG_TOP = [11, 11, 13];
const BG_BOTTOM = [27, 27, 32];
const EYE = [244, 242, 239];
const ACCENT = [232, 131, 58];

// 네 모서리가 둥근 사각형 안쪽인지 판정한다(점에서 가장 가까운 내부 점까지의 거리).
function insideRoundRect(x, y, x0, y0, x1, y1, radius) {
  const cx = Math.min(Math.max(x, x0 + radius), x1 - radius);
  const cy = Math.min(Math.max(y, y0 + radius), y1 - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

// 4배로 그린 뒤 평균 내어 가장자리를 부드럽게 만든다(알파는 미리 곱해 둔다).
function render(size) {
  const ss = 4;
  const S = size * ss;
  const out = new Uint8Array(size * size * 4);
  const sum = new Float64Array(size * size * 4);

  const pad = S * 0.02;
  const radius = S * 0.22;
  const eyeW = S * 0.18;
  const eyeH = S * 0.125;
  const eyeR = eyeH / 2;
  const eyeGap = S * 0.08;
  const eyeY = S * 0.42;
  const eyeX = (S - (eyeW * 2 + eyeGap)) / 2;
  const accentW = S * 0.4;
  const accentH = Math.max(S * 0.03, ss);
  const accentY = S * 0.72;
  const showAccent = size >= 32;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let color = null;
      if (insideRoundRect(px, py, pad, pad, S - pad, S - pad, radius)) {
        const t = (py - pad) / (S - pad * 2);
        color = [
          BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t,
          BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t,
          BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t,
        ];
        if (
          showAccent &&
          insideRoundRect(px, py, (S - accentW) / 2, accentY, (S + accentW) / 2, accentY + accentH, accentH / 2)
        ) {
          color = ACCENT;
        }
        if (
          insideRoundRect(px, py, eyeX, eyeY, eyeX + eyeW, eyeY + eyeH, eyeR) ||
          insideRoundRect(px, py, eyeX + eyeW + eyeGap, eyeY, eyeX + eyeW * 2 + eyeGap, eyeY + eyeH, eyeR)
        ) {
          color = EYE;
        }
      }
      if (!color) continue;
      const target = ((y / ss) | 0) * size * 4 + ((x / ss) | 0) * 4;
      sum[target] += color[0];
      sum[target + 1] += color[1];
      sum[target + 2] += color[2];
      sum[target + 3] += 255;
    }
  }

  const total = ss * ss;
  for (let i = 0; i < size * size; i++) {
    const alpha = sum[i * 4 + 3] / total;
    const offset = i * 4;
    if (alpha <= 0) continue;
    const coverage = sum[i * 4 + 3];
    out[offset] = Math.round((sum[i * 4] / coverage) * 255);
    out[offset + 1] = Math.round((sum[i * 4 + 1] / coverage) * 255);
    out[offset + 2] = Math.round((sum[i * 4 + 2] / coverage) * 255);
    out[offset + 3] = Math.round(alpha);
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ICO는 각 크기를 PNG로 넣을 수 있다(Vista 이후 표준).
function encodeIco(sizes) {
  const images = sizes.map((size) => ({ size, png: encodePng(size, render(size)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = [];
  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry[0] = image.size >= 256 ? 0 : image.size;
    entry[1] = image.size >= 256 ? 0 : image.size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32BE(0, 8);
    entry.writeUInt32LE(image.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += image.png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "icon.ico"), encodeIco([16, 24, 32, 48, 64, 128, 256]));
fs.writeFileSync(path.join(OUT_DIR, "icon.png"), encodePng(512, render(512)));
fs.writeFileSync(path.join(OUT_DIR, "tray.png"), encodePng(32, render(32)));
console.log("assets/icon.ico, assets/icon.png, assets/tray.png 생성 완료");
