import type { WorkRef } from '../drivers/types.ts';
import { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import { neoDerivedId } from './derived-id.ts';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { sentDuringTurn } from '../../storage/repositories/neo-session-message-repository.ts';
import { renderRemoteAddress } from '../mailbox/address.ts';

type Live = { status: string; waitingFor?: string } | null;
type Observation = { live: Live; baseline: string | null };

export class NeoTurnReportReceipts {
  private readonly receipts: JobQueueRepository;
  private readonly cutoff: number;

  constructor(private readonly db: Database) {
    this.receipts = new JobQueueRepository(db);
    this.cutoff = this.receipts.commitSubmissionReceipt(
      'neo-turn-report:v2:cutoff',
      'v2',
      Date.now
    );
  }

  async observe(
    todoId: string,
    dispatchId: string,
    ref: WorkRef,
    live: Live,
    turn: { id: string; at: number; startedAt?: number; message: string },
    recipient: string
  ) {
    const scope = [todoId, dispatchId, ref.adapter, ref.id, ref.daemon ?? null];
    const hash = neoDerivedId(turn.message);
    const key = neoDerivedId(JSON.stringify(['neo-turn-observed-v2', ...scope, turn.id]));
    const observation =
      this.receipts.submissionReceipt<Observation>(key, 'v2') ??
      this.receipts.commitSubmissionReceipt<Observation>(key, 'v2', () => ({
        live,
        baseline: turn.at <= this.cutoff ? hash : null,
      }));
    const previousId = neoDerivedId(
      JSON.stringify(['neo-turn-delivery-v2', ...scope, observation.live?.status ?? null, hash])
    );
    const messageId = neoDerivedId(
      JSON.stringify([
        'neo-turn-delivery-v3',
        recipient,
        ref.adapter,
        ref.id,
        ref.daemon ?? null,
        turn.id,
        observation.live?.status ?? null,
        hash,
      ])
    );
    if (observation.baseline === hash) this.acknowledge(messageId);
    if (this.receipts.submissionReceipt<boolean>(previousId, 'v2')) this.acknowledge(messageId);
    const sender = ref.daemon
      ? renderRemoteAddress({ kind: 'remote-session', daemonId: ref.daemon, sessionId: ref.id })
      : ref.adapter === 'hyperneo'
        ? ref.id
        : `${ref.adapter}:${ref.id}`;
    if (
      turn.startedAt !== undefined &&
      (await gatewayFor(this.db).call(sentDuringTurn, 'sentDuringTurn', {
        sender,
        recipient,
        from: turn.startedAt,
        to: turn.at,
      }))
    )
      this.acknowledge(messageId);
    return {
      live: observation.live,
      messageId,
      skip: this.receipts.submissionReceipt<boolean>(messageId, 'v2') === true,
    };
  }

  acknowledge(messageId: string) {
    if (!this.receipts.submissionReceipt<boolean>(messageId, 'v2'))
      this.receipts.commitSubmissionReceipt(messageId, 'v2', () => true);
  }
}
