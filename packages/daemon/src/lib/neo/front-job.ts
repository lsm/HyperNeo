import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { DbGateway } from '../../storage/db-gateway/db-gateway.ts';
import { neoFrontInputWrites } from '../../storage/repositories/neo-front-input-worker.ts';
import type { Job } from '../../storage/repositories/job-queue-repository.ts';

const Receipt = z
  .object({ conversationId: z.string().min(1), messageId: z.string().min(1) })
  .strict();

export function createFakeNeoFrontHandler(db: DbGateway) {
  return (superpipe({})('neo-front-fake') as PipelineAPI)
    .input('job')
    .pipe((job: Job) => Receipt.parse(job.payload), 'job', 'receipt')
    .pipe(
      ({ conversationId, messageId }: z.infer<typeof Receipt>) =>
        db.call(neoFrontInputWrites, 'claim', conversationId, [messageId], 'neo'),
      'receipt',
      'handedOff'
    )
    .pipe((handedOff: boolean) => ({ handedOff }), 'handedOff', 'result')
    .endAsync('result') as (job: Job) => Promise<{ handedOff: boolean }>;
}
