// The client's side of courting (M5 T10, ADR 0021): look at a partner, court, answer an invitation,
// pay and wait for the offspring. DOM-free; the shell supplies the clock, the creature's state and
// what to do with the cost. The hub decides everything that counts: this only asks and shows.

import type { Identity } from '../ledger/identity';
import { toBase64Url } from '../ledger/identity';
import { type MateAsk, signMateAsk } from '../ledger/mate-ask';
import type { LifeMsg } from '../net/hub-client';
import type { ClientMsg } from '../net/protocol';
import { type MateView, ownRefusal, pairRefusal } from '../sim/mating';
import { RULES } from '../sim/rules';
import { bandWords, refusalText } from './mate-text';

export type MateState =
  | 'idle'
  | 'checking'
  | 'courting'
  | 'invited'
  | 'signing'
  | 'awaiting'
  | 'done'
  | 'declined'
  | 'expired';

/** The slice of the online session the flow talks through. */
export interface MateLink {
  send(msg: ClientMsg): void;
}

export interface MateDeps {
  identity(): Identity;
  /** A fresh 16-byte nonce as base64url. */
  nonce(): string;
  /** A millisecond clock; any origin. */
  now(): number;
  /** What the rules see of the player's own creature now; null when there is none to mate. */
  own(): MateView | null;
  /** The name of a player in the pond. */
  nameOf(id: string): string | undefined;
}

/** A creature near enough to court, as the shell sees it. */
export interface Nearby {
  id: string;
  name: string;
  biomass: number;
}

export interface Invite {
  from: string;
  name: string;
  ask: MateAsk;
  generation: number;
  /** The inbreeding words for a child of the two. */
  band: string;
}

export interface MateViewModel {
  state: MateState;
  /** One line about what is going on or why it ended; empty when there is nothing to say. */
  note: string;
  invite: Invite | null;
  inviteLeftMs: number;
}

type Info = Extract<LifeMsg, { t: 'mate-info' }>;

const SIGN_WINDOW_MS = RULES.mating.signWindowMs;
const ACCEPT_MS = RULES.mating.acceptShownMs;
/** A `mate-info` is good for this long when courting, and no new ask goes out sooner than the gap. */
const COURT_FRESH_MS = 5000;
const CHECK_FRESH_MS = 3000;
const CHECK_GAP_MS = 2000;
/** The longest an E press waits for the hub's check before giving up. */
const CHECK_WAIT_MS = 5000;
/** How long the reason a mating ended stays on screen. */
const NOTE_MS = 4000;
/** Hub refusals that belong to the life flow, not to a mating. */
const LIFE_REFUSALS: ReadonlySet<string> = new Set(['dead', 'cause', 'queued', 'limit', 'active']);

const VISITED_KEPT = 16;

const BUSY: ReadonlySet<MateState> = new Set([
  'checking',
  'courting',
  'invited',
  'signing',
  'awaiting',
]);

export class MateFlow {
  private link: MateLink | null = null;
  private state: MateState = 'idle';
  private partner: string | null = null;
  private note = '';
  private since = 0;
  private invite: Invite | null = null;
  private infos = new Map<string, { info: Info; at: number }>();
  private asked = new Map<string, number>();
  private owed = false;
  /** The states entered, oldest first (the last 16): the test hook shows what a fast flow went through. */
  readonly visited: MateState[] = [];

  constructor(private readonly deps: MateDeps) {}

  view(): MateViewModel {
    const left = this.invite ? ACCEPT_MS - (this.deps.now() - this.since) : 0;
    return {
      state: this.state,
      note: this.note,
      invite: this.invite,
      inviteLeftMs: Math.max(0, left),
    };
  }

  /** A new hub connection (or none): what was in the air is lost. */
  attach(link: MateLink | null): void {
    this.link = link;
    this.infos.clear();
    this.asked.clear();
    this.enter('idle');
  }

  /** True once after a mating is committed: the shell applies the cost to the creature. */
  takeCost(): boolean {
    const owed = this.owed;
    this.owed = false;
    return owed;
  }

  /** Asks the hub about a partner, unless an answer is fresh or one is on its way. */
  check(partner: string): void {
    const now = this.deps.now();
    const known = this.infos.get(partner);
    if (known && now - known.at < CHECK_FRESH_MS) return;
    const last = this.asked.get(partner);
    if (last !== undefined && now - last < CHECK_GAP_MS) return;
    this.asked.set(partner, now);
    this.link?.send({ t: 'mate-check', partner });
  }

  /** The latest `mate-check` answer about a player, or null before one arrives. */
  info(partner: string): Info | null {
    return this.infos.get(partner)?.info ?? null;
  }

  /** The line beside a creature in reach: the court key, or the plain reason why not. */
  hint(near: Nearby): { court: boolean; text: string } | null {
    const view = this.mine();
    if (!view || !this.startable()) return null;
    const refusal = this.refusal(view, near);
    if (refusal) return { court: false, text: refusal };
    const known = this.infos.get(near.id);
    if (known?.info.reason) {
      return {
        court: false,
        text: refusalText(known.info.reason, known.info.cooldownLeftMs, near.name),
      };
    }
    return { court: true, text: `E: court ${near.name}` };
  }

