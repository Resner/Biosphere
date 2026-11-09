import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, type Page, test } from '@playwright/test';
import type { CardState } from '../../src/card/hook';
import type { BsHook } from '../../src/game/debug';
import {
  clickHatch,
  M12_LIFECYCLE_HUB as HUB,
  playerOf,
  ripe,
  state,
  waitPlaying,
} from './helpers';
import { mate, open } from './m7-fight';
import { takeOver } from './m9-steps';
import { end, fight, hatch, settled, type Trio } from './m10-steps';
import { CENTRE, closeAll, linksAre, type Player, place } from './m11-steps';
import { clearance, directory, dist, emptyWorld, p1Reach, type Sized, spawnOf } from './m12-steps';

// M12 T11: the whole M12 line in one scenario (@slow, release gate), on an authority with instances
// of 2 (`INSTANCE_MAX=2`), a crowd that is quiet after 3 s (`QUIET_MS=3000`), a ride offered after 3 s
// alone (`RIDE_ALONE_MS=3000`) and short matings. Four players, A, B, C and D, all on
// `debug.crowdAt(3)`:
// - spawning: A hatches on the world's centre, B, C and D are placed around it, outside each other's
//   clearance, and every pair links;
// - mating: A and B mate and take over their children;
// - a crowd: the four are brought within a few hundred wu (A's child beside B's child, C beside D),
//   the hub splits them into {A, B} and {C, D}, and A's child engages B's child inside their
//   instance, so C and D never see the fight;
// - during the fight: B reloads and comes back into the same fight, in the same instance; D swims
//   40,000 wu out of the crowd and, after 3 s alone, rides the current back, protected, outside
//   every crowd member's P1 reach (the locked fight keeps the crowd alive until then);
// - after the fight: C swims out of the crowd too, the crowd of A's and B's children merges, and
//   the four come together in open water and link.
// Throughout, no page holds more links than its cap allows. Every page closes; the cards verify,
// the command line agrees and the audit shows no `teleport` flag.

test.describe.configure({ mode: 'serial' });
// The cards are judged on the picture: no low preset, and the medium one asked for.
test.use({ storageState: { cookies: [], origins: [] } });

const run = promisify(execFile);
/** The most links a page may hold (ADR 0062), and the most of them beyond P0 and P1. */
const CAP = 32;
const CAP_LOW = 24;
/** D swims this far out of the crowd, into the twilight. */
const FAR_WU = 40_000;
/** The hub's directory is as old as a report: a member may have drifted this far since (wu). */
const DRIFT_WU = 100;

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

/** The most links a page held at once, and the most of them beyond P0 and P1. */
interface Held {
  max: number;
  maxLow: number;
}

/** Every second a page samples its links (a reload starts the page's count again). */
const sampleLinks = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __links?: Held };
    w.__links = { max: 0, maxLow: 0 };
    window.setInterval(() => {
      const links = (window.__bs as BsHook).state().net.links;
      const held = w.__links as Held;
      held.max = Math.max(held.max, links.length);
      const low = links.filter((l) => l.class !== null && l.class >= 2).length;
      held.maxLow = Math.max(held.maxLow, low);
    }, 1000);
  });

const sampled = (page: Page): Promise<Held> =>
  page.evaluate(() => (window as unknown as { __links: Held }).__links);

/** A page's own instance (`state().net.instance.n`; 0 is the open water). */
const instanceOf = (p: Player) =>
  p.page.evaluate(() => (window.__bs as BsHook).state().net.instance.n);

/**
 * Keeps the pages' creatures fed from here on. These creatures never eat, so on a slow runner they
 * starve before the last step (E2E main: all four pages on the death screen), and a dead creature
 * leaves the directory, so nobody could link to it. Called once the crowd has merged, so it changes
 * nothing the crowd steps see: it only keeps the living alive through the final gathering.
 */
const feedAll = (ps: Player[]) =>
  Promise.all(
    ps.map((p) =>
      p.page.evaluate(() => {
        const debug = (window.__bs as BsHook).debug;
        const feed = () => {
          debug?.setEnergy(Number.MAX_SAFE_INTEGER);
          debug?.setHealth(Number.MAX_SAFE_INTEGER);
        };
        feed();
        window.setInterval(feed, 2000);
      }),
    ),
  );

