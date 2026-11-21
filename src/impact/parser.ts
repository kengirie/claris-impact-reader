import { BinaryReader, decodeMacRoman, decodeWin1252 } from '../core/BinaryReader.ts';
import { DEFAULT_PALETTE } from './palette.ts';
import { decompressImpact, isCompressedImpact } from './decompress.ts';
import type {
  Block,
  FontStyle,
  Gradient,
  GraphicObject,
  PathPoint,
  GroupZone,
  ImpactDocument,
  RGB,
  Ruler,
  TableCell,
  TableZone,
  TextStyleDef,
  TextZone,
  UnknownZone,
  Zone,
} from './model.ts';

export class ImpactFormatError extends Error {}

const DSET = 0x44534554; // 'DSET'

/** Quick check used for file-type detection. */
export function sniffImpact(bytes: Uint8Array): { signature: string; version: number } | null {
  if (bytes.length < 16) return null;
  const sig = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  if (sig !== 'CIPT' && sig !== 'BOBO') return null;
  return { signature: sig, version: bytes[0] };
}

interface DsetHeader {
  offset: number;
  size: number;
  end: number;
  numData: number;
  dataSize: number;
  headerSize: number;
  fileType: number;
  id: number;
  little: boolean;
}

/**
 * Finds every DSET zone header. The structure is the one used by the
 * ClarisWorks family: 'DSET', size(4), numData(2), then either
 * (-1, 0, dataSize, headerSize, flags) or, for text zones, selection info,
 * then fileType at +20 and id at +22.
 */
function findDsets(bytes: Uint8Array, little: boolean): DsetHeader[] {
  const out: DsetHeader[] = [];
  const r = new BinaryReader(bytes, false);
  for (let i = 8; i + 24 <= bytes.length; i++) {
    if (bytes[i] !== 0x44 || bytes[i + 1] !== 0x53 || bytes[i + 2] !== 0x45 || bytes[i + 3] !== 0x54) continue;
    r.littleEndian = false;
    if (r.peekU32(i) !== DSET) continue;
    r.littleEndian = little;
    const size = r.peekU32(i + 4);
    if (size < 16 || i + 8 + size > bytes.length) continue;
    r.seek(i + 8);
    const numData = r.u16();
    r.seek(i + 14);
    const dataSize = r.u16();
    const headerSize = r.u16();
    const fileType = bytes[i + 20];
    r.seek(i + 22);
    const id = r.u16();
    if (fileType !== 1) {
      if (headerSize > size) continue;
      if (dataSize && numData * dataSize > size) continue;
    }
    out.push({ offset: i, size, end: i + 8 + size, numData, dataSize, headerSize, fileType, id, little });
    i += 7;
  }
  return out;
}

/** Reads length-prefixed blocks from `start` up to `limit`. */
function readBlocks(bytes: Uint8Array, start: number, limit: number, little: boolean): Block[] {
  const r = new BinaryReader(bytes, little);
  const out: Block[] = [];
  let p = start;
  while (p + 4 <= limit) {
    const sz = r.peekU32(p);
    if (p + 4 + sz > limit) break;
    out.push({ offset: p + 4, data: bytes.subarray(p + 4, p + 4 + sz) });
    p += 4 + sz;
  }
  return out;
}

interface StructList {
  offset: number;
  numData: number;
  dataSize: number;
  headerSize: number;
  dataStart: number;
}

/**
 * Generic list structure: size(4) numData(2) type(2)=-1 v0(2)=0 dataSize(2)
 * headerSize(2) v1(2), header, numData*dataSize bytes.
 */
function findStructLists(bytes: Uint8Array, start: number, end: number, little: boolean): StructList[] {
  const r = new BinaryReader(bytes, little);
  const out: StructList[] = [];
  for (let o = start; o + 16 <= end; o++) {
    const size = r.peekU32(o);
    if (size < 12 || o + 4 + size > bytes.length) continue;
    r.seek(o + 4);
    const n = r.u16();
    const type = r.i16();
    const v0 = r.i16();
    const ds = r.u16();
    const hs = r.u16();
    if ((type !== -1 && type !== 3) || n === 0 || ds === 0 || ds > 1000) continue;
    void v0;
    if (12 + hs + n * ds !== size) continue;
    out.push({ offset: o, numData: n, dataSize: ds, headerSize: hs, dataStart: o + 16 + hs });
  }
  return out;
}

