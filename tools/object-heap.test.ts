import { describe, expect, it } from 'vitest';
import { listeningPorts, userTarget } from './object-heap';

// The soak reads the authority object's own heap from workerd's inspector (M14 T14c): the process's
// resident memory also holds wrangler's proxy and V8's uncollected garbage, so it is no measure of
// what the hub keeps.

const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:9437 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 111 1 0000000000000000 100 0 0 10 0
   1: 0100007F:B171 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 222 1 0000000000000000 100 0 0 10 0
   2: 0100007F:2293 0100007F:C350 01 00000000:00000000 00:00000000 00000000     0        0 333 1 0000000000000000 20 4 30 10 -1
   3: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 444 1 0000000000000000 100 0 0 10 0
`;

describe('the object heap reader', () => {
  it("finds the ports a process listens on from /proc's table and its sockets", () => {
    expect(listeningPorts(TCP, new Set(['111', '222', '333']))).toEqual([0x9437, 0xb171]);
    expect(listeningPorts(TCP, new Set())).toEqual([]);
    expect(listeningPorts('garbage', new Set(['111']))).toEqual([]);
  });

  it("picks the user worker's target from the inspector's list", () => {
    const list = [
      { id: 'core:internal:proxy', webSocketDebuggerUrl: 'ws://127.0.0.1:1/a' },
      { id: 'core:user:biosphere-authority-e2e', webSocketDebuggerUrl: 'ws://127.0.0.1:1/b' },
    ];
    expect(userTarget(list)).toBe('ws://127.0.0.1:1/b');
    expect(userTarget([list[0]])).toBeNull();
    expect(userTarget({ error: 'not-found' })).toBeNull();
    expect(userTarget(null)).toBeNull();
  });
});
