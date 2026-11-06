import { describe, expect, it } from 'vitest';
import type { SignedSnap } from '../src/net/protocol';
import { RULES } from '../src/sim/rules';
import {
  advance,
  authority,
  engage,
  lockIn,
  NEAR,
  type Player,
  pair,
  pondTick,
  snap,
  useFightHub,
} from './fight-test-kit';
import { AFTER_FIGHT_MS } from './movement';
import { nextOf, sql } from './test-hub';

// M10 T11 (ADR 0059): the movement check at lock-in. The target's answer carries the attacker's
// own signed snapshots it held (`seen`); a jump between neighbours refuses the engage.

useFightHub();

/** Engages, answers the ask with the target's own state and `seen`, and returns the attacker's next word. */
async function answered(a: Player, b: Player, seen: SignedSnap[], mine = snap(a, ...NEAR.a)) {
  engage(a, b, undefined, mine);
  const ask = await nextOf(b.c, 'lock-ask');
  expect(ask.by).toBe(a.id.playerId);
  b.c.send({ t: 'lock-state', lock: ask.lock, mine: snap(b, ...NEAR.b), seen });
  for (;;) {
    const word = await a.c.next();
    if (word.t === 'refused') return word.reason;
    if (word.t === 'enc-start') return word.t;
  }
}

const teleports = async (p: Player) =>
  (
    await sql<{ n: number }>(
      "SELECT COUNT(*) AS n FROM flags WHERE kind = 'teleport' AND creature = ?",
      p.creature,
    )
  )[0]?.n;

const locked = (p: Player) => authority((o) => o.fights.playerLocked(p.id.playerId));

/** `p`'s snapshot `back` ticks ago at (x, 1000). */
const ago = (p: Player, back: number, x: number, over = {}) =>
  snap(p, x, 1000, { tick: pondTick(p) - back, ...over });

describe('the movement check at lock-in', () => {
  it('refuses a 200 wu jump between two seen snapshots 200 ms apart, and flags teleport once', async () => {
    const [a, b] = await pair();
    const jump = () => [ago(a, 12, 800), ago(a, 6, 1000)];
    expect(await answered(a, b, jump())).toBe('engage:moved');
    // The target is released with the attacker, and neither is in a fight.
    expect(await locked(a)).toBe(false);
    expect(await locked(b)).toBe(false);
    expect(await teleports(a)).toBe(1);
    await advance(500);
    expect(await answered(a, b, jump())).toBe('engage:moved');
    await advance(500);
    expect(await answered(a, b, jump())).toBe('engage:moved');
    expect(await teleports(a)).toBe(1);
  });

  it('refuses an engage snapshot 150 wu from the newest seen one 100 ms before it', async () => {
    const [a, b] = await pair();
    expect(await answered(a, b, [ago(a, 6, 840), ago(a, 3, 850)])).toBe('engage:moved');
    expect(await teleports(a)).toBe(1);
  });

  it('starts the fight when the seen path is one the attacker could swim', async () => {
    const [a, b] = await pair();
    const swum = [ago(a, 15, 970), ago(a, 9, 980), ago(a, 3, 995)];
    expect(await answered(a, b, swum)).toBe('enc-start');
    expect(await teleports(a)).toBe(0);
  });

  it('ignores a forged seen snapshot, and one of another creature or player', async () => {
    const [a, b] = await pair();
    const far = ago(a, 6, 200);
    const flipped = far.sig.startsWith('A') ? `B${far.sig.slice(1)}` : `A${far.sig.slice(1)}`;
    const forged = { ...far, sig: flipped };
    const otherGenome = ago(a, 6, 200, { genomeRef: (a.ref + 1) & 0xffff });
    const otherPlayer = ago(b, 6, 200);
    const dead = ago(a, 6, 200, { alive: false });
    const seen = [forged, otherGenome, otherPlayer, dead, ago(a, 3, 995)];
    expect(await answered(a, b, seen)).toBe('enc-start');
    expect(await teleports(a)).toBe(0);
  });

  it('leaves an answer without seen on the M7 path', async () => {
    const [a, b] = await pair();
    engage(a, b);
    const ask = await nextOf(b.c, 'lock-ask');
    b.c.send({ t: 'lock-state', lock: ask.lock, mine: snap(b, ...NEAR.b) });
    await Promise.all([nextOf(a.c, 'enc-start'), nextOf(b.c, 'enc-start')]);
  });

  it('does not check an attacker fresh out of a fight, whose fight moved it', async () => {
    const [a, b] = await pair();
    await lockIn(a, b);
    const end = () =>
      authority((o) => {
        const lock = o.fights.ofPlayer(a.id.playerId);
        if (lock) o.fights.release(lock.id);
      });
    await end();
    // A new encounter id: it hashes the heads with the time.
    await advance(10);
    const jump = () => [ago(a, 12, 800), ago(a, 6, 1000)];
    expect(await answered(a, b, jump())).toBe('enc-start');
    await end();
    await advance(AFTER_FIGHT_MS + 1);
    expect(await answered(a, b, jump())).toBe('engage:moved');
    expect(AFTER_FIGHT_MS).toBeGreaterThan(2000 + RULES.encounter.lockAnswerMs);
  });
});
