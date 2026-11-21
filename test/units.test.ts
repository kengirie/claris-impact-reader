import { describe, expect, it } from 'vitest';
import { decodeMacRoman } from '../src/core/BinaryReader.ts';
import { decompressImpact, isCompressedImpact } from '../src/impact/decompress.ts';
import { unpackBits } from '../src/pict/pict.ts';
import { lineEndpoints } from '../src/render/svg.ts';
import type { GraphicObject } from '../src/impact/model.ts';

describe('decodeMacRoman', () => {
  it('maps the high half of the Mac character set', () => {
    expect(decodeMacRoman(new Uint8Array([0x48, 0x8e, 0xd2, 0xd3, 0xa5]))).toBe('Hé“”•');
  });
});

describe('unpackBits', () => {
  it('expands literal and repeat runs', () => {
    // 2 literals, then 0xAA repeated 3 times
    expect([...unpackBits(new Uint8Array([0x01, 1, 2, 0xfe, 0xaa]), 5)]).toEqual([1, 2, 0xaa, 0xaa, 0xaa]);
  });
});

describe('decompressImpact', () => {
  it('decodes literals and back references in a chunk', () => {
    // control word 0x0010 (LE): items 0-3 literal, item 4 a reference
    const lz = [0x10, 0x00, 0x41, 0x42, 0x43, 0x44, 0x03, 0x04]; // ABCD, then length 4 from distance 4
    const n = lz.length + 4;
    const file = new Uint8Array([
      0x02, 0x00, 0xc6, 0x00, 0x43, 0x49, 0x50, 0x54, // version + 'CIPT'
      0x00, 0x00, 0x04, 0x00, // chunk size 1024
      0x00, 0x00, 0x00, n, 0x00, 0x00, 0x00, 0x00, ...lz,
    ]);
    expect(isCompressedImpact(file)).toBe(true);
    const out = decompressImpact(file);
    expect(new TextDecoder().decode(out.subarray(8))).toBe('ABCDABCD');
  });
});

describe('lineEndpoints', () => {
  const line = (box: [number, number, number, number], angle: number) =>
    ({ box: { x0: box[0], y0: box[1], x1: box[2], y1: box[3] }, fixed34: angle }) as GraphicObject;

  it('recovers a horizontal arrow pointing left', () => {
    const e = lineEndpoints(line([-13.4, -6.4, 40.4, 20.4], Math.PI));
    expect(e.x1).toBeCloseTo(27, 0);
    expect(e.x2).toBeCloseTo(0, 0);
    expect(e.y1).toBeCloseTo(7, 0);
  });

  it('recovers a diagonal line from its grown box and angle', () => {
    // box grown by 13.4 around (0,9.5)-(39,49.5), pointing down-left
    const a = Math.atan2(40, -39);
    const e = lineEndpoints(line([-13.4, -3.9, 52.4, 62.9], a));
    expect(e.x1).toBeCloseTo(39, 0);
    expect(e.y1).toBeCloseTo(9.5, 0);
    expect(e.x2).toBeCloseTo(0, 0);
    expect(e.y2).toBeCloseTo(49.5, 0);
  });
});
