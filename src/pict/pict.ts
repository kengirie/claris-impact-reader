/**
 * Decoder for Apple QuickDraw PICT pictures (version 1 and 2), the format
 * ClarisImpact uses for pasted and imported images.
 *
 * The decoder turns opcodes into a small list of drawing operations that a
 * 2D canvas can replay. Pixel images are expanded to RGBA.
 */
import { decodeMacRoman } from '../core/BinaryReader.ts';

export interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export type Shape = 'rect' | 'rrect' | 'oval' | 'arc' | 'poly' | 'rgn';
export type Verb = 'frame' | 'paint' | 'erase' | 'invert' | 'fill';

export type PictOp =
  | { op: 'image'; dst: Rect; width: number; height: number; rgba: Uint8ClampedArray; mode: number }
  | {
      op: 'shape';
      shape: Shape;
      verb: Verb;
      rect: Rect;
      points?: [number, number][];
      oval?: [number, number];
      arc?: [number, number];
      color: string;
      penW: number;
      penH: number;
    }
  | { op: 'line'; x1: number; y1: number; x2: number; y2: number; color: string; penW: number; penH: number }
  | { op: 'text'; x: number; y: number; text: string; font: number; fontName?: string; size: number; face: number; color: string }
  /** the coordinate origin moved by (dh, dv): later coordinates are shifted by minus that amount */
  | { op: 'origin'; dh: number; dv: number };

export interface Pict {
  version: 1 | 2;
  frame: Rect;
  ops: PictOp[];
  warnings: string[];
}

class R {
  pos = 0;
  b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  u8() {
    return this.b[this.pos++];
  }
  i8() {
    const v = this.b[this.pos++];
    return v > 127 ? v - 256 : v;
  }
  u16() {
    const v = (this.b[this.pos] << 8) | this.b[this.pos + 1];
    this.pos += 2;
    return v;
  }
  i16() {
    const v = this.u16();
    return v > 32767 ? v - 65536 : v;
  }
  u32() {
    const v = ((this.b[this.pos] << 24) >>> 0) + (this.b[this.pos + 1] << 16) + (this.b[this.pos + 2] << 8) + this.b[this.pos + 3];
    this.pos += 4;
    return v;
  }
  rect(): Rect {
    const top = this.i16();
    const left = this.i16();
    const bottom = this.i16();
    const right = this.i16();
    return { top, left, bottom, right };
  }
  skip(n: number) {
    this.pos += n;
  }
  eof() {
    return this.pos >= this.b.length;
  }
}

/** Unpacks Apple PackBits data. */
export function unpackBits(src: Uint8Array, outLen: number, unit = 1): Uint8Array {
  const out = new Uint8Array(outLen);
  let i = 0;
  let o = 0;
  while (i < src.length && o < outLen) {
    let c = src[i++];
    if (c > 127) c -= 256;
    if (c >= 0) {
      const n = (c + 1) * unit;
      for (let k = 0; k < n && o < outLen; k++) out[o++] = src[i++];
    } else if (c !== -128) {
      const n = 1 - c;
      const val = src.subarray(i, i + unit);
      i += unit;
      for (let k = 0; k < n; k++) for (let u = 0; u < unit && o < outLen; u++) out[o++] = val[u];
    }
  }
  return out;
}

const QD_COLORS: Record<number, string> = {
  33: '#000000', // black
  30: '#ffffff', // white
  205: '#dd0000', // red
  341: '#00aa00', // green
  409: '#0000dd', // blue
  273: '#00aaff', // cyan
  137: '#ff00aa', // magenta
  69: '#ffff00', // yellow
};

function hex(r: number, g: number, b: number) {
  return '#' + [r, g, b].map((v) => (v >> 8).toString(16).padStart(2, '0')).join('');
}

function patternGray(p: Uint8Array): number {
  let ones = 0;
  for (const b of p) for (let k = 0; k < 8; k++) if (b & (1 << k)) ones++;
  return ones / 64;
}

