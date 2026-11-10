import { expect, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { state } from './helpers';
import {
  CENTRE,
  closeAll,
  directory,
  join,
  linksAre,
  type Player,
  place,
  relaysOf,
} from './m11-steps';

// M11 T13: discovery and signaling through a peer. A at −5,000 wu, B at the centre and C at
// +5,000 wu: A–B and B–C are linked, A–C is not (10,000 wu is past a starter's reach). A swims
// toward C, learns of it from B's gossip, and the two link through B's relay: the hub carries none
// of their signals. (They hatched side by side, so their first link went through the hub: the
// pair's count must not rise from there.)

const HUB = 'http://localhost:8830';

test.describe.configure({ mode: 'serial' });

const signals = async (p: Player) => (await state(p.page)).net.signals;

test('two players learn of each other by gossip and link through a peer’s relay @slow', async ({
  browser,
  request,
}) => {
  test.setTimeout(240_000);
  const players: Player[] = [];
  try {
    for (let i = 0; i < 3; i++) players.push(await join(browser, HUB));
    const [a, b, c] = players as [Player, Player, Player];
    await linksAre(b, [a.id, c.id], 'B links A and C at the spawn', 60_000);
    await place(a, -5000, 0);
    await place(b, 0, 0);
    await place(c, 5000, 0);
    await linksAre(a, [b.id], 'A holds B alone once C is 10,000 wu away', 60_000);
    await linksAre(c, [b.id], 'C holds B alone', 30_000);
    await linksAre(b, [a.id, c.id], 'B still holds A and C', 30_000);

    const hubBefore = relaysOf(await directory(request, HUB), a.id, c.id);
    const relayedA = (await signals(a)).relayed;
    const relayedC = (await signals(c)).relayed;
    const hubA = (await signals(a)).hub;
    const hubC = (await signals(c)).hub;
    const fallbackA = (await signals(a)).fallback;
    const fallbackC = (await signals(c)).fallback;

    // A swims toward C, in steps a starter could swim, until C is within its reach.
    for (let x = -5000; x <= -1500; x += 100) {
      await place(a, x, 0);
      await a.page.waitForTimeout(100);
    }
    // A hears of C from B's gossip.
    await expect
      .poll(async () => (await state(a.page)).net.known.gossip, {
        message: 'A knows of C from gossip',
        timeout: 20_000,
      })
      .toBeGreaterThan(0);
    await linksAre(a, [b.id, c.id], 'A and C link', 60_000);
    await linksAre(c, [a.id, b.id], 'C links A', 30_000);

    expect((await signals(a)).relayed, 'A’s signals went through a peer').toBeGreaterThan(relayedA);
    expect((await signals(c)).relayed, 'C’s signals went through a peer').toBeGreaterThan(relayedC);
    expect((await signals(b)).forwarded, 'B passed them on').toBeGreaterThan(0);
    // Neither page sent a signal through the hub but an offer's one resend (ADR 0062: an offer a
    // peer carried and nobody answered in 4 s goes once more through the hub, which a slow runner's
    // ICE gathering can outlast), and the hub relayed nothing more for the pair (its count lives in
    // memory, so a hibernating hub may have dropped the spawn's).
    const sa = await signals(a);
    const sc = await signals(c);
    expect(sa.hub - hubA, 'A sent only resends through the hub').toBe(sa.fallback - fallbackA);
    expect(sc.hub - hubC, 'C sent only resends through the hub').toBe(sc.fallback - fallbackC);
    expect(
      relaysOf(await directory(request, HUB), a.id, c.id),
      'the hub relayed nothing more for A and C but those resends',
    ).toBeLessThanOrEqual(hubBefore + (sa.fallback - fallbackA) + (sc.fallback - fallbackC));
    // Both still in the world where the test put them.
    const at = (await a.page.evaluate(() => (window.__bs as BsHook).state().player)) ?? null;
    expect(Math.abs((at?.x ?? 0) - (CENTRE - 1500))).toBeLessThan(200);
  } finally {
    await closeAll(players);
  }
});
