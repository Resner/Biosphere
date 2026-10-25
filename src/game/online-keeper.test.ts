import { describe, expect, it } from 'vitest';
import { OnlineKeeper } from './online-keeper';

class Fake {
  disposed = false;
  final = false;
  constructor(readonly name: string) {}
  get status(): 'online' | 'closed' {
    return this.final ? 'closed' : 'online';
  }
  dispose(): void {
    this.disposed = true;
  }
}

const setup = () => {
  const made: Fake[] = [];
  const stopped: Fake[] = [];
  const keeper = new OnlineKeeper<Fake>({
    start: (name) => {
      const s = new Fake(name);
      made.push(s);
      return s;
    },
    stop: (s) => {
      stopped.push(s);
      s.dispose();
    },
    isFinal: (s) => s.final,
  });
  return { keeper, made, stopped };
};

describe('OnlineKeeper', () => {
  it('starts once per name and reuses a live session', () => {
    const { keeper, made } = setup();
    keeper.ensure('Ann');
    keeper.ensure('Ann');
    expect(made).toHaveLength(1);
    expect(keeper.current).toBe(made[0]);
  });

  it('replaces the session for a new name or a final one', () => {
    const { keeper, made, stopped } = setup();
    keeper.ensure('Ann');
    keeper.ensure('Bea');
    expect(made.map((s) => s.name)).toEqual(['Ann', 'Bea']);
    expect(stopped).toEqual([made[0]]);
    if (made[1]) made[1].final = true;
    keeper.ensure('Bea');
    expect(made).toHaveLength(3);
  });

  it('clears the session on suspend, so the page coming back from the cache reconnects', () => {
    const { keeper, made } = setup();
    keeper.ensure('Ann');
    keeper.suspend();
    expect(made[0]?.disposed).toBe(true);
    expect(keeper.current).toBeNull();
    keeper.resume();
    expect(made).toHaveLength(2);
    expect(made[1]?.name).toBe('Ann');
    expect(keeper.current).toBe(made[1]);
  });

  it('does nothing on resume before a first session or after one that was never suspended', () => {
    const { keeper, made } = setup();
    keeper.resume();
    expect(made).toHaveLength(0);
    keeper.ensure('Ann');
    keeper.resume();
    expect(made).toHaveLength(1);
  });
});
