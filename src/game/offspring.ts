// The player's pending child (M5 T11): the hub's `born` is checked, shown as an egg for a moment,
// then kept as a card until the player becomes it. DOM-free; the shell draws it and the life flow
// does the promotion. Nothing here says "record", "commitment" or "beacon".

import { parseGenomeText } from '../genome/codec';
import type { LifeMsg } from '../net/hub-client';
import type { Born } from '../net/protocol';
import { type Body, hatchBody } from './body';

/** How long a new child shows as an egg before it becomes a card. */
export const EGG_MS = 3000;

export const VERIFY_BORN_FAILED = 'Could not verify your offspring';

export interface Child {
  born: Born;
  body: Body;
  generation: number;
}

export type OffspringView =
  | { kind: 'none' }
  | { kind: 'verifying' }
  | { kind: 'failed'; message: string }
  | { kind: 'egg'; child: Child }
  | { kind: 'card'; child: Child; later: boolean };

export interface OffspringDeps {
  now(): number;
  /** Why this birth is not the child its parents and the committed round produce; empty when it is. */
  verify(born: Born): Promise<string[]>;
  /** How long this child stays an egg before its card (its reveal, M6 T20); `EGG_MS` without it. */
  eggMs?(child: Child): number;
}

export class OffspringFlow {
  private state: OffspringView = { kind: 'none' };
  private eggAt = 0;
  /** Bumped by every new message about the child, so a slow check never overwrites a newer state. */
  private epoch = 0;
  private later = false;

  constructor(private readonly deps: OffspringDeps) {}

  view(): OffspringView {
    return this.state;
  }

  /** The verified child, whether it is an egg or a card; null before the check ends. */
  child(): Child | null {
    return this.state.kind === 'egg' || this.state.kind === 'card' ? this.state.child : null;
  }

  receive(msg: LifeMsg): void {
    switch (msg.t) {
      case 'born':
        this.later = false;
        void this.accept(msg, true);
        break;
      case 'life':
        // After a reconnect the same child is already shown; a different one starts over.
        if (msg.pending) {
          if (this.child()?.born.record.hash !== msg.pending.record.hash) {
            this.later = false;
            void this.accept(msg.pending, false);
          }
        } else {
          this.clear();
        }
        break;
      case 'promoted':
        this.clear();
        break;
      default:
        break;
    }
  }

  /** Egg to card once its moment has passed. */
  tick(): void {
    if (this.state.kind !== 'egg') return;
    const ms = this.deps.eggMs?.(this.state.child) ?? EGG_MS;
    if (this.deps.now() - this.eggAt >= ms) {
      this.state = { kind: 'card', child: this.state.child, later: this.later };
    }
  }

  /** "Later": the card goes away until the next child, and `H` still works. */
  postpone(): void {
    this.later = true;
    if (this.state.kind === 'card') this.state = { ...this.state, later: true };
  }

  private clear(): void {
    this.epoch++;
    this.state = { kind: 'none' };
  }

  private async accept(born: Born, egg: boolean): Promise<void> {
    const mine = ++this.epoch;
    this.state = { kind: 'verifying' };
    let problems: string[];
    try {
      problems = await this.deps.verify(born);
    } catch (error) {
      console.warn('birth check failed', error);
      problems = ['unreadable'];
    }
    if (mine !== this.epoch) return;
    const genome = parseGenomeText(born.genome);
    if (problems.length > 0 || !genome) {
      if (problems.length > 0) console.warn('birth refused:', problems.join(', '));
      this.state = { kind: 'failed', message: VERIFY_BORN_FAILED };
      return;
    }
    const generation = born.record.record.body.generation;
    const child: Child = {
      born,
      body: hatchBody(genome),
      generation: typeof generation === 'number' ? generation : 0,
    };
    if (egg) {
      this.eggAt = this.deps.now();
      this.state = { kind: 'egg', child };
    } else {
      this.state = { kind: 'card', child, later: this.later };
    }
  }
}
