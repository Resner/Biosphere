import { describe, expect, it } from 'vitest';
import { createRng, seedFromString } from '../sim/prng';
import { type HubMsg, type LifeInfo, type LifeMating, parseHubMsg } from './protocol';

// Protocol 14 (M14 T3, ADR 0076): a sign-in's `life` names a mating still waiting for its round.

const HEX = 'ab'.repeat(32);
const life: LifeInfo = {
  creature: HEX,
  seq: 3,
  genome: 'Ab-_09'.repeat(10),
  biomass: 1200,
  energy: 900,
  health: 800,
  activeMs: 60_000,
  lifespanMs: 3_600_000,
  matureAtMs: 600_000,
  cooldownUntilMs: 0,
};
const mating: LifeMating = { commit: 'cd'.repeat(32), round: 1_234_567, partner: 'Partner_9' };
const withMating = (m: unknown): string =>
  JSON.stringify({ t: 'life', life, genesisIn: 0, mating: m });

describe('life.mating', () => {
  it('round-trips', () => {
    const msg: HubMsg = { t: 'life', life, genesisIn: 0, mating };
    expect(parseHubMsg(JSON.stringify(msg))).toEqual(msg);
    // And beside the other things a sign-in names.
    const both: HubMsg = { t: 'life', life: null, genesisIn: 5, mating, renewed: true };
    expect(parseHubMsg(JSON.stringify(both))).toEqual(both);
  });

  it('refuses a missing partner, a bad round, an extra field and wrong types', () => {
    const { partner: _, ...noPartner } = mating;
    expect(parseHubMsg(withMating(noPartner))).toBeNull();
    expect(parseHubMsg(withMating({ ...mating, round: -1 }))).toBeNull();
    expect(parseHubMsg(withMating({ ...mating, round: 0 }))).toBeNull();
    expect(parseHubMsg(withMating({ ...mating, round: 1.5 }))).toBeNull();
    expect(parseHubMsg(withMating({ ...mating, extra: 1 }))).toBeNull();
    expect(parseHubMsg(withMating({ ...mating, commit: 'xyz' }))).toBeNull();
    expect(parseHubMsg(withMating({ ...mating, partner: 'a b' }))).toBeNull();
    expect(parseHubMsg(withMating(null))).toBeNull();
    expect(parseHubMsg(withMating([mating]))).toBeNull();
  });

  it('never throws on 10,000 fuzzed values, and parses only well-formed ones', () => {
    const rng = createRng(seedFromString('fuzz-life-mating'), 'net');
    const keys = ['commit', 'round', 'partner', 'extra', '__proto__'];
    const atoms = [HEX, 'Partner_9', 'x', '', -1, 0, 1, 1.5, 2 ** 32, null, true, [], {}];
    const value = (): unknown => {
      if (rng.int(0, 3) > 0) return atoms[rng.int(0, atoms.length - 1)];
      return Object.fromEntries(
        Array.from({ length: rng.int(0, 4) }, () => [
          keys[rng.int(0, keys.length - 1)],
          atoms[rng.int(0, atoms.length - 1)],
        ]),
      );
    };
    let parsed = 0;
    for (let n = 0; n < 10_000; n++) {
      const v = rng.int(0, 4) === 0 ? { ...mating, [keys[rng.int(0, 3)] as string]: value() } : value();
      const raw = withMating(v);
      let msg: HubMsg | null = null;
      expect(() => {
        msg = parseHubMsg(raw);
      }).not.toThrow();
      if (msg === null) continue;
      parsed++;
      const got = (msg as Extract<HubMsg, { t: 'life' }>).mating;
      expect(Object.keys(got ?? {}).sort()).toEqual(['commit', 'partner', 'round']);
      expect(got?.commit).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isInteger(got?.round) && (got?.round ?? 0) >= 1).toBe(true);
    }
    expect(parsed).toBeGreaterThan(0);
  });
});
