import { describe, expect, it } from 'vitest';
import {
  GUIDE,
  GUIDE_KEY,
  GUIDE_STEPS,
  GUIDE_WORDS,
  Guide,
  type GuideFacts,
  type GuideStep,
  OLD_HINTS_KEY,
} from './guide';

/** A Storage stand-in backed by a map. */
function memory(entries: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  };
}

/** A Storage whose every read and write throws, as a blocked one does. */
const broken = (): Storage =>
  new Proxy({} as Storage, {
    get() {
      throw new Error('blocked');
    },
  });

/** A creature in play that has done nothing yet: no step's moment has come but `swim`'s. */
const base = (): GuideFacts => ({
  screen: 'play',
  still: false,
  lifeMs: 0,
  x: 0,
  y: 0,
  radius: 1,
  eats: 0,
  dashes: 0,
  foodNear: false,
  energy: 0.8,
  hazard: null,
  bigger: false,
  marked: false,
  engaged: false,
  fighting: false,
  mature: false,
  courting: false,
  invited: false,
  pending: false,
  menuOpen: false,
  linked: false,
  wheelOpen: false,
  fallback: false,
});

/** A guide whose steps but `only` were all seen, so one step's rules are tested alone. */
function alone(only: GuideStep[], store = memory()): Guide {
  const seen = GUIDE_STEPS.filter((s) => !only.includes(s));
  store.setItem(GUIDE_KEY, JSON.stringify(seen));
  const guide = new Guide(store);
  guide.startLife();
  return guide;
}

/** Steps the guide `ms` milliseconds at a time with the same facts, from `from` to `to`. */
function run(guide: Guide, facts: GuideFacts, from: number, to: number, ms = 100): void {
  for (let t = from; t <= to; t += ms) guide.update(t, facts);
}

