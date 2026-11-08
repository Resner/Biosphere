import { bytesToHex } from '@noble/hashes/utils.js';
import { beforeEach } from 'vitest';
import { randomnessOf } from '../src/ledger/drand';
import type { Identity } from '../src/ledger/identity';
import {
  signAttestation,
  signInput,
  signWitnessFrame,
  type WitnessData,
  witnessOrder,
} from '../src/ledger/witness';
import { auditVerdict } from '../src/net/audit';
import { AUTHORITY } from '../src/net/handover';
import type { DutyEndWhy, HubMsg, SignedCommit, WorldInfo } from '../src/net/protocol';
import {
  type BatchMsg,
  type RefereeDuty,
  type WitnessFrame,
  WitnessReferee,
  type WitnessVerdict,
} from '../src/net/witness-referee';
import type { SignedCommitment } from './beacons';
import { authority, clock, within } from './fight-test-kit';
import { keep, type Session } from './socket';
import { beaconOf, type Client, flush, nextOf, signIn, sql } from './test-hub';
import { eligible, WITNESS_PLAY_MS } from './witness-pool';

// Shared by the witness hub tests (M10 T4, T5): sessions that can witness (play, `avail`, their
// own IP), the pool the object would draw now, the order a commitment's round draws, and a
// scripted witness referee (`ScriptedWitness`) that answers its duty, signs and batches on the
// hand clock, and goes silent or forges on cue. Use it with `useFightHub()` (the hand clock);
// `useWitnessHub()` adds a clean slate of duties.

export interface Witness {
  c: Client;
  id: Identity;
  pond: WorldInfo;
  ip: string;
}

/** Each test starts with no duty in memory (the object outlives a test). Call after `useFightHub()`. */
export function useWitnessHub(): void {
  beforeEach(() => authority((a) => a.duties.clear()));
}

let ips = 0;
/** A fresh address for a session's `CF-Connecting-IP`. */
export const nextIp = () => `10.4.${(++ips >> 8) & 255}.${ips & 255}`;

/**
 * Credits `ms` of play to the player: a finished creature of its own that lived that long. Its row
 * is written directly, so a seated player's witness candidacy reads its play again (`seats.ts`).
 */
export async function credit(player: string, ms: number): Promise<void> {
  await sql(
    `INSERT INTO creatures (id, owner, status, seq, hash, genome, active_ms, biomass, energy, health, born_t, died_t)
     VALUES (?, ?, 'dead', 0, '', '', ?, 0, 0, 0, 0, 0)`,
    bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    player,
    ms,
  );
  await authority((a) => a.seats.reload(player));
}

/** Sends `avail` and waits until the object has taken it. */
export async function setAvail(c: Client, on: boolean): Promise<HubMsg[]> {
  c.send({ t: 'avail', on });
  return flush(c);
}

/**
 * A seated session that may witness: `playMs` of play (20 minutes by default), `avail` on unless
 * told otherwise, and its own IP unless one is given.
 */
export async function witness(
  opts: { playMs?: number; avail?: boolean; ip?: string } = {},
): Promise<Witness> {
  const ip = opts.ip ?? nextIp();
  const { c, id } = await signIn(undefined, undefined, ip);
  const { world: pond } = await nextOf(c, 'welcome');
  await nextOf(c, 'life');
  await credit(id.playerId, opts.playMs ?? WITNESS_PLAY_MS);
  if (opts.avail ?? true) await setAvail(c, true);
  return { c, id, pond, ip };
}

/** `n` witnesses. */
export async function witnesses(n: number): Promise<Witness[]> {
  const out: Witness[] = [];
  for (let i = 0; i < n; i++) out.push(await witness());
  return out;
}

/** Who the object would pool now for an event whose participants are `exclude`. */
export const poolNow = (exclude: readonly { id: Identity }[] = []) =>
  authority((a) =>
    eligible(
      a,
      exclude.map((p) => p.id.playerId),
      clock.now(),
    ),
  );

/** Edits a session's attachment on the object. */
export const editWitness = (
  w: { id: Identity },
  edit: (s: Session & { phase: 'active' }) => Session,
) =>
  authority((a) => {
    for (const ws of a.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.phase === 'active' && s.playerId === w.id.playerId) keep(a, ws, edit(s));
    }
  });

/** The event's witness commitment on the object, or null. */
export const witnessCommit = (event: string) =>
  authority((a): SignedCommitment | null => a.beacons.find('witness', '', { event }));

/** The order a witness commitment's round draws, from the recorded beacon. */
export function orderOf(commit: SignedCommit | SignedCommitment, id: string): string[] {
  const data = commit.commitment.data as unknown as WitnessData;
  return witnessOrder(data.pool, randomnessOf(beaconOf(commit.commitment.round)), id);
}

/** The witness whose player is `player`, of `ws`. */
export function byPlayer(ws: readonly Witness[], player: string | undefined): Witness {
  const found = ws.find((w) => w.id.playerId === player);
  if (!found) throw new Error(`no witness ${player}`);
  return found;
}

type EncReferee = Extract<HubMsg, { t: 'enc-referee' }>;

/**
 * A witness referee driven by a test: the pure `WitnessReferee` on the hand clock behind a real
 * socket. It hears the hub's frames before its span, a take-back and `duty-end` on its socket,
 * takes each fighter's signed input directly (the peer link is the test's), and sends its batches
 * to the hub, unless told to stay `silent` or to `tamper` with them.
 */
