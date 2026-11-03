// The player's side of a refereed fight (M7 T10): from `enc-start` the encounter, not free roam,
// moves the player's creature; the creature mirrors its fighter so the HUD, the bars, the snapshots
// and the camera keep working, remote fighters are drawn from the encounter, and at `enc-end` free
// roam carries on from the authority's result. DOM-free: the app supplies a `FightHost`.

import type { Creature } from '../genome/stats';
import { bodyFromText } from '../net/encounter-start';
import { EncounterSync } from '../net/encounter-sync';
import type { FightMsg } from '../net/hub-client';
import type { ClientMsg } from '../net/protocol';
import { radiusOf } from '../sim/encounter/reach';
import type { Encounter, EncounterEvent, Outcome, Stance } from '../sim/encounter/types';
import type { Input } from '../sim/input';
import type { CreatureState, World } from '../sim/types';
import { maxHealth } from '../sim/vitals';
import type { App } from './app';
import { aimsAt } from './fight-cues';
import { inputTarget, markedTarget, nextTarget, targetAt } from './fight-target';

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
}

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
  /** Staggered by a block: no windup starts (M7 T12). */
  staggered: boolean;
  /** Ticks in a row outside every living opponent's escape range (M7 T12). */
  outside: number;
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
  fighters: FighterView[];
  /**
   * What the target ring marks (M7 T15): a target code (0-3 a slot, 4-7 that slot's egg), and
   * whether the player chose it (Tab or a click) or it is the nearest by default. Null when
   * targeting is not offered (a plain duel) or the player is not seated.
   */
  aim: { code: number; chosen: boolean } | null;
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
  /** The life that fights. */
  private life: { player: CreatureState; world: World } | null = null;

  constructor(private readonly host: FightHost) {}

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
    if (msg.t === 'enc-start') this.begin(msg);
    else if (msg.t === 'enc-frame') this.sync?.receive(msg);
    else if (msg.t === 'enc-join') this.sync?.join(msg);
    else if (msg.t === 'enc-end') this.finish(msg);
  }

  private begin(msg: Extract<FightMsg, { t: 'enc-start' }>): void {
    const { host } = this;
    const me = host.me();
    const pond = host.pond();
    const life = host.life();
    if (this.fighting || !me || !pond || !life) return;
    const sync = new EncounterSync({
      me,
      oneWayMs: () => host.oneWayMs(),
      send: (m) => host.send(m),
      sample: () => this.sample(),
      events: (events) => host.events?.(events),
    });
    // The hub sends an `enc-start` only to its fighters and to a joiner (M7 T15), whose slot
    // comes with its `enc-join`.
    const bodies = host.body ? (text: string) => host.body?.(text) ?? null : undefined;
    if (!sync.start(msg, pond, bodies, true)) return;
    this.sync = sync;
    this.life = life;
    this.stance = 'balanced';
    this.braceQueued = false;
    this.chosen = null;
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
    const { sync } = this;
    if (!sync?.running) return false;
    const life = this.current();
    if (!life) return false;
    const hubNow = this.host.hubNow();
    sync.step(hubNow);
    if (sync.frame === 0) return false;
    const body = sync.ownBody();
    const pose = sync.pose(sync.slot, hubNow, false);
    if (!body || !pose) return false;
    const { player, world } = life;
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
    world.tick++;
    return true;
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
      aim: this.aim(),
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
          staggered: f.fx.staggerUntil > tick,
          outside: f.outside,
        };
      }),
    };
  }
}

/** The app as a fight's host: the hub's pond and clock, the live life and this tick's steering. */
export function appFightHost(app: App): FightHost {
  const clock = () => app.keeper.current?.clock ?? null;
  return {
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
  };
}
