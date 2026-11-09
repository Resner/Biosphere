import { describe, expect, it } from 'vitest';
import { GOLDEN_SET_NAMES } from '../src/game/golden-names';
import { COMPUTED_SETS, runGolden } from '../src/game/goldens';
import { goldenFiles, NODE_ONLY, SETS } from './goldens-catalogue';

describe('the golden catalogue', () => {
  const covered = new Set(SETS.flatMap((s) => s.files));

  it('lists every golden file, as a set or as Node-only with its reason', () => {
    for (const file of goldenFiles()) {
      const inSet = covered.has(file);
      const nodeOnly = file in NODE_ONLY;
      expect(inSet || nodeOnly, `${file} is in no set and not in NODE_ONLY`).toBe(true);
      expect(inSet && nodeOnly, `${file} is both in a set and Node-only`).toBe(false);
    }
  });

  it('names no file that does not exist, and gives every Node-only file a reason', () => {
    const files = new Set(goldenFiles());
    for (const file of [...covered, ...Object.keys(NODE_ONLY)]) {
      expect(files.has(file), `${file} does not exist`).toBe(true);
    }
    for (const [file, reason] of Object.entries(NODE_ONLY)) {
      expect(reason.length, `${file} needs a reason`).toBeGreaterThan(20);
    }
  });

  it("the page's set names are the sets this catalogue and goldens.ts have", () => {
    expect([...GOLDEN_SET_NAMES].sort()).toEqual(SETS.map((s) => s.name).sort());
    expect([...COMPUTED_SETS].sort()).toEqual([...GOLDEN_SET_NAMES].sort());
  });

  for (const set of SETS) {
    it(`${set.name}: Node computes the golden from the catalogue's input`, () => {
      const output = JSON.parse(JSON.stringify(runGolden(set.name, set.input())));
      expect(output).toEqual(set.expected());
    });
  }
});
