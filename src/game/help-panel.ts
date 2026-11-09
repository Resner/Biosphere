// How to play (M14 T8): one glass panel with the loop, survival, growing and mating, fighting, the
// lineage, every control and what is kept where. `?` (the key's value, so any layout) opens it
// anywhere but in a text field, as do "How to play" on the title and Help in the menu. In play it is
// a side panel and steering carries on under it; on the title and death screens it is centred.
// `Help` is the logic over a `HelpView`, so it tests without a DOM; `HelpPanel` is the DOM.

import { CONTROLS, type Control, keysText } from './controls';
import { pick } from './dom';
import { HELP_SECTIONS, type HelpSectionId } from './help-text';

/** Opens and closes the panel: the key's value, whatever the layout puts it on. */
export const HELP_KEY = '?';

/** Something focus can go back to. */
export interface Focusable {
  readonly isConnected: boolean;
  focus(): void;
}

/** What `Help` asks of the page. */
export interface HelpView {
  show(open: boolean): void;
  /** Brings a section into view and moves focus onto its heading. */
  reveal(section: HelpSectionId): void;
  /** What holds focus now, or null for nothing (the body). */
  focused(): Focusable | null;
  /** Whether focus is inside the panel. */
  holdsFocus(): boolean;
  blur(): void;
}

/** `state().help`: whether it is open and the section it last opened or jumped to (null while closed). */
export interface HelpInfo {
  open: boolean;
  section: HelpSectionId | null;
}

export class Help {
  private shown = false;
  private section: HelpSectionId = 'play';
  /** What held focus when the panel opened, which gets it back on close. */
  private opener: Focusable | null = null;

  constructor(private readonly dom: HelpView) {}

  get isOpen(): boolean {
    return this.shown;
  }

  /** Opens at a section, or moves to it when already open. */
  open(section: HelpSectionId = 'play'): void {
    if (!this.shown) this.opener = this.dom.focused();
    this.shown = true;
    this.section = section;
    this.dom.show(true);
    this.dom.reveal(section);
  }

  close(): void {
    if (!this.shown) return;
    this.shown = false;
    const back = this.opener;
    this.opener = null;
    // Focus left in a hidden panel would take the next keys; it goes back where it came from.
    const inside = this.dom.holdsFocus();
    this.dom.show(false);
    if (!inside) return;
    if (back?.isConnected) back.focus();
    else this.dom.blur();
  }

  /** A fresh key press outside a text field: `?` opens or closes, Esc closes. Whether it took it. */
  key(key: string): boolean {
    if (key === HELP_KEY) {
      if (this.shown) this.close();
      else this.open('play');
      return true;
    }
    if (key === 'Escape' && this.shown) {
      this.close();
      return true;
    }
    return false;
  }

  view(): HelpInfo {
    return { open: this.shown, section: this.shown ? this.section : null };
  }
}

const WHEN: Readonly<Record<Control['when'], string>> = {
  always: '',
  play: '',
  combat: 'In a fight',
  title: 'Title and death screens',
};

/** An empty cell: a dash in the table, nothing where the rows stack. */
function none(cell: HTMLElement): void {
  cell.textContent = '—';
  cell.classList.add('help-none');
}

/** One row of the controls table: the action, its keys as caps and its mouse. */
function controlRow(control: Control): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.dataset.testid = 'help-control';
  const action = document.createElement('th');
  action.scope = 'row';
  action.textContent = control.action;
  const when = WHEN[control.when];
  if (when) {
    const note = document.createElement('span');
    note.className = 'help-when';
    note.textContent = when;
    action.append(note);
  }
  const keys = document.createElement('td');
  keys.className = 'help-keys';
  for (const part of keysText(control)) {
    if (part === 'then') {
      keys.append(' then ');
      continue;
    }
    const cap = document.createElement('kbd');
    cap.textContent = part;
    keys.append(cap, ' ');
  }
  if (control.keys.length === 0) none(keys);
  const mouse = document.createElement('td');
  mouse.className = 'help-mouse';
  if (control.mouse) mouse.textContent = control.mouse;
  else none(mouse);
  row.append(action, keys, mouse);
  return row;
}

