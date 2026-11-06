// The lineage graph's DOM (M9 T13): the nodes are links laid over an SVG of the edges, inside a box
// that scrolls on its own when the graph is wider or taller than the card. Each node opens that
// creature's card (Tab, then Enter, as any link); an ancestor not loaded has a Load button instead.

import { capitalise } from '../game/badge';
import {
  type CardGraph,
  type CardGraphNode,
  cardLink,
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
} from './lineage-graph';

const SVG = 'http://www.w3.org/2000/svg';
/** How far apart two parents' edges meet their child, in pixels. */
const EDGE_SPREAD = 28;

/** Where an ancestor's own bundle is: on its way, or could not be had (Load offers it again). */
export type LoadState = 'loading' | 'failed';

export interface GraphViewOptions {
  /** The section that holds the graph, hidden while the subject is alone in it. */
  section: HTMLElement;
  /** The scroll box. */
  box: HTMLElement;
  /** This page's query, whose local hub and preset the links carry over. */
  search: string;
  /** Load an ancestor the proof left out. */
  onLoad(id: string): void;
}

const MARK = {
  yes: ['✓', 'Verified'],
  no: ['✗', 'Not verified'],
  wait: ['…', 'Not checked yet'],
} as const;

function markOf(n: CardGraphNode): keyof typeof MARK {
  return n.verified === null ? 'wait' : n.verified ? 'yes' : 'no';
}

