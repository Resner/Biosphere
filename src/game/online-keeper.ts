// Keeps at most one online session per tab: replaced for a new name or a final status, and
// dropped and restored around the page cache (`pagehide`, then `pageshow` when it comes back).

export interface KeeperOptions<S> {
  start(name: string): S;
  /** Leaves the pond and closes the session. */
  stop(session: S): void;
  /** Whether the session has ended for good (replaced elsewhere, outdated). */
  isFinal(session: S): boolean;
}

export class OnlineKeeper<S> {
  current: S | null = null;
  private name: string | null = null;

  constructor(private readonly opts: KeeperOptions<S>) {}

  /** The session for `name`: the live one when it fits, else a new one. */
  ensure(name: string): S {
    const { current } = this;
    if (current && this.name === name && !this.opts.isFinal(current)) return current;
    if (current) this.opts.stop(current);
    this.current = null;
    this.name = name;
    this.current = this.opts.start(name);
    return this.current;
  }

  /** Stops the session but remembers the name, so `resume` can bring it back. */
  suspend(): void {
    if (this.current) this.opts.stop(this.current);
    this.current = null;
  }

  /** Starts a session again after `suspend`; does nothing while one is running or none ever was. */
  resume(): void {
    if (this.current === null && this.name !== null) this.ensure(this.name);
  }
}
