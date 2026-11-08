import { expect, type Page } from '@playwright/test';
import type { BsHook, BsState } from '../../src/game/debug';
import { TICK_HZ } from '../../src/sim/rules';

/**
 * Opens the game on the title screen and waits for the test hook. A test that does not pin a body
 * with `genome=` gets the starter cell, so the thresholds of the M1 and M2 specs stay meaningful.
 */
export async function openGame(page: Page, query: string): Promise<void> {
  const pinned = /[?&]genome=/.test(query)
    ? query
    : `${query}${query.includes('?') ? '&' : '?'}genome=starter`;
  await page.goto(`./${pinned}`);
  await page.waitForFunction(() => window.__bs?.ready === true);
}

/**
 * Clicks Hatch and waits until play has started. The click leaves the cursor on the button, which
 * would steer the cell away, so the cursor is parked on the cell (inside its dead zone).
 */
export async function hatch(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Hatch', exact: true }).click();
  await page.waitForFunction(() => window.__bs?.state().screen === 'playing');
  const { width, height } = page.viewportSize() ?? { width: 960, height: 540 };
  await page.mouse.move(width / 2, height / 2);
}

/**
 * Opens the play screen's menu (M6b T9) with Esc, which leaves the cursor (and so the steering)
 * where it is: the numbers in words, the roster, Lineage and Settings live there now. Call it with
 * nothing else open that Esc would close first (the wheel, the map, a card or an invitation).
 */
export async function openMenu(page: Page): Promise<void> {
  const menu = page.getByTestId('menu');
  if (!(await menu.isVisible())) await page.keyboard.press('Escape');
  await expect(menu).toBeVisible();
}

export const state = (page: Page) => page.evaluate(() => (window.__bs as BsHook).state());

/** Types a chat line through the real UI (Enter, text, Enter). */
/**
 * The wheel's "look" ping at the cursor: G held while `1` picks, then released. A G tapped and
 * released later than the wheel's hold time (250 ms) cancels it, and a loaded runner can take
 * longer than that between the two key events of `keyboard.press('g')`.
 */
export async function pingLook(page: Page): Promise<void> {
  await page.keyboard.down('g');
  await page.keyboard.press('1');
  await page.keyboard.up('g');
}

export async function say(page: Page, text: string): Promise<void> {
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('chat-input')).toBeVisible();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('chat-input')).toBeHidden();
}

export const chatTexts = (page: Page) =>
  page.evaluate(() => (window.__bs as BsHook).state().social.chat.map((l) => l.text));

export async function playerOf(page: Page): Promise<NonNullable<BsState['player']>> {
  const { player } = await page.evaluate(() => (window.__bs as BsHook).state());
  if (!player) throw new Error('the player has not hatched');
  return player;
}

/**
 * How the player swims over `ms` of wall time: the distance per second of sim time and the
 * heading. Position and tick are read in one page call and the distance is divided by the ticks
 * that ran, so a slow runner's stalled frames do not read as a slower swimmer.
 */
export async function swimPace(page: Page, ms = 1000): Promise<{ dist: number; heading: number }> {
  const at = () =>
    page.evaluate(() => {
      const { player, tick } = (window.__bs as BsHook).state();
      if (!player) throw new Error('the player has not hatched');
      return { x: player.x, y: player.y, tick };
    });
  const from = await at();
  await page.waitForTimeout(ms);
  // A starved page can run no tick in a whole second: wait until it has run a few, then read.
  await page.waitForFunction(
    (t) => ((window.__bs as BsHook).state().tick ?? 0) >= t + 5,
    from.tick,
    { timeout: 30_000 },
  );
  const to = await at();
  const ticks = to.tick - from.tick;
  if (ticks <= 0) throw new Error('the world did not run');
  return {
    dist: (Math.hypot(to.x - from.x, to.y - from.y) * TICK_HZ) / ticks,
    heading: Math.atan2(to.y - from.y, to.x - from.x),
  };
}

