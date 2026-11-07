import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { hatch, openGame, state } from './helpers';

// Shared by the M11 link specs (M11 T13): players on one hub, placed relative to the world's
// centre, and what each page and the hub say about the links.

/** The world's centre, where the hub's ring of spawns sits (ADR 0061). */
export const CENTRE = 131_072;

export interface Player {
  page: Page;
  id: string;
}

/**
 * Opens a player on `hub` and hatches it, one after the other so each lands as the last left it;
 * `query` adds to the page's query (`&quality=medium`).
 */
export async function join(browser: Browser, hub: string, query = ''): Promise<Player> {
  const page = await (await browser.newContext()).newPage();
  await openGame(page, `?debug=1&hub=${hub}${query}`);
  await page.waitForFunction(() => window.__bs?.state().playerId);
  await hatch(page);
  return { page, id: (await state(page)).playerId as string };
}

/** Moves a player to (`dx`, `dy`) from the world's centre and stops it. */
export const place = (p: Player, dx: number, dy: number) =>
  p.page.evaluate(
    ([x, y]) => (window.__bs as BsHook).debug?.teleport(x as number, y as number),
    [CENTRE + dx, CENTRE + dy],
  );

/** The page's links whose hello passed, by id. */
export const linked = async (p: Player): Promise<string[]> =>
  (await state(p.page)).net.links
    .filter((l) => l.hello)
    .map((l) => l.id)
    .sort();

/** Waits until the page's linked peers are exactly `ids`. */
export async function linksAre(p: Player, ids: string[], message: string, timeout = 30_000) {
  await expect
    .poll(() => linked(p), { message, timeout, intervals: [200] })
    .toEqual([...ids].sort());
}

export interface DirectoryView {
  leaves: { leaf: { x: number; y: number; size: number }; members: number }[];
  members: { id: string; x: number; y: number; leaf: { x: number; y: number; size: number } }[];
  relays: Record<string, number>;
}

/** The hub's directory and relay counts (`GET /v1/e2e/directory`). */
export async function directory(request: APIRequestContext, hub: string): Promise<DirectoryView> {
  const res = await request.get(`${hub}/v1/e2e/directory`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as DirectoryView;
}

/** The hub's relay count for a pair of players. */
export const relaysOf = (view: DirectoryView, a: string, b: string): number =>
  view.relays[[a, b].sort().join(':')] ?? 0;

export const closeAll = (players: Player[]) =>
  Promise.all(players.map((p) => p.page.context().close()));
