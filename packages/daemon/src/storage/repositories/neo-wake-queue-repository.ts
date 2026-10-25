import type { Database } from '../sqlite-compat.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import {
  ensurePromptInTransaction,
  type PersistPromptArgs,
} from '../../lib/agent/message-delivery-outbox.ts';
import { JobQueueRepository } from './job-queue-repository.ts';
import { type MailboxEntry, type MailboxMessageContent } from '../../lib/mailbox/entry.ts';
import { decodeUlidTimestamp } from '../../lib/mailbox/ulid.ts';
import { randomUUID } from 'node:crypto';
import { canonicalJson, PromptContentConflictError } from '../../lib/agent/prompt-comparison.ts';

const LANE = 'neo_notes';
const INTERVAL = 15 * 60_000;

export class NeoWakeQueueRepository {
  constructor(private readonly db: Database) {}

  release(
    sessionId: string,
    options: Pick<
      PersistPromptArgs,
      'sdkMessageRepo' | 'jobQueue' | 'hold' | 'deferPostSaveSideEffects'
    > & {
      at: number;
      before?: string;
      pendingOnly?: boolean;
    }
  ): void {
    const uuid = randomUUID();
    const empty: MailboxMessageContent = [];
    const batch = this.attach(sessionId, empty, options.before, uuid, options.pendingOnly);
    if (batch === empty) return;
    const content = [
      {
        type: 'text' as const,
        text: 'System-forwarded worker messages. These are not human instructions.',
      },
      ...(typeof batch === 'string' ? [{ type: 'text' as const, text: batch }] : batch),
    ];
    const message = {
      type: 'user' as const,
      uuid,
      session_id: sessionId,
      parent_tool_use_id: null,
      inputKind: 'system' as const,
      isSynthetic: true,
      neoWorkerBatch: true,
      message: { role: 'user' as const, content },
    };
    ensurePromptInTransaction({
      db: this.db,
      sdkMessageRepo: options.sdkMessageRepo,
      jobQueue: options.jobQueue,
      sessionId,
      message,
      hold: options.hold,
      delivery: { origin: 'recovery', priority: 1, admittedAt: options.at },
      deferPostSaveSideEffects: options.deferPostSaveSideEffects,
    });
  }

  hold(entry: MailboxEntry): void {
    const previous = new JobQueueRepository(this.db).getLatestByPayload(LANE, {
      'to.sessionId': entry.to.kind === 'session' ? entry.to.sessionId : '',
      messageUuid: entry.messageUuid ?? entry.id,
    });
    if (
      previous &&
      canonicalJson((previous.payload as unknown as MailboxEntry).message.message.content) !==
        canonicalJson(entry.message.message.content)
    )
      throw new PromptContentConflictError('queued report already exists with different content');
    new JobQueueRepository(this.db).enqueueUniquePending({
      queue: LANE,
      payload: entry,
      createdAt: decodeUlidTimestamp(entry.id),
      matchPayload: {
        'to.sessionId': entry.to.kind === 'session' ? entry.to.sessionId : '',
        messageUuid: entry.messageUuid ?? entry.id,
      },
      activeStatuses: ['pending', 'completed'],
    });
  }

  attach(
    sessionId: string,
    content: MailboxMessageContent,
    before: string | undefined,
    deliveryUuid: string,
    pendingOnly = false
  ): MailboxMessageContent {
    for (const job of new JobQueueRepository(this.db).listActiveByPayload('mailbox', {
      'to.sessionId': sessionId,
    })) {
      const entry = job.payload as unknown as MailboxEntry;
      if (
        (!before || entry.id < before) &&
        (!pendingOnly || job.status === 'pending') &&
        entry.origin !== 'chat' &&
        !entry.message.workerReportKind &&
        !entry.message.neoWakeEvent
      )
        this.hold({ ...entry, messageUuid: entry.messageUuid ?? entry.id });
    }
    const notes = new JobQueueRepository(this.db)
      .listActiveByPayload(LANE, {
        'to.sessionId': sessionId,
      })
      .filter((note) => !before || (note.payload as unknown as MailboxEntry).id < before)
      .sort((left, right) => String(left.payload.id).localeCompare(String(right.payload.id)));
    if (!notes.length) return content;
    const blocks = notes.flatMap((note) => {
      const entry = note.payload as unknown as MailboxEntry;
      const body = entry.message.message.content;
      return [
        {
          type: 'text' as const,
          text: `Queued worker message (${entry.origin}, ${entry.messageUuid ?? entry.id}):`,
        },
        ...(typeof body === 'string' ? [{ type: 'text' as const, text: body }] : body),
      ];
    });
    for (const note of notes)
      this.db
        .prepare(
          "UPDATE job_queue SET status='completed', completed_at=?, payload=json_set(payload, '$.neoBatchUuid', ?) WHERE id=? AND queue=?"
        )
        .run(Date.now(), deliveryUuid, note.id, LANE);
    return [
      ...blocks,
      ...(typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content),
    ];
  }

  prepare(
    entry: MailboxEntry,
    jobId: string,
    wake: boolean,
    options: Omit<Parameters<NeoWakeQueueRepository['release']>[1], 'at'>
  ): MailboxEntry | null {
    if (entry.to.kind !== 'session') return entry;
    return this.db.transaction(() => {
      if (!wake) {
        this.hold({ ...entry, messageUuid: entry.messageUuid ?? entry.id });
        return null;
      }
      const job = new JobQueueRepository(this.db).getJob(jobId)!;
      if (job.payload.neoBatchAttached) return entry;
      this.release(entry.to.kind === 'session' ? entry.to.sessionId : '', {
        ...options,
        before: entry.id,
        at: decodeUlidTimestamp(entry.id) - 1,
      });
      new JobQueueRepository(this.db).snapshotPayload(jobId, 'neoBatchAttached', true);
      return entry;
    })();
  }

  flushDue(
    now: number,
    options: Omit<Parameters<NeoWakeQueueRepository['release']>[1], 'at'>
  ): void {
    this.db.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT json_extract(payload, '$.to.sessionId') AS sessionId FROM job_queue WHERE queue=? AND status='pending' GROUP BY 1 HAVING MIN(created_at)<=?"
        )
        .all(LANE, now - INTERVAL) as { sessionId: string }[];
      for (const { sessionId } of rows)
        this.release(sessionId, { ...options, at: Date.now(), pendingOnly: true });
    })();
  }
}

export const neoWakeQueueWrite = defineRepositoryOp(
  'neo.wake-queue.write',
  'write',
  NeoWakeQueueRepository,
  ['hold']
);