/** Bundles a source file into one browser script (an IIFE that sets `globalName`). */
export async function bundleForBrowser(entry: string, globalName: string): Promise<string> {
  const { build } = await import('vite');
  const out = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry, name: globalName, formats: ['iife'], fileName: 'bundle' },
    },
  });
  const outputs = Array.isArray(out) ? out : [out];
  const chunk = outputs
    .flatMap((o) => ('output' in o ? o.output : []))
    .find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error(`no bundle for ${entry}`);
  return chunk.code;
}

/** Mean luminance (0..1) of the square patches of `2 * half + 1` pixels around each point of a PNG. */
export async function patchLuma(
  page: Page,
  png: Buffer,
  points: { x: number; y: number }[],
  half = 4,
): Promise<number[]> {
  return page.evaluate(
    async ({ base64, points, half }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const scratch = document.createElement('canvas');
      scratch.width = image.width;
      scratch.height = image.height;
      const context = scratch.getContext('2d');
      if (!context) throw new Error('2D canvas unavailable');
      context.drawImage(image, 0, 0);
      return points.map((p) => {
        const size = 2 * half + 1;
        const { data } = context.getImageData(
          Math.round(p.x) - half,
          Math.round(p.y) - half,
          size,
          size,
        );
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) {
          sum +=
            (0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0)) /
            255;
        }
        return sum / (size * size);
      });
    },
    { base64: png.toString('base64'), points, half },
  );
}

/** The authority the M4 specs share: `wrangler dev --e2e`, serving recorded drand rounds. */
export const M4_HUB = 'http://localhost:8790';

/** The M4 authority with lifespans at 1% (about 45 s), for the old-age spec. */
export const M4_SHORT_LIFE_HUB = 'http://localhost:8791';

/** The M4 authority with two seats (`MAX_SESSIONS=2`), for the lifecycle spec's admission queue. */
export const M4_TWO_SEAT_HUB = 'http://localhost:8792';

/** The M5 authority: lives of about 4 min (`LIFESPAN_SCALE=0.05`) and maturity in seconds (`MATING_SCALE=0.01`). */
export const M5_HUB = 'http://localhost:8793';

/** A second M5 authority, alone in its pond, for the inspect spec. */
export const M5_INSPECT_HUB = 'http://localhost:8794';

/** A third, for the promote spec. */
export const M5_PROMOTE_HUB = 'http://localhost:8795';

/** A fourth, for the lifecycle spec. */
export const M5_LIFECYCLE_HUB = 'http://localhost:8796';

/** The M6 authority for the finding spec (edge indicators and the pond map), alone in its pond. */
export const M6_FIND_HUB = 'http://localhost:8797';

/** The M6 authority for the egg spec, with the M5 hooks (short lives, maturity in seconds), alone in its pond. */
export const M6_EGG_HUB = 'http://localhost:8798';

/** The M6 authority for the social wheel spec, alone in its pond. */
export const M6_WHEEL_HUB = 'http://localhost:8799';

/** The M6 authority for the lifecycle spec, with the M5 hooks, alone in its pond. */
export const M6_LIFECYCLE_HUB = 'http://localhost:8800';

/** The M6b authority for the egg spec, with the M5 hooks, alone in its pond. */
export const M6B_EGG_HUB = 'http://localhost:8801';

/** The M6b authority for the minimap spec, alone in its pond. */
export const M6B_MINIMAP_HUB = 'http://localhost:8802';

/** The M6b authority for the lifecycle spec, with the M5 hooks (short lives), two players in one pond. */
export const M6B_LIFECYCLE_HUB = 'http://localhost:8803';

/** The M6c authority for the world renewal (M6c T2), with its E2E hook that stages a pre-reset player. */
export const M6C_RESET_HUB = 'http://localhost:8804';

/** The M6c authority for the egg spec (M6c T11), with the M5 hooks, alone in its pond. */
export const M6C_EGG_HUB = 'http://localhost:8805';

/** The M6c authority for the lifecycle spec (M6c T14), with the M5 hooks (short lives) and the pre-reset hook. */
export const M6C_LIFECYCLE_HUB = 'http://localhost:8806';

