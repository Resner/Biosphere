import type { APIRequestContext, Browser } from '@playwright/test';
import { expect } from '@playwright/test';
import { clickHatch, openRecorded, state, waitPlaying } from './helpers';
import { type DirectoryView as M11View, directory as m11Directory, type Player } from './m11-steps';

// Shared by the M12 specs (M12 T4 on): the hub's placement as the E2E directory view shows it, and
// the distances ADR 0064 places by.

/** A directory member with the size it reported, and a spawn the hub gave in the last minute. */
export interface Sized {
  x: number;
  y: number;
  r: number;
  aoi: number;
}
export interface DirectoryView extends M11View {
  members: (M11View['members'][number] & Sized)[];
  spawns: (Sized & { t: number })[];
}

export const directory = (request: APIRequestContext, hub: string) =>
  m11Directory(request, hub) as Promise<DirectoryView>;

/** How far apart two creatures must be so neither is in the other's reach at once (`worker/placement.ts`). */
export const clearance = (a: Sized, b: Sized) => Math.max(a.aoi, b.aoi, 12 * Math.max(a.r, b.r));

/** P1 reach between two creatures: close enough to link at once. */
export const p1Reach = (a: Sized, b: Sized) => 8 * Math.max(a.r, b.r) + 600;

export const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

/** The hub's last `spawn` answer to this page (M12 T4). */
export async function spawnOf(p: Player) {
  const spawn = (await state(p.page)).spawn;
  expect(spawn, 'the page has a spawn answer').not.toBeNull();
  return spawn as NonNullable<typeof spawn>;
}

/**
 * Waits until the hub's world is empty: nobody in the directory and no spawn of the last minute,
 * which an earlier run against the same hub leaves for up to 60 s.
 */
export async function emptyWorld(request: APIRequestContext, hub: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const view = await directory(request, hub);
        const now = Date.now();
        return view.members.length + view.spawns.filter((s) => now - s.t < 60_000).length;
      },
      { message: 'the hub’s world is empty', timeout: 75_000, intervals: [1000] },
    )
    .toBe(0);
}

/** Opens a player on `hub` and hatches a recorded creature (a genesis, spawn-protected). */
export async function joinRecorded(browser: Browser, hub: string, query = ''): Promise<Player> {
  const page = await (await browser.newContext()).newPage();
  await openRecorded(page, query, hub);
  await clickHatch(page);
  await waitPlaying(page);
  return { page, id: (await state(page)).playerId as string };
}

/** Reloads a recorded player's page and resumes its creature from the title. */
export async function reloadAndResume(p: Player): Promise<void> {
  await p.page.reload();
  await p.page.waitForFunction(() => window.__bs?.ready === true);
  await p.page.waitForFunction(() => window.__bs?.state().playerId);
  await clickHatch(p.page);
  await waitPlaying(p.page);
}
