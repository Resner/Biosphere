import type { Page } from '@playwright/test';
import { state } from './helpers';

// Shared by the M9 hub specs that mate: the step after a mating, taking the child over.

/** Presses H and cracks the egg, and waits until the child is the player's creature, playing. */
export async function takeOver(page: Page): Promise<string> {
  await page.waitForFunction(() => window.__bs?.state().offspring.kind === 'card', undefined, {
    timeout: 40_000,
  });
  const child = (await state(page)).offspring.creature as string;
  await page.keyboard.press('h');
  // The hatch waits up to 6 s for the player to crack it (M6c T11): Enter cracks it now.
  await page.keyboard.press('Enter');
  await page
    .waitForFunction(
      (id) => {
        const life = window.__bs?.state().life;
        return life?.creature === id && life.status === 'playing';
      },
      child,
      { timeout: 20_000 },
    )
    .catch((error) => {
      throw new Error('the child never became the player creature', { cause: error });
    });
  return child;
}