/** The M7 duel spec's hub (M7 T11): two players, one engagement and a kill. */
export const M7_DUEL_HUB = 'http://localhost:8807';
/** The M7 HUD spec's own authority (M7 T12): a duel's HUD, telegraphs and cues. */
export const M7_HUD_HUB = 'http://localhost:8808';

/** The M7 carrion spec's hub (M7 T14): a kill seen by a spectator. */
export const M7_CARRION_HUB = 'http://localhost:8810';

/** The M7 kill spec's hub (M7 T14): the M5 hooks, with a mating before the kill. */
export const M7_KILL_HUB = 'http://localhost:8809';
/** The M7 melee spec's own authority (M7 T15): a third player joins a running fight. */
export const M7_MELEE_HUB = 'http://localhost:8811';
/** The M7 lifecycle spec's authority (M7 T16): the M5 hooks and the whole encounter line. */
export const M7_LIFECYCLE_HUB = 'http://localhost:8812';
/** The M8 resume spec's hub (M8 T10): B reloads mid-fight and goes back to it. */
export const M8_RESUME_HUB = 'http://localhost:8813';
/** The M8 restart spec's hub (M8 T10): the authority restarts mid-fight (`POST /v1/e2e/restart`). */
export const M8_RESTART_HUB = 'http://localhost:8814';
/** The M8 away spec's hub (M8 T12): pages close mid-fight, with `AWAY_GRACE_MS` 500. */
export const M8_AWAY_HUB = 'http://localhost:8816';
/** The M8 proxy spec's hub (M8 T11): an away fighter seen by its opponent and, by proxy, a spectator. */
export const M8_PROXY_HUB = 'http://localhost:8815';
/** The M8 lifecycle spec's hub (M8 T14): one fight through a reload, a restart and a closed tab. */
export const M8_LIFECYCLE_HUB = 'http://localhost:8817';
/** The M9 card spec's hub (M9 T12): a creature's card opened with its owner offline. */
export const M9_CARD_HUB = 'http://localhost:8818';
/** The M9 share spec's hub (M9 T14): from the game's Lineage to a card and its image. */
export const M9_SHARE_HUB = 'http://localhost:8820';
/** The M9 lineage spec's hub (M9 T13), with the M5 hooks: a mating and both promotions, then the card's graph. */
export const M9_LINEAGE_HUB = 'http://localhost:8819';
/** The M9 lifecycle spec's hub (M9 T15), with the M5 hooks: a lineage from genesis to a mating, a fight, a death and a return. */
export const M9_LIFECYCLE_HUB = 'http://localhost:8821';
/** The M10 witness specs' hubs (M10 T7), with `WITNESS_PLAY_MS=0` and `WITNESS_IP_CHECK=off`: the fight and the witness that vanishes, and the witness 20,000 wu away. */
export const M10_WITNESS_HUB = 'http://localhost:8822';
export const M10_CROSS_HUB = 'http://localhost:8823';
/** The M10 audit spec's hub (M10 T8), with the M5 hooks, `WITNESS_PLAY_MS=0` and `WITNESS_IP_CHECK=off`. */
export const M10_AUDIT_HUB = 'http://localhost:8825';
/** The M10 card spec's hub (M10 T10), with `WITNESS_PLAY_MS=0` and `WITNESS_IP_CHECK=off`: a witnessed fight on a card. */
export const M10_CARD_HUB = 'http://localhost:8826';
/** The M10 lifecycle spec's hub (M10 T17): `MATING_SCALE` and the witness variables, four players through the whole M10 line. */
export const M10_LIFECYCLE_HUB = 'http://localhost:8827';
/** The M11 lifecycle spec (8832): `LEAF_MAX=2`, short matings and the witness variables. */
export const M11_LIFECYCLE_HUB = 'http://localhost:8832';
/** The M12 lifecycle spec (8836): instances of 2, a 3 s quiet and a 3 s wait alone, short matings. */
export const M12_LIFECYCLE_HUB = 'http://localhost:8836';

/** Hubs this worker process has already woken. */
const warmed = new Set<string>();