/**
 * Brings a page that starved back into play: it takes the ancestor the death screen offers, else
 * hatches again. These creatures never eat and the scenario runs for minutes, so one of the four can
 * be on its death screen at the final gathering (E2E main: whichever of them ran out first, in
 * either order, and feeding the crowd steps' creatures broke those steps). A dead creature leaves
 * the directory, so the gathering is of the four players' living creatures, whichever those are.
 */
async function revive(p: Player): Promise<void> {
  if ((await state(p.page)).screen !== 'dead') return;
  const ancestor = p.page.getByTestId('death-fallback-ancestor');
  const offered = await ancestor
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (offered) await ancestor.click();
  else await p.page.getByTestId('hatch-again').click();
  await waitPlaying(p.page);
}

/**
 * Every pair of `ps` holds a link past its hello. A failure names every player's links, instance
 * and position, since the one page that timed out first says nothing of the others.
 */
async function allLinked(ps: Player[], message: string, timeout = 60_000): Promise<void> {
  const results = await Promise.allSettled(
    ps.map((p) =>
      linksAre(
        p,
        ps.filter((o) => o !== p).map((o) => o.id),
        message,
        timeout,
      ),
    ),
  );
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (!failed) return;
  const all = await Promise.all(
    ps.map(async (p) => {
      const { net, spawn, ride, screen } = await state(p.page);
      const at = await playerOf(p.page).catch(() => null);
      return {
        id: p.id.slice(0, 6),
        screen,
        spawn,
        ride,
        at: at ? { x: Math.round(at.x), y: Math.round(at.y), radius: at.radius } : null,
        n: net.instance.n,
        crowded: net.crowded,
        known: net.known,
        links: net.links.map((l) => ({
          id: l.id.slice(0, 6),
          class: l.class,
          open: l.open,
          hello: l.hello,
        })),
      };
    }),
  );
  throw new Error(`${(failed.reason as Error).message}\nevery player: ${JSON.stringify(all)}`, {
    cause: failed.reason,
  });
}

/**
 * B reloads mid-fight. True once B is back in the same running fight (one click on its title), false
 * when that fight ended first: B then hatches back in and the caller engages again.
 */
async function reloadBack(a: Player, b: Player, id: string): Promise<boolean> {
  await b.page.reload();
  await b.page
    .waitForFunction(() => window.__bs?.ready === true && window.__bs.state().playerId, undefined, {
      timeout: 60_000,
    })
    .catch((error) => {
      throw new Error('B’s page never came back after its reload', { cause: error });
    });
  await b.page.evaluate(() => (window.__bs as BsHook).debug?.skipDraw(true));
  const offered = b.page.getByTestId('resume-fight');
  await expect
    .poll(
      async () => {
        if (await offered.isVisible()) return 'offered';
        const enc = (await state(a.page)).encounter;
        return enc?.id === id && enc.over ? 'over' : 'waiting';
      },
      { message: 'B is offered the fight, or the fight ends', timeout: 30_000 },
    )
    .not.toBe('waiting');
  if (!(await offered.isVisible())) {
    await clickHatch(b.page);
    await waitPlaying(b.page);
    return false;
  }
  await offered.click();
  await b.page
    .waitForFunction(() => window.__bs?.state().screen === 'playing', undefined, {
      timeout: 20_000,
    })
    .catch((error) => {
      throw new Error('B never went back into the fight after its click', { cause: error });
    });
  // The click leaves the cursor on the button, which steers B away (E2E main: B swam 8,300 wu off
  // after the final teleport and could not link), so the cursor is parked on the cell, as `hatch` does.
  const { width, height } = b.page.viewportSize() ?? { width: 960, height: 540 };
  await b.page.mouse.move(width / 2, height / 2);
  const back = (await state(b.page)).encounter;
  expect(back?.id, 'B is back in the same fight').toBe(id);
  return back?.over === false;
}

