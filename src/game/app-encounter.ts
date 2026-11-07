// The player's side of a refereed fight (M7 T10): from `enc-start` the encounter, not free roam,
// moves the player's creature; the creature mirrors its fighter so the HUD, the bars, the snapshots
// and the camera keep working, remote fighters are drawn from the encounter, and at `enc-end` free
// roam carries on from the authority's result. DOM-free: the app supplies a `FightHost`.

import type { Creature } from '../genome/stats';
import type { PubKey } from '../ledger/record';
import { bodyFromText } from '../net/encounter-start';
import { EncounterSync } from '../net/encounter-sync';
import { AUTHORITY } from '../net/handover';
import type { FightMsg } from '../net/hub-client';
import { type SnapshotFields, snapshotOf } from '../net/pond-sync';
import { type ClientMsg, type FighterInfo, genomeRefOf, type PeerEvent } from '../net/protocol';
import type { RelayFight } from '../net/proxy-snaps';
import { RefereeRoute } from '../net/referee-route';
import type { WitnessFrame } from '../net/witness-referee';
import { radiusOf, strikeReach } from '../sim/encounter/reach';
import type { Encounter, EncounterEvent, Outcome, Stance } from '../sim/encounter/types';
import type { Input } from '../sim/input';
import type { CreatureState, World } from '../sim/types';
import { maxHealth } from '../sim/vitals';
import type { App } from './app';
import { aimsAt } from './fight-cues';
import { inputTarget, markedTarget, nextTarget, targetAt } from './fight-target';
import { FightVerify } from './fight-verify';

export interface FightHost {
  /** This player's id, or null before the identity is loaded. */
  me(): string | null;
  /** The hub's pond the life plays in, or null for a local or title life. */
  pond(): { seed: string; size: number } | null;
  /** The recorded life playing now: its creature and its world; null on the title or after a death. */
  life(): { player: CreatureState; world: World } | null;
  /** The steering free roam would use this tick. */
  steering(): Input;
  send(msg: ClientMsg): void;
  /** The hub clock now, in ms. */
  hubNow(): number;
  /** Half the round trip to the hub, in ms. */
  oneWayMs(): number;
  /** The tab is hidden: its frames are left to the autopilot. */
  hidden(): boolean;
  /** The creature a genome text builds (the own body is known already); null when it does not build. */
  body?(genome: string): Creature | null;
  /** Every simulated frame's events, for the fight's cues and telegraphs (M7 T12). */
  events?(events: readonly EncounterEvent[]): void;
  /** The authority's keys a settlement is checked with (M8 T12); none means no check. */
  keys?(): Promise<readonly PubKey[] | null>;
  /** Whether a player is in the pond now (this one, or a roster member); absent means everyone is. */
  present?(player: string): boolean;
  /** A witness's message on the duty link to it (M10 T7): an own `finput`. */
  sendWitness?(witness: string, ev: PeerEvent): void;
  /** The own signature on fight `enc`'s frame `f` input (`signInput`). */
  signInput?(enc: string, f: number, code: number): string;
  /** Whether `witness` signed that frame of fight `enc` (`witnessFrameSigned`). */
  frameSigned?(
    witness: string,
    enc: string,
    f: number,
    inputs: readonly (number | null)[],
    sig: string,
  ): boolean;
  /** The one-way latency to a duty peer from its probes, or null before one came back. */
  peerOneWayMs?(peer: string): number | null;
  /** A fight begins: what a witness phase will need (its signatures' code) starts to load. */
  prepare?(): void;
}

/** Rollbacks this many frames either side of a handover's frame count as the handover's. */
export const HANDOVER_WINDOW = 10;

/** `debug.autoBrace` braces when a windup aimed at the player or its egg has this many ticks or fewer left. */
export const AUTO_BRACE_TICKS = 4;

/** Whether a windup in `enc` aims at slot `own` or its egg and lands within `ticks` ticks. */
export function threatened(enc: Encounter, own: number, ticks: number): boolean {
  const tick = enc.world.tick;
  return enc.fighters.some(
    (f) =>
      f.slot !== own && f.status === 'in' && aimsAt(f, own, tick) && f.fx.windupEnd - tick <= ticks,
  );
}

