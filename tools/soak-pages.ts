// The soak's two Chromium pages (M14 T14): the real game on the low preset, played among the life
// clients: hatch, swim to food, court when a creature is in reach, accept an invitation, hatch
// again after a death, and reload once at the half. Sampled every minute for the JS heap after a
// forced collection, the renderer's resources and the frame times. Node only; every page dials localhost.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setPriority } from 'node:os';
import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium,
  type Page,
} from 'playwright';
import type { BsHook } from '../src/game/debug';
import type { PageLife, PageSample } from './soak-report';

export interface PagesOptions {
  /** The built game, served: `http://localhost:<port>/`. */
  site: string;
  /** The authority: `http://localhost:<port>`. */
  hub: string;
  pages: number;
  /** The run's length, for the half-way reload. */
  minutes: number;
  log: (line: string) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const FRAME_CAP = 20_000;

/** The 95th percentile of `values` (nearest rank), or null with none. */
export function p95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] ?? null;
}

/** The frame deltas of a page since the last read, kept in the page by an init script. */
const FRAME_RECORDER = `
(() => {
  const frames = [];
  window.__soakFrames = frames;
  let last = 0;
  const tick = (now) => {
    if (last > 0 && frames.length < ${FRAME_CAP}) frames.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
`;

/** The Chromium build to launch: the pinned one, else the cloud session's pre-installed one. */
function executablePath(): string | undefined {
  const preinstalled = '/opt/pw-browsers/chromium';
  return !existsSync(chromium.executablePath()) && existsSync(preinstalled)
    ? preinstalled
    : undefined;
}

class SoakPage {
  readonly life: PageLife;
  private cdp: CDPSession | null = null;
  readonly creatures = new Set<string>();
  private running = true;
  private loop: Promise<void> = Promise.resolve();

  constructor(
    readonly id: number,
    private readonly page: Page,
    private readonly opts: PagesOptions,
  ) {
    this.life = { page: id, hatches: 0, reloads: [], courts: 0, errors: [] };
    page.on('pageerror', (e) => this.fail(`pageerror: ${e.message}`));
  }

  private fail(message: string): void {
    if (this.life.errors.length < 10) this.life.errors.push(message);
  }

