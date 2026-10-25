import { describe, expect, it } from 'vitest';
import { CHAT_MAX_CHARS } from '../net/protocol';
import { MuteList, RateLimit, Social, type SocialOptions } from './social';

const NAMES: Record<string, string> = { alice: 'Alice', bob: 'Bob' };

function setup(overrides: Partial<SocialOptions> = {}) {
  const clock = { now: 0 };
  const sent: unknown[] = [];
  const social = new Social({
    now: () => clock.now,
    nameOf: (id) => NAMES[id],
    send: (event) => sent.push(event),
    muted: new MuteList(null),
    selfName: 'Me',
    ...overrides,
  });
  return { clock, sent, social };
}

describe('RateLimit', () => {
  it('allows `max` hits per window and frees them as the window slides', () => {
    const limit = new RateLimit(3, 5000);
    expect([0, 1000, 2000, 2500].map((t) => limit.allow(t))).toEqual([true, true, true, false]);
    // The first hit leaves the window at 5000.
    expect(limit.allow(4999)).toBe(false);
    expect(limit.allow(5000)).toBe(true);
  });

  it('does not count a refused hit', () => {
    const limit = new RateLimit(1, 1000);
    expect(limit.allow(0)).toBe(true);
    expect(limit.allow(500)).toBe(false);
    expect(limit.allow(1000)).toBe(true);
  });
});

describe('MuteList', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
  };

  it('toggles and survives a reload through the store', () => {
    const store = memory();
    const first = new MuteList(store);
    expect(first.toggle('alice')).toBe(true);
    expect(first.has('alice')).toBe(true);
    const second = new MuteList(store);
    expect(second.has('alice')).toBe(true);
    expect(second.toggle('alice')).toBe(false);
    expect(new MuteList(store).has('alice')).toBe(false);
  });

  it('copes with a missing, broken or throwing store', () => {
    const broken = { getItem: () => '{nope', setItem: () => {} };
    expect(new MuteList(broken).has('a')).toBe(false);
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const list = new MuteList(throwing);
    expect(list.toggle('a')).toBe(true);
    expect(list.has('a')).toBe(true);
    expect(new MuteList(null).toggle('a')).toBe(true);
  });

  it('ignores stored junk', () => {
    const store = { getItem: () => JSON.stringify(['ok', 7, null]), setItem: () => {} };
    expect([...new MuteList(store).ids()]).toEqual(['ok']);
  });
});