/**
 * Wakes a hub's authority before a page asks it for anything. The first connection to a hub
 * starts its Durable Object, which on a loaded runner (three dozen hubs starting at once) can take
 * longer than the game's 4 s hatch wait: the cell then swims as a practice cell and the scenario
 * waits for a creature that never comes. Waiting on the hub's own answer, bounded, keeps the
 * scenario independent of the runner's speed.
 */
export async function warmHub(hub: string): Promise<void> {
  if (warmed.has(hub)) return;
  const url = `${hub.replace(/^http/, 'ws')}/v1/hub`;
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`the hub at ${hub} did not accept a connection within 60 s`));
    }, 60_000);
    socket.onopen = () => {
      clearTimeout(timer);
      socket.close();
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`the hub at ${hub} refused a connection`));
    };
  });
  warmed.add(hub);
}

/** Opens the game against an M4 hub with no pinned body, so a hatch goes through the ledger. */
export async function openRecorded(page: Page, extra = '', hub = M4_HUB): Promise<void> {
  await warmHub(hub);
  await page.goto(`./?debug=1&hub=${hub}${extra}`);
  await page.waitForFunction(() => window.__bs?.ready === true);
  await page.waitForFunction(() => window.__bs?.state().playerId);
}

/** Clicks Hatch on the title screen without waiting for play to start. */
export const clickHatch = (page: Page) =>
  page.getByRole('button', { name: 'Hatch', exact: true }).click();

/**
 * Waits for play to start after a recorded hatch, which takes a beacon round (3 to 6 s). The egg
 * then waits up to 6 s for the player to crack it (M6c T11): by default this presses Enter as soon
 * as it stirs, as an impatient player would; `paced: true` leaves it to the player or its wait.
 */
export async function waitPlaying(page: Page, { paced = false } = {}): Promise<void> {
  await page.waitForFunction(
    (paced) => {
      const s = window.__bs?.state();
      if (!s) return false;
      // Pressed in the page, in the frame that sees the stir: on the title or death screen only,
      // since Enter in play opens the chat.
      if (!paced && s.screen !== 'playing' && s.egg.phase === 'stirring' && s.egg.paced) {
        dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }));
      }
      return s.screen === 'playing';
    },
    paced,
    { timeout: 15_000, polling: 'raf' },
  );
  const { width, height } = page.viewportSize() ?? { width: 960, height: 540 };
  await page.mouse.move(width / 2, height / 2);
}

/** Fills the creature's belly. */
export const topUp = (page: Page) =>
  page.evaluate(() => (window.__bs as BsHook).debug?.setEnergy(Number.MAX_SAFE_INTEGER));

/**
 * Runs the sim fast until the hub has credited the creature's maturity (seconds, on the M5
 * authorities). The hub credits at most the wall time (plus 2 s) per report, so fast play sends
 * the reports sooner. The belly is filled all the while, since 30x time would starve it.
 */
export const ripe = (page: Page, timeout = 60_000) =>
  page
    .waitForFunction(
      () => {
        const bs = window.__bs as BsHook;
        bs.debug?.setEnergy(Number.MAX_SAFE_INTEGER);
        bs.debug?.timeScale(30);
        const { activeMs, matureAtMs } = bs.state().life;
        if (matureAtMs === 0 || activeMs < matureAtMs) return false;
        bs.debug?.timeScale(1);
        return true;
      },
      undefined,
      { timeout },
    )
    .catch(async (error) => {
      const life = await page
        .evaluate(() => (window.__bs as BsHook).state().life)
        .catch(() => null);
      throw new Error(`never ripe: ${JSON.stringify(life)}`, { cause: error });
    });

/**
 * Parks the player beside a remote, as soon as the remote is drawn. `peer` is the remote's own page;
 * when given, a failure reports how that page sees itself (dead, hurt, silent).
 */