function span(cls: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

/** The line under the name: the generation, and whether it was hatched rather than born. */
function metaOf(n: CardGraphNode): string {
  const gen = n.generation === null ? '' : `Generation ${n.generation}`;
  return [gen, n.root ? 'Genesis' : ''].filter(Boolean).join(' · ');
}

/** What a node says to a screen reader and in its tooltip. */
function labelOf(n: CardGraphNode): string {
  const parts = [n.species ?? 'An ancestor not loaded'];
  if (n.generation !== null) parts.push(`generation ${n.generation}`);
  if (n.tier) parts.push(n.tier);
  if (n.root) parts.push('first of its line');
  if (n.loaded) parts.push(MARK[markOf(n)][1].toLowerCase());
  if (n.subject) parts.push('this card');
  else if (n.branch) parts.push('on the line this creature took over from');
  return capitalise(parts.join(', '));
}

export class GraphView {
  private readonly loads = new Map<string, LoadState>();
  private last: CardGraph | null = null;
  private scrolled = false;

  constructor(private readonly opts: GraphViewOptions) {}

  /** Marks an ancestor's load, or clears it, and draws again. */
  setLoad(id: string, state: LoadState | null): void {
    if (state) this.loads.set(id, state);
    else this.loads.delete(id);
    if (this.last) this.draw(this.last);
  }

  draw(g: CardGraph): void {
    this.last = g;
    const { section, box } = this.opts;
    section.hidden = g.nodes.length < 2;
    if (section.hidden) return;
    // A redraw keeps the focus on the node (or its Load button) that had it.
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
      '[data-node]',
    )?.dataset.node;

    const plane = document.createElement('div');
    plane.className = 'graph-plane';
    plane.style.width = `${g.width}px`;
    plane.style.height = `${g.height}px`;
    plane.append(this.edges(g));
    for (const n of g.nodes) plane.append(this.node(n));
    box.replaceChildren(plane);

    if (focused) {
      const el = box.querySelector<HTMLElement>(`[data-node="${focused}"]`);
      const target = el?.matches('a') ? el : el?.querySelector('button');
      target?.focus({ preventScroll: true });
    }
    // The first time, the subject is in view: the bottom row, centred on it.
    const subject = g.nodes.find((n) => n.subject);
    if (!this.scrolled && subject && box.clientWidth > 0) {
      this.scrolled = true;
      box.scrollLeft = subject.x + GRAPH_NODE_WIDTH / 2 - box.clientWidth / 2;
      box.scrollTop = box.scrollHeight;
    }
  }

  private edges(g: CardGraph): SVGSVGElement {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'graph-edges');
    svg.setAttribute('width', String(g.width));
    svg.setAttribute('height', String(g.height));
    svg.setAttribute('viewBox', `0 0 ${g.width} ${g.height}`);
    svg.setAttribute('aria-hidden', 'true');
    const at = new Map(g.nodes.map((n) => [n.id, n]));
    // Each parent's edge meets its child on its own side of the child's top edge.
    const into = new Map<string, number>();
    for (const id of new Set(g.edges.map((e) => e.to))) {
      const froms = g.edges
        .filter((e) => e.to === id)
        .sort((a, b) => (at.get(a.from)?.x ?? 0) - (at.get(b.from)?.x ?? 0));
      for (const [i, e] of froms.entries())
        into.set(`${e.from}|${id}`, (i - (froms.length - 1) / 2) * EDGE_SPREAD);
    }
    // The branch last, so it runs over the others where they cross.
    const edges = [...g.edges].sort((a, b) => Number(a.branch) - Number(b.branch));
    for (const e of edges) {
      const from = at.get(e.from);
      const to = at.get(e.to);
      if (!from || !to) continue;
      const [x1, y1] = [from.x + GRAPH_NODE_WIDTH / 2, from.y + GRAPH_NODE_HEIGHT];
      const [x2, y2] = [to.x + GRAPH_NODE_WIDTH / 2 + (into.get(`${e.from}|${e.to}`) ?? 0), to.y];
      const bend = Math.min(40, (y2 - y1) / 2);
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', `M${x1} ${y1} C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}`);
      path.setAttribute('class', e.branch ? 'graph-edge branch' : 'graph-edge');
      if (!from.loaded) path.classList.add('faint');
      path.dataset.testid = 'graph-edge';
      svg.append(path);
    }
    return svg;
  }

  private node(n: CardGraphNode): HTMLElement {
    let el: HTMLElement;
    if (n.subject) {
      el = document.createElement('div');
      el.setAttribute('aria-current', 'page');
    } else if (n.loaded) {
      const a = document.createElement('a');
      a.href = cardLink(n.id, this.opts.search);
      el = a;
    } else {
      el = document.createElement('div');
    }
    el.className = 'graph-node';
    el.dataset.node = n.id;
    el.dataset.testid = 'graph-node';
    el.toggleAttribute('data-branch', n.branch);
    el.toggleAttribute('data-root', n.root);
    el.toggleAttribute('data-subject', n.subject);
    el.toggleAttribute('data-unloaded', !n.loaded);
    // A common creature keeps the plain stripe (the page's own tier would show through otherwise).
    if (n.tier && n.tier !== 'common') el.dataset.tier = n.tier;
    Object.assign(el.style, {
      left: `${n.x}px`,
      top: `${n.y}px`,
      width: `${GRAPH_NODE_WIDTH}px`,
      height: `${GRAPH_NODE_HEIGHT}px`,
    });
    el.title = labelOf(n);

    if (!n.loaded) {
      el.append(span('graph-name', 'Not loaded'), this.loadButton(n.id));
      return el;
    }
    const kind = markOf(n);
    const mark = span('graph-mark', MARK[kind][0]);
    mark.dataset.mark = kind;
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', MARK[kind][1]);
    const head = document.createElement('span');
    head.className = 'graph-head';
    head.append(mark, span('graph-name', n.species ?? 'Unknown'));
    el.append(head, span('graph-meta', metaOf(n)));
    if (!n.subject) el.setAttribute('aria-label', `${labelOf(n)}. Open its card`);
    return el;
  }

  private loadButton(id: string): HTMLButtonElement {
    const state = this.loads.get(id);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'graph-load';
    button.dataset.testid = 'graph-load';
    button.textContent =
      state === 'loading' ? 'Loading…' : state === 'failed' ? "Couldn't load: retry" : 'Load';
    button.disabled = state === 'loading';
    button.setAttribute('aria-label', `${button.textContent} this ancestor and check it`);
    button.addEventListener('click', () => this.opts.onLoad(id));
    return button;
  }
}
