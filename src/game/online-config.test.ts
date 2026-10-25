import { describe, expect, it } from 'vitest';
import {
  cleanName,
  defaultName,
  hubSocketUrl,
  loadName,
  ringSpawn,
  saveName,
  statusText,
} from './online-config';

describe('hubSocketUrl', () => {
  it('runs offline with neither a query nor a build URL', () => {
    expect(hubSocketUrl('', '')).toBeNull();
  });

  it('turns the build URL into the hub WebSocket endpoint', () => {
    expect(hubSocketUrl('', 'https://hub.example.workers.dev')).toBe(
      'wss://hub.example.workers.dev/v1/hub',
    );
    expect(hubSocketUrl('', 'https://hub.example.workers.dev/')).toBe(
      'wss://hub.example.workers.dev/v1/hub',
    );
  });

  it('lets ?hub= select a local authority over the build URL', () => {
    expect(hubSocketUrl('?hub=http://localhost:8787', 'https://prod.example')).toBe(
      'ws://localhost:8787/v1/hub',
    );
    expect(hubSocketUrl('?debug=1&hub=http://127.0.0.1:1', '')).toBe('ws://127.0.0.1:1/v1/hub');
  });

  it('refuses a ?hub= that is not local, so a shared link cannot redirect players', () => {
    expect(hubSocketUrl('?hub=https://evil.example', 'https://prod.example')).toBe(
      'wss://prod.example/v1/hub',
    );
    expect(hubSocketUrl('?hub=https://evil.example', '')).toBeNull();
    expect(hubSocketUrl('?hub=not a url', '')).toBeNull();
  });
});

describe('names', () => {
  const store = (initial: Record<string, string> = {}) => {
    const data = { ...initial };
    return {
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
      data,
    };
  };

  it('defaults to Cell and four digits', () => {
    expect(defaultName(() => 0.1234)).toMatch(/^Cell\d{4}$/);
    expect(defaultName(() => 0)).toBe('Cell0000');
    expect(defaultName(() => 0.99999)).toBe('Cell9999');
  });

  it('remembers the name, and makes one the first time', () => {
    const s = store();
    const first = loadName(s, () => 0.5);
    expect(first).toBe('Cell5000');
    expect(s.data['bs.name']).toBe('Cell5000');
    expect(loadName(s, () => 0.9)).toBe('Cell5000');
    saveName(s, 'Ada_1');
    expect(loadName(s, () => 0.9)).toBe('Ada_1');
  });

  it('replaces a stored name that is no longer valid, and survives a broken store', () => {
    expect(loadName(store({ 'bs.name': 'x' }), () => 0.25)).toBe('Cell2500');
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadName(broken, () => 0.25)).toBe('Cell2500');
    expect(() => saveName(broken, 'Ada')).not.toThrow();
  });

  it('cleans typed names: trimmed, valid or null', () => {
    expect(cleanName('  Ada  ')).toBe('Ada');
    expect(cleanName('a-b_c')).toBe('a-b_c');
    expect(cleanName('ab')).toBeNull();
    expect(cleanName('a'.repeat(17))).toBeNull();
    expect(cleanName('has space')).toBeNull();
    expect(cleanName('')).toBeNull();
    expect(cleanName('Fuck')).toBeNull();
    expect(cleanName(' f_u_c_k ')).toBeNull();
  });

  it('replaces a stored name that is profane', () => {
    expect(loadName(store({ 'bs.name': 'Scheisse' }), () => 0.25)).toBe('Cell2500');
  });
});

describe('ringSpawn', () => {
  const centre = { x: 500, y: 500 };
  const hint = { x: 800, y: 500 };

  it('uses the hub hint first, then the same radius at new angles', () => {
    expect(ringSpawn(centre, hint, 0)).toEqual(hint);
    const angles = new Set<number>();
    for (let life = 1; life < 6; life++) {
      const p = ringSpawn(centre, hint, life);
      expect(Math.hypot(p.x - centre.x, p.y - centre.y)).toBeCloseTo(300, 6);
      angles.add(Math.round(Math.atan2(p.y - centre.y, p.x - centre.x) * 1000));
    }
    expect(angles.size).toBe(5);
  });
});

describe('statusText', () => {
  it('names each state of the chip', () => {
    expect(statusText('online', 3)).toBe('Online · 3 in pond');
    expect(statusText('connecting', 1)).toBe('Connecting…');
    expect(statusText('offline', 1)).toBe('Offline · playing alone');
    expect(statusText('none', 1)).toBe('Offline · playing alone');
    expect(statusText('replaced', 1)).toBe('Signed in elsewhere');
    expect(statusText('outdated', 1)).toBe('Update available, reload');
  });
});
