import { NEO_WORK_RETURN_REVIEW } from '@hyperneo/prompts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoService } from './service.ts';
import { neoWorkReviewId } from './ask-origin.ts';

export const returnWorkThroughHolder = (superpipe({})('neo-work-holder-return') as PipelineAPI)
  .input(['service', 'work', 'rootId'])
  .pipe(
    (service: NeoService, work: NeoWork, rootId: string) => {
      const retries = service.driverTargets.readRetries(work.id);
      const id = neoWorkReviewId(work.id, retries);
      if (service.consultations.get(id)) return { reason: 'already-routed' };
      if (retries) return { value: { id } };
      const messages = service.db.getSDKMessageRepo();
      const queued = service.db.getJobQueueRepo().listActiveByPayload('mailbox', {
        'to.sessionId': rootId,
        messageUuid: work.id,
      });
      if (messages.findMessageIdByUuid(rootId, work.id) || queued.length)
        return { reason: 'legacy-return' };
      return { value: { id } };
    },
    ['service', 'work', 'rootId'],
    'result:admission'
  )
  .pipe(
    (service: NeoService, work: NeoWork) => service.open(work.concernId),
    ['service', 'work'],
    'holderId'
  )
  .pipe(
    (
      service: NeoService,
      work: NeoWork,
      rootId: string,
      holderId: string,
      { id }: { id: string }
    ) => {
      const item = service.consultations.reserve({
        id,
        requestKey: id,
        concernId: work.concernId!,
        originSessionId: rootId,
        sessionId: holderId,
        question: `${NEO_WORK_RETURN_REVIEW}\n${JSON.stringify({ workId: work.id, originSessionId: work.originSessionId, originMessageId: work.originMessageId, status: work.status, executionSessionId: work.sessionId, title: work.title, report: work.report })}`,
      });
      return item?.id === id ? { value: { id } } : { reason: 'holder-busy' };
    },
    ['service', 'work', 'rootId', 'holderId', 'admission'],
    'result:admission'
  )
  .pipe(
    async (service: NeoService, { id }: { id: string }) => {
      await service.syncConsultation(id);
      return 'routed';
    },
    ['service', 'admission'],
    'admission'
  )
  .endAsync('admission') as (service: NeoService, work: NeoWork, rootId: string) => Promise<string>;