/** A fighter as `state().encounter` shows it. */
export interface FighterView {
  player: string;
  creature: string;
  x: number;
  y: number;
  heading: number;
  health: number;
  maxHealth: number;
  stance: Stance;
  /** Ticks until the running windup lands, or null. */
  windup: number | null;
  /** The target code the running windup aims at (0-3 a fighter's slot, 4-7 that slot's egg), or null. */
  target: number | null;
  braced: boolean;
  /** The carried egg in the fight, or null. */
  egg: { x: number; y: number; health: number; eaten: boolean } | null;
  outcome: 'in' | Outcome;
  /** Its radius in wu (M7 T12). */
  radius: number;
  /** Its strike reach in wu, from its centre (M10 T7, `strikeReach`). */
  reach: number;
  /** Staggered by a block: no windup starts (M7 T12). */
  staggered: boolean;
  /** Ticks in a row outside every living opponent's escape range (M7 T12). */
  outside: number;
  /** Its player has left the pond: its autopilot fights on, drawn faded (M8 T11). */
  away: boolean;
}

export interface EncounterView {
  id: string;
  slot: number;
  frame: number;
  confirmed: number;
  over: boolean;
  hash: string | null;
  /** The referee's hash from `enc-end`, or null before it. */
  endHash: string | null;
  rollbacks: number;
  resyncs: number;
  desyncs: number;
  /** Times this client came back into the fight: a resync by the authority, or a resume after a reload (M8 T10). */
  rejoins: number;
  /**
   * The settlement checked here (M8 T12): true when its countersignature, its root over the frames
   * this client holds and its hash all held, false when one did not; null before the check is
   * done, for a fight that ended with no settlement, or when the authority's keys could not be had.
   */
  verified: boolean | null;
  fighters: FighterView[];
  /**
   * What the target ring marks (M7 T15): a target code (0-3 a slot, 4-7 that slot's egg), and
   * whether the player chose it (Tab or a click) or it is the nearest by default. Null when
   * targeting is not offered (a plain duel) or the player is not seated.
   */
  aim: { code: number; chosen: boolean } | null;
  /** Who referees the fight from which frame (M10 T7): the last `enc-referee`, or the authority from 0. */
  referee: { by: string; from: number };
  /** Handovers heard (`enc-referee`), and disputes sent against a witness's frames. */
  handovers: number;
  disputes: number;
  /** Own inputs sent to a witness, and sent again at a handover. */
  witnessInputs: number;
  resent: number;
  /**
   * Around each handover (`HANDOVER_WINDOW` frames either side of its frame): the longest rollback
   * and the resyncs, the measure that a handover can't be seen.
   */
  aroundHandover: { rollback: number; resyncs: number };
}

/** What a remote is drawn as; the fight moves those that are its fighters. */
interface Drawn {
  id: string;
  x: number;
  y: number;
  heading: number;
  radius: number;
}

export class FightPlay {
  /** The current or last fight; null before the first. */
  sync: EncounterSync | null = null;
  /** Where the fight's own inputs go and what its witness's frames are worth (M10 T7). */
  route: RefereeRoute | null = null;
  /** Own inputs sent to a witness. */
  private witnessInputs = 0;
  /** The fight's corrections, as `[from, frames, resync]`, the last 200. */
  private rolls: [number, number, boolean][] = [];
  /** The stance the own input carries (1, 2 and 3 set it). */
  stance: Stance = 'balanced';
  /** A brace asked for (Shift or the right button) goes out with the next frame's input. */
  private braceQueued = false;
  /** The target the player chose (Tab or a click) as a target code, or null for the nearest. */
  private chosen: number | null = null;
  /**
   * `debug.autoBrace` (a test aid, M7 T12): the own input braces whenever a windup aimed at the
   * player or its egg has `AUTO_BRACE_TICKS` or fewer left as its frame begins.
   */
  autoBrace = false;
  /**
   * `debug.holdBelly` (a test aid): in free roam, while carrion lies on the water, the player's
   * energy is lifted over its cap before each tick, so it eats none of it.
   */
  holdBelly = false;
  /** The life that fights. */
  private life: { player: CreatureState; world: World } | null = null;
  /** Each fight's settlement, checked after its end (M8 T12). */
  readonly verify: FightVerify;
  /** The fight's genome refs (`genomeRefOf`) by creature, from its start and joins: proxies name its bodies (M8 T11). */
  private readonly refs = new Map<string, number>();
  /** The fight as the proxy relay reads it, kept between frames. */
  private relayView: (RelayFight & { players: string[] }) | null = null;

