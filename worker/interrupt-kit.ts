// Interrupted transactions (M14 T3, ADR 0076): the catalogue of every multi-step transaction as the
// hub sees it, and `consistent`, the invariants that hold after any of them is cut short by a
// closed socket, a long absence or a rebuilt object. `worker/interrupt.test.ts` walks the
// catalogue; the E2E entry's consistency hook (M14 T13) answers `consistent(hub)`.
import type { SignedSettlement } from '../src/ledger/settlement';
import { verifyLineage } from '../src/ledger/verify';
import { proofBundle } from './proof';
import { activeSessions, type Hub } from './socket';

/** The multi-step transactions; a new one joins the catalogue (`.claude/rules/worker.md`). */
export type TransactionName =
  | 'genesis'
  | 'mating'
  | 'promote'
  | 'restore'
  | 'death'
  | 'fight'
  | 'close';

/**
 * A step as the hub sees it. `atomic` names a step that can't be interrupted on its own, because
 * it runs in the same handler and SQLite transaction as the step before it, and says why.
 */
export interface Step {
  step: string;
  what: string;
  atomic?: string;
}

/** Each transaction's steps in order. The matrix interrupts after each step that isn't `atomic`. */
export const CATALOGUE: Readonly<Record<TransactionName, readonly Step[]>> = {
  genesis: [
    { step: 'ask', what: 'the signed ask arrives' },
    {
      step: 'commit',
      what: 'the commitment and its hatch written (one transaction), `commit` sent',
    },
    {
      step: 'round',
      what: 'the round published: the commitment resolved and the genesis record written (one transaction)',
    },
    { step: 'genesis', what: '`genesis` sent' },
  ],
  mating: [
    { step: 'mate-check', what: '`mate-check` answered: nothing written' },
    { step: 'court', what: 'the invitation kept in the courting socket, `invite` sent' },
    {
      step: 'accept',
      what: 'the commitment and both `mate-commit` records (one transaction), `mating` sent to both',
    },
    {
      step: 'round',
      what: 'the round published: the commitment resolved and both births written (one transaction)',
    },
    { step: 'born', what: '`born` sent to each' },
  ],
  promote: [
    { step: 'request', what: 'the signed request arrives' },
    {
      step: 'records',
      what: 'the parent frozen and the child active',
      atomic: 'one handler and one transaction with the request',
    },
    { step: 'promoted', what: '`promoted` sent' },
  ],
  restore: [
    { step: 'request', what: 'the signed request arrives' },
    {
      step: 'records',
      what: 'the ancestor active again',
      atomic: 'one handler and one transaction with the request',
    },
    { step: 'restored', what: '`restored` sent' },
  ],
  death: [
    { step: 'death', what: "the client's `death` arrives (or the hub's old age)" },
    {
      step: 'record',
      what: 'the last checkpoint and the `death` record',
      atomic: 'one handler and one transaction with the report',
    },
    { step: 'died', what: '`died` sent with the fallback' },
  ],
  fight: [
    { step: 'engage', what: 'the attacker engages: both locked' },
    { step: 'lock-ask', what: '`lock-ask` sent to the target' },
    { step: 'answer', what: "the target's `lock-state` arrives" },
    {
      step: 'start',
      what: 'the row inserted, then `enc-start` sent',
      atomic: 'one handler with the answer (or the window closing)',
    },
    { step: 'batch', what: 'a batch of frames written' },
    { step: 'settle', what: 'the records, the document and the closed row (one transaction)' },
    { step: 'enc-end', what: '`enc-end` sent' },
  ],
  close: [
    { step: 'checkpoint', what: 'the checkpoint and the place out of the water (one transaction)' },
    { step: 'seat-back', what: 'the seat held back for 2 minutes' },
  ],
};

/** One broken invariant: its kind, whom it concerns and what was found. */
export interface Inconsistency {
  kind: string;
  player?: string;
  creature?: string;
  detail: string;
}

type Row = Record<string, SqlStorageValue>;

