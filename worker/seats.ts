// The hub's in-memory indexes of its sockets (M13 T2): who is seated on which socket, the line in
// ticket order, the sockets still to say hello, the live courts and the witness candidates. A
// message then finds what it needs by key, and its cost doesn't grow with the sockets. The
// attachments stay the truth: every write of one goes through `keep` (`socket.ts`), which notes
// it here, and a woken object rebuilds the indexes from them (`Seats.rebuild`).

import { askLive } from './mating';
import type { Session } from './socket';

/** A waiting session as the line holds it. */
export interface InLine {
  readonly ws: WebSocket;
  readonly player: string;
  readonly ticket: number;
  /** The place last announced (1 = next); 0 before the first. */
  place: number;
}

/** What eligibility needs of a seated player beyond its own attachment (ADR 0058). */
export interface Candidate {
  avail: boolean;
  ip: string | undefined;
  /** Σ of its creatures' `active_ms` as SQLite holds it: read at sign-in, then kept with every record. */
  savedMs: number;
  /** `players.struck_until`: read at sign-in, then set by a strike. */
  struckUntil: number;
}

/** These players' saved play and strike as SQLite holds them now (`playOf` in `witness-pool.ts`). */
export type PlayLoader = (
  players: readonly string[],
) => Map<string, { savedMs: number; struckUntil: number }>;

export class Seats {
  /** Each seated player's socket. */
  private readonly bySeat = new Map<string, WebSocket>();
  /** The player of each seated or waiting socket. */
  private readonly owner = new Map<WebSocket, string>();
  /** The waiting sessions, lowest ticket first. */
  private readonly waiting: InLine[] = [];
  /** The sockets that haven't said hello, with when they opened. */
  private readonly hellos = new Map<WebSocket, number>();
  /** Each seated player's own court ask: its partner and when it was sent. */
  private readonly asks = new Map<string, { partner: string; sentAt: number }>();
  /** Each seated player's witness candidacy. */
  private readonly candidates = new Map<string, Candidate>();

  constructor(private load: PlayLoader) {}

  /** Notes every socket a woken object finds, the seated players' play read all at once. */
  rebuild(sockets: Iterable<[WebSocket, Session | null]>): void {
    const all = [...sockets];
    const play = this.load(all.flatMap(([, s]) => (s?.phase === 'active' ? [s.playerId] : [])));
    const load = this.load;
    this.load = () => play;
    try {
      for (const [ws, s] of all) this.note(ws, s);
    } finally {
      this.load = load;
    }
  }

  /** Notes a socket's attachment as just written (null or `retired`: the socket is gone). */
  note(ws: WebSocket, s: Session | null): void {
    if (s?.phase !== 'challenged') this.hellos.delete(ws);
    if (s?.phase !== 'queued') this.unqueue(ws);
    switch (s?.phase) {
      case 'challenged':
        this.hellos.set(ws, s.openedAt);
        return;
      case 'queued':
        this.unseat(ws);
        this.owner.set(ws, s.playerId);
        this.enqueue(ws, s.playerId, s.ticket, s.place);
        return;
      case 'active':
        this.seat(ws, s);
        return;
      default:
        this.unseat(ws);
        this.owner.delete(ws);
    }
  }

  /** A seated session: its socket, its court and its candidacy (its play read once, when it takes the seat). */
  private seat(ws: WebSocket, s: Session & { phase: 'active' }): void {
    const player = s.playerId;
    const holder = this.bySeat.get(player);
    // A socket already closing (a handler finishing after its tab was replaced) never takes the
    // seat from the open one that holds it now.
    if (holder && holder !== ws && ws.readyState > WebSocket.READY_STATE_OPEN) return;
    if (this.owner.get(ws) !== player) this.unseat(ws);
    this.owner.set(ws, player);
    let c = this.candidates.get(player);
    if (holder !== ws || !c) {
      this.bySeat.set(player, ws);
      const play = this.load([player]).get(player);
      c = {
        avail: false,
        ip: undefined,
        savedMs: play?.savedMs ?? 0,
        struckUntil: play?.struckUntil ?? 0,
      };
      this.candidates.set(player, c);
    }
    c.avail = s.avail === true;
    c.ip = s.ip;
    if (s.court && 'ask' in s.court)
      this.asks.set(player, { partner: s.court.ask.partner, sentAt: s.court.sentAt });
    else this.asks.delete(player);
  }

