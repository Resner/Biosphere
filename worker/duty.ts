// Witness duties on the authority (ADR 0058): once an event's witness round resolves, the order it
// draws decides who is offered each duty. An offer goes to the first unused position whose player
// is still eligible; a decline, 5 s of silence or the player leaving moves it on. Each position
// serves once, and a duty makes at most 3 offers. A fight's referee is offered as soon as the round
// is in, while the fight runs; an auditor once `offerAudit` hands over the case (`attest.ts`). Everything
// here lives in memory: a restart ends every duty, and the fights it rebuilds are the authority's.

import { type Beacon, randomnessOf } from '../src/ledger/drand';
import {
  type DutyKind,
  type DutyRole,
  firstPosition,
  parseDutyEvent,
  type SignedAttestation,
  type WitnessData,
  witnessOrder,
} from '../src/ledger/witness';
import type {
  AuditCase,
  ClientMsg,
  DutyEndWhy,
  DutyHistory,
  HubMsg,
  SignedCommit,
} from '../src/net/protocol';
import { auditEnded, auditorTook } from './attest';
import type { FlagKind } from './audit';
import type { SignedCommitment } from './beacons';
import type { Fight } from './fights';
import { type ActiveSession, type Hub, type Session, seated, sendIfOpen, signedOf } from './socket';
import { handOver } from './witness-fight';
import {
  DUTIES_PER_HOUR,
  dutiesInHour,
  eligible,
  STRIKE_MS,
  struck as struckAmong,
} from './witness-pool';

/** How long an offer waits for `duty-ok` or `duty-no`. */
export const OFFER_MS = 5000;
/** The most offers one duty makes. */
export const MAX_OFFERS = 3;
/** A finished event is forgotten this long after its commitment (an auditor's case comes after its settlement or births). */
const KEEP_MS = 15 * 60_000;

export type OfferOutcome = 'pending' | 'ok' | 'no' | 'silent' | 'failed';

export interface Offer {
  position: number;
  player: string;
  role: DutyRole;
  outcome: OfferOutcome;
}

/** One role of an event: its offers so far, the one pending or taken, and whether it is over. */
interface RoleRun {
  role: DutyRole;
  offers: number;
  /** The next position to try. */
  cursor: number;
  current: Offer | null;
  timer: unknown;
  audit: AuditCase | null;
  over: boolean;
  /** How much of the fight's history the referee duty last offered carried. */
  history: number;
}

interface Duty {
  event: string;
  kind: DutyKind;
  id: string;
  commit: SignedCommitment;
  participants: string[];
  /** The order the round drew, once it resolved. */
  order: string[] | null;
  beacon: Beacon | null;
  used: Set<number>;
  offers: Offer[];
  runs: Map<DutyRole, RoleRun>;
  t: number;
}

/** A duty's history as a referee duty carries it: the fight's frames and joins without `enc`. */
function historyOf(fight: Fight): DutyHistory[] {
  const out: DutyHistory[] = [];
  for (const m of fight.history) {
    if (m.t === 'enc-frame') out.push({ t: 'enc-frame', f: m.f, i: m.i });
    else if (m.t === 'enc-join') out.push({ t: 'enc-join', f: m.f, fighter: m.fighter });
  }
  return out;
}

export class Duties {
  private readonly byEvent = new Map<string, Duty>();
  private readonly byCommit = new Map<string, string>();
  /** Who holds a duty (offered or taken), by player: at most one each. */
  private readonly held = new Map<string, { event: string; role: DutyRole }>();
  /** `duty-ok` and `duty-no` from someone not offered that event, dropped. */
  strays = 0;
  /** A referee took its duty: the fight is handed over (`witness-fight.ts`). */
  onReferee: (event: string, witness: string, position: number) => void = (event, w, p) =>
    handOver(this.hub, event, w, p);
  /** An auditor took its duty: it has a minute to attest (`attest.ts`). */
  onAuditor: (event: string, witness: string, position: number) => void = (event) =>
    auditorTook(this.hub, event);
  /** An event's auditors are spent, with nobody left to offer (`attest.ts` flags `authority-only`). */
  onAuditEnd: (event: string, audit: AuditCase | null, participants: readonly string[]) => void = (
    event,
    audit,
    participants,
  ) => auditEnded(this.hub, event, audit, participants);

