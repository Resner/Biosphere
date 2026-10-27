// The Lineage panel (M5 T13): your creatures newest first and the family graph behind them.
// It asks the hub when it opens and redraws whenever a `lineage` answer arrives.

import type { LineageEntry, PedigreeNode } from '../net/protocol';
import { rarityBadge } from './badge';
import { pick } from './dom';
import { type GraphNode, lineageView, NODE_HEIGHT, NODE_WIDTH } from './lineage-view';

const SVG = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** The Lab page that shows one body. */
export const labHref = (genome: string): string => `lab.html?genome=${encodeURIComponent(genome)}`;

export class LineagePanel {
  private readonly panel = pick('[data-testid="lineage"]');
  private readonly chain = pick('[data-testid="lineage-chain"]');
  private readonly graph = pick('[data-testid="lineage-graph"]');
  private readonly empty = pick('[data-testid="lineage-empty"]');
  private readonly more = pick('[data-testid="lineage-more"]');
  private latest: { creatures: LineageEntry[]; pedigree: PedigreeNode[] } = {
    creatures: [],
    pedigree: [],
  };

  constructor(private readonly ask: () => void) {
    pick('[data-testid="lineage-close"]').addEventListener('click', () => this.close());
    pick('[data-testid="lineage-open"]').addEventListener('click', () => this.open());
    this.panel.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    });
    // A new screen starts without the panel, so Hatch and the death screen are never covered.
    new MutationObserver(() => {
      if (document.body.dataset.screen === 'dead') this.close();
    }).observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  open(): void {
    this.panel.hidden = false;
    this.draw();
    this.ask();
  }

  close(): void {
    this.panel.hidden = true;
  }

  /** Takes the hub's answer; draws only while the panel is open. */
  receive(creatures: LineageEntry[], pedigree: PedigreeNode[]): void {
    this.latest = { creatures, pedigree };
    if (this.isOpen) this.draw();
  }

  private draw(): void {
    const view = lineageView(this.latest.creatures, this.latest.pedigree);
    this.empty.hidden = !view.empty;
    this.more.hidden = !view.more;
    this.chain.replaceChildren(
      ...view.chain.map((row) => {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = labHref(row.genome);
        link.textContent = row.species;
        link.title = 'Open in the Creature Lab';
        const detail = document.createElement('span');
        detail.className = 'lineage-detail';
        detail.textContent = [`generation ${row.generation}`, row.state, row.life]
          .filter(Boolean)
          .join(' · ');
        item.append(link, ' ', rarityBadge(row.tier), detail);
        return item;
      }),
    );
    this.graph.replaceChildren();
    this.graph.hidden = view.empty;
    if (view.empty) return;
    this.graph.setAttribute('viewBox', `-4 -4 ${view.width + 8} ${view.height + 8}`);
    const byId = new Map(view.nodes.map((n) => [n.id, n]));
    for (const edge of view.edges) {
      const from = byId.get(edge.from) as GraphNode;
      const to = byId.get(edge.to) as GraphNode;
      const line = svg('path', {
        d: `M${from.x + NODE_WIDTH} ${from.y + NODE_HEIGHT / 2} L${to.x} ${to.y + NODE_HEIGHT / 2}`,
        class: edge.branch ? 'edge branch' : 'edge',
      });
      line.dataset.testid = 'lineage-edge';
      this.graph.append(line);
    }
    for (const n of view.nodes) {
      const a = svg('a', { href: labHref(n.genome) });
      const g = svg('g', {
        class: `node${n.branch ? ' branch' : ''}${n.mine ? ' mine' : ''}${n.root ? ' root' : ''}`,
      });
      g.dataset.testid = 'lineage-node';
      const title = svg('title', {});
      title.textContent = `${n.label}${n.root ? ' · first of its line' : ''}`;
      g.append(
        svg('rect', { x: n.x, y: n.y, width: NODE_WIDTH, height: NODE_HEIGHT, rx: 5 }),
        title,
      );
      const text = svg('text', { x: n.x + 6, y: n.y + NODE_HEIGHT / 2 + 4 });
      text.textContent = n.name;
      g.append(text);
      a.append(g);
      this.graph.append(a);
    }
  }
}
