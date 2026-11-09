// What the pages' Content-Security-Policy blocked (M14 T16, `tools/csp.mjs`, docs/SECURITY.md).
// Each page's `main.ts` starts the watch before anything else runs; its hook's `state().csp` lists
// what it saw, and the E2E helpers fail a test whose page saw anything.

export interface CspViolation {
  /** The directive that blocked it (`script-src-elem`, `connect-src`, …). */
  directive: string;
  /** What was blocked: a URL, or `inline` or `eval`. */
  blocked: string;
}

/** A page that keeps hitting the policy needs only its first few to be named. */
export const CSP_KEPT = 20;

interface ViolationLike {
  effectiveDirective?: string;
  violatedDirective?: string;
  blockedURI?: string;
}

const seen: CspViolation[] = [];
let watching = false;

/** Starts keeping the violations the document reports; a second call changes nothing. */
export function watchCsp(target: Pick<EventTarget, 'addEventListener'>): void {
  if (watching) return;
  watching = true;
  target.addEventListener('securitypolicyviolation', (event) => {
    if (seen.length >= CSP_KEPT) return;
    const e = event as Event & ViolationLike;
    seen.push({
      directive: e.effectiveDirective || e.violatedDirective || 'unknown',
      blocked: e.blockedURI || 'inline',
    });
  });
}

/** The violations seen so far, oldest first (copies). */
export const cspViolations = (): CspViolation[] => seen.map((v) => ({ ...v }));
