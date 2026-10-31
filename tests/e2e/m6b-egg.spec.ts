import { type Browser, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { clickHatch, M6B_EGG_HUB, openRecorded, patchLuma, state, waitPlaying } from './helpers';

// The egg reveal as a gacha moment (M6b T11): the genesis egg drops in at the screen's centre and
// rests, answering a click, until the beacon comes; then it stirs, cracks and bursts by rarity, and
// a result card shows what hatched. Nothing covers it, on the title screen or after a death.

test.describe.configure({ mode: 'serial' });

// `EGG.dropMs` in `src/render/egg.ts` (that module pulls in the shaders, which Node cannot load).
const EGG = { dropMs: 400 } as const;

interface Sample {
  t: number;
  phase: string;
  angle: number;
  glow: number;
  status: string;
  screen: string;
  stir: number;
}

/** Records the egg on every frame into `window.__eggLog` until `stop` is called. */
const watchEgg = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __eggLog: Sample[]; __eggStop: boolean };
    w.__eggLog = [];
    w.__eggStop = false;
    const look = () => {
      const s = (window.__bs as BsHook).state();
      w.__eggLog.push({
        t: performance.now(),
        phase: s.egg.phase,
        angle: s.egg.angle,
        glow: s.egg.glow,
        status: s.life.status,
        screen: s.screen,
        stir: s.audio.cues.stir ?? 0,
      });
      if (!w.__eggStop) requestAnimationFrame(look);
    };
    look();
  });

const eggLog = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __eggLog: Sample[]; __eggStop: boolean };
    w.__eggStop = true;
    return w.__eggLog;
  });

/** What `document.elementFromPoint` finds at the egg's centre and at four points 0.8 of its radius out. */
const atEgg = (page: Page) =>
  page.evaluate(() => {
    const at = (window.__bs as BsHook).state().egg.at;
    if (!at) return null;
    const d = 0.8 * at.r;
    const points = [
      [at.x, at.y],
      [at.x + d, at.y],
      [at.x - d, at.y],
      [at.x, at.y + d],
      [at.x, at.y - d],
    ] as const;
    return {
      at,
      hits: points.map(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el ? `${el.tagName.toLowerCase()}#${el.id}` : 'none';
      }),
    };
  });

/** From the title, Hatch, and wait for the egg; the cursor then goes to a corner (no input). */
async function hatchEgg(page: Page): Promise<void> {
  await clickHatch(page);
  await page.mouse.move(2, 2);
  await page.waitForFunction(() => window.__bs?.state().egg.phase === 'waiting');
}

/** The rest, the cover and the stir on the title screen, then the burst and the result card. */
async function restAndReveal(browser: Browser, committed: () => void): Promise<void> {
  // The hub's beacon comes 3 to 6 s after the commitment on its real-time clock, sooner when it is
  // busy: a hatch whose beacon cuts the 2 s window short is checked as far as it went, then tried
  // again (three hatches at most).
  let page: Page | null = null;
  for (let attempt = 1; ; attempt++) {
    page = await (await browser.newContext()).newPage();
    const rested = await restAt(page, committed);
    if (rested || attempt === 3) {
      expect(rested, 'a full 2 s at rest before the beacon').toBe(true);
      break;
    }
    await page.context().close();
  }
  await revealAt(page as Page);
}

