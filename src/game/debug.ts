import type {
  AudioRenderOptions,
  AudioRenderResult,
  AudioView,
  CueRenderOptions,
  CueRenderResult,
} from '../audio/engine';
import type { RarityTier } from '../genome/rarity';
import type { Silhouette } from '../genome/silhouette';
import type { Beacon } from '../ledger/drand';
import type { PubKey } from '../ledger/record';
import type { AuditVerdict } from '../net/audit';
import type { AuditCase, PeerEvent } from '../net/protocol';
import type { FxSnapshot } from '../render/effects';
import type { EggPhase } from '../render/egg';
import type { GpuExtent } from '../render/gpu-watch';
import type { DrawnOutline } from '../render/outlines';
import type { Speck } from '../render/particles';
import type { ParticleLayerName, PresetName, QualitySetting } from '../render/presets';
import type { RenderInfo } from '../render/scene';
import type { ShakeKind } from '../render/shake';
import type { TelegraphInfo } from '../render/telegraph';
import type { Zone } from '../sim/bathymetry';
import type { PhysStats } from '../sim/body';
import type { EncounterLog } from '../sim/encounter/replay';
import type { FighterResult } from '../sim/encounter/types';
import type { LifeStage } from '../sim/life';
import type { InputLog } from '../sim/replay';
import type { FoodItem, FoodKind } from '../sim/types';
import type { AuditRecord } from './app-audit';
import type { FightShowView } from './app-fight';
import type { WitnessDutyView } from './app-witness';
import type { BenchStatus } from './auto-quality';
import type { ToldReport } from './away-report';
import type { Chip, HudBars } from './hud';
import type { Indicator } from './indicators';
import type { LifeView } from './life';
import type { MinimapInfo } from './minimap';
import type { DutyLink, NetLinks } from './online';
import type { DeathSummary, Screen } from './screens';
import type { WheelInfo } from './wheel';

