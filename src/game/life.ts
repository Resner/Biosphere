// The client's side of a recorded life (M4, ADR 0019): ask for a genesis, check what comes back,
// resume a saved creature, report progress and death. DOM-free; the shell drives it and decides what
// a spawn looks like. A cell the hub does not know about is a practice cell: nothing is sent for it.

import { signGenesisAsk } from '../ledger/ask';
import type { Identity } from '../ledger/identity';
import { recordHash } from '../ledger/record';
import type { LifeMsg } from '../net/hub-client';
import type { ClientMsg, HubMsg, LifeInfo } from '../net/protocol';
import type { DeathCause } from '../sim/types';

type GenesisMsg = Extract<HubMsg, { t: 'genesis' }>;

export type LifeStatus =
  | 'idle'
  | 'requesting'
  | 'awaiting'
  | 'verifying'
  | 'playing'
  | 'dead'
  | 'practice';

/** The slice of the online session the flow talks through. */
export interface LifeLink {
  send(msg: ClientMsg): void;
}

export interface LifeDeps {
  /** The browser identity, once it is loaded. */
  identity(): Identity;
  /** A fresh 16-byte nonce as base64url. */
  nonce(): string;
  /** Why the genesis is not the one its commitment and beacon produce; empty when it is. */
  verify(genesis: GenesisMsg): Promise<string[]>;
}

/** What the creature starts with. `condition` is in world units; null means the genome's own start. */
export interface Started {
  creature: string;
  seq: number;
  /** The genome as base64url text. */
  genome: string;
  condition: { biomass: number; energy: number; health: number } | null;
  activeMs: number;
  /** 0 until the hub says (the first `ack` for a fresh creature). */
  lifespanMs: number;
}

export type HatchOutcome =
  | { kind: 'recorded'; start: Started }
  | { kind: 'practice'; reason: 'offline' | 'limit'; genesisIn?: number }
  | { kind: 'failed'; message: string };

export interface LifeView {
  status: LifeStatus;
  creature: string | null;
  seq: number;
  activeMs: number;
  lifespanMs: number;
  awaitingBeacon: boolean;
  lastAckN: number;
  /** Ms until the next recorded hatch, as the hub last said (0 = now). */
  genesisIn: number;
  practice: boolean;
}

/** The longest a genesis may wait for its beacon: the round comes in 3 to 6 s. */
const GENESIS_WAIT_MS = 20_000;
const HUNDREDTHS = 100;

export const VERIFY_FAILED = 'Could not verify your creature';
const SLOW = 'The pond is slow to answer. Try again.';
const ELSEWHERE = 'Your creature is playing in another tab. Reload the page.';
const NOT_HATCHED = 'Could not hatch. Try again.';

type Condition = { biomass: number; energy: number; health: number };

export class LifeFlow {
  private link: LifeLink | null = null;
  /** What the hub last said the player has; null until its `life` arrives on this connection. */
  private known: { life: LifeInfo | null; genesisIn: number } | null = null;
  private status: LifeStatus = 'idle';
  private creature: string | null = null;
  private seq = 0;
  private activeMs = 0;
  private lifespanMs = 0;
  private lastAckN = 0;
  private genesisIn = 0;
  private waiter: ((msg: LifeMsg) => void) | null = null;
  /** Counters the hub sees: `n` and `ticks` start again on every connection. */
  private n = 0;
  private tickBase = 0;
  private lastTicks = 0;
  private rebase = false;
  private last: GenesisMsg | null = null;

  constructor(private readonly deps: LifeDeps) {}

  view(): LifeView {
    return {
      status: this.status,
      creature: this.creature,
      seq: this.seq,
      activeMs: this.activeMs,
      lifespanMs: this.lifespanMs,
      awaitingBeacon: this.status === 'awaiting',
      lastAckN: this.lastAckN,
      genesisIn: this.genesisIn,
      practice: this.status === 'practice',
    };
  }

  /** The last genesis this flow accepted, for tests that recompute its DNA. */
  lastGenesis(): GenesisMsg | null {
    return this.last;
  }

  /** A new hub connection (or none): what the old one said about the player no longer holds. */
  attach(link: LifeLink | null): void {
    this.link = link;
    this.known = null;
  }

  receive(msg: LifeMsg): void {
    switch (msg.t) {
      case 'life':
        this.known = { life: msg.life, genesisIn: msg.genesisIn };
        this.genesisIn = msg.genesisIn;
        // The hub binds the creature again on every connection and counts from zero.
        if (this.status === 'playing') this.rebase = true;
        break;
      case 'ack':
        if (this.status !== 'playing') break;
        this.lastAckN = Math.max(this.lastAckN, msg.n);
        this.activeMs = msg.activeMs;
        this.lifespanMs = msg.lifespanMs;
        break;
      case 'commit':
        if (this.status === 'requesting') this.status = 'awaiting';
        break;
      case 'genesis':
        if (this.status === 'requesting' || this.status === 'awaiting') this.status = 'verifying';
        break;
      case 'died':
        if (this.status === 'playing') this.ended();
        break;
      default:
        break;
    }
    this.waiter?.(msg);
  }

  /** Starts a recorded life: the saved creature if there is one, else a new genesis. */
  async hatch(waitMs: number): Promise<HatchOutcome> {
    if (!this.link) return this.practiceCell('offline');
    this.status = 'requesting';
    if (!this.known) await this.wait(waitMs, (m) => (m.t === 'life' ? m : undefined));
    const { known } = this;
    if (!known) return this.practiceCell('offline');
    if (known.life) return this.resume(known.life);
    if (known.genesisIn > 0) return this.practiceCell('limit', known.genesisIn);
    return this.genesis();
  }

