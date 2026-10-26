// Input logs and deterministic replay (ADR 0005): a seed, a spawn and run-length-coded inputs
// reproduce a world bit for bit in Node, workerd and every browser.

import { isPhysShape, type PhysStats } from './body';
import { decodeInput, encodeInput, IDLE, type Input } from './input';
import { RULES_VERSION } from './rules';
import { hashWorld } from './state-hash';
import { step } from './step';
import type { World } from './types';
import { createWorld, spawnCreature } from './world';

/** `runs[i] = [tick, code]`: from `tick` on, the creature holds the u16 input `code`. */
export type InputRun = readonly [tick: number, input: number];

export interface InputLog {
  rules: number;
  seed: string;
  spawn: { id: string; x: number; y: number; phys?: PhysStats };
  ticks: number;
  /** Strictly ascending ticks in [0, ticks). Before the first run the creature idles. */
  runs: InputRun[];
}

export interface ReplayResult {
  hash: string;
  world: World;
  /** How many events of each type the replay emitted. */
  events: Record<string, number>;
}

/** Run-length encodes one input per tick; a run starts wherever the encoded input changes. */
export function recordInputs(inputs: readonly Input[]): InputLog['runs'] {
  const runs: InputRun[] = [];
  let last = -1;
  for (let tick = 0; tick < inputs.length; tick++) {
    const code = encodeInput(inputs[tick] as Input);
    if (code === last) continue;
    runs.push([tick, code]);
    last = code;
  }
  return runs;
}

/** The inverse of `recordInputs` for a log of `ticks` ticks. */
export function expandRuns(runs: InputLog['runs'], ticks: number): Input[] {
  const inputs: Input[] = [];
  let next = 0;
  let current: Input = IDLE;
  for (let tick = 0; tick < ticks; tick++) {
    const run = runs[next];
    if (run !== undefined && run[0] === tick) {
      current = decodeInput(run[1]);
      next++;
    }
    inputs.push(current);
  }
  return inputs;
}

function validate(log: InputLog): void {
  if (log.rules !== RULES_VERSION)
    throw new Error(`log is for rules v${log.rules}, this build runs v${RULES_VERSION}`);
  if (log.spawn.phys !== undefined && !isPhysShape(log.spawn.phys))
    throw new RangeError('spawn.phys is not a body');
  if (!Number.isInteger(log.ticks) || log.ticks < 0) throw new RangeError('bad tick count');
  let previous = -1;
  for (const [tick, code] of log.runs) {
    if (!Number.isInteger(tick) || tick <= previous || tick >= log.ticks)
      throw new RangeError(`run at tick ${tick} is out of order or out of range`);
    if (!Number.isInteger(code) || code < 0 || code > 0xffff)
      throw new RangeError(`run input ${code} is not a u16`);
    previous = tick;
  }
}

/** Re-runs a log from its seed and spawn, and returns the final state hash. */
export function replay(log: InputLog): ReplayResult {
  validate(log);
  const world = createWorld({ seed: log.seed });
  spawnCreature(world, log.spawn);
  const events: Record<string, number> = {};
  let next = 0;
  let input: Input = IDLE;
  for (let tick = 0; tick < log.ticks; tick++) {
    const run = log.runs[next];
    if (run !== undefined && run[0] === tick) {
      input = decodeInput(run[1]);
      next++;
    }
    for (const event of step(world, { [log.spawn.id]: input }))
      events[event.type] = (events[event.type] ?? 0) + 1;
  }
  return { hash: hashWorld(world), world, events };
}