  constructor(private readonly hub: Hub) {}

  /** An event's witness commitment was written; its participants never witness it. */
  committed(event: string, commit: SignedCommitment, participants: readonly string[]): void {
    const ev = parseDutyEvent(event);
    if (!ev || this.byEvent.has(event)) return;
    const now = this.hub.clock.now();
    this.forget(now);
    this.byEvent.set(event, {
      event,
      kind: ev.kind,
      id: ev.id,
      commit,
      participants: [...participants],
      order: null,
      beacon: null,
      used: new Set(),
      offers: [],
      runs: new Map(),
      t: now,
    });
    this.byCommit.set(commit.id, event);
  }

  /** A witness commitment's round resolved: its order is drawn, and a running fight's referee offered. */
  resolved(commitId: string): void {
    const event = this.byCommit.get(commitId);
    const duty = event ? this.byEvent.get(event) : undefined;
    if (!duty || duty.order) return;
    const beacon = this.hub.beacons.stored(duty.commit.commitment.round);
    if (!beacon) return;
    const data = duty.commit.commitment.data as unknown as WitnessData;
    duty.beacon = beacon;
    duty.order = witnessOrder(data.pool, randomnessOf(beacon), commitId);
    if (duty.kind === 'enc' && this.fightOf(duty)) this.offer(duty, this.run(duty, 'referee'));
    const auditor = duty.runs.get('auditor');
    if (auditor?.audit && !auditor.current && !auditor.over) this.offer(duty, auditor);
  }

  /** The event is settled: its auditor is offered, now or once its round resolves (`attest.ts`). */
  offerAudit(event: string, audit: AuditCase): void {
    const duty = this.byEvent.get(event);
    if (!duty) return;
    const run = this.run(duty, 'auditor');
    if (run.audit || run.over) return;
    run.audit = audit;
    // A fight's joiners never audit it either.
    if (audit.kind === 'enc') {
      const players = audit.settlement.settlement.results.map((r) => r.player);
      duty.participants = [...new Set([...duty.participants, ...players])];
    }
    if (duty.order) this.offer(duty, run);
  }

  /** The auditor took its duty: without an attestation within `ms`, the next position is offered. */
  awaitAttest(event: string, ms: number): void {
    const duty = this.byEvent.get(event);
    const run = duty?.runs.get('auditor');
    const offer = run?.current;
    if (!duty || !run || offer?.outcome !== 'ok') return;
    this.cancel(run);
    run.timer = this.hub.clock.after(ms, () => {
      run.timer = null;
      if (run.current === offer) this.moveOn(duty, run, 'silent');
    });
  }

  /** The auditor duty `player` has taken (and not yet attested), with what its attestation must name; or null. */
  auditing(player: string): {
    event: string;
    position: number;
    order: string[];
    commitId: string;
    audit: AuditCase;
  } | null {
    const held = this.held.get(player);
    const duty = held?.role === 'auditor' ? this.byEvent.get(held.event) : undefined;
    const run = duty?.runs.get('auditor');
    const offer = run?.current;
    const audit = run?.audit;
    if (!duty?.order || !audit || offer?.player !== player || offer.outcome !== 'ok') return null;
    return {
      event: duty.event,
      position: offer.position,
      order: duty.order,
      commitId: duty.commit.id,
      audit,
    };
  }

