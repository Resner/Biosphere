import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTROLS } from './controls';
import { type Focusable, HELP_KEY, Help, type HelpView } from './help-panel';
import { HELP_SECTIONS, type HelpSectionId, helpNumbers } from './help-text';
import { InputController } from './input';

/** A focusable stand-in: a button somewhere on the page. */
const button = (name: string, connected = true): Focusable & { name: string } => ({
  name,
  isConnected: connected,
  focus() {
    focused = this;
  },
});

let focused: Focusable | null = null;

/** The panel's DOM as a record of what it was told. */
function fakeView(): HelpView & { shown: boolean; at: HelpSectionId | null; inside: boolean } {
  return {
    shown: false,
    at: null,
    inside: false,
    show(open) {
      this.shown = open;
      if (!open) this.at = null;
    },
    reveal(section) {
      this.at = section;
      this.inside = true;
      focused = null;
    },
    focused: () => focused,
    holdsFocus() {
      return this.inside;
    },
    blur() {
      this.inside = false;
      focused = null;
    },
  };
}

const ORDER: HelpSectionId[] = [
  'play',
  'survive',
  'grow',
  'fight',
  'lineage',
  'controls',
  'privacy',
];

describe('the help sections', () => {
  it('come in the spec order with their titles', () => {
    expect(HELP_SECTIONS.map((s) => s.id)).toEqual(ORDER);
    expect(HELP_SECTIONS.map((s) => s.title)).toEqual([
      'How to play',
      'Survive',
      'Grow and mate',
      'Fight',
      'Your lineage',
      'Controls',
      'Privacy',
    ]);
  });

  it('How to play is four plain lines, with no genetics words', () => {
    const play = HELP_SECTIONS[0];
    expect(play?.lines).toHaveLength(4);
    for (const line of play?.lines ?? [])
      expect(line).not.toMatch(/gene|allele|DNA|genome|haplo|diploid|mutation/i);
  });

  it('every prose section has lines, and Controls is the table', () => {
    for (const s of HELP_SECTIONS) {
      if (s.id === 'controls') expect(s.lines).toHaveLength(0);
      else expect(s.lines.length, s.id).toBeGreaterThan(0);
    }
  });

  it('Your lineage links what "Verified" means', () => {
    const lineage = HELP_SECTIONS.find((s) => s.id === 'lineage');
    expect(lineage?.link?.href).toBe(
      'https://github.com/Resner/Biosphere/blob/main/docs/VERIFY.md',
    );
  });

  it('names no number DESIGN.md does not hold', () => {
    const design = readFileSync(new URL('../../docs/DESIGN.md', import.meta.url), 'utf8');
    const text = [
      ...HELP_SECTIONS.flatMap((s) => [...s.lines, s.link?.text ?? '']),
      ...CONTROLS.flatMap((c) => [c.action, c.mouse ?? '']),
    ].join('\n');
    const numbers = helpNumbers(text);
    expect(numbers.length).toBeGreaterThan(5);
    for (const n of numbers) expect(design, `DESIGN.md holds ${n}`).toContain(n);
  });

  it('keeps lines short', () => {
    for (const s of HELP_SECTIONS)
      for (const line of s.lines) expect(line.length, line).toBeLessThanOrEqual(120);
  });
});

describe('helpNumbers', () => {
  it('finds whole numbers, decimals and percentages', () => {
    expect(helpNumbers('30% of its energy, 9 minutes, 1.5 times, 14 days')).toEqual([
      '30%',
      '9',
      '1.5',
      '14',
    ]);
  });
});

describe('Help (the panel)', () => {
  it('opens at a section, moving focus into it, and Esc closes it with focus back', () => {
    const view = fakeView();
    const help = new Help(view);
    const opener = button('How to play');
    opener.focus();
    expect(help.view()).toEqual({ open: false, section: null });
    help.open('play');
    expect(view.shown).toBe(true);
    expect(view.at).toBe('play');
    expect(help.view()).toEqual({ open: true, section: 'play' });
    expect(focused).toBeNull();
    expect(help.key('Escape')).toBe(true);
    expect(view.shown).toBe(false);
    expect(help.view()).toEqual({ open: false, section: null });
    expect(focused).toBe(opener);
  });

  it('opens at Controls from the menu, and moves to another section when open', () => {
    const view = fakeView();
    const help = new Help(view);
    help.open('controls');
    expect(help.view().section).toBe('controls');
    expect(view.at).toBe('controls');
    help.open('fight');
    expect(help.view()).toEqual({ open: true, section: 'fight' });
    expect(view.at).toBe('fight');
  });

  it('? toggles it at How to play; Esc does nothing while it is closed', () => {
    const view = fakeView();
    const help = new Help(view);
    expect(help.key('Escape')).toBe(false);
    expect(help.key('e')).toBe(false);
    expect(help.key(HELP_KEY)).toBe(true);
    expect(help.view()).toEqual({ open: true, section: 'play' });
    expect(help.key('w')).toBe(false);
    expect(help.view().open).toBe(true);
    expect(help.key(HELP_KEY)).toBe(true);
    expect(help.view().open).toBe(false);
  });

  it('gives focus back only to an opener still on the page, and blurs otherwise', () => {
    const view = fakeView();
    const help = new Help(view);
    const gone = button('menu Help', false);
    gone.focus();
    help.open('controls');
    help.close();
    expect(focused).toBeNull();
    expect(view.inside).toBe(false);
  });

  it('leaves focus alone when it already left the panel', () => {
    const view = fakeView();
    const help = new Help(view);
    const opener = button('opener');
    opener.focus();
    help.open('play');
    const elsewhere = button('canvas');
    view.inside = false;
    elsewhere.focus();
    help.close();
    expect(focused).toBe(elsewhere);
  });

  it('a second open keeps the first opener', () => {
    const view = fakeView();
    const help = new Help(view);
    const opener = button('title');
    opener.focus();
    help.open('play');
    help.open('controls');
    help.close();
    expect(focused).toBe(opener);
  });
});

describe('? in chat', () => {
  it('never reaches the game while chat is open', () => {
    const win = new EventTarget();
    const controller = new InputController();
    const keys: string[] = [];
    controller.attach(win as unknown as Window, undefined, undefined, {
      key: (k) => keys.push(k),
    });
    const press = (key: string) =>
      win.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key }));
    controller.typing = true;
    press(HELP_KEY);
    expect(keys).toEqual([]);
    controller.typing = false;
    press(HELP_KEY);
    expect(keys).toEqual([HELP_KEY]);
  });
});
