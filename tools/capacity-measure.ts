// The capacity model's inputs (M13 T8): the committed measurements in `docs/perf/` folded into the
// per-player numbers `MEASURED` (`worker/plan.ts`) holds. Pure: `tools/capacity-report.ts` and the
// drift test call it with the parsed JSON files.
import { BATCH_FRAMES } from '../src/net/handover';
import type { Measured, PageCadence } from '../worker/capacity';
import type { HubCost } from './hub-report';
import { figuresOf, type HubLoad } from './load-hub-report';
import { DUEL_FRAMES, model, type StorageMeasure, snapped } from './storage-report';
import { cost, type WitnessMeasure } from './witness-report';

/** What `load.json` holds of the in-process simulation that the model reads. */
export interface LoadInput {
  holdSeries: { players: number; mean: number }[];
  heapBytes: number | null;
  heapMembers: number;
  uploadKBps: { mean: number };
  downloadKBps: { mean: number };
}

export interface CapacityInputs {
  load: LoadInput;
  hub: HubCost;
  hubLoad: HubLoad;
  storage: StorageMeasure;
  witness: WitnessMeasure;
}

/** Four significant digits, so a committed number is stable and readable. */
export const sig4 = (n: number): number => (n === 0 ? 0 : Number(n.toPrecision(4)));

/** Rows a fight writes: its row, final seal, two records, a prune, a witness commitment and an attestation, and one row per batch. */
export const FIGHT_FIXED_ROWS = 7;

/**
 * Rows a genesis hatch, a mating and a promotion write (M14 T14d): the soak's rows per player-hour
 * found matings and promotions missing from the model, and the soak prices its hatches with the
 * first. `worker/lifecycle-rows.test.ts` holds each number to the hub.
 */
export const LIFECYCLE_ROWS = { hatch: 12, mating: 20, promote: 5 } as const;

export function measuredFrom(inputs: CapacityInputs): Measured {
  const i = { ...inputs, storage: snapped(inputs.storage) };
  const figures = figuresOf(i.hubLoad);
  const meter = (type: string) =>
    figures.messagesPerMinute.find((m) => m.type === type)?.meter ?? 0;
  const page: PageCadence = {
    where: sig4(meter('where')),
    progress: sig4(meter('progress')),
    ping: sig4(meter('ping')),
    signal: sig4(meter('signal')),
    avail: sig4(meter('avail')),
    total: sig4(figures.totalPerMinute.meter ?? 0),
  };
  // The hold's mean of world messages, weighted by the players in each minute.
  const players = i.load.holdSeries.reduce((s, r) => s + r.players, 0);
  const world = i.load.holdSeries.reduce((s, r) => s + r.mean * r.players, 0) / players;
  const duel = cost(DUEL_FRAMES / 10, 2, i.witness.handoverMs / 1000);
  const entered = i.hubLoad.entered;
  const fightRows = FIGHT_FIXED_ROWS + Math.ceil(DUEL_FRAMES / BATCH_FRAMES);
  const stored = model(i.storage, 1);
  return {
    world: sig4(world),
    page,
    fight: { frames: DUEL_FRAMES, alone: duel.alone, witnessed: duel.witnessed },
    session: {
      // A session's close: the checkpoint and the place it left. The hold writes nothing.
      rowsWritten: sig4((i.hubLoad.end.rowsWritten - i.hubLoad.holdEnd.rowsWritten) / entered),
      // Joining reads the identity, its creature and its chain; leaving reads them again.
      rowsRead: sig4((i.hubLoad.end.rowsRead - i.hubLoad.start.rowsRead) / entered),
    },
    fightRows: { written: fightRows, read: fightRows },
    lifecycle: { mating: LIFECYCLE_ROWS.mating, promote: LIFECYCLE_ROWS.promote },
    cpuMsPerMessage: sig4(figures.cpuMsPerMessage ?? 0),
    clientKBps: sig4(i.load.downloadKBps.mean),
    memoryBytesPerSession: Math.ceil(
      i.hub.attachmentBytes.p95 + (i.load.heapBytes ?? 0) / Math.max(1, i.load.heapMembers),
    ),
    bytes: {
      hour: i.storage.hourBytes,
      hatch: i.storage.hatchBytes,
      settled: i.storage.fight.prunedBytes + i.storage.witness.attestBytes,
      logged: stored.logBytes + i.storage.witness.commitBytes,
    },
  };
}

/** `MEASURED`'s members as the TypeScript `worker/plan.ts` holds between its markers. */
export function measuredSource(m: Measured): string {
  const obj = (o: Record<string, number>) =>
    `{ ${Object.entries(o)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ')} }`;
  return [
    `  world: ${m.world},`,
    `  page: ${obj({ ...m.page })},`,
    `  fight: ${obj({ ...m.fight })},`,
    `  session: ${obj({ ...m.session })},`,
    `  fightRows: ${obj({ ...m.fightRows })},`,
    `  lifecycle: ${obj({ ...m.lifecycle })},`,
    `  cpuMsPerMessage: ${m.cpuMsPerMessage},`,
    `  clientKBps: ${m.clientKBps},`,
    `  memoryBytesPerSession: ${m.memoryBytesPerSession},`,
    `  bytes: ${obj({ ...m.bytes })},`,
    '',
  ].join('\n');
}
