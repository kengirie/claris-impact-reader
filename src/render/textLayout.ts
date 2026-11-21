import type { FontStyle, Ruler, TextZone } from '../impact/model.ts';
import { approxCharWidth, cssFont } from './fonts.ts';

export type Measure = (text: string, font: FontStyle) => number;

export interface LaidSpan {
  text: string;
  font: FontStyle;
  x: number;
  width: number;
}

export interface LaidLine {
  baseline: number;
  height: number;
  spans: LaidSpan[];
  width: number;
  /** outline bullet drawn before the first line of a paragraph */
  bullet?: { x: number; size: number; font: FontStyle };
}

/** distance from the ruler's indent to the text of a bulleted paragraph */
export const BULLET_TEXT_INDENT = 28;

export interface TextLayout {
  lines: LaidLine[];
  height: number;
}

/** Measurement backed by a canvas when one exists, otherwise an estimate. */
export function createMeasure(): Measure {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      ctx = new OffscreenCanvas(8, 8).getContext('2d') as unknown as CanvasRenderingContext2D;
    } else if (typeof document !== 'undefined') {
      ctx = document.createElement('canvas').getContext('2d');
    }
  } catch {
    ctx = null;
  }
  const cache = new Map<string, number>();
  return (text, font) => {
    if (!ctx) return text.length * approxCharWidth(font);
    const f = cssFont(font);
    const key = f + '\u0000' + text;
    let w = cache.get(key);
    if (w === undefined) {
      ctx.font = f;
      w = ctx.measureText(text).width;
      if (font.extended) w += text.length;
      if (font.condensed) w -= text.length;
      cache.set(key, w);
    }
    return w;
  };
}

/** Classic Mac font metrics, as fractions of the point size. */
export function lineMetrics(font: FontStyle): { ascent: number; descent: number; leading: number } {
  const s = font.size;
  const serif = font.fontId === 20 || font.fontId === 2 || font.fontId === 16 || font.fontId === 34;
  const ascent = Math.ceil(s * (serif ? 0.75 : 0.77));
  const descent = Math.ceil(s * 0.23);
  const leading = Math.max(0, Math.round(s * 0.08));
  return { ascent, descent, leading };
}

const DEFAULT_RULER: Ruler = {
  index: -1,
  align: 'left',
  spacing: { kind: 'lines', value: 1 },
  firstIndent: 0,
  leftIndent: 0,
  rightIndent: 0,
  spaceBefore: 0,
  spaceAfter: 0,
  tabs: [],
  bullet: false,
};

function fontAt(zone: TextZone, pos: number): { font: FontStyle; next: number } {
  let idx = 0;
  let next = Infinity;
  for (let i = 0; i < zone.fonts.length; i++) {
    const p = zone.fonts[i].pos;
    if (p <= pos) idx = i;
    else if (p < next) next = p;
  }
  return { font: zone.fonts[idx]?.font ?? defaultFont(), next };
}

export function defaultFont(): FontStyle {
  return {
    fontId: 21, size: 12, color: 1, bold: false, italic: false, underline: false, outline: false,
    shadow: false, condensed: false, extended: false, strike: false, superscript: false, subscript: false,
  };
}

function rulerAt(zone: TextZone, rulers: Ruler[], pos: number): Ruler {
  let id = -1;
  for (const p of zone.paragraphs) if (p.pos <= pos) id = p.ruler;
  return rulers[id] ?? DEFAULT_RULER;
}

interface Piece {
  text: string;
  font: FontStyle;
  width: number;
  space: boolean;
}

/**
 * Lays out a text zone into lines that fit `width` points.
 * Paragraphs end at '\r'. Words break at spaces; a word wider than the
 * line breaks between characters.
 */
