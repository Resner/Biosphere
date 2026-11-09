import { execSync } from 'node:child_process';
import { firefox, test } from '@playwright/test';

// Temporary diagnostic (M14 T6, to remove): when Firefox's ICE gathering stops working.
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
    const out = { n: cands.length, ice: pc.iceConnectionState };
    pc.close();
    return out;
  });
const sh = (cmd: string) => {
  try {
    return execSync(cmd).toString();
  } catch (e) {
    return String(e);
  }
};

test('probe ICE gathering', async ({ baseURL }) => {
  test.setTimeout(240_000);
  const prefs = { 'media.peerconnection.ice.obfuscate_host_addresses': false };
  const b = await firefox.launch({ headless: false, firefoxUserPrefs: prefs });
  const page = await b.newPage();
  const at = () => new Date().toISOString().slice(11, 19);
  await page.setContent('<p>blank</p>');
  console.log(at(), 'blank 1', JSON.stringify(await gatherIn(page)));
  await page.waitForTimeout(5000);
  console.log(at(), 'blank 2 (5 s later)', JSON.stringify(await gatherIn(page)));
  await page.goto(`${baseURL}lab.html?seed=x`);
  console.log(at(), 'lab', JSON.stringify(await gatherIn(page)));
  await page.goto(`${baseURL}?genome=starter`);
  console.log(at(), 'game', JSON.stringify(await gatherIn(page)));
  const p2 = await b.newPage();
  await p2.setContent('<p>blank</p>');
  console.log(at(), 'blank 3 (new tab)', JSON.stringify(await gatherIn(p2)));
  console.log(
    sh(
      'free -m; sudo dmesg | grep -iE "oom|killed process" | tail -5; ps -eo rss,comm --sort=-rss | head -6',
    ),
  );
  await b.close();
  const c = await firefox.launch({ headless: false, firefoxUserPrefs: prefs });
  const p3 = await c.newPage();
  await p3.setContent('<p>blank</p>');
  console.log(at(), 'fresh browser blank', JSON.stringify(await gatherIn(p3)));
  await c.close();
});
