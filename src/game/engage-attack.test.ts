import { describe, expect, it } from 'vitest';
import { fighterOf } from '../genome/fighter';
import { starterGenome } from '../genome/starter';
import { buildCreature } from '../genome/stats';
import type { ClientMsg } from '../net/protocol';
import { engageRange, type Reacher, strikeDistance } from '../sim/encounter/reach';
import { RULES } from '../sim/rules';
import type { CreatureState } from '../sim/types';
import {
  Attack,
  type AttackHost,
  type AttackPeer,
  authorityRefusal,
  chooseTarget,
  ENGAGE_WAIT_MS,
  engageRefusal,
  fightKey,
  hintTarget,
  ProtectionWatch,
  refusalToast,
} from './engage';

const STARTER = fighterOf(buildCreature(starterGenome()));

/** A starter body at (x, y), facing east, of `biomass` (radius 20 at 400: tier 0). */
function reacher(id: string, x: number, y: number, biomass = 400): Reacher {
  const body: CreatureState = {
    id,
    x,
    y,
    vx: 0,
    vy: 0,
    heading: 0,
    biomass,
    energy: 100,
    health: 100,
    dashReadyTick: 0,
    alive: true,
    elder: false,
    cause: null,
    bornTick: 0,
    phys: STARTER.phys,
  };
  return { body, combat: STARTER.combat };
}

const self = reacher('me', 1000, 1000);

function peer(id: string, x: number, y: number, extra: Partial<AttackPeer> = {}, biomass = 400) {
  return {
    id,
    reacher: reacher(id, x, y, biomass),
    protected: false,
    fighting: false,
    signed: true,
    ...extra,
  } satisfies AttackPeer;
}

/** The centre distance at which a starter peer sits exactly `edge` wu outside `self`'s engage range. */
const range = engageRange(self, reacher('x', 0, 0));
const at = (edge: number) => 1000 + 20 + range + edge;

describe('engage refusals', () => {
  it('takes a comparable peer within the engage range', () => {
    const p = peer('b', at(-1), 1000);
    expect(strikeDistance(self.body, p.reacher.body)).toBeLessThan(range);
    expect(engageRefusal(self, p)).toBeNull();
  });

  it('refuses out of range, unsigned, protected, and two tiers apart', () => {
    expect(engageRefusal(self, peer('b', at(1), 1000))).toBe('range');
    expect(engageRefusal(self, peer('b', at(-1), 1000, { signed: false }))).toBe('range');
    expect(engageRefusal(self, peer('b', at(-1), 1000, { protected: true }))).toBe('protected');
    // Radius 200 is two tiers above radius 20; the other way round it is two below.
    expect(engageRefusal(self, peer('b', 1100, 1000, {}, 40_000))).toBe('bigger');
    expect(engageRefusal(reacher('big', 1000, 1000, 40_000), peer('b', 1100, 1000))).toBe(
      'smaller',
    );
    expect(RULES.encounter.maxTierGap).toBe(1);
  });
});

describe('joining a fight (M7 T15)', () => {
  it('takes a peer that is already fighting: the engage joins its fight', () => {
    const fighting = peer('b', at(-1), 1000, { fighting: true });
    expect(engageRefusal(self, fighting)).toBeNull();
    expect(hintTarget(self, [fighting])?.id).toBe('b');
    expect(engageRefusal(self, peer('b', at(1), 1000, { fighting: true }))).toBe('range');
  });

  it('tells a full fight and a pair in other fights apart', () => {
    expect(refusalToast(authorityRefusal('engage:full', false))).toBe('That fight is full');
    expect(refusalToast(authorityRefusal('engage:locked', false))).toBe('Already fighting');
  });
});

describe('the target F engages', () => {
  const near = peer('near', at(-6), 1000);
  const nearer = peer('nearer', at(-10), 1000);
  const aside = peer('aside', 1000, 1000 + 20 + range - 2);

  it('takes the creature under the cursor when it can be engaged', () => {
    const cursor = { x: aside.reacher.body.x, y: aside.reacher.body.y, pick: 2 };
    const choice = chooseTarget(self, [near, nearer, aside], cursor);
    expect(choice.target?.id).toBe('aside');
  });

  it('else the nearest it can engage, even with the cursor on one it cannot', () => {
    const shielded = peer('shielded', 1000, 1030, { protected: true });
    const cursor = { x: 1000, y: 1030, pick: 2 };
    expect(chooseTarget(self, [near, nearer, shielded], cursor).target?.id).toBe('nearer');
    expect(chooseTarget(self, [near, nearer], null).target?.id).toBe('nearer');
  });

  it("names none, or why the cursor's creature (else the nearest) cannot be engaged", () => {
    expect(chooseTarget(self, [], null)).toEqual({ target: null, refusal: 'none', peer: null });
    const far = peer('far', at(50), 1000);
    const shielded = peer('shielded', at(100), 1000, { protected: true });
    const choice = chooseTarget(self, [far, shielded], null);
    expect(choice.target).toBeNull();
    expect(choice.refusal).toBe('range');
    const onShielded = chooseTarget(self, [far, shielded], {
      x: shielded.reacher.body.x,
      y: 1000,
      pick: 2,
    });
    expect(onShielded.refusal).toBe('protected');
  });
});