/**
 * The invariants every interruption must leave (ADR 0076); `[]` when every one holds:
 * - each player has at most one active and one pending creature, and each creature one head (the
 *   last record of its chain);
 * - a genesis or mating commitment whose round is resolved is resolved into its creature or its
 *   two births, and one still waiting is its owner's pending hatch (spent once) or an open mating;
 * - each mating's two `mate-commit` records, and no third;
 * - no lock without its active creatures, no running fight without its open row, no open row
 *   without its fight, and every settled fight's records on each fighter's chain;
 * - a seated session plays its player's active creature (or one whose life it saw end), and no
 *   directory entry or anchor names a creature that isn't active;
 * - each creature verifies (`verifyLineage` over its proof bundle): every active and pending one,
 *   or every creature of `players`.
 *
 * With `players`, only what concerns them (or no player at all) is reported: a hub test's object
 * outlives its tests, whose kits wipe tables between them.
 */
export function consistent(hub: Hub, players?: readonly string[]): Inconsistency[] {
  const out: Inconsistency[] = [];
  const rows = (query: string, ...b: SqlStorageValue[]): Row[] =>
    hub.sql.exec<Row>(query, ...b).toArray();
  heads(rows, out);
  commitments(rows, out);
  fights(hub, rows, out);
  sessions(hub, out);
  const scope = players ? new Set(players) : null;
  const ids = rows(
    scope
      ? `SELECT id, owner FROM creatures`
      : "SELECT id, owner FROM creatures WHERE status IN ('active', 'pending')",
  ).flatMap((r) => (!scope || scope.has(String(r.owner)) ? [String(r.id)] : []));
  for (const id of ids) {
    const bundle = proofBundle(hub, id, hub.clock.now());
    if (!bundle) {
      out.push({ kind: 'verify', creature: id, detail: 'no proof bundle' });
      continue;
    }
    for (const p of verifyLineage(bundle).problems) {
      out.push({ kind: 'verify', creature: id, detail: `${p.family}:${p.code} at ${p.seq}` });
    }
  }
  return scope ? out.filter((x) => x.player === undefined || scope.has(x.player)) : out;
}

type Rows = (query: string, ...b: SqlStorageValue[]) => Row[];

function heads(rows: Rows, out: Inconsistency[]): void {
  for (const status of ['active', 'pending']) {
    for (const r of rows(
      'SELECT owner, COUNT(*) AS n FROM creatures WHERE status = ? GROUP BY owner HAVING n > 1',
      status,
    )) {
      out.push({ kind: `two-${status}`, player: String(r.owner), detail: `${r.n} ${status}` });
    }
  }
  const chains = rows(
    `SELECT c.id, c.owner, c.seq, c.hash,
       (SELECT COUNT(*) FROM records r WHERE r.creature = c.id) AS n,
       (SELECT r.hash FROM records r WHERE r.creature = c.id AND r.seq = c.seq) AS last
     FROM creatures c`,
  );
  for (const c of chains) {
    if (c.last !== c.hash || c.n !== (c.seq as number) + 1) {
      out.push({
        kind: 'head',
        player: String(c.owner),
        creature: String(c.id),
        detail: `head ${c.seq} of a chain of ${c.n}, last record ${c.last === c.hash ? 'is' : 'is not'} the head`,
      });
    }
  }
}

