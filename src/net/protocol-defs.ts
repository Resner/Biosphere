import type { GenesisAsk } from '../ledger/ask';
import type { Beacon } from '../ledger/drand';
import type { Commitment } from '../ledger/genesis';
import type { MateAsk } from '../ledger/mate-ask';
import type { RecordRequest, Status, StoredRecord } from '../ledger/record';
import type { DeathCause } from '../sim/types';

/** Wire protocol shared by clients and the Worker. No DOM or Node APIs. */
export const PROTOCOL_VERSION = 7;

/** Hub WebSocket close codes. */
export const CLOSE_REPLACED = 4001;
export const CLOSE_BAD_HELLO = 4002;
export const CLOSE_RATE_LIMITED = 4003;
export const CLOSE_ORIGIN = 4004;

/** Size caps in UTF-8 bytes. A `signal` carries an SDP of up to `SDP_MAX_BYTES`, so it gets more room. */
export const HUB_MAX_BYTES = 4096;
/** A welcome lists up to 23 members plus ICE servers with long TURN credentials (about 4.8 KB at worst). */
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
export const SNAPSHOT_BYTES = 25;
/** The snapshot layout version, the last byte of every snapshot. */
export const SNAPSHOT_VERSION = 4;
/** A state-channel frame for engage candidates: the snapshot, then its 64-byte signature (ADR 0050). */
export const SIGNED_FRAME_BYTES = SNAPSHOT_BYTES + 64;
/** An `enc-start` carries up to 4 fighters with their genome texts; an `enc-end` up to 4 outcomes. */
export const ENC_START_MAX_BYTES = 8192;
export const ENC_END_MAX_BYTES = 4096;
/** An encounter's frames run 0 to 900 (the timeout), so a frame number past this is malformed. */
export const ENC_MAX_FRAME = 1000;
export const ENC_MAX_FIGHTERS = 4;

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

export interface PondInfo {
  id: string;
  seed: string;
  epoch: number;
  centre: Vec2;
  /** The world's side in wu. */
  size: number;
}

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

/** Every cause a death record can name (a `Record`, so a new `DeathCause` fails to compile until it is listed). A client may report all but `old-age` and `eaten` (an egg eaten in a fight), which only the authority decides. */
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

/** A snapshot signed by its sender for lock-in (`src/ledger/snapshot-sig.ts`): base64url of the 25 snapshot bytes and of the 64-byte signature. */
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
}

