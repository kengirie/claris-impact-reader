/** In-memory model of a ClarisImpact document, as recovered from the file. */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A length-prefixed block of bytes found in the file. */
export interface Block {
  offset: number;
  data: Uint8Array;
}

export interface Ruler {
  index: number;
  align: 'left' | 'center' | 'right' | 'justify';
  /** line spacing: either a multiple (1 = single) or a fixed point value */
  spacing: { kind: 'lines'; value: number } | { kind: 'points'; value: number };
  firstIndent: number;
  leftIndent: number;
  rightIndent: number;
  spaceBefore: number;
  spaceAfter: number;
  tabs: { pos: number; align: 'left' | 'center' | 'right' | 'decimal' }[];
  /** paragraphs start with a bullet (outline rulers) */
  bullet: boolean;
}

export interface Gradient {
  colors: RGB[];
  /** degrees, counter-clockwise from the +x axis; the first colour is at the tail */
  angle: number;
  /** 0 linear; other values are radial/rectangular in the original */
  type: number;
}

export interface FontStyle {
  fontId: number;
  fontName?: string;
  size: number;
  color: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  outline: boolean;
  shadow: boolean;
  condensed: boolean;
  extended: boolean;
  strike: boolean;
  superscript: boolean;
  subscript: boolean;
}

export interface TextStyleDef {
  index: number;
  name: string;
  font: FontStyle;
}

export interface TextZone {
  kind: 'text';
  id: number;
  offset: number;
  text: string;
  /** character runs, sorted by position */
  fonts: { pos: number; font: FontStyle }[];
  paragraphs: { pos: number; ruler: number }[];
  /** true when the file uses the 12-byte (version 2) character records */
  wideRecords?: boolean;
}

export interface GraphicObject {
  index: number;
  offset: number;
  typeId: number;
  /** byte 2 of the record: arrow / connection flags */
  flags: number;
  /** byte 3 of the record */
  subType: number;
  /** byte 1 of the record */
  wrap: number;
  box: Box;
  lineWidth: number;
  /** byte 21: 0x80 means "no line"? kept raw */
  lineFlags: number;
  lineColor: number;
  fillColor: number;
  linePattern: number;
  fillPattern: number;
  order: number;
  /** id of the zone this object points to (containers) */
  childId: number;
  /** value at offset 34 read as 16.16 fixed (angles for lines) */
  fixed34: number;
  /** value at offset 38 read as 16.16 fixed */
  fixed38: number;
  /** 16-bit word at offset 46: 3 marks a closed note */
  objFlags: number;
  /** points of a Bezier path object (type 8) */
  path?: PathPoint[];
  /** raw 56-byte record */
  raw: Uint8Array;
  /** associated data block, when one could be attached (pictures) */
  data?: Block;
}

export interface PathPoint {
  x: number;
  y: number;
  /** first control point */
  c1x: number;
  c1y: number;
  /** second control point */
  c2x: number;
  c2y: number;
  flags: number;
}

export interface GroupZone {
  kind: 'group';
  id: number;
  offset: number;
  objects: GraphicObject[];
  header?: Block;
  blocks: Block[];
}

export interface TableCell {
  text: string;
  font: FontStyle;
  /** palette index of the cell background, or -1 */
  fill: number;
  align: 'left' | 'center' | 'right';
}

export interface TableZone {
  kind: 'table';
  id: number;
  offset: number;
  numData: number;
  dataSize: number;
  blocks: Block[];
  raw: Uint8Array;
  columns: number;
  rows: number;
  /** cells[column][row] */
  cells: (TableCell | null)[][];
  /** sizes from the two size lists (total or per-cell, see renderer) */
  widthHint?: number;
  heightHint?: number;
}

export interface UnknownZone {
  kind: 'unknown';
  id: number;
  offset: number;
  fileType: number;
  blocks: Block[];
}

export type Zone = GroupZone | TextZone | TableZone | UnknownZone;

export interface ImpactDocument {
  /** 'CIPT' for documents, 'BOBO' for style and library files */
  signature: string;
  platform: 'mac' | 'windows';
  version: number;
  byteLength: number;
  /** true for the LZ-compressed files written by the Windows version */
  compressed: boolean;
  palette: RGB[];
  gradients: Gradient[];
  rulers: Ruler[];
  textStyles: TextStyleDef[];
  /** font number -> font name, when the file carries a font table */
  fontNames: Map<number, string>;
  zones: Map<number, Zone>;
  rootId: number;
  /** size of one printed page, in points, when known */
  page?: { width: number; height: number };
  warnings: string[];
}
