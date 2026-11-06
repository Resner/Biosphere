// The card's module worker (M9 T12): the lineage check off the page's thread, so the creature keeps
// moving while drand rounds, signatures and fight replays are checked. The page posts the bundle,
// then each fight's log as it arrives; every message gets the report so far back.

import type { ProofBundle } from '../ledger/proof';
import type { FightLog } from '../ledger/settlement';
import type { LineageReport } from '../ledger/verify';
import { verifyEncounter } from '../net/encounter-verify';
import { LineageCheck } from './check';

export type ToWorker =
  | { t: 'verify'; bundle: ProofBundle }
  | { t: 'fight'; enc: string; log: FightLog | null };

export type FromWorker = { t: 'report'; report: LineageReport; fights: string[] };

let check: LineageCheck | null = null;

const post = (message: FromWorker): void => postMessage(message);

addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  if (msg.t === 'verify') {
    check = new LineageCheck(msg.bundle, verifyEncounter);
    post({ t: 'report', report: check.report, fights: check.fights() });
  } else if (check) {
    post({ t: 'report', report: check.add(msg.enc, msg.log), fights: [] });
  }
});
