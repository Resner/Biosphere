import { describe, expect, it } from 'vitest';
import { RULES_VERSION } from '../sim/rules';
import { FIRST_LIVE_RULES, REGISTRY, type RulesPart, rulesProblem, rulesStatus } from './registry';

// ADR 0055: one entry per live rules version, and every check answers through `rulesStatus`.

const PARTS: RulesPart[] = ['genesis', 'inherit', 'body', 'life', 'mating', 'encounter'];

describe('the rules registry', () => {
  it('starts the live world at rules 12', () => {
    expect(FIRST_LIVE_RULES).toBe(12);
    expect(REGISTRY).toEqual([
      {
        rules: 12,
        epoch: 4,
        since: { genesis: 12, inherit: 12, body: 12, life: 12, mating: 12, encounter: 12 },
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
    expect(rulesStatus(11)).toBe('retired');
    expect(rulesStatus(0)).toBe('retired');
    expect(rulesStatus(12)).toBe('live');
    expect(rulesStatus(13)).toBe('unknown');
    for (const junk of [Number.NaN, 12.5, -1, Number.POSITIVE_INFINITY]) {
      expect(rulesStatus(junk), String(junk)).not.toBe('live');
    }
  });

  it('turns a status into the problem a check names', () => {
    expect(rulesProblem(11)).toBe('rules-retired');
    expect(rulesProblem(12)).toBeNull();
    expect(rulesProblem(13)).toBe('rules-unknown');
  });
});
