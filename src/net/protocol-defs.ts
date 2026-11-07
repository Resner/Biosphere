import type { GenesisAsk } from '../ledger/ask';
import type { Beacon } from '../ledger/drand';
import type { Commitment } from '../ledger/genesis';
import type { MateAsk } from '../ledger/mate-ask';
import type { RecordRequest, Status, StoredRecord } from '../ledger/record';
import type { SignedSeat } from '../ledger/seat';
import type { FightLog, SignedSettlement } from '../ledger/settlement';
import type { SignedAttestation } from '../ledger/witness-doc';
import type { DeathCause } from '../sim/types';

/** Wire protocol shared by clients and the Worker. No DOM or Node APIs. */
export const PROTOCOL_VERSION = 11;

/** Hub WebSocket close codes. */
export const CLOSE_REPLACED = 4001;
export const CLOSE_BAD_HELLO = 4002;
export const CLOSE_RATE_LIMITED = 4003;
export const CLOSE_ORIGIN = 4004;

/** Size caps in UTF-8 bytes. A `signal` carries an SDP of up to `SDP_MAX_BYTES`, so it gets more room. */
export const HUB_MAX_BYTES = 4096;
/** A welcome lists up to 23 members plus ICE servers with long TURN credentials and a seat ticket (about 5.3 KB at worst). */
export const WELCOME_MAX_BYTES = 8192;
export const SIGNAL_MAX_BYTES = 12288;
export const SDP_MAX_BYTES = 8192;
/** A `genesis` carries a record, a commitment, a beacon and a genome text. */
export const GENESIS_MAX_BYTES = 8192;
/** A `born`: three genomes, three records and a commitment with two asks. */
export const BORN_MAX_BYTES = 32_768;
/** A `history` carries up to `HISTORY_MAX` past lives of about 250 bytes each. */
export const HISTORY_MAX_BYTES = 8192;
/** A `lineage`: up to `LINEAGE_MAX` creatures and `PEDIGREE_MAX` ancestors, each with a genome text of up to 595 characters (karyotype v2; about 110 KB at worst). */
export const LINEAGE_MAX_BYTES = 131_072;
export const LINEAGE_MAX = 64;
export const PEDIGREE_MAX = 64;
export const EVENT_MAX_BYTES = 2048;
export const SNAPSHOT_BYTES = 29;
/** The snapshot layout version, the last byte of every snapshot. */
export const SNAPSHOT_VERSION = 5;
/** An Ed25519 signature. */
export const SIGNATURE_BYTES = 64;
/** A state-channel frame for engage candidates: the snapshot, then its 64-byte signature (ADR 0050). */
export const SIGNED_FRAME_BYTES = SNAPSHOT_BYTES + SIGNATURE_BYTES;
/** An Ed25519 public key: a player id's 32 bytes. */
export const PLAYER_KEY_BYTES = 32;
/** A state-channel proxy frame of an away fighter (ADR 0053): its player's key, then its snapshot. */
export const PROXY_FRAME_BYTES = PLAYER_KEY_BYTES + SNAPSHOT_BYTES;
/** An `enc-start` carries up to 4 fighters with their genome texts; an `enc-end` up to 4 outcomes and the signed settlement. */
export const ENC_START_MAX_BYTES = 8192;
export const ENC_END_MAX_BYTES = 8192;
/** An encounter's frames run 0 to 900 (the timeout), so a frame number past this is malformed. */
export const ENC_MAX_FRAME = 1000;
export const ENC_MAX_FIGHTERS = 4;

/**
 * Witnesses (protocol 10, ADR 0058): a `batch` to the authority, and a `duty` with a fight's history
 * or an audit's case. The largest batch (20 frames of 4 signed inputs) is about 8.2 KB.
 */
