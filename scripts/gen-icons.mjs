// 앱 아이콘(PWA용 PNG) 생성기. 외부 의존성 없이 Node 내장 zlib로 PNG를 인코딩한다.
// 디자인: 파란 배경 + 흰 체크리스트 3줄 (플래너 느낌). 실행: node scripts/gen-icons.mjs
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
fs.mkdirSync(outDir, { recursive: true });

const BG = [37, 99, 235, 255];   // --accent 파랑
const FG = [255, 255, 255, 255];

// ── PNG 인코딩 ──
const crcTable = (() => {
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
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit, RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ── 도형 그리기 (supersample 후 다운샘플로 안티앨리어싱) ──
const SS = 4;
function render(size, { rounded, contentScale }) {
  const R = size * SS;
  const buf = Buffer.alloc(R * R * 4); // 투명으로 시작
  const set = (x, y, col) => {
    if (x < 0 || y < 0 || x >= R || y >= R) return;
    const i = (y * R + x) * 4;
    buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2]; buf[i + 3] = col[3];
  };
  const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  // 배경
  const bgR = rounded ? 0.22 * R : 0;
  for (let y = 0; y < R; y++)
    for (let x = 0; x < R; x++)
      if (!rounded || inRoundRect(x, y, 0, 0, R - 1, R - 1, bgR)) set(x, y, BG);

  // 체크리스트 3줄 (0~1 좌표를 중앙 기준으로 contentScale 만큼 축소)
  const f = v => 0.5 + (v - 0.5) * contentScale;
  const rows = [0.34, 0.5, 0.66];
  for (const row of rows) {
    const cy = f(row) * R;
    // 점
    const dotCx = f(0.28) * R, dotR = 0.05 * contentScale * R;
    for (let y = Math.floor(cy - dotR); y <= cy + dotR; y++)
      for (let x = Math.floor(dotCx - dotR); x <= dotCx + dotR; x++)
        if ((x - dotCx) ** 2 + (y - cy) ** 2 <= dotR * dotR) set(x, y, FG);
    // 막대
    const bx0 = f(0.40) * R, bx1 = f(0.74) * R, hh = 0.04 * contentScale * R, rr = hh;
    for (let y = Math.floor(cy - hh); y <= cy + hh; y++)
      for (let x = Math.floor(bx0); x <= bx1; x++)
        if (inRoundRect(x, y, bx0, cy - hh, bx1, cy + hh, rr)) set(x, y, FG);
  }

  // 다운샘플 (SS×SS 평균)
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++)
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * R + (x * SS + dx)) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      const n = SS * SS, o = (y * size + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  return encodePng(size, size, out);
}

fs.writeFileSync(path.join(outDir, "icon-192.png"), render(192, { rounded: true, contentScale: 1 }));
fs.writeFileSync(path.join(outDir, "icon-512.png"), render(512, { rounded: true, contentScale: 1 }));
fs.writeFileSync(path.join(outDir, "icon-maskable-512.png"), render(512, { rounded: false, contentScale: 0.72 }));
console.log("아이콘 생성 완료: public/icons/ (192, 512, maskable-512)");
