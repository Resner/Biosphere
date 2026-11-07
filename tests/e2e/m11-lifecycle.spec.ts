import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, type Page, test } from '@playwright/test';
import type { CardState } from '../../src/card/hook';
import type { BsHook } from '../../src/game/debug';
import { M11_LIFECYCLE_HUB as HUB, ripe, state } from './helpers';
import { EQUAL_BIOMASS, mate, open } from './m7-fight';
import { takeOver } from './m9-steps';
import { end, hatch, sameEnd, settled, type Trio, witness, witnessedFight } from './m10-steps';
import { CENTRE, closeAll, directory, type Player } from './m11-steps';

// M11 T19: the whole M11 line in one scenario (@slow, release gate), on an authority with short
// matings, the witness variables and two members to a leaf (`LEAF_MAX=2`, so the directory splits
// as soon as four players share the spawn). Four players share one world:
// - they hatch by the spawn and link;
// - A and B mate, and C or D audits the births;
// - A's child and C are put 30,000 wu away and swim toward each other until the directory brings
//   them together (they share no link with anyone else), and fight there, refereed by a witness
//   back at the spawn over its duty links;
// - B grows to T2 beside D, draws it as a swarm and never links it again.
// Throughout, no page holds more links than its cap allows. Every page closes; then the cards
// verify, the command line agrees and the audit shows no movement flag.

test.describe.configure({ mode: 'serial' });
// The cards and the swarm are judged on the picture: no low preset, and the medium one asked for.
test.use({ storageState: { cookies: [], origins: [] } });

const run = promisify(execFile);
/** The most links a page may hold (ADR 0062: the cap, P0 and P1 reach beyond what P2–P4 may). */
const CAP = 32;
/** How far from the spawn the fight is. */
const FAR_WU = 30_000;
/** A's child and C start this far apart, past any link class, and swim toward each other. */
const APART_WU = 3_000;

const cardUrl = (id: string): string => `./card.html?c=${id}&hub=${HUB}&quality=medium`;
const cardState = (page: Page): Promise<CardState> =>
  page.evaluate(() => (window.__card as { state(): CardState }).state());

async function cardOf(page: Page, id: string, what: string): Promise<CardState> {
  await page.goto(cardUrl(id));
  await page
    .waitForFunction(() => ['done', 'error'].includes(window.__card?.state().phase ?? ''), null, {
      timeout: 60_000,
    })
    .catch(async (error) => {
      throw new Error(`${what} never finished: ${JSON.stringify(await cardState(page))}`, {
        cause: error,
      });
    });
  return cardState(page);
}

/** Waits until one of the pages attested an event of `kind`, agreeing. */
async function audited(pages: Page[], kind: string): Promise<void> {
  await expect
    .poll(
      async () => {
        for (const page of pages) {
          const hit = (await state(page)).witness.audits.find((x) =>
            x.event.startsWith(`${kind}:`),
          );
          if (hit) return hit.agree;
        }
        return null;
      },
      { message: `C or D audits the ${kind}`, timeout: 90_000 },
    )
    .toBe(true);
}

/** Every second a page samples its links: the most it held at once, and the most of those beyond P0 and P1. */
const sampleLinks = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __links?: { max: number; maxLow: number } };
    w.__links = { max: 0, maxLow: 0 };
    window.setInterval(() => {
      const links = (window.__bs as BsHook).state().net.links;
      const held = w.__links as { max: number; maxLow: number };
      held.max = Math.max(held.max, links.length);
      const low = links.filter((l) => l.class !== null && l.class >= 2).length;
      held.maxLow = Math.max(held.maxLow, low);
    }, 1000);
  });

const sampled = (page: Page) =>
  page.evaluate(() => (window as unknown as { __links: { max: number; maxLow: number } }).__links);

/** The ids of the page's links whose hello passed. */
const helloed = async (page: Page): Promise<string[]> =>
  (await state(page)).net.links
    .filter((l) => l.hello)
    .map((l) => l.id)
    .sort();

/** Waits until every page in `pages` holds a link, past its hello, to every other. */
async function allLinked(pages: { page: Page; id: string }[], message: string): Promise<void> {
  for (const me of pages) {
    const others = pages.filter((p) => p !== me).map((p) => p.id);
    await expect
      .poll(
        async () => {
          const held = await helloed(me.page);
          return others.filter((id) => !held.includes(id));
        },
        { message, timeout: 60_000, intervals: [250] },
      )
      .toEqual([])
      .catch(async (error) => {
        const views = await Promise.all(
          pages.map(async (p) => {
            const s = await state(p.page);
            return {
              id: p.id.slice(0, 4),
              at: s.player && [Math.round(s.player.x), Math.round(s.player.y)],
              net: s.net,
            };
          }),
        );
        throw new Error(`${message}: ${JSON.stringify(views)}`, { cause: error });
      });
  }
}

