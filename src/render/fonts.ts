import type { FontStyle } from '../impact/model.ts';

/** Classic Mac OS font family numbers and the closest web font stacks. */
const MAC_FONTS: Record<number, { name: string; css: string }> = {
  0: { name: 'Chicago', css: "Chicago, Charcoal, 'Helvetica Neue', Arial, sans-serif" },
  1: { name: 'Geneva', css: "Geneva, Verdana, 'DejaVu Sans', sans-serif" },
  2: { name: 'New York', css: "'New York', 'Times New Roman', Times, serif" },
  3: { name: 'Geneva', css: "Geneva, Verdana, 'DejaVu Sans', sans-serif" },
  4: { name: 'Monaco', css: "Monaco, Menlo, Consolas, monospace" },
  5: { name: 'Venice', css: "'Apple Chancery', cursive" },
  6: { name: 'London', css: "'Old English Text MT', serif" },
  7: { name: 'Athens', css: "Georgia, serif" },
  8: { name: 'San Francisco', css: "'Helvetica Neue', sans-serif" },
  9: { name: 'Toronto', css: "Georgia, serif" },
  11: { name: 'Cairo', css: 'sans-serif' },
  12: { name: 'Los Angeles', css: "'Comic Sans MS', cursive" },
  13: { name: 'Zapf Dingbats', css: "'Zapf Dingbats', 'Wingdings', sans-serif" },
  14: { name: 'Bookman', css: "'Bookman Old Style', Bookman, 'URW Bookman', Georgia, serif" },
  15: { name: 'Helvetica Narrow', css: "'Helvetica Neue Condensed', 'Arial Narrow', Helvetica, Arial, sans-serif" },
  16: { name: 'Palatino', css: "Palatino, 'Palatino Linotype', 'Book Antiqua', 'URW Palladio L', serif" },
  18: { name: 'Zapf Chancery', css: "'Zapf Chancery', 'Apple Chancery', 'URW Chancery L', cursive" },
  20: { name: 'Times', css: "Times, 'Times New Roman', 'Liberation Serif', serif" },
  21: { name: 'Helvetica', css: "Helvetica, Arial, 'Liberation Sans', sans-serif" },
  22: { name: 'Courier', css: "Courier, 'Courier New', 'Liberation Mono', monospace" },
  23: { name: 'Symbol', css: 'Symbol, serif' },
  24: { name: 'Taliesin', css: 'serif' },
  33: { name: 'Avant Garde', css: "'Avant Garde', 'ITC Avant Garde Gothic', 'Century Gothic', 'URW Gothic', sans-serif" },
  34: { name: 'New Century Schoolbook', css: "'New Century Schoolbook', 'Century Schoolbook', 'C059', Georgia, serif" },
};

const NAMED: Record<string, string> = {
  times: MAC_FONTS[20].css,
  'times new roman': MAC_FONTS[20].css,
  helvetica: MAC_FONTS[21].css,
  arial: "Arial, Helvetica, 'Liberation Sans', sans-serif",
  geneva: MAC_FONTS[3].css,
  courier: MAC_FONTS[22].css,
  'courier new': MAC_FONTS[22].css,
  palatino: MAC_FONTS[16].css,
  'new york': MAC_FONTS[2].css,
  chicago: MAC_FONTS[0].css,
  monaco: MAC_FONTS[4].css,
  symbol: MAC_FONTS[23].css,
};

export function fontName(f: FontStyle): string {
  if (f.fontName) return f.fontName;
  return MAC_FONTS[f.fontId]?.name ?? `Font ${f.fontId}`;
}

/** Picks a fallback family from words in a font name (Bitstream names such as "Futura Md BT"). */
function guessStack(name: string): string {
  const k = name.toLowerCase();
  const own = `'${name.replace(/'/g, '')}'`;
  const rules: [RegExp, string][] = [
    [/bodoni|didot/, "'Bodoni 72', 'Bodoni MT', Didot, 'Times New Roman', serif"],
    [/geoslb|slab|rockwell|serifa|memphis|lubalin/, "Rockwell, 'Roboto Slab', 'Courier New', serif"],
    [/futura|century gothic|avant|kabel/, "Futura, 'Century Gothic', 'Trebuchet MS', sans-serif"],
    [/garamond/, "Garamond, 'EB Garamond', 'Times New Roman', serif"],
    [/palatino|zapf calligraphic|book antiqua/, MAC_FONTS[16].css],
    [/times|roman|dutch|schoolbook|century|bookman|georgia|serif/, MAC_FONTS[20].css],
    [/courier|mono|typewriter|letter gothic/, MAC_FONTS[22].css],
    [/helv|arial|swiss|univers|frutiger|gill|optima|humanst|sans|geneva|verdana/, MAC_FONTS[21].css],
    [/chancery|script|brush|park avenue/, MAC_FONTS[18].css],
    [/symbol/, 'Symbol, serif'],
    [/dingbat|wingding/, MAC_FONTS[13].css],
  ];
  for (const [re, css] of rules) if (re.test(k)) return `${own}, ${css}`;
  return `${own}, Helvetica, Arial, sans-serif`;
}

export function fontStack(f: FontStyle): string {
  if (f.fontName) {
    const k = f.fontName.toLowerCase();
    return NAMED[k] ?? guessStack(f.fontName);
  }
  return MAC_FONTS[f.fontId]?.css ?? 'Helvetica, Arial, sans-serif';
}

/** CSS font shorthand, used for canvas measurement. */
export function cssFont(f: FontStyle): string {
  const style = f.italic ? 'italic ' : '';
  const weight = f.bold ? 'bold ' : '';
  return `${style}${weight}${f.size}px ${fontStack(f)}`;
}

/** Rough per-family width factor for environments without a canvas. */
export function approxCharWidth(f: FontStyle): number {
  const id = f.fontId;
  let k = 0.5;
  if (id === 20 || id === 2) k = 0.44;
  else if (id === 22 || id === 4) k = 0.6;
  else if (id === 21 || id === 3 || id === 0) k = 0.52;
  if (f.bold) k *= 1.07;
  return k * f.size;
}
