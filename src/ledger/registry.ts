// The rules registry (ADR 0055): which rules versions the live world holds, and for each one the
// version where each part of the rules last changed. Every check of a record, a birth, a genesis or
// a settlement answers a version through `rulesStatus`. Pure and shared: no DOM, no Node APIs.

/** The first rules version of the live world: the renewal of v0.12.0 retired every older one (ADRs 0040, 0055, 0061). */
export const FIRST_LIVE_RULES = 12;

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
    rules: 12,
    epoch: 4,
    since: Object.freeze({
      genesis: 12,
      inherit: 12,
      body: 12,
      life: 12,
      mating: 12,
      encounter: 12,
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
