import { sessionUnavailable } from '../session-resolution/session-lookup.ts';
import type { Database } from '../../storage/database.ts';
import {
  SessionScheduleRepository,
  type SessionSchedule,
} from '../../storage/repositories/session-schedule-repository.ts';
import type { z } from 'zod';
import type {
  WorkInputEvidenceSchema,
  WorkInputReceiptSchema,
  WorkStatus,
  WorkTurnQuestion,
} from '../drivers/types.ts';
import { createMailboxEntry } from '../mailbox/entry.ts';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { enqueueMailboxAdmission } from '../../storage/repositories/mailbox-admission-write.ts';
import { invokeOperation } from '../operations/invoke.ts';
import type { OperationRegistry } from '../operations/registry.ts';
import { hyperneoWorkStatus } from '../drivers/hyperneo-adapter.ts';
import { neoSessionStatus } from '../neo/session-status.ts';

type WorkInputReceipt = z.infer<typeof WorkInputReceiptSchema>;
type WorkInputEvidence = z.infer<typeof WorkInputEvidenceSchema>;

const accepted = (evidence: WorkInputEvidence | undefined, receipt: WorkInputReceipt) =>
  evidence?.receipt.executionId === receipt.executionId &&
  evidence.receipt.inputId === receipt.inputId &&
  (evidence.state === 'observed' || evidence.transcriptState === 'accepted');

export function createScheduleDelivery(db: Database, registry: () => OperationRegistry) {
  const caller = { source: 'internal' as const, role: 'neo' as const };
  const call = async (name: string, input: unknown) => {
    const outcome = await invokeOperation(registry(), name, input, caller);
    if (outcome.kind !== 'completed') throw new Error(outcome.message);
    const value = outcome.value as
      | {
          ok: true;
          value: {
            status?: WorkStatus;
            inputId?: string;
            unconfirmed?: boolean;
            receipt?: WorkInputReceipt;
            inputEvidence?: WorkInputEvidence;
            turnQuestion?: WorkTurnQuestion;
          };
        }
      | { ok: false; reason: string; detail: string; notSent?: true };
    return value;
  };
  const refused = (name: string, value: { reason: string; detail: string }) =>
    value.reason !== 'not_found' && value.reason !== 'not_open'
      ? new Error(value.detail ?? `${name} refused`)
      : null;
  const invoke = async (name: string, input: unknown) => {
    const value = await call(name, input);
    const error = value.ok ? null : refused(name, value);
    if (error) throw error;
    return value;
  };
  return {
    status: async (
      ref: SessionSchedule['target']
    ): Promise<WorkStatus | 'not_found' | 'not_open'> => {
      if (ref.adapter === 'hyperneo' && !ref.daemon && ref.id.startsWith('neo:')) {
        const session = db.getSession(ref.id);
        if (!session) return 'not_found';
        if (sessionUnavailable(session.status)) return 'not_open';
        return hyperneoWorkStatus(session.status, neoSessionStatus(session.processingState));
      }
      const result = await invoke('work.status', { ref });
      if (!result.ok) return result.reason === 'not_found' ? 'not_found' : 'not_open';
      if (!result.value?.status) throw new Error('work.status returned no work');
      if (result.value.status === 'stopped' && ref.adapter === 'hyperneo' && !ref.daemon) {
        const session = db.getSession(ref.id);
        if (!session) return 'not_found';
        if (sessionUnavailable(session.status)) return 'not_open';
      }
      return result.value.status === 'needs_you' && result.value.turnQuestion
        ? 'done'
        : result.value.status;
    },
    deliver: async (
      schedule: SessionSchedule,
      messageId: string,
      text: string
    ): Promise<void | 'target_gone' | 'unconfirmed'> => {
      const metadata = JSON.stringify({
        scheduleId: schedule.id,
        sourceKind: schedule.sourceKind,
        sourceId: schedule.sourceId,
      });
      const origin = `scheduled_wake:${metadata}`;
      const message = `<daemon-note kind="scheduled_wake">\n${text.replace(/</g, '&lt;')}\n</daemon-note>`;
      const ref = schedule.target;
      if (ref.adapter !== 'hyperneo' || ref.daemon) {
        const repo = new SessionScheduleRepository(db.getDatabase());
        if (!repo.reserveExternalDelivery(schedule, messageId)) {
          const receipt = repo.deliveryReceipt(schedule.id, messageId) as WorkInputReceipt | null;
          if (!receipt) return 'unconfirmed';
          const read = await invoke('work.status', { ref, receipt });
          return read.ok && accepted(read.value.inputEvidence, receipt) ? undefined : 'unconfirmed';
        }
        const sent = await call('work.send', { ref, message, from: origin, notice: true });
        if (!sent.ok) {
          const error = refused('work.send', sent);
          if (!error) return 'target_gone';
          if (sent.notSent) repo.releaseExternalDelivery(schedule, messageId);
          throw error;
        }
        if (!sent.value.unconfirmed) return undefined;
        if (sent.value.receipt)
          repo.saveDeliveryReceipt(schedule.id, messageId, sent.value.receipt);
        return 'unconfirmed';
      }
      const sent = await gatewayFor(db.getDatabase()).call(
        enqueueMailboxAdmission,
        'enqueueScheduled',
        createMailboxEntry({
          to: { kind: 'session', sessionId: ref.id },
          origin,
          messageUuid: messageId,
          message: {
            type: 'user',
            message: { role: 'user', content: message },
            parent_tool_use_id: null,
            inputKind: 'system',
            neoWakeEvent: true,
          },
        }),
        { scheduleId: schedule.id, sourceKind: schedule.sourceKind, sourceId: schedule.sourceId }
      );
      if (sent === 'target_gone') return sent;
    },
  };
}
