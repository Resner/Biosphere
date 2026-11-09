// The first-life guide (M14 T7): a newcomer learns by playing. Each step shows the first time its
// moment comes in this browser, one line at the bottom centre, then never again. One step shows at
// a time, at most one new step starts every 20 s, and a fight, an invitation or a hazard shows at
// once, pushing a showing step back into the queue. Pure: the app hands it the time and the facts
// of each frame (`GuideFacts`), so the rules test in Node.

export type GuideStep =
  | 'swim'
  | 'eat'
  | 'dash'
  | 'energy'
  | 'hazard'
  | 'bigger'
  | 'attack'
  | 'fight'
  | 'mature'
  | 'invite'
  | 'egg'
  | 'menu'
  | 'wheel'
  | 'death';

/** localStorage: the steps this browser has seen, as a JSON array. */
export const GUIDE_KEY = 'bs.guide';
/** The M6b first-life hints' key: a browser that has it has seen what they taught. */
export const OLD_HINTS_KEY = 'bs.hints';
const OLD_HINTS_TAUGHT: readonly GuideStep[] = ['swim', 'dash', 'menu', 'wheel'];

export const GUIDE = {
  /** At most one new step starts in this long. */
  spacingMs: 20_000,
  /** A step shows for this long at most. */
  holdMs: 8_000,
  /** `bigger`, `attack`, `menu` and `wheel` show this long at most. */
  shortMs: 6_000,
  /** `hazard` goes once the creature has been out of every hazard this long. */
  clearMs: 2_000,
  /** `swim` goes once the creature has swum this many body lengths. */
  swimLengths: 3,
  /** `swim` starts in a life's first second. */
  firstMs: 1_000,
  /** `menu` starts this far into a life. */
  menuAtMs: 120_000,
  /** `wheel` starts this long after the life's first link to another player. */
  wheelAfterMs: 30_000,
  /** `energy` starts under this share of the energy cap, and goes over `fedShare`. */
  hungryShare: 0.3,
  fedShare: 0.5,
} as const;

export const GUIDE_WORDS = {
  swim: 'Move the mouse to swim · WASD works too',
  eat: 'Swim into the glowing specks to eat',
  dash: 'Space to dash',
  energy: "Hungry: eat, or you'll starve",
  hazard: ['Toxic cloud: steer clear', 'Too bright here: swim deeper', 'Too deep here: swim up'],
  bigger: 'Amber rings mean bigger: keep away',
  attack: 'F to attack a creature your size',
  fight: '1 2 3 stance · Shift braces · swim away to escape',
  mature: 'Grown up: find a player and press E to court',
  invite: 'E to accept: you each get a child',
  egg: "H becomes your child when you're ready",
  menu: 'Esc opens the menu: stats, lineage and help',
  wheel: 'G for pings and emotes',
  death: [
    'You come back as your egg or nearest ancestor',
    'Nothing survived. Your lineage stays in History',
  ],
} as const;

/** What the page shows this frame, as the guide reads it. */
export interface GuideFacts {
  /** A life in play, the death screen, or anything else (the title, the hatch's wait). */
  screen: 'play' | 'dead' | 'other';
  /** A hatch's still scene: nothing new starts until the shell bursts. */
  still: boolean;
  /** Milliseconds of play in this life (its sim ticks). */
  lifeMs: number;
  /** The creature's centre and radius, world units. */
  x: number;
  y: number;
  radius: number;
  /** This life's meals and dashes so far. */
  eats: number;
  dashes: number;
  /** Food within 3 body lengths. */
  foodNear: boolean;
  /** Energy as a share of its cap. */
  energy: number;
  /** A plume within 3 body radii, or a UV or pressure hit. */
  hazard: 'plume' | 'uv' | 'pressure' | null;
  /** A creature a tier bigger on screen. */
  bigger: boolean;
  /** The "F" glyph marks a creature. */
  marked: boolean;
  /** An attack asked or a fight running. */
  engaged: boolean;
  fighting: boolean;
  mature: boolean;
  /** The player courts someone. */
  courting: boolean;
  /** An invitation waits for the player's answer. */
  invited: boolean;
  /** A pending child. */
  pending: boolean;
  menuOpen: boolean;
  /** A link to another player is open. */
  linked: boolean;
  wheelOpen: boolean;
  /** On the death screen: an egg or an ancestor to come back as. */
  fallback: boolean;
}

/** `state().guide`. */
export interface GuideView {
  on: boolean;
  seen: GuideStep[];
  current: GuideStep | null;
  text: string | null;
}

/** What the guide remembers of the current life. */
interface LifeMemory {
  swum: number;
  last: { x: number; y: number } | null;
  firstLinkAt: number | null;
  menuOpened: boolean;
  wheelOpened: boolean;
  clearSince: number | null;
}