  /** The socket leaves its seat, if it held one. */
  private unseat(ws: WebSocket): void {
    const player = this.owner.get(ws);
    if (player === undefined || this.bySeat.get(player) !== ws) return;
    this.bySeat.delete(player);
    this.asks.delete(player);
    this.candidates.delete(player);
  }

  private enqueue(ws: WebSocket, player: string, ticket: number, place: number): void {
    const held = this.waiting.find((e) => e.ws === ws);
    if (held && held.ticket === ticket) {
      held.place = place;
      return;
    }
    if (held) this.unqueue(ws);
    let i = this.waiting.length;
    while (i > 0 && (this.waiting[i - 1] as InLine).ticket > ticket) i--;
    this.waiting.splice(i, 0, { ws, player, ticket, place });
  }

  private unqueue(ws: WebSocket): void {
    const i = this.waiting.findIndex((e) => e.ws === ws);
    if (i >= 0) this.waiting.splice(i, 1);
  }

  /** The player's seated socket, or null. */
  socketOf(player: string): WebSocket | null {
    return this.bySeat.get(player) ?? null;
  }

  /** Whether the player holds a seat. */
  has(player: string): boolean {
    return this.bySeat.has(player);
  }

  /** How many sessions hold a seat. */
  get size(): number {
    return this.bySeat.size;
  }

  /** The seated players with their sockets. */
  seated(): IterableIterator<[string, WebSocket]> {
    return this.bySeat.entries();
  }

  /** The line, next first. */
  line(): readonly InLine[] {
    return this.waiting;
  }

  /** The player's waiting socket, or null. */
  waitingOf(player: string): InLine | null {
    return this.waiting.find((e) => e.player === player) ?? null;
  }

  /** The sockets that haven't said hello yet, with when each opened. */
  challenged(): IterableIterator<[WebSocket, number]> {
    return this.hellos.entries();
  }

  /** Forgets a socket that hasn't said hello (closed). */
  forgetHello(ws: WebSocket): void {
    this.hellos.delete(ws);
  }

  /** Each player's live court partners at `now`, both ways. */
  courtPairs(now: number): Map<string, string[]> {
    const pairs = new Map<string, string[]>();
    const add = (a: string, b: string) => pairs.set(a, [...(pairs.get(a) ?? []), b]);
    for (const [player, ask] of this.asks) {
      if (!askLive(ask.sentAt, now)) continue;
      add(player, ask.partner);
      add(ask.partner, player);
    }
    return pairs;
  }

  /** A seated player's candidacy, or null. */
  candidate(player: string): Readonly<Candidate> | null {
    return this.candidates.get(player) ?? null;
  }

  /** The seated players with `avail` on. */
  *available(): Generator<string> {
    for (const [player, c] of this.candidates) if (c.avail) yield player;
  }

  /** A record added `ms` of active time to one of the player's creatures; false when it isn't seated. */
  addPlay(player: string, ms: number): boolean {
    const c = this.candidates.get(player);
    if (!c) return false;
    c.savedMs += ms;
    return true;
  }

  /** Reads a seated player's play and strike again (a test that wrote their rows directly). */
  reload(player: string): void {
    const c = this.candidates.get(player);
    const play = c ? this.load([player]).get(player) : undefined;
    if (!c || !play) return;
    c.savedMs = play.savedMs;
    c.struckUntil = play.struckUntil;
  }

  /** The player is struck until `until`. */
  strike(player: string, until: number): void {
    const c = this.candidates.get(player);
    if (c) c.struckUntil = until;
  }

  /** The indexes as a test compares them: seated players, the line, live courts and candidates. */
  view(now: number) {
    return {
      seated: [...this.bySeat.keys()].sort(),
      line: this.waiting.map((e) => [e.player, e.ticket, e.place]),
      courts: [...this.courtPairs(now)].sort(([a], [b]) => (a < b ? -1 : 1)),
      candidates: [...this.candidates].sort(([a], [b]) => (a < b ? -1 : 1)),
      challenged: this.hellos.size,
    };
  }
}
