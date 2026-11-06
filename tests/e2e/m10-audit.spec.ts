import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import type { SignedAttestation } from '../../src/ledger/witness';
import { longAudit } from '../audit-case';
import { clickHatch, M10_AUDIT_HUB, ripe, state, waitPlaying } from './helpers';
import { fightToEnd, mate, open, stage } from './m7-fight';

// Audits (M10 T8): A and B mate while C and D are online and can witness (the hub's
// `WITNESS_PLAY_MS=0` and `WITNESS_IP_CHECK=off`). One of them audits the births, and the hub
// stores its agreeing attestation. A then engages B, and after the fight's end C or D (whichever
// holds the auditor's place in the drand order) audits it the same way. Last, C's audit worker
// replays a 90 s, 4-fighter log while the test watches C's frames.

test.describe.configure({ mode: 'serial' });

/** What `GET /v1/e2e/witness/<event>` serves that the test reads (`WitnessView`, `worker/duty.ts`). */
interface WitnessView {
  struck: string[];
  attestations: SignedAttestation[];
}

/** Hatches the page's creature and waits until it tells the hub it can witness. */
async function witnessing(page: Page): Promise<void> {
  // Four software-rendered pages on one runner draw slower than a witness may (a frame-time p90
  // over 50 ms): availability judges fast frames here, so both witnesses stay in the pool.
  await page.evaluate(() => (window.__bs as BsHook).debug?.dutyFrameMs(16));
  await clickHatch(page);
  await waitPlaying(page);
  await expect
    .poll(async () => (await state(page)).witness.avail, {
      message: 'the page offers to witness',
      timeout: 60_000,
    })
    .toBe(true);
}

/** Waits until C or D attested an event of `kind` (and `id`, when given) and returns its event. */
async function audited(pages: Page[], kind: string, id?: string): Promise<string> {
  const match = (event: string) => event.startsWith(`${kind}:`) && (!id || event.endsWith(id));
  let found = '';
  await expect
    .poll(
      async () => {
        for (const page of pages) {
          const hit = (await state(page)).witness.audits.find((x) => match(x.event));
          if (hit) {
            found = hit.event;
            return hit.agree;
          }
        }
        return null;
      },
      { message: `C or D audits the ${kind}`, timeout: 90_000 },
    )
    .toBe(true)
    .catch(async (error) => {
      const seen = await Promise.all(pages.map(async (p) => (await state(p)).witness));
      const hub = id
        ? await (
            await pages[0]?.request.get(`${M10_AUDIT_HUB}/v1/e2e/witness/${kind}:${id}`)
          )?.text()
        : null;
      throw new Error(`no ${kind} audit: ${JSON.stringify({ seen, hub })}`, { cause: error });
    });
  return found;
}

/** The hub's view of the event's witnesses: its stored attestations agree, and nobody is struck. */
async function stored(page: Page, event: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const r = await page.request.get(`${M10_AUDIT_HUB}/v1/e2e/witness/${event}`);
        const view = (await r.json()) as WitnessView | null;
        return view?.attestations.map((s) => s.attestation.agree);
      },
      { message: `the hub stores ${event}'s attestation`, timeout: 15_000 },
    )
    .toEqual([true]);
  const r = await page.request.get(`${M10_AUDIT_HUB}/v1/e2e/witness/${event}`);
  expect(((await r.json()) as WitnessView).struck).toEqual([]);
}

test('witnesses audit a mating and a fight, and an audit never stalls a frame @slow', async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const pages = await Promise.all([0, 1, 2, 3].map(() => open(browser, M10_AUDIT_HUB)));
  const [a, b, c, d] = pages as [Page, Page, Page, Page];
  try {
    await Promise.all([witnessing(c), witnessing(d)]);
    const ids = await stage(
      a,
      b,
      async () => {
        await Promise.all([ripe(a), ripe(b)]);
        await mate(a, b);
      },
      0.6,
    );
    // The births are written once the mating's round is out, and audited after them.
    const mating = await audited([c, d], 'mating');
    await stored(a, mating);

    // A fight, audited after its end. Its pool is C and D, so both must be free to witness again.
    for (const page of [c, d]) {
      await expect
        .poll(async () => (await state(page)).witness.auditing, { timeout: 60_000 })
        .toBeNull();
    }
    const enc = await fightToEnd(a, b, ids);
    if (!enc) throw new Error('no fight');
    const fight = await audited([c, d], 'enc', enc);
    await stored(a, fight);

    // C's frames while its audit worker replays a 90 s, 4-fighter log, against its frames before.
    const long = longAudit();
    const frames = await c.evaluate(async ({ audit, beacon, keys }) => {
      const watch = () => {
        const gaps: number[] = [];
        let last = performance.now();
        let on = true;
        const loop = (t: number) => {
          gaps.push(t - last);
          last = t;
          if (on) requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
        return () => {
          on = false;
          return gaps;
        };
      };
      const frames = (n: number) =>
        new Promise<void>((done) => {
          let k = 0;
          const step = () => (++k >= n ? done() : requestAnimationFrame(step));
          requestAnimationFrame(step);
        });
      const stopBefore = watch();
      await frames(60);
      const before = stopBefore();
      const stopDuring = watch();
      const out = await (window.__bs as BsHook).debug?.audit(audit, beacon, keys);
      await frames(2);
      const during = stopDuring();
      return {
        before: Math.max(...before),
        during: Math.max(...during),
        frames: during.length,
        verdict: out?.verdict,
        ms: out?.ms,
      };
    }, long);
    expect(frames.verdict).toEqual({ subject: long.audit.settlement.hash, agree: true });
    expect(frames.during, JSON.stringify(frames)).toBeLessThanOrEqual(frames.before + 100);
  } finally {
    await Promise.all(pages.map((p) => p.context().close()));
  }
});
