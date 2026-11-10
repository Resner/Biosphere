import { describe, expect, it } from 'vitest';
import {
  checksOf,
  cpuPerMessage,
  type FullSeries,
  failures,
  type HubSample,
  modelOf,
  type PageSample,
  playedMix,
  reportOf,
  slopePerHour,
} from './soak-report';
import type { Soak } from './soak-run';

const MINUTES = 60;

/** A healthy hour: memory and CPU per message level, two pages level, everything seated. */
function healthy(): Soak {
  const hub: HubSample[] = [];
  for (let minute = 1; minute <= MINUTES; minute++) {
    hub.push({
      minute,
      cpuMs: minute * 6_000,
      rssBytes: 400_000_000 + (minute % 3) * 1_000_000,
      messages: minute * 12_000,
      seated: 200,
      queued: 0,
      consistent: minute % 5 === 0 ? { kinds: {}, first: [] } : null,
      flags: { 'authority-only': 4 },
    });
  }
  const pages: PageSample[] = [];
  for (const page of [1, 2]) {
    for (let minute = 1; minute <= MINUTES; minute++) {
      pages.push({
        page,
        minute,
        heapBytes: 60_000_000 + (minute % 2) * 500_000,
        geometries: 120,
        textures: 40,
        programs: 12,
        frameP95Ms: 90 + (minute % 4),
      });
    }
  }
  const full: FullSeries = {
    hub,
    pages,
    pageLives: [1, 2].map((page) => ({
      page,
      hatches: 2,
      reloads: [30],
      courts: 1,
      errors: [],
    })),
    perPlayer: { messagesPerMinute: 12, rowsWrittenPerHour: 20 },
    pagesVerified: { checked: 4, problems: [] },
  };
  return {
    config: { clients: 200, minutes: MINUTES },
    entered: 200,
    failures: [],
    totals: { matings: 90, births: 180, fights: 40, kills: 12, restores: 30, drops: 25 },
    closes: {},
    refused: {},
    deaths: {},
    notReady: {},
    dropped: {},
    flags: { 'authority-only': 4 },
    inconsistencies: [],
    verified: { checked: 50, problems: [] },
    full,
  };
}

const failed = (run: Soak): string[] =>
  checksOf(run)
    .filter((c) => !c.ok)
    .map((c) => c.name);

