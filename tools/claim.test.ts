import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// tools/claim.sh decides who may hold a factory step (ADRs 0047, 0048, 0057). These cases feed it a
// fixed list of open PRs (CLAIM_PRS_FILE) and a fixed clock (CLAIM_NOW), so nothing reaches GitHub.
const dir = mkdtempSync(join(tmpdir(), 'claim-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse('2026-11-05T12:00:00Z') / 1000;
const minutesAgo = (m: number) => new Date((NOW - m * 60) * 1000).toISOString();

interface Pr {
  number: number;
  task?: string;
  updated?: number;
  fork?: boolean;
}

function probe(task: string, prs: Pr[]): { status: number | null; out: string } {
  const file = join(dir, `prs-${Math.random().toString(36).slice(2)}.json`);
  const json = prs.map((p) => ({
    number: p.number,
    body: p.task ? `Step: x\n\nTask: ${p.task}\n` : 'no task line',
    updated_at: minutesAgo(p.updated ?? 5),
    head: {
      ref: `claude/run-${p.number}`,
      repo: { full_name: p.fork ? 'someone/Biosphere' : 'Resner/Biosphere' },
    },
  }));
  writeFileSync(file, JSON.stringify(json));
  const run = spawnSync('bash', ['tools/claim.sh', 'probe', task], {
    encoding: 'utf8',
    env: { ...process.env, CLAIM_PRS_FILE: file, CLAIM_NOW: String(NOW) },
  });
  return { status: run.status, out: `${run.stdout}${run.stderr}`.trim() };
}

describe('tools/claim.sh probe', () => {
  it('finds a step free when no open PR claims it', () => {
    expect(probe('M9 T6', [{ number: 10, task: 'M9 T5' }])).toEqual({ status: 0, out: 'free' });
  });

  it('blocks a step another open PR already claims', () => {
    const r = probe('M9 T5', [{ number: 10, task: 'M9 T5' }]);
    expect(r.status).toBe(3);
    expect(r.out).toContain('already claimed by #10');
  });

  it('ignores a fork that names a claude/ branch', () => {
    expect(probe('M9 T5', [{ number: 10, task: 'M9 T5', fork: true }]).status).toBe(0);
  });

  it('blocks a third step while two others are live, but lets a health fix through', () => {
    const busy = [
      { number: 10, task: 'M9 T5' },
      { number: 11, task: 'M9 T6' },
      { number: 12, task: 'health' },
    ];
    const r = probe('M9 T7', busy);
    expect(r.status).toBe(3);
    expect(r.out).toContain('two steps in progress');
    expect(probe('health', [{ number: 10, task: 'M9 T5' }, { number: 11, task: 'M9 T6' }])).toEqual({
      status: 0,
      out: 'free',
    });
  });

  it('does not count stale claims, which the next run takes over instead', () => {
    const stale = [
      { number: 10, task: 'M9 T5', updated: 180 },
      { number: 11, task: 'M9 T6', updated: 5 },
    ];
    expect(probe('M9 T7', stale).status).toBe(0);
  });
});
