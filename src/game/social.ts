// Chat, emotes and pings: the rules (limits, filtering, mute, expiry) without any DOM or network,
// so they test with a fake clock. `social-ui.ts` draws what this holds; `app.ts` wires the keys.

import { CHAT_MAX_CHARS, EMOTE_COUNT, type PeerEvent, PING_KINDS } from '../net/protocol';
import { filterText } from '../net/text';
import type { Store } from './online-config';

const MUTE_KEY = 'bs.muted';

const CHAT_LIMIT = { max: 3, windowMs: 5000 };
const EMOTE_LIMIT = { max: 1, windowMs: 1000 };
const PING_LIMIT = { max: 1, windowMs: 1000 };

const LOG_SIZE = 50;
const BUBBLE_MS = 5000;
const EMOTE_MS = 2000;
const PING_MS = 4000;
/** `T` waits this long for the number that follows. */
const EMOTE_ARM_MS = 3000;

interface Limits {
  chat: RateLimit;
  emote: RateLimit;
  ping: RateLimit;
}

function makeLimits(): Limits {
  return {
    chat: new RateLimit(CHAT_LIMIT.max, CHAT_LIMIT.windowMs),
    emote: new RateLimit(EMOTE_LIMIT.max, EMOTE_LIMIT.windowMs),
    ping: new RateLimit(PING_LIMIT.max, PING_LIMIT.windowMs),
  };
}

/** At most `max` hits in any `windowMs`; a refused hit is not counted. */
export class RateLimit {
  private readonly hits: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  allow(now: number): boolean {
    while (this.hits.length > 0 && now - (this.hits[0] as number) >= this.windowMs)
      this.hits.shift();
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}

/** Players this browser has muted, kept by `playerId` in local storage. */
export class MuteList {
  private readonly set = new Set<string>();

  constructor(private readonly store: Store | null) {
    try {
      const parsed: unknown = JSON.parse(store?.getItem(MUTE_KEY) ?? '[]');
      if (Array.isArray(parsed))
        for (const id of parsed) if (typeof id === 'string') this.set.add(id);
    } catch {
      // storage blocked or broken: start with nobody muted
    }
  }

  has(id: string): boolean {
    return this.set.has(id);
  }

  ids(): ReadonlySet<string> {
    return this.set;
  }

  /** Flips the mute and returns whether the player is muted now. */
  toggle(id: string): boolean {
    const muted = !this.set.delete(id);
    if (muted) this.set.add(id);
    try {
      this.store?.setItem(MUTE_KEY, JSON.stringify([...this.set]));
    } catch {
      // storage blocked: the mute lasts for this visit
    }
    return muted;
  }
}

export interface ChatLine {
  from: string;
  name: string;
  text: string;
}

export interface Bubble {
  text: string;
  until: number;
}

export interface EmoteCue {
  id: number;
  until: number;
}

export interface PingCue {
  from: string;
  kind: number;
  x: number;
  y: number;
  until: number;
}

/** A cue that went on screen (M6 T23 plays its sound): a ping carries where it landed. */
export interface Heard {
  kind: 'chat' | 'emote' | 'ping';
  from: string;
  at: { x: number; y: number } | null;
}

export interface SocialOptions {
  /** Milliseconds on any steady clock. */
  now(): number;
  /** The display name of a roster member; undefined for anyone else. */
  nameOf(id: string): string | undefined;
  send(event: PeerEvent): void;
  muted: MuteList;
  selfName: string;
  /** Pings outside 0..worldSize are ignored. */
  worldSize?: number;
  /** Each peer's chat line, emote and ping shown, and the player's own emotes and pings. */
  heard?: (cue: Heard) => void;
}

export class Social {
  /** Messages and cues dropped for a rate limit or a sender outside the roster. */
  dropped = 0;
  /** Messages logged so far (the log keeps only the last 50), so a view knows when to redraw. */
  chats = 0;
  selfName: string;
  /** The pond's side in world units; peers' pings outside it are ignored. */
  worldSize: number | undefined;
  readonly muted: MuteList;

  private readonly chatLines: ChatLine[] = [];
  private readonly bubbleMap = new Map<string, Bubble>();
  private readonly emoteMap = new Map<string, EmoteCue>();
  private readonly pingList: PingCue[] = [];
  private readonly mine = makeLimits();
  private readonly theirs = new Map<string, Limits>();
  private nextPing = 0;
  private armedUntil = -1;

  constructor(private readonly opts: SocialOptions) {
    this.selfName = opts.selfName;
    this.worldSize = opts.worldSize;
    this.muted = opts.muted;
  }

  /** The last 50 messages, oldest first. */
  log(): readonly ChatLine[] {
    return this.chatLines;
  }

  bubbles(): ReadonlyMap<string, Bubble> {
    this.expire(this.bubbleMap);
    return this.bubbleMap;
  }

  emotes(): ReadonlyMap<string, EmoteCue> {
    this.expire(this.emoteMap);
    return this.emoteMap;
  }

  pings(): readonly PingCue[] {
    // Pings last the same time, so they expire oldest first.
    const now = this.opts.now();
    while (this.pingList.length > 0 && (this.pingList[0] as PingCue).until <= now) {
      this.pingList.shift();
    }
    return this.pingList;
  }

