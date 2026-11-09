import { describe, expect, it } from 'vitest';
import {
  type Capabilities,
  type CapabilityWindow,
  capabilities,
  NOTES,
  PLAIN_WORDS,
  playLimits,
  unsupportedReason,
} from './capability';

const ALL: Capabilities = { webgl2: true, rtc: true, idb: true, ws: true, moduleWorker: true };

/** A browser that reads a worker's `type` (module workers) or ignores it (classic only). */
function fakeWorker(reads: boolean, started: { n: number }) {
  return class {
    constructor(url: string, options?: { type?: string }) {
      if (reads) void options?.type;
      // The real constructor throws on a URL that can't parse, after converting its options.
      if (url.startsWith('http://[')) throw new SyntaxError('bad URL');
      started.n++;
    }
    terminate(): void {}
  };
}

interface Fake {
  webgl2?: boolean | 'throws';
  rtc?: boolean;
  idb?: boolean | 'throws';
  ws?: boolean;
  worker?: 'module' | 'classic' | 'none';
}

function fakeWindow(f: Fake = {}, started = { n: 0 }, lost = { n: 0 }): CapabilityWindow {
  const gl = {
    getExtension: (name: string) =>
      name === 'WEBGL_lose_context' ? { loseContext: () => lost.n++ } : null,
  };
  const win = {
    document: {
      createElement: () => ({
        getContext: (kind: string) => {
          if (f.webgl2 === 'throws') throw new Error('no GL');
          return kind === 'webgl2' && f.webgl2 !== false ? gl : null;
        },
      }),
    },
    RTCPeerConnection: f.rtc === false ? undefined : class {},
    WebSocket: f.ws === false ? undefined : class {},
    Worker:
      f.worker === 'none' ? undefined : fakeWorker((f.worker ?? 'module') === 'module', started),
  } as Record<string, unknown>;
  Object.defineProperty(win, 'indexedDB', {
    get() {
      if (f.idb === 'throws') throw new DOMException('denied', 'SecurityError');
      return f.idb === false ? undefined : {};
    },
  });
  return win as unknown as CapabilityWindow;
}

describe('capabilities', () => {
  it('finds everything a current browser has', () => {
    expect(capabilities(fakeWindow())).toEqual(ALL);
  });

  it('names each missing capability on its own', () => {
    expect(capabilities(fakeWindow({ webgl2: false }))).toEqual({ ...ALL, webgl2: false });
    expect(capabilities(fakeWindow({ rtc: false }))).toEqual({ ...ALL, rtc: false });
    expect(capabilities(fakeWindow({ idb: false }))).toEqual({ ...ALL, idb: false });
    expect(capabilities(fakeWindow({ ws: false }))).toEqual({ ...ALL, ws: false });
    expect(capabilities(fakeWindow({ worker: 'classic' }))).toEqual({
      ...ALL,
      moduleWorker: false,
    });
    expect(capabilities(fakeWindow({ worker: 'none' }))).toEqual({ ...ALL, moduleWorker: false });
  });

  it('counts a check that throws as missing (a private window, a blocked GPU)', () => {
    expect(capabilities(fakeWindow({ idb: 'throws', webgl2: 'throws' }))).toEqual({
      ...ALL,
      idb: false,
      webgl2: false,
    });
  });

  it('starts no worker and gives back the WebGL2 context it took', () => {
    const started = { n: 0 };
    const lost = { n: 0 };
    capabilities(fakeWindow({}, started, lost));
    expect(started.n).toBe(0);
    expect(lost.n).toBe(1);
  });
});

describe('unsupportedReason', () => {
  it('runs every page with everything', () => {
    for (const page of ['game', 'lab', 'card'] as const) {
      expect(unsupportedReason(ALL, page)).toBeNull();
    }
  });

  it('shows the plain page without WebGL2, except the card, which draws its flat preview', () => {
    const caps = { ...ALL, webgl2: false };
    expect(unsupportedReason(caps, 'game')).toBe('webgl2');
    expect(unsupportedReason(caps, 'lab')).toBe('webgl2');
    expect(unsupportedReason(caps, 'card')).toBeNull();
  });

  it('shows the plain page on every page without module workers, WebGL2 first', () => {
    const caps = { ...ALL, moduleWorker: false };
    expect(unsupportedReason(caps, 'game')).toBe('module-worker');
    expect(unsupportedReason(caps, 'card')).toBe('module-worker');
    expect(unsupportedReason({ ...caps, webgl2: false }, 'game')).toBe('webgl2');
  });

  it('never sends a page to the plain page for what the game plays without', () => {
    const caps = { ...ALL, ws: false, idb: false, rtc: false };
    expect(unsupportedReason(caps, 'game')).toBeNull();
  });

  it('says what WebGL2 needs: the browsers and hardware acceleration', () => {
    const { title, lines } = PLAIN_WORDS.webgl2;
    expect(title).toBe('Biosphere needs WebGL2');
    const text = lines.join(' ');
    for (const browser of ['Chrome', 'Edge', 'Firefox', 'Safari']) expect(text).toContain(browser);
    expect(text).toMatch(/hardware acceleration/);
  });
});

describe('playLimits', () => {
  it('plays everything with everything, and says nothing', () => {
    expect(playLimits(ALL, true)).toEqual({ online: true, links: true, note: null });
  });

  it('plays practice cells offline without WebSocket, saying why', () => {
    expect(playLimits({ ...ALL, ws: false }, true)).toEqual({
      online: false,
      links: false,
      note: NOTES.ws,
    });
  });

  it('plays practice cells without IndexedDB, saying creatures cannot be recorded', () => {
    const limits = playLimits({ ...ALL, idb: false }, true);
    expect(limits).toEqual({ online: false, links: false, note: NOTES.idb });
    expect(limits.note).toMatch(/can't be recorded in this window/);
  });

  it('plays recorded creatures alone without RTCPeerConnection, saying others cannot be seen', () => {
    const limits = playLimits({ ...ALL, rtc: false }, true);
    expect(limits).toEqual({ online: true, links: false, note: NOTES.rtc });
    expect(limits.note).toMatch(/Others can't be seen in this browser/);
  });

  it('names the most limiting gap when several are missing', () => {
    expect(playLimits({ ...ALL, ws: false, idb: false, rtc: false }, true).note).toBe(NOTES.ws);
    expect(playLimits({ ...ALL, idb: false, rtc: false }, true).note).toBe(NOTES.idb);
  });

  it('needs no line without an authority to reach', () => {
    expect(playLimits({ ...ALL, ws: false }, false).note).toBeNull();
    expect(playLimits({ ...ALL, rtc: false }, false).note).toBeNull();
  });

  it('keeps each line to one short sentence or two', () => {
    for (const note of Object.values(NOTES)) expect(note.length).toBeLessThanOrEqual(80);
  });
});
