import { firefox, test } from '@playwright/test';

// Temporary diagnostic (M14 T6, to remove): Firefox's ICE gathering on the game's origin under prefs.
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

const BASE = { 'media.peerconnection.ice.obfuscate_host_addresses': false };
const VARIANTS: Record<string, Record<string, unknown>> = {
  base: BASE,
  lna: { ...BASE, 'network.lna.enabled': false, 'network.lna.blocking': false },
  loopback: { ...BASE, 'media.peerconnection.ice.loopback': true },
  parentProcess: {
    ...BASE,
    'media.peerconnection.mtransport_process': false,
    'network.process.enabled': false,
  },
  allAddr: { ...BASE, 'media.peerconnection.ice.default_address_only': false },
  proxy: {
    ...BASE,
    'media.peerconnection.ice.proxy_only_if_behind_proxy': false,
    'network.proxy.type': 0,
  },
};

test('probe ICE gathering', async ({ baseURL }) => {
  test.setTimeout(240_000);
  for (const [name, prefs] of Object.entries(VARIANTS)) {
    const b = await firefox.launch({
      headless: false,
      firefoxUserPrefs: prefs as Record<string, string>,
    });
    const page = await b.newPage();
    await page.goto(`${baseURL}?genome=starter`);
    const origin = await gatherIn(page);
    await page.setContent('<p>blank</p>');
    const blank = await gatherIn(page);
    console.log(name, JSON.stringify({ localhost: origin, blank }));
    await b.close();
  }
});
