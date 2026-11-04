// The rules registry (ADR 0055): which rules versions the live world holds, and for each one the
// version where each part of the rules last changed. Every check of a record, a birth, a genesis or
// a settlement answers a version through `rulesStatus`. Pure and shared: no DOM, no Node APIs.

/** The first rules version of the live world: the renewal of v0.10.0 retired every older one (ADR 0040). */
export const FIRST_LIVE_RULES = 11;

export type RulesPart = 'genesis' | 'inherit' | 'body' | 'life' | 'mating' | 'encounter';

export interface RulesEntry {
  rules: number;
  /** The world epoch that version runs in. */
  epoch: number;
  /** For each part, the version where it last changed: a later bump keeps an older part's history checkable. */
  since: Readonly<Record<RulesPart, number>>;
}

/**
 * One entry per live version, oldest first. A rules bump without a world renewal adds one; a bump
 * that changes a part recorded history depends on must also keep that part's older code (none yet).
 */
export const REGISTRY: readonly RulesEntry[] = Object.freeze([
  Object.freeze({
    rules: 11,
    epoch: 3,
    since: Object.freeze({
      genesis: 11,
      inherit: 11,
      body: 11,
      life: 11,
      mating: 11,
      encounter: 11,
    }),
  }),
]);

/**
 * `live` for a version the registry holds, `retired` for one a world renewal retired, `unknown`
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
