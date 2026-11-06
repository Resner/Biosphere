import { expect, it } from 'vitest';
import { useFightHub } from './fight-test-kit';
import { history } from './history-kit';
import { sql } from './test-hub';

useFightHub();

// The history's fight puts B at 1 hp where `NEAR` has no pressure or UV only in the pond seeded
// `timeout`; a random pond seed killed B by pressure in about 1 run in 100.
it('is made in the calm pond, never one with a random seed', async () => {
  const { enc } = await history();
  const [row] = await sql<{ settlement: string }>(
    'SELECT settlement FROM encounters WHERE id = ?',
    enc,
  );
  expect(JSON.parse(row?.settlement ?? '{}').settlement.pondSeed).toBe('timeout');
});