function commitments(rows: Rows, out: Inconsistency[]): void {
  const born = new Set(
    rows("SELECT json_extract(json, '$.body.commit') AS c FROM records WHERE seq = 0").map((r) =>
      String(r.c),
    ),
  );
  const pendingOf = new Map(
    rows("SELECT id, pending FROM players WHERE pending <> ''").map((r) => [
      String(r.id),
      String(r.pending),
    ]),
  );
  const matings = new Map(
    rows('SELECT commit_id, resolved, child_a, child_b FROM matings').map((r) => [
      String(r.commit_id),
      r,
    ]),
  );
  const mates = new Map(
    rows(
      `SELECT json_extract(json, '$.body.commit') AS c, COUNT(*) AS n,
         COUNT(DISTINCT creature) AS k, MIN(owner) AS owner
       FROM records WHERE kind = 'mate-commit' GROUP BY c`,
    ).map((r) => [String(r.c), r]),
  );
  const waiting = new Set<string>();
  for (const c of rows(
    "SELECT id, kind, owner, resolved FROM commitments WHERE kind IN ('genesis', 'mate')",
  )) {
    const id = String(c.id);
    const owner = String(c.owner);
    const resolved = c.resolved !== null;
    if (c.kind === 'genesis') {
      if (resolved && !born.has(id))
        out.push({ kind: 'genesis-lost', player: owner, detail: `${id} resolved, no creature` });
      if (!resolved) {
        waiting.add(id);
        if (pendingOf.get(owner) !== id)
          out.push({ kind: 'genesis-hatch', player: owner, detail: `${id} waits, no hatch held` });
      }
      continue;
    }
    const mating = matings.get(id);
    const pair = mates.get(id);
    if (!mating || pair?.n !== 2 || pair.k !== 2) {
      out.push({
        kind: 'mating-records',
        player: owner,
        detail: `${id}: ${mating ? 'a' : 'no'} mating row, ${pair?.n ?? 0} mate-commits`,
      });
      continue;
    }
    if (resolved && !(mating.resolved && born.has(id)))
      out.push({ kind: 'mating-lost', player: owner, detail: `${id} resolved, no births` });
  }
  for (const [player, pending] of pendingOf) {
    if (!waiting.has(pending))
      out.push({ kind: 'genesis-stale', player, detail: `pending ${pending} waits on nothing` });
  }
  for (const [id, pair] of mates) {
    if (!matings.has(id))
      out.push({
        kind: 'mating-records',
        player: String(pair.owner),
        detail: `${id}: ${pair.n} mate-commits, no mating`,
      });
  }
}

function fights(hub: Hub, rows: Rows, out: Inconsistency[]): void {
  const status = (creature: string) =>
    rows('SELECT owner, status FROM creatures WHERE id = ?', creature)[0];
  for (const lock of hub.fights.locks()) {
    lock.creatures.forEach((creature, i) => {
      const head = status(creature);
      if (head?.status !== 'active' || head.owner !== lock.players[i])
        out.push({
          kind: 'lock-creature',
          player: lock.players[i] ?? '',
          creature,
          detail: `locked in ${lock.id} while ${String(head?.status ?? 'unknown')}`,
        });
    });
    const enc = lock.fight?.enc.id;
    if (enc && !hub.fightStore.openRows().some((r) => r.id === enc))
      out.push({ kind: 'fight-row', detail: `${enc} runs with no open row` });
  }
  for (const row of hub.fightStore.openRows()) {
    if (!hub.fights.ofEncounter(row.id))
      out.push({ kind: 'fight-row', detail: `${row.id} open with no fight` });
  }
  for (const r of rows('SELECT id, settlement FROM encounters WHERE settlement IS NOT NULL')) {
    const settled = JSON.parse(String(r.settlement)) as SignedSettlement;
    for (const f of settled.settlement.results) {
      const held = rows(
        "SELECT 1 FROM records WHERE creature = ? AND json_extract(json, '$.body.enc') = ? LIMIT 1",
        f.creature,
        String(r.id),
      );
      if (held.length === 0)
        out.push({
          kind: 'fight-records',
          player: f.player,
          creature: f.creature,
          detail: `settled ${r.id} with no record`,
        });
    }
  }
}

function sessions(hub: Hub, out: Inconsistency[]): void {
  const seatedIds = new Set<string>();
  for (const [, s] of activeSessions(hub)) {
    seatedIds.add(s.playerId);
    const head = s.life ? hub.ledger.head(s.life.creature) : null;
    const playing = s.life && !s.life.over;
    const active = head?.status === 'active' && head.owner === s.playerId;
    if (playing && !active)
      out.push({
        kind: 'session-creature',
        player: s.playerId,
        creature: s.life?.creature ?? '',
        detail: `plays a creature that is ${head?.status ?? 'unknown'}`,
      });
    if (!s.life) continue;
    const inWater = hub.directory.member(s.playerId) !== null;
    if ((inWater || s.anchor) && !(playing && active))
      out.push({
        kind: 'ashore',
        player: s.playerId,
        creature: s.life.creature,
        detail: `${inWater ? 'in the directory' : 'anchored'} while its life is over`,
      });
  }
  for (const m of hub.directory.members()) {
    if (!seatedIds.has(m.id))
      out.push({ kind: 'directory', player: m.id, detail: 'in the directory, not seated' });
  }
}