  /** A `duty-ok` or `duty-no`: only from the player whose offer is pending, else dropped and counted. */
  answer(
    ws: WebSocket,
    session: ActiveSession,
    msg: ClientMsg & { t: 'duty-ok' | 'duty-no' },
  ): void {
    const duty = this.byEvent.get(msg.event);
    const run = duty
      ? [...duty.runs.values()].find(
          (r) => r.current?.player === session.playerId && r.current.outcome === 'pending',
        )
      : undefined;
    const offer = run?.current;
    if (!duty || !run || !offer) {
      this.strays++;
      return;
    }
    if (msg.t === 'duty-no') {
      this.moveOn(duty, run, 'no');
      return;
    }
    this.cancel(run);
    offer.outcome = 'ok';
    const now = this.hub.clock.now();
    const taken = [...dutiesInHour(session, now), now].slice(-DUTIES_PER_HOUR);
    ws.serializeAttachment({ ...session, duties: taken } satisfies Session);
    if (run.role === 'referee') this.onReferee(duty.event, offer.player, offer.position);
    else this.onAuditor(duty.event, offer.player, offer.position);
  }

  /** Ends a role's duty: its holder hears `duty-end`, a referee's fighters close their links, and nothing more is offered. */
  end(event: string, role: DutyRole, why: DutyEndWhy): void {
    const duty = this.byEvent.get(event);
    const run = duty?.runs.get(role);
    if (!duty || !run) return;
    this.cancel(run);
    const offer = run.current;
    if (offer) {
      this.release(duty, run, offer);
      const found = seated(this.hub, offer.player);
      if (found) sendIfOpen(found[0], { t: 'duty-end', event, why });
    }
    run.over = true;
  }

  /**
   * Strikes a player for `STRIKE_MS`: it enters no pool until then. `kind` is flagged once for
   * `key`, and a duty it holds fails and ends (`duty-end { why: 'struck' }`).
   */
  strike(player: string, kind: FlagKind, key: string): void {
    const now = this.hub.clock.now();
    // Not through `Ledger` (which no M10 task grows), but counted with its rows all the same.
    const cursor = this.hub.sql.exec(
      `INSERT INTO players (id, first_seen, last_seen, struck_until) VALUES (?1, ?2, ?2, ?3)
       ON CONFLICT (id) DO UPDATE SET struck_until = ?3`,
      player,
      now,
      now + STRIKE_MS,
    );
    this.hub.ledger.rowsWritten += cursor.rowsWritten;
    this.hub.ledger.audit.raise(kind, { owner: player, creature: '', key, t: now });
    const held = this.held.get(player);
    const offer = held ? this.byEvent.get(held.event)?.runs.get(held.role)?.current : null;
    if (!held || !offer) return;
    offer.outcome = 'failed';
    this.end(held.event, held.role, 'struck');
  }

  /**
   * A role may be offered again (a fight's witness failed or was taken back, an auditor was
   * struck): to the next unused position, within the duty's 3 offers.
   */
  reoffer(event: string, role: DutyRole = 'referee'): void {
    const duty = this.byEvent.get(event);
    const run = duty?.runs.get(role);
    if (!duty || !run || run.current) return;
    run.over = false;
    this.offer(duty, run);
  }

  /** How many messages of the fight's history the event's last referee offer carried (0 when none). */
  offeredHistory(event: string): number {
    return this.byEvent.get(event)?.runs.get('referee')?.history ?? 0;
  }

  /** The duty the player holds (offered or taken), or null. */
  holding(player: string): { event: string; role: DutyRole } | null {
    return this.held.get(player) ?? null;
  }

  /** Whom the player may signal outside its pond: a referee's fighters, or a fighter's referee, offered or taken. */
  linksOf(player: string): string[] {
    const out = new Set<string>();
    for (const duty of this.byEvent.values()) {
      const offer = duty.runs.get('referee')?.current;
      const fight = offer ? this.fightOf(duty) : null;
      if (!offer || !fight) continue;
      if (offer.player === player) for (const p of fight.players) out.add(p);
      else if (fight.players.includes(player)) out.add(offer.player);
    }
    out.delete(player);
    return [...out];
  }