  /** Flips the mute; muting also clears what that player has on screen and in the log. */
  toggleMute(id: string): boolean {
    const muted = this.muted.toggle(id);
    if (muted) {
      this.bubbleMap.delete(id);
      this.emoteMap.delete(id);
      for (let i = this.pingList.length - 1; i >= 0; i--) {
        if ((this.pingList[i] as PingCue).from === id) this.pingList.splice(i, 1);
      }
      const kept = this.chatLines.filter((line) => line.from !== id);
      this.chatLines.length = 0;
      this.chatLines.push(...kept);
      this.chats++;
    }
    return muted;
  }

  /** Sends `text` (trimmed, cut, filtered) and shows it as the player's own; false if nothing went. */
  sendChat(text: string, self: string): boolean {
    const clean = filterText(text.trim().slice(0, CHAT_MAX_CHARS)).trim();
    if (clean === '' || !this.mine.chat.allow(this.opts.now())) return false;
    this.opts.send({ t: 'chat', text: clean });
    this.addChat(self, this.selfName, clean);
    return true;
  }

  sendEmote(id: number, self: string): boolean {
    if (!Number.isInteger(id) || id < 0 || id >= EMOTE_COUNT) return false;
    const now = this.opts.now();
    if (!this.mine.emote.allow(now)) return false;
    this.opts.send({ t: 'emote', id });
    this.emoteMap.set(self, { id, until: now + EMOTE_MS });
    this.opts.heard?.({ kind: 'emote', from: self, at: null });
    return true;
  }

  /** Marks a world position; each ping placed moves on to the next of the four kinds. */
  ping(at: { x: number; y: number }, self: string): boolean {
    const now = this.opts.now();
    if (this.worldSize !== undefined && !inside(at.x, at.y, this.worldSize)) return false;
    if (!this.mine.ping.allow(now)) return false;
    const kind = this.nextPing;
    this.nextPing = (kind + 1) % PING_KINDS;
    this.opts.send({ t: 'ping', kind, x: at.x, y: at.y });
    this.pingList.push({ from: self, kind, x: at.x, y: at.y, until: now + PING_MS });
    this.opts.heard?.({ kind: 'ping', from: self, at: { x: at.x, y: at.y } });
    return true;
  }

  /** A pressed key: `T` then 1–6 is an emote, `G` pings at the cursor (world units, or null). */
  key(key: string, self: string, cursor: { x: number; y: number } | null): void {
    const now = this.opts.now();
    const k = key.toLowerCase();
    if (k === 't') {
      this.armedUntil = now + EMOTE_ARM_MS;
    } else if (k === 'g') {
      if (cursor) this.ping(cursor, self);
    } else if (/^[1-9]$/.test(k) && Number(k) <= EMOTE_COUNT && now < this.armedUntil) {
      this.armedUntil = -1;
      this.sendEmote(Number(k) - 1, self);
    }
  }

  /** A social event from a peer; anything from outside the roster or from a muted player is dropped. */
  receive(from: string, event: PeerEvent): void {
    if (event.t !== 'chat' && event.t !== 'emote' && event.t !== 'ping') return;
    const name = this.opts.nameOf(from);
    if (name === undefined) {
      this.dropped++;
      return;
    }
    if (this.muted.has(from)) return;
    const now = this.opts.now();
    const limits = this.limitsOf(from);
    if (!limits[event.t].allow(now)) {
      this.dropped++;
      return;
    }
    switch (event.t) {
      case 'chat': {
        const text = filterText(event.text);
        if (text.trim() !== '') {
          this.addChat(from, name, text);
          this.opts.heard?.({ kind: 'chat', from, at: null });
        }
        break;
      }
      case 'emote':
        this.emoteMap.set(from, { id: event.id, until: now + EMOTE_MS });
        this.opts.heard?.({ kind: 'emote', from, at: null });
        break;
      case 'ping': {
        const { worldSize } = this;
        if (worldSize !== undefined && !inside(event.x, event.y, worldSize)) break;
        this.pingList.push({
          from,
          kind: event.kind,
          x: event.x,
          y: event.y,
          until: now + PING_MS,
        });
        this.opts.heard?.({ kind: 'ping', from, at: { x: event.x, y: event.y } });
        break;
      }
    }
  }

  /** Forgets the log and every cue (a new pond or name); mutes stay. */
  reset(): void {
    this.chatLines.length = 0;
    this.chats++;
    this.bubbleMap.clear();
    this.emoteMap.clear();
    this.pingList.length = 0;
    this.theirs.clear();
    this.armedUntil = -1;
  }

  private addChat(from: string, name: string, text: string): void {
    this.chats++;
    this.chatLines.push({ from, name, text });
    if (this.chatLines.length > LOG_SIZE) this.chatLines.shift();
    this.bubbleMap.set(from, { text, until: this.opts.now() + BUBBLE_MS });
  }

  private limitsOf(id: string): Limits {
    let limits = this.theirs.get(id);
    if (!limits) {
      limits = makeLimits();
      this.theirs.set(id, limits);
    }
    return limits;
  }

  private expire(map: Map<string, { until: number }>): void {
    const now = this.opts.now();
    for (const [id, cue] of map) if (cue.until <= now) map.delete(id);
  }
}

function inside(x: number, y: number, size: number): boolean {
  return x >= 0 && x <= size && y >= 0 && y <= size;
}