  /** The shell plays an unrecorded cell (a pinned body, no hub): nothing goes to the hub. */
  practice(): void {
    this.status = 'practice';
    this.creature = null;
  }

  /** The creature's condition, from the game's tick count since it hatched. */
  report(ticks: number, condition: Condition): void {
    if (this.status !== 'playing' || !this.link) return;
    const counted = this.count(ticks);
    this.n++;
    this.link.send({
      t: 'progress',
      n: this.n,
      ticks: counted,
      biomass: hundredths(condition.biomass),
      energy: hundredths(condition.energy),
      health: hundredths(condition.health),
    });
  }

  /** The creature died; the hub hears once. Old age is the hub's own call. */
  died(cause: DeathCause, ticks: number): void {
    if (this.status !== 'playing') return;
    const sent = this.count(ticks);
    this.ended();
    if (cause !== 'old-age') this.link?.send({ t: 'death', cause, ticks: sent });
  }

  /** `ticks` as this connection counts them, from the first report after a (re)connection. */
  private count(ticks: number): number {
    if (this.rebase) {
      this.tickBase = this.lastTicks;
      this.n = 0;
      this.rebase = false;
    }
    this.lastTicks = ticks;
    return Math.max(0, ticks - this.tickBase);
  }

  private ended(): void {
    this.status = 'dead';
    // Whatever the hub said before, the player has no creature now; a hatch asks for a genesis.
    this.known = { life: null, genesisIn: this.genesisIn };
  }

  private practiceCell(reason: 'offline' | 'limit', genesisIn?: number): HatchOutcome {
    this.practice();
    if (genesisIn !== undefined) this.genesisIn = genesisIn;
    return genesisIn === undefined
      ? { kind: 'practice', reason }
      : { kind: 'practice', reason, genesisIn };
  }

  private fail(message: string): HatchOutcome {
    this.status = 'idle';
    return { kind: 'failed', message };
  }

  private begin(start: Started): HatchOutcome {
    this.status = 'playing';
    this.creature = start.creature;
    this.seq = start.seq;
    this.activeMs = start.activeMs;
    this.lifespanMs = start.lifespanMs;
    this.lastAckN = 0;
    this.n = 0;
    this.tickBase = 0;
    this.lastTicks = 0;
    this.rebase = false;
    return { kind: 'recorded', start };
  }

  private resume(life: LifeInfo): HatchOutcome {
    // A creature that was never reported has no condition yet: it starts from its genome.
    const fresh = life.biomass === 0;
    return this.begin({
      creature: life.creature,
      seq: life.seq,
      genome: life.genome,
      condition: fresh
        ? null
        : {
            biomass: life.biomass / HUNDREDTHS,
            energy: life.energy / HUNDREDTHS,
            health: life.health / HUNDREDTHS,
          },
      activeMs: life.activeMs,
      lifespanMs: life.lifespanMs,
    });
  }

  private async genesis(): Promise<HatchOutcome> {
    const ask = signGenesisAsk(this.deps.identity(), this.deps.nonce());
    this.link?.send({ t: 'genesis-request', nonce: ask.nonce, sig: ask.sig });
    const reply = await this.wait(GENESIS_WAIT_MS, (m) =>
      m.t === 'genesis' || m.t === 'refused' ? m : undefined,
    );
    if (!reply) return this.fail(SLOW);
    if (reply.t === 'refused') {
      if (reply.reason === 'limit') return this.practiceCell('limit', reply.genesisIn ?? 0);
      return this.fail(reply.reason === 'active' ? ELSEWHERE : NOT_HATCHED);
    }
    if (reply.t !== 'genesis') return this.fail(NOT_HATCHED);
    if (!(await this.checked(reply))) return this.fail(VERIFY_FAILED);
    this.known = { life: null, genesisIn: this.genesisIn };
    this.last = reply;
    return this.begin({
      creature: reply.record.hash,
      seq: 0,
      genome: reply.genome,
      condition: null,
      activeMs: 0,
      lifespanMs: 0,
    });
  }

  /** The cheap checks here, then the BLS and DNA recomputation the shell supplies. */
  private async checked(g: GenesisMsg): Promise<boolean> {
    const { record, hash } = g.record;
    if (record.owner !== this.deps.identity().playerId) return false;
    if (g.commit.commitment.owner !== record.owner) return false;
    if (hash !== recordHash(record)) return false;
    try {
      const problems = await this.deps.verify(g);
      if (problems.length > 0) console.warn('genesis refused:', problems.join(', '));
      return problems.length === 0;
    } catch (error) {
      console.warn('genesis check failed', error);
      return false;
    }
  }

  /** Resolves with the first message `pick` accepts, or null after `ms`. */
  private wait<T>(ms: number, pick: (msg: LifeMsg) => T | undefined): Promise<T | null> {
    return new Promise((resolve) => {
      const finish = (value: T | null): void => {
        clearTimeout(timer);
        this.waiter = null;
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), ms);
      this.waiter = (msg) => {
        const value = pick(msg);
        if (value !== undefined) finish(value);
      };
    });
  }
}

function hundredths(value: number): number {
  return Math.max(0, Math.round(value * HUNDREDTHS));
}
