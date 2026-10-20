import type { Database } from '../../storage/database.ts';
import type { SessionSchedule } from '../../storage/repositories/session-schedule-repository.ts';
import { NeoInputOriginRepository } from '../../storage/repositories/neo-input-origin-repository.ts';
import type { WorkStatus } from '../drivers/types.ts';
import { handoffPromptToMailbox } from '../mailbox/handoff.ts';
import { renderAddress } from '../mailbox/address.ts';
import { invokeOperation } from '../operations/invoke.ts';
import type { OperationRegistry } from '../operations/registry.ts';

export function createScheduleDelivery(db: Database, registry: () => OperationRegistry) {
  const caller = { source: 'internal' as const, role: 'neo' as const };
  const invoke = async (name: string, input: unknown) => {
    const outcome = await invokeOperation(registry(), name, input, caller);
    if (outcome.kind !== 'completed') throw new Error(outcome.message);
    const value = outcome.value as { ok: boolean; value?: { status: WorkStatus }; detail?: string };
    if (!value.ok) throw new Error(value.detail ?? `${name} refused`);
    return value;
  };
  return {
    status: async (ref: SessionSchedule['target']): Promise<WorkStatus> => {
      const result = await invoke('work.status', { ref });
      if (!result.value) throw new Error('work.status returned no work');
      return result.value.status;
    },
    deliver: async (schedule: SessionSchedule, messageId: string, text: string): Promise<void> => {
      const metadata = JSON.stringify({
        scheduleId: schedule.id,
        sourceKind: schedule.sourceKind,
        sourceId: schedule.sourceId,
      });
      const origin = `scheduled_wake:${metadata}`;
      const message = `<daemon-note kind="scheduled_wake">\n${text.replace(/</g, '&lt;')}\n</daemon-note>`;
      const ref = schedule.target;
      if (ref.adapter !== 'hyperneo' || ref.daemon) {
        await invoke('work.send', { ref, message, from: origin });
        return;
      }
      const queue = db.getJobQueueRepo();
      if (
        db.getSDKMessageRepo().findMessageIdByUuid(ref.id, messageId) ||
        queue.listActiveByPayload('mailbox', { 'to.sessionId': ref.id, messageUuid: messageId })
          .length
      )
        return;
      new NeoInputOriginRepository(db.getDatabase()).record(
        { sessionId: ref.id, messageId },
        { sessionId: ref.id, messageId },
        Date.now(),
        origin
      );
      const sent = await handoffPromptToMailbox({
        to: renderAddress({ kind: 'session', sessionId: ref.id }),
        origin,
        messageUuid: messageId,
        message: {
          type: 'user',
          message: { role: 'user', content: message },
          parent_tool_use_id: null,
          inputKind: 'system',
        },
        jobQueue: queue,
      });
      if (sent.kind === 'rejected') throw new Error(sent.reason);
    },
  };
}
