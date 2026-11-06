import type { SignedCommit } from '../net/protocol-defs';
import { type Beacon, randomnessOf, roundTime, verifyBeacon, verifyBeacons } from './drand';
import { commitmentId } from './genesis';
import type { KeyVerify } from './key-verify';
import type { AuthorityKey } from './proof';
import type { StoredRecord } from './record';
import { type RefereeSpan, refereeSpanProblems, refereesOf, settlementHash } from './settlement';
import type { BundleIndex, Problem, VerifyOptions, WitnessEvent, Witnessed } from './verify';
import { countersigned, firstNamers, keyProblem, whereNamed } from './verify-chain';
import {
  attestationSigned,
  birthSubject,
  type DutyKind,
  dutyEvent,
  type SignedAttestation,
  witnessDataProblems,
  witnessOrder,
} from './witness';

// The witness family of `verifyLineage` (ADR 0058). Every held event (each settlement, each held
// genesis, each mating a held record names) is checked against its witness commitment when the
// bundle holds it: the countersignature, the pool, the round (not yet published when committed,
// and a mating's or a genesis's own), its beacon, and the order that beacon draws. Each referee
// span's witness and each attestation's must sit at their positions in that order, each position
// serving once, and each attestation must be signed by its witness over the event's own subject.
// A disagreeing attestation is overruled, not a problem; a commitment not held leaves the
// selection unchecked; an event no witness refereed and none agreed with is authority-only.

const problem = (creature: string, seq: number | null, code: string): Problem => ({
  creature,
  seq,
  family: 'witness',
  code,
});

const AUTHORITY = 'authority';

/** One held event, as the records and documents of the bundle give it. */
interface Held {
  event: string;
  kind: DutyKind;
  /** Held creatures with a part in it. */
  creatures: Set<string>;
  /** Where its problems go. */
  where: [string, number | null];
  /** What an attestation of it must name, or null when the bundle cannot tell (a mating with a birth not held). */
  subject: string | null;
  /** A mating's or a genesis's own round, which its witness commitment must name. */
  round: number | null;
  /** A fight's referee spans and problems, from its first settlement. */
  spans: RefereeSpan[];
  spanProblems: string[];
  /** A version 2 settlement's `duty`; undefined for every other event. */
  duty?: string;
}

const eventOf = (kind: DutyKind, id: unknown): string | null => {
  try {
    return typeof id === 'string' ? dutyEvent(kind, id) : null;
  } catch {
    return null;
  }
};

/** Every fight, genesis and mating the bundle holds, by event. */
function heldEvents(index: BundleIndex): Map<string, Held> {
  const out = new Map<string, Held>();
  const naming = firstNamers(index);
  for (const [enc, [first]] of index.settlements) {
    const event = eventOf('enc', enc);
    if (!event || !first) continue;
    const s = first.settlement;
    let subject: string | null = null;
    try {
      subject = settlementHash(s);
    } catch {
      // A settlement that does not hash is the signature family's to name.
    }
    out.set(event, {
      event,
      kind: 'enc',
      creatures: new Set(s.results.map((r) => r.creature).filter((c) => index.creatures.has(c))),
      where: whereNamed(index, naming.enc.get(enc)),
      subject,
      round: null,
      spans: refereesOf(s),
      spanProblems: refereeSpanProblems(s),
      ...(s.v === 2 ? { duty: s.duty } : {}),
    });
  }
  const births = new Map<string, StoredRecord[]>();
  for (const [id, chain] of index.records) {
    for (const s of chain) {
      const { kind, body } = s.record;
      if (kind === 'genesis' && s.record.seq === 0) {
        const event = eventOf('genesis', body.commit);
        if (!event) continue;
        out.set(event, {
          event,
          kind: 'genesis',
          creatures: new Set([id]),
          where: [id, 0],
          subject: s.hash,
          round: typeof body.round === 'number' ? body.round : null,
          spans: [],
          spanProblems: [],
        });
      } else if (kind === 'mate-commit' || kind === 'birth') {
        const event = eventOf('mating', body.commit);
        if (!event) continue;
        const held = out.get(event) ?? {
          event,
          kind: 'mating' as const,
          creatures: new Set<string>(),
          where: whereNamed(index, naming.commit.get(body.commit as string)),
          subject: null,
          round: typeof body.round === 'number' ? body.round : null,
          spans: [],
          spanProblems: [],
        };
        held.creatures.add(id);
        out.set(event, held);
        if (kind === 'birth') births.set(event, [...(births.get(event) ?? []), s]);
      }
    }
  }
  // A mating's subject is both births' hashes in slot order: the bundle must hold both.
  for (const [event, pair] of births) {
    const slot = (n: number) => pair.find((s) => s.record.body.slot === n)?.hash;
    const [a, b] = [slot(0), slot(1)];
    const held = out.get(event);
    if (held && a && b && pair.length === 2) held.subject = birthSubject(a, b);
  }
  return out;
}

