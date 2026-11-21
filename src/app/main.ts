import { parseImpact, ImpactFormatError } from '../impact/parser.ts';
import { documentLayout, type DocumentLayout } from '../impact/pages.ts';
import type { ImpactDocument, Zone } from '../impact/model.ts';
import { renderDocument, type RenderResult } from '../render/svg.ts';
import { pictToDataUrl } from '../pict/pictToUrl.ts';
import { fontName } from '../render/fonts.ts';

interface OpenFile {
  name: string;
  size: number;
  doc?: ImpactDocument;
  layout?: DocumentLayout;
  error?: string;
}

type Zoom = 'fit' | 'width' | number;

const state = {
  files: [] as OpenFile[],
  current: -1,
  page: 0,
  zoom: 'fit' as Zoom,
  inspector: false,
  rendered: null as RenderResult | null,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fileInput = $<HTMLInputElement>('file-input');
const fileList = $<HTMLUListElement>('file-list');
const pagesBox = $<HTMLDivElement>('pages');
const pagesLabel = $<HTMLHeadingElement>('pages-label');
const pageList = $<HTMLOListElement>('page-list');
const desk = $<HTMLElement>('desk');
const empty = $<HTMLElement>('empty');
const stage = $<HTMLDivElement>('stage');
const sheet = $<HTMLDivElement>('sheet');
const dropHint = $<HTMLDivElement>('drop-hint');
const zoomSelect = $<HTMLSelectElement>('zoom-select');
const status = $<HTMLElement>('status');
const inspector = $<HTMLElement>('inspector');
const facts = $<HTMLElement>('facts');
const tree = $<HTMLElement>('tree');
const exportSvgBtn = $<HTMLButtonElement>('export-svg');
const exportPngBtn = $<HTMLButtonElement>('export-png');
const inspectorBtn = $<HTMLButtonElement>('toggle-inspector');

const KIND_LABEL: Record<DocumentLayout['kind'], string> = { drawing: '図', presentation: 'プレゼンテーション' };

function describe(f: OpenFile): string {
  if (f.error) return '読み込めません';
  if (!f.doc || !f.layout) return '';
  const os = f.doc.platform === 'windows' ? 'Windows' : 'Mac';
  const kind = f.doc.signature === 'BOBO' ? 'スタイル' : KIND_LABEL[f.layout.kind];
  return `${kind} · ${os} 版 ${f.doc.version >= 2 ? '2.0' : '1.0'}`;
}

async function openFiles(list: FileList | File[]) {
  const files = Array.from(list);
  if (!files.length) return;
  for (const file of files) {
    const entry: OpenFile = { name: file.name, size: file.size };
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      entry.doc = parseImpact(buf);
      entry.layout = documentLayout(entry.doc);
    } catch (e) {
      entry.error =
        e instanceof ImpactFormatError
          ? e.message === 'This file is not a ClarisImpact document (no CIPT/BOBO signature).'
            ? 'ClarisImpact のファイルではないようです（先頭に CIPT / BOBO の識別子がありません）。'
            : `ファイルが壊れているため読めません: ${e.message}`
          : `読み込み中に問題が起きました: ${(e as Error).message}`;
    }
    state.files.push(entry);
  }
  select(state.files.length - files.length);
}

function select(index: number, page = 0) {
  state.current = index;
  state.page = page;
  renderAll();
}

function currentFile(): OpenFile | undefined {
  return state.files[state.current];
}

function renderFileList() {
  $('files-empty').hidden = state.files.length > 0;
  fileList.replaceChildren(
    ...state.files.map((f, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-current', String(i === state.current));
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = f.name;
      const meta = document.createElement('span');
      meta.className = 'file-meta' + (f.error ? ' error' : '');
      meta.textContent = describe(f);
      b.append(name, meta);
      b.addEventListener('click', () => select(i));
      li.append(b);
      return li;
    }),
  );
}

function renderPageList() {
  const f = currentFile();
  const pages = f?.layout?.pages ?? [];
  pagesBox.hidden = pages.length < 2;
  pagesLabel.textContent = f?.layout?.kind === 'presentation' ? 'スライド' : 'ページ';
  pageList.replaceChildren(
    ...pages.map((p, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-current', String(i === state.page));
      const num = document.createElement('span');
      num.className = 'page-num';
      num.textContent = String(i + 1);
      const t = document.createElement('span');
      t.className = 'page-title';
      t.textContent = p.title;
      t.title = p.title;
      b.append(num, t);
      b.addEventListener('click', () => {
        state.page = i;
        renderAll();
      });
      li.append(b);
      return li;
    }),
  );
}

function scaleFor(r: RenderResult): number {
  if (typeof state.zoom === 'number') return state.zoom;
  const pad = 64;
  const w = Math.max(100, desk.clientWidth - pad);
  const h = Math.max(100, desk.clientHeight - pad);
  if (state.zoom === 'width') return w / r.width;
  return Math.min(w / r.width, h / r.height);
}