  constructor(private readonly host: FightHost) {
    this.verify = new FightVerify({ keys: () => host.keys?.() ?? Promise.resolve(null) });
  }

  /** Locked in a fight that has not ended: snapshots carry the fighting bit. */
  get fighting(): boolean {
    return this.sync?.running === true && this.life !== null;
  }

  /** The hub clock now, in ms. */
  hubNow(): number {
    return this.host.hubNow();
  }

  /** A fight message from the hub (`lock-ask` is answered elsewhere). */
  receive(msg: FightMsg): void {
    if (msg.t === 'enc-start') {
      if (msg.enc !== this.sync?.id) this.refs.clear();
      for (const f of msg.fighters) this.noteRef(f);
    }
    if (msg.t === 'enc-join') this.noteRef(msg.fighter);
    if (msg.t === 'enc-start') this.begin(msg);
    else if (msg.t === 'enc-frame') this.hubFrame(msg);
    else if (msg.t === 'enc-join') this.sync?.join(msg);
    else if (msg.t === 'enc-referee') this.route?.referee(msg);
    else if (msg.t === 'enc-end') this.finish(msg);
  }

  private begin(msg: Extract<FightMsg, { t: 'enc-start' }>): void {
    const { host } = this;
    const me = host.me();
    const pond = host.pond();
    const life = host.life();
    const bodies = host.body ? (text: string) => host.body?.(text) ?? null : undefined;
    if (this.fighting) {
      // The authority's resync of the running fight (M8 T10): its history follows and replaces
      // what this client had. The creature stays the fighter's; stance and target carry on.
      if (pond && this.sync?.id === msg.enc) this.sync.start(msg, pond, bodies, true);
      return;
    }
    if (!me || !pond || !life) return;
    host.prepare?.();
    const route = this.routeFor(msg.enc);
    const rolls: [number, number, boolean][] = [];
    const sync: EncounterSync = new EncounterSync({
      me,
      // The lead is the latency to the referee of the frame about to be played.
      oneWayMs: () => route.oneWayMs(sync.frame),
      send: (m) => route.send(m),
      sample: () => this.sample(),
      events: (events) => host.events?.(events),
      rolled: (from, frames, resync) => {
        rolls.push([from, frames, resync]);
        if (rolls.length > 200) rolls.shift();
      },
    });
    // The hub sends an `enc-start` only to its fighters and to a joiner (M7 T15), whose slot
    // comes with its `enc-join`.
    if (!sync.start(msg, pond, bodies, true)) return;
    this.sync = sync;
    this.route = route;
    this.rolls = rolls;
    this.witnessInputs = 0;
    this.life = life;
    this.stance = 'balanced';
    this.braceQueued = false;
    this.chosen = null;
  }

  /** A fight's route: own inputs to each frame's referee, signed to a witness, and its frames checked. */
  private routeFor(enc: string): RefereeRoute {
    const { host } = this;
    return new RefereeRoute({
      enc,
      sendHub: (m) => host.send(m),
      sendWitness: (witness, ev) => {
        this.witnessInputs++;
        host.sendWitness?.(witness, ev);
      },
      signInput: (f, code) => host.signInput?.(enc, f, code) ?? '',
      frameSigned: (witness, f, inputs, sig) =>
        host.frameSigned?.(witness, enc, f, inputs, sig) ?? false,
      oneWayMs: (by) =>
        by === AUTHORITY ? host.oneWayMs() : (host.peerOneWayMs?.(by) ?? host.oneWayMs()),
    });
  }

  /** The authority's frame: where it differs from the witness's frame held for it, it overrules it. */
  private hubFrame(msg: Extract<FightMsg, { t: 'enc-frame' }>): void {
    const { sync, route } = this;
    if (!sync) return;
    if (route && sync.id === msg.enc && route.hubFrame(msg)) sync.overrule(msg);
    else sync.receive(msg);
  }