function readPalette(bytes: Uint8Array, list: StructList, little: boolean): RGB[] {
  const r = new BinaryReader(bytes, little, list.dataStart);
  const pal: RGB[] = [];
  for (let i = 0; i < list.numData; i++) {
    const at = list.dataStart + i * list.dataSize;
    r.seek(at);
    pal.push({ r: r.u16() >> 8, g: r.u16() >> 8, b: r.u16() >> 8 });
  }
  return pal;
}

export function decodeFontFlags(fontId: number, flags: number, size: number, color: number): FontStyle {
  return {
    fontId,
    size,
    color,
    bold: !!(flags & 0x1),
    italic: !!(flags & 0x2),
    underline: !!(flags & 0x4),
    outline: !!(flags & 0x8),
    shadow: !!(flags & 0x10),
    condensed: !!(flags & 0x20),
    extended: !!(flags & 0x40),
    strike: !!(flags & 0x80),
    superscript: !!(flags & 0x100) || !!(flags & 0x400),
    subscript: !!(flags & 0x200) || !!(flags & 0x800),
  };
}

/** Gradient records: four RGB colours, colour count, type, angle. */
function readGradients(bytes: Uint8Array, list: StructList, little: boolean): Gradient[] {
  const r = new BinaryReader(bytes, little);
  const out: Gradient[] = [];
  for (let i = 0; i < list.numData; i++) {
    const at = list.dataStart + i * list.dataSize;
    r.seek(at);
    const colors: RGB[] = [];
    for (let k = 0; k < 4; k++) colors.push({ r: r.u16() >> 8, g: r.u16() >> 8, b: r.u16() >> 8 });
    const count = r.u8();
    const type = r.u8();
    const angle = r.i16();
    out.push({ colors: colors.slice(0, Math.max(2, Math.min(4, count))), type, angle });
  }
  return out;
}

function readRulers(bytes: Uint8Array, list: StructList, little: boolean): Ruler[] {
  const r = new BinaryReader(bytes, little);
  const out: Ruler[] = [];
  for (let i = 0; i < list.numData; i++) {
    const at = list.dataStart + i * list.dataSize;
    r.seek(at);
    r.i16(); // usage count
    const flags = r.u16();
    const alignBits = flags >> 14;
    const align = (['left', 'center', 'right', 'justify'] as const)[alignBits];
    // bit 3 marks outline (bulleted) paragraphs; line spacing is kept single
    const bullet = !!(flags & 0x0008);
    const spacing: Ruler['spacing'] = { kind: 'lines', value: 1 };
    const firstIndent = r.i16();
    const leftIndent = r.i16();
    const rightIndent = r.i16();
    const spaceBefore = r.u8();
    r.u8();
    const spaceAfter = r.u8();
    r.u8();
    r.i8();
    let numTabs = r.u8();
    if (at + 16 + numTabs * 4 > at + list.dataSize) numTabs = 0;
    const tabs: Ruler['tabs'] = [];
    for (let t = 0; t < numTabs; t++) {
      const pos = r.i16();
      const v = r.u8();
      r.u8();
      tabs.push({ pos, align: (['left', 'center', 'right', 'decimal'] as const)[v >> 6] });
    }
    out.push({ index: i, align, spacing, firstIndent, leftIndent, rightIndent, spaceBefore, spaceAfter, tabs, bullet });
  }
  return out;
}

function readTextStyles(bytes: Uint8Array, list: StructList, little: boolean, decode: (b: Uint8Array) => string): TextStyleDef[] {
  const r = new BinaryReader(bytes, little);
  const out: TextStyleDef[] = [];
  for (let i = 0; i < list.numData; i++) {
    const at = list.dataStart + i * list.dataSize;
    r.seek(at);
    const fontId = r.u16();
    const flags = r.u16();
    const size = r.u8();
    const color = r.u8();
    const n = Math.min(r.u8(), list.dataSize - 7);
    const name = decode(r.take(n));
    out.push({ index: i, name, font: decodeFontFlags(fontId, flags, size, color) });
  }
  return out;
}

