import type { RemoteView } from '../net/pond-sync';

/** Where the camera looks and how big a world unit is on screen, in CSS pixels. */
export interface LabelProjection {
  camX: number;
  camY: number;
  pxPerWu: number;
  width: number;
  height: number;
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
      const x = p.width / 2 + (remote.x - p.camX) * p.pxPerWu;
      const y = p.height / 2 - (remote.y - p.camY) * p.pxPerWu - remote.radius * p.pxPerWu - GAP_PX;
      const element = this.elementAt(used);
      used++;
      // Names come from other players: text only, never markup.
      if (element.textContent !== remote.name) element.textContent = remote.name;
      element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
      element.style.opacity = String(Math.round(remote.alpha * 100) / 100);
      element.hidden = false;
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