interface Rule {
  where: 'play' | 'dead';
  /** Shows at once, pushing a showing step back into the queue. */
  urgent?: boolean;
  holdMs: number;
  /** Its moment has come. */
  when(f: GuideFacts, m: LifeMemory, now: number): boolean;
  /** It is done: it goes from the screen, or from the queue. */
  until(f: GuideFacts, m: LifeMemory, now: number): boolean;
  /** While queued: its moment still holds (a bigger creature still on screen). */
  relevant?(f: GuideFacts): boolean;
  text(f: GuideFacts): string;
}

const swumEnough = (f: GuideFacts, m: LifeMemory) => m.swum >= GUIDE.swimLengths * 2 * f.radius;
const never = () => false;
const words = (text: string) => () => text;
const { holdMs, shortMs } = GUIDE;

const RULES: Readonly<Record<GuideStep, Rule>> = {
  swim: {
    where: 'play',
    holdMs,
    when: (f, m) => f.lifeMs < GUIDE.firstMs && !swumEnough(f, m),
    until: swumEnough,
    text: words(GUIDE_WORDS.swim),
  },
  eat: {
    where: 'play',
    holdMs,
    when: (f, m) => swumEnough(f, m) && f.eats === 0,
    until: (f) => f.eats > 0,
    text: words(GUIDE_WORDS.eat),
  },
  dash: {
    where: 'play',
    holdMs,
    when: (f) => f.eats > 0 && f.foodNear && f.dashes === 0,
    until: (f) => f.dashes > 0,
    text: words(GUIDE_WORDS.dash),
  },
  energy: {
    where: 'play',
    holdMs,
    when: (f) => f.energy < GUIDE.hungryShare,
    until: (f) => f.energy > GUIDE.fedShare,
    text: words(GUIDE_WORDS.energy),
  },
  hazard: {
    where: 'play',
    urgent: true,
    holdMs,
    when: (f) => f.hazard !== null,
    until: (_, m, now) => m.clearSince !== null && now - m.clearSince >= GUIDE.clearMs,
    text: (f) => GUIDE_WORDS.hazard[f.hazard === 'uv' ? 1 : f.hazard === 'pressure' ? 2 : 0],
  },
  bigger: {
    where: 'play',
    holdMs: shortMs,
    when: (f) => f.bigger,
    until: never,
    relevant: (f) => f.bigger,
    text: words(GUIDE_WORDS.bigger),
  },
  attack: {
    where: 'play',
    holdMs: shortMs,
    when: (f) => f.marked && !f.engaged,
    until: (f) => f.engaged,
    relevant: (f) => f.marked,
    text: words(GUIDE_WORDS.attack),
  },
  fight: {
    where: 'play',
    urgent: true,
    holdMs,
    when: (f) => f.fighting,
    until: (f) => !f.fighting,
    text: words(GUIDE_WORDS.fight),
  },
  mature: {
    where: 'play',
    holdMs,
    when: (f) => f.mature && !f.courting,
    until: (f) => f.courting,
    text: words(GUIDE_WORDS.mature),
  },
  invite: {
    where: 'play',
    urgent: true,
    holdMs,
    when: (f) => f.invited,
    until: (f) => !f.invited,
    text: words(GUIDE_WORDS.invite),
  },
  egg: {
    where: 'play',
    holdMs,
    when: (f) => f.pending,
    until: (f) => !f.pending,
    text: words(GUIDE_WORDS.egg),
  },
  menu: {
    where: 'play',
    holdMs: shortMs,
    when: (f, m) => f.lifeMs >= GUIDE.menuAtMs && !m.menuOpened,
    until: (f) => f.menuOpen,
    text: words(GUIDE_WORDS.menu),
  },
  wheel: {
    where: 'play',
    holdMs: shortMs,
    when: (_, m, now) =>
      m.firstLinkAt !== null && now - m.firstLinkAt >= GUIDE.wheelAfterMs && !m.wheelOpened,
    until: (f) => f.wheelOpen,
    text: words(GUIDE_WORDS.wheel),
  },
  death: {
    where: 'dead',
    holdMs,
    when: () => true,
    until: never,
    text: (f) => GUIDE_WORDS.death[f.fallback ? 0 : 1],
  },
};

export const GUIDE_STEPS = Object.keys(RULES) as GuideStep[];
const isStep = (value: unknown): value is GuideStep =>
  typeof value === 'string' && Object.hasOwn(RULES, value);

const freshLife = (): LifeMemory => ({
  swum: 0,
  last: null,
  firstLinkAt: null,
  menuOpened: false,
  wheelOpened: false,
  clearSince: null,
});

interface Showing {
  step: GuideStep;
  text: string;
  at: number;
}