const place = (page: Page, dx: number, dy: number) =>
  page.evaluate(
    ([x, y]) => {
      const debug = (window.__bs as BsHook).debug;
      debug?.teleport(x as number, y as number);
      debug?.setZone('twilight');
    },
    [CENTRE + dx, CENTRE + dy],
  );

const steer = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([tx, ty]) => void (window.__bs as BsHook).debug?.steerTo({ x: tx as number, y: ty as number }),
    [x, y],
  );

const at = async (page: Page) => {
  const p = (await state(page)).player;
  if (!p) throw new Error('a page has no creature');
  return p;
};

test('four players find each other across a world, fight a witnessed fight 30,000 wu out and a giant sees a starter as a swarm @slow', async ({
  browser,
  request,
}) => {
  test.setTimeout(900_000);
  const pages: Page[] = [];
  const made: { a1?: string; b1?: string; c0?: string; d0?: string } = {};
  let fightId = '';
  try {
    // Every page is a witness candidate (`dutyFrameMs`: four software-rendered pages draw slower
    // than a witness may) and skips its draw, as in the M10 lifecycle.
    const c = await witness(browser, HUB);
    const d = await witness(browser, HUB);
    const a = await open(browser, HUB);
    const b = await witness(browser, HUB);
    pages.push(a, b, c, d);
    await b.evaluate(() => (window.__bs as BsHook).debug?.skipDraw(true));
    // C and D hatch first, so both are in the witness pool for the births.
    await Promise.all([hatch(c), hatch(d)]);
    await Promise.all([hatch(a), hatch(b)]);
    for (const page of pages) await sampleLinks(page);
    const ids = await Promise.all(pages.map(async (p) => (await state(p)).playerId as string));
    const [idA, idB, idC, idD] = ids as [string, string, string, string];

    // All four are by the spawn, so each links the others.
    await allLinked(
      [
        { page: a, id: idA },
        { page: b, id: idB },
        { page: c, id: idC },
        { page: d, id: idD },
      ],
      'the four link by the spawn',
    );

    // A and B mate and take over their children, C or D audits the births.
    await Promise.all([ripe(a), ripe(b)]);
    await mate(a, b);
    [made.a1, made.b1] = await Promise.all([takeOver(a), takeOver(b)]);
    made.c0 = (await state(c)).life.creature as string;
    made.d0 = (await state(d)).life.creature as string;
    await audited([c, d], 'mating');

    // Far away: A's child and C are put 30,000 wu from the spawn, 3,000 apart, in the twilight
    // zone, and swim toward each other until the directory links them.
    const toFight = [a, c];
    for (const page of toFight) {
      await page.evaluate((m) => (window.__bs as BsHook).debug?.setBiomass(m), EQUAL_BIOMASS);
    }
    await place(a, FAR_WU, 0);
    // C goes beside where A ended up (the zone search may have moved it), APART_WU to its east.
    const start = await at(a);
    await place(c, start.x - CENTRE + APART_WU, start.y - CENTRE);
    for (const page of toFight)
      await page.evaluate(() => (window.__bs as BsHook).debug?.setHealth(Number.MAX_SAFE_INTEGER));
    const deadline = Date.now() + 300_000;
    let near = false;
    while (Date.now() < deadline) {
      const [pa, pc] = [await at(a), await at(c)];
      const closeBy = Math.hypot(pa.x - pc.x, pa.y - pc.y);
      if (closeBy < 150) {
        near = true;
        break;
      }
      await Promise.all([steer(a, pc.x, pc.y), steer(c, pa.x, pa.y)]);
      await a.waitForTimeout(1000);
    }
    expect(
      near,
      `A’s child and C swam together: ${JSON.stringify({ a: await at(a), c: await at(c) })}`,
    ).toBe(true);
    // They found each other through the directory with no link in common: each holds the other
    // and nobody from the spawn.
    await expect
      .poll(() => helloed(a), { message: 'A links C alone, 30,000 wu out', timeout: 60_000 })
      .toEqual([idC]);
    await expect
      .poll(() => helloed(c), { message: 'C links A alone, 30,000 wu out', timeout: 60_000 })
      .toEqual([idA]);
    // The directory places them far from the spawn, in leaves of their own.
    const view = await directory(request, HUB);
    const member = (id: string) => view.members.find((m) => m.id === id);
    for (const id of [idA, idC]) {
      const m = member(id);
      expect(m, `the directory holds ${id}`).toBeDefined();
      expect(Math.hypot((m?.x ?? 0) - CENTRE, (m?.y ?? 0) - CENTRE)).toBeGreaterThan(FAR_WU * 0.8);
    }

    // The fight: A's child engages C, and a witness back at the spawn (D, or B) referees it over
    // its duty links. D and B are the pool; the fighters are the pair.
    const t: Trio = { hub: HUB, a, b: c, c: d, d: b, idA, idB: idC, idC: idD, idD: idB };
    const fight = await witnessedFight(t);
    fightId = fight.id;
    const holder = (await state(d)).witness.duty?.enc === fight.id ? d : b;
    const holderId = holder === d ? idD : idB;
    for (const page of [a, c]) {
      const s = await state(page);
      expect(
        s.net.dutyLinks.map((l) => l.peer),
        'the fighters hold a duty link to the witness',
      ).toContain(holderId);
    }
    await end(t, fight.id);
    const hash = await sameEnd(t, fight.id);
    await expect
      .poll(async () => (await state(holder)).witness.duty, {
        message: 'the witness’s duty ends',
        timeout: 20_000,
      })
      .toBeNull();
    // The witness, A and C end the fight on one hash.
    expect((await state(holder)).witness.last?.hash).toBe(hash);
    const one = await settled(request, HUB, fight.id);
    expect(one.referees[0]).toMatchObject({ by: 'authority', from: 0 });
    expect(one.referees.some((r) => r.by === holderId && r.from === fight.from)).toBe(true);

    // Tiers: B grows to T2 beside D. D is then a swarm to B, and B never links D again.
    const spawn = await at(d);
    await b.evaluate(
      ([x, y]) => {
        const debug = (window.__bs as BsHook).debug;
        debug?.teleport(x as number, y as number);
        debug?.skipDraw(false);
        debug?.setBiomass(70_000);
      },
      [spawn.x, spawn.y],
    );
    await expect
      .poll(() => helloed(b).then((l) => l.includes(idD)), {
        message: 'B’s link to D closes: a giant and a starter are two tiers apart',
        timeout: 60_000,
        intervals: [250],
      })
      .toBe(false);
    await expect
      .poll(async () => (await b.evaluate(() => (window.__bs as BsHook).render.info())).swarms, {
        message: 'B draws D as a swarm',
        timeout: 60_000,
        intervals: [250],
      })
      .toBeGreaterThanOrEqual(1);
    // A few more seconds of B’s own ticks: the link stays closed.
    const tick = (await state(b)).tick;
    await b.waitForFunction((t0) => (window.__bs?.state().tick ?? 0) >= t0 + 90, tick, {
      timeout: 60_000,
    });
    expect(await helloed(b), 'B never links D').not.toContain(idD);

    // No page ever held more links than its cap allows.
    for (const page of pages) {
      const held = await sampled(page);
      expect(held.max, 'a page held more links than the cap').toBeLessThanOrEqual(CAP);
      expect(held.maxLow, 'a page held more P2–P4 links than the cap').toBeLessThanOrEqual(24);
    }
  } finally {
    await closeAll(pages.map((page) => ({ page, id: '' }) satisfies Player));
  }
  expect(fightId).not.toBe('');

  // Every page is closed. The cards verify, the command line agrees and the audit is clean.
  const { a1, b1, c0, d0 } = made;
  if (!a1 || !b1 || !c0 || !d0) throw new Error('missing creatures');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    for (const [what, id] of [
      ["A's child", a1],
      ["B's child", b1],
      ['C', c0],
      ['D', d0],
    ] as const) {
      const card = await cardOf(page, id, `the card of ${what}`);
      expect(card, what).toMatchObject({ phase: 'done', verdict: 'verified', problems: [] });
    }
    await cardOf(page, a1, "A's child");
    await page.screenshot({ path: 'test-results/m11-lifecycle-card.png' });
    await test.info().attach('m11-lifecycle-card', {
      path: 'test-results/m11-lifecycle-card.png',
      contentType: 'image/png',
    });
  } finally {
    await context.close();
  }

  const cli = await run('node', ['tools/lineage.mjs', a1, '--hub', HUB, '--replay']).catch(
    (error: { stdout?: string; stderr?: string }) => {
      throw new Error(`the CLI did not exit 0:\n${error.stdout}\n${error.stderr}`, {
        cause: error,
      });
    },
  );
  expect(cli.stdout).toMatch(/verified/i);

  const audit = await request.get(`${HUB}/v1/audit`);
  expect(audit.ok()).toBe(true);
  const flags = (await audit.json()) as { total: Record<string, number> };
  expect(flags.total.teleport ?? 0, JSON.stringify(flags.total)).toBe(0);
});
