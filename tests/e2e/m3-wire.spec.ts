import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { GENOME_TEXT_LENGTH, genomeToBase64url, parseGenomeText } from '../../src/genome/codec';
import { bodyViolations } from '../../src/genome/develop';
import { genesisGenome } from '../../src/genome/genesis';
import { LOCI, MODULE_PARAMS } from '../../src/genome/karyotype';
import { buildCreature } from '../../src/genome/stats';
import { seedFromString } from '../../src/sim/prng';
import { buildGenome } from '../archetypes';
import { hatch, openGame, playerOf } from './helpers';

// Bodies on the wire (M3 T16), with scripted remotes: their snapshots go through the real codec and
// their genomes through the real parser, builder and renderer. The two-browser exchange through the
// hub is in m2-online.spec.ts.

const maxModules = Object.fromEntries(
  LOCI.filter((l) => l.kind === 'module').map((l) => [
    l.id,
    Object.fromEntries(MODULE_PARAMS.map((p) => [p, 255])),
  ]),
);

const HOSTILE: Record<string, string> = {
  allFF: '_'.repeat(GENOME_TEXT_LENGTH),
  allZero: 'A'.repeat(GENOME_TEXT_LENGTH),
  truncated: genomeToBase64url(genesisGenome(seedFromString('cut'))).slice(0, 120),
  maximal: genomeToBase64url(buildGenome(maxModules)),
};

async function scripted(
  page: Page,
  specs: { id: string; name: string; genome?: string; withholdGenome?: boolean }[],
): Promise<void> {
  const { x, y } = await playerOf(page);
  await page.evaluate(
    ({ specs, x, y }) => {
      (window.__bs as BsHook).debug?.setRemotes(
        specs.map((s, i) => ({
          ...s,
          x: x + 40 + (i % 6) * 14,
          y: y + 20 + Math.floor(i / 6) * 14,
        })),
      );
    },
    { specs, x, y },
  );
}

test('a remote with a delivered genome is drawn as its body; withheld, as the fallback cell', async ({
  page,
}) => {
  await openGame(page, '?debug=1&seed=wire');
  await hatch(page);
  const genome = genesisGenome(seedFromString('remote-body'));
  const expected = buildCreature(genome).hash;
  await scripted(page, [
    { id: 'with', name: 'With', genome: genomeToBase64url(genome) },
    { id: 'without', name: 'Without', genome: genomeToBase64url(genome), withholdGenome: true },
    { id: 'plain', name: 'Plain' },
  ]);
  await page.waitForFunction(() => (window.__bs as BsHook).render.info().remoteBodies === 1);
  const { remotes, info } = await page.evaluate(() => {
    const bs = window.__bs as BsHook;
    return { remotes: bs.state().remotes, info: bs.render.info() };
  });
  const hashes = Object.fromEntries(remotes.map((r) => [r.id, r.genomeHash]));
  expect(hashes).toEqual({ with: expected, without: null, plain: null });
  expect(remotes.find((r) => r.id === 'with')?.species).toMatch(/^[A-Z][a-z]+ [a-z]+$/);
  expect(info.remoteBodies).toBe(1);
  expect(info.remoteCells).toBe(2);
});

test('a remote body is scaled to its snapshot biomass', async ({ page }) => {
  await openGame(page, '?debug=1&seed=wire');
  await hatch(page);
  const text = genomeToBase64url(genesisGenome(seedFromString('scale')));
  const { x, y } = await playerOf(page);
  await page.evaluate(
    ({ text, x, y }) => {
      (window.__bs as BsHook).debug?.setRemotes([
        { id: 'big', name: 'Big', x: x + 400, y, genome: text, biomass: 40_000 },
      ]);
    },
    { text, x, y },
  );
  await page.waitForFunction(() => (window.__bs as BsHook).render.info().remoteBodies === 1);
  // Radius is √biomass; 40,000 survives the codec within 0.03%.
  const radius = await page.evaluate(() => (window.__bs as BsHook).state().remotes[0]?.radius);
  expect(radius).toBeGreaterThan(199.9);
  expect(radius).toBeLessThan(200.1);
});

test('hostile genomes neither throw nor break the budget (23 remotes at once)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await openGame(page, '?debug=1&seed=wire');
  await hatch(page);
  // Every built plan is valid, whatever the bytes.
  for (const [name, text] of Object.entries(HOSTILE)) {
    const genome = parseGenomeText(text);
    if (genome) expect(bodyViolations(buildCreature(genome).plan), name).toEqual([]);
  }
  const names = Object.keys(HOSTILE);
  const specs = Array.from({ length: 23 }, (_, i) => ({
    id: `hostile-${i}`,
    name: `H${i}`,
    genome: HOSTILE[names[i % names.length] as string] as string,
    biomass: 100 + i * 40,
  }));
  await scripted(page, specs);
  await page.waitForFunction(() => (window.__bs as BsHook).state().remotes.length === 23);
  // 3 of the 4 kinds parse (17 of 23) (truncated text is no genome); the rest stay cells.
  await page.waitForFunction(() => {
    const info = (window.__bs as BsHook).render.info();
    return info.remoteBodies + info.remoteCells === 23 && info.remoteBodies > 0;
  });
  const { info, net } = await page.evaluate(() => {
    const bs = window.__bs as BsHook;
    return { info: bs.render.info(), net: bs.state().net };
  });
  expect(info.remoteBodies).toBe(17);
  expect(info.remoteCells).toBe(6);
  expect(net.dropped).toBe(6);
  expect(info.triangles).toBeLessThan(300_000);
  expect(errors).toEqual([]);
});
