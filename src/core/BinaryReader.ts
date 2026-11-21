/** Thin cursor over a byte array with explicit endianness. */
export class BinaryReader {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  pos: number;
  littleEndian: boolean;

  constructor(bytes: Uint8Array, littleEndian = false, pos = 0) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.littleEndian = littleEndian;
    this.pos = pos;
  }

  get length(): number {
    return this.bytes.length;
  }

  remaining(): number {
    return this.bytes.length - this.pos;
  }

  has(n: number, at = this.pos): boolean {
    return at >= 0 && at + n <= this.bytes.length;
  }

  seek(pos: number): this {
    this.pos = pos;
    return this;
  }

  skip(n: number): this {
    this.pos += n;
    return this;
  }

  u8(): number {
    return this.view.getUint8(this.pos++);
  }

  i8(): number {
    return this.view.getInt8(this.pos++);
  }

  u16(): number {
    const v = this.view.getUint16(this.pos, this.littleEndian);
    this.pos += 2;
    return v;
  }

  i16(): number {
    const v = this.view.getInt16(this.pos, this.littleEndian);
    this.pos += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.pos, this.littleEndian);
    this.pos += 4;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.pos, this.littleEndian);
    this.pos += 4;
    return v;
  }

  /** 16.16 fixed point */
  fixed(): number {
    return this.i32() / 65536;
  }

  bytesAt(start: number, len: number): Uint8Array {
    return this.bytes.subarray(start, start + len);
  }

  take(len: number): Uint8Array {
    const out = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  /** Pascal string (length byte + MacRoman bytes) */
  pstring(): string {
    const n = this.u8();
    return decodeMacRoman(this.take(n));
  }

  peekU32(at = this.pos): number {
    return this.view.getUint32(at, this.littleEndian);
  }

  peekU16(at = this.pos): number {
    return this.view.getUint16(at, this.littleEndian);
  }

  fourCC(at = this.pos): string {
    return String.fromCharCode(...this.bytes.subarray(at, at + 4));
  }
}

const MAC_ROMAN_HIGH =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

export function decodeMacRoman(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    if (b < 0x80) s += String.fromCharCode(b);
    else s += MAC_ROMAN_HIGH[b - 0x80];
  }
  return s;
}

const WIN_1252_HIGH =
  '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ ¡¢£¤¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ';

export function decodeWin1252(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    if (b < 0x80) s += String.fromCharCode(b);
    else s += WIN_1252_HIGH[b - 0x80];
  }
  return s;
}
