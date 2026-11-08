import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain .mjs module with no declarations
import { withInspectorPort } from './worker-args.mjs';

// A dozen `wrangler dev` hubs start at once in the E2E run. Wrangler picks each one's inspector port
// by probing from 9229 and binds it later, so two hubs can take the same port and one dies with
// "Address already in use (socket direct:1:default)". Every dev hub gets a port of its own instead.
describe('withInspectorPort', () => {
  it('derives a distinct inspector port from the hub port', () => {
    const a = withInspectorPort('dev', ['--port', '8787', '--persist-to', 'x']);
    const b = withInspectorPort('dev', ['--port', '8788']);
    const at = (args: string[]) => args[args.indexOf('--inspector-port') + 1];
    expect(at(a)).toBe('9787');
    expect(at(b)).toBe('9788');
    expect(a.slice(0, 4)).toEqual(['--port', '8787', '--persist-to', 'x']);
  });

  it('leaves an explicit inspector port, a hub with no port and other commands alone', () => {
    const own = ['--port', '8787', '--inspector-port', '9000'];
    expect(withInspectorPort('dev', own)).toEqual(own);
    expect(withInspectorPort('dev', ['--var', 'A:1'])).toEqual(['--var', 'A:1']);
    expect(withInspectorPort('deploy', ['--port', '8787'])).toEqual(['--port', '8787']);
  });

  it('keeps every hub of the E2E config on its own inspector port', () => {
    const ports = Array.from({ length: 64 }, (_, i) => 8787 + i);
    const used = ports.map((p) => withInspectorPort('dev', ['--port', String(p)])[3]);
    expect(new Set(used).size).toBe(ports.length);
    for (const u of used) expect(Number(u)).toBeLessThan(65536);
  });
});
