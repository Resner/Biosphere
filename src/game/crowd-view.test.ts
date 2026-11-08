import { describe, expect, it } from 'vitest';
import type { FightMsg } from '../net/hub-client';
import { CROWD_AT } from '../net/instance';
import type { ClientMsg, FighterInfo, PeerEvent } from '../net/protocol';
import { BUSY_EVERY_MS, CrowdView, WATER_CHANGE_MS } from './crowd-view';
import { C, nearMsg, settled, snap } from './online-test-kit';

// Crowd instances in the page (M12 T6, ADR 0064): links follow the water, the crowd list goes in
// the `where`, and a creature that stops sharing water is told to the app to fade.

const ENC = 'e'.repeat(64);
const instance = (n: number) => ({ t: 'instance', n }) as const;
const wheres = (sent: ClientMsg[]) =>
  sent.filter((m): m is Extract<ClientMsg, { t: 'where' }> => m.t === 'where');

/** A settled session linked to each of `peers` (id, dx, instance), with the hello naming it. */
function linkedTo(peers: [id: string, dx: number, n: number][]) {
  const rig = settled();
  rig.hub.world(nearMsg(peers));
  for (const [id, , n] of peers) {
    rig.mesh.helloN.set(id, n);
    rig.mesh.join(id);
  }
  rig.run(600);
  rig.mesh.disconnects.length = 0;
  rig.mesh.events.length = 0;
  return rig;
}

describe('OnlineSession: crowd instances (M12 T6)', () => {
  it('`instance { n: 2 }` closes the links to instance-1 peers at once and keeps those in 0 and 2', () => {
    const { hub, mesh, session, handlers } = linkedTo([
      ['a0', 200, 0],
      ['b1', 250, 1],
      ['c2', 300, 2],
    ]);
    hub.world(instance(2));
    // At once: no tick, no plan's 500 ms, no 3 s grace.
    expect(mesh.disconnects).toEqual(['b1']);
    expect(session.netInfo().instance).toMatchObject({ n: 2, changes: 1 });
    expect(handlers.busy).toHaveBeenCalledTimes(1);
    // Every link heard the page's new instance before any closed.
    const told = mesh.events.filter(([, e]) => e.t === 'instance').map(([id]) => id);
    expect(told.sort()).toEqual(['a0', 'b1', 'c2']);
  });

  it('a hello naming another instance closes the link', () => {
    const { hub, mesh, run } = settled();
    hub.world(instance(1));
    hub.world(nearMsg([['x', 200, 1]]));
    mesh.helloN.set('x', 2);
    mesh.join('x');
    expect(mesh.disconnects).toEqual(['x']);
    run(1000);
    expect(mesh.open.has('x')).toBe(false);
  });

  it('never dials a gossip entry from another instance', () => {
    const { hub, mesh, run } = linkedTo([['v', 100, 0]]);
    hub.world(instance(1));
    mesh.state('v', snap(100), null);
    const gossip: PeerEvent = {
      t: 'peers',
      list: [
        ['w2', C + 150, C, 10, 2],
        ['w1', C - 150, C, 10, 1],
      ],
    };
    mesh.event('v', gossip);
    run(3000);
    expect(mesh.connects).toContain('w1');
    expect(mesh.connects).not.toContain('w2');
  });

  it('keeps a fight’s opponent in another instance linked', () => {
    const { hub, mesh, run } = settled();
    hub.world(instance(1));
    hub.fight({
      t: 'enc-start',
      enc: ENC,
      seed: 's',
      round: 0,
      t0: 0,
      at: 0,
      fighters: [{ player: 'me' }, { player: 'f' }] as FighterInfo[],
    } as FightMsg);
    expect(mesh.connects).toContain('f');
    mesh.helloN.set('f', 2);
    mesh.join('f');
    mesh.event('f', instance(3));
    run(5000);
    expect(mesh.disconnects).toEqual([]);
  });

  it('sends its crowd in the next `where` once past `CROWD_AT`', () => {
    const { hub, mesh, session, run } = linkedTo([
      ['p1', 40, 0],
      ['p2', -50, 0],
      ['p3', 300, 0],
    ]);
    run(2500);
    hub.sent.length = 0;
    // Under 3 P0 + P1 at the default (24): no crowd.
    for (const [id, dx] of [
      ['p1', 40],
      ['p2', -50],
      ['p3', 300],
    ] as const) {
      mesh.state(id, snap(dx), null);
    }
    run(2500);
    expect(wheres(hub.sent).some((m) => m.crowd)).toBe(false);
    expect(session.netInfo().instance.crowded).toBe(false);

    session.setCrowdAt(3);
    run(100);
    const sent = wheres(hub.sent).filter((m) => m.crowd);
    expect(sent).toHaveLength(1);
    // Within 8 × the larger radius (80 wu), nearest first: p3 is P1 but too far for the list.
    expect(sent[0]?.crowd).toEqual(['p1', 'p2']);
    expect(session.netInfo().instance).toMatchObject({ crowded: true, crowdSent: 1 });
  });

  it('counts only the P1 that share its water toward `CROWD_AT`', () => {
    const { hub, session, run } = linkedTo([
      ['p1', 40, 0],
      ['p2', -50, 0],
    ]);
    hub.world(instance(1));
    hub.world(
      nearMsg([
        ['p1', 40, 0],
        ['p2', -50, 0],
        ['q', 60, 1],
      ]),
    );
    session.setCrowdAt(3);
    run(600);
    expect(session.netInfo().instance.crowded).toBe(true);
    hub.world(nearMsg([['p1', 40, 0]]));
    run(600);
    expect(session.netInfo().instance.crowded).toBe(false);
  });

  it('tells the app which linked creatures stop and start being drawn', () => {
    const rig = linkedTo([
      ['a1', 200, 1],
      ['b0', 250, 0],
    ]);
    const shown = rig.handlers.water.mock.calls;
    rig.hub.world(instance(2));
    expect(shown).toEqual([['a1', false]]);
    // b0 moves into instance 1: this page no longer shares water with it.
    rig.mesh.event('b0', instance(1));
    expect(shown).toEqual([
      ['a1', false],
      ['b0', false],
    ]);
    expect(rig.mesh.disconnects.sort()).toEqual(['a1', 'b0']);
  });

  it('fades a link that drops just after its own instance changed, and not later', () => {
    const rig = linkedTo([
      ['a', 200, 0],
      ['b', 250, 0],
    ]);
    const shown = rig.handlers.water.mock.calls;
    rig.hub.world(instance(1));
    // The other side closed it for the water before its `instance` event came.
    rig.mesh.disconnect('a');
    expect(shown).toEqual([['a', false]]);
    rig.run(WATER_CHANGE_MS + 100);
    rig.mesh.disconnect('b');
    expect(shown).toEqual([['a', false]]);
  });

  it('sends no snapshot or game event to a duty link that doesn’t share water, and takes none from it', () => {
    const { hub, mesh, session, handlers } = linkedTo([['k', 200, 0]]);
    hub.world(instance(1));
    session.dutyPeer(ENC, 'w', true);
    mesh.helloN.set('w', 2);
    mesh.join('w');
    expect(mesh.open.has('w')).toBe(true);
    mesh.states.length = 0;
    mesh.events.length = 0;
    session.broadcastState(new Uint8Array(29));
    session.broadcastEvent({ t: 'emote', id: 1 });
    expect(mesh.states.map(([id]) => id)).toEqual(['k']);
    expect(mesh.events.map(([id]) => id)).toEqual(['k']);
    handlers.state.mockClear();
    handlers.event.mockClear();
    mesh.state('w', snap(10), null);
    mesh.event('w', { t: 'emote', id: 1 });
    mesh.event('w', { t: 'probe', n: 1, back: false });
    expect(handlers.state).not.toHaveBeenCalled();
    expect(handlers.event.mock.calls.map(([, e]) => e.t)).toEqual(['probe']);
  });

  it('says whether a peer shares water with a player, for an away fighter’s proxies', () => {
    const { hub, mesh, session } = linkedTo([
      ['s0', 200, 0],
      ['s2', 250, 0],
    ]);
    mesh.event('s2', instance(2));
    hub.world(nearMsg([['f', 100, 1]]));
    expect(session.sharesWith('s0', 'f')).toBe(true);
    expect(session.sharesWith('s2', 'f')).toBe(false);
  });

  it('is back in the open water on a new hub session', () => {
    const { hub, session } = settled();
    hub.world(instance(4));
    hub.welcome({ ...(session.welcome as NonNullable<typeof session.welcome>) });
    expect(session.netInfo().instance.n).toBe(0);
  });
});