describe('the steps', () => {
  it('names fourteen steps with words that fit one line at 390 px', () => {
    expect(GUIDE_STEPS).toEqual([
      'swim',
      'eat',
      'dash',
      'energy',
      'hazard',
      'bigger',
      'attack',
      'fight',
      'mature',
      'invite',
      'egg',
      'menu',
      'wheel',
      'death',
    ]);
    for (const words of Object.values(GUIDE_WORDS).flat()) expect(words.length).toBeLessThan(70);
  });

  it('swim: in a life’s first second, gone once it has swum 3 body lengths', () => {
    const guide = alone(['swim']);
    const f = { ...base(), radius: 2 };
    guide.update(0, f);
    expect(guide.view()).toMatchObject({ current: 'swim', text: GUIDE_WORDS.swim });
    // 3 body lengths of a radius-2 body: 12 world units.
    guide.update(100, { ...f, x: 11.9 });
    expect(guide.view().current).toBe('swim');
    guide.update(200, { ...f, x: 12 });
    expect(guide.view().current).toBeNull();
    expect(guide.view().seen).toContain('swim');
  });

  it('swim: a life that has already swum 3 lengths in its first second is never told', () => {
    const guide = alone(['swim']);
    guide.update(0, { ...base(), still: true });
    guide.update(500, { ...base(), still: true, x: 10 });
    guide.update(600, { ...base(), x: 10 });
    expect(guide.view().current).toBeNull();
    // A later moment of the same life is no longer its first second.
    guide.update(5000, { ...base(), lifeMs: 5000, x: 10 });
    expect(guide.view().current).toBeNull();
  });

  it('eat: once it swam, gone when it eats; dash: after its first eat with food near, gone when it dashes', () => {
    const guide = alone(['eat', 'dash']);
    guide.update(0, base());
    expect(guide.view().current).toBeNull();
    const swum = { ...base(), x: 6, lifeMs: 2000 };
    guide.update(100, swum);
    guide.update(200, swum);
    expect(guide.view()).toMatchObject({ current: 'eat', text: GUIDE_WORDS.eat });
    guide.update(300, { ...swum, eats: 1 });
    expect(guide.view().current).toBeNull();
    // Dash waits for food within 3 body lengths, and for the 20 s since eat began.
    guide.update(30_000, { ...swum, eats: 1 });
    expect(guide.view().current).toBeNull();
    guide.update(30_100, { ...swum, eats: 1, foodNear: true });
    expect(guide.view()).toMatchObject({ current: 'dash', text: GUIDE_WORDS.dash });
    guide.update(30_200, { ...swum, eats: 1, dashes: 1 });
    expect(guide.view().current).toBeNull();
  });

  it('energy: under 30%, gone over 50%', () => {
    const guide = alone(['energy']);
    guide.update(0, { ...base(), energy: 0.31 });
    expect(guide.view().current).toBeNull();
    guide.update(100, { ...base(), energy: 0.29 });
    expect(guide.view()).toMatchObject({ current: 'energy', text: GUIDE_WORDS.energy });
    guide.update(200, { ...base(), energy: 0.5 });
    expect(guide.view().current).toBe('energy');
    guide.update(300, { ...base(), energy: 0.51 });
    expect(guide.view().current).toBeNull();
  });

  it('hazard: names the plume, UV or pressure, and goes 2 s out of it', () => {
    const words = GUIDE_WORDS.hazard;
    for (const [hazard, text] of [
      ['plume', words[0]],
      ['uv', words[1]],
      ['pressure', words[2]],
    ] as const) {
      const guide = alone(['hazard']);
      guide.update(0, { ...base(), hazard });
      expect(guide.view()).toMatchObject({ current: 'hazard', text });
      guide.update(1000, base());
      guide.update(2900, base());
      expect(guide.view().current).toBe('hazard');
      // Back in for a moment: the 2 s start over.
      guide.update(3000, { ...base(), hazard });
      guide.update(3100, base());
      guide.update(5000, base());
      expect(guide.view().current).toBe('hazard');
      guide.update(5100, base());
      expect(guide.view().current).toBeNull();
    }
  });

  it('bigger: a creature a tier bigger on screen, for 6 s', () => {
    const guide = alone(['bigger']);
    guide.update(0, { ...base(), bigger: true });
    expect(guide.view()).toMatchObject({ current: 'bigger', text: GUIDE_WORDS.bigger });
    guide.update(5900, base());
    expect(guide.view().current).toBe('bigger');
    guide.update(6000, base());
    expect(guide.view().current).toBeNull();
  });

  it('attack: when F first marks a creature, gone when it engages or after 6 s', () => {
    const engages = alone(['attack']);
    engages.update(0, { ...base(), marked: true });
    expect(engages.view()).toMatchObject({ current: 'attack', text: GUIDE_WORDS.attack });
    engages.update(1000, { ...base(), marked: true, engaged: true });
    expect(engages.view().current).toBeNull();
    const waits = alone(['attack']);
    waits.update(0, { ...base(), marked: true });
    waits.update(5900, { ...base(), marked: true });
    expect(waits.view().current).toBe('attack');
    waits.update(6000, { ...base(), marked: true });
    expect(waits.view().current).toBeNull();
  });

  it('fight: while its first fight lasts', () => {
    const guide = alone(['fight']);
    guide.update(0, { ...base(), fighting: true });
    expect(guide.view()).toMatchObject({ current: 'fight', text: GUIDE_WORDS.fight });
    guide.update(3000, base());
    expect(guide.view().current).toBeNull();
  });

  it('mature: gone when it courts or after 8 s; invite: gone when it answers', () => {
    const guide = alone(['mature', 'invite']);
    guide.update(0, { ...base(), mature: true });
    expect(guide.view()).toMatchObject({ current: 'mature', text: GUIDE_WORDS.mature });
    guide.update(1000, { ...base(), mature: true, courting: true });
    expect(guide.view().current).toBeNull();
    guide.update(2000, { ...base(), mature: true, invited: true });
    expect(guide.view()).toMatchObject({ current: 'invite', text: GUIDE_WORDS.invite });
    guide.update(3000, { ...base(), mature: true });
    expect(guide.view().current).toBeNull();

    const late = alone(['mature']);
    late.update(0, { ...base(), mature: true });
    late.update(7900, { ...base(), mature: true });
    expect(late.view().current).toBe('mature');
    late.update(8000, { ...base(), mature: true });
    expect(late.view().current).toBeNull();
  });

  it('egg: its first pending child, gone when it promotes or after 8 s', () => {
    const guide = alone(['egg']);
    guide.update(0, { ...base(), pending: true });
    expect(guide.view()).toMatchObject({ current: 'egg', text: GUIDE_WORDS.egg });
    guide.update(100, base());
    expect(guide.view().current).toBeNull();
    const late = alone(['egg']);
    late.update(0, { ...base(), pending: true });
    late.update(8000, { ...base(), pending: true });
    expect(late.view().current).toBeNull();
  });

  it('menu: 2 minutes into a life, gone when the menu opens or after 6 s', () => {
    const guide = alone(['menu']);
    guide.update(0, { ...base(), lifeMs: 119_000 });
    expect(guide.view().current).toBeNull();
    guide.update(1000, { ...base(), lifeMs: 120_000 });
    expect(guide.view()).toMatchObject({ current: 'menu', text: GUIDE_WORDS.menu });
    guide.update(2000, { ...base(), lifeMs: 121_000, menuOpen: true });
    expect(guide.view().current).toBeNull();
    const late = alone(['menu']);
    late.update(0, { ...base(), lifeMs: 120_000 });
    late.update(6000, { ...base(), lifeMs: 126_000 });
    expect(late.view().current).toBeNull();
  });

  it('menu: a player who opened the menu in this life is not told', () => {
    const guide = alone(['menu']);
    guide.update(0, { ...base(), menuOpen: true });
    guide.update(100, { ...base(), lifeMs: 130_000 });
    expect(guide.view().current).toBeNull();
  });

  it('wheel: 30 s after its first link, gone when the wheel opens or after 6 s', () => {
    const guide = alone(['wheel']);
    guide.update(0, base());
    guide.update(1000, { ...base(), linked: true });
    guide.update(30_900, { ...base(), linked: true });
    expect(guide.view().current).toBeNull();
    // The link need not last: the time counts from the first one.
    guide.update(31_000, base());
    expect(guide.view()).toMatchObject({ current: 'wheel', text: GUIDE_WORDS.wheel });
    guide.update(32_000, { ...base(), wheelOpen: true });
    expect(guide.view().current).toBeNull();
    const late = alone(['wheel']);
    late.update(0, { ...base(), linked: true });
    late.update(30_000, base());
    late.update(36_000, base());
    expect(late.view().current).toBeNull();
  });

  it('death: on the death screen, with or without a fallback, until it closes', () => {
    const [comes, none] = GUIDE_WORDS.death;
    const back = alone(['death']);
    back.update(0, base());
    expect(back.view().current).toBeNull();
    back.update(100, { ...base(), screen: 'dead', fallback: true });
    expect(back.view()).toMatchObject({ current: 'death', text: comes });
    back.update(200, { ...base(), screen: 'other' });
    expect(back.view().current).toBeNull();
    const lost = alone(['death']);
    lost.update(0, { ...base(), screen: 'dead' });
    expect(lost.view()).toMatchObject({ current: 'death', text: none });
  });

  it('nothing shows on the title, nor while a hatch’s still scene plays', () => {
    const title = alone(['swim', 'energy']);
    title.update(0, { ...base(), screen: 'other', energy: 0.1 });
    expect(title.view().current).toBeNull();
    const still = alone(['swim']);
    still.update(0, { ...base(), still: true });
    expect(still.view().current).toBeNull();
    still.update(100, { ...base(), lifeMs: 2000 });
    expect(still.view().current).toBe('swim');
  });
});

