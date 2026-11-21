// Regression tests against the sample files in ./samples (not part of the
// repository). Each test is skipped when its file is missing.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseImpact } from '../src/impact/parser.ts';
import { documentLayout } from '../src/impact/pages.ts';
import { renderDocument } from '../src/render/svg.ts';

const sample = (p: string) => new URL(`../samples/${p}`, import.meta.url);
const has = (p: string) => existsSync(sample(p));
const load = (p: string) => parseImpact(readFileSync(sample(p)));
const texts = (p: string) =>
  [...load(p).zones.values()].flatMap((z) => (z.kind === 'text' ? [z.text] : []));

describe('Mac 1.0 drawing', () => {
  const f = 'mac_1.0_demo/Tour Start/Tour Start';
  it.skipIf(!has(f))('reads zones, palette and text', () => {
    const doc = load(f);
    expect(doc.platform).toBe('mac');
    expect(doc.rootId).toBe(1);
    expect(doc.palette[47]).toEqual({ r: 255, g: 0, b: 0 });
    expect(texts(f)).toContain('Welcome to');
    expect(documentLayout(doc).kind).toBe('drawing');
  });
  it.skipIf(!has(f))('draws every object (pictures need a browser canvas)', () => {
    const r = renderDocument(load(f));
    expect(Object.keys(r.stats.skipped).filter((k) => k !== 'picture')).toEqual([]);
    expect(r.svg).toContain('More about Styles');
  });
});

describe('Mac 1.0 presentation', () => {
  const f = 'mac_1.0_demo/Tour Presentation';
  it.skipIf(!has(f))('finds five slides and a master', () => {
    const layout = documentLayout(load(f));
    expect(layout.kind).toBe('presentation');
    expect(layout.pages.map((p) => p.title)).toContain('Recreational Activities');
    expect(layout.pages).toHaveLength(5);
    expect(layout.masterId).toBe(47);
  });
  it.skipIf(!has(f))('reads the activity table', () => {
    const t = load(f).zones.get(6);
    expect(t?.kind).toBe('table');
    if (t?.kind !== 'table') return;
    expect(t.columns).toBe(4);
    expect(t.cells[1][0]?.text).toBe('Continental');
    expect(t.cells[0][5]?.text).toBe('Tennis');
  });
});

describe('Windows 2.0 compressed drawing', () => {
  const f = 'win_2.0_trial/DATADRAW/HR/ORG2FLD.CID';
  it.skipIf(!has(f))('decompresses and reads the org chart', () => {
    const doc = load(f);
    expect(doc.compressed).toBe(true);
    expect(doc.platform).toBe('windows');
    expect(texts(f)).toContain('Chris Moyer');
    expect(doc.fontNames.get(12821)).toBe('GeoSlb712 Md BT');
  });
});
