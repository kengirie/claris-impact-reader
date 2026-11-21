import { parsePict, type Pict, type PictOp } from './pict.ts';

const MAC_FONT_CSS: Record<number, string> = {
  0: 'Chicago, Charcoal, sans-serif',
  2: "'New York', 'Times New Roman', serif",
  3: 'Geneva, Verdana, sans-serif',
  4: 'Monaco, Menlo, monospace',
  16: 'Palatino, "Palatino Linotype", serif',
  20: "Times, 'Times New Roman', serif",
  21: 'Helvetica, Arial, sans-serif',
  22: "Courier, 'Courier New', monospace",
};

function pathFor(ctx: CanvasRenderingContext2D, op: Extract<PictOp, { op: 'shape' }>) {
  const { rect } = op;
  const x = rect.left;
  const y = rect.top;
  const w = rect.right - rect.left;
  const h = rect.bottom - rect.top;
  ctx.beginPath();
  switch (op.shape) {
    case 'oval':
      ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
      break;
    case 'rrect': {
      const rx = Math.min(Math.abs(w) / 2, (op.oval?.[0] ?? 0) / 2);
      const ry = Math.min(Math.abs(h) / 2, (op.oval?.[1] ?? 0) / 2);
      ctx.roundRect(x, y, w, h, [Math.min(rx, ry)]);
      break;
    }
    case 'arc': {
      // QuickDraw: start angle measured clockwise from 12 o'clock
      const [start, extent] = op.arc ?? [0, 360];
      const a0 = ((start - 90) * Math.PI) / 180;
      const a1 = ((start + extent - 90) * Math.PI) / 180;
      ctx.moveTo(x + w / 2, y + h / 2);
      ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, a0, a1, extent < 0);
      ctx.closePath();
      break;
    }
    case 'poly': {
      const pts = op.points ?? [];
      pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      if (op.verb !== 'frame') ctx.closePath();
      break;
    }
    default:
      ctx.rect(x, y, w, h);
  }
}

export function drawPict(ctx: CanvasRenderingContext2D, pict: Pict) {
  const { frame } = pict;
  ctx.save();
  ctx.translate(-frame.left, -frame.top);
  for (const op of pict.ops) {
    if (op.op === 'origin') {
      ctx.translate(-op.dh, -op.dv);
      continue;
    }
    if (op.op === 'image') {
      const img = new ImageData(op.rgba, op.width, op.height);
      const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(op.width, op.height) : Object.assign(document.createElement('canvas'), { width: op.width, height: op.height });
      const cx = c.getContext('2d') as CanvasRenderingContext2D;
      cx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(c as CanvasImageSource, op.dst.left, op.dst.top, op.dst.right - op.dst.left, op.dst.bottom - op.dst.top);
    } else if (op.op === 'shape') {
      pathFor(ctx, op);
      if (op.verb === 'frame') {
        ctx.strokeStyle = op.color;
        ctx.lineWidth = Math.max(op.penW, op.penH);
        ctx.save();
        // QuickDraw pens draw inside the shape
        ctx.translate(op.penW / 2, op.penH / 2);
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.fillStyle = op.color;
        ctx.fill();
      }
    } else if (op.op === 'line') {
      ctx.strokeStyle = op.color;
      ctx.lineWidth = Math.max(op.penW, op.penH);
      ctx.beginPath();
      ctx.moveTo(op.x1 + op.penW / 2, op.y1 + op.penH / 2);
      ctx.lineTo(op.x2 + op.penW / 2, op.y2 + op.penH / 2);
      ctx.stroke();
    } else if (op.op === 'text') {
      const family = MAC_FONT_CSS[op.font] ?? (op.fontName ? `'${op.fontName}', sans-serif` : 'Helvetica, Arial, sans-serif');
      ctx.font = `${op.face & 2 ? 'italic ' : ''}${op.face & 1 ? 'bold ' : ''}${op.size}px ${family}`;
      ctx.fillStyle = op.color;
      ctx.fillText(op.text, op.x, op.y);
    }
  }
  ctx.restore();
}

const cache = new WeakMap<Uint8Array, { url: string; width: number; height: number } | null>();

/** Decodes a PICT and returns a PNG data URL (browser only). */
export function pictToDataUrl(data: Uint8Array): { url: string; width: number; height: number } | null {
  if (cache.has(data)) return cache.get(data)!;
  let result: { url: string; width: number; height: number } | null = null;
  try {
    if (typeof document === 'undefined') return null;
    const pict = parsePict(data);
    const w = pict.frame.right - pict.frame.left;
    const h = pict.frame.bottom - pict.frame.top;
    if (w > 0 && h > 0 && w < 10000 && h < 10000) {
      const canvas = document.createElement('canvas');
      // render at 2x so small pictures stay sharp when zoomed
      const scale = 2;
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext('2d')!;
      ctx.scale(scale, scale);
      drawPict(ctx, pict);
      result = { url: canvas.toDataURL('image/png'), width: w, height: h };
    }
  } catch {
    result = null;
  }
  cache.set(data, result);
  return result;
}