/** Hatches, checks the egg is alone at the centre and at rest; false when the beacon cut the 2 s short. */
async function restAt(page: Page, committed: () => void): Promise<boolean> {
  await openRecorded(page, '', M6B_EGG_HUB);
  await watchEgg(page);
  // It drops in, then rests: sampled at 10 Hz over 2 s from the drop's end, with no input, it does
  // not swing. Timed in the page, since a busy software-rendered page answers calls slowly; its
  // timers run late too, so each 0.1 s mark is read from the egg's timeline as soon as it passed
  // (while the egg still waits, the timeline is what the frames draw).
  const resting = page.evaluate(
    (dropMs) =>
      new Promise<{ since: number; phase: string; angle: number }[]>((resolve) => {
        const out: { since: number; phase: string; angle: number }[] = [];
        const begin = setInterval(() => {
          if ((window.__bs as BsHook).state().egg.phase !== 'waiting') return;
          clearInterval(begin);
          const from = performance.now() + dropMs + 50;
          const timer = setInterval(() => {
            const bs = window.__bs as BsHook;
            const { phase } = bs.state().egg;
            const since = performance.now() - from;
            while (out.length < 20 && out.length * 100 <= since) {
              const mark = out.length * 100;
              out.push({ since: mark, phase, angle: bs.render.eggAngle(from + mark) });
            }
            if (out.length === 20 || phase !== 'waiting') {
              clearInterval(timer);
              resolve(out);
            }
          }, 20);
        }, 10);
      }),
    EGG.dropMs,
  );
  await hatchEgg(page);
  committed();
  const viewport = page.viewportSize() ?? { width: 960, height: 540 };

  // Alone at the centre: the title screen hides its menu and lets the pointer through.
  const covered = await atEgg(page);
  if (!covered) throw new Error('no egg on screen');
  expect(Math.abs(covered.at.x - viewport.width / 2)).toBeLessThanOrEqual(2);
  expect(Math.abs(covered.at.y - viewport.height / 2)).toBeLessThanOrEqual(2);
  expect(covered.at.r).toBeGreaterThan(30);
  expect(covered.hits).toEqual(Array(5).fill('canvas#scene'));
  await expect(page.getByTestId('hatch')).toBeHidden();
  await expect(page.getByTestId('egg-wait')).toBeHidden();

  const samples = await resting;
  // And it is drawn: its glass rim stands out from the water beside it (held still for the shot;
  // a frozen world holds the egg's clock).
  const held = await page.evaluate(() => {
    const bs = window.__bs as BsHook;
    bs.debug?.timeScale(0);
    return bs.state().egg.phase;
  });
  const shot = await page.screenshot({ path: 'test-results/m6b-egg-waiting.png' });
  await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(1));
  if (held === 'waiting' || held === 'stirring') {
    const { x, y, r } = covered.at;
    const [left, right, waterL, waterR] = await patchLuma(
      page,
      shot,
      [
        { x: x - 0.62 * r, y },
        { x: x + 0.62 * r, y },
        { x: x - 2.8 * r, y },
        { x: x + 2.8 * r, y },
      ],
      2,
    );
    const water = Math.max(waterL ?? 0, waterR ?? 0);
    expect(Math.min(left ?? 0, right ?? 0), 'the rim over the water').toBeGreaterThan(water + 0.15);
  }
  const waiting = samples.filter((s) => s.phase === 'waiting');
  for (const s of waiting) expect(Math.abs(s.angle)).toBeLessThanOrEqual(0.01);
  return waiting.length === 20;
}

/** The stir, the burst and the result card. */
async function revealAt(page: Page): Promise<void> {
  // The result card, read in the page the moment it shows (a busy page answers the test slowly,
  // and the card stays 3 s), until it slides away by itself.
  const watched = page.evaluate(
    () =>
      new Promise<Record<string, unknown>>((resolve) => {
        let card: Record<string, unknown> | null = null;
        let shownAt = 0;
        const look = setInterval(() => {
          const { shown, tier } = (window.__bs as BsHook).state().egg.card;
          if (!card && shown) {
            shownAt = performance.now();
            const text = (id: string) =>
              document.querySelector(`[data-testid="${id}"]`)?.textContent;
            const el = document.querySelector('[data-testid="reveal-card"]') as HTMLElement;
            const preview = document.querySelector(
              '[data-testid="reveal-preview"]',
            ) as HTMLCanvasElement;
            const pixels = preview
              .getContext('2d')
              ?.getImageData(0, 0, preview.width, preview.height).data;
            // Where it rests once slid in (the layout box, without the slide's transform).
            const under = document.elementFromPoint(
              innerWidth / 2,
              el.offsetTop + el.offsetHeight / 2,
            );
            card = {
              shown: tier,
              name: text('reveal-name'),
              stars: text('reveal-stars'),
              label: document
                .querySelector('[data-testid="reveal-stars"]')
                ?.getAttribute('aria-label'),
              rarity: text('reveal-rarity'),
              shape: text('reveal-shape'),
              tier: el.dataset.tier,
              drawn: pixels ? pixels.some((v, i) => i % 4 === 3 && v > 0) : false,
              under: under?.id,
            };
          } else if (card && !shown) {
            clearInterval(look);
            resolve({ ...card, lasted: performance.now() - shownAt });
          }
        }, 20);
      }),
  );
  // The beacon: it stirs, with its sound, only now; then cracks and bursts as play begins.
  await page.waitForFunction(() => window.__bs?.state().egg.phase !== 'waiting', undefined, {
    timeout: 15_000,
  });
  await page.screenshot({ path: 'test-results/m6b-egg-stirring.png' });
  await waitPlaying(page);
  await page.waitForFunction(() => window.__bs?.state().egg.phase === 'revealed');
  const s = await state(page);
  expect(s.egg.phases).toEqual(['waiting', 'stirring', 'cracking', 'revealed']);
  const log = await eggLog(page);
  const first = (phase: string) => log.find((e) => e.phase === phase) as Sample;
  const stirred = first('stirring');
  // Never before the beacon: the hub's genesis had come (the check runs during the stir).
  expect(stirred.status).not.toBe('awaiting');
  expect(log.filter((e) => e.status === 'awaiting').every((e) => e.phase === 'waiting')).toBe(true);
  expect(Math.max(...log.map((e) => e.stir))).toBe(1);
  // The time cap: the burst within the stir and crack times of its rarity, unless the check
  // held it (then at once when play begins).
  const tier = s.player?.rarity ?? 'common';
  const revealed = first('revealed').t;
  const playing = log.find((e) => e.screen === 'playing')?.t ?? revealed;
  const cap = { common: 2200, uncommon: 2800, rare: 3400, exotic: 4000 }[tier];
  // A loaded software-rendered page draws seldom: allow two of its slowest frames meanwhile.
  const span = log.filter((e) => e.t >= stirred.t && e.t <= revealed);
  const frame = Math.max(100, ...span.slice(1).map((e, i) => e.t - (span[i] as Sample).t));
  expect(revealed - stirred.t).toBeLessThanOrEqual(Math.max(cap, playing - stirred.t) + 2 * frame);

  // The result card: the preview, the species, the rarity with its stars and the shape, over a
  // game that already plays (it takes no clicks); it slides away by itself after 3 s.
  const stars = { common: 1, uncommon: 2, rare: 3, exotic: 4 }[tier];
  const card = await watched;
  expect(card).toEqual({
    shown: tier,
    name: s.player?.species,
    stars: '★'.repeat(stars) + '☆'.repeat(4 - stars),
    label: `${stars} of 4 stars`,
    rarity: tier.charAt(0).toUpperCase() + tier.slice(1),
    shape: expect.stringMatching(/^[A-Z][a-z ]+$/),
    tier,
    drawn: true,
    under: 'scene',
    lasted: expect.any(Number),
  });
  // 3 s, give or take the page's slow timers.
  expect(card.lasted as number).toBeGreaterThan(1500);
  expect(card.lasted as number).toBeLessThan(4500);
  await expect(page.getByTestId('reveal-card')).toBeHidden();
  await page.context().close();
}