export class Guide {
  private readonly seen: Set<GuideStep>;
  private on = true;
  private life = freshLife();
  /** Steps whose moment came, in order; `resumed` ones were pushed back and skip the spacing. */
  private queue: { step: GuideStep; resumed: boolean }[] = [];
  private current: Showing | null = null;
  private lastStart = Number.NEGATIVE_INFINITY;

  constructor(private readonly store: Storage | null) {
    this.seen = new Set(this.load());
  }

  /** Whether this browser has seen no step: the title offers "New here? How to play". */
  fresh(): boolean {
    return this.seen.size === 0;
  }

  /** Every step seen: the guide has nothing left to teach this browser. */
  get done(): boolean {
    return this.seen.size === GUIDE_STEPS.length;
  }

  /** The words on screen now, or null; cheaper than `view()` for a per-frame read. */
  get text(): string | null {
    return this.current?.text ?? null;
  }

  /** "Show hints": off hides the step on screen and starts none. */
  setOn(on: boolean): void {
    this.on = on;
    if (!on) {
      this.current = null;
      this.queue = [];
    }
  }

  /** A new life: the guide's memory of the last one goes (what was seen stays). */
  startLife(): void {
    this.life = freshLife();
    this.current = null;
    this.queue = [];
  }

  /** "Show the hints again": every step is unseen again, here and in the store. */
  reset(): void {
    this.seen.clear();
    this.current = null;
    this.queue = [];
    try {
      this.store?.removeItem(GUIDE_KEY);
      this.store?.removeItem(OLD_HINTS_KEY);
    } catch {
      // A blocked store: this visit forgets, which is all it ever knew.
    }
  }

  /** One frame at `now` (milliseconds on the guide's clock). */
  update(now: number, f: GuideFacts): void {
    this.remember(now, f);
    if (!this.on) return;
    const { current } = this;
    if (current) {
      const rule = RULES[current.step];
      if (
        rule.where !== f.screen ||
        rule.until(f, this.life, now) ||
        now - current.at >= rule.holdMs
      ) {
        this.current = null;
      }
    }
    this.queue = this.queue.filter(({ step }) => {
      const rule = RULES[step];
      return (
        rule.where === f.screen && !rule.until(f, this.life, now) && (rule.relevant?.(f) ?? true)
      );
    });
    for (const step of GUIDE_STEPS) {
      if (this.seen.has(step) || this.current?.step === step) continue;
      if (this.queue.some((q) => q.step === step)) continue;
      const rule = RULES[step];
      if (rule.where !== f.screen || !rule.when(f, this.life, now)) continue;
      if (rule.urgent && !f.still) {
        const pushed = this.current;
        if (pushed) this.queue.unshift({ step: pushed.step, resumed: true });
        this.show(step, f, now);
      } else {
        this.queue.push({ step, resumed: false });
      }
    }
    const next = this.queue[0];
    if (!this.current && next && !f.still) {
      if (next.resumed || now - this.lastStart >= GUIDE.spacingMs) {
        this.queue.shift();
        this.show(next.step, f, now, next.resumed);
      }
    }
  }

  /** The step on screen's time left before its longest show ends; 0 with none. */
  leftMs(now: number): number {
    const { current } = this;
    return current ? Math.max(0, current.at + RULES[current.step].holdMs - now) : 0;
  }

  view(): GuideView {
    return {
      on: this.on,
      seen: [...this.seen],
      current: this.current?.step ?? null,
      text: this.current?.text ?? null,
    };
  }

  private remember(now: number, f: GuideFacts): void {
    const { life } = this;
    if (f.screen === 'play') {
      if (life.last) life.swum += Math.hypot(f.x - life.last.x, f.y - life.last.y);
      life.last = { x: f.x, y: f.y };
    }
    if (f.linked && life.firstLinkAt === null) life.firstLinkAt = now;
    if (f.menuOpen) life.menuOpened = true;
    if (f.wheelOpen) life.wheelOpened = true;
    if (f.hazard !== null) life.clearSince = null;
    else if (life.clearSince === null) life.clearSince = now;
  }

  private show(step: GuideStep, f: GuideFacts, now: number, resumed = false): void {
    this.current = { step, text: RULES[step].text(f), at: now };
    if (resumed) return;
    this.lastStart = now;
    if (this.seen.has(step)) return;
    this.seen.add(step);
    try {
      this.store?.setItem(GUIDE_KEY, JSON.stringify([...this.seen]));
    } catch {
      // A blocked store: the step shows once in this visit only.
    }
  }

  private load(): GuideStep[] {
    try {
      const text = this.store?.getItem(GUIDE_KEY);
      if (text == null) {
        return this.store?.getItem(OLD_HINTS_KEY) != null ? [...OLD_HINTS_TAUGHT] : [];
      }
      const data: unknown = JSON.parse(text);
      return Array.isArray(data) ? data.filter(isStep) : [];
    } catch {
      return [];
    }
  }
}
