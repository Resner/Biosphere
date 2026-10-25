import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const text = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const SECRETS = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'CF_TURN_KEY_ID',
  'CF_TURN_KEY_API_TOKEN',
];

interface Job {
  name: string;
  needs: string[];
  steps: { name: string; text: string }[];
}

/** A line-based reading of the workflow: jobs at two spaces, steps at six (`      - …`). */
function jobs(): Job[] {
  const result: Job[] = [];
  let job: Job | null = null;
  let inJobs = false;
  for (const line of text.split('\n')) {
    if (/^jobs:/.test(line)) inJobs = true;
    else if (/^\S/.test(line)) inJobs = false;
    if (!inJobs) continue;
    const head = /^ {2}([\w-]+):\s*$/.exec(line);
    if (head) {
      job = { name: head[1] as string, needs: [], steps: [] };
      result.push(job);
      continue;
    }
    if (!job) continue;
    const needs = /^ {4}needs:\s*(.+)$/.exec(line);
    if (needs) job.needs = (needs[1] as string).replace(/[[\]]/g, '').split(/,\s*/);
    const step = /^ {6}- (?:name:\s*(.+)|(.+))$/.exec(line);
    if (step) job.steps.push({ name: (step[1] ?? step[2]) as string, text: `${line}\n` });
    else if (job.steps.length > 0 && /^ {6,}/.test(line)) {
      (job.steps[job.steps.length - 1] as { text: string }).text += `${line}\n`;
    }
  }
  return result;
}

describe('release workflow', () => {
  it('has no secret value, only secrets.* references', () => {
    // A token-like literal (32+ characters of key material) would be a leaked value.
    expect(text).not.toMatch(/[A-Za-z0-9_-]{32,}/);
    for (const [, name] of text.matchAll(/\$\{\{\s*secrets\.(\w+)\s*\}\}/g)) {
      expect([...SECRETS, 'GITHUB_TOKEN']).toContain(name);
    }
  });

  it('reads the Cloudflare secrets only in the preflight and the Worker deploy steps', () => {
    for (const job of jobs()) {
      for (const step of job.steps) {
        if (!/secrets\./.test(step.text)) continue;
        expect(['preflight', 'worker'], `${job.name}: ${step.name}`).toContain(job.name);
      }
    }
  });

  it('checks the secrets first and deploys the Worker before Pages', () => {
    const byName = new Map(jobs().map((j) => [j.name, j]));
    const preflight = byName.get('preflight');
    const build = byName.get('build');
    const worker = byName.get('worker');
    const pages = byName.get('deploy');
    expect(preflight?.needs).toEqual([]);
    expect(build?.needs).toContain('preflight');
    expect(worker?.needs).toContain('build');
    expect(pages?.needs).toContain('worker');
    const check = preflight?.steps.map((s) => s.text).join('') ?? '';
    for (const name of [...SECRETS, 'AUTHORITY_URL']) expect(check).toContain(name);
    expect(check).toContain('::error::');
  });

  it('deploys with wrangler, sets the TURN secrets and smoke-checks the version', () => {
    const worker = jobs().find((j) => j.name === 'worker');
    const all = worker?.steps.map((s) => s.text).join('') ?? '';
    expect(all).toContain('tools/worker.mjs deploy');
    expect(all).toContain('secret put CF_TURN_KEY_ID');
    expect(all).toContain('secret put CF_TURN_KEY_API_TOKEN');
    expect(all).toContain('/v1/health');
    expect(text).toContain('BUILD_LABEL');
    expect(text).toMatch(/AUTHORITY_URL: \$\{\{ vars\.AUTHORITY_URL \}\}/);
  });
});