  async start(startedAt: number): Promise<void> {
    const { page, opts } = this;
    await page.goto(`${opts.site}?debug=1&hub=${encodeURIComponent(opts.hub)}&quality=low`);
    await page.waitForFunction(() => window.__bs?.ready === true, undefined, { timeout: 120_000 });
    this.loop = this.play(startedAt).catch((e: unknown) => {
      this.fail(`the driver stopped: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  /** One step per second or so, for as long as the run lasts. */
  private async play(startedAt: number): Promise<void> {
    const reloadAt = startedAt + (this.opts.minutes * 60_000) / 2;
    let reloaded = false;
    while (this.running) {
      if (!reloaded && Date.now() >= reloadAt) {
        reloaded = true;
        await this.reload(startedAt);
      }
      try {
        await this.step();
      } catch (e) {
        // A navigation under the step is not the driver's failure: look again.
        if (!/Execution context|navigat|Target closed/i.test(String(e))) {
          this.fail(`step: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      await sleep(500);
    }
  }

  private async reload(startedAt: number): Promise<void> {
    await this.page.reload();
    await this.page.waitForFunction(() => window.__bs?.ready === true, undefined, {
      timeout: 120_000,
    });
    this.cdp = null;
    this.life.reloads.push(Math.round((Date.now() - startedAt) / 6000) / 10);
  }

  private async step(): Promise<void> {
    const todo = await this.page.evaluate(
      (): { did: string; visit?: string | null; ids: string[] } => {
        const bs = window.__bs as BsHook;
        const s = bs.state();
        const ids = [s.life.creature, s.offspring.creature].filter((c): c is string => !!c);
        const press = (key: string) => {
          dispatchEvent(new KeyboardEvent('keydown', { key }));
          dispatchEvent(new KeyboardEvent('keyup', { key }));
        };
        const click = (): string | null => {
          const pick = (sel: string) =>
            [...document.querySelectorAll<HTMLButtonElement>(sel)].find(
              (b) => !b.hidden && !b.disabled && b.offsetParent !== null,
            );
          const button =
            pick('[data-testid*="-fallback-"]') ??
            pick('[data-testid="hatch-again"]') ??
            pick('[data-testid="hatch"]');
          button?.click();
          return button ? (button.dataset.testid ?? 'button') : null;
        };
        if (s.screen !== 'playing') {
          // The egg is cracked as soon as it stirs, as an impatient player would.
          if (s.egg.phase === 'stirring' && s.egg.paced) {
            press('Enter');
            return { did: 'crack', ids };
          }
          if (s.egg.phase === 'none') {
            return { did: click() ? 'hatch' : 'wait', ids };
          }
          return { did: 'wait', ids };
        }
        if (s.mate.invite) {
          press('e');
          return { did: 'accept', ids };
        }
        if (s.mate.text.startsWith('E: court')) {
          press('e');
          return { did: 'court', ids };
        }
        const player = s.player;
        if (!player?.alive) return { did: 'wait', ids };
        const others = s.remotes.filter((r) => !r.fighting && !r.away);
        return {
          did: 'swim',
          ids,
          // A neighbour in sight is visited now and then; otherwise the nearest food.
          visit:
            others.length > 0 && Math.floor(performance.now() / 20_000) % 3 === 0
              ? (others.reduce((a, b) =>
                  Math.hypot(a.x - player.x, a.y - player.y) <=
                  Math.hypot(b.x - player.x, b.y - player.y)
                    ? a
                    : b,
                ).id ?? null)
              : null,
        };
      },
    );
    for (const id of todo.ids) this.creatures.add(id);
    if (todo.did === 'hatch') this.life.hatches++;
    else if (todo.did === 'court' || todo.did === 'accept') this.life.courts++;
    else if (todo.did === 'swim') {
      await this.page.evaluate(
        ([visit]) => {
          const { debug } = window.__bs as BsHook;
          if (!debug) return Promise.resolve(false);
          const target = visit
            ? { id: visit, x: 0, y: 0 }
            : (() => {
                const food = debug.nearestFood();
                return food ? { id: food.id, x: food.x, y: food.y } : null;
              })();
          if (!target) return Promise.resolve(false);
          // `steerTo` ends on a bite or a timeout; a few seconds is a step.
          return Promise.race([
            debug.steerTo(target),
            new Promise<boolean>((r) => setTimeout(() => r(false), 4_000)),
          ]);
        },
        [todo.visit ?? null] as const,
      );
    }
  }

  /** The heap after a forced collection, the renderer's resources and the frame times so far. */
  async sample(minute: number): Promise<PageSample> {
    const { page } = this;
    this.cdp ??= await page.context().newCDPSession(page);
    for (let i = 0; i < 2; i++) await this.cdp.send('HeapProfiler.collectGarbage');
    const heap = await this.cdp.send('Runtime.getHeapUsage');
    const seen = await page.evaluate(() => {
      const info = (window.__bs as BsHook).render.info();
      const frames = (window as unknown as { __soakFrames: number[] }).__soakFrames;
      return { memory: info.memory, frames: frames.splice(0, frames.length) };
    });
    return {
      page: this.id,
      minute,
      heapBytes: heap.usedSize,
      geometries: seen.memory.geometries,
      textures: seen.memory.textures,
      programs: seen.memory.programs,
      frameP95Ms: p95(seen.frames),
    };
  }
}

/** The pages of a soak. */
export class SoakPages {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly drivers: SoakPage[] = [];
  private reniced = false;

  constructor(private readonly opts: PagesOptions) {}

  async start(): Promise<void> {
    const path = executablePath();
    this.browser = await chromium.launch({
      ...(path ? { executablePath: path } : {}),
      args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
    });
    this.yieldCpu();
    this.context = await this.browser.newContext({ viewport: { width: 960, height: 540 } });
    await this.context.addInitScript(FRAME_RECORDER);
    const startedAt = Date.now();
    for (let id = 1; id <= this.opts.pages; id++) {
      const driver = new SoakPage(id, await this.context.newPage(), this.opts);
      this.drivers.push(driver);
      await driver.start(startedAt);
      this.opts.log(`page ${id} open`);
    }
  }

  /**
   * Chromium's processes yield the CPU to the authority and the clients (nice 10): software GL
   * would otherwise take the cores of a four-core runner, and a load generator starved of them
   * hears of a fight's end seconds late (M14 T14e). New renderer processes are found at each sample.
   */
  private yieldCpu(): void {
    try {
      const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
        .flatMap((m) => (m ? [{ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] ?? '' }] : []));
      // The browsers under this process (a direct child, or one a launcher started), and everything under them.
      const below = [process.pid];
      for (let i = 0; i < below.length; i++)
        for (const r of rows) if (r.ppid === below[i]) below.push(r.pid);
      const tree = rows
        .filter((r) => below.includes(r.pid) && /chrom|headless_shell/i.test(r.args))
        .map((r) => r.pid);
      for (let i = 0; i < tree.length; i++)
        for (const r of rows) if (r.ppid === tree[i] && !tree.includes(r.pid)) tree.push(r.pid);
      let set = 0;
      for (const pid of tree) {
        try {
          setPriority(pid, 10);
          set++;
        } catch {
          // gone already
        }
      }
      if (set > 0 && !this.reniced) this.opts.log(`${set} browser processes at nice 10`);
      this.reniced ||= set > 0;
    } catch {
      // no `ps`: the pages keep their priority
    }
  }

  async sample(minute: number): Promise<PageSample[]> {
    this.yieldCpu();
    return Promise.all(this.drivers.map((d) => d.sample(minute)));
  }

  /** Stops the drivers and returns what they did. */
  async stop(): Promise<PageLife[]> {
    await Promise.all(this.drivers.map((d) => d.stop()));
    const lives = this.drivers.map((d) => d.life);
    await this.browser?.close().catch(() => {});
    return lives;
  }

  /** The creatures the pages played, for the proof check. */
  creatures(): string[] {
    return [...new Set(this.drivers.flatMap((d) => [...d.creatures]))];
  }
}