describe('pacing', () => {
  it('shows one step at a time: a step waits while another shows', () => {
    const guide = alone(['energy', 'bigger', 'mature']);
    guide.update(0, { ...base(), energy: 0.1, mature: true });
    expect(guide.view().current).toBe('energy');
    // A bigger creature comes and goes while energy shows: gone before its turn, it is dropped.
    guide.update(1000, { ...base(), energy: 0.1, mature: true, bigger: true });
    guide.update(1100, { ...base(), energy: 0.1, mature: true });
    expect(guide.view().current).toBe('energy');
    guide.update(2000, { ...base(), energy: 0.9, mature: true });
    expect(guide.view().current).toBeNull();
  });

  it('starts at most one new step every 20 s', () => {
    const guide = alone(['energy', 'mature']);
    guide.update(0, { ...base(), energy: 0.1, mature: true });
    expect(guide.view().current).toBe('energy');
    guide.update(1000, { ...base(), mature: true });
    expect(guide.view().current).toBeNull();
    guide.update(19_900, { ...base(), mature: true });
    expect(guide.view().current).toBeNull();
    guide.update(20_000, { ...base(), mature: true });
    expect(guide.view().current).toBe('mature');
  });

  it('a step shows for 8 s at most', () => {
    const guide = alone(['energy']);
    guide.update(0, { ...base(), energy: 0.1 });
    guide.update(7900, { ...base(), energy: 0.1 });
    expect(guide.view().current).toBe('energy');
    guide.update(8000, { ...base(), energy: 0.1 });
    expect(guide.view().current).toBeNull();
    // Seen: it never comes back, though the energy is still low.
    run(guide, { ...base(), energy: 0.1 }, 8000, 60_000, 1000);
    expect(guide.view().current).toBeNull();
  });

  it('fight, invite and hazard show at once and push a showing step back into the queue', () => {
    for (const [step, facts] of [
      ['fight', { fighting: true }],
      ['invite', { invited: true }],
      ['hazard', { hazard: 'plume' }],
    ] as const) {
      const guide = alone(['energy', step]);
      guide.update(0, { ...base(), energy: 0.1 });
      expect(guide.view().current).toBe('energy');
      guide.update(1000, { ...base(), energy: 0.1, ...facts });
      expect(guide.view().current, step).toBe(step);
      // Its end brings the pushed step back at once, the 20 s spacing aside.
      run(guide, { ...base(), energy: 0.1 }, 1100, 3500);
      expect(guide.view().current, step).toBe('energy');
    }
  });

  it('a queued step whose moment ended is dropped, and may come again later', () => {
    const guide = alone(['energy', 'mature', 'bigger']);
    guide.update(0, { ...base(), mature: true, energy: 0.1 });
    expect(guide.view().current).toBe('energy');
    guide.update(1000, { ...base(), mature: true, bigger: true, energy: 0.9 });
    // `mature` waited first; a bigger creature that left before its turn is not shown.
    guide.update(20_000, { ...base(), mature: true });
    expect(guide.view().current).toBe('mature');
    guide.update(20_100, { ...base(), courting: true, mature: true });
    expect(guide.view().current).toBeNull();
    guide.update(40_100, { ...base(), bigger: true });
    expect(guide.view().current).toBe('bigger');
  });

  it('a death ends the step on screen and drops the queued ones', () => {
    const guide = alone(['energy', 'mature', 'death']);
    guide.update(0, { ...base(), energy: 0.1, mature: true });
    guide.update(100, { ...base(), screen: 'dead' });
    expect(guide.view().current).toBeNull();
    guide.update(20_000, { ...base(), screen: 'dead' });
    expect(guide.view().current).toBe('death');
  });
});

