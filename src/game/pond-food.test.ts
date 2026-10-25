import { describe, expect, it } from 'vitest';
import type { PeerEvent } from '../net/protocol';
import { step } from '../sim/step';
import { createWorld, spawnCreature } from '../sim/world';
import { PondFood } from './pond-food';

/** A player parked on the first item of a cell, with room to eat. */
function eater(id: string, tick: number) {
  const world = createWorld({ seed: 'pond-food', currents: false, hazards: false });
  world.tick = tick;
  return { world, id };
}

describe('PondFood', () => {
  it('sends a claim for each bite, tagged with the tick the step ran at', () => {
    const { world } = eater('A', 100);
    const sent: PeerEvent[] = [];
    const food = new PondFood('A', (e) => sent.push(e));
    const probe = world.size / 4;
    const creature = spawnCreature(world, { id: 'A', x: probe, y: probe });
    creature.energy = 1;
    const ticks: number[] = [];
    for (let i = 0; i < 600 && sent.length === 0; i++) {
      const at = world.tick;
      const events = step(world, {});
      food.onEat(events, at);
      ticks.push(at);
      creature.x += 3; // sweep along a row until something is eaten
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: 'claim', k: 0, tick: ticks[ticks.length - 1] });
  });

  it('hands back the stolen bite when an earlier claim arrives', () => {
    const { world } = eater('B', 103);
    const food = new PondFood('B', () => {});
    food.onEat([{ type: 'eat', creature: 'B', food: 'c3_5_s2_k0', value: 12 }], 103);
    const stolen = food.receive(world, 'A', { t: 'claim', slot: 'c3_5_s2', k: 0, tick: 100 });
    expect(stolen).toEqual({ slot: 'c3_5_s2', k: 0, value: 12 });
  });
});