function parseGroup(bytes: Uint8Array, h: DsetHeader, tail: Block[]): GroupZone {
  const r = new BinaryReader(bytes, h.little);
  const objects: GraphicObject[] = [];
  const recSize = h.dataSize || 56;
  const start = h.end - h.numData * recSize;
  for (let i = 0; i < h.numData; i++) {
    const at = start + i * recSize;
    const raw = bytes.subarray(at, at + recSize);
    r.seek(at);
    const typeId = r.u8();
    const wrap = r.u8();
    const flags = r.u8();
    const subType = r.u8();
    const y0 = r.i32() / 256;
    const x0 = r.i32() / 256;
    const y1 = r.i32() / 256;
    const x1 = r.i32() / 256;
    const lineWidth = r.u8();
    const lineFlags = r.u8();
    const lineColor = r.u8();
    const fillColor = r.u8();
    const linePattern = r.u8();
    const fillPattern = r.u8();
    const order = r.i16();
    r.seek(at + 34);
    const childId = r.u32();
    r.seek(at + 34);
    const fixed34 = r.fixed();
    const fixed38 = r.fixed();
    r.seek(at + 46);
    const objFlags = r.u16();
    objects.push({
      index: i,
      offset: at,
      typeId,
      wrap,
      flags,
      subType,
      box: { x0, y0, x1, y1 },
      lineWidth,
      lineFlags,
      lineColor,
      fillColor,
      linePattern,
      fillPattern,
      order,
      childId,
      fixed34,
      fixed38,
      objFlags,
      raw,
    });
  }
  const header = tail[0];
  const blocks = tail.slice(1);
  // Attach picture data: picture objects (type 10) take the first PICT-looking
  // block in order.
  const pictBlocks = blocks.filter((b) => looksLikePict(b.data));
  let pi = 0;
  // pictures (type 10) and charts (type 11, which keep a PICT preview)
  for (const o of objects) {
    if ((o.typeId === 10 || o.typeId === 11) && pi < pictBlocks.length) o.data = pictBlocks[pi++];
  }
  // Bezier paths: a list structure of 26-byte points.
  const pathBlocks = blocks.filter((b) => isStructList(b.data, h.little, 26));
  let qi = 0;
  for (const o of objects) {
    if (o.typeId === 8 && qi < pathBlocks.length) o.path = readPath(pathBlocks[qi++].data, h.little);
  }
  return { kind: 'group', id: h.id, offset: h.offset, objects, header, blocks };
}

/** True when `d` is a list structure whose records are `dataSize` bytes. */
function isStructList(d: Uint8Array, little: boolean, dataSize: number): boolean {
  if (d.length < 12) return false;
  const r = new BinaryReader(d, little);
  const n = r.u16();
  const type = r.i16();
  r.i16();
  const ds = r.u16();
  const hs = r.u16();
  return type === -1 && ds === dataSize && 12 + hs + n * ds === d.length;
}

/** Path points: anchor, two control points (each v,h as 24.8 fixed) and flags. */
function readPath(d: Uint8Array, little: boolean): PathPoint[] {
  const r = new BinaryReader(d, little);
  const n = r.u16();
  r.seek(6);
  const ds = r.u16();
  const hs = r.u16();
  const pts: PathPoint[] = [];
  for (let i = 0; i < n; i++) {
    r.seek(12 + hs + i * ds);
    const vals: number[] = [];
    for (let k = 0; k < 6; k++) vals.push(r.i32() / 256);
    const flags = r.u16();
    pts.push({ x: vals[1], y: vals[0], c1x: vals[3], c1y: vals[2], c2x: vals[5], c2y: vals[4], flags });
  }
  return pts;
}

export function looksLikePict(d: Uint8Array): boolean {
  if (d.length < 14) return false;
  // version 2: 0x0011 0x02FF at offset 10
  if (d[10] === 0x00 && d[11] === 0x11 && d[12] === 0x02 && d[13] === 0xff) return true;
  // version 1: 0x11 0x01 at offset 10
  if (d[10] === 0x11 && d[11] === 0x01) return true;
  return false;
}

