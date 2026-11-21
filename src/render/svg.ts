import type { Box, GraphicObject, GroupZone, ImpactDocument, RGB, TableZone, TextZone } from '../impact/model.ts';
import { fontStack } from './fonts.ts';
import { createMeasure, layoutText, type Measure } from './textLayout.ts';

export interface RenderOptions {
  measure?: Measure;
  /** turns a PICT block into an image URL (data: or blob:) */
  pictToUrl?: (data: Uint8Array) => { url: string; width: number; height: number } | null;
  /** outline objects whose type is not drawn yet */
  debug?: boolean;
  /** draw closed notes as open text boxes instead of icons */
  openNotes?: boolean;
  /** zone to draw instead of the document root */
  rootId?: number;
  /** zone drawn first, behind the page (a master slide) */
  backgroundId?: number;
  /** size the picture to the page frame instead of the drawing's extent */
  clipToPage?: boolean;
}

export interface RenderResult {
  svg: string;
  width: number;
  height: number;
  stats: { drawn: number; skipped: Record<string, number> };
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const n = (v: number) => (Math.round(v * 100) / 100).toString();

const SHADOW_OFFSET = 5;
const SHADOW_COLOR = '#777777';
/** default margin added around lines and rotatable groups */
const DEFAULT_MARGIN = 13.421875;

class Ctx {
  out: string[] = [];
  defs: string[] = [];
  drawn = 0;
  skipped: Record<string, number> = {};
  visiting = new Set<number>();
  uid = 0;
  doc: ImpactDocument;
  opts: Required<Pick<RenderOptions, 'measure'>> & RenderOptions;
  constructor(doc: ImpactDocument, opts: Required<Pick<RenderOptions, 'measure'>> & RenderOptions) {
    this.doc = doc;
    this.opts = opts;
  }
  color(i: number): string {
    const c: RGB | undefined = this.doc.palette[i];
    if (!c) return '#000';
    return `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }
  skip(kind: string) {
    this.skipped[kind] = (this.skipped[kind] ?? 0) + 1;
  }
}

const boxW = (b: Box) => b.x1 - b.x0;
const boxH = (b: Box) => b.y1 - b.y0;

/** Stroke width: integer part in byte 20, 1/256ths in byte 21. */
export function strokeWidth(o: GraphicObject): number {
  return o.lineWidth + o.lineFlags / 256;
}

/** Lines store their bounding box grown by a margin, plus an angle (start -> end). */
export function lineEndpoints(o: GraphicObject): { x1: number; y1: number; x2: number; y2: number } {
  const { x0, y0, x1, y1 } = o.box;
  const w = x1 - x0;
  const h = y1 - y0;
  const a = o.fixed34;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const t = Math.abs(c) < 1e-9 ? Infinity : Math.abs(s / c);
  let m: number;
  if (t < 1e-3) m = h / 2;
  else if (t > 1e3) m = w / 2;
  else if (Math.abs(t - 1) < 0.02) m = DEFAULT_MARGIN;
  else m = (h - t * w) / (2 * (1 - t));
  if (!Number.isFinite(m)) m = DEFAULT_MARGIN;
  m = Math.max(0, Math.min(m, Math.min(w, h) / 2));
  const lx0 = x0 + m;
  const lx1 = x1 - m;
  const ly0 = y0 + m;
  const ly1 = y1 - m;
  const sx = c >= 0 ? lx0 : lx1;
  const ex = c >= 0 ? lx1 : lx0;
  const sy = s >= 0 ? ly0 : ly1;
  const ey = s >= 0 ? ly1 : ly0;
  return { x1: sx, y1: sy, x2: ex, y2: ey };
}

const ROTATABLE = 0xc0;

/** The area an object really covers, in its parent's coordinates. */
function realExtent(doc: ImpactDocument, o: GraphicObject, depth = 0): Box {
  if (o.typeId === 2) {
    const e = lineEndpoints(o);
    return { x0: Math.min(e.x1, e.x2), y0: Math.min(e.y1, e.y2), x1: Math.max(e.x1, e.x2), y1: Math.max(e.y1, e.y2) };
  }
  if (o.typeId === 1 && o.flags & ROTATABLE && depth < 20) {
    const org = zoneOrigin(doc, o, depth);
    const child = doc.zones.get(o.childId);
    if (child && child.kind === 'group') {
      const c = contentExtent(doc, child, depth + 1);
      if (c) return { x0: org.x + c.x0, y0: org.y + c.y0, x1: org.x + c.x1, y1: org.y + c.y1 };
    }
  }
  return o.box;
}

const SANE = 20000;

function contentExtent(doc: ImpactDocument, g: GroupZone, depth = 0): Box | null {
  let b: Box | null = null;
  for (const o of g.objects) {
    // type 0 records are model descriptors, not drawn shapes; their "box" is not a box
    if (o.typeId === 0) continue;
    const e = realExtent(doc, o, depth);
    if (![e.x0, e.y0, e.x1, e.y1].every((v) => Number.isFinite(v) && Math.abs(v) < SANE)) continue;
    if (!b) b = { ...e };
    else {
      b.x0 = Math.min(b.x0, e.x0);
      b.y0 = Math.min(b.y0, e.y0);
      b.x1 = Math.max(b.x1, e.x1);
      b.y1 = Math.max(b.y1, e.y1);
    }
  }
  return b;
}

/**
 * Where the child zone's (0,0) sits in the parent. Rotatable groups store a
 * box grown by an equal margin on every side around their content.
 */
function zoneOrigin(doc: ImpactDocument, o: GraphicObject, depth = 0): { x: number; y: number } {
  const child = doc.zones.get(o.childId);
  if (!(o.flags & ROTATABLE) || !child || child.kind !== 'group') return { x: o.box.x0, y: o.box.y0 };
  const c = contentExtent(doc, child, depth + 1);
  if (!c) return { x: o.box.x0, y: o.box.y0 };
  const mx = (boxW(o.box) - (c.x1 - c.x0)) / 2;
  const my = (boxH(o.box) - (c.y1 - c.y0)) / 2;
  return { x: o.box.x0 + mx - c.x0, y: o.box.y0 + my - c.y0 };
}

function renderText(ctx: Ctx, zone: TextZone, width: number) {
  const layout = layoutText(zone, ctx.doc.rulers, width, ctx.opts.measure);
  for (const line of layout.lines) {
    if (line.bullet) {
      const b = line.bullet;
      const cy = line.baseline - line.spans[0]?.font.size * 0.32;
      const r = b.size / 2;
      const cx = b.x + r;
      ctx.out.push(`<path d="M${n(cx)} ${n(cy - r)}L${n(cx + r)} ${n(cy)}L${n(cx)} ${n(cy + r)}L${n(cx - r)} ${n(cy)}Z" fill="${ctx.color(b.font.color)}"/>`);
    }
    for (const s of line.spans) {
      if (!s.text.trim()) continue;
      const f = s.font;
      // damaged character records carry impossible sizes or colours
      if (f.size <= 0 || f.size > 512 || f.color > 255) continue;
      const y = line.baseline + (f.superscript ? -f.size * 0.33 : f.subscript ? f.size * 0.2 : 0);
      const attrs = [
        `y="${n(y)}"`,
        `font-family="${esc(fontStack(f))}"`,
        `font-size="${n(f.superscript || f.subscript ? f.size * 0.7 : f.size)}"`,
      ];
      if (f.bold) attrs.push('font-weight="bold"');
      if (f.italic) attrs.push('font-style="italic"');
      const deco = [f.underline && 'underline', f.strike && 'line-through'].filter(Boolean).join(' ');
      if (deco) attrs.push(`text-decoration="${deco}"`);
      attrs.push(`textLength="${n(s.width)}" lengthAdjust="spacingAndGlyphs"`);
      const color = ctx.color(f.color);
      const body = esc(s.text);
      if (f.shadow) {
        ctx.out.push(`<text xml:space="preserve" x="${n(s.x + 1)}" ${attrs.join(' ').replace(`y="${n(y)}"`, `y="${n(y + 1)}"`)} fill="${color}" opacity="0.45">${body}</text>`);
      }
      const paint = f.outline ? `fill="#fff" stroke="${color}" stroke-width="0.6"` : `fill="${color}"`;
      ctx.out.push(`<text xml:space="preserve" x="${n(s.x)}" ${attrs.join(' ')} ${paint}>${body}</text>`);
    }
  }
  ctx.drawn++;
}

function arrowHead(ctx: Ctx, x: number, y: number, ang: number, size: number, color: string) {
  const back = size * 1.6;
  const half = size * 0.6;
  const bx = x - Math.cos(ang) * back;
  const by = y - Math.sin(ang) * back;
  const px = -Math.sin(ang) * half;
  const py = Math.cos(ang) * half;
  ctx.out.push(`<path d="M${n(x)} ${n(y)}L${n(bx + px)} ${n(by + py)}L${n(bx - px)} ${n(by - py)}Z" fill="${color}"/>`);
}

function renderLine(ctx: Ctx, o: GraphicObject) {
  const e = lineEndpoints(o);
  const color = ctx.color(o.lineColor);
  const w = Math.max(0.5, strokeWidth(o) || 1);
  const ang = Math.atan2(e.y2 - e.y1, e.x2 - e.x1);
  const head = 3 + w * 1.5;
  const hasHead = !!(o.flags & 0xc0);
  // byte 39 = 3 puts the head on the other end of the line
  const atStart = hasHead && o.raw[39] === 3;
  let { x1, y1, x2, y2 } = e;
  if (hasHead && !atStart) {
    x2 -= Math.cos(ang) * head;
    y2 -= Math.sin(ang) * head;
  } else if (atStart) {
    x1 += Math.cos(ang) * head;
    y1 += Math.sin(ang) * head;
  }
  ctx.out.push(`<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${color}" stroke-width="${n(w)}"/>`);
  if (atStart) arrowHead(ctx, e.x1, e.y1, ang + Math.PI, head, color);
  else if (hasHead) arrowHead(ctx, e.x2, e.y2, ang, head, color);
  ctx.drawn++;
}

/**
 * Gradient fills: flag 0x10 on the object, the fill pattern selects an entry
 * of the document's gradient table (pattern 2 is the first entry).
 */
function gradientFill(ctx: Ctx, o: GraphicObject): string | null {
  if (!(o.flags & 0x10)) return null;
  const list = ctx.doc.gradients;
  const g = list[o.fillPattern - 2] ?? list[0];
  const hex = (c: RGB) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const colors = g ? g.colors.map(hex) : [ctx.color(o.lineColor), ctx.color(o.fillColor)];
  const angle = ((g?.angle ?? 90) * Math.PI) / 180;
  // the vector runs from the first colour to the last, y pointing up
  const dx = Math.cos(angle) / 2;
  const dy = -Math.sin(angle) / 2;
  const id = `g${ctx.uid++}`;
  const stops = colors.map((c, i) => `<stop offset="${n(i / Math.max(1, colors.length - 1))}" stop-color="${c}"/>`).join('');
  if (g && g.type === 2) {
    ctx.defs.push(`<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.75">${stops}</radialGradient>`);
  } else {
    ctx.defs.push(`<linearGradient id="${id}" x1="${n(0.5 - dx)}" y1="${n(0.5 - dy)}" x2="${n(0.5 + dx)}" y2="${n(0.5 + dy)}">${stops}</linearGradient>`);
  }
  return `url(#${id})`;
}

/** fill and stroke attributes shared by closed shapes */
function paint(ctx: Ctx, o: GraphicObject, filled = !(o.subType & 0x80)): string {
  const w = strokeWidth(o);
  const grad = gradientFill(ctx, o);
  const fill = grad ?? (filled ? ctx.color(o.fillColor) : 'none');
  const stroke = w > 0 ? `stroke="${ctx.color(o.lineColor)}" stroke-width="${n(Math.max(w, 1))}"` : '';
  return `fill="${fill}" ${stroke}`;
}

function shadow(ctx: Ctx, o: GraphicObject, shape: (dx: number, dy: number) => string) {
  if ((o.subType & 0x12) !== 0x12) return;
  ctx.out.push(shape(SHADOW_OFFSET, SHADOW_OFFSET).replace('/>', ` fill="${SHADOW_COLOR}" stroke="none"/>`));
}

/** stroke is drawn inside the frame, as QuickDraw does */
function inset(o: GraphicObject): Box {
  const h = Math.max(strokeWidth(o), 0) / 2;
  const b = o.box;
  return { x0: b.x0 + h, y0: b.y0 + h, x1: b.x1 - h, y1: b.y1 - h };
}

function renderRect(ctx: Ctx, o: GraphicObject, rounded: boolean) {
  const b = inset(o);
  let rx = 0;
  let ry = 0;
  if (rounded) {
    rx = Math.min(Math.abs(o.fixed34) / 2, boxW(b) / 2);
    ry = Math.min(Math.abs(o.fixed38 || o.fixed34) / 2, boxH(b) / 2);
  }
  const r = rounded ? ` rx="${n(rx)}" ry="${n(ry)}"` : '';
  shadow(ctx, o, (dx, dy) => `<rect x="${n(o.box.x0 + dx)}" y="${n(o.box.y0 + dy)}" width="${n(boxW(o.box))}" height="${n(boxH(o.box))}"${r}/>`);
  ctx.out.push(`<rect x="${n(b.x0)}" y="${n(b.y0)}" width="${n(Math.max(0, boxW(b)))}" height="${n(Math.max(0, boxH(b)))}"${r} ${paint(ctx, o)}/>`);
  ctx.drawn++;
}

function renderOval(ctx: Ctx, o: GraphicObject) {
  const b = inset(o);
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  shadow(ctx, o, (dx, dy) => `<ellipse cx="${n(cx + dx)}" cy="${n(cy + dy)}" rx="${n(boxW(o.box) / 2)}" ry="${n(boxH(o.box) / 2)}"/>`);
  ctx.out.push(`<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(Math.max(0, boxW(b) / 2))}" ry="${n(Math.max(0, boxH(b) / 2))}" ${paint(ctx, o)}/>`);
  ctx.drawn++;
}

function renderPath(ctx: Ctx, o: GraphicObject) {
  const pts = o.path;
  if (!pts || !pts.length) {
    ctx.skip('path without points');
    return;
  }
  const w = strokeWidth(o);
  const ox = o.box.x0 + w / 2;
  const oy = o.box.y0 + w / 2;
  const filled = !(o.subType & 0x80);
  let d = `M${n(ox + pts[0].x)} ${n(oy + pts[0].y)}`;
  const seg = (a: (typeof pts)[0], b: (typeof pts)[0]) => {
    const straight = a.c2x === a.x && a.c2y === a.y && b.c1x === b.x && b.c1y === b.y;
    if (straight) return `L${n(ox + b.x)} ${n(oy + b.y)}`;
    return `C${n(ox + a.c2x)} ${n(oy + a.c2y)} ${n(ox + b.c1x)} ${n(oy + b.c1y)} ${n(ox + b.x)} ${n(oy + b.y)}`;
  };
  for (let i = 1; i < pts.length; i++) d += seg(pts[i - 1], pts[i]);
  if (filled) d += seg(pts[pts.length - 1], pts[0]) + 'Z';
  shadow(ctx, o, (dx, dy) => `<path transform="translate(${dx} ${dy})" d="${d}"/>`);
  ctx.out.push(`<path d="${d}" ${paint(ctx, o, filled)} stroke-linejoin="miter"/>`);
  ctx.drawn++;
}

/**
 * Org chart connectors: an elbow inside the box. The end that touches a
 * sibling's edge midpoint decides the direction.
 */
function renderConnector(ctx: Ctx, o: GraphicObject, siblings: GraphicObject[]) {
  const b = o.box;
  const w = Math.max(0.5, strokeWidth(o) || 1);
  const h = w / 2;
  const xl = b.x0 + h;
  const xr = b.x1 - h;
  const yt = b.y0 + h;
  const yb = b.y1 - h;
  const near = (x: number, y: number, edge: 'top' | 'bottom' | 'left' | 'right') =>
    siblings.some((s) => {
      if (s === o || s.typeId === 7) return false;
      const sb = s.box;
      const cx = (sb.x0 + sb.x1) / 2;
      const cy = (sb.y0 + sb.y1) / 2;
      if (edge === 'top') return Math.abs(cx - x) < 2 && Math.abs(sb.y0 - y) < 2.5;
      if (edge === 'bottom') return Math.abs(cx - x) < 2 && Math.abs(sb.y1 - y) < 2.5;
      if (edge === 'left') return Math.abs(cy - y) < 2 && Math.abs(sb.x0 - x) < 2.5;
      return Math.abs(cy - y) < 2 && Math.abs(sb.x1 - x) < 2.5;
    });
  const score = (sx: number, sy: number, ex: number, ey: number, vertical: boolean) =>
    vertical
      ? (near(sx, b.y0, 'bottom') ? 1 : 0) + (near(ex, b.y1, 'top') ? 1 : 0)
      : (near(b.x0, sy, 'right') ? 1 : 0) + (near(b.x1, ey, 'left') ? 1 : 0);
  const options = [
    { v: true, sx: xl, sy: yt, ex: xr, ey: yb },
    { v: true, sx: xr, sy: yt, ex: xl, ey: yb },
    { v: false, sx: xl, sy: yt, ex: xr, ey: yb },
    { v: false, sx: xl, sy: yb, ex: xr, ey: yt },
  ];
  let best = options[0];
  let bestScore = -1;
  for (const op of options) {
    const s = score(op.sx, op.sy, op.ex, op.ey, op.v);
    if (s > bestScore) {
      best = op;
      bestScore = s;
    }
  }
  let d: string;
  if (best.v) {
    const my = Math.round((b.y0 + b.y1) / 2) + h;
    d = `M${n(best.sx)} ${n(b.y0)}V${n(my)}H${n(best.ex)}V${n(b.y1)}`;
  } else {
    const mx = Math.round((b.x0 + b.x1) / 2) + h;
    d = `M${n(b.x0)} ${n(best.sy)}H${n(mx)}V${n(best.ey)}H${n(b.x1)}`;
  }
  ctx.out.push(`<path d="${d}" fill="none" stroke="${ctx.color(o.lineColor)}" stroke-width="${n(w)}"/>`);
  ctx.drawn++;
}

function renderPicture(ctx: Ctx, o: GraphicObject) {
  const b = o.box;
  const img = o.data && ctx.opts.pictToUrl ? ctx.opts.pictToUrl(o.data.data) : null;
  if (!img) {
    ctx.skip('picture');
    if (ctx.opts.debug)
      ctx.out.push(`<rect x="${n(b.x0)}" y="${n(b.y0)}" width="${n(boxW(b))}" height="${n(boxH(b))}" fill="none" stroke="#c33" stroke-dasharray="4 2"/>`);
    return;
  }
  ctx.out.push(`<image x="${n(b.x0)}" y="${n(b.y0)}" width="${n(boxW(b))}" height="${n(boxH(b))}" preserveAspectRatio="none" href="${img.url}"/>`);
  ctx.drawn++;
}

/** The yellow "information note" icon ClarisImpact shows for a closed note. */
function renderNoteIcon(ctx: Ctx, x: number, y: number) {
  const s = 16;
  ctx.out.push(
    `<g transform="translate(${n(x)} ${n(y)})" class="note-icon">` +
      `<path d="M2 2H${s + 2}V${s + 2}H6L2 ${s - 2}Z" fill="#000"/>` +
      `<path d="M0 0H${s}V${s}H4L0 ${s - 4}Z" fill="#ffff99" stroke="#000" stroke-width="0.75"/>` +
      `<path d="M0 ${s - 4}H4V${s}" fill="#e6e6a0" stroke="#000" stroke-width="0.75"/>` +
      `<rect x="3" y="3" width="6" height="4" fill="none" stroke="#000" stroke-width="0.6"/>` +
      `<path d="M10 3.5H13M10 5.5H13M3 9H13" stroke="#000" stroke-width="0.6" stroke-dasharray="0.8 0.8"/>` +
      `</g>`,
  );
}

function renderTable(ctx: Ctx, t: TableZone, o: GraphicObject) {
  const W = boxW(o.box);
  const H = boxH(o.box);
  if (!t.columns || !t.rows) {
    ctx.skip('empty table');
    return;
  }
  let colW = t.widthHint ? t.widthHint / t.columns : W / t.columns;
  if (colW < 24 && t.widthHint) colW = t.widthHint;
  const rowH = t.heightHint ? t.heightHint / t.rows : H / t.rows;
  const id = `c${ctx.uid++}`;
  ctx.defs.push(`<clipPath id="${id}"><rect x="0" y="0" width="${n(W)}" height="${n(H)}"/></clipPath>`);
  ctx.out.push(`<g clip-path="url(#${id})">`);
  const grid = ctx.color(o.lineColor === 1 ? 15 : o.lineColor);
  for (let c = 0; c < t.cells.length; c++) {
    for (let r = 0; r < t.rows; r++) {
      const cell = t.cells[c][r];
      const x = c * colW;
      const y = r * rowH;
      if (cell && cell.fill > 0) ctx.out.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(colW)}" height="${n(rowH)}" fill="${ctx.color(cell.fill)}"/>`);
      if (cell && cell.text.trim()) {
        const f = cell.font;
        const size = Math.min(f.size || 10, rowH * 0.8);
        const font = { ...f, size };
        const width = ctx.opts.measure(cell.text, font);
        const tx = cell.align === 'center' ? x + (colW - width) / 2 : cell.align === 'right' ? x + colW - 3 - width : x + 3;
        const ty = y + rowH / 2 + size * 0.35;
        const attrs = [`x="${n(tx)}"`, `y="${n(ty)}"`, `font-family="${esc(fontStack(f))}"`, `font-size="${n(size)}"`, `fill="${ctx.color(f.color)}"`];
        if (f.bold) attrs.push('font-weight="bold"');
        if (f.italic) attrs.push('font-style="italic"');
        if (f.condensed) attrs.push('font-stretch="condensed"');
        ctx.out.push(`<text xml:space="preserve" ${attrs.join(' ')}>${esc(cell.text)}</text>`);
      }
    }
  }
  // grid lines
  const cols = Math.min(t.cells.length, Math.ceil(W / colW));
  let d = '';
  for (let c = 0; c <= cols; c++) d += `M${n(c * colW)} 0V${n(t.rows * rowH)}`;
  for (let r = 0; r <= t.rows; r++) d += `M0 ${n(r * rowH)}H${n(cols * colW)}`;
  ctx.out.push(`<path d="${d}" fill="none" stroke="${grid}" stroke-width="${n(Math.max(0.5, strokeWidth(o) || 0.5))}"/>`);
  ctx.out.push('</g>');
  ctx.drawn++;
}

function renderZoneRef(ctx: Ctx, o: GraphicObject) {
  const child = ctx.doc.zones.get(o.childId);
  if (!child) {
    ctx.skip('missing zone');
    return;
  }
  if (ctx.visiting.has(child.id)) return;
  // bit 1 of the word at offset 46 hides the frame (closed notes, chart data sheets)
  if ((o.objFlags & 2) && !((o.objFlags & 1) && child.kind === 'text')) return;
  if (child.kind === 'text' && (o.objFlags & 3) === 3 && !ctx.opts.openNotes) {
    renderNoteIcon(ctx, o.box.x0, o.box.y0);
    ctx.drawn++;
    return;
  }
  const org = zoneOrigin(ctx.doc, o);
  ctx.out.push(`<g transform="translate(${n(org.x)} ${n(org.y)})" data-zone="${child.id}">`);
  ctx.visiting.add(child.id);
  if (child.kind === 'text') renderText(ctx, child, boxW(o.box));
  else if (child.kind === 'group') renderGroup(ctx, child);
  else if (child.kind === 'table') renderTable(ctx, child, o);
  else ctx.skip(`zone:${child.kind}`);
  ctx.visiting.delete(child.id);
  ctx.out.push('</g>');
}

function renderObject(ctx: Ctx, o: GraphicObject, siblings: GraphicObject[]) {
  switch (o.typeId) {
    case 1:
      return renderZoneRef(ctx, o);
    case 2:
      return renderLine(ctx, o);
    case 3:
      return renderRect(ctx, o, false);
    case 4:
      return renderRect(ctx, o, true);
    case 5:
      return renderOval(ctx, o);
    case 7:
      return renderConnector(ctx, o, siblings);
    case 8:
      return renderPath(ctx, o);
    case 10:
    case 11:
      return renderPicture(ctx, o);
    default: {
      ctx.skip(`type ${o.typeId}`);
      if (ctx.opts.debug) {
        const b = o.box;
        ctx.out.push(
          `<rect x="${n(b.x0)}" y="${n(b.y0)}" width="${n(boxW(b))}" height="${n(boxH(b))}" fill="none" stroke="#39f" stroke-width="0.5" stroke-dasharray="3 2"><title>type ${o.typeId} sub ${o.subType} flags ${o.flags}</title></rect>`,
        );
      }
    }
  }
}

function renderGroup(ctx: Ctx, g: GroupZone) {
  for (const o of g.objects) renderObject(ctx, o, g.objects);
}

export function renderDocument(doc: ImpactDocument, options: RenderOptions = {}): RenderResult {
  const ctx = new Ctx(doc, { measure: options.measure ?? createMeasure(), ...options });
  const root = doc.zones.get(options.rootId ?? doc.rootId);
  let width = 612;
  let height = 792;
  const bg = options.backgroundId !== undefined ? doc.zones.get(options.backgroundId) : undefined;
  if (bg && bg.kind === 'group') {
    ctx.visiting.add(bg.id);
    renderGroup(ctx, bg);
    ctx.visiting.delete(bg.id);
  }
  if (root && root.kind === 'group') {
    ctx.visiting.add(root.id);
    renderGroup(ctx, root);
    const frame = root.objects[0];
    const b = contentExtent(doc, root);
    if (frame && frame.typeId === 1 && frame.flags === 0x0a && options.clipToPage) {
      width = Math.ceil(frame.box.x1);
      height = Math.ceil(frame.box.y1);
    } else if (b) {
      width = Math.max(1, Math.ceil(b.x1));
      height = Math.max(1, Math.ceil(b.y1));
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    (ctx.defs.length ? `<defs>${ctx.defs.join('')}</defs>` : '') +
    `<rect width="100%" height="100%" fill="#fff"/>` +
    ctx.out.join('') +
    `</svg>`;
  return { svg, width, height, stats: { drawn: ctx.drawn, skipped: ctx.skipped } };
}
