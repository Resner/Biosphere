import { describe, expect, it } from 'vitest';
import { RULES_VERSION } from '../sim/rules';
import { FIRST_LIVE_RULES, REGISTRY, type RulesPart, rulesProblem, rulesStatus } from './registry';

// ADR 0055: one entry per live rules version, and every check answers through `rulesStatus`.

const PARTS: RulesPart[] = ['genesis', 'inherit', 'body', 'life', 'mating', 'encounter'];

describe('the rules registry', () => {
  it('starts the live world at rules 11', () => {
    expect(FIRST_LIVE_RULES).toBe(11);
    expect(REGISTRY).toEqual([
      {
        rules: 11,
        epoch: 3,
        since: { genesis: 11, inherit: 11, body: 11, life: 11, mating: 11, encounter: 11 },
      },
    ]);
  });

  it('has an entry for this build’s rules version', () => {
    expect(REGISTRY.some((e) => e.rules === RULES_VERSION)).toBe(true);
  });

  it('names no part as changed after the entry’s own version, nor before the first live one', () => {
    for (const entry of REGISTRY) {
      expect(Object.keys(entry.since).sort()).toEqual([...PARTS].sort());
      for (const part of PARTS) {
        expect(entry.since[part], `${entry.rules} ${part}`).toBeLessThanOrEqual(entry.rules);
        expect(entry.since[part], `${entry.rules} ${part}`).toBeGreaterThanOrEqual(
          FIRST_LIVE_RULES,
        );
      }
    }
  });

  it('lists each version once, in order, with epochs that never go back', () => {
    for (let i = 1; i < REGISTRY.length; i++) {
      const [a, b] = [REGISTRY[i - 1], REGISTRY[i]];
      expect(b?.rules).toBeGreaterThan(a?.rules ?? 0);
      expect(b?.epoch).toBeGreaterThanOrEqual(a?.epoch ?? 0);
    }
  });

  it('answers retired below the first live version, live for an entry and unknown past them', () => {
    expect(rulesStatus(10)).toBe('retired');
    expect(rulesStatus(0)).toBe('retired');
    expect(rulesStatus(11)).toBe('live');
    expect(rulesStatus(12)).toBe('unknown');
    for (const junk of [Number.NaN, 11.5, -1, Number.POSITIVE_INFINITY]) {
      expect(rulesStatus(junk), String(junk)).not.toBe('live');
    }
  });

  it('turns a status into the problem a check names', () => {
    expect(rulesProblem(10)).toBe('rules-retired');
    expect(rulesProblem(11)).toBeNull();
    expect(rulesProblem(12)).toBe('rules-unknown');
  });
});