  /** A witness's signed frame from peer `from` (M10 T7): checked by the route, then played as the referee's. */
  witnessFrame(from: string, ev: WitnessFrame): void {
    const { sync, route } = this;
    if (!sync?.running || !route || ev.enc !== sync.id) return;
    const frame = route.witnessFrame(from, ev);
    if (frame) sync.receive(frame);
  }

  /** The fight's referee now: a witness's player id, or the authority. */
  referee(): string {
    return this.route?.spans.last().by ?? AUTHORITY;
  }

  /** The longest rollback and the resyncs around each handover to or from a witness. */
  private aroundHandover(): { rollback: number; resyncs: number } {
    const spans = this.route?.spans.list().slice(1) ?? [];
    let rollback = 0;
    let resyncs = 0;
    for (const [from, frames, resync] of this.rolls) {
      if (!spans.some((s) => Math.abs(from - s.from) <= HANDOVER_WINDOW)) continue;
      if (resync) resyncs++;
      else rollback = Math.max(rollback, frames);
    }
    return { rollback, resyncs };
  }

  /**
   * A `life` from the hub names the fight the creature is locked in, if any (M8 T10). A running
   * fight it does not name ended while this page was away and its `enc-end` was lost: the fight
   * stops here, and free roam carries on from where the creature was.
   */
  named(fight: string | undefined): void {
    const { sync } = this;
    if (!sync?.running || sync.id === fight) return;
    sync.abandon();
    this.life = null;
  }

  /** The own slot, while it is seated in the running fight; -1 otherwise. */
  private seat(): number {
    const { sync } = this;
    const enc = sync?.enc;
    return this.fighting && enc && sync.slot >= 0 && sync.slot < enc.fighters.length
      ? sync.slot
      : -1;
  }

  /** Tab: the next living opponent or whole egg, nearest first. False outside a fight. */
  cycleTarget(): boolean {
    const slot = this.seat();
    const enc = this.sync?.enc;
    if (slot < 0 || !enc) return false;
    this.chosen = nextTarget(enc, slot, this.chosen);
    return this.chosen !== null;
  }

  /** A click at (x, y) in the world on a fighter or an egg targets it; false (no change) when it hits none. */
  pickTarget(x: number, y: number, pick: number): boolean {
    const slot = this.seat();
    const enc = this.sync?.enc;
    if (slot < 0 || !enc) return false;
    const code = targetAt(enc, slot, x, y, pick);
    if (code === null) return false;
    this.chosen = code;
    return true;
  }

  /** Shift or the right button: the next frame's input braces. Nothing outside a fight. */
  brace(): void {
    if (this.fighting) this.braceQueued = true;
  }

  /** The own input as its frame begins: the steering of this tick, the stance, the nearest target and a queued brace. */
  private sample() {
    const { host, sync } = this;
    if (host.hidden() || !sync) return null;
    const s = host.steering();
    const auto =
      this.autoBrace && sync.enc !== null && threatened(sync.enc, sync.slot, AUTO_BRACE_TICKS);
    const brace = this.braceQueued || auto;
    this.braceQueued = false;
    return {
      steer: s.steer,
      throttle: s.throttle,
      dash: s.dash,
      stance: this.stance,
      // The chosen target while it is valid; the own slot names none, so the nearest is struck.
      target: sync.enc ? inputTarget(sync.enc, sync.slot, this.chosen) : sync.slot,
      brace,
    };
  }

  /** The life the fight began in, while it is still the one playing. */
  private current(): { player: CreatureState; world: World } | null {
    const { life } = this;
    return life && this.host.life()?.player === life.player ? life : null;
  }

  /**
   * One tick of the life while locked: the encounter steps every frame begun by now and the
   * creature mirrors its fighter. False when free roam runs this tick (no fight, or frame 0 has
   * not begun yet).
   */
  tick(): boolean {
    const life = this.mirror(false);
    if (life) life.world.tick++;
    return life !== null;
  }

  /**
   * Back in the fight after a reload (M8 T10), its held messages applied: it counts as a rejoin,
   * and the encounter catches up to the present in one step, so the creature is in its fighter's
   * place before any tick (before frame 0, at its start). False when the fight is not running.
   */
  resumed(): boolean {
    const { sync } = this;
    if (!sync?.running) return false;
    sync.rejoins++;
    return this.mirror(true) !== null;
  }

