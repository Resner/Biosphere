// The hub's cost report (M13 T6, ADR 0067): what each kind of message costs the real object with
// 50, 200 and 500 sessions seated, measured by `worker/hub-cost.test.ts` in the local runtime.
// Pure: `tools/hub.mjs` runs the measuring test and hands its numbers here.

export interface HubCost {
  /** The seated sessions of each round: 50, 200, 500. */
  sessions: number[];
  /** Ms per message by type, one per size. */
  msPerMessage: Record<string, number[]>;
  /** One frame step of an authority-refereed duel (both inputs, the step and its notices), by size. */
  frameMs: number[];
  attachmentBytes: { median: number; p95: number; max: number };
  /** The runtime's clock resolution. */
  clockStepMs: number;
}

/** What a type's cost may grow to between the smallest and the largest size (ratio, plus a floor). */
export const GROWTH_RATIO = 1.5;
export const GROWTH_FLOOR_MS = 0.02;

const ms = (n: number) => n.toFixed(3);

/**
 * The most a type's largest size may cost, by its smallest. A `spawn` places the creature by
 * `place()`, which reads every member of the directory (ADR 0069 budgets it at 20 ms at 10,000
 * members), and is asked once per life: it may grow no faster than the members do. Every other
 * message costs the same whatever the population.
 */
export function budgetOf(type: string, small: number, sessions: number[]): number {
  const [first, last] = [sessions[0] ?? 1, sessions[sessions.length - 1] ?? 1];
  const ratio = type === 'spawn' ? last / first : GROWTH_RATIO;
  return ratio * small + GROWTH_FLOOR_MS + 1e-9;
}

/** Whether a type's costs (one per size) are within its budget. */
export const inBudget = (type: string, costs: number[], sessions: number[]): boolean =>
  (costs[costs.length - 1] ?? 0) <= budgetOf(type, costs[0] ?? 0, sessions);

/** The measurement with every time rounded to a thousandth of a millisecond, as the report prints it. */
export function rounded(m: HubCost): HubCost {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return {
    ...m,
    msPerMessage: Object.fromEntries(
      Object.entries(m.msPerMessage).map(([t, xs]) => [t, xs.map(r)]),
    ),
    frameMs: m.frameMs.map(r),
  };
}

/** What a `spawn` costs per 1,000 seated sessions (a straight line through the smallest and largest size), and at 10,000. */
export function spawnSlope(m: HubCost): { perThousand: number; at10k: number } | null {
  const xs = m.msPerMessage.spawn;
  const [n0, n1] = [m.sessions[0], m.sessions[m.sessions.length - 1]];
  if (!xs || n0 === undefined || n1 === undefined || n1 <= n0) return null;
  const perMember = Math.max(0, ((xs[xs.length - 1] ?? 0) - (xs[0] ?? 0)) / (n1 - n0));
  return { perThousand: perMember * 1000, at10k: (xs[0] ?? 0) + perMember * (10_000 - n0) };
}

function spawnNote(m: HubCost): string[] {
  const s = spawnSlope(m);
  if (!s) return [];
  return [
    '`spawn` is the one type that grows with the population, by design: `place()` reads every member of the',
    `directory (ADR 0069 budgets it at 20 ms in Node at 10,000 members), and a session asks once per life. Its budget is that it grows no faster than the members do. On a straight line it costs about ${s.perThousand.toFixed(1)} ms more per 1,000 seated, so about ${ms(s.at10k)} ms at 10,000 on the local runtime: the capacity model prices it.`,
    '',
  ];
}

/** `docs/perf/hub.md` for the measurement. */
export function hubReport(measured: HubCost): string {
  const m = rounded(measured);
  const rows: [string, number[]][] = [
    ...Object.entries(m.msPerMessage).sort(([x], [y]) => (x < y ? -1 : 1)),
    ['frame step (an authority-refereed duel)', m.frameMs],
  ];
  const over = rows.filter(([t, xs]) => !inBudget(t, xs, m.sessions));
  const out: string[] = [
    '# Hub cost report',
    '',
    'Reproduce with `npm run report:hub`, which runs `worker/hub-cost.test.ts` (a `speedTest`) and',
    'writes this file and `hub.json`.',
    '',
    'What each kind of message costs the real Durable Object (ADR 0067), with real sockets and a',
    `recorded creature seated in one populated area: ${m.sessions.join(', ')} sessions. A batch of 200 messages goes through the`,
    "object's own dispatch (`webSocketMessage`) inside the object and is timed on the local runtime's",
    `clock, which steps by ${m.clockStepMs} ms, so a batch of 200 resolves ${(m.clockStepMs / 200).toFixed(3)} ms per message; each figure is the median of 5`,
    "batches (a `spawn` is each session's first ask, a `batch` is every batch of a 300-frame witnessed duel, the frame step",
    "a 200-frame duel). **Production cannot measure this**: the deployed object's clocks stand still while",
    'code runs (ADR 0067), so these figures come from the local runtime and tell the shape, not the',
    "price of a message on Cloudflare's hardware.",
    '',
    '## Milliseconds per message',
    '',
    `| Message | ${m.sessions.map((n) => `${n} seated`).join(' | ')} | 500 against 50 |`,
    `|---|${m.sessions.map(() => '---|').join('')}---|`,
    ...rows.map(([t, xs]) => {
      const first = xs[0] ?? 0;
      const last = xs[xs.length - 1] ?? 0;
      const ratio = first > 0 ? `${(last / first).toFixed(2)}x` : 'n/a';
      return `| ${t} | ${xs.map(ms).join(' | ')} | ${ratio}${inBudget(t, xs, m.sessions) ? '' : ' (over the budget)'} |`;
    }),
    '',
    `The budget (the \`speedTest\`): each type at the largest size at most ${GROWTH_RATIO} times its cost at the smallest, plus ${GROWTH_FLOOR_MS} ms; a \`spawn\`, which reads every member, at most ${m.sessions.length > 1 ? (m.sessions[m.sessions.length - 1] ?? 1) / (m.sessions[0] ?? 1) : 1} times.`,
    '',
    '## Attachment sizes',
    '',
    'Each seated session keeps its state in its socket attachment, as JSON (the limit is 2 KB).',
    '',
    '| Median | p95 | Max |',
    '|---|---|---|',
    `| ${m.attachmentBytes.median} B | ${m.attachmentBytes.p95} B | ${m.attachmentBytes.max} B |`,
    '',
    ...spawnNote(m),
    over.length === 0
      ? 'Every type stays within its budget.'
      : `Over the budget: ${over.map(([t]) => t).join(', ')}.`,
    '',
  ];
  return out.join('\n');
}