describe('remembering', () => {
  it('a step seen never shows again, in this visit or the next', () => {
    const store = memory();
    const first = alone(['energy'], store);
    first.update(0, { ...base(), energy: 0.1 });
    first.update(100, { ...base(), energy: 0.9 });
    expect(JSON.parse(store.getItem(GUIDE_KEY) ?? '[]')).toContain('energy');
    first.startLife();
    run(first, { ...base(), energy: 0.1 }, 30_000, 60_000, 1000);
    expect(first.view().current).toBeNull();
    const next = new Guide(store);
    next.startLife();
    run(next, { ...base(), energy: 0.1, x: 100, lifeMs: 2000 }, 0, 30_000, 1000);
    expect(next.view().current).toBeNull();
    expect(next.fresh()).toBe(false);
  });

  it('a browser with the old hints has seen swim, dash, menu and wheel', () => {
    const guide = new Guide(memory({ [OLD_HINTS_KEY]: 'seen' }));
    expect(guide.view().seen.sort()).toEqual(['dash', 'menu', 'swim', 'wheel']);
    guide.startLife();
    guide.update(0, base());
    expect(guide.view().current).toBeNull();
    expect(guide.fresh()).toBe(false);
  });

  it('a fresh browser has seen nothing', () => {
    const guide = new Guide(memory());
    expect(guide.fresh()).toBe(true);
    expect(guide.view()).toEqual({ on: true, seen: [], current: null, text: null });
  });

  it('a damaged store reads as nothing seen', () => {
    for (const text of ['{', '{"a":1}', '["swim", 3, "nope"]']) {
      const guide = new Guide(memory({ [GUIDE_KEY]: text }));
      expect(guide.view().seen).toEqual(text.startsWith('[') ? ['swim'] : []);
    }
  });

  it('"Show hints" off shows none, and on again shows them', () => {
    const guide = alone(['energy']);
    guide.setOn(false);
    guide.update(0, { ...base(), energy: 0.1 });
    expect(guide.view()).toMatchObject({ on: false, current: null });
    guide.setOn(true);
    guide.update(100, { ...base(), energy: 0.1 });
    expect(guide.view().current).toBe('energy');
    // Turned off while a step shows: it goes at once.
    guide.setOn(false);
    expect(guide.view().current).toBeNull();
  });

  it('"Show the hints again" forgets what was seen, and swim comes back on the next life', () => {
    const store = memory();
    const guide = new Guide(store);
    guide.startLife();
    guide.update(0, base());
    expect(guide.view().current).toBe('swim');
    guide.update(100, { ...base(), x: 10 });
    expect(guide.fresh()).toBe(false);
    guide.reset();
    expect(guide.fresh()).toBe(true);
    expect(store.getItem(GUIDE_KEY)).toBeNull();
    guide.update(30_000, { ...base(), lifeMs: 30_000, x: 10, eats: 1 });
    expect(guide.view().current).toBeNull();
    guide.startLife();
    guide.update(30_100, { ...base(), x: 10 });
    expect(guide.view().current).toBe('swim');
  });

  it('a blocked store shows each step once per visit', () => {
    for (const store of [null, broken()]) {
      const guide = new Guide(store);
      guide.startLife();
      guide.update(0, base());
      expect(guide.view().current).toBe('swim');
      guide.update(100, { ...base(), x: 10 });
      guide.startLife();
      guide.update(GUIDE.spacingMs, base());
      expect(guide.view().current).toBeNull();
      expect(new Guide(store).fresh()).toBe(true);
    }
  });

  it('leftMs counts down to the end of the step on screen', () => {
    const guide = alone(['bigger']);
    expect(guide.leftMs(0)).toBe(0);
    guide.update(0, { ...base(), bigger: true });
    expect(guide.leftMs(1000)).toBe(5000);
  });
});