  /**
   * Steps the encounter to now and sets the creature from its fighter; the life it set, or null
   * when free roam runs (no fight, or frame 0 has not begun and `early` is false).
   */
  private mirror(early: boolean): { player: CreatureState; world: World } | null {
    const { sync } = this;
    if (!sync?.running) return null;
    const life = this.current();
    if (!life) return null;
    const hubNow = this.host.hubNow();
    sync.step(hubNow);
    if (sync.frame === 0 && !early) return null;
    const body = sync.ownBody();
    const pose = sync.pose(sync.slot, hubNow, false);
    if (!body || !pose) return null;
    const { player } = life;
    player.x = pose.x;
    player.y = pose.y;
    player.heading = pose.heading;
    player.vx = body.vx;
    player.vy = body.vy;
    player.biomass = body.biomass;
    player.energy = body.energy;
    // A predicted death waits for the referee's word: the creature lives on until `enc-end`.
    player.health = Math.max(0, body.health);
    player.dashReadyTick = body.dashReadyTick;
    return life;
  }

  /** The referee's end: the creature takes its result, and free roam carries on from it. */
  private finish(msg: Extract<FightMsg, { t: 'enc-end' }>): void {
    const { sync } = this;
    const own = sync?.end(msg);
    if (!sync || !own) {
      // A joiner whose join frame never came plays on in free roam as it was.
      if (sync?.over) this.life = null;
      return;
    }
    this.verify.check(msg.settlement, { enc: sync.id, frames: sync.held, hash: sync.hash });
    const life = this.current();
    this.life = null;
    if (!life) return;
    const { player } = life;
    player.x = own.x;
    player.y = own.y;
    player.vx = own.vx;
    player.vy = own.vy;
    player.heading = own.heading;
    player.biomass = own.biomass;
    player.energy = own.energy;
    player.health = own.health;
    const body = sync.ownBody();
    if (body) player.dashReadyTick = body.dashReadyTick;
    if (own.outcome === 'killed' || own.outcome === 'died') {
      player.health = 0;
      player.alive = false;
      player.cause = own.cause ?? 'killed';
    }
  }

  /** Remote fighters are drawn where the encounter has them, a rollback's correction eased. */
  drawRemotes(views: readonly Drawn[]): void {
    const { sync } = this;
    const enc = sync?.enc;
    if (!sync || !enc || !this.fighting) return;
    const hubNow = this.host.hubNow();
    for (const f of enc.fighters) {
      if (f.slot === sync.slot) continue;
      const view = views.find((v) => v.id === f.player);
      const pose = view ? sync.pose(f.slot, hubNow) : null;
      if (!view || !pose) continue;
      view.x = pose.x;
      view.y = pose.y;
      view.heading = pose.heading;
      view.radius = radiusOf(f.body);
    }
  }

  private noteRef(f: FighterInfo): void {
    if (this.refs.has(f.creature)) return;
    this.refs.set(f.creature, genomeRefOf(bodyFromText(f.genome)?.hash ?? ''));
  }

  /**
   * The current or last fight as the proxy relay reads it (M8 T11): its players by slot, and each
   * one as peers would see it, from the last confirmed state. Null before the first fight.
   */
  relayFight(): RelayFight | null {
    const { sync } = this;
    const enc = sync?.enc;
    if (!sync || !enc) return null;
    let view = this.relayView;
    if (!view || view.id !== sync.id) {
      view = { id: sync.id, players: [], snapshot: (slot) => this.confirmedSnapshot(slot) };
      this.relayView = view;
    }
    if (view.players.length !== enc.fighters.length)
      view.players = enc.fighters.map((f) => f.player);
    return view;
  }

  private confirmedSnapshot(slot: number): SnapshotFields | null {
    const state = this.sync?.confirmedState();
    const f = state?.fighters[slot];
    if (!state || !f) return null;
    const egg = f.eggBody !== null && f.eggBody.by < 0;
    const marks = { ready: false, egg, spawnProtected: false, fighting: true };
    return snapshotOf(f.body, state.world.tick, this.refs.get(f.creature) ?? 0, marks);
  }

