// The one table of controls (M14 T8, DESIGN §3): each action with its mouse, its keys and when it
// works. The help panel draws it, and a key-map test holds it to the game's key handlers both ways.
// Keys are `KeyboardEvent.key` names as the handlers compare them (letters in lower case).

import { EMOTE_COUNT } from '../net/protocol-defs';

export interface Control {
  action: string;
  /** The mouse's way to do it, or null when only keys do. */
  mouse: string | null;
  keys: readonly string[];
  /** Keys pressed after `keys` (T, then 1–6). */
  after?: readonly string[];
  when: 'always' | 'play' | 'combat' | 'title';
}

/** Closes what is open: Esc. */
export const ESC_KEY = 'Escape';

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

export const CONTROLS: readonly Control[] = [
  {
    action: 'Swim',
    mouse: 'Point where to go; farther is faster',
    keys: ['w', 'a', 's', 'd', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'],
    when: 'play',
  },
  { action: 'Dash', mouse: null, keys: [' '], when: 'play' },
  {
    action: 'Court a creature, or accept',
    mouse: 'Click the creature, then its button',
    keys: ['e'],
    when: 'play',
  },
  {
    action: 'Attack the creature marked F',
    mouse: 'Click the creature, then Attack',
    keys: ['f'],
    when: 'play',
  },
  {
    action: 'Stance: aggressive, balanced, evasive',
    mouse: 'The fight buttons',
    keys: ['1', '2', '3'],
    when: 'combat',
  },
  { action: 'Brace', mouse: 'Right button', keys: ['Shift'], when: 'combat' },
  { action: 'Change target', mouse: 'Click a fighter or an egg', keys: ['Tab'], when: 'combat' },
  { action: 'Become your offspring', mouse: 'Its card’s button', keys: ['h'], when: 'play' },
  {
    action: 'Pings and emotes',
    mouse: 'Middle button: a quick look ping',
    keys: ['g'],
    when: 'play',
  },
  {
    action: 'Pick on the wheel',
    mouse: 'Release over an item',
    keys: DIGITS,
    when: 'play',
  },
  { action: 'Emote', mouse: null, keys: ['t'], after: DIGITS.slice(0, EMOTE_COUNT), when: 'play' },
  { action: 'Chat', mouse: null, keys: ['Enter'], when: 'play' },
  { action: 'Map', mouse: 'Click the minimap', keys: ['m'], when: 'play' },
  {
    action: 'Ride the current, when alone',
    mouse: 'Its button',
    keys: ['r'],
    when: 'play',
  },
  { action: 'Look at a creature', mouse: 'Click it', keys: [], when: 'play' },
  {
    action: 'Hatch, or back to a fight',
    mouse: 'The main button',
    keys: ['Enter'],
    when: 'title',
  },
  {
    action: 'Crack the egg',
    mouse: 'Click it, or hold the button',
    keys: [' '],
    when: 'title',
  },
  {
    action: 'Menu, or close',
    mouse: 'The round button, top left',
    keys: ['Escape'],
    when: 'always',
  },
  { action: 'Help', mouse: 'How to play, or Help in the menu', keys: ['?'], when: 'always' },
];

/** Every key the table names, lower case, once each. */
export function controlKeys(): string[] {
  return [
    ...new Set(
      CONTROLS.flatMap((c) => [...c.keys, ...(c.after ?? [])]).map((k) => k.toLowerCase()),
    ),
  ];
}

const LABELS: Readonly<Record<string, string>> = {
  ' ': 'Space',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

/** A key as its cap reads. */
export function keyLabel(key: string): string {
  return LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** A run of four or more number keys in a row reads as a range (1–0), the rest one by one. */
function labels(keys: readonly string[]): string[] {
  const digits = keys.length >= 4 && keys.every((k) => /^\d$/.test(k));
  if (digits) return [`${keys[0]}–${keys[keys.length - 1]}`];
  return keys.map(keyLabel);
}

/** A control's keys as the caps to draw, with "then" between a key and the ones that follow it. */
export function keysText(control: Pick<Control, 'keys' | 'after'>): string[] {
  const after = control.after ?? [];
  return after.length ? [...labels(control.keys), 'then', ...labels(after)] : labels(control.keys);
}
