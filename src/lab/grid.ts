// Where the Lab's creatures sit (M3 T13, T14): a plain grid of 24 over the stage with a strip of 8
// offspring under it, and the size of a core radius that lets the longest body (and the hover lift)
// stay inside its own cell.

export const COLS = 6;
export const ROWS = 4;
/** Offspring of a Breed, in one row under the grid; their indices follow the grid's. */
export const STRIP_COLS = 8;
/** Grid rows plus the strip, all of the same height. */
const TOTAL_ROWS = ROWS + 1;
export const GRID_COUNT = COLS * ROWS;
export const CELL_COUNT = GRID_COUNT + STRIP_COLS;

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

/** The size of one grid cell of a stage. */
export const cellSize = (width: number, height: number): { w: number; h: number } => ({
  w: width / COLS,
  h: height / TOTAL_ROWS,
});

/** The size of one cell of the offspring strip. */
export const stripSize = (width: number, height: number): { w: number; h: number } => ({
  w: width / STRIP_COLS,
  h: height / TOTAL_ROWS,
});

export function cellRect(index: number, width: number, height: number): Rect {
  if (index >= GRID_COUNT) {
    const { w, h } = stripSize(width, height);
    return { x: (index - GRID_COUNT) * w, y: ROWS * h, w, h };
  }
  const { w, h } = cellSize(width, height);
  return { x: (index % COLS) * w, y: Math.floor(index / COLS) * h, w, h };
}

/** The cell under a point of the stage (pixels from its top left), or -1. */
export function cellAt(x: number, y: number, width: number, height: number): number {
  if (x < 0 || y < 0 || x >= width || y >= height) return -1;
  const { w, h } = cellSize(width, height);
  const row = Math.floor(y / h);
  if (row >= ROWS) return GRID_COUNT + Math.floor(x / stripSize(width, height).w);
  return row * COLS + Math.floor(x / w);
}

/** The core radius, in pixels, of a creature in a cell of this size. */
export function coreRadius(cellWidth: number, cellHeight: number): number {
  return (Math.min(cellWidth, cellHeight) / 2 / (REACH * HOVER_SCALE)) * FILL;
}

/** The one core radius of a stage: the smaller of the grid cells' and the strip cells', so every body fits. */
export function stageCoreRadius(width: number, height: number): number {
  const cell = cellSize(width, height);
  const strip = stripSize(width, height);
  return Math.min(coreRadius(cell.w, cell.h), coreRadius(strip.w, strip.h));
}