/** Read-only views of the running game for tests and tools (`window.__bs`). */
export interface BsState {
  screen: Screen;
  /**
   * Graphics quality (M6 T4): the setting in force, the preset `auto` resolves to, and the
   * benchmark's status (`stored` means this GPU's result was read and no benchmark ran).
   */
  quality: { setting: QualitySetting; detected: PresetName; bench: BenchStatus };
  tick: number;
  /** The depth zone under the player and its depth, 0..1 (M6 T16); null on the title screen. */
  zone: Zone | null;
  depth: number | null;
  /** This browser's identity; null until the key is loaded. */
  playerId: string | null;
  /**
   * Whether the hub's last `life` on this page said the world was renewed (M6c T2, ADR 0040): true
   * at most once per identity; null until the hub has answered.
   */
  renewed: boolean | null;
  /**
   * The last fight told on this page as settled while the player was away (M8 T12): the hub's
   * `FightReport` (`enc`, `outcome`, `cause`, `by` and `eggBy` as player names, `egg`, `frames`)
   * and the `lines` shown; null before one.
   */
  report: ToldReport | null;
  /** Food items handed to the renderer this tick. */
  visibleFood: number;
  /** The carrion pieces on the water in this life's world (M7 T14), in id order. */
  carrion: { id: string; x: number; y: number; value: number; radius: number }[];
  /**
   * The current or last refereed fight (M7 T10); null before the first. `frame` counts the frames
   * simulated here, `confirmed` those the referee's bundles cover from frame 0, `over` that its
   * `enc-end` arrived, `hash` the local `hashEncounter` then. Each fighter (by slot) has its
   * simulated `x`, `y`, `heading`, `health`, `maxHealth`, `stance`, `windup` (ticks left, or null),
   * `target` (the windup's target code, or null), `braced`, `egg` and `outcome` (`in` while it
   * fights), and (M7 T12) `radius`, `staggered` and `outside` (ticks outside every opponent's
   * escape range). `hud` is the combat HUD (`shown`, `stance`, `brace` `{ ready, cooldown, active }`,
   * `opponents` `{ player, health }`, `escape` 0..1) and the fight's cues so far (`windups` aimed
   * at the player, `blocks` and `hits`). `rejoins` (M8 T10) counts the resyncs and the resume after
   * a reload that brought this page back into the fight.
   */
  encounter: FightShowView | null;
  /** The creature being played; null on the title screen. */
  player: {
    x: number;
    y: number;
    /** World units. */
    radius: number;
    biomass: number;
    energy: number;
    health: number;
    alive: boolean;
    /** World units per second now. */
    speed: number;
    /** Past 85% of the lifespan: slower and hungrier. */
    elder: boolean;
    /** The body this life hatched with (M3). */
    genomeHash: string;
    species: string;
    /** The body's silhouette class (M6 T8). */
    silhouette: Silhouette;
    rarity: RarityTier;
    /** Size tier of the fully grown body. */
    tier: number;
    /** What the sim sees of the body. */
    stats: PhysStats;
  } | null;
  /** Set once the player has died. */
  death: DeathSummary | null;
  /**
   * The recorded life (M4): `status` is the client's state machine (`idle`, `requesting`,
   * `awaiting`, `verifying`, `playing`, `dead`, `practice`), `genome` the hash of the body now
   * played (null on the title screen), `lastAckN` the last progress report the hub took, `stage`
   * the life stage now (null without a recorded life), `remainingMs` the time left in it, and
   * `limitMs` how long until the next recorded hatch (0 when one is free).
   */
  life: LifeView & {
    genome: string | null;
    stage: LifeStage | null;
    remainingMs: number | null;
    limitMs: number;
  };
  /**
   * Courting (M5): the flow's `state`, the line it shows (`text`: the hint beside a creature in
   * reach, else the note), the invitation's `invite` name and seconds `left`, `visited` states, and
   * the cooldown line under the life bar.
   */
  mate: {
    state: string;
    text: string;
    invite: { name: string; from: string; leftMs: number } | null;
    visited: string[];
    ready: string;
  };
  /**
   * The pending child (M5 T11): the offspring flow's `kind` (`none`, `verifying`, `failed`, `egg`,
   * `card`), the child's creature id, species, rarity, generation and genome hash, whether the card
   * and the egg are on screen, and the ids of the choices the death and title screens offer.
   */
  offspring: {
    kind: string;
    creature: string | null;
    species: string | null;
    rarity: string | null;
    generation: number | null;
    genomeHash: string | null;
    cardShown: boolean;
    eggShown: boolean;
    options: string[];
  };
  /** The other players in the pond, as drawn (alpha fades when they go quiet). */
  remotes: {
    id: string;
    name: string;
    x: number;
    y: number;
    alpha: number;
    /** World units, from the snapshot's biomass. */
    radius: number;
    /** The genome hash of the body drawn, or null while the tinted fallback cell stands in. */
    genomeHash: string | null;
    species: string | null;
    /** Its snapshots say it carries an egg (M6 T20). */
    egg: boolean;
    /** Its snapshots say it is spawn-protected, or locked in a fight (M7). */
    protected: boolean;
    fighting: boolean;
    /**
     * A fighter whose player left (M8 T11): drawn from proxy snapshots or this page's own fight,
     * faded, with "away" after its name, and never offered for an engage.
     */
    away: boolean;
    /** The fastest it was drawn, as a share of its snapshots' speed: at most 1.2 (M11 T15). */
    pace: number;
  }[];
  /**
   * Attack (M7 T11): the remote the "F" glyph marks (the nearest this player could engage now) or
   * null, the remotes drawn with the protection shimmer, and whether an engage awaits its answer.
   */
  attack: { hint: string | null; shimmer: string[]; waiting: boolean };
  /**
   * The play screen's HUD (M6b T9): whether the `menu` is open, the stat `bars` as drawn (each
   * 0..1; `life` null while its bar is hidden, as on a practice cell), the `chips` shown beside them
   * and the first-life hint on screen (`hints`, its text, or null).
   */
  hud: { menu: boolean; bars: HudBars; chips: Chip[]; hints: string | null };
  /**
   * The egg (M6 T20, M6b T11): the reveal's `phase` (`none`, `waiting` for a beacon, `stirring`
   * once it came, `cracking`, `revealed`) and the `phases` it went through (the last 16), whether a
   * pending child is `carried`, whether the player's egg is `shown` this frame, the `peers` drawn
   * with one, whether a parent left by a hatch is still dissolving (`ghost`), and `motion` (`fade`
   * when motion is reduced: the setting, else `prefers-reduced-motion`; M6 T22). M6b: the player's
   * egg as last drawn, its `angle` (radians, the lean included) and `glow` (0..1), and `at`, its
   * CSS-pixel centre and half-height (null while it is not drawn); `card` is the result card or the
   * offspring card on screen, with its rarity.
   */
  egg: {
    phase: EggPhase;
    phases: EggPhase[];
    carried: boolean;
    shown: boolean;
    peers: string[];
    ghost: boolean;
    motion: 'shake' | 'fade';
    angle: number;
    glow: number;
    at: { x: number; y: number; r: number } | null;
    card: { shown: boolean; tier: RarityTier | null };
    /** 0..1: how far the player's pokes have charged the show (M6c T11). */
    charge: number;
    /** The rarity hint: 'cycling' before the beacon (or before the tier is known), then the true tier. */
    hint: RarityTier | 'cycling' | null;
    /** Whether the player paces the crack (a genesis or a hatch). */
    paced: boolean;
    /** When the beacon came and when the shell began to crack, on the egg's clock (ms); null before. */
    beaconAt: number | null;
    crackAt: number | null;
    /** How the shell came to crack: by the player (quick pokes, a hold, Enter) or by itself. */
    crackedBy: 'player' | 'auto' | null;
    /** The still scene: whether it holds, and how far it has dimmed the picture (0..1). */
    still: boolean;
    dim: number;
  };
  /** The pond this tab is in (the next hatch joins it); `members` are player ids, this one included. */
  pond: {
    id: string;
    seed: string;
    /** The world's side in wu, and its centre: where the hub's spawn ring is. */
    size: number;
    centre: { x: number; y: number };
    members: string[];
  } | null;
  /** Chat, emotes and pings as this tab sees them; `muted` holds player ids. */
  social: {
    chat: { from: string; name: string; text: string }[];
    muted: string[];
    emotes: { from: string; emote: number }[];
    pings: { from: string; kind: number; x: number; y: number }[];
    /** Social events dropped for a rate limit or a sender outside the roster. */
    dropped: number;
  };
  /**
   * The status chip's text, the hub's state ('none' without a hub), open peer connections, food
   * claims ignored as implausible, genome events dropped (too frequent, from a peer with no
   * link, or not a genome), the peers whose signed snapshot is held, the signed snapshots
   * that failed to verify (M7 T7), the proxy frames dropped (M8 T11: from a peer not
   * fighting, for a player still sending its own, or more than three from one peer), the duty
   * links by peer (M10 T6: `open` once both channels are, `encs` the fights each serves) and the
   * offers this page refused (`strangers`: no class for the caller, or no room). The links by area
   * of interest (M11 T13): each link with its class, `open` (the connection up), `hello` (the
   * peer's ticket passed) and `since` (when it did, page ms); the known creatures by source;
   * `crowded`; the `where` reports sent and the leaf last named; the signals sent through the hub,
   * relayed through a peer, forwarded for others and dropped as forged; and the links closed for a
   * failed hello (`NetLinks`).
   */
  net: NetLinks & {
    text: string;
    status: string;
    open: number;
    foodIgnored: number;
    dropped: number;
    signed: number;
    badSignatures: number;
    proxyDropped: number;
    dutyLinks: DutyLink[];
    strangers: number;
  };
  /**
   * Witness duty (M10 T6, T7, T8): `avail`, whether the hub was last told this page can witness; the
   * referee duty held now (null without one) and the last one as it ended; the duties accepted, the
   * offers declined and the batches sent over the page's life; each duty handler's time in ms (the
   * last 3,000); the event audited now (null without one), and the last 20 audits this page
   * attested, each with its verdict and the worker's time in ms.
   */
  witness: {
    avail: boolean;
    duty: WitnessDutyView | null;
    last: WitnessDutyView | null;
    duties: number;
    declined: number;
    batches: number;
    dutyMs: number[];
    auditing: string | null;
    audits: AuditRecord[];
  };
  /**
   * Edge indicators as last drawn (M6 T19): the nearest six pond players off screen and the
   * nearby pings off screen. `angle` is the world bearing from the player in degrees
   * (counter-clockwise from east), `lengths` the distance in the player's body lengths, `x`, `y`
   * the indicator's CSS-pixel position.
   */
  indicators: Indicator[];
  /** The pond map (M): whether it is open, and the player dots and pings it shows. */
  map: { open: boolean; players: number; pings: number };
  /**
   * The minimap as last drawn (M6b T10): `shown`, its radius in world units, the zone and depth
   * under the player, the `hazard` hurting now (`uv`, `pressure` or null), the `heading` its arrow
   * shows this frame (radians, M6c T12), the round `marks` the last draw painted (`players` and
   * `pings` counts; nothing else is round on it), and the `players` and `pings` on it (`id`,
   * CSS-pixel `x` and `y` inside the minimap; players' `size` class and `ready`, pings' `kind`).
   */
  minimap: MinimapInfo;
  /**
   * The social wheel (M6 T24): open, its items (with each one's CSS-pixel centre while open), the
   * world point a ping would land on, the wheel's centre and the cursor it opened at.
   */
  wheel: WheelInfo;
  /**
   * Sound (M6 T22): the context's state (`idle` before the first gesture), cues asked for since
   * hatching, volume, mute, the master gain's target, the ambience's zone and parameter targets,
   * and the cue voices sounding.
   */
  audio: AudioView;
}