function renderSheet() {
  const f = currentFile();
  const page = f?.layout?.pages[state.page];
  const ok = !!(f?.doc && page);
  empty.hidden = !!f;
  stage.hidden = !f;
  exportSvgBtn.disabled = !ok;
  exportPngBtn.disabled = !ok;
  state.rendered = null;
  if (!f) {
    sheet.replaceChildren();
    return;
  }
  if (!f.doc || !page) {
    const msg = document.createElement('div');
    msg.className = 'empty-sheet message';
    const h = document.createElement('h1');
    h.textContent = f.name;
    const p = document.createElement('p');
    p.textContent = f.error ?? 'このファイルには表示できるページがありません。';
    msg.append(h, p);
    sheet.replaceChildren(msg);
    return;
  }
  const r = renderDocument(f.doc, {
    rootId: page.id,
    backgroundId: page.masterId,
    clipToPage: f.layout?.kind === 'presentation',
    pictToUrl: pictToDataUrl,
  });
  state.rendered = r;
  const scale = scaleFor(r);
  sheet.innerHTML = r.svg;
  const svg = sheet.querySelector('svg')!;
  svg.setAttribute('width', String(Math.round(r.width * scale)));
  svg.setAttribute('height', String(Math.round(r.height * scale)));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${f.name} — ${page.title}`);
}

function renderStatus() {
  const f = currentFile();
  const r = state.rendered;
  const parts: string[] = [];
  if (f?.doc && r) {
    const page = f.layout?.pages[state.page];
    if (f.layout && f.layout.pages.length > 1) parts.push(`${state.page + 1} / ${f.layout.pages.length}`);
    if (page) parts.push(`${Math.round(r.width)} × ${Math.round(r.height)} pt`);
    parts.push(`${Math.round(scaleFor(r) * 100)}%`);
    parts.push(`${r.stats.drawn} 個の要素を描画`);
  }
  status.replaceChildren(
    ...parts.map((p) => {
      const s = document.createElement('span');
      s.textContent = p;
      return s;
    }),
  );
  const skipped = r ? Object.values(r.stats.skipped).reduce((a, b) => a + b, 0) : 0;
  if (skipped) {
    const w = document.createElement('span');
    w.className = 'warn';
    w.textContent = `未対応の要素 ${skipped} 個（${Object.entries(r!.stats.skipped)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ')}）`;
    status.append(w);
  }
  for (const msg of f?.doc?.warnings ?? []) {
    const w = document.createElement('span');
    w.className = 'warn';
    w.textContent = msg;
    status.append(w);
  }
}

function zoneNode(doc: ImpactDocument, id: number, seen: Set<number>, depth: number): HTMLElement {
  const z: Zone | undefined = doc.zones.get(id);
  const leaf = (html: string) => {
    const d = document.createElement('div');
    d.className = 'leaf';
    d.innerHTML = html;
    return d;
  };
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  if (!z) return leaf(`<span class="dim">#${id} (見つかりません)</span>`);
  if (seen.has(id) || depth > 12) return leaf(`<span class="dim">#${id} …</span>`);
  seen.add(id);
  if (z.kind === 'text') {
    const f = z.fonts[0]?.font;
    return leaf(
      `<span class="kind">テキスト</span> #${id} “${esc(z.text.slice(0, 80))}”` +
        (f ? ` <span class="dim">${esc(fontName(f))} ${f.size}pt</span>` : ''),
    );
  }
  if (z.kind !== 'group') return leaf(`<span class="kind">${z.kind === 'table' ? '表' : '不明'}</span> #${id}`);
  const det = document.createElement('details');
  det.open = depth < 1;
  const sum = document.createElement('summary');
  sum.innerHTML = `<span class="kind">グループ</span> #${id} <span class="dim">${z.objects.length} 個</span>`;
  det.append(sum);
  for (const o of z.objects) {
    const b = o.box;
    const label = `t${o.typeId} <span class="dim">(${b.x0.toFixed(0)}, ${b.y0.toFixed(0)}) ${(b.x1 - b.x0).toFixed(0)}×${(b.y1 - b.y0).toFixed(0)}</span>`;
    if (o.typeId === 1) {
      const wrap = document.createElement('div');
      wrap.append(leaf(label), zoneNode(doc, o.childId, seen, depth + 1));
      det.append(wrap);
    } else det.append(leaf(label));
  }
  return det;
}

