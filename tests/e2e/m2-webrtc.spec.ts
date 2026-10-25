import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Browser, chromium, expect, type Page, test } from '@playwright/test';
import type { PeerMesh } from '../../src/net/peer-mesh';
import { bundleForBrowser } from './helpers';

// Real WebRTC between two browser contexts: no ICE servers (host candidates only) and an in-test
// signal relay, so nothing leaves the machine. Chromium would otherwise hide local IPs behind mDNS
// names that the sandbox cannot resolve.
const preinstalled = '/opt/pw-browsers/chromium';
const executablePath =
  !existsSync(chromium.executablePath()) && existsSync(preinstalled) ? preinstalled : undefined;

declare global {
  interface Window {
    __m: PeerMesh;
    __got: { states: { seq: number; x: number }[]; events: unknown[]; joined: string[] };
    __relay: (to: string, kind: string, sdp: string) => void;
  }
}

test('two browsers connect and exchange a snapshot and an event', async () => {
  const code = await bundleForBrowser(resolve('src/net/peer-mesh-entry.ts'), 'BsMesh');
  const browser: Browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
  });
  try {
    const ids = ['alice', 'bob'] as const;
    const pages: Page[] = [];
    for (const id of ids) {
      const page = await (await browser.newContext()).newPage();
      pages.push(page);
      const other = () => pages[id === 'alice' ? 1 : 0] as Page;
      await page.exposeFunction('__relay', (to: string, kind: string, sdp: string) => {
        void other().evaluate(
          ([from, k, s]) => window.__m.handleSignal(from, k as 'offer' | 'answer', s),
          [id, kind, sdp] as const,
        );
        return to;
      });
      await page.goto('about:blank');
      await page.addScriptTag({ content: code });
      await page.evaluate((selfId) => {
        // biome-ignore lint/suspicious/noExplicitAny: the bundle's global
        const { PeerMesh, encodeSnapshot, decodeSnapshot } = (window as any).BsMesh;
        window.__got = { states: [], events: [], joined: [] };
        window.__m = new PeerMesh({
          selfId,
          signal: (to: string, kind: string, sdp: string) => window.__relay(to, kind, sdp),
          iceServers: [],
        });
        window.__m.onPeerJoined((id: string) => window.__got.joined.push(id));
        window.__m.onState((_: string, s: { seq: number; x: number }) =>
          window.__got.states.push(s),
        );
        window.__m.onEvent((_: string, e: unknown) => window.__got.events.push(e));
        // biome-ignore lint/suspicious/noExplicitAny: test-only helpers on the hook
        (window as any).__enc = (s: unknown) => encodeSnapshot(s);
        // biome-ignore lint/suspicious/noExplicitAny: keeps the decoder bundled
        (window as any).__dec = decodeSnapshot;
      }, id);
    }
    const [alice, bob] = pages as [Page, Page];
    await alice.evaluate(() => window.__m.connect('bob'));
    for (const page of pages) {
      await page.waitForFunction(() => window.__m.stats().open === 1, undefined, { timeout: 5000 });
    }

    await alice.evaluate(() => {
      const snap = {
        seq: 42,
        tick: 10,
        x: 300,
        y: 400,
        heading: 1,
        vx: 0,
        vy: 0,
        biomass: 2,
        energy: 1,
        health: 1,
        alive: true,
        dashing: false,
      };
      // biome-ignore lint/suspicious/noExplicitAny: test-only helper
      window.__m.sendState('bob', (window as any).__enc(snap));
      window.__m.sendEvent('bob', { t: 'chat', text: 'hello bob' });
    });
    await bob.waitForFunction(
      () => window.__got.states.length >= 1 && window.__got.events.length >= 1,
      undefined,
      { timeout: 5000 },
    );
    const got = await bob.evaluate(() => window.__got);
    expect(got.states[0]?.seq).toBe(42);
    expect(got.states[0]?.x).toBe(300);
    expect(got.events[0]).toEqual({ t: 'chat', text: 'hello bob' });
    expect(await bob.evaluate(() => window.__m.stats().dropped)).toBe(0);
  } finally {
    await browser.close();
  }
});