describe('the soak checks', () => {
  it('pass a healthy hour', () => {
    expect(failed(healthy())).toEqual([]);
    expect(failures(healthy())).toEqual([]);
  });

  it('fail a rising memory slope', () => {
    const run = healthy();
    for (const s of run.full?.hub ?? []) s.rssBytes = 400_000_000 + s.minute * 1_000_000;
    // 60 MB an hour against a limit of 20.
    expect(failed(run)).toEqual(['authority memory level']);
  });

  it('fail CPU per message that grows', () => {
    const run = healthy();
    for (const s of run.full?.hub ?? []) {
      s.cpuMs = s.minute <= 40 ? s.minute * 6_000 : 240_000 + (s.minute - 40) * 30_000;
    }
    expect(failed(run)).toEqual(['authority CPU per message level']);
  });

  it('fail a page whose heap climbs or whose frames slow down', () => {
    const run = healthy();
    for (const p of run.full?.pages ?? []) {
      if (p.page === 2) p.heapBytes = 60_000_000 + p.minute * 1_000_000;
      if (p.page === 1 && p.minute > 30) p.frameP95Ms = 200;
    }
    expect(failed(run)).toEqual(['page 1 frame time level', 'page 2 heap level']);
  });

  it('fail resources that grow, a line, an inconsistency and a flag', () => {
    const run = healthy();
    const hub = run.full?.hub ?? [];
    for (const p of run.full?.pages ?? []) if (p.page === 1 && p.minute > 40) p.textures = 41;
    if (hub[20]) hub[20].queued = 3;
    if (hub[29]) hub[29].consistent = { kinds: { ashore: 1 }, first: ['ashore: anchored'] };
    if (hub[40]) hub[40].flags = { 'authority-only': 4, implausible: 1 };
    expect(failed(run)).toEqual([
      'consistent empty at every sample',
      'no audit flag at any sample',
      'nobody waited in line',
      'page 1 renderer resources do not grow',
    ]);
  });

  it('fail players that cost more than measured', () => {
    const run = healthy();
    if (run.full) run.full.perPlayer = { messagesPerMinute: 200, rowsWrittenPerHour: 900 };
    expect(failed(run)).toEqual(['messages per player-minute', 'rows written per player-hour']);
  });

  it('judge rows and messages against the model at the mix the clients played', () => {
    const run = healthy();
    run.playerHours = 180;
    if (run.full) run.full.perPlayer = { messagesPerMinute: 14, rowsWrittenPerHour: 20 };
    const mix = playedMix(run);
    // 225 sign-ins, 40 fights, 90 matings, 30 restores and no hatches over 180 player-hours.
    expect(mix).toMatchObject({ fights: 40 / 180, matings: 90 / 180, hatches: 0 });
    expect(mix?.sessions).toBeCloseTo(225 / 180);
    if (!mix) throw new Error('no mix');
    const model = modelOf(mix);
    // Sessions, four checkpoints, half a fight's, a mating's and a restore's rows: a few a player-hour.
    expect(model.rowsPerHour).toBeGreaterThan(8);
    expect(model.rowsPerHour).toBeLessThan(20);
    expect(failed(run)).toEqual([]);
    // Rows over 1.5 times the model's fail, and name the mix.
    if (run.full) run.full.perPlayer.rowsWrittenPerHour = 1.6 * model.rowsPerHour;
    expect(failed(run)).toEqual(['rows written per player-hour']);
    const detail = checksOf(run).find((c) => c.name === 'rows written per player-hour')?.detail;
    expect(detail).toContain('the mix played');
    // A player who fights 20 times an hour is allowed the rows of 20 fights.
    run.totals.fights = 20 * 180;
    const busy = playedMix(run);
    if (!busy) throw new Error('no mix');
    expect(modelOf(busy).rowsPerHour).toBeGreaterThan(model.rowsPerHour + 300);
    expect(failed(run)).toEqual([]);
  });

  it('fail clients that were not seated, closes for rate and a missing page reload', () => {
    const run = healthy();
    run.entered = 190;
    run.closes = { '4003': 2 };
    if (run.full)
      run.full.pageLives[0] = { page: 1, hatches: 1, reloads: [], courts: 0, errors: [] };
    expect(failed(run)).toEqual([
      'every client seated at once',
      'no socket closed for its rate',
      'page 1 played and reloaded',
    ]);
  });

  it('let a page free resources (a reload frees what a life made)', () => {
    const run = healthy();
    for (const p of run.full?.pages ?? []) if (p.minute > 30) p.geometries = 110;
    expect(failed(run)).toEqual([]);
  });

  it('fail a bundle that does not verify', () => {
    const run = healthy();
    run.verified.problems = ['abcd1234: chain:break at 3'];
    expect(failed(run)).toEqual(['bundles verify']);
  });

  it('scale their windows to a shorter run', () => {
    const run = healthy();
    run.config.minutes = 30;
    // Samples to minute 60 still hold: the windows are looked up in minute 30's scale.
    expect(failed(run)).toEqual([]);
  });
});

describe('the helpers', () => {
  it('find a slope per hour', () => {
    const points = [0, 10, 20, 30].map((minute) => ({ minute, value: minute * 2 }));
    expect(slopePerHour(points)).toBeCloseTo(120);
    expect(slopePerHour(points.slice(0, 2))).toBeNull();
  });

  it('read CPU per message between two minutes', () => {
    const hub = healthy().full?.hub ?? [];
    expect(cpuPerMessage(hub, 10, 20)).toBeCloseTo(0.5);
    expect(cpuPerMessage([], 10, 20)).toBeNull();
  });
});

describe('the report', () => {
  it('names every check and the result', () => {
    const text = reportOf(healthy());
    expect(text).toContain('# Soak report');
    expect(text).toContain('authority memory level');
    expect(text).toContain('Result: pass');
    const bad = healthy();
    bad.entered = 1;
    expect(reportOf(bad)).toContain('Result: FAIL');
    expect(reportOf(healthy())).toBe(reportOf(healthy()));
  });

  it('says which tables the rows written went to, the largest first', () => {
    const run = healthy();
    run.rows = { checkpoints: 10, encounters: 30, other: 10 };
    const text = reportOf(run);
    expect(text).toContain('## Rows written, by table');
    expect(text).toContain('| encounters | 30 | 60.0% |');
    expect(text.indexOf('| encounters |')).toBeLessThan(text.indexOf('| checkpoints |'));
    expect(reportOf(healthy())).not.toContain('Rows written, by table');
  });
});
