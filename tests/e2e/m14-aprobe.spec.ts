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
  const at = () => new Date().toISOString().slice(11, 19);
  const tab = async (
    label: string,
    setup: (p: import('@playwright/test').Page) => Promise<unknown>,
  ) => {
    const p = await b.newPage();
    try {
      await setup(p);
      console.log(at(), label, JSON.stringify(await gatherIn(p)));
    } catch (e) {
      console.log(at(), label, 'threw', String(e).slice(0, 200));
    }
    await p.close();
  };
  await tab('blank', (p) => p.setContent('<p>blank</p>'));
  await tab('blank+webgl2', async (p) => {
    await p.setContent('<p>blank</p>');
    await p.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 1;
      c.height = 1;
      return c.getContext('webgl2') !== null;
    });
  });
  await tab('blank+worker-probe', async (p) => {
    await p.setContent('<p>blank</p>');
    await p.evaluate(() => {
      try {
        new Worker('http://[', { type: 'module' }).terminate();
      } catch {}
    });
  });
  await tab('hub health page (localhost, no script)', (p) =>
    p.goto('http://localhost:8842/v1/health'),
  );
  await tab('preview 404 page (localhost:4173)', (p) => p.goto(`${baseURL}nothing-here.txt`));
  await tab('favicon (localhost:4173)', (p) => p.goto(`${baseURL}favicon.svg`));
  await tab('game', (p) => p.goto(`${baseURL}?genome=starter`));
  await b.close();
});
