import { type Browser, chromium, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { chromiumPath } from '../../tools/gallery-capture.mjs';
import { linked, recordRtc, rtcLog, seesMove, watchErrors } from './engines';
import { openRecorded, state, warmHub } from './helpers';
import { fightLine, fightToEnd, open, stage } from './m7-fight';

// Mixed engines in one pond (M14 T6): a Chromium page and a page of the engine under test (the
// firefox project's Firefox; `E2E full` only) hatch near each other, link over WebRTC with host
// candidates, see each other move, and duel: both pages end on the referee's hash. The test
// launches the Chromium page itself. Playwright's Linux WebKit can't link (ADR 0077), so the webkit
// project leaves this spec out, and Safari's links are an owner check.

const HUB = 'http://localhost:8841';

test.describe.configure({ mode: 'serial' });
test.skip(({ browserName }) => browserName === 'chromium', 'an engine beside Chromium');

/** B at 0.6 of its health stands and fights (as `m7-duel` explains): no genome's autopilot flees. */
const HURT = 0.6;

const openOn = (browser: Browser) => open(browser, HUB, '&quality=low', recordRtc);

test('a Chromium page and this engine link, see each other move and duel to the referee’s hash @slow', async ({
  browser,
  browserName,
}) => {
  test.setTimeout(300_000);
  await warmHub(HUB);
  const executablePath = chromiumPath(chromium.executablePath());
  const other = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    // As the chromium project: host candidates as addresses, which a sandbox can reach.
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
  });
  try {
    // A is Chromium, B the engine under test; B is the one `stage` reloads and hurts.
    const [a, b] = await Promise.all([openOn(other), openOn(browser)]);
    const errors = [watchErrors(a, 'chromium'), watchErrors(b, browserName)];
    const ids = await stage(a, b, undefined, HURT).catch(async (error: Error) => {
      const logs = [await rtcLog(a, 'chromium'), await rtcLog(b, browserName)];
      throw new Error(`${error.message}\n${logs.join('\n')}`, { cause: error });
    });

    // Linked both ways, and each sees the other move.
    await Promise.all([linked(a, ids.idB), linked(b, ids.idA)]);
    await seesMove(a, b, ids.idB);
    await seesMove(b, a, ids.idA);

    // The duel: A engages, both pages play the same fight to the referee's end.
    await a.evaluate(() => (window.__bs as BsHook).debug?.setHealth(Number.MAX_SAFE_INTEGER));
    const id = await fightToEnd(a, b, ids);
    const [endA, endB] = [(await state(a)).encounter, (await state(b)).encounter];
    const line = await fightLine(a, ids);
    for (const [who, enc] of [
      ['chromium', endA],
      [browserName, endB],
    ] as const) {
      expect(enc?.id, `${who} played the fight (${line})`).toBe(id);
      expect(enc?.over).toBe(true);
      expect(enc?.endHash).toMatch(/^[0-9a-f]+$/);
      expect(enc?.hash, `${who} ends on the referee's hash (${line})`).toBe(enc?.endHash);
    }
    expect(endA?.endHash).toBe(endB?.endHash);
    expect(
      endA?.fighters.map((f) => f.outcome),
      'both engines saw the same outcomes',
    ).toEqual(endB?.fighters.map((f) => f.outcome));
    expect(errors.flat(), 'no page error and no uncaught rejection').toEqual([]);
  } finally {
    await other.close();
  }
});
