// The rules registry (ADR 0055): which rules versions the live world holds, and for each one the
// version where each part of the rules last changed. Every check of a record, a birth, a genesis or
// a settlement answers a version through `rulesStatus`. Pure and shared: no DOM, no Node APIs.

/**
 * The first rules version of the permanent world: the last renewal, of v1.0.0, retired every older
 * one (ADRs 0040, 0055, 0061, 0074). From v1.0.0 nothing is retired again: a rules bump adds an
 * entry and keeps the older parts' code.
 */
export const FIRST_LIVE_RULES = 13;

export type RulesPart = 'genesis' | 'inherit' | 'body' | 'life' | 'mating' | 'encounter';

export interface RulesEntry {
  rules: number;
  /** The world epoch that version runs in. */
  epoch: number;
  /** For each part, the version where it last changed: a later bump keeps an older part's history checkable. */
  since: Readonly<Record<RulesPart, number>>;
}

/**
 * One entry per live version, oldest first. A rules bump adds one in the same epoch; a bump that
 * changes a part recorded history depends on must also keep that part's older code (none yet).
 */
export const REGISTRY: readonly RulesEntry[] = Object.freeze([
  Object.freeze({
    rules: 13,
    epoch: 5,
    since: Object.freeze({
      genesis: 13,
      inherit: 13,
      body: 13,
      life: 13,
      mating: 13,
      encounter: 13,
    }),
  }),
]);

/**
 * Each released rules version → the SHA-256 of its entry in `__golden__/frozen.json` (`entryHash`
 * in `frozen.ts`, ADR 0074): a released version's goldens never change. Rules 13 is v1.0.0's,
 * pinned by the last change of M14 (T18); a later rules version adds its own pin and never edits this one.
 */
export const RELEASED: Readonly<Record<number, string>> = Object.freeze({
  13: '974c66d48d4d10ac08212be0ceab1c6d4511344c97e975b7d662df34cc61fed6',
});

/**
 * `live` for a version the registry holds, `retired` for one before the permanent world (rules 12
 * or older, retired by a world renewal), `unknown`
 * for anything else (a newer build's version: the checker must be updated). Never throws.
 */
export function rulesStatus(rules: number): 'live' | 'retired' | 'unknown' {
  if (REGISTRY.some((entry) => entry.rules === rules)) return 'live';
  return Number.isSafeInteger(rules) && rules < FIRST_LIVE_RULES ? 'retired' : 'unknown';
}

/** The problem a check names for a version that is not live (`rules-retired`, `rules-unknown`), or null. */
export function rulesProblem(rules: number): 'rules-retired' | 'rules-unknown' | null {
  const status = rulesStatus(rules);
  return status === 'live' ? null : `rules-${status}`;
}
