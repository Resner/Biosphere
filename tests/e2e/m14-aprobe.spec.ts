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
test('probe ICE gathering', async () => {
  test.setTimeout(240_000);
  const http = await import('node:http');
  const serve = (host: string, port: number) =>
    new Promise<import('node:http').Server>((resolve) => {
      const srv = http.createServer((_q, r) => {
        r.setHeader('content-type', 'text/html');
        r.end('<p>probe</p>');
      });
      srv.listen(port, host, () => resolve(srv));
    });
  const v4 = await serve('127.0.0.1', 4199);
  const v6 = await serve('::1', 4198);
  for (const [name, prefs] of [
    ['base', { 'media.peerconnection.ice.obfuscate_host_addresses': false }],
    [
      'noIPv6',
      {
        'media.peerconnection.ice.obfuscate_host_addresses': false,
        'network.dns.disableIPv6': true,
      },
    ],
  ] as const) {
    const b = await firefox.launch({ headless: false, firefoxUserPrefs: prefs });
    const at = () => new Date().toISOString().slice(11, 19);
    const tab = async (url: string) => {
      const p = await b.newPage();
      try {
        await p.goto(url);
        console.log(at(), name, url, JSON.stringify(await gatherIn(p)));
      } catch (e) {
        console.log(at(), name, url, 'threw', String(e).slice(0, 120));
      }
      await p.close();
    };
    for (const url of [
      'http://127.0.0.1:4199/',
      'http://localhost:4199/',
      'http://[::1]:4198/',
      'http://localhost:4198/',
      'http://localhost:4173/favicon.svg',
      'http://[::1]:4173/favicon.svg',
    ])
      await tab(url);
    await b.close();
  }
  v4.close();
  v6.close();
});
