// Where the Lab's 24 creatures sit (M3 T13): a plain grid over the stage, and the size of a core
// radius that lets the longest body (and the hover lift) stay inside its own cell.

export const COLS = 6;
export const ROWS = 4;

/** The longest a body reaches, in core radii, with its 5% slack (`BodyPlan` cap) and the hover lift. */
export const REACH = 2.5 * 1.05;
export const HOVER_SCALE = 1.15;
/** Share of half a cell that the longest body fills. */
const FILL = 0.96;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The size of one cell of a stage. */
export const cellSize = (width: number, height: number): { w: number; h: number } => ({
  w: width / COLS,
  h: height / ROWS,
});

export function cellRect(index: number, width: number, height: number): Rect {
  const { w, h } = cellSize(width, height);
  return { x: (index % COLS) * w, y: Math.floor(index / COLS) * h, w, h };
}

/** The cell under a point of the stage (pixels from its top left), or -1. */
export function cellAt(x: number, y: number, width: number, height: number): number {
  if (x < 0 || y < 0 || x >= width || y >= height) return -1;
  const { w, h } = cellSize(width, height);
  return Math.floor(y / h) * COLS + Math.floor(x / w);
}

/** The core radius, in pixels, of a creature in a cell of this size. */
export function coreRadius(cellWidth: number, cellHeight: number): number {
  return (Math.min(cellWidth, cellHeight) / 2 / (REACH * HOVER_SCALE)) * FILL;
}
