import { expect, type Page, test } from '@playwright/test';
import type { AudioRenderOptions } from '../../src/audio/engine';
import type { BsHook } from '../../src/game/debug';
import { openGame } from './helpers';

// The audio engine rendered offline (M6 T22): the same graph the game plays, built on an
// `OfflineAudioContext` in Chromium, so loudness, clipping, mute and determinism are measured on
// real samples. No gesture or speaker is involved.

const ZONES = ['shallows', 'twilight', 'deep', 'abyss'] as const;

const render = (page: Page, options: AudioRenderOptions) =>
  page.evaluate((o) => (window.__bs as BsHook).audio.render(o), options);

test.beforeEach(async ({ page }) => {
  await openGame(page, '?seed=audio');
});

test('each zone ambience is audible and never clips, at full volume', async ({ page }) => {
  for (const zone of ZONES) {
    const loud = await render(page, { zone, seed: 7, seconds: 3, volume: 100, muted: false });
    expect(loud.rmsDb, `${zone} rms`).toBeGreaterThan(-50);
    expect(loud.peakDb, `${zone} peak`).toBeLessThanOrEqual(-1);
    expect(loud.silent).toBe(false);
  }
});

test('the default volume stays audible in every zone', async ({ page }) => {
  for (const zone of ZONES) {
    const quiet = await render(page, { zone, seed: 7, seconds: 3, volume: 60, muted: false });
    expect(quiet.rmsDb, `${zone} rms`).toBeGreaterThan(-50);
  }
});

test('the zones sound different: the shallows are brighter, the abyss lower', async ({ page }) => {
  const shallows = await render(page, { zone: 'shallows', seed: 7, seconds: 3, volume: 100 });
  const abyss = await render(page, { zone: 'abyss', seed: 7, seconds: 3, volume: 100 });
  // The share of energy above 2 kHz (from the first difference) separates airy from dark.
  expect(shallows.brightness).toBeGreaterThan(abyss.brightness * 3);
});

test('mute renders digital silence', async ({ page }) => {
  for (const zone of ZONES) {
    const muted = await render(page, { zone, seed: 7, seconds: 2, volume: 100, muted: true });
    expect(muted.silent, zone).toBe(true);
    expect(muted.peakDb).toBe(Number.NEGATIVE_INFINITY);
  }
  const zero = await render(page, { zone: 'twilight', seed: 7, seconds: 2, volume: 0 });
  expect(zero.silent).toBe(true);
});

test('two renders with the same seed are sample-identical', async ({ page }) => {
  const a = await render(page, { zone: 'deep', seed: 11, seconds: 2, volume: 80 });
  const b = await render(page, { zone: 'deep', seed: 11, seconds: 2, volume: 80 });
  expect(a.hash).toBe(b.hash);
  expect(a.length).toBe(b.length);
  const other = await render(page, { zone: 'deep', seed: 12, seconds: 2, volume: 80 });
  expect(other.hash).not.toBe(a.hash);
});
