/**
 * ClarisImpact 2.0 for Windows stores its documents compressed.
 *
 * Layout after the 8-byte signature (version + 'CIPT'/'BOBO'):
 *   u32 BE  size of one uncompressed chunk (0x5000)
 *   repeated:
 *     u32 BE  n = number of bytes that follow in this chunk
 *     u32     0
 *     n - 4 bytes of LZ data
 *
 * The LZ data is a sequence of groups: a 16-bit little-endian control word,
 * then 16 items read from its lowest bit up. A clear bit is one literal byte;
 * a set bit is a 2-byte back reference b1 b2:
 *   length   = (b1 & 0x0F) + 1
 *   distance = b2 | (b1 & 0xF0) << 4
 * Each chunk decodes on its own to `chunk` bytes (the last one may be short).
 * Once decoded, the document has the same layout as a Macintosh file.
 */

export function isCompressedImpact(bytes: Uint8Array): boolean {
  if (bytes.length < 24) return false;
  const u32 = (o: number) => ((bytes[o] << 24) >>> 0) + (bytes[o + 1] << 16) + (bytes[o + 2] << 8) + bytes[o + 3];
  const chunk = u32(8);
  const first = u32(12);
  const zero = u32(16);
  return chunk >= 0x400 && chunk <= 0x100000 && (chunk & 0xff) === 0 && zero === 0 && first > 4 && 16 + first <= bytes.length + 4;
}

function lz(src: Uint8Array, start: number, end: number, out: Uint8Array, outStart: number, max: number): number {
  let p = start;
  let o = outStart;
  const limit = outStart + max;
  while (p + 2 <= end && o < limit) {
    const ctrl = src[p] | (src[p + 1] << 8);
    p += 2;
    for (let bit = 0; bit < 16; bit++) {
      if (p >= end || o >= limit) break;
      if ((ctrl >> bit) & 1) {
        if (p + 2 > end) break;
        const b1 = src[p];
        const b2 = src[p + 1];
        p += 2;
        const len = (b1 & 0x0f) + 1;
        const dist = b2 | ((b1 & 0xf0) << 4);
        if (dist <= 0 || o - dist < outStart) throw new Error(`bad back reference at byte ${p - 2}`);
        for (let k = 0; k < len && o < limit; k++, o++) out[o] = out[o - dist];
      } else {
        out[o++] = src[p++];
      }
    }
  }
  return o - outStart;
}

export function decompressImpact(bytes: Uint8Array): Uint8Array {
  const u32 = (o: number) => ((bytes[o] << 24) >>> 0) + (bytes[o + 1] << 16) + (bytes[o + 2] << 8) + bytes[o + 3];
  const chunk = u32(8);
  // count chunks first to size the output
  const parts: [number, number][] = [];
  let q = 12;
  while (q + 8 <= bytes.length) {
    const n = u32(q);
    if (n < 4) break;
    const end = Math.min(bytes.length, q + 4 + n);
    parts.push([q + 8, end]);
    q = q + 4 + n;
  }
  const out = new Uint8Array(8 + parts.length * chunk);
  out.set(bytes.subarray(0, 8), 0);
  let o = 8;
  for (const [s, e] of parts) o += lz(bytes, s, e, out, o, chunk);
  return out.subarray(0, o);
}