/** A scripted remote creature for tests: it swims in a straight line and sends real snapshots. */
export interface ScriptedRemote {
  id: string;
  name: string;
  x: number;
  y: number;
  /** World units per second. */
  vx?: number;
  vy?: number;
  /** Default 100. */
  biomass?: number;
  /** The remote's genome (base64url, any text): its snapshots carry the ref and the body is delivered. */
  genome?: string;
  /** With `genome`: send the ref but never deliver the genome event. */
  withholdGenome?: boolean;
  /** Its snapshots carry the ready-to-mate mark (M6 T19). */
  ready?: boolean;
  /** Its snapshots carry the egg mark (M6 T20). */
  egg?: boolean;
}

export interface BsHook {
  ready: true;
  state(): BsState;
  /** How many events of each type the sim has emitted since the player hatched; `eat@<id>` and `stolen@<id>` follow single items. */
  events(): Record<string, number>;
  /** Re-runs an input log in a fresh world and returns its final state hash. */
  replay(log: InputLog): { hash: string; events: Record<string, number> };
  /** Replays an encounter log (`src/sim/encounter/replay.ts`) in this engine: its final hash and results. */
  replayEncounter(log: EncounterLog): { hash: string; results: FighterResult[] };
  audio: {
    /** Renders the sound engine's ambience on an `OfflineAudioContext` and measures it (M6 T22). */
    render(options: AudioRenderOptions): Promise<AudioRenderResult>;
    /** Renders one cue alone on an `OfflineAudioContext`: its measures, length and channels (M6 T23). */
    renderCue(options: CueRenderOptions): Promise<CueRenderResult>;
  };
  render: {
    /** `telegraphs` (M7 T12): the marks drawn this frame and the flashes, sparks and wobbles. */
    info(): Omit<RenderInfo, 'telegraphs'> & { telegraphs: TelegraphInfo };
    fx(): FxState;
    /** The specks of a particle layer as last drawn: on-screen position, size, depth and blur. */
    specks(layer: ParticleLayerName): Speck[];
    /** The size outlines as last drawn (M6 T21): kind, CSS-pixel centre and radius, pulse 0..1. */
    outlines(): DrawnOutline[];
    /**
     * With `?gpu=watch` (M11 T11): the largest |float| sent to the GPU so far (uniforms and vertex
     * buffers), the uniform that sent it and the uploads seen; null without the switch.
     */
    gpu(): GpuExtent | null;
    /**
     * The player's egg's swing in radians at `atMs` on the egg's clock (`performance.now()` while
     * the world runs), lean included (M6b T11): a slow software frame cannot hide a wobble's peak.
     */
    eggAngle(atMs: number): number;
  };
  life: {
    /** The DNA of the last genesis, recomputed from its beacon and commitment, and its record's rules version; null before one. */
    recompute(): Promise<{
      rules: number;
      round: number;
      commit: string;
      genomeHash: string;
    } | null>;
  };
  /** Genome code run in this engine; present only with `?debug=1`. */
  genome?: BsGenome;
  /** Mutating helpers; present only with `?debug=1`. */
  debug?: BsDebug;
}