function renderInspector() {
  inspector.hidden = !state.inspector;
  inspectorBtn.setAttribute('aria-pressed', String(state.inspector));
  if (!state.inspector) return;
  const f = currentFile();
  facts.replaceChildren();
  tree.replaceChildren();
  if (!f?.doc) return;
  const d = f.doc;
  const rows: [string, string][] = [
    ['ファイル', f.name],
    ['大きさ', `${f.size.toLocaleString()} バイト`],
    ['識別子', d.signature],
    ['作成', `${d.platform === 'windows' ? 'Windows' : 'Mac'} 版（形式 ${d.version}）`],
    ['圧縮', d.compressed ? 'あり（LZ）' : 'なし'],
    ['ゾーン数', String(d.zones.size)],
    ['フォント', [...new Set([...d.zones.values()].flatMap((z) => (z.kind === 'text' ? z.fonts.map((r) => fontName(r.font)) : [])))].join(', ') || '—'],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    facts.append(dt, dd);
  }
  const page = f.layout?.pages[state.page];
  if (page) tree.append(zoneNode(d, page.id, new Set(), 0));
}

function renderAll() {
  renderFileList();
  renderPageList();
  renderSheet();
  renderStatus();
  renderInspector();
  zoomSelect.value = typeof state.zoom === 'number' ? String(state.zoom) : state.zoom;
  if (typeof state.zoom === 'number' && ![...zoomSelect.options].some((o) => o.value === String(state.zoom))) {
    const o = new Option(`${Math.round(state.zoom * 100)}%`, String(state.zoom));
    zoomSelect.add(o);
    zoomSelect.value = String(state.zoom);
  }
}

function rescale() {
  const r = state.rendered;
  const svg = sheet.querySelector('svg');
  if (!r || !svg) return;
  const s = scaleFor(r);
  svg.setAttribute('width', String(Math.round(r.width * s)));
  svg.setAttribute('height', String(Math.round(r.height * s)));
  renderStatus();
}

function stepZoom(dir: 1 | -1) {
  const steps = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6];
  const cur = state.rendered ? scaleFor(state.rendered) : 1;
  const next = dir > 0 ? steps.find((s) => s > cur + 0.01) : [...steps].reverse().find((s) => s < cur - 0.01);
  if (next) {
    state.zoom = next;
    renderAll();
  }
}

function baseName(): string {
  const f = currentFile();
  const page = f?.layout && f.layout.pages.length > 1 ? `-${state.page + 1}` : '';
  return (f?.name ?? 'impact').replace(/\.[^.]+$/, '') + page;
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportSvg() {
  if (!state.rendered) return;
  download(new Blob([state.rendered.svg], { type: 'image/svg+xml' }), `${baseName()}.svg`);
}

async function exportPng() {
  const r = state.rendered;
  if (!r) return;
  const scale = 2;
  const img = new Image();
  const url = URL.createObjectURL(new Blob([r.svg], { type: 'image/svg+xml' }));
  try {
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('image'));
      img.src = url;
    });
    const c = document.createElement('canvas');
    c.width = Math.round(r.width * scale);
    c.height = Math.round(r.height * scale);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
    if (blob) download(blob, `${baseName()}.png`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// events
fileInput.addEventListener('change', () => {
  if (fileInput.files) openFiles(fileInput.files);
  fileInput.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  dropHint.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropHint.hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropHint.hidden = true;
  if (e.dataTransfer?.files.length) openFiles(e.dataTransfer.files);
});

zoomSelect.addEventListener('change', () => {
  const v = zoomSelect.value;
  state.zoom = v === 'fit' || v === 'width' ? v : Number(v);
  rescale();
});
$('zoom-in').addEventListener('click', () => stepZoom(1));
$('zoom-out').addEventListener('click', () => stepZoom(-1));
exportSvgBtn.addEventListener('click', exportSvg);
exportPngBtn.addEventListener('click', () => void exportPng());
inspectorBtn.addEventListener('click', () => {
  state.inspector = !state.inspector;
  renderInspector();
  rescale();
});
window.addEventListener('resize', () => {
  if (typeof state.zoom !== 'number') rescale();
});
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const f = currentFile();
  const n = f?.layout?.pages.length ?? 0;
  if ((e.key === 'ArrowRight' || e.key === 'PageDown') && state.page < n - 1) {
    state.page++;
    renderAll();
  } else if ((e.key === 'ArrowLeft' || e.key === 'PageUp') && state.page > 0) {
    state.page--;
    renderAll();
  } else if (e.key === '+' || e.key === '=') stepZoom(1);
  else if (e.key === '-') stepZoom(-1);
  else if (e.key === '0') {
    state.zoom = 'fit';
    renderAll();
  }
});

renderAll();

// development aid: ?sample=path loads a file from the local samples folder
const sample = new URLSearchParams(location.search).get('sample');
if (sample && import.meta.env.DEV) {
  fetch('/__sample/' + sample)
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
    .then((b) => openFiles([new File([b], sample.split('/').pop() ?? sample)]))
    .catch(() => undefined);
}
