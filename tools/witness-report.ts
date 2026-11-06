// The witness cost report (M10 T14, ADR 0058): what a witnessed fight costs the authority in
// incoming messages, measured in a hub test (`worker/witness-cost.test.ts`) and extended to other
// lengths, handover delays and a melee by the model below. Pure: `tools/witness.mjs` runs the test
// and hands its numbers here. M13's capacity model uses these cuts.
import { BATCH_FRAMES, HANDOVER_AHEAD, handoverFrame } from '../src/net/handover';
import { FRAME_MS } from '../src/net/referee';

/** What `worker/witness-cost.test.ts` prints as `WITNESS_MEASURE` (and `WITNESS_CPU`). */
export interface WitnessMeasure {
  frames: number;
  /** The first frame the witness refereed. */
  from: number;
  /** Incoming messages by type before the span (inputs, the duty's 4 signals, `duty-ok`), during it and after the fight (the audit). */
  before: Record<string, number>;
  span: Record<string, number>;
  after: Record<string, number>;
  /** The same fight without a witness: before and during the span. */
  aloneBefore: Record<string, number>;
  aloneSpan: Record<string, number>;
  handoverMs: number;
  /** Median CPU of one batch's signature checks in workerd, ms. */
  batchMs: number;
}

/** The fixed budget the cut must meet at a 30 s duel, and per participant-second (ADR 0058). */
export const DUEL_CUT = 4;
export const SPAN_CUT = 10;

export const DELAYS_S = [2, 3, 4] as const;
export const SCENARIOS: { name: string; seconds: number; fighters: number }[] = [
  { name: 'duel, 6 s', seconds: 6, fighters: 2 },
  { name: 'duel, 10.4 s (median genesis duel)', seconds: 10.4, fighters: 2 },
  { name: 'duel, 17.2 s', seconds: 17.2, fighters: 2 },
  { name: 'duel, 30 s', seconds: 30, fighters: 2 },
  { name: 'duel, 90 s (the timeout)', seconds: 90, fighters: 2 },
  { name: 'melee of 4, 30 s', seconds: 30, fighters: 4 },
];

/** The authority's incoming messages for a fight of `seconds` with `fighters` fighters. */
export function cost(seconds: number, fighters: number, delayS: number) {
  const frames = Math.round((seconds * 1000) / FRAME_MS);
  const alone = fighters * frames;
  const handFrom = handoverFrame(Math.round((delayS * 1000) / FRAME_MS));
  // A fight over before the handover is refereed by the authority alone.
  if (frames <= handFrom) return { alone, witnessed: alone, handFrom: frames, span: 0, batches: 0 };
  const span = frames - handFrom;
  const batches = Math.ceil(span / BATCH_FRAMES);
  // Inputs to the authority before the handover, a signal each way on each fighter's link,
  // `duty-ok`, the batches, and the auditor's `duty-ok` and `attest`.
  const witnessed = fighters * handFrom + 2 * fighters + 1 + batches + 2;
  return { alone, witnessed, handFrom, span, batches };
}

const times = (n: number) => `${n.toFixed(1)}×`;

/** The measured fight as the model prices it: must agree with what the hub counted. */
export function modelOfMeasure(m: WitnessMeasure) {
  return cost((m.frames * FRAME_MS) / 1000, 2, m.handoverMs / 1000);
}

export const total = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);