  /** The court key: one press sends one court, and repeats are ignored. */
  court(partner: string): void {
    const view = this.mine();
    if (!view || !this.link || !this.startable()) return;
    const name = this.deps.nameOf(partner) ?? 'They';
    const own = ownRefusal(view);
    if (own) {
      this.end('idle', refusalText(own, view.cooldownUntilMs - view.activeMs));
      return;
    }
    const known = this.infos.get(partner);
    if (known && this.deps.now() - known.at < COURT_FRESH_MS) {
      this.start(partner, known.info, name);
      return;
    }
    this.partner = partner;
    this.enter('checking');
    this.asked.set(partner, this.deps.now());
    this.link.send({ t: 'mate-check', partner });
  }

  /** Accepts the invitation on screen. */
  accept(): void {
    const { invite } = this;
    const view = this.mine();
    if (this.state !== 'invited' || !invite || !view) return;
    const ask = signMateAsk(this.deps.identity(), {
      creature: view.creature,
      partner: invite.from,
      partnerCreature: invite.ask.creature,
      nonce: invite.ask.nonce,
    });
    this.link?.send({ t: 'accept', ask });
    this.enter('signing');
  }

  /** Declines the invitation on screen. */
  decline(): void {
    const { invite } = this;
    if (this.state !== 'invited' || !invite) return;
    this.link?.send({ t: 'decline', partner: invite.from });
    this.end('declined', '');
  }

  /** Runs the clocks: call it every frame. */
  tick(): void {
    const age = this.deps.now() - this.since;
    switch (this.state) {
      case 'checking':
        if (age >= CHECK_WAIT_MS) this.end('idle', 'The pond is slow to answer');
        break;
      case 'courting':
        if (age >= SIGN_WINDOW_MS) this.end('expired', 'No answer');
        break;
      case 'signing':
        if (age >= SIGN_WINDOW_MS) this.end('expired', 'Could not mate');
        break;
      case 'invited':
        if (age >= ACCEPT_MS) this.decline();
        break;
      case 'declined':
      case 'expired':
      case 'done':
        if (age >= NOTE_MS) this.enter('idle');
        break;
      default:
        break;
    }
  }

  receive(msg: LifeMsg): void {
    switch (msg.t) {
      case 'mate-info':
        this.infos.set(msg.partner, { info: msg, at: this.deps.now() });
        if (this.state === 'checking' && this.partner === msg.partner) this.checked(msg);
        break;
      case 'invite':
        this.invited(msg);
        break;
      case 'declined':
        if (this.state === 'courting' && this.partner === msg.by) {
          this.end('declined', `${this.deps.nameOf(msg.by) ?? 'They'} said no`);
        }
        break;
      case 'mating':
        if (this.state === 'courting' || this.state === 'signing') {
          this.owed = true;
          this.enter('awaiting');
          this.note = 'Awaiting beacon';
        }
        break;
      case 'born':
        if (this.state === 'awaiting') this.end('done', '');
        break;
      case 'refused':
        if (BUSY.has(this.state) && this.state !== 'awaiting' && !LIFE_REFUSALS.has(msg.reason)) {
          this.end('declined', refusalText(msg.reason, 0, this.deps.nameOf(this.partner ?? '')));
        }
        break;
      default:
        break;
    }
  }

  /** The creature as the rules see it, with this flow's own busy state counted as in flight. */
  private mine(): MateView | null {
    const view = this.deps.own();
    if (!view) return null;
    return BUSY.has(this.state) ? { ...view, inFlight: true } : view;
  }

  private startable(): boolean {
    return !BUSY.has(this.state);
  }

  /** Why this creature cannot court that one, by what the client itself can see. */
  private refusal(view: MateView, near: Nearby): string | null {
    const own = ownRefusal(view);
    if (own) return refusalText(own, view.cooldownUntilMs - view.activeMs);
    const theirs = pairRefusal(view, { ...view, owner: near.id, biomass: near.biomass });
    return theirs ? refusalText(theirs) : null;
  }

  private checked(info: Info): void {
    this.start(info.partner, info, this.deps.nameOf(info.partner) ?? 'They');
  }

  private start(partner: string, info: Info, name: string): void {
    if (info.reason || !info.creature) {
      this.end('declined', refusalText(info.reason ?? 'not-here', info.cooldownLeftMs, name));
      return;
    }
    const view = this.mine();
    if (!view || !this.link) {
      this.enter('idle');
      return;
    }
    const ask = signMateAsk(this.deps.identity(), {
      creature: view.creature,
      partner,
      partnerCreature: info.creature,
      nonce: this.deps.nonce(),
    });
    this.partner = partner;
    this.link.send({ t: 'court', ask });
    this.enter('courting');
  }

  private invited(msg: Extract<LifeMsg, { t: 'invite' }>): void {
    const view = this.mine();
    // Busy, or not able to mate: the courting player hears no at once instead of waiting 15 s.
    if (!view || !this.startable() || ownRefusal(view)) {
      this.link?.send({ t: 'decline', partner: msg.from });
      return;
    }
    this.partner = msg.from;
    this.invite = {
      from: msg.from,
      name: this.deps.nameOf(msg.from) ?? 'Someone',
      ask: msg.ask,
      generation: msg.generation,
      band: bandWords(msg.kinship),
    };
    this.enter('invited');
  }

  private enter(state: MateState): void {
    this.state = state;
    if (state !== 'invited') this.invite = null;
    if (this.visited.push(state) > VISITED_KEPT) this.visited.shift();
    this.since = this.deps.now();
    this.note = '';
    if (state === 'idle') this.partner = null;
  }

  private end(state: MateState, note: string): void {
    this.enter(state);
    this.note = note;
  }
}

/** A random nonce for an ask. */
export const randomNonce = (): string => toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