/** A click on the waiting egg wobbles it once; Enter during the stir skips to the burst. */
async function pokeAndSkip(browser: Browser, first: Promise<void>): Promise<void> {
  const page = await (await browser.newContext()).newPage();
  await openRecorded(page, '', M6B_EGG_HUB);
  // After the other player's commitment, so the hub is not committing two at once.
  await first;
  // Enter as soon as the egg stirs (pressed from the page: a busy page answers the test late, and
  // the stir lasts barely more than a second).
  await page.evaluate(() => {
    const w = window as unknown as { __pressed: string };
    w.__pressed = '';
    const look = setInterval(() => {
      const bs = window.__bs as BsHook;
      if (bs.state().egg.phase !== 'stirring') return;
      clearInterval(look);
      dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }));
      // The phase the key left it in, at once.
      w.__pressed = bs.state().egg.phase;
    }, 10);
  });
  // As soon as the result card shows, a key (from the page, so it lands within the card's 3 s).
  const dismissed = page.evaluate(
    () =>
      new Promise<{ shown: boolean }>((resolve) => {
        const look = setInterval(() => {
          const bs = window.__bs as BsHook;
          if (!bs.state().egg.card.shown) return;
          clearInterval(look);
          dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
          dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }));
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve({ shown: bs.state().egg.card.shown })),
          );
        }, 20);
      }),
  );
  await watchEgg(page);
  // A click on the egg once it has dropped in, from the page too (the beacon may come a second
  // after the egg), and the wobble from the click on, read from the egg's own timeline: a busy
  // software-rendered page draws a frame every 150 ms or so, too seldom to catch a peak 0.1 s on.
  const poked = page.evaluate(
    (dropMs) =>
      new Promise<{ phase: string; angles: { since: number; angle: number }[] }>((resolve) => {
        const look = setInterval(() => {
          const bs = window.__bs as BsHook;
          const { phase, at } = bs.state().egg;
          if (phase !== 'waiting' || !at) return;
          clearInterval(look);
          setTimeout(() => {
            const canvas = document.getElementById('scene') as HTMLCanvasElement;
            const clicked = performance.now();
            const where = { button: 0, clientX: at.x, clientY: at.y, bubbles: true };
            canvas.dispatchEvent(new PointerEvent('pointerdown', where));
            canvas.dispatchEvent(new PointerEvent('pointerup', where));
            resolve({
              phase: bs.state().egg.phase,
              angles: Array.from({ length: 131 }, (_, k) => ({
                since: k * 10,
                angle: bs.render.eggAngle(clicked + k * 10),
              })),
            });
          }, dropMs + 50);
        }, 10);
      }),
    EGG.dropMs,
  );
  await hatchEgg(page);
  const wobble = await poked;
  expect(wobble.phase).toBe('waiting');
  const peak = Math.max(...wobble.angles.map((e) => Math.abs(e.angle)));
  expect(peak).toBeGreaterThanOrEqual(0.1);
  expect(peak).toBeLessThanOrEqual(0.2);
  // Back within 0.01 rad in 1 s.
  for (const e of wobble.angles.filter((w) => w.since >= 1000)) {
    expect(Math.abs(e.angle)).toBeLessThanOrEqual(0.01);
  }
  // Enter during the stir jumps to the crack, and the burst follows as soon as play can begin.
  await waitPlaying(page);
  await page.waitForFunction(() => window.__bs?.state().egg.phase === 'revealed');
  const log = await eggLog(page);
  // Enter jumped the stir to the crack at once (held while the check runs, then the burst).
  const pressed = await page.evaluate(() => (window as unknown as { __pressed: string }).__pressed);
  expect(pressed).toBe('cracking');
  // The frames after the click drew the wobble, never past its cap.
  const drawn = log.filter((e) => e.phase === 'waiting').map((e) => Math.abs(e.angle));
  expect(Math.max(...drawn)).toBeLessThanOrEqual(0.2);
  expect((await state(page)).egg.phases.slice(-4)).toEqual([
    'waiting',
    'stirring',
    'cracking',
    'revealed',
  ]);
  // A key sends the card away at once: by the next frames it is gone.
  expect(await dismissed).toEqual({ shown: false });
  await page.context().close();
}