describe('chat', () => {
  it("sends a filtered, trimmed message and logs it as the player's own", () => {
    const { social, sent } = setup();
    expect(social.sendChat('  hello pond  ', 'self')).toBe(true);
    expect(sent).toEqual([{ t: 'chat', text: 'hello pond' }]);
    expect(social.log().at(-1)).toMatchObject({ from: 'self', name: 'Me', text: 'hello pond' });
    expect(social.bubbles().get('self')?.text).toBe('hello pond');
  });

  it('filters profanity before sending and again on receipt', () => {
    const a = setup();
    a.social.sendChat('what the fuck', 'self');
    expect(a.sent).toEqual([{ t: 'chat', text: 'what the ****' }]);
    const b = setup();
    b.social.receive('alice', { t: 'chat', text: 'what the fuck' });
    expect(b.social.log().at(-1)?.text).toBe('what the ****');
  });

  it('cuts to 140 characters and sends nothing for blank text', () => {
    const { social, sent } = setup();
    expect(social.sendChat('   ', 'self')).toBe(false);
    social.sendChat('x'.repeat(300), 'self');
    expect((sent[0] as { text: string }).text).toHaveLength(CHAT_MAX_CHARS);
    expect(sent).toHaveLength(1);
  });

  it('limits the sender to 3 messages per 5 s', () => {
    const { social, sent, clock } = setup();
    const results = [0, 1000, 2000, 3000].map((t) => {
      clock.now = t;
      return social.sendChat(`m${t}`, 'self');
    });
    expect(results).toEqual([true, true, true, false]);
    expect(sent).toHaveLength(3);
    clock.now = 5000;
    expect(social.sendChat('later', 'self')).toBe(true);
  });

  it("drops (and counts) a sender's 4th message in 5 s", () => {
    const { social, clock } = setup();
    for (const t of [0, 100, 200, 300]) {
      clock.now = t;
      social.receive('alice', { t: 'chat', text: `m${t}` });
    }
    expect(social.log().map((m) => m.text)).toEqual(['m0', 'm100', 'm200']);
    expect(social.dropped).toBe(1);
    // Another sender has their own allowance.
    social.receive('bob', { t: 'chat', text: 'hi' });
    expect(social.log()).toHaveLength(4);
    clock.now = 5000;
    social.receive('alice', { t: 'chat', text: 'again' });
    expect(social.log().at(-1)?.text).toBe('again');
  });

  it('drops chat from anyone outside the roster or muted', () => {
    const { social } = setup();
    social.receive('mallory', { t: 'chat', text: 'psst' });
    expect(social.log()).toHaveLength(0);
    expect(social.dropped).toBe(1);
    social.toggleMute('alice');
    social.receive('alice', { t: 'chat', text: 'hello' });
    expect(social.log()).toHaveLength(0);
    social.toggleMute('alice');
    social.receive('alice', { t: 'chat', text: 'hello' });
    expect(social.log()).toHaveLength(1);
  });

  it('keeps the last 50 messages', () => {
    const { social, clock } = setup();
    for (let i = 0; i < 60; i++) {
      clock.now = i * 10_000;
      social.receive('alice', { t: 'chat', text: `m${i}` });
    }
    expect(social.log()).toHaveLength(50);
    expect(social.log()[0]?.text).toBe('m10');
  });

  it('shows a bubble for 5 s', () => {
    const { social, clock } = setup();
    social.receive('alice', { t: 'chat', text: 'hey' });
    expect(social.bubbles().get('alice')?.text).toBe('hey');
    clock.now = 4999;
    expect(social.bubbles().has('alice')).toBe(true);
    clock.now = 5000;
    expect(social.bubbles().has('alice')).toBe(false);
  });
});

describe('emotes', () => {
  it('shows for 2 s on the sender and lets one through per second', () => {
    const { social, sent, clock } = setup();
    expect(social.sendEmote(2, 'self')).toBe(true);
    expect(social.sendEmote(3, 'self')).toBe(false);
    expect(sent).toEqual([{ t: 'emote', id: 2 }]);
    expect(social.emotes().get('self')?.id).toBe(2);
    clock.now = 1000;
    expect(social.sendEmote(3, 'self')).toBe(true);
    clock.now = 2999;
    expect(social.emotes().get('self')?.id).toBe(3);
    clock.now = 3000;
    expect(social.emotes().has('self')).toBe(false);
  });

  it("shows a peer's emote, but not a muted or unknown one, and limits per sender", () => {
    const { social, clock } = setup();
    social.receive('alice', { t: 'emote', id: 4 });
    social.receive('alice', { t: 'emote', id: 5 });
    expect(social.emotes().get('alice')?.id).toBe(4);
    social.receive('mallory', { t: 'emote', id: 1 });
    expect(social.emotes().has('mallory')).toBe(false);
    social.toggleMute('bob');
    social.receive('bob', { t: 'emote', id: 1 });
    expect(social.emotes().has('bob')).toBe(false);
    clock.now = 1000;
    social.receive('alice', { t: 'emote', id: 0 });
    expect(social.emotes().get('alice')?.id).toBe(0);
  });
});