function parseText(bytes: Uint8Array, h: DsetHeader, tail: Block[], decode: (b: Uint8Array) => string): TextZone {
  const r = new BinaryReader(bytes, h.little, h.offset + 24);
  r.u16(); // unknown
  r.u16(); // father id
  const numChar = r.u32();
  const numTextZone = Math.max(1, r.u16());
  const numPara = r.u16();
  const numFont = r.u16();
  const zone: TextZone = { kind: 'text', id: h.id, offset: h.offset, text: '', fonts: [], paragraphs: [] };
  // tail: [paragraphs][fonts][tokens][sizes][text * numTextZone]
  const para = tail[0];
  const fonts = tail[1];
  if (para) {
    const pr = new BinaryReader(para.data, h.little);
    // 8 bytes per entry in version 1 files, 12 in version 2
    const recSize = numPara ? Math.max(6, Math.floor(para.data.length / numPara)) : 8;
    for (let p = 0; p + recSize <= para.data.length; p += recSize) {
      pr.seek(p);
      zone.paragraphs.push({ pos: pr.u32(), ruler: pr.i16() });
    }
  }
  if (fonts) {
    const fr = new BinaryReader(fonts.data, h.little);
    // version 1: pos(4) font(2) flags(2) size(1) color(1); version 2: size and color are 16-bit
    const recSize = numFont ? Math.floor(fonts.data.length / numFont) : 10;
    const wide = recSize >= 12;
    for (let p = 0; p + recSize <= fonts.data.length; p += recSize) {
      fr.seek(p);
      const pos = fr.u32();
      const fontId = fr.u16();
      const flags = fr.u16();
      const size = wide ? fr.u16() : fr.u8();
      const color = wide ? fr.u16() : fr.u8();
      zone.fonts.push({ pos, font: decodeFontFlags(fontId, flags, size, color) });
    }
    zone.wideRecords = wide;
  }
  let text = '';
  for (let i = 0; i < numTextZone; i++) {
    const b = tail[4 + i];
    if (b) text += decode(b.data);
  }
  zone.text = text.slice(0, numChar || text.length);
  return zone;
}

/**
 * Font name table ('FNTM' in version 2 files): records of 72 bytes holding the
 * font number and, at offset 8, its name as a Pascal string.
 */
function readFontNames(bytes: Uint8Array, little: boolean): Map<number, string> {
  const names = new Map<number, string>();
  const r = new BinaryReader(bytes, little);
  for (let i = 8; i + 24 < bytes.length; i++) {
    if (bytes[i] !== 0x46 || bytes[i + 1] !== 0x4e || bytes[i + 2] !== 0x54 || bytes[i + 3] !== 0x4d) continue;
    r.seek(i + 8);
    const n = r.u16();
    const type = r.i16();
    r.i16();
    const ds = r.u16();
    const hs = r.u16();
    if (type !== -1 || ds < 10 || ds > 300) continue;
    const start = i + 20 + hs;
    for (let k = 0; k < n && start + (k + 1) * ds <= bytes.length; k++) {
      const at = start + k * ds;
      r.seek(at);
      const id = r.u16();
      const len = bytes[at + 8];
      if (len > 0 && len < ds - 8) names.set(id, decodeMacRoman(bytes.subarray(at + 9, at + 9 + len)));
    }
    break;
  }
  return names;
}

/**
 * Table zones hold a 'CTAB' block: max column and row index, then one
 * 'COLM' + 'CHNK' pair per column. A CHNK lists, for every row, the offset
 * of its cell (0 = empty). A cell is: type, ?, font(2), size, style flags,
 * text colour, alignment, fill colour, ?, then a Pascal string.
 */
function parseTable(h: DsetHeader, tail: Block[], bytes: Uint8Array, decode: (b: Uint8Array) => string): TableZone {
  const zone: TableZone = {
    kind: 'table',
    id: h.id,
    offset: h.offset,
    numData: h.numData,
    dataSize: h.dataSize,
    blocks: tail,
    raw: bytes.subarray(h.offset, h.end),
    columns: 0,
    rows: 0,
    cells: [],
  };
  // two small lists after the cells: column and row sizes
  const sizeLists = tail.filter((b) => b.data.length === 20 && b.data[2] === 0xff && b.data[3] === 0xff);
  if (sizeLists.length >= 2) {
    zone.widthHint = (sizeLists[0].data[12] << 8) | sizeLists[0].data[13];
    zone.heightHint = (sizeLists[1].data[12] << 8) | sizeLists[1].data[13];
  }
  const block = tail.find((b) => b.data.length > 12 && b.data[6] === 0x43 && b.data[7] === 0x54 && b.data[8] === 0x41 && b.data[9] === 0x42);
  if (!block) return zone;
  const d = block.data;
  const r = new BinaryReader(d);
  r.seek(10);
  zone.columns = r.u16() + 1;
  zone.rows = r.u16() + 1;
  if (zone.columns > 256 || zone.rows > 4096) return zone;
  let col = 0;
  for (let i = 0; i + 4 <= d.length && col < zone.columns; i++) {
    if (d[i] !== 0x43 || d[i + 1] !== 0x48 || d[i + 2] !== 0x4e || d[i + 3] !== 0x4b) continue; // 'CHNK'
    const cells: (TableCell | null)[] = [];
    for (let row = 0; row < zone.rows && i + 12 + row * 2 + 2 <= d.length; row++) {
      r.seek(i + 12 + row * 2);
      const off = r.u16();
      if (!off || i + off + 11 > d.length) {
        cells.push(null);
        continue;
      }
      const at = i + off;
      const type = d[at];
      r.seek(at + 2);
      const fontId = r.u16();
      const size = d[at + 4];
      const flags = d[at + 5];
      const color = d[at + 6];
      const alignByte = d[at + 7];
      const fill = d[at + 8];
      let text = '';
      if ((type & 0xf0) === 0x30) {
        const len = d[at + 10];
        text = decode(d.subarray(at + 11, Math.min(d.length, at + 11 + len)));
      }
      const align = (alignByte & 0x0c) === 0x08 ? 'center' : (alignByte & 0x0c) === 0x0c ? 'right' : 'left';
      cells.push({ text, font: decodeFontFlags(fontId, flags, size, color), fill: fill || -1, align });
    }
    zone.cells.push(cells);
    col++;
    i += 3;
  }
  return zone;
}

