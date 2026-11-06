// The page's audit worker (M10 T8, ADR 0058): an auditor duty's selection check (a drand beacon) and
// its verdict (a fight's replay, or a genesis or a mating recomputed) run here, never on the frame
// loop. Each job gets its reply, by id.

import { type AuditJob, auditJob } from '../net/audit';

addEventListener('message', (event: MessageEvent<AuditJob>) => {
  postMessage(auditJob(event.data));
});
