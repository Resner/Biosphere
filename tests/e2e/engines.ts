import { expect, type Page, type TestInfo } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { playerOf } from './helpers';
import { decodePng, luminance } from './look-metrics';

// Shared by the engine specs (M14 T6): `m14-smoke` (the game in one engine) and `m14-mixed`
// (Chromium with Firefox, and WebKit, in one pond).

/** Page errors and uncaught rejections (Playwright reports both as `pageerror`), from the start. */
export function watchErrors(page: Page, who: string): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${who}: ${String(e).slice(0, 400)}`));
  return errors;
}

/** A canvas drawn blank or flat reads under this spread of luminance (levels, 0-255). */
const FLAT_SPREAD = 2;

/**
 * A screenshot of the page, saved and attached as `m14-<spec>-<engine>-<step>`, that must show a
 * drawn frame: the luminance of its pixels spreads more than a flat or blank canvas's.
 */
export async function drawnShot(
  page: Page,
  info: TestInfo,
  name: string,
  engine: string,
): Promise<void> {
  const path = info.outputPath(`${name}-${engine}.png`);
  const png = await page.screenshot({ path });
  await info.attach(`${name}-${engine}`, { path, contentType: 'image/png' });
  const image = await decodePng(page, png);
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let i = 0; i < image.rgba.length; i += 4 * 7) {
    const l = luminance(image.rgba, i);
    sum += l;
    sq += l * l;
    n++;
  }
  const mean = sum / n;
  const spread = Math.sqrt(Math.max(0, sq / n - mean * mean));
  expect(spread, `${name} in ${engine} is a drawn frame, not a flat canvas`).toBeGreaterThan(
    FLAT_SPREAD,
  );
}

/** Waits until the canvas has drawn `more` frames past now: the loop runs in this engine. */
export async function framesRun(page: Page, more = 10): Promise<void> {
  const at = Number(await page.locator('#scene').getAttribute('data-frames'));
  await page.waitForFunction(
    (target) => Number(document.querySelector('#scene')?.getAttribute('data-frames')) >= target,
    at + more,
    { timeout: 30_000 },
  );
}

/** Where `page` draws the remote `id`, or null while it draws none. */
export const seen = (page: Page, id: string) =>
  page.evaluate((who) => {
    const r = (window.__bs as BsHook).state().remotes.find((x) => x.id === who);
    return r ? { x: r.x, y: r.y } : null;
  }, id);

/**
 * `mover` swims `far` body radii east, and `watcher` sees its remote move by at least half that:
 * each page sees the other move. Bounded, with what each saw on failure.
 */
export async function seesMove(watcher: Page, mover: Page, moverId: string): Promise<void> {
  const before = await seen(watcher, moverId);
  if (!before) throw new Error(`the watcher draws no ${moverId}`);
  const from = await playerOf(mover);
  const far = from.radius * 8;
  await mover.evaluate(([x, y]) => void (window.__bs as BsHook).debug?.steerTo({ x, y }), [
    from.x + far,
    from.y,
  ] as const);
  await expect
    .poll(
      async () => {
        const now = await seen(watcher, moverId);
        return now ? Math.hypot(now.x - before.x, now.y - before.y) : 0;
      },
      { message: 'the watcher sees the other creature move', timeout: 30_000 },
    )
    .toBeGreaterThan(far / 2);
}

type RtcLogged = Window & { __rtcLog?: string[] };

/**
 * Logs, from the page's first script, each `RTCPeerConnection`'s life (its descriptions, the
 * candidates in them, and its ICE and connection states, with the page's clock), so a link that
 * never comes up says why in the failure (`linked`). Behaviour is unchanged.
 */
export const recordRtc = (page: Page) =>
  page.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    if (typeof Native !== 'function') return;
    const log: string[] = [];
    (window as RtcLogged).__rtcLog = log;
    let n = 0;
    const at = () => Math.round(performance.now());
    const cands = (sdp: string | undefined) =>
      (sdp ?? '')
        .split('\n')
        .filter((l) => l.startsWith('a=candidate'))
        .map((l) => l.split(' ').slice(4, 8).join(' '))
        .join(', ');
    class Logged extends Native {
      constructor(config?: RTCConfiguration) {
        super(config);
        const id = ++n;
        const say = (what: string) => log.length < 400 && log.push(`${at()} #${id} ${what}`);
        say(`new ice=${JSON.stringify(config?.iceServers?.map((s) => s.urls) ?? [])}`);
        this.addEventListener('iceconnectionstatechange', () =>
          say(`ice ${this.iceConnectionState}`),
        );
        this.addEventListener('connectionstatechange', () => say(`conn ${this.connectionState}`));
        this.addEventListener('icegatheringstatechange', () =>
          say(`gather ${this.iceGatheringState}`),
        );
        const setLocal = this.setLocalDescription.bind(this);
        this.setLocalDescription = async (d?: RTCLocalSessionDescriptionInit) => {
          await setLocal(d);
          say(`local ${this.localDescription?.type}`);
        };
        const setRemote = this.setRemoteDescription.bind(this);
        this.setRemoteDescription = async (d: RTCSessionDescriptionInit) => {
          say(`remote ${d.type} [${cands(d.sdp)}]`);
          await setRemote(d);
        };
        const close = this.close.bind(this);
        this.close = () => {
          say(`close (local had [${cands(this.localDescription?.sdp)}])`);
          close();
        };
      }
    }
    window.RTCPeerConnection = Logged;
  });

/** The page's `RTCPeerConnection` log (`recordRtc`), for a failure's message. */
export const rtcLog = async (page: Page, who: string): Promise<string> => {
  const log = await page
    .evaluate(() => (window as RtcLogged).__rtcLog?.slice(0, 60) ?? [])
    .catch(() => []);
  return `${who}'s RTCPeerConnection log:\n${log.join('\n')}`;
};

/**
 * Waits until `page` draws the remote `id` over an open link, with what it saw on failure (and the
 * `RTCPeerConnection` log when `recordRtc` ran).
 */
export async function linked(page: Page, id: string, timeout = 60_000): Promise<void> {
  await page
    .waitForFunction(
      (who) => {
        const s = (window.__bs as BsHook).state();
        return s.remotes.some((r) => r.id === who) && s.net.open > 0;
      },
      id,
      { timeout },
    )
    .catch(async (error) => {
      const net = await page.evaluate(() => {
        const s = (window.__bs as BsHook).state();
        return { remotes: s.remotes.map((r) => r.id), net: s.net };
      });
      throw new Error(
        `no link to ${id}: ${JSON.stringify(net).slice(0, 1500)}\n${await rtcLog(page, 'its')}`,
        { cause: error },
      );
    });
}
