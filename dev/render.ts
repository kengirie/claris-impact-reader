// Development harness: renders one sample file at 1:1 so it can be compared
// with screenshots taken in the original application.
import { parseImpact } from '../src/impact/parser.ts';
import { renderDocument } from '../src/render/svg.ts';
import { pictToDataUrl } from '../src/pict/pictToUrl.ts';

const params = new URLSearchParams(location.search);
const file = params.get('file') ?? '';
const debug = params.has('debug');
const res = await fetch('/__sample/' + file.replace(/^samples\//, ''));
const buf = new Uint8Array(await res.arrayBuffer());
const doc = parseImpact(buf);
const root = params.get('root');
const r = renderDocument(doc, { debug, pictToUrl: pictToDataUrl, rootId: root ? Number(root) : undefined });
const scale = Number(params.get('scale') ?? '1');
document.getElementById('out')!.innerHTML = r.svg.replace(/width="(\d+)" height="(\d+)"/, (_m, w, h) => `width="${w * scale}" height="${h * scale}"`);
document.getElementById('log')!.textContent = JSON.stringify({ stats: r.stats, warnings: doc.warnings, size: [r.width, r.height] }, null, 1);
(window as any).__done = true;