  /** What the target ring marks, while the player is seated in a fight that offers a choice. */
  aim(): { code: number; chosen: boolean } | null {
    const slot = this.seat();
    const enc = this.sync?.enc;
    return slot >= 0 && enc ? markedTarget(enc, slot, this.chosen) : null;
  }

  /** The fight as the test hook shows it; null before the first. */
  view(): EncounterView | null {
    const { sync } = this;
    const enc = sync?.enc;
    if (!sync || !enc) return null;
    const tick = enc.world.tick;
    const last = this.route?.spans.last() ?? { by: AUTHORITY, from: 0 };
    const { host } = this;
    return {
      id: sync.id,
      slot: sync.slot,
      frame: sync.frame,
      confirmed: sync.confirmed,
      over: sync.over,
      hash: sync.hash,
      endHash: sync.endHash,
      rollbacks: sync.rollbacks,
      resyncs: sync.resyncs,
      desyncs: sync.desyncs,
      rejoins: sync.rejoins,
      verified: this.verify.verdict(sync.id),
      aim: this.aim(),
      referee: { by: last.by, from: last.from },
      handovers: (this.route?.spans.list().length ?? 1) - 1,
      disputes: this.route?.disputes ?? 0,
      witnessInputs: this.witnessInputs,
      resent: this.route?.resent ?? 0,
      aroundHandover: this.aroundHandover(),
      fighters: enc.fighters.map((f) => {
        const winding = f.fx.windupEnd >= 0;
        const egg = f.eggBody;
        return {
          player: f.player,
          creature: f.creature,
          x: f.body.x,
          y: f.body.y,
          heading: f.body.heading,
          health: f.body.health,
          maxHealth: maxHealth(f.body.biomass),
          stance: f.fx.stance,
          windup: winding ? Math.max(0, f.fx.windupEnd - tick) : null,
          target: winding ? f.fx.windupTarget : null,
          braced: f.fx.braceUntil >= tick,
          egg: egg ? { x: egg.x, y: egg.y, health: egg.health, eaten: egg.by >= 0 } : null,
          outcome: f.status,
          radius: radiusOf(f.body),
          reach: strikeReach(f),
          staggered: f.fx.staggerUntil > tick,
          outside: f.outside,
          away: f.slot !== sync.slot && host.present?.(f.player) === false,
        };
      }),
    };
  }
}

/** The app as a fight's host: the hub's pond and clock, the live life and this tick's steering. */
export function appFightHost(app: App): FightHost {
  const clock = () => app.keeper.current?.clock ?? null;
  const keys = app.authorityKeys;
  // Signed inputs and witness frames need `@noble/curves`, which the app shell never loads: each
  // fight loads it as it begins, long before a witness can take it over (a round and an offer later).
  let witness: typeof import('../ledger/witness') | null = null;
  return {
    ...(keys ? { keys } : {}),
    me: () => app.playerId,
    pond: () => {
      const pond = app.livePond();
      return pond && pond === app.pond ? { seed: pond.seed, size: pond.size } : null;
    },
    life: () => {
      const { session } = app;
      return session.demo || session.death !== null
        ? null
        : { player: session.player, world: session.world };
    },
    steering: () => app.input,
    send: (msg) => app.keeper.current?.send(msg),
    hubNow: () => clock()?.hubNow(performance.now()) ?? performance.now(),
    oneWayMs: () => (clock()?.rtt ?? 0) / 2,
    hidden: () => document.hidden,
    // The own genome is built already; a peer's is built once for the fight.
    body: (text) =>
      text === app.session.body.text ? app.session.body.creature : bodyFromText(text),
    events: (events) => app.fightShow.onEvents(events),
    present: (player) => player === app.playerId || app.keeper.current?.present(player) === true,
    sendWitness: (peer, ev) => app.keeper.current?.sendEvent(peer, ev),
    signInput: (enc, f, code) =>
      witness && app.identity ? witness.signInput(app.identity, enc, f, code) : '',
    frameSigned: (by, enc, f, inputs, sig) =>
      witness?.witnessFrameSigned(by, enc, f, inputs, sig) ?? false,
    peerOneWayMs: (peer) => app.duty.probes.oneWayMs(peer),
    prepare: () => {
      if (!witness) {
        void import('../ledger/witness').then(
          (m) => {
            witness = m;
          },
          () => {},
        );
      }
    },
  };
}