describe('the "F" glyph', () => {
  it('marks the nearest engageable creature in range', () => {
    const peers = [peer('near', at(-2), 1000), peer('nearer', at(-8), 1000)];
    expect(hintTarget(self, peers)?.id).toBe('nearer');
  });

  it('is hidden when nobody is in range, or the only ones are protected', () => {
    expect(hintTarget(self, [])).toBeNull();
    expect(hintTarget(self, [peer('far', at(5), 1000)])).toBeNull();
    expect(hintTarget(self, [peer('s', at(-5), 1000, { protected: true })])).toBeNull();
    expect(hintTarget(self, [peer('u', at(-5), 1000, { signed: false })])).toBeNull();
  });
});

describe('combat key routing', () => {
  it('F attacks only outside a fight', () => {
    expect(fightKey('f', false, false)).toEqual({ t: 'attack' });
    expect(fightKey('F', false, false)).toEqual({ t: 'attack' });
    expect(fightKey('f', true, false)).toBeNull();
  });

  it('the stance and brace keys work only while locked', () => {
    for (const key of ['1', '2', '3', 'Shift']) expect(fightKey(key, false, false)).toBeNull();
    expect(fightKey('1', true, false)).toEqual({ t: 'stance', stance: 'aggressive' });
    expect(fightKey('2', true, false)).toEqual({ t: 'stance', stance: 'balanced' });
    expect(fightKey('3', true, false)).toEqual({ t: 'stance', stance: 'evasive' });
    expect(fightKey('Shift', true, false)).toEqual({ t: 'brace' });
    expect(fightKey('4', true, false)).toBeNull();
  });

  it('leaves the numbers to the wheel while it is open', () => {
    expect(fightKey('1', true, true)).toBeNull();
    expect(fightKey('3', true, true)).toBeNull();
    expect(fightKey('Shift', true, true)).toEqual({ t: 'brace' });
  });
});

describe('refusal toasts', () => {
  it('says each reason in a few words', () => {
    expect(refusalToast('protected', 12)).toBe('Protected for 12 s');
    expect(refusalToast('bigger')).toBe('Too big to fight');
    expect(refusalToast('range')).toBe('Too far');
    expect(refusalToast('fighting')).toBe('Already fighting');
  });

  it('counts down a protection from when it was first seen', () => {
    const watch = new ProtectionWatch();
    watch.update([{ id: 'b', spawnProtected: true }], 1000);
    expect(watch.leftSeconds('b', 1000)).toBe(RULES.encounter.protectionSeconds);
    expect(watch.leftSeconds('b', 4_500)).toBe(RULES.encounter.protectionSeconds - 3);
    watch.update([{ id: 'b', spawnProtected: false }], 5000);
    expect(watch.leftSeconds('b', 5000)).toBeNull();
  });
});

describe('Attack', () => {
  function rig(peers: AttackPeer[]) {
    const log: string[] = [];
    const sent: ClientMsg[] = [];
    let now = 0;
    const host: AttackHost = {
      self: () => self,
      peers: () => peers,
      cursor: () => null,
      engage: (target) =>
        ({
          t: 'engage',
          target,
          mine: { snap: 'a', sig: 'b' },
          theirs: { snap: 'c', sig: 'd' },
        }) satisfies ClientMsg,
      send: (msg) => {
        log.push('send');
        sent.push(msg);
      },
      ring: () => log.push('ring'),
      endShield: () => log.push('shield'),
      toast: (text) => log.push(`toast:${text}`),
      nowMs: () => now,
      protectedLeft: () => 9,
    };
    return { attack: new Attack(host), log, sent, tick: (ms: number) => (now += ms) };
  }

  it('shows the ring at once, ends its own protection and sends the engage', () => {
    const { attack, log, sent } = rig([peer('b', at(-4), 1000)]);
    expect(attack.press()).toBe(true);
    // The ring is asked for within the key press itself, before anything goes out.
    expect(log).toEqual(['ring', 'shield', 'send']);
    expect(sent[0]).toMatchObject({ t: 'engage', target: 'b' });
  });

  it('waits for the answer before another engage, then toasts a refusal', () => {
    const { attack, log, tick } = rig([peer('b', at(-4), 1000)]);
    attack.press();
    expect(attack.press()).toBe(false);
    attack.refused('engage:protected');
    expect(log.at(-1)).toBe('toast:Protected for 9 s');
    expect(attack.press()).toBe(true);
    tick(ENGAGE_WAIT_MS);
    expect(attack.press()).toBe(true);
    attack.refused('engage:locked');
    expect(log.at(-1)).toBe('toast:Already fighting');
  });

  it('toasts instead of engaging a creature it cannot, by the card button too', () => {
    const { attack, log, sent } = rig([peer('b', at(20), 1000)]);
    expect(attack.press()).toBe(false);
    expect(attack.press('b')).toBe(false);
    expect(log).toEqual(['toast:Too far', 'toast:Too far']);
    expect(sent).toEqual([]);
  });
});
