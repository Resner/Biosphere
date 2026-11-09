import { execSync } from 'node:child_process';
import { test } from '@playwright/test';

// Temporary diagnostic (M14 T6, to remove): Firefox's ICE gathering on a blank page and on the game's origin.
const gatherIn = (page: import('@playwright/test').Page) =>
  page.evaluate(async () => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    const cands: string[] = [];
    pc.onicecandidate = (e) => {
      if (e.candidate) cands.push(e.candidate.candidate);
    };
    pc.createDataChannel('x');
    await pc.setLocalDescription();
    await new Promise((r) => setTimeout(r, 1500));
    const out = { cands, ice: pc.iceConnectionState, gather: pc.iceGatheringState };
    pc.close();
    return out;
  });

test('probe ICE gathering', async ({ browser }) => {
  console.log(execSync('free -m; ps -eo rss,comm --sort=-rss | head -8').toString());
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent('<p>blank</p>');
  console.log('blank', JSON.stringify(await gatherIn(page)));
  await page.goto('./?genome=starter');
  console.log('game-origin before app', JSON.stringify(await gatherIn(page)));
  await page.waitForFunction(() => window.__bs?.ready === true);
  console.log('game-origin after app', JSON.stringify(await gatherIn(page)));
  await ctx.close();
});