export function layoutText(zone: TextZone, rulers: Ruler[], width: number, measure: Measure): TextLayout {
  const lines: LaidLine[] = [];
  let y = 0;
  const text = zone.text;
  let paraStart = 0;
  while (paraStart <= text.length) {
    let paraEnd = text.indexOf('\r', paraStart);
    if (paraEnd < 0) paraEnd = text.length;
    const ruler = rulerAt(zone, rulers, paraStart);
    // split the paragraph into pieces of constant font, then into words
    const pieces: Piece[] = [];
    let p = paraStart;
    while (p < paraEnd) {
      const { font, next } = fontAt(zone, p);
      const end = Math.max(p + 1, Math.min(paraEnd, next));
      // drop control characters (placeholders in master slides are NUL)
      const chunk = text.slice(p, end).replace(/[\x00-\x08\x0b-\x1f]/g, '');
      for (const m of chunk.matchAll(/[^ \t]+|[ \t]+/g)) {
        const t = m[0].replace(/\t/g, '    ');
        pieces.push({ text: t, font, width: measure(t, font), space: /^\s+$/.test(t) });
      }
      p = end;
    }
    const paraFont = fontAt(zone, Math.min(paraStart, Math.max(0, text.length - 1))).font;
    y += ruler.spaceBefore;
    const left = ruler.leftIndent + (ruler.bullet ? BULLET_TEXT_INDENT : 0);
    const right = width - Math.max(0, ruler.rightIndent);
    let first = true;
    let i = 0;
    const emit = (line: Piece[], isFirst: boolean) => {
      // trim trailing spaces
      while (line.length && line[line.length - 1].space) line.pop();
      const indent = isFirst && !ruler.bullet ? left + ruler.firstIndent : left;
      const avail = Math.max(1, right - indent);
      const lineW = line.reduce((s, q) => s + q.width, 0);
      let x = indent;
      if (ruler.align === 'center') x = indent + (avail - lineW) / 2;
      else if (ruler.align === 'right') x = indent + avail - lineW;
      let asc = 0;
      let desc = 0;
      let lead = 0;
      for (const q of line.length ? line : [{ font: paraFont } as Piece]) {
        const m = lineMetrics(q.font);
        asc = Math.max(asc, m.ascent);
        desc = Math.max(desc, m.descent);
        lead = Math.max(lead, m.leading);
      }
      let h = asc + desc + lead;
      if (ruler.spacing.kind === 'lines') h = h * ruler.spacing.value;
      else if (ruler.spacing.value > 0) h = Math.max(h, ruler.spacing.value);
      const spans: LaidSpan[] = [];
      for (const q of line) {
        const last = spans[spans.length - 1];
        if (last && last.font === q.font) {
          last.text += q.text;
          last.width += q.width;
        } else spans.push({ text: q.text, font: q.font, x, width: q.width });
        x += q.width;
      }
      const line0: LaidLine = { baseline: y + asc, height: h, spans, width: lineW };
      if (ruler.bullet && isFirst && line.length) {
        const f = line[0].font;
        const size = f.size * 0.62;
        line0.bullet = { x: indent - size - f.size * 0.25, size, font: f };
      }
      lines.push(line0);
      y += h;
    };
    if (!pieces.length) {
      emit([], true);
    }
    while (i < pieces.length) {
      const indent = first && !ruler.bullet ? left + ruler.firstIndent : left;
      const avail = Math.max(1, right - indent);
      const line: Piece[] = [];
      let w = 0;
      while (i < pieces.length) {
        const q = pieces[i];
        if (w + q.width <= avail + 0.5 || (!line.length && !q.space && q.width <= avail + 0.5)) {
          line.push(q);
          w += q.width;
          i++;
          continue;
        }
        if (q.space) {
          i++;
          break;
        }
        if (!line.length) {
          // break inside a long word; always consume at least one character
          if (q.text.length <= 1) {
            line.push(q);
            i++;
          } else {
            let n = q.text.length - 1;
            while (n > 1 && measure(q.text.slice(0, n), q.font) > avail) n--;
            const head = q.text.slice(0, n);
            line.push({ ...q, text: head, width: measure(head, q.font) });
            pieces[i] = { ...q, text: q.text.slice(n), width: measure(q.text.slice(n), q.font) };
          }
        }
        break;
      }
      emit(line, first);
      first = false;
    }
    y += ruler.spaceAfter;
    paraStart = paraEnd + 1;
    if (paraEnd >= text.length) break;
  }
  return { lines, height: y };
}
