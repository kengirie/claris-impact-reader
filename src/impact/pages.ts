import type { GroupZone, ImpactDocument } from './model.ts';

export interface Page {
  /** group zone drawn for this page */
  id: number;
  /** a short label: the first line of text on the page, or "Page n" */
  title: string;
  width: number;
  height: number;
  /** group drawn behind this page (the master slide), if any */
  masterId?: number;
}

export interface DocumentLayout {
  kind: 'drawing' | 'presentation';
  pages: Page[];
  masterId?: number;
}

/** A page group starts with a page frame object (type 1, flags 0x0A). */
function isPageGroup(g: GroupZone): boolean {
  const o = g.objects[0];
  return !!o && o.typeId === 1 && o.flags === 0x0a;
}

function hasContent(doc: ImpactDocument, id: number, depth = 0): boolean {
  const z = doc.zones.get(id);
  if (!z || depth > 8) return false;
  if (z.kind === 'text') return z.text.trim().length > 0;
  if (z.kind !== 'group') return true;
  return z.objects.some((o) => (o.typeId === 1 ? hasContent(doc, o.childId, depth + 1) : true));
}

function firstText(doc: ImpactDocument, id: number, depth = 0): string | undefined {
  const z = doc.zones.get(id);
  if (!z || depth > 6) return undefined;
  if (z.kind === 'text') return z.text.split('\r').map((s) => s.trim()).find(Boolean);
  if (z.kind !== 'group') return undefined;
  for (const o of z.objects.slice(1)) {
    if (o.typeId === 1) {
      const t = firstText(doc, o.childId, depth + 1);
      if (t) return t;
    }
  }
  return undefined;
}

export function documentLayout(doc: ImpactDocument): DocumentLayout {
  const groups = [...doc.zones.values()].filter((z): z is GroupZone => z.kind === 'group');
  const pageGroups = groups.filter(isPageGroup);
  const content = pageGroups.filter((g) => g.objects.length > 1);
  const root = doc.zones.get(doc.rootId);
  const size = (g: GroupZone) => ({ width: g.objects[0].box.x1 - g.objects[0].box.x0, height: g.objects[0].box.y1 - g.objects[0].box.y0 });
  if (content.length <= 1) {
    const g = content[0] ?? (root && root.kind === 'group' ? root : undefined);
    if (!g) return { kind: 'drawing', pages: [] };
    return { kind: 'drawing', pages: [{ id: g.id, title: firstText(doc, g.id) ?? 'Page 1', ...size(g) }] };
  }
  // the master: a page with only its frame, whose frame holds drawings
  const master = pageGroups.find((g) => g.objects.length === 1 && hasContent(doc, g.objects[0].childId));
  const pages = content.map((g, i) => ({
    id: g.id,
    title: firstText(doc, g.id) ?? `Slide ${i + 1}`,
    masterId: master?.id,
    ...size(g),
  }));
  return { kind: 'presentation', pages, masterId: master?.id };
}
