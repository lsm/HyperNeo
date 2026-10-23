import type { Database } from '../../storage/database.ts';
import { NeoPublicationRepository } from '../../storage/repositories/neo-publication-repository.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import {
  type SessionSchedule,
  SessionScheduleRepository,
} from '../../storage/repositories/session-schedule-repository.ts';
import { hyperneoWorkStatus } from '../drivers/hyperneo-adapter.ts';
import type { WorkStatus } from '../drivers/types.ts';
import { renderAddress } from '../mailbox/address.ts';
import { handoffPromptToMailbox } from '../mailbox/handoff.ts';
import { neoDerivedId } from '../neo/derived-id.ts';
import { neoSessionStatus } from '../neo/session-status.ts';
import { invokeOperation } from '../operations/invoke.ts';
import type { OperationRegistry } from '../operations/registry.ts';
import { sessionUnavailable } from '../session-resolution/session-lookup.ts';

export function createScheduleDelivery(
  db: Database,
  registry: () => OperationRegistry,
  notify: () => void = () => {}
) {
  const caller = { source: 'internal' as const, role: 'neo' as const };
  const invoke = async (name: string, input: unknown) => {
    const outcome = await invokeOperation(registry(), name, input, caller);
    if (outcome.kind !== 'completed') throw new Error(outcome.message);
    const value = outcome.value as
      | { ok: true; value: { status?: WorkStatus; unconfirmed?: boolean } }
      | { ok: false; reason: string; detail: string };
    if (!value.ok && value.reason !== 'not_found' && value.reason !== 'not_open')
      throw new Error(value.detail ?? `${name} refused`);
    return value;
  };
  return {
    notifyIdle: (schedule: SessionSchedule): void => {
      const conversationId = new NeoRepository(db.getDatabase()).conversationId();
      if (!conversationId) return;
      const publications = new NeoPublicationRepository(db.getDatabase());
      const publicationId = neoDerivedId(
        `schedule-idle:${schedule.id}:${schedule.factsDigest}:${schedule.lastMessageId}`
      );
      if (publications.get(conversationId, publicationId)) return;
      const name = db.getSession(schedule.target.id)?.title ?? schedule.target.id;
      const elapsed =
        schedule.cadence.kind === 'every'
          ? ` for ${Math.round((schedule.cadence.everyMs * 3) / 60_000)} minutes`
          : '';
      const text = `${name} has been idle${elapsed}, waiting for work.`;
      const receipt = publications.append({
        conversationId,
        publicationId,
        shortText: text,
        fullText: text,
        links: [],
      });
      if (!receipt.accepted) throw new Error(`Idle notice: ${receipt.reason}`);
      if (receipt.created) notify();
    },
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
      return result.value.status;
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
        if (
          !new SessionScheduleRepository(db.getDatabase()).reserveExternalDelivery(
            schedule,
            messageId
          )
        )
          return 'unconfirmed';
        const sent = await invoke('work.send', { ref, message, from: origin });
        if (!sent.ok) return 'target_gone';
        return sent.value.unconfirmed ? 'unconfirmed' : undefined;
      }
      const session = db.getSession(ref.id);
      if (!session || sessionUnavailable(session.status)) return 'target_gone';
      const queue = db.getJobQueueRepo();
      if (
        db.getSDKMessageRepo().findMessageIdByUuid(ref.id, messageId) ||
        queue.listActiveByPayload('mailbox', { 'to.sessionId': ref.id, messageUuid: messageId })
          .length
      )
        return;
      new SessionScheduleRepository(db.getDatabase()).recordWake(
        ref.id,
        messageId,
        { scheduleId: schedule.id, sourceKind: schedule.sourceKind, sourceId: schedule.sourceId },
        Date.now()
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