/** The controls table, from `CONTROLS`. */
function controlsTable(): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'help-controls';
  table.dataset.testid = 'help-controls';
  const head = document.createElement('thead');
  const titles = document.createElement('tr');
  for (const name of ['Action', 'Keys', 'Mouse']) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = name;
    titles.append(th);
  }
  head.append(titles);
  const body = document.createElement('tbody');
  body.append(...CONTROLS.map(controlRow));
  table.append(head, body);
  return table;
}

/** Room left above a section's heading scrolled to the top, so its focus ring shows whole. */
const HEADING_GAP_PX = 6;

/** The panel in the page: its sections built once from `HELP_SECTIONS`. */
export class HelpPanel {
  private readonly panel = pick('[data-testid="help"]');
  private readonly body = pick('.help-body');
  private readonly headings = new Map<HelpSectionId, HTMLElement>();
  readonly help: Help;

  /** `openers` open it at a section: the title's button, the guide's line and the menu's Help. */
  constructor(openers: readonly [testid: string, section: HelpSectionId][]) {
    const nav = pick('.help-nav');
    for (const section of HELP_SECTIONS) {
      const block = document.createElement('section');
      block.className = 'help-section';
      block.dataset.section = section.id;
      block.setAttribute('aria-labelledby', `help-${section.id}`);
      const heading = document.createElement('h3');
      heading.id = `help-${section.id}`;
      heading.tabIndex = -1;
      heading.textContent = section.title;
      block.append(heading);
      this.headings.set(section.id, heading);
      if (section.lines.length) {
        const list = document.createElement('ul');
        for (const line of section.lines) {
          const item = document.createElement('li');
          item.textContent = line;
          list.append(item);
        }
        block.append(list);
      }
      if (section.link) {
        const p = document.createElement('p');
        const a = document.createElement('a');
        a.href = section.link.href;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = section.link.text;
        p.append(a);
        block.append(p);
      }
      if (section.id === 'controls') block.append(controlsTable());
      this.body.append(block);
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.textContent = section.title;
      jump.addEventListener('click', () => this.help.open(section.id));
      nav.append(jump);
    }
    this.help = new Help({
      show: (open) => {
        this.panel.hidden = !open;
      },
      reveal: (section) => {
        const heading = this.headings.get(section);
        if (!heading?.parentElement) return;
        // The panel scrolls inside itself (`.help-body` is the sections' offset parent); the page never does.
        this.body.scrollTop = heading.parentElement.offsetTop - HEADING_GAP_PX;
        heading.focus({ preventScroll: true });
      },
      // In play focus goes back nowhere, as the menu's buttons keep none: Space stays the dash.
      focused: () => {
        const active = document.activeElement;
        if (document.body.dataset.screen === 'playing') return null;
        return active instanceof HTMLElement && active !== document.body ? active : null;
      },
      holdsFocus: () => this.panel.contains(document.activeElement),
      blur: () => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      },
    });
    for (const [id, section] of openers)
      pick(`[data-testid="${id}"]`).addEventListener('click', () => this.help.open(section));
    pick('[data-testid="help-close"]').addEventListener('click', () => this.help.close());
    // Its own keys: Esc and `?` close it, and Enter or Space work its buttons and link. Every other
    // key goes on to the game, so WASD and the dash still work while focus is inside.
    this.panel.addEventListener('keydown', (e) => {
      const control = e.target instanceof Element && e.target.closest('button, a');
      if ((e.key === 'Escape' || e.key === HELP_KEY) && !e.repeat) {
        e.stopPropagation();
        this.help.close();
      } else if ((e.key === 'Enter' || e.key === ' ') && control) {
        e.stopPropagation();
      }
    });
    // A death closes it, as it does Lineage, so the death screen is never covered.
    new MutationObserver(() => {
      if (document.body.dataset.screen === 'dead') this.help.close();
    }).observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });
  }

  get isOpen(): boolean {
    return this.help.isOpen;
  }
}