export interface BsGenome {
  /** The plan and stats hashes of each genome (base64url), for comparing engines against the Node goldens. */
  hashes(genomes: readonly string[]): { planHash: string; statsHash: string }[];
}

/** The feedback cues now showing: counts since hatching, plus the camera's current zoom. */
export interface FxState extends FxSnapshot {
  /**
   * The damage hits (M6c T9): the body's offset and the camera's now, in CSS pixels, the kind of
   * the hit still settling (`uv`, `pressure`, `jolt`) or null, and the hits since hatching.
   */
  shake: { body: number; camera: number; kind: ShakeKind | null; hits: number };
  /** Visible half-height in world units, as drawn. */
  halfHeight: number;
  /** Where the camera looks, in world units. */
  camX: number;
  camY: number;
}

export interface BsDebug {
  /** Sets the player's energy (clamped to its maximum). */
  setEnergy(energy: number): void;
  /** Sets the player's biomass (growth to a new size); energy and health keep their fractions. */
  setBiomass(biomass: number): void;
  /** Sets the player's health here only (never above its maximum); the hub hears it in snapshots. */
  setHealth(hp: number): void;
  /**
   * A test aid (M7 T12, client inputs only): while on, the player's fight input braces whenever a
   * windup aimed at it or its egg has 4 ticks or fewer left as the frame begins.
   */
  autoBrace(on: boolean): void;
  /**
   * A test aid: while on, the player eats no carrion in free roam (its energy is held over the cap
   * whenever pieces lie on the water). A kill's reward opens room for as much as the pieces hold,
   * so the killer would otherwise eat them before anyone else saw them.
   */
  holdBelly(on: boolean): void;
  /**
   * A test aid: while on, the scene still updates (`render.info()` counts, the HUD) but skips its
   * draw call. Software rendering is the cost of a frame on a runner, and a fight page that draws
   * a frame in over 100 ms misses the referee's input deadline.
   */
  skipDraw(on: boolean): void;
  /**
   * A test aid (M10 T8): works out an auditor's verdict on `audit` in the page's audit worker, as
   * an auditor duty does, and resolves with it and the worker's time in ms. Nothing is sent.
   */
  audit(
    audit: AuditCase,
    beacon: Beacon,
    keys: PubKey[],
  ): Promise<{ verdict: AuditVerdict; ms: number }>;
  /** Moves the player and stops it. */
  teleport(x: number, y: number): void;
  /** Sets the room for links of P2 to P4 (1 to 24; M11 T13); P0 and P1 may still reach 32. */
  netCap(cap: number): void;
  /**
   * Moves the player (as `teleport`) to the nearest point well inside that zone, clear of its edge
   * bands with its surround in the zone too, and returns it (M6 T16).
   */
  setZone(zone: Zone): { x: number; y: number };
  /** The food item closest to the player (of this kind, if given), or null. */
  nearestFood(kind?: FoodKind): FoodItem | null;
  /**
   * Swims at full throttle towards a target (in a fight too); resolves true once it is eaten or
   * reached, false on a timeout or if it vanished. An `id` names a food item or a remote player,
   * whose drawn body is followed and reached on touching it.
   */
  steerTo(target: { id?: string; x: number; y: number }): Promise<boolean>;
  /**
   * A test aid (M10 T7, client inputs only): while set, the player keeps its centre `distance` wu
   * from a remote player's drawn centre (in a fight, where the encounter has it), easing in as a
   * cursor on that spot would, and coasts while the remote is not drawn. `steerTo`, `null` or a
   * new life ends it.
   */
  hover(target: { id: string; distance: number } | null): void;
  /** Adds a toxic plume to the world. */
  spawnPlume(x: number, y: number, radius?: number): void;
  /** Replaces the scripted remotes (an empty list removes them); they send snapshots at 10 Hz. */
  setRemotes(remotes: readonly ScriptedRemote[]): void;
  /**
   * Joins a pond for the next hatch without a hub: its seed, epoch and the hub clock's reading now
   * (hub ms), and where this tab's food claims go. Tests relay them to other tabs.
   */
  joinPond(spec: {
    seed: string;
    epoch: number;
    hubNow: number;
    send(event: PeerEvent): void;
  }): void;
  /**
   * Delivers a peer's `event` message as if its data channel had; invalid ones are dropped. A
   * genome event skips the link and rate checks, which the unit tests cover. Chat, emotes and
   * pings go through `Social`, from a scripted remote's id (it is in the roster).
   */
  deliver(from: string, event: unknown): void;
  /** Whether the food item (`c3_5_s2_k0`) is in the field now. */
  hasFood(id: string): boolean;
  /**
   * Replaces every measured frame time with `ms` and re-runs the auto-detect benchmark on it at
   * once; adaptive resolution then follows `ms` too, even where it is otherwise pinned at 1.
   */
  setBench(ms: number): void;
  /**
   * A test aid (M10 T8): the frame time witness availability judges is `ms` (null: the measured
   * one again), as `setBench` does for the quality. Four software-rendered pages on one runner draw
   * slower than a witness may, and a scenario about audits needs its witnesses to stay available.
   */
  dutyFrameMs(ms: number | null): void;
  /** Runs the sim this many times faster than real time; 0 also holds the shaders' animation clock. */
  timeScale(scale: number): void;
  /**
   * Freezes the world (as `timeScale(0)`) at sim tick `tick` with the player stopped at (`x`, `y`)
   * and the camera on it, so a shot does not depend on how many ticks a slow runner played before
   * the freeze: the food's bob and the player's drift are the same on every page.
   */
  freezeAt(tick: number, x: number, y: number): void;
  /** Zeroes the marine snow's flow and, in a frozen world, the shaders' clock: frozen shots then agree (M6 T17). */
  resetWater(): void;
  /** Sets the shaders' clock to this many seconds in a frozen world, leaving the snow's flow (M6b T8). */
  setClock(seconds: number): void;
}

declare global {
  interface Window {
    __bs?: BsHook;
  }
}

export function installHook(hook: BsHook): void {
  window.__bs = hook;
}