/** A fighter at an encounter's end: its final state and result. `by` and `eggBy` are slots (0–3). */
export interface FighterOutcome extends Omit<FighterInfo, 'genome' | 'elder' | 'egg'> {
  outcome: 'killed' | 'died' | 'escaped' | 'stood';
  cause: DeathCause | null;
  by: number | null;
  egg: 'none' | 'kept' | 'eaten';
  eggBy: number | null;
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
  /** The answer to `lock-ask`: a freshly signed snapshot of the creature's current state. */
  | { t: 'lock-state'; lock: string; mine: SignedSnap }
  /** This fighter's input for frame `f` of encounter `enc`: a u32 code (`encodeFrameInput`). */
  | { t: 'input'; enc: string; f: number; i: number };

/** Hub WebSocket, hub to client. */
export type HubMsg =
  | { t: 'challenge'; nonce: string }
  | {
      t: 'welcome';
      pond: PondInfo;
      you: { spawnHint: Vec2 };
      members: Member[];
      ice: IceServer[];
      turn: boolean;
      now: number;
    }
  | { t: 'pong'; id: number; now: number }
  | { t: 'member'; op: 'join' | 'leave'; member: Member }
  | { t: 'signal'; from: string; kind: 'offer' | 'answer'; sdp: string }
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
  /** Someone engages this player: answer at once with `lock-state`. */
  | { t: 'lock-ask'; lock: string }
  /** The fight starts: the seed from beacon `round` (0 = none), the pond tick `t0` and the hub time of frame 0, fighters by slot. */
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
  /** The fight is over at frame `f`: the authority's `hashEncounter` and every fighter's result. */
  | { t: 'enc-end'; enc: string; f: number; hash: string; fighters: FighterOutcome[] }
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
  | { t: 'ping'; kind: number; x: number; y: number };

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

// Snapshot layout (version 4), little endian, 25 bytes:
//  0 seq u16 | 2 tick u32 | 6 x u16 | 8 y u16 | 10 heading u8 | 11 flags u8 |
// 12 vx i16 | 14 vy i16 | 16 biomass u16 | 18 energy u16 | 20 health u16 | 22 genomeRef u16 |
// 24 version u8 (4)
// Flags: 1 alive, 2 dashing, 4 ready to mate, 8 carrying an egg, 16 spawn-protected, 32 fighting;
// any other bit drops the snapshot.
// Positions are in 0.125 wu steps (0 to 8192 wu), heading in 2π/256, velocity in 0.25 wu/s;
// energy and health are fractions of the creature's maximum, in 1/65535. Biomass is quantised on a
// log scale: q = round(log2(biomass) · 65535 / 24) covers 1 to 2^24 (a body can reach 2.4 million),
// so the relative error is at most 2^(12/65535) - 1 = 0.013%; smaller values read back as 1.
// Version 1 snapshots are 24 bytes and fail the length check; version 2 lacked the ready and egg
// bits, version 3 the protected and fighting bits.
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
  v.setUint16(6, quantize(s.x, POS_STEP, 0, 0xffff), true);
  v.setUint16(8, quantize(s.y, POS_STEP, 0, 0xffff), true);
  const turns = Number.isFinite(s.heading) ? s.heading / TAU : 0;
  v.setUint8(10, Math.round((turns - Math.floor(turns)) * HEADING_STEPS) & (HEADING_STEPS - 1));
  v.setUint8(
    11,
    (s.alive ? FLAG_ALIVE : 0) |
      (s.dashing ? FLAG_DASHING : 0) |
      (s.ready ? FLAG_READY : 0) |
      (s.egg ? FLAG_EGG : 0) |
      (s.spawnProtected ? FLAG_PROTECTED : 0) |
      (s.fighting ? FLAG_FIGHTING : 0),
  );
  v.setInt16(12, quantize(s.vx, VEL_STEP, -0x8000, 0x7fff), true);
  v.setInt16(14, quantize(s.vy, VEL_STEP, -0x8000, 0x7fff), true);
  v.setUint16(16, encodeBiomass(s.biomass), true);
  v.setUint16(18, quantize(s.energy, 1 / 0xffff, 0, 0xffff), true);
  v.setUint16(20, quantize(s.health, 1 / 0xffff, 0, 0xffff), true);
  v.setUint16(22, s.genomeRef & 0xffff, true);
  v.setUint8(24, SNAPSHOT_VERSION);
  return out;
}

/** Returns null for anything that is not a well-formed snapshot. Never throws. */
export function decodeSnapshot(b: Uint8Array): Snapshot | null {
  if (!(b instanceof Uint8Array) || b.length !== SNAPSHOT_BYTES) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const flags = v.getUint8(11);
  if ((flags & ~FLAG_MASK) !== 0 || v.getUint8(24) !== SNAPSHOT_VERSION) return null;
  return {
    seq: v.getUint16(0, true),
    tick: v.getUint32(2, true),
    x: v.getUint16(6, true) * POS_STEP,
    y: v.getUint16(8, true) * POS_STEP,
    heading: (v.getUint8(10) * TAU) / HEADING_STEPS,
    vx: v.getInt16(12, true) * VEL_STEP,
    vy: v.getInt16(14, true) * VEL_STEP,
    biomass: 2 ** ((v.getUint16(16, true) * BIOMASS_LOG2_MAX) / 0xffff),
    energy: v.getUint16(18, true) / 0xffff,
    health: v.getUint16(20, true) / 0xffff,
    alive: (flags & FLAG_ALIVE) !== 0,
    dashing: (flags & FLAG_DASHING) !== 0,
    ready: (flags & FLAG_READY) !== 0,
    egg: (flags & FLAG_EGG) !== 0,
    spawnProtected: (flags & FLAG_PROTECTED) !== 0,
    fighting: (flags & FLAG_FIGHTING) !== 0,
    genomeRef: v.getUint16(22, true),
  };
}
