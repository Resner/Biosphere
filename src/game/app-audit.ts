// An auditor duty in the page (M10 T8, ADR 0058). The hub offers this page a fight's, a mating's or
// a genesis's case; the page checks its own selection (the beacon and the drand order), answers
// `duty-ok`, works out its verdict and sends the signed attestation. Both checks run in a module
// worker (`audit-worker.ts`), never on the frame loop; the page only signs. It loads with the first
// auditor duty (it brings `@noble/curves`), never with the app shell.

import { commitmentId } from '../ledger/genesis';
import type { Identity } from '../ledger/identity';
import type { PubKey } from '../ledger/record';
import { signAttestation } from '../ledger/witness';
import type { AuditJob, AuditorDuty, AuditReply } from '../net/audit';

export type { AuditorDuty };

import type { ClientMsg, HubMsg } from '../net/protocol';

type DutyEnd = Extract<HubMsg, { t: 'duty-end' }>;

/** A job without its id: the runner numbers them. */
type Job = AuditJob extends infer J ? (J extends AuditJob ? Omit<J, 'id'> : never) : never;
type Reply<T extends AuditJob['t']> = Extract<AuditReply, { t: T }>;

/** Runs jobs off the page's thread (the module worker), or inline in tests. */
export interface AuditRunner {
  run<J extends Job>(job: J): Promise<Reply<J['t']>>;
}

/** A runner over a module worker, made at the first job and kept. A worker that fails fails every job waiting on it. */
export function workerRunner(make: () => Worker): AuditRunner {
  let worker: Worker | null = null;
  let next = 0;
  const waiting = new Map<number, { ok: (r: AuditReply) => void; fail: (e: unknown) => void }>();
  const failAll = (error: unknown) => {
    for (const w of waiting.values()) w.fail(error);
    waiting.clear();
    worker?.terminate();
    worker = null;
  };
  const start = (): Worker => {
    const w = make();
    w.addEventListener('message', (e: MessageEvent<AuditReply>) => {
      const found = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      found?.ok(e.data);
    });
    w.addEventListener('error', (e) => failAll(e));
    return w;
  };
  return {
    run(job) {
      worker ??= start();
      const id = ++next;
      const w = worker;
      return new Promise((ok, fail) => {
        waiting.set(id, { ok: ok as (r: AuditReply) => void, fail });
        w.postMessage({ ...job, id });
      });
    },
  };
}

export interface AuditHost {
  identity(): Identity | null;
  /** The authority's keys (a fight's settlement is checked under them); null when they could not be had. */
  keys(): Promise<readonly PubKey[] | null>;
  sendHub(msg: ClientMsg): void;
  runner: AuditRunner;
  perfNow(): number;
}

/** One audit this page finished: its event, its verdict and how long the verdict took (ms). */
export interface AuditRecord {
  event: string;
  agree: boolean;
  code?: string;
  ms: number;
}

/** The audits kept for `state().witness.audits`. */
const KEEP = 20;

interface Held {
  event: string;
  /** `checking` its selection, then `auditing` once it said `duty-ok`. */
  phase: 'checking' | 'auditing';
}

export class AuditDuties {
  private held: Held | null = null;
  readonly audits: AuditRecord[] = [];

  constructor(private readonly host: AuditHost) {}

  /** The event audited now, or null. */
  get auditing(): string | null {
    return this.held?.event ?? null;
  }

  /** The hub offers an auditor duty: checked, taken, audited and attested; declined when it cannot be. */
  async offer(msg: AuditorDuty): Promise<void> {
    const { host } = this;
    const identity = host.identity();
    if (this.held || !identity) {
      this.decline(msg.event);
      return;
    }
    const held: Held = { event: msg.event, phase: 'checking' };
    this.held = held;
    try {
      const keys = msg.audit.kind === 'enc' ? await host.keys() : [];
      const me = identity.playerId;
      const selected = keys ? await host.runner.run({ t: 'select', duty: msg, me }) : null;
      if (this.held !== held) return;
      if (!keys || !selected?.ok) {
        this.decline(msg.event);
        return;
      }
      host.sendHub({ t: 'duty-ok', event: msg.event });
      held.phase = 'auditing';
      const t0 = host.perfNow();
      const { verdict } = await host.runner.run({
        t: 'verdict',
        audit: msg.audit,
        beacon: msg.beacon,
        keys: [...keys],
      });
      // The duty ended while the worker ran (replaced, struck or the hub restarted): nothing to send.
      if (this.held !== held) return;
      const code = verdict.code === undefined ? {} : { code: verdict.code };
      const signed = signAttestation(identity, {
        v: 1,
        kind: 'attest',
        event: msg.event,
        duty: commitmentId(msg.commit.commitment),
        position: msg.position,
        witness: me,
        subject: verdict.subject,
        agree: verdict.agree,
        ...code,
      });
      host.sendHub({ t: 'attest', signed });
      this.audits.push({
        event: msg.event,
        agree: verdict.agree,
        ...code,
        ms: host.perfNow() - t0,
      });
      if (this.audits.length > KEEP) this.audits.shift();
    } catch {
      // The worker failed: before `duty-ok` the duty goes to the next position, after it the hub replaces a silent auditor.
      if (this.held === held && held.phase === 'checking') this.decline(msg.event);
    } finally {
      if (this.held === held) this.held = null;
    }
  }

  /** The hub ended a duty: an audit in progress for it sends nothing. */
  end(msg: DutyEnd): void {
    if (this.held?.event === msg.event) this.held = null;
  }

  /** A new hub session holds no duty of this page's. */
  reset(): void {
    this.held = null;
  }

  private decline(event: string): void {
    this.host.sendHub({ t: 'duty-no', event });
  }
}