  /** The player's socket closed: an offer it had not answered moves on. */
  left(player: string): void {
    const held = this.held.get(player);
    const duty = held ? this.byEvent.get(held.event) : undefined;
    const run = held ? duty?.runs.get(held.role) : undefined;
    if (duty && run?.current?.outcome === 'pending') this.moveOn(duty, run, 'silent');
  }

  /** The event's commitment, order and offers so far (the E2E hook), or null when none is held. */
  view(event: string): { order: string[] | null; offers: Offer[] } | null {
    const duty = this.byEvent.get(event);
    return duty ? { order: duty.order, offers: duty.offers.map((o) => ({ ...o })) } : null;
  }

  /** Forgets every duty and its timers, as a restart does. */
  clear(): void {
    for (const duty of this.byEvent.values())
      for (const run of duty.runs.values()) this.cancel(run);
    this.byEvent.clear();
    this.byCommit.clear();
    this.held.clear();
  }

  private run(duty: Duty, role: DutyRole): RoleRun {
    let run = duty.runs.get(role);
    if (!run) {
      run = {
        role,
        offers: 0,
        cursor: firstPosition(duty.kind, role) ?? Number.POSITIVE_INFINITY,
        current: null,
        timer: null,
        audit: null,
        over: firstPosition(duty.kind, role) === null,
        history: 0,
      };
      duty.runs.set(role, run);
    }
    return run;
  }

  /** The running fight of an encounter's duty, or null. */
  private fightOf(duty: Duty): Fight | null {
    if (duty.kind !== 'enc') return null;
    for (const lock of this.hub.fights.running()) {
      if (lock.fight?.enc.id === duty.id && !lock.fight.enc.over) return lock.fight;
    }
    return null;
  }

  /** Whether position `p` is another role's first: it waits for that role. */
  private reserved(duty: Duty, run: RoleRun, p: number): boolean {
    const other: DutyRole = run.role === 'referee' ? 'auditor' : 'referee';
    return firstPosition(duty.kind, other) === p;
  }

  /** Offers the role to the first unused position whose player is still eligible; ends it when none is left. */
  private offer(duty: Duty, run: RoleRun): void {
    const order = duty.order;
    if (!order || run.over || (run.role === 'auditor' && !run.audit)) return;
    const fight = run.role === 'referee' ? this.fightOf(duty) : null;
    if ((run.role === 'referee' && !fight) || run.offers >= MAX_OFFERS) {
      this.spent(duty, run);
      return;
    }
    const now = this.hub.clock.now();
    const exclude = [...new Set([...duty.participants, ...(fight?.players ?? [])])];
    const open: number[] = [];
    for (let p = run.cursor; p < order.length; p++) {
      if (!duty.used.has(p) && !this.reserved(duty, run, p)) open.push(p);
    }
    // One eligibility pass for every position left (it reads every session), not one per position.
    const among = open.map((p) => order[p] as string);
    const ok = new Set(among.length > 0 ? eligible(this.hub, exclude, now, among) : []);
    for (const p of open) {
      const player = order[p] as string;
      if (!ok.has(player)) continue;
      const found = seated(this.hub, player);
      const msg = found ? this.dutyMsg(duty, run, p, fight) : null;
      if (!found || !msg) continue;
      run.cursor = p + 1;
      run.offers++;
      duty.used.add(p);
      const offer: Offer = { position: p, player, role: run.role, outcome: 'pending' };
      duty.offers.push(offer);
      run.current = offer;
      if (fight) run.history = fight.history.length;
      this.held.set(player, { event: duty.event, role: run.role });
      sendIfOpen(found[0], msg);
      if (fight) this.tellFighters(fight, duty.id, player, true);
      run.timer = this.hub.clock.after(OFFER_MS, () => {
        run.timer = null;
        if (run.current === offer && offer.outcome === 'pending') this.moveOn(duty, run, 'silent');
      });
      return;
    }
    run.cursor = order.length;
    this.spent(duty, run);
  }

  /** Nobody is left to offer the role: it is over, and an auditor's end may leave the event authority-only. */
  private spent(duty: Duty, run: RoleRun): void {
    run.over = true;
    if (run.role === 'auditor') this.onAuditEnd(duty.event, run.audit, duty.participants);
  }