/** The event a witness commitment's data names, or null. */
const eventNamed = (c: SignedCommit): string | null => {
  const event = (c.commitment.data as { event?: unknown } | null)?.event;
  return typeof event === 'string' ? event : null;
};

export interface WitnessReport {
  problems: Problem[];
  witnessed: Witnessed;
  events: WitnessEvent[];
}

/** The witness family: its problems, and what witnesses saw of each held event. Never throws. */
export function verifyWitness(index: BundleIndex, _opts: VerifyOptions): WitnessReport {
  const out: Problem[] = [];
  const commits = new Map<string, SignedCommit>();
  const byEvent = new Map<string, string[]>();
  for (const c of index.bundle.witnessCommits) {
    let id: string;
    try {
      id = commitmentId(c.commitment);
    } catch {
      continue; // A commitment that does not hash names nothing.
    }
    if (commits.has(id)) continue;
    commits.set(id, c);
    const event = eventNamed(c);
    if (event) byEvent.set(event, [...(byEvent.get(event) ?? []), id]);
  }
  const attestations = new Map<string, SignedAttestation[]>();
  for (const a of index.bundle.attestations) {
    const event = a.attestation.event;
    attestations.set(event, [...(attestations.get(event) ?? []), a]);
  }
  const held = heldEvents(index);
  const beaconOk = beaconsOf(index, held, commits, byEvent);
  const verifiers = new Map<string, KeyVerify | null>();
  /** A held commitment's problems, and the order its beacon draws when everything it rests on holds. */
  const commitmentProblems = (
    h: Held,
    id: string,
    signed: SignedCommit,
    at: (code: string) => void,
  ): string[] | null => {
    const c = signed.commitment;
    const key = keyProblem(index, signed.keyId, c.t, 'witness-commit-');
    const authority = index.keys.get(signed.keyId) as AuthorityKey;
    if (key) at(key);
    else if (!countersigned(verifiers, authority, id, signed.authSig)) at('witness-commit-sig');
    const data = witnessDataProblems(c.data);
    for (const code of data) at(`witness-data:${code}`);
    if (eventNamed(signed) !== h.event) at('witness-event');
    if (roundTime(c.round) <= c.t) at('witness-round-not-future');
    if (h.round !== null && c.round !== h.round) at('witness-round');
    const beacon = index.beacons.get(c.round);
    if (!beacon) at('witness-beacon-missing');
    else if (!beaconOk(beacon)) at('witness-bad-beacon');
    else if (data.length === 0) {
      const { pool } = c.data as unknown as { pool: string[] };
      return witnessOrder(pool, randomnessOf(beacon), id);
    }
    return null;
  };
  const events: WitnessEvent[] = [];
  for (const h of held.values()) {
    const at = (code: string) => out.push(problem(h.where[0], h.where[1], code));
    for (const code of h.spanProblems) at(code);
    const signedBy: SignedAttestation[] = [];
    for (const s of attestations.get(h.event) ?? []) {
      if (attestationSigned(s)) signedBy.push(s);
      else at('attest-sig');
    }
    // The commitment: the one a settlement names, else the one for the event, else the one its
    // attestations name (not held: pruned, or not served).
    const forEvent = byEvent.get(h.event) ?? [];
    const dutyId: string | null = h.duty ?? forEvent[0] ?? signedBy[0]?.attestation.duty ?? null;
    if (h.duty === '' ? forEvent.length > 0 : forEvent.some((id) => id !== dutyId))
      at(h.duty === undefined ? 'witness-commit-duplicate' : 'witness-duty');
    const signed = dutyId ? commits.get(dutyId) : undefined;
    const order = signed ? commitmentProblems(h, dutyId as string, signed, at) : null;
    const selection: WitnessEvent['selection'] = signed
      ? order
        ? 'checked'
        : 'unchecked'
      : dutyId
        ? 'unchecked'
        : 'none';
    // Each position serves once: a witness's spans count once, every signed attestation once.
    const uses = new Map<number, number>();
    const use = (position: number) => uses.set(position, (uses.get(position) ?? 0) + 1);
    const seen = new Set<string>();
    let refereed = false;
    for (const span of h.spans) {
      if (span.by === AUTHORITY) continue;
      refereed = true;
      const key = `${span.by}|${span.position}`;
      if (span.position === undefined || seen.has(key)) continue;
      seen.add(key);
      use(span.position);
      if (selection === 'none') at('referee-unselected');
      else if (order && order[span.position] !== span.by) at('referee-position');
    }
    // An attestation counts when it names this duty, sits at its witness's position and names
    // the event's subject, each as far as the bundle can tell.
    let audited = false;
    let overruled = false;
    for (const { attestation: a } of signedBy) {
      use(a.position);
      const codes: string[] = [];
      if (a.duty !== dutyId) codes.push('attest-duty');
      if (order && order[a.position] !== a.witness) codes.push('attest-position');
      if (h.subject !== null && a.subject !== h.subject) codes.push('attest-subject');
      for (const code of codes) at(code);
      if (codes.length > 0) continue;
      if (a.agree) audited = true;
      else overruled = true;
    }
    if ([...uses.values()].some((n) => n > 1)) at('position-twice');
    events.push({
      event: h.event,
      creatures: [...h.creatures],
      refereed,
      audited,
      overruled,
      authorityOnly: !refereed && !audited,
      selection,
    });
  }
  const count = (f: (e: WitnessEvent) => boolean) => events.filter(f).length;
  return {
    problems: out,
    witnessed: {
      events: events.length,
      refereed: count((e) => e.refereed),
      audited: count((e) => e.audited),
      authorityOnly: count((e) => e.authorityOnly),
      overruled: count((e) => e.overruled),
      unchecked: count((e) => e.selection === 'unchecked'),
    },
    events,
  };
}

/**
 * Whether a beacon verifies, every round a held event's witness commitment names checked in one
 * batch (`verifyBeacons`): a bundle of 64 fights holds 64 rounds.
 */
function beaconsOf(
  index: BundleIndex,
  held: ReadonlyMap<string, Held>,
  commits: ReadonlyMap<string, SignedCommit>,
  byEvent: ReadonlyMap<string, readonly string[]>,
): (b: Beacon) => boolean {
  const named = new Map<number, Beacon>();
  for (const h of held.values()) {
    for (const id of [h.duty, ...(byEvent.get(h.event) ?? [])]) {
      const round = id ? commits.get(id)?.commitment.round : undefined;
      const beacon = round === undefined ? undefined : index.beacons.get(round);
      if (beacon) named.set(beacon.round, beacon);
    }
  }
  const list = [...named.values()];
  const ok = new Map(verifyBeacons(list).map((v, i) => [list[i] as Beacon, v]));
  return (b) => ok.get(b) ?? verifyBeacon(b);
}
