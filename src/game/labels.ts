import type { RemoteView } from '../net/pond-sync';

/** Where the camera looks and how big a world unit is on screen, in CSS pixels. */
export interface LabelProjection {
  camX: number;
  camY: number;
  pxPerWu: number;
  width: number;
  height: number;
}

/** Screen position (CSS pixels) of a world position. */
export function screenX(wx: number, p: LabelProjection): number {
  return p.width / 2 + (wx - p.camX) * p.pxPerWu;
}

export function screenY(wy: number, p: LabelProjection): number {
  return p.height / 2 - (wy - p.camY) * p.pxPerWu;
}

export type Anchor = 'above' | 'centre';

/**
 * A CSS transform that puts the anchor point of a box of `width` × `height` CSS pixels at (x, y):
 * its bottom centre (`above`) or its centre. Whole pixels only, so text never blurs (M6 T21): a
 * percentage offset lands on half pixels whenever the box's size is odd.
 */
export function anchorTransform(
  x: number,
  y: number,
  width: number,
  height: number,
  anchor: Anchor,
): string {
  const left = Math.round(x - width / 2);
  const top = Math.round(anchor === 'above' ? y - height : y - height / 2);
  return `translate(${left}px, ${top}px)`;
}

/**
 * Moves an absolutely positioned element so its anchor point sits at (x, y), on whole pixels. Its
 * size is read back, which costs a layout only when its content changed since the last read.
 */
export function placeAt(element: HTMLElement, x: number, y: number, anchor: Anchor): void {
  const transform = anchorTransform(x, y, element.offsetWidth, element.offsetHeight, anchor);
  if (element.style.transform !== transform) element.style.transform = transform;
}

/** Gap between a cell's edge and its name, in CSS pixels. */
const GAP_PX = 8;
const FADED = 0.01;

/** Names above the other players' cells: DOM text, positioned from the camera each frame. */
export class RemoteLabels {
  private readonly elements: HTMLElement[] = [];

  constructor(private readonly root: HTMLElement) {}

  update(remotes: readonly RemoteView[], p: LabelProjection): void {
    let used = 0;
    for (const remote of remotes) {
      if (remote.alpha < FADED) continue;
      const x = screenX(remote.x, p);
      const y = screenY(remote.y, p) - remote.radius * p.pxPerWu - GAP_PX;
      const element = this.elementAt(used);
      used++;
      // Names come from other players: text only, never markup.
      if (element.textContent !== remote.name) element.textContent = remote.name;
      element.hidden = false;
      placeAt(element, x, y, 'above');
      element.style.opacity = String(Math.round(remote.alpha * 100) / 100);
    }
    for (let i = used; i < this.elements.length; i++)
      (this.elements[i] as HTMLElement).hidden = true;
  }

  private elementAt(index: number): HTMLElement {
    let element = this.elements[index];
    if (!element) {
      element = document.createElement('span');
      element.className = 'remote-label';
      element.hidden = true;
      this.root.append(element);
      this.elements[index] = element;
    }
    return element;
  }
}
