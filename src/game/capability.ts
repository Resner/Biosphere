// What the browser offers the game (M14 T6), checked once on load. Without WebGL2 or module workers
// a page can't run, so it shows a plain page that says what to do; without WebSocket, IndexedDB or
// RTCPeerConnection the game still plays, with less, and a line on the title says why.

export interface Capabilities {
  webgl2: boolean;
  rtc: boolean;
  idb: boolean;
  ws: boolean;
  moduleWorker: boolean;
}

/** Why a page shows the plain page instead of itself. */
export type Unsupported = 'webgl2' | 'module-worker';

/** The pages, each with what it can't do without: the card draws a flat preview without WebGL2. */
export type PageKind = 'game' | 'lab' | 'card';

/** The parts of `window` the checks read; a fake window in the tests gives just these. */
export type CapabilityWindow = Pick<
  typeof globalThis,
  'Worker' | 'RTCPeerConnection' | 'indexedDB' | 'WebSocket'
> & { document: Pick<Document, 'createElement'> };

/** A capability check never throws: a browser that throws on asking hasn't got it. */
function safely(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

/**
 * A module worker is asked for without starting one: the options' `type` is read while the
 * constructor's arguments are converted, before the URL (which can't parse) throws. A browser
 * without module workers never reads it.
 */
function moduleWorker(win: CapabilityWindow): boolean {
  if (typeof win.Worker !== 'function') return false;
  let read = false;
  const options = {
    get type(): 'module' {
      read = true;
      return 'module';
    },
  };
  try {
    new win.Worker('http://[', options).terminate();
  } catch {
    // The URL never parses; the read is all this asks.
  }
  return read;
}

/** A WebGL2 context on a canvas of its own, given back at once. */
function webgl2(win: CapabilityWindow): boolean {
  const canvas = win.document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  if (!gl) return false;
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return true;
}

export function capabilities(win: CapabilityWindow): Capabilities {
  return {
    webgl2: safely(() => webgl2(win)),
    rtc: safely(() => typeof win.RTCPeerConnection === 'function'),
    // Some private windows have no IndexedDB, or throw on reaching it.
    idb: safely(() => win.indexedDB != null),
    ws: safely(() => typeof win.WebSocket === 'function'),
    moduleWorker: safely(() => moduleWorker(win)),
  };
}

/** The plain page's reason for this page, or null when it runs. */
export function unsupportedReason(caps: Capabilities, page: PageKind): Unsupported | null {
  if (!caps.webgl2 && page !== 'card') return 'webgl2';
  if (!caps.moduleWorker) return 'module-worker';
  return null;
}

/** How the game plays with what the browser has. */
export interface PlayLimits {
  /** It reaches the authority: without WebSocket or IndexedDB it plays practice cells offline. */
  online: boolean;
  /** It links to other players over WebRTC. */
  links: boolean;
  /** The title's line saying why it plays with less, or null with nothing missing. */
  note: string | null;
}

export const NOTES = {
  ws: "This browser can't reach the world, so you swim practice cells offline.",
  idb: "Creatures can't be recorded in this window, so you swim practice cells.",
  rtc: "Others can't be seen in this browser. Your creatures are still recorded.",
} as const;

/**
 * The game's limits. `hub` says whether the page has an authority to reach at all: without one it
 * plays offline anyway, and no line is needed.
 */
export function playLimits(caps: Capabilities, hub: boolean): PlayLimits {
  if (!caps.ws) return { online: false, links: false, note: hub ? NOTES.ws : null };
  if (!caps.idb) return { online: false, links: false, note: hub ? NOTES.idb : null };
  if (!caps.rtc) return { online: true, links: false, note: hub ? NOTES.rtc : null };
  return { online: true, links: true, note: null };
}

/** The plain page's words: a heading and what to do. */
export const PLAIN_WORDS: Record<Unsupported, { title: string; lines: readonly string[] }> = {
  webgl2: {
    title: 'Biosphere needs WebGL2',
    lines: [
      'WebGL2 draws the water and its creatures. The latest Chrome, Edge, Firefox and Safari all have it.',
      "If yours is one of these, hardware acceleration may be off: turn it on in the browser's settings, then reload.",
    ],
  },
  'module-worker': {
    title: 'Biosphere needs a newer browser',
    lines: ['Update to the latest Chrome, Edge, Firefox or Safari, then reload.'],
  },
};

/** Replaces the page with the plain page: no canvas, only words. */
export function showUnsupported(doc: Document, reason: Unsupported): void {
  const words = PLAIN_WORDS[reason];
  const main = doc.createElement('main');
  main.className = 'unsupported';
  main.dataset.testid = 'unsupported';
  main.dataset.reason = reason;
  const title = doc.createElement('h1');
  title.textContent = words.title;
  main.append(title);
  for (const line of words.lines) {
    const p = doc.createElement('p');
    p.textContent = line;
    main.append(p);
  }
  doc.body.replaceChildren(main);
  doc.body.dataset.screen = 'unsupported';
  doc.title = `${words.title} · Biosphere`;
}