describe('CrowdView', () => {
  it('toasts on leaving the open water at most once a minute', () => {
    const v = new CrowdView();
    expect(v.setOwn(1, 0)).toEqual({ changed: true, busy: true });
    expect(v.setOwn(0, 1000)).toEqual({ changed: true, busy: false });
    expect(v.setOwn(2, 2000)).toEqual({ changed: true, busy: false });
    expect(v.setOwn(2, 3000)).toEqual({ changed: false, busy: false });
    v.setOwn(0, BUSY_EVERY_MS - 1);
    expect(v.setOwn(3, BUSY_EVERY_MS)).toEqual({ changed: true, busy: true });
    expect(v.info()).toMatchObject({ n: 3, changes: 5 });
  });

  it('keeps the freshest word of each creature’s instance', () => {
    const v = new CrowdView();
    v.see('a', 2, 100);
    v.see('a', 1, 50);
    expect(v.of('a')).toBe(2);
    expect(v.of('b')).toBe(0);
    v.setOwn(1, 0);
    expect(v.shares('a')).toBe(false);
    expect(v.shares('b')).toBe(true);
  });

  it('takes `crowdAt` from 2 to 24', () => {
    const v = new CrowdView();
    expect(v.crowdAt).toBe(CROWD_AT);
    v.setCrowdAt(2);
    expect(v.crowdAt).toBe(2);
    expect(() => v.setCrowdAt(1)).toThrow(RangeError);
    expect(() => v.setCrowdAt(25)).toThrow(RangeError);
    expect(() => v.setCrowdAt(2.5)).toThrow(RangeError);
  });
});