describe('pings', () => {
  it('cycles the kind on each ping placed and shows it for 4 s', () => {
    const { social, sent, clock } = setup();
    const kinds: number[] = [];
    for (let i = 0; i < 5; i++) {
      clock.now = i * 1000;
      social.ping({ x: 10, y: 20 }, 'self');
      kinds.push((sent.at(-1) as { kind: number }).kind);
    }
    expect(kinds).toEqual([0, 1, 2, 3, 0]);
    // The first ping (placed at 0) is gone at 4000; the four later ones are still up.
    clock.now = 4000;
    expect(social.pings().map((p) => p.kind)).toEqual([1, 2, 3, 0]);
  });

  it('allows one per second and does not advance the kind when refused', () => {
    const { social, sent, clock } = setup();
    expect(social.ping({ x: 1, y: 2 }, 'self')).toBe(true);
    clock.now = 500;
    expect(social.ping({ x: 1, y: 2 }, 'self')).toBe(false);
    clock.now = 1000;
    social.ping({ x: 1, y: 2 }, 'self');
    expect(sent.map((e) => (e as { kind: number }).kind)).toEqual([0, 1]);
  });

  it("places a peer's ping at the same world position and honours mute and the roster", () => {
    const { social } = setup();
    social.receive('alice', { t: 'ping', kind: 2, x: 123.5, y: -40 });
    expect(social.pings()).toEqual([
      expect.objectContaining({ from: 'alice', kind: 2, x: 123.5, y: -40 }),
    ]);
    social.receive('mallory', { t: 'ping', kind: 1, x: 0, y: 0 });
    social.toggleMute('bob');
    social.receive('bob', { t: 'ping', kind: 1, x: 0, y: 0 });
    expect(social.pings()).toHaveLength(1);
  });

  it('ignores a ping outside the world', () => {
    const { social } = setup({ worldSize: 1000 });
    social.receive('alice', { t: 'ping', kind: 0, x: 5000, y: 0 });
    expect(social.pings()).toHaveLength(0);
  });
});

describe('hotkeys', () => {
  it('T then 1-6 sends an emote; a lone number does nothing', () => {
    const { social, sent, clock } = setup();
    social.key('3', 'self', null);
    expect(sent).toHaveLength(0);
    social.key('t', 'self', null);
    social.key('3', 'self', null);
    expect(sent).toEqual([{ t: 'emote', id: 2 }]);
    // T is spent: the next number needs another T.
    clock.now = 2000;
    social.key('4', 'self', null);
    expect(sent).toHaveLength(1);
  });

  it('forgets a T after 3 s', () => {
    const { social, sent, clock } = setup();
    social.key('t', 'self', null);
    clock.now = 3001;
    social.key('2', 'self', null);
    expect(sent).toHaveLength(0);
  });

  it('G pings at the cursor, and does nothing without one', () => {
    const { social, sent } = setup();
    social.key('g', 'self', null);
    expect(sent).toHaveLength(0);
    social.key('G', 'self', { x: 5, y: 6 });
    expect(sent).toEqual([{ t: 'ping', kind: 0, x: 5, y: 6 }]);
  });
});

describe('mute clears what is showing', () => {
  it("removes the sender's bubble, emote, ping and log lines, and leaves others", () => {
    const { social, clock } = setup();
    social.receive('alice', { t: 'chat', text: 'hi' });
    social.receive('alice', { t: 'emote', id: 1 });
    social.receive('alice', { t: 'ping', kind: 0, x: 1, y: 1 });
    social.receive('bob', { t: 'chat', text: 'yo' });
    const before = social.chats;
    social.toggleMute('alice');
    expect(social.bubbles().has('alice')).toBe(false);
    expect(social.emotes().has('alice')).toBe(false);
    expect(social.pings()).toHaveLength(0);
    expect(social.log().map((l) => l.text)).toEqual(['yo']);
    expect(social.bubbles().has('bob')).toBe(true);
    expect(social.chats).toBeGreaterThan(before);
    clock.now = 1;
  });
});

describe('edges', () => {
  it('refuses to ping outside the world, as peers would drop it', () => {
    const { social, sent } = setup({ worldSize: 1000 });
    expect(social.ping({ x: -5, y: 10 }, 'self')).toBe(false);
    expect(social.ping({ x: 10, y: 10 }, 'self')).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('keeps T armed through a number that is not an emote', () => {
    const { social, sent } = setup();
    social.key('t', 'self', null);
    social.key('7', 'self', null);
    expect(sent).toHaveLength(0);
    social.key('6', 'self', null);
    expect(sent).toEqual([{ t: 'emote', id: 5 }]);
  });

  it('tells a view to redraw after a reset', () => {
    const { social } = setup();
    social.sendChat('hi', 'self');
    const before = social.chats;
    social.reset();
    expect(social.chats).toBeGreaterThan(before);
  });
});

describe('reset', () => {
  it('clears cues and the log but keeps mutes', () => {
    const { social } = setup();
    social.toggleMute('bob');
    social.sendChat('hi', 'self');
    social.reset();
    expect(social.log()).toHaveLength(0);
    expect(social.bubbles().size).toBe(0);
    expect(social.muted.has('bob')).toBe(true);
  });
});
