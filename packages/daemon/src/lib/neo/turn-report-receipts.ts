import type { NeoTurnReportFacts } from './turn-report-plan.ts';
import type { WorkRef } from '../drivers/types.ts';
import { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import { neoDerivedId } from './derived-id.ts';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { sentDuringTurn } from '../../storage/repositories/neo-session-message-repository.ts';
import { qualifyRemoteOrigin, renderAddress } from '../mailbox/address.ts';

type Live = { status: string; waitingFor?: string; turnQuestion?: unknown } | null;
type Observation = { live: Live; facts?: NeoTurnReportFacts; focused?: boolean };

export class NeoTurnReportReceipts {
  private readonly receipts: JobQueueRepository;

  constructor(private readonly db: Database) {
    this.receipts = new JobQueueRepository(db);
  }

  async observe(
    todoId: string,
    dispatchId: string,
    ref: WorkRef,
    live: Live,
    turn: {
      id: string;
      at: number;
      startedAt?: number;
      senderMachine?: string;
      humanInput?: string;
    },
    recipient: string,
    focused: boolean,
    facts?: NeoTurnReportFacts
  ) {
    const observation = this.receipts.commitSubmissionReceipt<Observation>(
      neoDerivedId(
        JSON.stringify([
          'neo-turn-observed-v2',
          todoId,
          dispatchId,
          ref.adapter,
          ref.id,
          ref.daemon ?? null,
          turn.id,
        ])
      ),
      'v2',
      () => ({ live, facts, focused })
    );
    const localSender = ref.adapter === 'hyperneo' ? ref.id : `${ref.adapter}:${ref.id}`;
    const sender = ref.daemon
      ? qualifyRemoteOrigin(
          renderAddress({ kind: 'session', sessionId: localSender }),
          turn.senderMachine ?? ref.daemon
        )
      : localSender;
    const sent =
      turn.humanInput === undefined &&
      turn.startedAt !== undefined &&
      (await gatewayFor(this.db).call(sentDuringTurn, 'sentDuringTurn', {
        sender,
        recipient,
        from: turn.startedAt,
        to: turn.at,
      }));
    return {
      live: observation.live,
      facts: observation.facts,
      focused: observation.focused ?? focused,
      sent,
    };
  }
}