/** `docs/perf/witness.md` for the measurement. */
export function witnessReport(m: WitnessMeasure): string {
  const measuredWith = total(m.before) + total(m.span) + total(m.after);
  const delayS = m.handoverMs / 1000;
  // Inputs a fighter sends each second, and the first duel length (to 0.1 s) whose cut is at the guard.
  const perSecond = 1000 / FRAME_MS;
  let reaches = 0.1;
  while (cost(reaches, 2, delayS).alone < DUEL_CUT * cost(reaches, 2, delayS).witnessed) {
    reaches = Math.round((reaches + 0.1) * 10) / 10;
  }
  const ms5 = Math.max(5, Math.ceil(m.batchMs / 5) * 5);
  const out: string[] = [
    '# Witness cost report',
    '',
    'Reproduce with `npm run report:witness`. The authority is charged for incoming WebSocket messages',
    '(ADR 0008), so this counts those, and nothing it sends. `worker/witness-cost.test.ts` plays a hunt',
    `of about 30 s (${(30 * 1000) / FRAME_MS} frames) in a hub test on the hand clock, once refereed by the authority alone and`,
    `once by a scripted witness that takes the duty ${m.handoverMs / 1000} s after the lock-in; the table prices other lengths with the`,
    'same model, which `tools/witness-report.test.ts` checks against what the hub counted.',
    '',
    `## Measured: a 30 s duel, the witness taking over at ${m.handoverMs / 1000} s`,
    '',
    '| | Authority alone | With a witness |',
    '|---|---|---|',
    `| Inputs before the handover (frame ${m.from}) | ${m.aloneBefore.input ?? 0} | ${m.before.input ?? 0} |`,
    `| Signals relayed for the duty links | 0 | ${m.before.signal ?? 0} |`,
    `| The witness's \`duty-ok\` | 0 | ${m.before['duty-ok'] ?? 0} |`,
    `| Inputs from the handover on, or the witness's batches | ${2 * perSecond} a second | ${perSecond / BATCH_FRAMES} a second |`,
    `| The auditor's \`duty-ok\` and \`attest\` | 0 | ${(m.after['duty-ok'] ?? 0) + (m.after.attest ?? 0)} |`,
    '',
    `The cut over the whole duel is ${times(cost(30, 2, m.handoverMs / 1000).alone / measuredWith)}`,
    `(guard: at least ${DUEL_CUT}×). From the handover on the authority hears the batches and nothing else; per participant-second`,
    `the cut is at least ${SPAN_CUT}× (guard), ${perSecond} inputs against ${perSecond / BATCH_FRAMES / 2} batches.`,
    '',
    '## The model, by length and handover delay',
    '',
    'A fight of `N` frames with `F` fighters costs the authority alone `F × N` inputs. With a witness it costs',
    `\`F × h\` inputs before the handover frame \`h\` (the delay plus ${HANDOVER_AHEAD} frames), \`2F\` signals, one \`duty-ok\`, one batch`,
    `per ${BATCH_FRAMES} frames after \`h\`, and the auditor's 2 messages. A fight over before \`h\` is the authority's alone.`,
    '',
    `| Fight | ${DELAYS_S.map((d) => `Alone | Witnessed (${d} s) | Cut (${d} s)`).join(' | ')} |`,
    `|---|${DELAYS_S.map(() => '---|---|---|').join('')}`,
    ...SCENARIOS.map((s) => {
      const cells = DELAYS_S.map((d) => {
        const c = cost(s.seconds, s.fighters, d);
        return `${c.alone} | ${c.witnessed} | ${times(c.alone / c.witnessed)}`;
      });
      return `| ${s.name} | ${cells.join(' | ')} |`;
    }),
    '',
    "Short fights save little: the opening, before the round resolves and a link is up, is the authority's",
    `(ADR 0058). At the measured ${delayS} s delay a duel's cut reaches ${DUEL_CUT}× from about ${reaches} s, and a melee saves more, since each fighter's inputs stop reaching the authority.`,
    '',
    '## CPU',
    '',
    `A batch of 10 frames of two fighters carries 20 input signatures; the authority checks each against its fighter's key`,
    `(\`worker/witness-cost.test.ts\`, workerd): at most ${ms5} ms per batch (guard: under 10 ms), one batch a second per witnessed fight.`,
    'The authority alone checks none: inputs on its own sockets are authenticated by the session.',
    '',
    '## Storage',
    '',
    'A witness commitment (kept 14 days) and an attestation (kept for good) are in `docs/perf/storage.md`.',
    '',
  ];
  return out.join('\n');
}
