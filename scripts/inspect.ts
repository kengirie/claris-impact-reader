// Prints the zone tree of a ClarisImpact file.
// usage: node scripts/inspect.ts <file> [zoneId] [--raw]
import { readFileSync } from 'node:fs';
import { parseImpact } from '../src/impact/parser.ts';
import type { ImpactDocument } from '../src/impact/model.ts';

const [file, zoneArg, ...rest] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scripts/inspect.ts <file> [zoneId] [--raw]');
  process.exit(1);
}
const raw = rest.includes('--raw') || zoneArg === '--raw';
const doc = parseImpact(readFileSync(file));
const hex = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');

function show(d: ImpactDocument, id: number, depth: number, seen: Set<number>) {
  const pad = '  '.repeat(depth);
  const z = d.zones.get(id);
  if (!z) return console.log(`${pad}#${id} (missing)`);
  if (seen.has(id)) return console.log(`${pad}#${id} (cycle)`);
  seen.add(id);
  if (z.kind === 'text') {
    console.log(`${pad}#${id} text ${JSON.stringify(z.text.slice(0, 60))} fonts=${z.fonts.map((f) => `${f.pos}:${f.font.fontId}/${f.font.size}/${f.font.color}`).join(',')} para=${z.paragraphs.map((p) => `${p.pos}:${p.ruler}`).join(',')}`);
    return;
  }
  if (z.kind !== 'group') {
    console.log(`${pad}#${id} ${z.kind} blocks=${z.blocks.map((b) => b.data.length).join(',')}`);
    return;
  }
  console.log(`${pad}#${id} group (${z.objects.length} objects) blocks=${z.blocks.map((b) => b.data.length).join(',')}`);
  for (const o of z.objects) {
    const b = o.box;
    console.log(
      `${pad}  [${o.index}] t${o.typeId} f=${o.flags.toString(16)} s=${o.subType} box=(${b.x0.toFixed(1)},${b.y0.toFixed(1)})-(${b.x1.toFixed(1)},${b.y1.toFixed(1)}) lw=${o.lineWidth}.${o.lineFlags} col=${o.lineColor}/${o.fillColor} pat=${o.linePattern}/${o.fillPattern}${o.typeId === 1 ? ` -> #${o.childId}` : ''}${raw ? ' ' + hex(o.raw.subarray(28)) : ''}`,
    );
    if (o.typeId === 1) show(d, o.childId, depth + 2, seen);
  }
}

console.log(`${doc.platform} v${doc.version} ${doc.signature} compressed=${doc.compressed} zones=${doc.zones.size} root=#${doc.rootId}`);
if (doc.warnings.length) console.log('warnings:', doc.warnings);
show(doc, zoneArg && zoneArg !== '--raw' ? Number(zoneArg) : doc.rootId, 0, new Set());
