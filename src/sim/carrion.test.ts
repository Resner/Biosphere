import { describe, expect, it } from 'vitest';
import { STARTER_PHYS } from './body';
import { carrionNear, dropCarrion, pieceCount } from './carrion';
import { applyFeeding, applyRemoteClaim, consumeFood } from './food';
import { hashWorld } from './state-hash';
import { step } from './step';
import type { World } from './types';
import { createWorld, spawnCreature } from './world';

const ENC = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const DROP = { enc: ENC, x: 3000, y: 3000, biomass: 400, radius: 20, tick: 100 };
const world = (seed = 'carrion'): World => createWorld({ seed, currents: false, hazards: false });
const withMouth = (type: number) => ({
  ...STARTER_PHYS,
  mouth: { ...STARTER_PHYS.mouth, type },
});

describe('dropCarrion', () => {
  it('gives identical pieces on two worlds, sorted by id', () => {
    const [a, b] = [world(), world()];
    dropCarrion(a, DROP);
    dropCarrion(b, DROP);
    expect(a.carrion).toEqual(b.carrion);
    expect(hashWorld(a)).toBe(hashWorld(b));
    expect(a.carrion.map((p) => p.id)).toEqual([...a.carrion.map((p) => p.id)].sort());
    expect(a.carrion[0]?.id).toBe('xa1b2c3d4_0');
  });

  it('splits 40% of the biomass at 3 energy per unit into radius ÷ 3 pieces, 3 to 12', () => {
    const w = world();
    dropCarrion(w, DROP);
    expect(w.carrion).toHaveLength(7);
    expect(w.carrion.reduce((sum, p) => sum + p.value, 0)).toBeCloseTo(0.4 * 400 * 3, 6);
    expect(pieceCount(1)).toBe(3);
    expect(pieceCount(400)).toBe(12);
  });

  it('sizes a piece by 1.5 + 0.08 × the victim radius and scatters within 2 victim radii', () => {
    const w = world();
    dropCarrion(w, DROP);
    for (const p of w.carrion) {
      expect(p.radius).toBeCloseTo(1.5 + 0.08 * 20, 9);
      expect(Math.hypot(p.x - 3000, p.y - 3000)).toBeLessThanOrEqual(2 * 20 + 1e-9);
      expect(p.expires).toBe(1900);
    }
    expect(new Set(w.carrion.map((p) => `${p.x},${p.y}`)).size).toBe(w.carrion.length);
  });

  it('ignores a drop heard twice and keeps the pieces of a second kill', () => {
    const w = world();
    dropCarrion(w, DROP);
    dropCarrion(w, DROP);
    expect(w.carrion).toHaveLength(7);
    dropCarrion(w, { ...DROP, enc: `ff${ENC.slice(2)}`, x: 500 });
    expect(w.carrion).toHaveLength(14);
  });

  it('stays inside the world', () => {
    const w = world();
    dropCarrion(w, { ...DROP, x: 0, y: w.size, radius: 200 });
    for (const p of w.carrion) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(w.size);
    }
  });
});

describe('eating carrion', () => {
  /** A creature with a mouth of `type` sitting on the first piece, and that piece's value. */
  function onPiece(type: number) {
    const w = world();
    dropCarrion(w, DROP);
    const piece = w.carrion[0];
    if (!piece) throw new Error('no piece');
    const creature = spawnCreature(w, { id: 'p', x: piece.x, y: piece.y, phys: withMouth(type) });
    creature.energy = 10;
    return { w, piece, creature };
  }

  it('gives a jaw the whole value, a middle mouth 0.8 and a filter mouth 0.3', () => {
    for (const [type, share] of [
      [1, 1],
      [0.5, 0.8],
      [0, 0.3],
    ] as const) {
      const { w, piece, creature } = onPiece(type);
      const events = applyFeeding(w, creature);
      expect(events).toContainEqual({
        type: 'eat',
        creature: 'p',
        food: piece.id,
        value: piece.value * share,
      });
      expect(creature.energy).toBeCloseTo(10 + piece.value * share, 6);
    }
  });

  it('removes an eaten piece from the water and keeps the energy cap', () => {
    const { w, piece, creature } = onPiece(1);
    applyFeeding(w, creature);
    expect(carrionNear(w, piece.x, piece.y, 50).map((p) => p.id)).not.toContain(piece.id);
    const full = onPiece(1);
    full.creature.energy = 1e9;
    expect(applyFeeding(full.w, full.creature)).toEqual([]);
    expect(carrionNear(full.w, full.piece.x, full.piece.y, 1)).toContainEqual(full.piece);
  });

  it('lets pieces vanish at 1,800 ticks', () => {
    const { w, piece } = onPiece(1);
    w.tick = piece.expires - 1;
    expect(carrionNear(w, piece.x, piece.y, 1)).toHaveLength(1);
    w.tick = piece.expires;
    expect(carrionNear(w, piece.x, piece.y, 1)).toHaveLength(0);
    dropCarrion(w, { ...DROP, enc: `ee${ENC.slice(2)}`, tick: w.tick });
    expect(w.carrion.find((p) => p.id === piece.id)).toBeUndefined();
  });

  it('never respawns an eaten piece, and skips one whose claim came first', () => {
    const w = world();
    expect(applyRemoteClaim(w, { slot: 'xa1b2c3d4_2', k: 0, tick: 0 })).toBe(true);
    dropCarrion(w, DROP);
    expect(w.carrion.map((p) => p.id)).not.toContain('xa1b2c3d4_2');
    expect(applyRemoteClaim(w, { slot: 'xa1b2c3d4_2', k: 1, tick: 0 })).toBe(false);
    expect(() => consumeFood(w, 'xa1b2c3d4_2')).toThrow();
  });
});

describe('the state hash', () => {
  it('is unchanged by an empty carrion list, and covers what is on the water', () => {
    const w = world();
    const empty = hashWorld(w);
    expect(hashWorld(w)).toBe(empty);
    dropCarrion(w, DROP);
    const dropped = hashWorld(w);
    expect(dropped).not.toBe(empty);
    w.tick = 5000;
    expect(hashWorld(w)).toBe(hashWorld({ ...w, carrion: [] }));
  });

  it('pins a replay that drops carrion and eats it', () => {
    const w = world('carrion-golden');
    dropCarrion(w, DROP);
    const piece = w.carrion[3];
    if (!piece) throw new Error('no piece');
    spawnCreature(w, { id: 'p', x: piece.x - 30, y: piece.y, phys: withMouth(1) });
    let eaten = 0;
    for (let i = 0; i < 90; i++) {
      const events = step(w, { p: { steer: 0, throttle: 15, dash: false } });
      eaten += events.filter((e) => e.type === 'eat' && e.food === piece.id).length;
    }
    expect(eaten).toBe(1);
    expect(hashWorld(w)).toBe('9b36078710317eb9');
  });
});
