import { describe, expect, it } from 'vitest';
import { APP_KEYS } from './app-keys';
import { CONTROLS, controlKeys, keyLabel, keysText } from './controls';
import { FIGHT_KEYS } from './engage';
import { DASH_KEY, ENTER_KEY, MOVE_KEYS } from './input';
import { EMOTE_KEYS } from './social';
import { WHEEL_KEYS } from './wheel';

/** Every key the game's handlers react to, as `KeyboardEvent.key` names them, lower case. */
const handled = (): Set<string> =>
  new Set(
    [
      ...MOVE_KEYS,
      DASH_KEY,
      ENTER_KEY,
      ...APP_KEYS,
      ...FIGHT_KEYS,
      ...WHEEL_KEYS,
      ...EMOTE_KEYS,
    ].map((k) => k.toLowerCase()),
  );

describe('the key map (M14 T8)', () => {
  it('every key CONTROLS names is handled by the game', () => {
    const keys = handled();
    for (const key of controlKeys()) expect(keys, `CONTROLS names ${key}`).toContain(key);
  });

  it('every key the game handles is in CONTROLS', () => {
    const named = new Set(controlKeys());
    for (const key of handled()) expect(named, `the game handles ${key}`).toContain(key);
  });

  it('names the help key, the menu, the six core actions and the combat keys', () => {
    const named = new Set(controlKeys());
    for (const key of ['?', 'escape', ' ', 'e', 'f', 'g', 'w', 'shift', 'tab', '1', '0'])
      expect(named).toContain(key);
  });

  it('each row has an action, a way to do it and a time it works', () => {
    const actions = new Set<string>();
    for (const c of CONTROLS) {
      expect(c.action.length).toBeGreaterThan(0);
      expect(c.mouse !== null || c.keys.length > 0, c.action).toBe(true);
      expect(['always', 'play', 'combat', 'title']).toContain(c.when);
      expect(actions.has(c.action), `${c.action} twice`).toBe(false);
      actions.add(c.action);
    }
  });

  it('the combat keys work only in combat', () => {
    for (const key of ['Shift', 'Tab'])
      expect(CONTROLS.filter((c) => c.keys.includes(key)).map((c) => c.when)).toEqual(['combat']);
  });
});

describe('key labels', () => {
  it('names keys as their caps read', () => {
    expect(keyLabel(' ')).toBe('Space');
    expect(keyLabel('Escape')).toBe('Esc');
    expect(keyLabel('e')).toBe('E');
    expect(keyLabel('ArrowUp')).toBe('↑');
    expect(keyLabel('?')).toBe('?');
  });

  it('runs of numbers read as a range, and a second press as "then"', () => {
    expect(keysText({ keys: ['1', '2', '3'] })).toEqual(['1', '2', '3']);
    expect(keysText({ keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] })).toEqual(['1–0']);
    expect(keysText({ keys: ['t'], after: ['1', '2', '3', '4', '5', '6'] })).toEqual([
      'T',
      'then',
      '1–6',
    ]);
    expect(keysText({ keys: ['w', 'a', 's', 'd'] })).toEqual(['W', 'A', 'S', 'D']);
  });
});