function mix(fg: string, bg: string, t: number): string {
  const a = parseInt(fg.slice(1), 16);
  const b = parseInt(bg.slice(1), 16);
  const ch = (s: number) => Math.round(((a >> s) & 255) * t + ((b >> s) & 255) * (1 - t));
  return '#' + [16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('');
}

export function parsePict(bytes: Uint8Array): Pict {
  const r = new R(bytes);
  const warnings: string[] = [];
  r.u16(); // size (low 16 bits)
  const frame = r.rect();
  let version: 1 | 2 = 1;
  if (bytes[r.pos] === 0x00 && bytes[r.pos + 1] === 0x11) {
    version = 2;
    r.skip(4); // 0011 02FF
  } else if (bytes[r.pos] === 0x11 && bytes[r.pos + 1] === 0x01) {
    r.skip(2);
  }
  const ops: PictOp[] = [];
  let fg = '#000000';
  let bg = '#ffffff';
  let penW = 1;
  let penH = 1;
  let penPat = 1; // fraction of foreground in the pen pattern
  let fillPat = 1;
  let ovW = 0;
  let ovH = 0;
  let txFont = 0;
  let txFontName: string | undefined;
  let txSize = 12;
  let txFace = 0;
  let px = 0;
  let py = 0;
  // text location: DHText/DVText/DHDVText are relative to the previous text, not the pen
  let tx = 0;
  let ty = 0;
  let lastRect: Rect = frame;
  let lastRRect: Rect = frame;
  let lastOval: Rect = frame;
  let lastArc: Rect = frame;
  let lastPoly: [number, number][] = [];
  let lastPolyRect: Rect = frame;
  let lastRgn: Rect = frame;
  let origin = { x: 0, y: 0 };

  const penColor = () => (penPat >= 1 ? fg : mix(fg, bg, penPat));
  const shape = (s: Shape, verb: Verb, rect: Rect, extra: Partial<Extract<PictOp, { op: 'shape' }>> = {}) => {
    let color = penColor();
    if (verb === 'erase') color = bg;
    if (verb === 'fill') color = fillPat >= 1 ? fg : mix(fg, bg, fillPat);
    if (verb === 'invert') color = '#000000';
    ops.push({ op: 'shape', shape: s, verb, rect, color, penW, penH, ...extra });
  };
  const verbOf = (op: number): Verb => (['frame', 'paint', 'erase', 'invert', 'fill'] as Verb[])[op & 7] ?? 'frame';

  const readPoly = () => {
    const size = r.u16();
    const rect = r.rect();
    const pts: [number, number][] = [];
    const n = (size - 10) / 4;
    for (let i = 0; i < n; i++) {
      const y = r.i16();
      const x = r.i16();
      pts.push([x, y]);
    }
    return { rect, pts };
  };
  const readRgn = (): Rect => {
    const size = r.u16();
    const rect = r.rect();
    r.skip(Math.max(0, size - 10));
    return rect;
  };

  const readPixData = (op: number) => {
    const direct = op === 0x9a || op === 0x9b;
    if (direct) r.skip(4); // base address
    let rowBytes = r.u16();
    const isPixmap = direct || (rowBytes & 0x8000) !== 0;
    rowBytes &= 0x3fff;
    const bounds = r.rect();
    let pixelSize = 1;
    let packType = 0;
    let cmpCount = 1;
    let palette: [number, number, number][] = [];
    if (isPixmap) {
      r.u16(); // pmVersion
      packType = r.u16();
      r.u32(); // packSize
      r.u32(); // hRes
      r.u32(); // vRes
      r.u16(); // pixelType
      pixelSize = r.u16();
      cmpCount = r.u16();
      r.u16(); // cmpSize
      r.u32(); // planeBytes
      r.u32(); // pmTable
      r.u32(); // reserved
      if (!direct) {
        r.u32(); // ctSeed
        const ctFlags = r.u16();
        const ctSize = r.u16();
        palette = new Array(256).fill([0, 0, 0]);
        for (let i = 0; i <= ctSize; i++) {
          const v = r.u16();
          const cr = r.u16() >> 8;
          const cg = r.u16() >> 8;
          const cb = r.u16() >> 8;
          const idx = ctFlags & 0x8000 ? i : v & 255;
          palette[idx] = [cr, cg, cb];
        }
      }
    }
    r.rect(); // src rect
    const dst = r.rect();
    const mode = r.u16();
    if (op === 0x91 || op === 0x99 || op === 0x9b) readRgn();
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    if (width <= 0 || height <= 0 || width > 8192 || height > 8192) throw new Error('bad pixmap size');
    const rgba = new Uint8ClampedArray(width * height * 4);
    const fgRGB = [parseInt(fg.slice(1, 3), 16), parseInt(fg.slice(3, 5), 16), parseInt(fg.slice(5, 7), 16)];
    const bgRGB = [parseInt(bg.slice(1, 3), 16), parseInt(bg.slice(3, 5), 16), parseInt(bg.slice(5, 7), 16)];
    const packed = rowBytes >= 8 && packType !== 1;
    for (let y = 0; y < height; y++) {
      let row: Uint8Array;
      if (!packed) {
        row = r.b.subarray(r.pos, r.pos + rowBytes);
        r.skip(rowBytes);
      } else {
        const count = rowBytes > 250 ? r.u16() : r.u8();
        const src = r.b.subarray(r.pos, r.pos + count);
        r.skip(count);
        if (pixelSize === 16 && packType === 3) row = unpackBits(src, rowBytes, 2);
        else row = unpackBits(src, rowBytes, 1);
      }
      const o = y * width * 4;
      for (let x = 0; x < width; x++) {
        let cr = 0;
        let cg = 0;
        let cb = 0;
        if (!isPixmap || pixelSize === 1) {
          const bit = (row[x >> 3] >> (7 - (x & 7))) & 1;
          const c = isPixmap ? palette[bit] ?? (bit ? [0, 0, 0] : [255, 255, 255]) : bit ? fgRGB : bgRGB;
          [cr, cg, cb] = c;
        } else if (pixelSize === 2 || pixelSize === 4 || pixelSize === 8) {
          const per = 8 / pixelSize;
          const byte = row[Math.floor(x / per)];
          const shift = (per - 1 - (x % per)) * pixelSize;
          const idx = (byte >> shift) & ((1 << pixelSize) - 1);
          [cr, cg, cb] = palette[idx] ?? [0, 0, 0];
        } else if (pixelSize === 16) {
          const v = (row[x * 2] << 8) | row[x * 2 + 1];
          cr = ((v >> 10) & 31) * 8.226;
          cg = ((v >> 5) & 31) * 8.226;
          cb = (v & 31) * 8.226;
        } else if (pixelSize === 32) {
          if (packType === 4 || (packed && cmpCount >= 3)) {
            // planar: one row of each component
            const off = cmpCount === 4 ? width : 0;
            cr = row[off + x];
            cg = row[off + width + x];
            cb = row[off + 2 * width + x];
          } else {
            cr = row[x * 4 + 1];
            cg = row[x * 4 + 2];
            cb = row[x * 4 + 3];
          }
        }
        rgba[o + x * 4] = cr;
        rgba[o + x * 4 + 1] = cg;
        rgba[o + x * 4 + 2] = cb;
        rgba[o + x * 4 + 3] = 255;
      }
    }
    ops.push({ op: 'image', dst, width, height, rgba, mode });
  };

  let guard = 0;
  while (!r.eof() && guard++ < 1_000_000) {
    if (version === 2 && r.pos & 1) r.pos++;
    if (r.pos + (version === 2 ? 2 : 1) > bytes.length) break;
    const op = version === 2 ? r.u16() : r.u8();
    if (op === 0x00ff) break;
    try {
      switch (op) {
        case 0x0000:
          break;
        case 0x0001:
          readRgn();
          break;
        case 0x0002: // BkPat
          r.skip(8);
          break;
        case 0x0003:
          txFont = r.u16();
          txFontName = undefined;
          break;
        case 0x0004:
          txFace = r.u8();
          break;
        case 0x0005:
        case 0x0008:
          r.skip(2);
          break;
        case 0x0006:
          r.skip(4);
          break;
        case 0x0007:
          penH = r.i16();
          penW = r.i16();
          break;
        case 0x0009:
          penPat = patternGray(r.b.subarray(r.pos, r.pos + 8));
          r.skip(8);
          break;
        case 0x000a:
          fillPat = patternGray(r.b.subarray(r.pos, r.pos + 8));
          r.skip(8);
          break;
        case 0x000b:
          ovH = r.i16();
          ovW = r.i16();
          break;
        case 0x000c: {
          const dh = r.i16();
          const dv = r.i16();
          origin = { x: origin.x + dh, y: origin.y + dv };
          ops.push({ op: 'origin', dh, dv });
          break;
        }
        case 0x000d:
          txSize = r.u16();
          break;
        case 0x000e:
          fg = QD_COLORS[r.u32()] ?? fg;
          break;
        case 0x000f:
          bg = QD_COLORS[r.u32()] ?? bg;
          break;
        case 0x0010:
          r.skip(8);
          break;
        case 0x0011:
          r.skip(version === 2 ? 2 : 1);
          break;
        case 0x0012:
        case 0x0013:
        case 0x0014: {
          // PixPat: type(2) pattern(8) [+ pixmap...] — approximate by skipping
          const type = r.u16();
          const pat = r.b.subarray(r.pos, r.pos + 8);
          r.skip(8);
          if (type === 1) {
            // full pixel pattern: rowBytes + pixmap + color table + data
            let rowBytes = r.u16() & 0x3fff;
            const b = r.rect();
            r.skip(2 + 2 + 4 + 4 + 4 + 2);
            const pixelSize = r.u16();
            r.skip(2 + 2 + 4 + 4 + 4);
            r.skip(4 + 2);
            const ctSize = r.u16();
            r.skip((ctSize + 1) * 8);
            const h = b.bottom - b.top;
            if (rowBytes < 8) r.skip(rowBytes * h);
            else
              for (let y = 0; y < h; y++) {
                const c = rowBytes > 250 ? r.u16() : r.u8();
                r.skip(c);
              }
            void pixelSize;
            rowBytes = 0;
          } else if (type === 2) {
            const cr = r.u16();
            const cg = r.u16();
            const cb = r.u16();
            const c = hex(cr, cg, cb);
            if (op === 0x0012) bg = c;
            else if (op === 0x0013) fg = c;
            else fg = c;
          }
          const g = patternGray(pat);
          if (op === 0x0013) penPat = g === 0 ? 1 : g;
          if (op === 0x0014) fillPat = g === 0 ? 1 : g;
          break;
        }
        case 0x0015:
        case 0x0016:
          r.skip(2);
          break;
        case 0x0017:
        case 0x0018:
        case 0x0019:
          break;
        case 0x001a: {
          const cr = r.u16();
          const cg = r.u16();
          const cb = r.u16();
          fg = hex(cr, cg, cb);
          break;
        }
        case 0x001b: {
          const cr = r.u16();
          const cg = r.u16();
          const cb = r.u16();
          bg = hex(cr, cg, cb);
          break;
        }
        case 0x001c:
        case 0x001e:
          break;
        case 0x001d:
        case 0x001f:
          r.skip(6);
          break;
        case 0x0020: {
          const y1 = r.i16();
          const x1 = r.i16();
          const y2 = r.i16();
          const x2 = r.i16();
          ops.push({ op: 'line', x1, y1, x2, y2, color: penColor(), penW, penH });
          px = x2;
          py = y2;
          break;
        }
        case 0x0021: {
          const y2 = r.i16();
          const x2 = r.i16();
          ops.push({ op: 'line', x1: px, y1: py, x2, y2, color: penColor(), penW, penH });
          px = x2;
          py = y2;
          break;
        }
        case 0x0022: {
          const y1 = r.i16();
          const x1 = r.i16();
          const dx = r.i8();
          const dy = r.i8();
          ops.push({ op: 'line', x1, y1, x2: x1 + dx, y2: y1 + dy, color: penColor(), penW, penH });
          px = x1 + dx;
          py = y1 + dy;
          break;
        }
        case 0x0023: {
          const dx = r.i8();
          const dy = r.i8();
          ops.push({ op: 'line', x1: px, y1: py, x2: px + dx, y2: py + dy, color: penColor(), penW, penH });
          px += dx;
          py += dy;
          break;
        }
        case 0x0028: {
          ty = r.i16();
          tx = r.i16();
          const len = r.u8();
          const text = decodeMacRoman(r.b.subarray(r.pos, r.pos + len));
          r.skip(len);
          ops.push({ op: 'text', x: tx, y: ty, text, font: txFont, fontName: txFontName, size: txSize, face: txFace, color: fg });
          break;
        }
        case 0x0029:
        case 0x002a:
        case 0x002b: {
          if (op === 0x0029) tx += r.u8();
          else if (op === 0x002a) ty += r.u8();
          else {
            tx += r.u8();
            ty += r.u8();
          }
          const len = r.u8();
          const text = decodeMacRoman(r.b.subarray(r.pos, r.pos + len));
          r.skip(len);
          ops.push({ op: 'text', x: tx, y: ty, text, font: txFont, fontName: txFontName, size: txSize, face: txFace, color: fg });
          break;
        }
        case 0x002c: {
          const len = r.u16();
          const end = r.pos + len;
          txFont = r.u16();
          const nlen = r.u8();
          txFontName = decodeMacRoman(r.b.subarray(r.pos, r.pos + nlen));
          r.pos = end;
          break;
        }
        case 0x002d:
        case 0x002e:
        case 0x002f:
        case 0x0024:
        case 0x0025:
        case 0x0026:
        case 0x0027:
          r.skip(r.u16());
          break;
        default:
          if (op >= 0x30 && op <= 0x34) {
            lastRect = r.rect();
            shape('rect', verbOf(op), lastRect);
          } else if (op >= 0x35 && op <= 0x37) r.skip(8);
          else if (op >= 0x38 && op <= 0x3c) shape('rect', verbOf(op), lastRect);
          else if (op >= 0x3d && op <= 0x3f) {
            /* reserved */
          } else if (op >= 0x40 && op <= 0x44) {
            lastRRect = r.rect();
            shape('rrect', verbOf(op), lastRRect, { oval: [ovW, ovH] });
          } else if (op >= 0x45 && op <= 0x47) r.skip(8);
          else if (op >= 0x48 && op <= 0x4c) shape('rrect', verbOf(op), lastRRect, { oval: [ovW, ovH] });
          else if (op >= 0x4d && op <= 0x4f) {
            /* reserved */
          } else if (op >= 0x50 && op <= 0x54) {
            lastOval = r.rect();
            shape('oval', verbOf(op), lastOval);
          } else if (op >= 0x55 && op <= 0x57) r.skip(8);
          else if (op >= 0x58 && op <= 0x5c) shape('oval', verbOf(op), lastOval);
          else if (op >= 0x5d && op <= 0x5f) {
            /* reserved */
          } else if (op >= 0x60 && op <= 0x64) {
            lastArc = r.rect();
            const a = r.i16();
            const b = r.i16();
            shape('arc', verbOf(op), lastArc, { arc: [a, b] });
          } else if (op >= 0x65 && op <= 0x67) r.skip(12);
          else if (op >= 0x68 && op <= 0x6c) {
            const a = r.i16();
            const b = r.i16();
            shape('arc', verbOf(op), lastArc, { arc: [a, b] });
          } else if (op >= 0x6d && op <= 0x6f) r.skip(4);
          else if (op >= 0x70 && op <= 0x74) {
            const p = readPoly();
            lastPoly = p.pts;
            lastPolyRect = p.rect;
            shape('poly', verbOf(op), p.rect, { points: p.pts });
          } else if (op >= 0x75 && op <= 0x77) r.skip(r.u16() - 2);
          else if (op >= 0x78 && op <= 0x7c) shape('poly', verbOf(op), lastPolyRect, { points: lastPoly });
          else if (op >= 0x7d && op <= 0x7f) {
            /* reserved */
          } else if (op >= 0x80 && op <= 0x84) {
            lastRgn = readRgn();
            shape('rgn', verbOf(op), lastRgn);
          } else if (op >= 0x85 && op <= 0x87) r.skip(r.u16() - 2);
          else if (op >= 0x88 && op <= 0x8c) shape('rgn', verbOf(op), lastRgn);
          else if (op >= 0x8d && op <= 0x8f) {
            /* reserved */
          } else if (op === 0x90 || op === 0x91 || op === 0x98 || op === 0x99 || op === 0x9a || op === 0x9b) readPixData(op);
          else if ((op >= 0x92 && op <= 0x97) || (op >= 0x9c && op <= 0x9f)) r.skip(r.u16());
          else if (op === 0xa0) r.skip(2);
          else if (op === 0xa1) {
            r.skip(2);
            r.skip(r.u16());
          } else if (op >= 0xa2 && op <= 0xaf) r.skip(r.u16());
          else if (op >= 0xb0 && op <= 0xcf) {
            /* no data */
          } else if (op >= 0xd0 && op <= 0xfe) r.skip(r.u32());
          else if (op === 0x0c00) r.skip(24);
          else if (op >= 0x0100 && op <= 0x7fff) r.skip((op >> 8) * 2);
          else if (op >= 0x8000 && op <= 0x80ff) {
            /* no data */
          } else if (op >= 0x8100) r.skip(r.u32());
          else {
            warnings.push(`unknown opcode 0x${op.toString(16)}`);
            r.pos = bytes.length;
          }
      }
    } catch (e) {
      warnings.push(`stopped at opcode 0x${op.toString(16)}: ${(e as Error).message}`);
      break;
    }
  }
  void origin;
  return { version, frame, ops, warnings };
}
