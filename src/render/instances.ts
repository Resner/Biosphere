/** A cheap stable fraction in [0, 1) from an id, so an item keeps its angle and phase. */
export function idFraction(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/**
 * Writes a 2D transform into slot `n` of an instance matrix array: rotation by `angle`, uniform
 * `size`, a translation, and `phase` in the otherwise unused z scale and `alpha` in the unused w row (the shaders read them back).
 */
export function writeInstance(
  array: ArrayLike<number> & { [index: number]: number },
  n: number,
  x: number,
  y: number,
  size: number,
  angle: number,
  phase: number,
  alpha = 0,
): void {
  const c = Math.cos(angle) * size;
  const s = Math.sin(angle) * size;
  const o = n * 16;
  array[o] = c;
  array[o + 1] = s;
  array[o + 2] = 0;
  array[o + 3] = 0;
  array[o + 4] = -s;
  array[o + 5] = c;
  array[o + 6] = 0;
  array[o + 7] = 0;
  array[o + 8] = 0;
  array[o + 9] = 0;
  array[o + 10] = phase;
  array[o + 11] = alpha;
  array[o + 12] = x;
  array[o + 13] = y;
  array[o + 14] = 0;
  array[o + 15] = 1;
}