export function parseImpact(input: ArrayBuffer | Uint8Array): ImpactDocument {
  const raw = input instanceof Uint8Array ? input : new Uint8Array(input);
  const sniff = sniffImpact(raw);
  if (!sniff) throw new ImpactFormatError('This file is not a ClarisImpact document (no CIPT/BOBO signature).');
  const warnings: string[] = [];
  const compressed = isCompressedImpact(raw);
  let bytes = raw;
  if (compressed) {
    try {
      bytes = decompressImpact(raw);
    } catch (e) {
      throw new ImpactFormatError(`The compressed data in this file is damaged (${(e as Error).message}).`);
    }
  }

  // Byte order: Windows files store some header fields little-endian.
  // Detect by trying both and keeping the one that yields valid DSETs.
  const be = findDsets(bytes, false);
  const little = false;
  const dsets = be;
  const platform: 'mac' | 'windows' = compressed ? 'windows' : 'mac';
  const decode = platform === 'windows' ? decodeWin1252 : decodeMacRoman;

  const firstZone = dsets.length ? dsets[0].offset : bytes.length;
  const lists = findStructLists(bytes, 8, firstZone, little);
  let palette: RGB[] = DEFAULT_PALETTE;
  const palList = lists.find((l) => l.numData === 256 && l.dataSize === 6);
  if (palList) palette = readPalette(bytes, palList, little);
  else warnings.push('No colour table found; using the default ClarisImpact palette.');
  const rulerList = lists.find((l) => l.dataSize === 96 || l.dataSize === 92 || l.dataSize === 108);
  const gradList = lists.find((l) => l.dataSize === 40 && l.headerSize === 64);
  const gradients = gradList ? readGradients(bytes, gradList, little) : [];
  const rulers = rulerList ? readRulers(bytes, rulerList, little) : [];
  const styleList = lists.find((l) => l.dataSize === 38);
  const textStyles = styleList ? readTextStyles(bytes, styleList, little, decode) : [];

  const fontNames = readFontNames(bytes, little);
  const zones = new Map<number, Zone>();
  dsets.forEach((h, i) => {
    const limit = i + 1 < dsets.length ? dsets[i + 1].offset : bytes.length;
    const tail = readBlocks(bytes, h.end, limit, little);
    let zone: Zone;
    try {
      if (h.fileType === 0) zone = parseGroup(bytes, h, tail);
      else if (h.fileType === 1) zone = parseText(bytes, h, tail, decode);
      else if (h.fileType === 2) zone = parseTable(h, tail, bytes, decode);
      else zone = { kind: 'unknown', id: h.id, offset: h.offset, fileType: h.fileType, blocks: tail } as UnknownZone;
    } catch (e) {
      warnings.push(`Zone ${h.id} at 0x${h.offset.toString(16)} could not be read: ${(e as Error).message}`);
      return;
    }
    if (zone.kind === 'text') for (const f of zone.fonts) f.font.fontName = fontNames.get(f.font.fontId);
    if (!zones.has(h.id)) zones.set(h.id, zone);
  });
  for (const t of textStyles) t.font.fontName = fontNames.get(t.font.fontId);

  const rootId = zones.has(1) ? 1 : (dsets[0]?.id ?? 0);
  if (!zones.size) warnings.push('No drawing zones were found in this file.');

  return {
    signature: sniff.signature,
    platform,
    version: sniff.version,
    byteLength: raw.length,
    compressed,
    palette,
    gradients,
    rulers,
    textStyles,
    fontNames,
    zones,
    rootId,
    warnings,
  };
}
