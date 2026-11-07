import { describe, expect, it } from 'vitest';
import type { FightMsg } from '../net/hub-client';
import type { FighterInfo } from '../net/protocol';
import type { CreatureNow } from './online';
import { FIGHT_HOLD_MS } from './online-links';
import { C, nearMsg, settled, welcome } from './online-test-kit';

// A fight's links (M11 T16): every other fighter is P0 from `enc-start` (or the page's own
// `enc-join`) until 3 s after `enc-end`, whatever the distance, the leaf or the tier, and then
// closes unless another class holds it.

const ENC = 'e'.repeat(64);
const start = (players: string[], enc = ENC): FightMsg => ({
  t: 'enc-start',
  enc,
  seed: 's',
  round: 0,
  t0: 0,
  at: 0,
  fighters: players.map((player) => ({ player }) as FighterInfo),
});
const join = (player: string, enc = ENC): FightMsg => ({
  t: 'enc-join',
  enc,
  f: 10,
  fighter: { player } as FighterInfo,
});
const end = (enc = ENC) => ({ t: 'enc-end', enc }) as FightMsg;
const starter = (over: Partial<CreatureNow> = {}): CreatureNow => ({
  x: C,
  y: C,
  vx: 0,
  vy: 0,
  r: 10,
  adultR: 20,
  inWater: true,
  ...over,
});

describe('OnlineSession: a fight’s links (M11 T16)', () => {
  it('holds a fighter’s links across a leaf crossing and a growth into a tier, and closes them 3 s after the end', () => {
    const { hub, mesh, session, run, setCreature } = settled();
    hub.world(nearMsg([['b', 200]]));
    mesh.join('b');
    run(600);
    expect(session.links.classOf('b')).toBe(1);
    hub.fight(start(['b', 'me']));
    expect(session.links.classOf('b')).toBe(0);

    // A dash across a leaf's edge, 9,000 wu on: far past every class but P0.
    setCreature(starter({ x: C + 9000 }));
    hub.world({ t: 'leaf', leaf: { x: C, y: 0, size: 131_072 } });
    run(2000);
    expect(session.links.classOf('b')).toBe(0);
    // The kill's growth: two tiers up, where `linkTiers` never links the two.
    setCreature(starter({ x: C + 300, r: 400, adultR: 400 }));
    run(2000);
    expect(session.links.classOf('b')).toBe(0);
    expect(mesh.disconnects).toEqual([]);

    hub.fight(end());
    run(FIGHT_HOLD_MS - 500);
    expect(session.links.classOf('b')).toBe(0);
    expect(mesh.disconnects).toEqual([]);
    run(1000);
    expect(mesh.disconnects).toEqual(['b']);
    expect(session.links.classOf('b')).toBeNull();
  });

  it('keeps a fight’s link after the end while another class holds it', () => {
    const { hub, mesh, session, run } = settled();
    hub.world(nearMsg([['b', 200]]));
    mesh.join('b');
    hub.fight(start(['me', 'b']));
    hub.fight(end());
    run(FIGHT_HOLD_MS + 2000);
    expect(session.links.classOf('b')).toBe(1);
    expect(mesh.disconnects).toEqual([]);
  });

  it('dials far fighters at once, and takes a joiner’s and its own join', () => {
    const { hub, mesh, session } = settled();
    // An `enc-start` that doesn't name this page is the catch-up of a fight it joins.
    hub.fight(start(['a', 'b']));
    expect(mesh.connects.sort()).toEqual(['a', 'b']);
    hub.fight(join('c'));
    hub.fight(join('me'));
    expect(mesh.connects.sort()).toEqual(['a', 'b', 'c']);
    for (const id of ['a', 'b', 'c']) expect(session.links.classOf(id)).toBe(0);
  });

  it('holds a fight’s links on the title, and lets them go 3 s after a welcome that resyncs no fight', () => {
    const { hub, mesh, session, run, setCreature } = settled();
    setCreature(null);
    hub.fight(start(['me', 'b']));
    mesh.join('b');
    run(1000);
    expect(session.links.classOf('b')).toBe(0);
    // A reconnect whose resync brings the fight back keeps it.
    hub.welcome(welcome());
    hub.fight(start(['me', 'b']));
    run(FIGHT_HOLD_MS + 1000);
    expect(mesh.disconnects).toEqual([]);
    // One that doesn't: the fight settled while this page was away.
    hub.welcome(welcome());
    run(FIGHT_HOLD_MS + 1000);
    expect(mesh.disconnects).toEqual(['b']);
  });

  it('counts the links of P0 and P1 it wants, for the witness availability', () => {
    const { hub, session } = settled();
    expect(session.protectedLinks()).toBe(0);
    hub.world(
      nearMsg([
        ['a', 100],
        ['b', 200],
        ['c', 5000],
      ]),
    );
    hub.fight(start(['me', 'f']));
    // a and b are P1, f is P0, c is P4.
    expect(session.protectedLinks()).toBe(3);
  });
});