test('the genesis egg rests until the beacon, then stirs, bursts and shows a result card', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  // Two players hatch side by side: one watches, the other pokes and skips.
  let committed = (): void => {};
  const first = new Promise<void>((resolve) => {
    committed = resolve;
  });
  await Promise.all([restAndReveal(browser, () => committed()), pokeAndSkip(browser, first)]);
});

test('reduced motion: no drop, wobble or twitch, and the glow pulses instead', async ({
  browser,
}) => {
  test.setTimeout(45_000);
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await openRecorded(page, '', M6B_EGG_HUB);
  await watchEgg(page);
  await hatchEgg(page);
  expect((await state(page)).egg.motion).toBe('fade');
  const egg = await atEgg(page);
  if (egg) await page.mouse.click(egg.at.x, egg.at.y);
  await page.mouse.move(2, 2);
  await waitPlaying(page);
  await page.waitForFunction(() => window.__bs?.state().egg.phase === 'revealed');
  const log = await eggLog(page);
  for (const e of log) expect(e.angle, e.phase).toBe(0);
  const waitingGlow = log.filter((e) => e.phase === 'waiting').map((e) => e.glow);
  expect(Math.max(...waitingGlow) - Math.min(...waitingGlow)).toBeGreaterThan(0.1);
  expect(log.some((e) => e.phase === 'stirring')).toBe(true);
  await context.close();
});

test('after a death, Hatch again plays the reveal with nothing covering the egg @slow', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const page = await (await browser.newContext()).newPage();
  await openRecorded(page, '', M6B_EGG_HUB);
  await clickHatch(page);
  await waitPlaying(page);
  await page.evaluate(() => {
    const bs = window.__bs as BsHook;
    bs.debug?.setEnergy(0);
    bs.debug?.timeScale(10);
  });
  await page.waitForFunction(() => window.__bs?.state().screen === 'dead', undefined, {
    timeout: 20_000,
  });
  await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(1));
  await expect(page.getByTestId('hatch-again')).toBeVisible();
  await page.getByTestId('hatch-again').click();
  await page.mouse.move(2, 2);
  await page.waitForFunction(() => window.__bs?.state().egg.phase === 'waiting');
  expect((await state(page)).screen).toBe('dead');
  const viewport = page.viewportSize() ?? { width: 960, height: 540 };
  const covered = await atEgg(page);
  if (!covered) throw new Error('no egg on screen');
  expect(Math.abs(covered.at.x - viewport.width / 2)).toBeLessThanOrEqual(2);
  expect(Math.abs(covered.at.y - viewport.height / 2)).toBeLessThanOrEqual(2);
  expect(covered.hits).toEqual(Array(5).fill('canvas#scene'));
  await expect(page.getByTestId('hatch-again')).toBeHidden();
  await expect(page.getByTestId('death-cause')).toBeHidden();
  await page.screenshot({ path: 'test-results/m6b-egg-death.png' });
  await waitPlaying(page);
  await page.waitForFunction(() => window.__bs?.state().egg.phase === 'revealed');
  expect((await state(page)).egg.phases.slice(-4)).toEqual([
    'waiting',
    'stirring',
    'cracking',
    'revealed',
  ]);
  await expect.poll(async () => (await state(page)).egg.card.shown).toBe(true);
  await page.context().close();
});
