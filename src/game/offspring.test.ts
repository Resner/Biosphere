import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { genomeToBase64url } from '../genome/codec';
import { genesisGenome } from '../genome/genesis';
import type { Born } from '../net/protocol';
import { seedFromString } from '../sim/prng';
import { EGG_MS, OffspringFlow, VERIFY_BORN_FAILED } from './offspring';

let clock = 0;
let problems: string[];
let checked: Born[];
let flow: OffspringFlow;

const bornOf = (name: string): Born =>
  ({
    record: {
      hash: name.padEnd(64, '0'),
      record: { body: { generation: 2 } },
    },
    genome: genomeToBase64url(genesisGenome(seedFromString(name))),
  }) as unknown as Born;

beforeEach(() => {
  clock = 0;
  problems = [];
  checked = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  flow = new OffspringFlow({
    now: () => clock,
    verify: async (b) => {
      checked.push(b);
      return problems;
    },
  });
});
afterEach(() => vi.restoreAllMocks());

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('OffspringFlow', () => {
  it('checks a birth, shows an egg for three seconds, then the card', async () => {
    flow.receive({ t: 'born', ...bornOf('a') });
    expect(flow.view().kind).toBe('verifying');
    await settle();
    const view = flow.view();
    expect(view.kind).toBe('egg');
    expect(flow.child()?.generation).toBe(2);
    expect(flow.child()?.body.species).toBeTruthy();
    clock = EGG_MS - 1;
    flow.tick();
    expect(flow.view().kind).toBe('egg');
    clock = EGG_MS;
    flow.tick();
    expect(flow.view().kind).toBe('card');
  });

  it('keeps the egg closed when the check fails', async () => {
    problems = ['genome-mismatch'];
    flow.receive({ t: 'born', ...bornOf('a') });
    await settle();
    expect(flow.view()).toEqual({ kind: 'failed', message: VERIFY_BORN_FAILED });
    expect(flow.child()).toBeNull();
  });

  it('shows a child from a reload straight as a card, and does not restart on a reconnect', async () => {
    const b = bornOf('a');
    flow.receive({ t: 'life', life: null, genesisIn: 0, pending: b });
    await settle();
    expect(flow.view().kind).toBe('card');
    flow.receive({ t: 'life', life: null, genesisIn: 0, pending: b });
    expect(checked).toHaveLength(1);
    expect(flow.view().kind).toBe('card');
  });

  it('forgets the child once promoted or when the hub has none', async () => {
    flow.receive({ t: 'born', ...bornOf('a') });
    await settle();
    flow.receive({ t: 'promoted', life: {} as never, parent: null });
    expect(flow.view().kind).toBe('none');
    flow.receive({ t: 'born', ...bornOf('b') });
    await settle();
    flow.receive({ t: 'life', life: null, genesisIn: 0 });
    expect(flow.view().kind).toBe('none');
  });

  it('lets a late check lose to a newer message', async () => {
    flow.receive({ t: 'born', ...bornOf('a') });
    flow.receive({ t: 'promoted', life: {} as never, parent: null });
    await settle();
    expect(flow.view().kind).toBe('none');
  });

  it('"Later" hides the card without losing the child', async () => {
    flow.receive({ t: 'life', life: null, genesisIn: 0, pending: bornOf('a') });
    await settle();
    flow.postpone();
    const view = flow.view();
    expect(view.kind === 'card' && view.later).toBe(true);
    expect(flow.child()).not.toBeNull();
  });
});