export const BATCH_MAX_BYTES = 12_288;
export const DUTY_MAX_BYTES = 131_072;
/** A batch carries 1 to 20 frames (a witness sends 10 at a time, and catches up with more). */
export const BATCH_MAX_FRAMES = 20;
/** A referee duty's history holds at most a whole fight's frames (90 s at 10 Hz), and its joins. */
export const DUTY_HISTORY_FRAMES = 900;
/** A `lock-state` carries at most this many of the target's copies of the attacker's signed snapshots (M10 T11). */
export const SEEN_MAX = 5;

/**
 * The world and its directory (protocol 11, M11, ADR 0062). A `near` lists up to 48 peers and 64
 * swarm points within `NEAR_MAX_BYTES` (the hub drops the farthest to stay within it); a gossip
 * `peers` event up to 16. A `relay` peer event carries an SDP, so it alone may pass
 * `EVENT_MAX_BYTES`, up to `RELAY_MAX_BYTES`.
 */
export const NEAR_MAX = 48;
export const SWARM_MAX = 64;
export const NEAR_MAX_BYTES = 8192;
export const GOSSIP_MAX = 16;
export const RELAY_MAX_BYTES = 10_240;
/** The size cap of a peer event of type `t`, for the sender and the receiver alike. */
export const peerEventMax = (t: unknown): number =>
  t === 'relay' ? RELAY_MAX_BYTES : EVENT_MAX_BYTES;
/** Positions on the wire lie in 0 to 2^29 wu (exclusive), the snapshot's reach. */
export const WIRE_POS_MAX = 2 ** 29;
/** A reported radius lies in 1 to 4096 wu, and an area of interest in 1 to 40,000 wu. */
export const WIRE_RADIUS_MAX = 4096;
export const WIRE_AOI_MAX = 40_000;
/** The snapshot rates a receiver may ask for (`rate`), in Hz. */
export const SNAPSHOT_RATES = [1, 2, 5, 10] as const;

export const CHAT_MAX_CHARS = 140;
export const CONSUMED_MAX_ENTRIES = 40;
/** Parts of a whole pond's consumed set: 32 x 32 cells x 10 slots at 40 entries per part. */
export const CONSUMED_MAX_PARTS = 256;
export const EMOTE_COUNT = 6;
export const PING_KINDS = 4;

export const NAME_RE = /^[A-Za-z0-9_-]{3,16}$/;
/** The hub's challenge nonce: 16 bytes, 22 base64url characters. */
export const NONCE_BYTES = 16;
/** Genome text: base64url, and short enough that its event stays within `EVENT_MAX_BYTES`. */
export const GENOME_DATA_MAX_CHARS = 1900;
export interface Vec2 {
  x: number;
  y: number;
}

export interface Member {
  playerId: string;
  name: string;
}