  private dutyMsg(duty: Duty, run: RoleRun, position: number, fight: Fight | null): HubMsg | null {
    const beacon = duty.beacon;
    if (!beacon) return null;
    const base = {
      t: 'duty' as const,
      event: duty.event,
      position,
      commit: signedOf(duty.commit),
      beacon,
    };
    if (run.role === 'auditor')
      return run.audit ? { ...base, role: 'auditor', audit: run.audit } : null;
    if (!fight) return null;
    return {
      ...base,
      role: 'referee',
      pondSeed: fight.pondSeed,
      fighters: [...fight.players],
      start: fight.start,
      history: historyOf(fight),
    };
  }

  /** The pending offer is over (`outcome`): its links close, a silent player is told, and the next position is offered. */
  private moveOn(duty: Duty, run: RoleRun, outcome: OfferOutcome): void {
    const offer = run.current;
    if (!offer) return;
    this.cancel(run);
    offer.outcome = outcome;
    this.release(duty, run, offer);
    if (outcome === 'silent') {
      const found = seated(this.hub, offer.player);
      if (found) sendIfOpen(found[0], { t: 'duty-end', event: duty.event, why: 'replaced' });
    }
    this.offer(duty, run);
  }

  /** The offer's player holds the duty no more, and a referee's fighters close their links to it. */
  private release(duty: Duty, run: RoleRun, offer: Offer): void {
    if (this.held.get(offer.player)?.event === duty.event) this.held.delete(offer.player);
    run.current = null;
    const fight = run.role === 'referee' ? this.fightOf(duty) : null;
    if (fight) this.tellFighters(fight, duty.id, offer.player, false);
  }

  private tellFighters(fight: Fight, enc: string, witness: string, on: boolean): void {
    for (const p of fight.players) {
      const found = seated(this.hub, p);
      if (found) sendIfOpen(found[0], { t: 'duty-peer', enc, peer: witness, on });
    }
  }

  private cancel(run: RoleRun): void {
    if (run.timer !== null) this.hub.clock.cancel(run.timer);
    run.timer = null;
  }

  /** Drops the events committed `KEEP_MS` before `now` whose duties nobody holds. */
  private forget(now: number): void {
    for (const [event, duty] of this.byEvent) {
      if (duty.t > now - KEEP_MS) continue;
      if ([...duty.runs.values()].some((r) => r.current !== null)) continue;
      this.byEvent.delete(event);
      this.byCommit.delete(duty.commit.id);
    }
  }
}

/** An event's witnesses as `GET /v1/e2e/witness/<event>` serves them (the E2E entry only). */
export interface WitnessView {
  commit: SignedCommit;
  /** The order its round drew, null until the round is published. */
  order: string[] | null;
  offers: Offer[];
  /** The order's players struck now. */
  struck: string[];
  attestations: SignedAttestation[];
}

/** The event's witness commitment, order, offers, strikes and attestations; null without a commitment. Reads only. */
export function witnessView(hub: Hub, event: string): WitnessView | null {
  const commit = hub.beacons.find('witness', '', { event });
  if (!commit) return null;
  const held = hub.duties.view(event);
  let order = held?.order ?? null;
  const beacon = order ? null : hub.beacons.stored(commit.commitment.round);
  if (beacon) {
    const data = commit.commitment.data as unknown as WitnessData;
    order = witnessOrder(data.pool, randomnessOf(beacon), commit.id);
  }
  const sql = hub.sql;
  const struck = order ? [...struckAmong(hub, order, hub.clock.now())].sort() : [];
  const attestations = sql
    .exec<{ json: string }>(
      'SELECT json FROM attestations WHERE event = ? ORDER BY position',
      event,
    )
    .toArray()
    .map((r) => JSON.parse(r.json) as SignedAttestation);
  return { commit: signedOf(commit), order, offers: held?.offers ?? [], struck, attestations };
}
