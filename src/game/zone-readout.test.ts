import { describe, expect, it } from 'vitest';
import { zoneReadout } from './zone-readout';

const phys = (uvTolerance: number, pressureTolerance: number) => ({
  uvTolerance,
  pressureTolerance,
});

describe('zoneReadout', () => {
  it('names the zone and the depth', () => {
    expect(zoneReadout(0.1, phys(0, 0), true)).toMatchObject({
      zone: 'shallows',
      name: 'Shallows',
      depth: 0.1,
    });
    expect(zoneReadout(0.4, phys(0, 0), true)).toMatchObject({
      zone: 'twilight',
      name: 'Twilight',
    });
    expect(zoneReadout(0.6, phys(0, 0), true)).toMatchObject({ zone: 'deep', name: 'Deep' });
    expect(zoneReadout(0.9, phys(0, 0), true)).toMatchObject({ zone: 'abyss', name: 'Abyss' });
  });

  it('shows the UV cue only where UV burns a creature with tolerance below 1', () => {
    expect(zoneReadout(0.1, phys(0.5, 0), true).uv).toBe(true);
    expect(zoneReadout(0.1, phys(1, 0), true).uv).toBe(false);
    expect(zoneReadout(0.4, phys(0, 0), true).uv).toBe(false);
    expect(zoneReadout(0.1, phys(0, 0), false).uv).toBe(false);
  });

  it('shows the pressure cue from depth 0.7 for a creature with tolerance below 1', () => {
    expect(zoneReadout(0.9, phys(0, 0.2), true).pressure).toBe(true);
    expect(zoneReadout(0.75, phys(0, 0.2), true).pressure).toBe(true);
    expect(zoneReadout(0.65, phys(0, 0.2), true).pressure).toBe(false);
    expect(zoneReadout(0.9, phys(0, 1), true).pressure).toBe(false);
    expect(zoneReadout(0.9, phys(0, 0), false).pressure).toBe(false);
  });
});