/** Joiner `i` of a pond spawns at angle `i · SPAWN_GOLDEN_ANGLE` on the spawn ring (DESIGN.md). */
export const SPAWN_GOLDEN_ANGLE = 2.399963;

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** The world a welcome names (until T14, `id` is the session's pond, a roster group of it). */
export interface WorldInfo {
  id: string;
  seed: string;
  epoch: number;
  centre: Vec2;
  /** The world's side in wu. */
  size: number;
}

/** A directory leaf: its square's lower corner and side, in wu. */
export interface Leaf {
  x: number;
  y: number;
  size: number;
}

/** A member near a reporter, as the directory last heard of it; `age` is ms since its report. */
export interface NearPeer {
  id: string;
  name: string;
  x: number;
  y: number;
  r: number;
  age: number;
}

/** A position on the wire: the centre and the radius, in wu. */
export type Pos = [x: number, y: number, r: number];

/** A commitment with the authority's countersignature over its id. */
export interface SignedCommit {
  commitment: Commitment;
  authSig: string;
  keyId: string;
}

/** The creature a player resumes: its head and condition (hundredths) and its life clock. */
export interface LifeInfo {
  creature: string;
  seq: number;
  genome: string;
  biomass: number;
  energy: number;
  health: number;
  activeMs: number;
  lifespanMs: number;
  /** The active time from which it may mate, and until which it is in cooldown (ADR 0021). */
  matureAtMs: number;
  cooldownUntilMs: number;
}

/** A frozen ancestor the player can return to: its saved condition and the head hash a `restore` must follow. */
export interface Ancestor extends LifeInfo {
  hash: string;
}

/** What a player can fall back on when no creature is active: a pending child, and the nearest surviving ancestor. */
export interface FallbackInfo {
  pending: boolean;
  ancestor: Ancestor | null;
}

/** One of the player's creatures in the lineage view. */
export interface LineageEntry {
  creature: string;
  status: Status;
  generation: number;
  species: string;
  genome: string;
  activeMs: number;
  lifespanMs: number;
  hash: string;
  chainParent: string | null;
}

/** A creature in the pedigree: its parents (null for a genesis creature), name and genome. No owner is named. */
export interface PedigreeNode {
  id: string;
  parents: [string, string] | null;
  species: string;
  genome: string;
}

/** A newborn with everything a client needs to recompute it: the birth record, its commitment and beacon, and both parents. */
export interface Born {
  record: StoredRecord;
  commit: SignedCommit;
  beacon: Beacon;
  /** The child's genome as base64url text. */
  genome: string;
  /** Both parents' genome texts, in the commitment's order (the courting player's first). */
  parents: [string, string];
  /** Both `mate-commit` records, in the same order. */
  mates: [StoredRecord, StoredRecord];
}

/** A finished life as the history lists it (ADR 0019); the species name is derived from the genome. */
export interface PastLife {
  creature: string;
  species: string;
  cause: DeathCause;
  activeMs: number;
  bornT: number;
  diedT: number;
}

/** Every cause a death record can name (a `Record`, so a new `DeathCause` fails to compile until it is listed). A client may report all but `old-age`, `killed` and `eaten` (an egg eaten in a fight), which only the authority decides. */
const CAUSES: Record<DeathCause, true> = {
  starved: true,
  toxin: true,
  'old-age': true,
  uv: true,
  pressure: true,
  killed: true,
  eaten: true,
};
export const isCause = (v: unknown): v is DeathCause =>
  typeof v === 'string' && Object.hasOwn(CAUSES, v);
/** Past lives one `history` answer carries. */
export const HISTORY_MAX = 20;

/** A snapshot signed by its sender for lock-in (`src/ledger/snapshot-sig.ts`): base64url of the 29 snapshot bytes and of the 64-byte signature. */
export interface SignedSnap {
  snap: string;
  sig: string;
}

/** A fighter at an encounter's start, as the authority sets it; numbers are JSON doubles (they round-trip exactly). */
export interface FighterInfo {
  player: string;
  creature: string;
  /** The creature's genome text, so no client needs peer genome sync to simulate the fight. */
  genome: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
  biomass: number;
  energy: number;
  health: number;
  elder: boolean;
  /** It carries a pending child, which comes into the fight as an egg (ADR 0052). */
  egg: boolean;
  /** Its worth as prey (ADR 0054): one of 1, 0.5, …, 2^-7 (`FIGHTER_WORTHS`); nothing else parses. */
  worth: number;
}

/** A fighter's changing state: its info without the fields fixed at lock-in. */
export type FighterState = Omit<FighterInfo, 'genome' | 'elder' | 'egg' | 'worth'>;

/** A fighter at an encounter's end: its final state and result. `by` and `eggBy` are slots (0–3). */
export interface FighterOutcome extends FighterState {
  outcome: 'killed' | 'died' | 'escaped' | 'stood';
  cause: DeathCause | null;
  by: number | null;
  egg: 'none' | 'kept' | 'eaten';
  eggBy: number | null;
}

/** A fight settled while its player was away, told once at the next sign-in. `by` and `eggBy` are player names. */
export interface FightReport {
  enc: string;
  outcome: FighterOutcome['outcome'];
  cause: DeathCause | null;
  /** The killer's player name. */
  by: string | null;
  egg: FighterOutcome['egg'];
  /** The eater's player name. */
  eggBy: string | null;
  frames: number;
}

/** Hub WebSocket, client to hub. */
export type ClientMsg =
  | { t: 'hello'; v: typeof PROTOCOL_VERSION; playerId: string; name: string; sig: string }
  | { t: 'genesis-request'; nonce: string; sig: string }
  /** Life report, about every 30 s: `n` counts up, `ticks` is cumulative for this connection, the rest is the condition in hundredths. */
  | { t: 'progress'; n: number; ticks: number; biomass: number; energy: number; health: number }
  /** The creature died of `cause`; `ticks` is the cumulative count as in `progress`, so the last stretch is credited. */
  | { t: 'death'; cause: DeathCause; ticks: number }
  /** The player's past lives, newest first. */
  | { t: 'history' }
  /** The player's creatures and their pedigree. */
  | { t: 'lineage' }
  /** Promotes the pending child: an owner-signed `promote` request with role `child`. */
  | { t: 'promote'; request: RecordRequest; sig: string }
  /** Restores the nearest surviving ancestor: an owner-signed `restore` request. */
  | { t: 'restore'; request: RecordRequest; sig: string }
  /** Asks whether this player's creature and the partner's could mate now, and what the partner's card says. */
  | { t: 'mate-check'; partner: string }
  /** Courts the partner: a signed ask that names them; the partner has `RULES.mating.signWindowMs` to answer. */
  | { t: 'court'; ask: MateAsk }
  /** Accepts a court with the accepter's own ask (same nonce, naming the courting player). */
  | { t: 'accept'; ask: MateAsk }
  | { t: 'decline'; partner: string }
  | { t: 'ping'; id: number }
  | { t: 'signal'; to: string; kind: 'offer' | 'answer'; sdp: string }
  | { t: 'leave' }
  /** Engages `target` (a player id) with the attacker's own fresh signed snapshot and the target's newest. */
  | { t: 'engage'; target: string; mine: SignedSnap; theirs: SignedSnap }
  /**
   * The answer to `lock-ask`: a freshly signed snapshot of the creature's current state, and the
   * attacker's signed snapshots it received in the last 2 s, for the movement check (M10 T11).
   */
  | { t: 'lock-state'; lock: string; mine: SignedSnap; seen?: SignedSnap[] }
  /** This fighter's input for frame `f` of encounter `enc`: a u32 code (`encodeFrameInput`). */
  | { t: 'input'; enc: string; f: number; i: number }
  /** Whether this client can witness now (ADR 0058): visible, the setting on, not fighting, frames fast enough. */
  | { t: 'avail'; on: boolean }
  /** The answer to a `duty`: taken (its links are open), or declined. */
  | { t: 'duty-ok'; event: string }
  | { t: 'duty-no'; event: string }
  /**
   * A witness referee's final frames `f` to `f + i.length - 1`, 1 to `BATCH_MAX_FRAMES` of them, each
   * 1 to 4 slots wide. `s[k][slot]` is the fighter's signature on that input (`signInput`), null
   * exactly where the input is null. `end` closes the witness's span (the fight's end or a stop).
   */
  | {
      t: 'batch';
      enc: string;
      f: number;
      i: (number | null)[][];
      s: (string | null)[][];
      end: boolean;
    }
  /** A fighter shows the witness's signed frame `f` (`signWitnessFrame`), which differs from the authority's. */
  | { t: 'dispute'; enc: string; f: number; i: (number | null)[]; sig: string }
  /** An auditor's verdict. */
  | { t: 'attest'; signed: SignedAttestation }
  /** The creature's centre and radius, and the sender's area-of-interest radius, in wu (M11). */
  | { t: 'where'; x: number; y: number; r: number; aoi: number }
  /** No creature in the water: the title, the death screen or a hidden tab. */
  | { t: 'gone' };

/** One entry of a referee duty's history: a finalized frame or a join, in order, without the encounter id the duty names. */
export type DutyHistory =
  | { t: 'enc-frame'; f: number; i: (number | null)[] }
  | { t: 'enc-join'; f: number; fighter: FighterInfo };

/** What an auditor re-checks (ADR 0058): a fight's log and settlement, a genesis, or a mating's records and genome texts in slot order. */
export type AuditCase =
  | { kind: 'enc'; log: FightLog; settlement: SignedSettlement }
  | { kind: 'genesis'; commitment: SignedCommit; record: StoredRecord; genome: string }
  | {
      kind: 'mating';
      commitment: SignedCommit;
      births: [StoredRecord, StoredRecord];
      mates: [StoredRecord, StoredRecord];
      parents: [string, string];
    };

/** What every duty names: its event (`dutyEvent`), the witness's position in the order, the witness commitment and its round's beacon. */
interface DutyBase {
  t: 'duty';
  event: string;
  position: number;
  commit: SignedCommit;
  beacon: Beacon;
}

/** The hub's reason a duty is over. */
export type DutyEndWhy = 'done' | 'taken-back' | 'replaced' | 'struck';

/** Hub WebSocket, hub to client. */
export type HubMsg =
  | { t: 'challenge'; nonce: string }
  | {
      t: 'welcome';
      world: WorldInfo;
      you: { spawnHint: Vec2 };
      members: Member[];
      ice: IceServer[];
      turn: boolean;
      now: number;
      /** The session's seat ticket (T7 always sends one). */
      ticket?: SignedSeat;
    }
  | { t: 'pong'; id: number; now: number }
  | { t: 'member'; op: 'join' | 'leave'; member: Member }
  /** `at`: the sender's directory position, stamped by the hub. */
  | { t: 'signal'; from: string; kind: 'offer' | 'answer'; sdp: string; at?: Pos }
  /** The answer to every `where`: the reporter's leaf, the linkable members near it, and the small ones as positions. */
  | { t: 'near'; leaf: Leaf; peers: NearPeer[]; swarm: [x: number, y: number][] }
  /** A split or merge moved the session's leaf. */
  | { t: 'leaf'; leaf: Leaf }
  /** A fresh seat ticket. */
  | { t: 'seat'; ticket: SignedSeat }
  /** After `welcome`: the player's active creature or null, and ms until the next recorded hatch (0 = now). */
  | {
      t: 'life';
      life: LifeInfo | null;
      genesisIn: number;
      pending?: Born;
      /** With no active creature: what the player can fall back on. */
      fallback?: FallbackInfo;
      /** Once per returning identity: the world was renewed since it last played (ADR 0040). */
      renewed?: true;
      /** The running encounter its creature is locked in; `enc-start` and the history follow (ADR 0053). */
      fight?: string;
      /** A fight settled while the player was away; sent once. */
      report?: FightReport;
    }
  /** The pending child is now the active creature; `parent` is the record that froze the old one (null when it was already dead). */
  | { t: 'promoted'; life: LifeInfo; parent: StoredRecord | null }
  /** The ancestor is active again with its saved condition. */
  | { t: 'restored'; life: LifeInfo }
  | { t: 'lineage'; creatures: LineageEntry[]; pedigree: PedigreeNode[] }
  /** A mating's round is published: the player's child, waiting to be promoted. */
  | ({ t: 'born' } & Born)
  /** A `progress` was taken: `activeMs` is the creature's life clock after crediting it, `lifespanMs` its total. */
  | {
      t: 'ack';
      n: number;
      activeMs: number;
      lifespanMs: number;
      matureAtMs: number;
      cooldownUntilMs: number;
    }
  /** The answer to `mate-check`: `reason` is null when they could mate, else why not (`partner-` prefix when it is theirs, `not-here` when unreachable). */
  | {
      t: 'mate-info';
      partner: string;
      /** The partner's active creature (what a court must name), or null when they are not here. */
      creature: string | null;
      reason: string | null;
      kinship: number;
      generation: number;
      tier: number;
      cooldownLeftMs: number;
    }
  /** Someone courts you: their ask, and what the card shows without any species or look. */
  | { t: 'invite'; from: string; ask: MateAsk; kinship: number; generation: number }
  | { t: 'declined'; by: string }
  /** The mating is committed to a future round: the countersigned commitment and this parent's `mate-commit` record. */
  | { t: 'mating'; commit: SignedCommit; record: StoredRecord }
  /** The creature's life is over: the cause and the `death` record that closes its chain. */
  | {
      t: 'died';
      cause: DeathCause;
      record: StoredRecord;
      fallback?: FallbackInfo;
      /** The killer's or eater's name. */
      by?: string;
    }
  | { t: 'history'; lives: PastLife[] }
  /** A genesis request was accepted: the committed round, and how many hatches are left. */
  | { t: 'commit'; commit: SignedCommit; hatchesLeft: number }
  /** The committed round's beacon exists: everything a client needs to recompute the DNA. */
  | {
      t: 'genesis';
      record: StoredRecord;
      ownerRequest: GenesisAsk;
      commit: SignedCommit;
      beacon: Beacon;
      genome: string;
    }
  | { t: 'refused'; reason: string; genesisIn?: number }
  /** Admission is full: the session waits in line (1 = next) instead of getting a `welcome`; sent again when its place changes. */
  | { t: 'queued'; position: number; etaS: number }
  | { t: 'error'; code: string }
  /**
   * Someone engages this player: answer at once with `lock-state`. `by` is the attacker's player
   * id, whose held snapshots the answer carries as `seen` (M10 T11).
   */
  | { t: 'lock-ask'; lock: string; by: string }
  /**
   * The fight starts: the seed from beacon `round` (0 = none), the pond tick `t0` and the hub time of
   * frame 0, fighters by slot. An `enc-start` for the fight a client already runs is the authority's
   * resync (a sign-in, a reconnect or a restart, ADR 0053): every `enc-frame` and `enc-join` so far
   * follows in order, and replaces the client's own history of that fight.
   */
  | {
      t: 'enc-start';
      enc: string;
      seed: string;
      round: number;
      t0: number;
      at: number;
      fighters: FighterInfo[];
    }
  /** Frame `f`'s finalized inputs by slot; null where the autopilot plays. */
  | { t: 'enc-frame'; enc: string; f: number; i: (number | null)[] }
  /** A fighter joins at frame `f`, taking the next slot. */
  | { t: 'enc-join'; enc: string; f: number; fighter: FighterInfo }
  /** The fight is over at frame `f`: the authority's `hashEncounter`, every fighter's result and the signed settlement (ADR 0054). */
  | {
      t: 'enc-end';
      enc: string;
      f: number;
      hash: string;
      fighters: FighterOutcome[];
      settlement?: SignedSettlement;
    }
  /** Referee this fight (ADR 0058): the fighters by slot, its start and everything finalized so far. */
  | (DutyBase & {
      role: 'referee';
      pondSeed: string;
      fighters: string[];
      start: Extract<HubMsg, { t: 'enc-start' }>;
      history: DutyHistory[];
    })
  /** Audit this event. */
  | (DutyBase & { role: 'auditor'; audit: AuditCase })
  | { t: 'duty-end'; event: string; why: DutyEndWhy }
  /** Open (or close) a duty link to `peer` for encounter `enc`. */
  | { t: 'duty-peer'; enc: string; peer: string; on: boolean }
  /** From frame `from` on, `by` referees the fight: `'authority'` or the witness's player id. */
  | { t: 'enc-referee'; enc: string; from: number; by: string }
  /** A kill left carrion: every client in the pond drops the same pieces. */
  | {
      t: 'carrion';
      enc: string;
      x: number;
      y: number;
      biomass: number;
      radius: number;
      tick: number;
    };

/** Peer `event` channel: JSON, at most `EVENT_MAX_BYTES`. */
export type PeerEvent =
  /** `slot` may carry a food layer before its cell: `t<1–4>c<x>_<y>_s<slot>`. */
  | { t: 'claim'; slot: string; k: number; tick: number }
  | {
      t: 'consumed';
      part: number;
      of: number;
      entries: [slot: string, k: number, until: number][];
    }
  | { t: 'chat'; text: string }
  /** The sender's genome as base64url text; a receiver checks it against the snapshots' `genomeRef`. */
  | { t: 'genome'; data: string }
  | { t: 'emote'; id: number }
  | { t: 'ping'; kind: number; x: number; y: number }
  /** A fighter's input to its witness referee, signed (`signInput`). */
  | { t: 'finput'; enc: string; f: number; i: number; sig: string }
  /** The witness referee's final frame, signed (`signWitnessFrame`). */
  | { t: 'wframe'; enc: string; f: number; i: (number | null)[]; sig: string }
  /** A round trip on a duty link: `back` is the answer to probe `n`. */
  | { t: 'probe'; n: number; back: boolean }
  /** The first event on every link, each way: the sender's seat ticket. */
  | { t: 'hello'; ticket: SignedSeat }
  /** Gossip: up to `GOSSIP_MAX` of the sender's linked peers, distinct. */
  | { t: 'peers'; list: [id: string, x: number, y: number, r: number][] }
  /** A signal relayed by a peer both sides hold, signed by `from` over its fields (`signalBytes`). */
  | {
      t: 'relay';
      from: string;
      to: string;
      kind: 'offer' | 'answer';
      sdp: string;
      at: number;
      pos: Pos;
      sig: string;
    }
  /** The snapshot rate this side wants from the other. */
  | { t: 'rate'; hz: (typeof SNAPSHOT_RATES)[number] };

/** Peer `state` channel. Energy and health are fractions of their maximum, 0 to 1. */
export interface Snapshot {
  seq: number;
  tick: number;
  x: number;
  y: number;
  heading: number;
  vx: number;
  vy: number;
  biomass: number;
  energy: number;
  health: number;
  alive: boolean;
  dashing: boolean;
  /**
   * The sender says its creature could mate now: mature, rested and with no pending child (M6
   * T19). A hint for finding partners only; the authority checks everything again at `court`.
   */
  ready: boolean;
  /** The sender carries a pending child, drawn as an egg (M6 T20). */
  egg: boolean;
  /** The sender's creature is spawn-protected: it can't be engaged (ADR 0050). */
  spawnProtected: boolean;
  /** The sender's creature is locked in an encounter. */
  fighting: boolean;
  /** The first two bytes of the sender's genome hash, as a u16 (see `genomeRefOf`). */
  genomeRef: number;
}

// Snapshot layout (version 5), little endian, 29 bytes:
//  0 seq u16 | 2 tick u32 | 6 x u32 | 10 y u32 | 14 heading u8 | 15 flags u8 |
// 16 vx i16 | 18 vy i16 | 20 biomass u16 | 22 energy u16 | 24 health u16 | 26 genomeRef u16 |
// 28 version u8 (5)
// Flags: 1 alive, 2 dashing, 4 ready to mate, 8 carrying an egg, 16 spawn-protected, 32 fighting;
// any other bit drops the snapshot.
// Positions are in 0.125 wu steps (0 to 2^29 wu), heading in 2π/256, velocity in 0.25 wu/s;
// energy and health are fractions of the creature's maximum, in 1/65535. Biomass is quantised on a
// log scale: q = round(log2(biomass) · 65535 / 24) covers 1 to 2^24 (a body can reach 2.4 million),
// so the relative error is at most 2^(12/65535) - 1 = 0.013%; smaller values read back as 1.
// Version 1 snapshots are 24 bytes and versions 2 to 4 25 bytes (x and y as u16, 0 to 8192 wu),
// so they fail the length check; version 2 lacked the ready and egg bits, version 3 the protected
// and fighting bits.
const TAU = 2 * Math.PI;
const POS_STEP = 0.125;
const VEL_STEP = 0.25;
/** log2 of the largest biomass a snapshot carries. */
const BIOMASS_LOG2_MAX = 24;
const HEADING_STEPS = 256;
const FLAG_ALIVE = 1;
const FLAG_DASHING = 2;
const FLAG_READY = 4;
const FLAG_EGG = 8;
const FLAG_PROTECTED = 16;
const FLAG_FIGHTING = 32;
const FLAG_MASK =
  FLAG_ALIVE | FLAG_DASHING | FLAG_READY | FLAG_EGG | FLAG_PROTECTED | FLAG_FIGHTING;

function quantize(value: number, step: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  const q = Math.round(value / step);
  return Math.max(min, Math.min(max, q));
}

function encodeBiomass(biomass: number): number {
  if (!Number.isFinite(biomass) || biomass <= 1) return 0;
  return Math.min(0xffff, Math.round((Math.log2(biomass) / BIOMASS_LOG2_MAX) * 0xffff));
}

/** The first two bytes of a hex genome hash: the `genomeRef` that a snapshot carries. */
export function genomeRefOf(hash: string): number {
  const ref = Number.parseInt(hash.slice(0, 4), 16);
  return Number.isNaN(ref) ? 0 : ref;
}

export function encodeSnapshot(s: Snapshot): Uint8Array {
  const out = new Uint8Array(SNAPSHOT_BYTES);
  const v = new DataView(out.buffer);
  v.setUint16(0, s.seq & 0xffff, true);
  v.setUint32(2, s.tick >>> 0, true);
  v.setUint32(6, quantize(s.x, POS_STEP, 0, 0xffffffff), true);
  v.setUint32(10, quantize(s.y, POS_STEP, 0, 0xffffffff), true);
  const turns = Number.isFinite(s.heading) ? s.heading / TAU : 0;
  v.setUint8(14, Math.round((turns - Math.floor(turns)) * HEADING_STEPS) & (HEADING_STEPS - 1));
  v.setUint8(
    15,
    (s.alive ? FLAG_ALIVE : 0) |
      (s.dashing ? FLAG_DASHING : 0) |
      (s.ready ? FLAG_READY : 0) |
      (s.egg ? FLAG_EGG : 0) |
      (s.spawnProtected ? FLAG_PROTECTED : 0) |
      (s.fighting ? FLAG_FIGHTING : 0),
  );
  v.setInt16(16, quantize(s.vx, VEL_STEP, -0x8000, 0x7fff), true);
  v.setInt16(18, quantize(s.vy, VEL_STEP, -0x8000, 0x7fff), true);
  v.setUint16(20, encodeBiomass(s.biomass), true);
  v.setUint16(22, quantize(s.energy, 1 / 0xffff, 0, 0xffff), true);
  v.setUint16(24, quantize(s.health, 1 / 0xffff, 0, 0xffff), true);
  v.setUint16(26, s.genomeRef & 0xffff, true);
  v.setUint8(28, SNAPSHOT_VERSION);
  return out;
}

/** Returns null for anything that is not a well-formed snapshot. Never throws. */
export function decodeSnapshot(b: Uint8Array): Snapshot | null {
  if (!(b instanceof Uint8Array) || b.length !== SNAPSHOT_BYTES) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const flags = v.getUint8(15);
  if ((flags & ~FLAG_MASK) !== 0 || v.getUint8(28) !== SNAPSHOT_VERSION) return null;
  return {
    seq: v.getUint16(0, true),
    tick: v.getUint32(2, true),
    x: v.getUint32(6, true) * POS_STEP,
    y: v.getUint32(10, true) * POS_STEP,
    heading: (v.getUint8(14) * TAU) / HEADING_STEPS,
    vx: v.getInt16(16, true) * VEL_STEP,
    vy: v.getInt16(18, true) * VEL_STEP,
    biomass: 2 ** ((v.getUint16(20, true) * BIOMASS_LOG2_MAX) / 0xffff),
    energy: v.getUint16(22, true) / 0xffff,
    health: v.getUint16(24, true) / 0xffff,
    alive: (flags & FLAG_ALIVE) !== 0,
    dashing: (flags & FLAG_DASHING) !== 0,
    ready: (flags & FLAG_READY) !== 0,
    egg: (flags & FLAG_EGG) !== 0,
    spawnProtected: (flags & FLAG_PROTECTED) !== 0,
    fighting: (flags & FLAG_FIGHTING) !== 0,
    genomeRef: v.getUint16(26, true),
  };
}