test('four players spawn around each other, fight in a crowd instance, a lone one rides back and the crowd merges @slow', async ({
  browser,
  request,
}) => {
  test.setTimeout(1_200_000);
  await emptyWorld(request, HUB);
  const players: Player[] = [];
  const made: { a1?: string; b1?: string; c0?: string; d0?: string } = {};
  let fightId = '';
  // B's links held before its reload, whose page then starts counting again.
  let bBefore: Held = { max: 0, maxLow: 0 };
  try {
    // Spawning. Each page hatches after the one before, the hub placing it by the directory as it
    // stands: outside every earlier player's clearance, and linking at once.
    for (const name of ['A', 'B', 'C', 'D']) {
      const before = new Map((await directory(request, HUB)).members.map((m) => [m.id, m]));
      const page = await open(browser, HUB, '&quality=medium');
      await hatch(page);
      await sampleLinks(page);
      const p: Player = { page, id: (await state(page)).playerId as string };
      const at = await spawnOf(p);
      if (players.length === 0) {
        expect(at, 'A hatches on the world’s centre').toEqual({
          x: CENTRE,
          y: CENTRE,
          why: 'placed',
          protect: true,
        });
      } else {
        expect(at, `${name} is placed, protected`).toMatchObject({ why: 'placed', protect: true });
        const view = await directory(request, HUB);
        const note = view.spawns.find((s) => s.x === at.x && s.y === at.y);
        if (!note) throw new Error(`the hub has no note of ${name}’s spawn`);
        const after = new Map(view.members.map((m) => [m.id, m]));
        for (const earlier of players) {
          const was = [before.get(earlier.id), after.get(earlier.id)].filter(
            (m): m is NonNullable<typeof m> => m !== undefined,
          );
          expect(was.length, `${name}: the hub knows ${earlier.id}`).toBeGreaterThan(0);
          expect(
            Math.max(...was.map((m) => dist(at, m) - clearance(note, m))),
            `${name} lies outside an earlier player’s clearance`,
          ).toBeGreaterThanOrEqual(-1e-6);
        }
        // A member the directory misses after the spawn counts at the place the sample before it had.
        const known = (id: string) => (after.get(id) ?? before.get(id)) as Sized;
        const reach = Math.min(
          ...players.map((q) => dist(at, known(q.id)) - p1Reach(note, known(q.id))),
        );
        expect(reach, `${name} lies within P1 reach of an earlier player`).toBeLessThanOrEqual(0);
      }
      players.push(p);
      await allLinked(players, `${name} spawns and every pair links`, 30_000);
    }
    const [a, b, c, d] = players as [Player, Player, Player, Player];
    const t: Trio = {
      hub: HUB,
      a: a.page,
      b: b.page,
      c: c.page,
      idA: a.id,
      idB: b.id,
      idC: c.id,
    };

    // Mating: A and B mate and take over their children.
    await Promise.all([ripe(a.page), ripe(b.page)]);
    await mate(a.page, b.page);
    [made.a1, made.b1] = await Promise.all([takeOver(a.page), takeOver(b.page)]);
    made.c0 = (await state(c.page)).life.creature as string;
    made.d0 = (await state(d.page)).life.creature as string;

    // A crowd. The pairs sit inside each other's crowd list (8 × the larger radius) and the two pairs
    // outside it, in a row B, A, C, D; all four link, and A draws C and D in full, before they crowd.
    const radius = Math.max(
      ...(await Promise.all(players.map(async (p) => (await playerOf(p.page)).radius))),
    );
    const pair = 3 * radius;
    const gap = 12 * radius;
    await place(b, -pair, 0);
    await place(a, 0, 0);
    await place(c, gap, 0);
    await place(d, gap + pair, 0);
    await allLinked(players, 'all four link before any crowds', 60_000);
    await expect
      .poll(
        () =>
          a.page.evaluate(
            (ids) =>
              ids.every(
                (id) =>
                  (window.__bs as BsHook).state().remotes.find((r) => r.id === id)?.alpha === 1,
              ),
            [c.id, d.id],
          ),
        { message: 'A draws C and D in full', timeout: 30_000 },
      )
      .toBe(true);
    await Promise.all(
      players.map((p) => p.page.evaluate(() => (window.__bs as BsHook).debug?.crowdAt(3))),
    );
    const split = async () => {
      const [na, nb, nc, nd] = await Promise.all(players.map(instanceOf));
      return na !== 0 && nc !== 0 && na === nb && nc === nd && na !== nc;
    };
    await expect
      .poll(split, {
        message: 'the hub splits the four into {A, B} and {C, D}',
        timeout: 30_000,
        intervals: [200],
      })
      .toBe(true);
    const instance = await instanceOf(a);

    // The fight, inside A's and B's instance: C and D never see it. A fight can end before B is back
    // in it, so A engages again, at most 3 times; then B is in it again, in the same instance.
    let previous: string | undefined;
    for (let attempt = 0; attempt < 3 && fightId === ''; attempt++) {
      await Promise.all(
        [a, b].map((p) =>
          p.page.evaluate(() => (window.__bs as BsHook).debug?.setHealth(Number.MAX_SAFE_INTEGER)),
        ),
      );
      // B is unprotected on A's page (the promotion's protection has run out) before A engages.
      await expect
        .poll(async () => (await state(a.page)).remotes.find((r) => r.id === b.id)?.protected, {
          message: 'A sees B unprotected',
          timeout: 60_000,
        })
        .toBe(false);
      const id = await fight(t, previous);
      expect(await instanceOf(a), 'A fights in its instance').toBe(instance);
      expect(await instanceOf(b), 'B fights in A’s instance').toBe(instance);
      for (const other of [c, d]) {
        const s = await state(other.page);
        const links = s.net.links.map((l) => l.id);
        expect(s.encounter?.id, 'C and D never see the fight').not.toBe(id);
        for (const fighter of [a, b]) {
          expect(links, 'C and D hold no link to the fighters').not.toContain(fighter.id);
          expect(
            s.remotes.find((r) => r.id === fighter.id)?.alpha ?? 0,
            'C and D draw neither fighter',
          ).toBe(0);
        }
      }
      bBefore = await sampled(b.page);
      if (await reloadBack(a, b, id)) {
        fightId = id;
        await sampleLinks(b.page);
        await b.page.evaluate(() => {
          const debug = (window.__bs as BsHook).debug;
          debug?.crowdAt(3);
          debug?.autoBrace(true);
        });
      } else {
        previous = id;
      }
    }
    expect(fightId, 'B was back in a running fight').not.toBe('');
    await expect
      .poll(() => instanceOf(b), {
        message: 'B is back in A’s instance',
        timeout: 30_000,
        intervals: [200],
      })
      .toBe(instance);
    expect(await instanceOf(a), 'A’s instance never changed during the fight').toBe(instance);
    const view = await directory(request, HUB);
    expect(view.members.find((m) => m.id === a.id)?.n).toBe(instance);
    expect(view.members.find((m) => m.id === b.id)?.n).toBe(instance);

    // D swims out of the crowd, alone in the twilight, and after 3 s rides the current back (the
    // locked fight keeps the crowd, and its members' P1 reach, in force).
    await d.page.evaluate(() => {
      const debug = (window.__bs as BsHook).debug;
      debug?.aloneMs(3000);
      debug?.skipDraw(false);
    });
    await place(d, FAR_WU, 0);
    await d.page.evaluate(() => (window.__bs as BsHook).debug?.setZone('twilight'));
    await linksAre(d, [], 'D is alone out there', 60_000);
    await expect
      .poll(async () => (await state(d.page)).ride.offered, {
        message: 'D’s hint offers the ride',
        timeout: 60_000,
        intervals: [200],
      })
      .toBe(true);
    const fightRuns = async () => (await state(a.page)).encounter?.over === false;
    const runningBefore = await fightRuns();
    // The hub decides D's place from the directory somewhere between this sample and the one after
    // the arrival, while A and B keep fighting: a member's place then lies within what it moved
    // between the two samples.
    const sampledBefore = new Map((await directory(request, HUB)).members.map((m) => [m.id, m]));
    await d.page.keyboard.press('r');
    await expect
      .poll(async () => (await state(d.page)).ride.phase, {
        message: 'D’s ride arrives',
        timeout: 60_000,
        intervals: [100],
      })
      .toBe('arrived');
    const arrival = await spawnOf(d);
    expect(arrival).toMatchObject({ why: 'ride', protect: true });
    const after = await directory(request, HUB);
    const note = after.spawns.find((s) => s.x === arrival.x && s.y === arrival.y);
    if (!note) throw new Error('the hub has a note of D’s arrival');
    const crowded = after.members.filter((m) => m.id !== d.id && m.n !== 0);
    if (runningBefore && (await fightRuns())) {
      // The fight held the crowd: the fighters were in an instance when D landed.
      expect(crowded.map((m) => m.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    }
    const movedSince = (m: Sized & { id: string }) => {
      const was = sampledBefore.get(m.id);
      return (was ? dist(was, m) : 0) + DRIFT_WU;
    };
    for (const m of after.members.filter((m) => m.id !== d.id)) {
      expect(dist(arrival, m), 'D lands outside every member’s clearance').toBeGreaterThanOrEqual(
        clearance(note, m) - movedSince(m),
      );
    }
    for (const m of crowded) {
      expect(
        dist(arrival, m),
        'D lands outside the P1 reach of every member still in the crowd',
      ).toBeGreaterThanOrEqual(p1Reach(note, m) - movedSince(m));
    }
    // D holds a link to nobody who is in a crowd. A member that left its instance meanwhile (C's
    // crowd of one dissolves after QUIET_MS, A's and B's once the fight is over) is open water and
    // may be linked, so judge the members that were in an instance before and now. A link made while
    // a member was still in the open water closes a moment after the hub moves that member into an
    // instance (E2E CI: one such link was read between the two), so the links and the directory are
    // read together until none is left, within a bound.
    await expect
      .poll(
        async () => {
          const dLinks = new Set((await state(d.page)).net.links.map((l) => l.id));
          const stillCrowded = new Set(
            (await directory(request, HUB)).members.filter((m) => m.n !== 0).map((m) => m.id),
          );
          return crowded.filter((m) => stillCrowded.has(m.id) && dLinks.has(m.id)).map((m) => m.id);
        },
        { message: 'D holds no link to a member in a crowd', timeout: 20_000, intervals: [200] },
      )
      .toEqual([]);

    // After the fight, A ends it by swimming off, and the hub settles it.
    await end(t, fightId);
    await settled(request, HUB, fightId);

    // Quiet: C swims out of the crowd too, the fight is over, and the crowd (A's and B's children)
    // merges back into the open water.
    await place(c, -6000, 0);
    await expect
      .poll(() => instanceOf(c), { message: 'C is back in the open water', timeout: 60_000 })
      .toBe(0);
    await expect
      .poll(async () => Promise.all([a, b].map(instanceOf)), {
        message: 'the crowd of A’s and B’s children merges into the open water',
        timeout: 60_000,
      })
      .toEqual([0, 0]);
    await expect
      .poll(async () => (await directory(request, HUB)).crowds.length, {
        message: 'no crowd is left',
        timeout: 30_000,
      })
      .toBe(0);

    // The four come together in open water (no crowd now: 24 links) and link.
    await feedAll(players);
    // Fed from here on, a page that starved before this point comes back into play first.
    await Promise.all(players.map(revive));
    await Promise.all(
      players.map((p) => p.page.evaluate(() => (window.__bs as BsHook).debug?.crowdAt(24))),
    );
    // A swam off to end the fight and B stayed where it fought, so all four gather on one spot: A
    // (which a teleport also stops) stays where it is, B, C and D are placed around it.
    const home = await playerOf(a.page);
    const [hx, hy] = [home.x - CENTRE, home.y - CENTRE];
    await place(a, hx, hy);
    await place(b, hx, hy + pair);
    await place(c, hx - pair, hy);
    await place(d, hx + pair, hy);
    // Each one stands where it was put, and stays there: a page that has moved on (a late
    // settlement, a hub spawn) would sit out of the others' reach, and the failure says which.
    const put = [
      ['A', a, hx, hy],
      ['B', b, hx, hy + pair],
      ['C', c, hx - pair, hy],
      ['D', d, hx + pair, hy],
    ] as const;
    const stand = async (when: string) => {
      for (const [name, p, dx, dy] of put) {
        const at = await playerOf(p.page);
        expect(
          Math.hypot(at.x - (CENTRE + dx), at.y - (CENTRE + dy)),
          `${name} stands where it was put ${when}: at ${Math.round(at.x)},${Math.round(at.y)}, put at ${CENTRE + dx},${CENTRE + dy}`,
        ).toBeLessThan(400);
      }
    };
    await stand('right after the teleport');
    await allLinked(players, 'the four link in open water', 90_000).catch(async (error) => {
      await stand('when they failed to link').catch((e) => {
        throw new Error(`${(error as Error).message}\n${(e as Error).message}`, { cause: error });
      });
      throw error;
    });
    for (const p of players) expect(await instanceOf(p), 'the open water').toBe(0);

    // No page ever held more links than its cap allows.
    for (const p of players) {
      // `bBefore` is zero for everyone but B, whose page counted again after its reload.
      const held = await sampled(p.page);
      const earlier = p === b ? bBefore : { max: 0, maxLow: 0 };
      expect(
        Math.max(held.max, earlier.max),
        'a page held more links than the cap',
      ).toBeLessThanOrEqual(CAP);
      expect(
        Math.max(held.maxLow, earlier.maxLow),
        'a page held more P2–P4 links than the cap',
      ).toBeLessThanOrEqual(CAP_LOW);
    }
  } finally {
    await closeAll(players);
  }

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