export async function goTo(page: Page, id: string, peer?: Page): Promise<void> {
  await page
    .waitForFunction((who) => window.__bs?.state().remotes.some((r) => r.id === who), id, {
      timeout: 20_000,
    })
    .catch(async (error) => {
      const seen = await page.evaluate(() => {
        const s = (window.__bs as BsHook).state();
        return {
          screen: s.screen,
          remotes: s.remotes.map((r) => r.id),
          world: s.world,
          net: s.net,
          alive: s.player?.alive ?? null,
        };
      });
      const theirs = await peer
        ?.evaluate(() => {
          const s = (window.__bs as BsHook).state();
          return {
            screen: s.screen,
            zone: s.zone,
            health: s.player?.health ?? null,
            alive: s.player?.alive ?? null,
            net: s.net.text,
          };
        })
        .catch(() => null);
      throw new Error(`the other player never showed: ${JSON.stringify({ ...seen, theirs })}`, {
        cause: error,
      });
    });
  // Teleport until the HUD sees the creature in reach: on a loaded runner the remote is still fading
  // in or has drifted by the time the first jump lands, and the mate hint stays hidden.
  const hint = page.getByTestId('mate-hint');
  await expect(async () => {
    await page.evaluate((who) => {
      const bs = window.__bs as BsHook;
      const r = bs.state().remotes.find((x) => x.id === who);
      if (r) bs.debug?.teleport(r.x + r.radius * 2.5, r.y);
    }, id);
    await expect(hint).toBeVisible({ timeout: 2_000 });
  })
    .toPass({ timeout: 40_000 })
    .catch(async (error) => {
      const seen = await page.evaluate((who) => {
        const s = (window.__bs as BsHook).state();
        const r = s.remotes.find((x) => x.id === who);
        return {
          player: s.player && { x: s.player.x, y: s.player.y },
          remote: r && { x: r.x, y: r.y, radius: r.radius },
          mate: s.mate,
        };
      }, id);
      throw new Error(`no mate hint beside the other player: ${JSON.stringify(seen)}`, {
        cause: error,
      });
    });
}

/**
 * A courts B until B's invitation shows. The first press can land before the hub has answered the
 * check, and on a loaded runner the two drift apart or B fades, so the key is offered no more:
 * park A beside B again, wait for the hint, press, and look at B, until B is invited.
 */
export async function courtUntilInvited(a: Page, b: Page, idB: string): Promise<void> {
  await expect(async () => {
    await goTo(a, idB);
    await expect(a.getByTestId('mate-hint')).toHaveText(/^E: court /, { timeout: 3_000 });
    await a.keyboard.press('e');
    await expect(b.getByTestId('invite')).toBeVisible({ timeout: 3_000 });
  }, 'A parks beside B, is offered the key and B is invited').toPass({ timeout: 40_000 });
}

/** What `document.elementFromPoint` finds at the egg's centre and at four points 0.8 of its radius out. */
export const atEgg = (page: Page) =>
  page.evaluate(() => {
    const at = (window.__bs as BsHook).state().egg.at;
    if (!at) return null;
    const d = 0.8 * at.r;
    const points = [
      [at.x, at.y],
      [at.x + d, at.y],
      [at.x - d, at.y],
      [at.x, at.y + d],
      [at.x, at.y - d],
    ] as const;
    return {
      at,
      hits: points.map(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el ? `${el.tagName.toLowerCase()}#${el.id}` : 'none';
      }),
    };
  });

/**
 * The share of the viewport the HUD covers (M6b T9): the menu button, the bars, the minimap with its
 * label and its depth gauge (M6c T12), and the elements of `extra` (the combat HUD's buttons, M7 T12).
 */
export const hudCover = (page: Page, extra: string[] = []) =>
  page.evaluate((extra) => {
    const parts = [
      document.querySelector('[data-testid="hud-menu"]'),
      ...document.querySelectorAll('.hud .stat'),
      document.querySelector('.minimap'),
      document.querySelector('[data-testid="minimap-depth"]'),
      ...extra.flatMap((selector) => [...document.querySelectorAll(selector)]),
    ].filter((el): el is HTMLElement => el instanceof HTMLElement && el.checkVisibility());
    const area = parts.reduce((sum, el) => {
      const r = el.getBoundingClientRect();
      return sum + r.width * r.height;
    }, 0);
    return { share: area / (innerWidth * innerHeight), parts: parts.length };
  }, extra);
