import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/sqlite-compat.ts';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { jobQueueWrites, type Job } from '../../storage/repositories/job-queue-repository.ts';
import type { DeliveryContent, DeliveryLoadResult } from '../agent/message-delivery.ts';
import { getDataDir } from '../data-dir.ts';
import { publishTextHandoff } from './publish-text.ts';
import {
  NeoSessionMessageRepository,
  WORKER_BATCH_SENDER,
} from '../../storage/repositories/neo-session-message-repository.ts';

export const boundDeliveryContent = (superpipe({})('bound-batch-delivery') as PipelineAPI)
  .input(['db', 'job', 'loaded'])
  .pipe(
    async (db: Database, job: Job, loaded: DeliveryLoadResult) => {
      if (!loaded.neoBatch) return loaded;
      const text = JSON.stringify(loaded.content);
      if (Buffer.byteLength(text) <= 64 * 1024) return loaded;
      if (job.payload.contentSnapshot)
        return { ...loaded, content: job.payload.contentSnapshot as DeliveryContent };
      const reference = await publishTextHandoff(getDataDir(), String(job.payload.sessionId), text);
      const content = [
        {
          type: 'text' as const,
          text: 'Complete ordered worker batch attached. Read all bytes with handoff.read before acting; no messages were dropped.',
        },
        { type: 'text' as const, text: JSON.stringify({ handoffFiles: [reference] }) },
      ];
      return {
        ...loaded,
        content: (await gatewayFor(db).call(
          jobQueueWrites,
          'snapshotPayload',
          job.id,
          'contentSnapshot',
          content
        )) as DeliveryContent,
      };
    },
    ['db', 'job', 'loaded'],
    'loaded'
  )
  .pipe(
    async (db: Database, job: Job, loaded: DeliveryLoadResult) => {
      if (!loaded.neoWorkerBatch) return loaded;
      const sessionId = String(job.payload.sessionId);
      const content = loaded.content;
      await new NeoSessionMessageRepository(db).record({
        messageId: String(job.payload.messageUuid),
        conversationId: sessionId.slice(4),
        fromSession: WORKER_BATCH_SENDER,
        fromName: 'System-forwarded worker messages',
        toSession: sessionId,
        toName: 'Neo',
        text:
          typeof content === 'string'
            ? content
            : content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n\n'),
        createdAt: new Date(job.createdAt).toISOString(),
        kind: 'worker-batch',
      });
      return loaded;
    },
    ['db', 'job', 'loaded'],
    'loaded'
  )
  .endAsync('loaded') as (
  db: Database,
  job: Job,
  loaded: DeliveryLoadResult
) => Promise<DeliveryLoadResult>;
