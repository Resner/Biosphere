import { describe, expect, it } from 'vitest';
import { CSP_KEPT, cspViolations, watchCsp } from './csp-watch';

const violation = (fields: Record<string, string>): Event =>
  Object.assign(new Event('securitypolicyviolation'), fields);

describe('watchCsp', () => {
  it('keeps each violation the target reports, by directive and what was blocked', () => {
    const target = new EventTarget();
    watchCsp(target);
    // A second watch adds no second listener.
    watchCsp(target);
    target.dispatchEvent(
      violation({ effectiveDirective: 'connect-src', blockedURI: 'https://evil.example/x' }),
    );
    target.dispatchEvent(violation({ violatedDirective: 'script-src-elem', blockedURI: '' }));
    expect(cspViolations()).toEqual([
      { directive: 'connect-src', blocked: 'https://evil.example/x' },
      { directive: 'script-src-elem', blocked: 'inline' },
    ]);
    // Copies: a caller's change stays its own.
    const got = cspViolations();
    (got[0] as { directive: string }).directive = 'x';
    expect(cspViolations()[0]?.directive).toBe('connect-src');
    for (let i = 0; i < CSP_KEPT * 2; i++) target.dispatchEvent(violation({}));
    expect(cspViolations()).toHaveLength(CSP_KEPT);
    expect(cspViolations().at(-1)).toEqual({ directive: 'unknown', blocked: 'inline' });
  });
});