export class ScriptedWitness {
  referee: WitnessReferee | null = null;
  /** No batch goes out. */
  silent = false;
  /** Changes each batch before it goes (null: it is not sent). */
  tamper: ((b: BatchMsg) => BatchMsg | null) | null = null;
  /** The batches sent, and the signed frames sent to the fighters. */
  readonly sent: BatchMsg[] = [];
  readonly frames: WitnessFrame[] = [];
  /** The take-back the hub announced, and the duty's end. */
  stoppedAt: number | null = null;
  ended: DutyEndWhy | null = null;

  constructor(
    readonly w: Witness,
    readonly duty: RefereeDuty,
  ) {}

  get enc(): string {
    return this.duty.start.enc;
  }

  get player(): string {
    return this.w.id.playerId;
  }

  /** The first frame it referees, once handed over. */
  get from(): number {
    return this.referee?.from ?? Number.POSITIVE_INFINITY;
  }

  /** Answers `duty-ok` and waits for its handover (`enc-referee` naming it). */
  async accept(): Promise<EncReferee> {
    this.w.c.send({ t: 'duty-ok', event: this.duty.event });
    const msg = await within(nextOf(this.w.c, 'enc-referee'), 'the handover');
    this.referee = new WitnessReferee({
      duty: this.duty,
      from: msg.from,
      now: () => clock.t,
      signFrame: (f, i) => signWitnessFrame(this.w.id, this.enc, f, i),
      sendFrame: (ev) => this.frames.push(ev),
      sendBatch: (b) => this.batch(b),
    });
    return msg;
  }

  private batch(b: BatchMsg): void {
    if (this.silent) return;
    const out = this.tamper ? this.tamper(b) : b;
    if (!out) return;
    this.sent.push(out);
    this.w.c.send(out);
  }

  /** What the hub sent it so far: its frames before the span, a take-back, the duty's end. */
  hear(): void {
    for (const m of this.w.c.inbox.splice(0)) this.take(m);
  }

  private take(m: HubMsg): void {
    const r = this.referee;
    if (m.t === 'enc-frame' && m.enc === this.enc) r?.hubFrame(m);
    else if (m.t === 'enc-referee' && m.enc === this.enc && m.by === AUTHORITY) {
      this.stoppedAt = m.from;
      r?.stopAt(m.from);
    } else if (m.t === 'duty-end' && m.event === this.duty.event) {
      this.ended = m.why;
      r?.stop();
    }
  }

  /** Waits until `done` holds, taking what the hub sends meanwhile. */
  async until(done: () => boolean, what: string): Promise<void> {
    this.hear();
    while (!done()) this.take(await within(this.w.c.next(), what));
  }

  /** Waits until the hub's frames before its span are in. */
  async catchUp(): Promise<void> {
    const r = this.referee;
    if (!r) return;
    this.hear();
    while (r.encounter.frame < r.from && !r.done) {
      this.take(await within(this.w.c.next(), `the hub's frames before ${r.from}`));
    }
  }

  /** Finalizes every frame due by now (and batches them). */
  tick(): void {
    this.hear();
    this.referee?.tick();
  }

  /** Fighter `p`'s input for frame `f`, signed as it would be on the peer link. */
  input(p: { id: Identity }, f: number, code: number): WitnessVerdict {
    const r = this.referee;
    if (!r) throw new Error('no handover yet');
    this.hear();
    const sig = signInput(p.id, this.enc, f, code);
    return r.input(p.id.playerId, { t: 'finput', enc: this.enc, f, i: code, sig });
  }
}

/** The referee duty the witness was offered. */
export async function refereeDuty(w: Witness): Promise<ScriptedWitness> {
  const duty = await within(nextOf(w.c, 'duty'), 'a referee duty');
  if (duty.role !== 'referee') throw new Error('not a referee duty');
  return new ScriptedWitness(w, duty);
}

/** Polls until `read` gives a value (a few ms apart, bounded). */
export async function waitFor<T>(read: () => Promise<T | null>, what: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await read();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`never got ${what}`);
}

/**
 * The auditor takes its offered duty and attests as the authority's own verdict says (an honest
 * auditor): its `duty-ok`, then its signed `attest`, then the wait for `duty-end`. `commitId` is the
 * event's witness commitment; `keys` are the fighters' keys a fight's audit needs.
 */
export async function attestAuditor(
  auditor: Witness,
  event: string,
  commitId: string,
  keys: { id: string; publicKey: string }[] = [],
) {
  const duty = await within(nextOf(auditor.c, 'duty'), 'the auditor duty');
  if (duty.role !== 'auditor') throw new Error('not an auditor duty');
  auditor.c.send({ t: 'duty-ok', event });
  const v = auditVerdict(duty.audit, duty.beacon, keys);
  auditor.c.send({
    t: 'attest',
    signed: signAttestation(auditor.id, {
      v: 1,
      kind: 'attest',
      event,
      duty: commitId,
      position: duty.position,
      witness: auditor.id.playerId,
      subject: v.subject,
      agree: v.agree,
    }),
  });
  return (await within(nextOf(auditor.c, 'duty-end'), 'duty-end')).why;
}
