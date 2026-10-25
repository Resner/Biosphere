import { expect, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { hatch, openGame, playerOf } from './helpers';

// Remote creatures are drawn from snapshots. Until the online session exists (T13), scripted
// remotes feed the real sender, codec, buffer and renderer.

const REMOTES = [
  { id: 'peer-alpha', name: 'Alpha', x: 0, y: 0, vx: 0, vy: 0 },
  { id: 'peer-beta', name: 'Beta', x: 0, y: 0, vx: 0, vy: 0 },
  { id: 'peer-gamma', name: 'Gamma', x: 0, y: 0, vx: 8, vy: 0 },
];

test('three remotes share one scene within the draw budget, with names', async ({ page }) => {
  await openGame(page, '?debug=1&seed=remotes');
  await hatch(page);
  const player = await playerOf(page);
  const offsets = [
    [30, 18],
    [-30, 18],
    [0, -30],
  ] as const;
  await page.evaluate(
    ({ remotes, x, y, offsets }) => {
      const bs = window.__bs as BsHook;
      bs.debug?.setRemotes(
        remotes.map((r, i) => ({
          ...r,
          x: x + (offsets[i]?.[0] ?? 0),
          y: y + (offsets[i]?.[1] ?? 0),
        })),
      );
    },
    { remotes: REMOTES, x: player.x, y: player.y, offsets },
  );

  await page.waitForFunction(() => {
    const bs = window.__bs as BsHook;
    return bs.state().remotes.length === 3 && bs.state().remotes.every((r) => r.alpha === 1);
  });
  // A frame later the cells are in the scene.
  await page.waitForFunction(() => (window.__bs as BsHook).render.info().remoteCells === 3);

  const { info, remotes } = await page.evaluate(() => {
    const bs = window.__bs as BsHook;
    return { info: bs.render.info(), remotes: bs.state().remotes };
  });
  expect(info.remoteCells).toBe(3);
  expect(info.calls).toBeLessThanOrEqual(60);
  expect(info.triangles).toBeLessThanOrEqual(120_000);
  // Gamma swims east, so its drawn position advances.
  const gamma = remotes.find((r) => r.id === 'peer-gamma');
  await page.waitForFunction((x) => {
    const now = (window.__bs as BsHook).state().remotes.find((r) => r.id === 'peer-gamma');
    return (now?.x ?? 0) > x + 2;
  }, gamma?.x ?? 0);
  expect(remotes.map((r) => r.name).sort()).toEqual(['Alpha', 'Beta', 'Gamma']);

  const labels = await page
    .locator('[data-testid="remote-labels"] .remote-label:visible')
    .allTextContents();
  expect(labels.sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
});

test('a remote cell shows against the water', async ({ page }) => {
  await openGame(page, '?debug=1&seed=remotes');
  await hatch(page);
  const player = await playerOf(page);
  await page.evaluate(
    ({ x, y }) => {
      (window.__bs as BsHook).debug?.setRemotes([
        { id: 'peer-gamma', name: 'Gamma', x: x + 35, y },
      ]);
    },
    { x: player.x, y: player.y },
  );
  await page.waitForFunction(() => (window.__bs as BsHook).render.info().remoteCells === 1);

  const png = await page.locator('#scene').screenshot();
  const { pxPerWu } = await page.evaluate(() => (window.__bs as BsHook).render.info());
  const at = await page.evaluate(() => {
    const bs = window.__bs as BsHook;
    const { camX, camY } = bs.render.fx();
    const remote = bs.state().remotes[0];
    return { camX, camY, x: remote?.x ?? 0, y: remote?.y ?? 0 };
  });
  const luma = await page.evaluate(
    async ({ base64, px, py, radiusPx }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const scratch = document.createElement('canvas');
      scratch.width = image.width;
      scratch.height = image.height;
      const context = scratch.getContext('2d');
      if (!context) throw new Error('2D canvas unavailable');
      context.drawImage(image, 0, 0);
      const scale = image.width / innerWidth;
      const { data } = context.getImageData(0, 0, image.width, image.height);
      let ring = 0;
      let ringCount = 0;
      let far = 0;
      let farCount = 0;
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          const d = Math.hypot(x / scale - px, y / scale - py) / radiusPx;
          const i = (y * image.width + x) * 4;
          const l =
            0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
          if (d >= 0.85 && d <= 1.05) {
            ring += l;
            ringCount++;
          } else if (d >= 2.2 && d <= 2.6) {
            far += l;
            farCount++;
          }
        }
      }
      return { ring: ring / ringCount, far: far / farCount };
    },
    {
      base64: png.toString('base64'),
      px: 480 + (at.x - at.camX) * pxPerWu,
      py: 270 - (at.y - at.camY) * pxPerWu,
      radiusPx: 10 * pxPerWu,
    },
  );
  expect(luma.ring).toBeGreaterThan(luma.far * 1.3);
});

test('dropping the scripted remotes clears the pond', async ({ page }) => {
  await openGame(page, '?debug=1&seed=remotes');
  await hatch(page);
  const player = await playerOf(page);
  await page.evaluate(
    ({ x, y }) => {
      (window.__bs as BsHook).debug?.setRemotes([{ id: 'peer-a', name: 'A', x: x + 30, y }]);
    },
    { x: player.x, y: player.y },
  );
  await page.waitForFunction(() => (window.__bs as BsHook).state().remotes.length === 1);
  // Removing the script stops the snapshots; the pond forgets the member at once.
  await page.evaluate(() => (window.__bs as BsHook).debug?.setRemotes([]));
  await page.waitForFunction(() => (window.__bs as BsHook).state().remotes.length === 0);
});
