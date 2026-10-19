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
      const continued = service.workContinues.get(work.id)?.count ?? 0;
      const id = neoWorkReviewId(work.id, retries, continued);
      if (service.consultations.get(id)) return { reason: 'already-routed' };
      if (retries || continued) return { value: { id } };
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
  .pipe((service: NeoService) => service.open(), 'service', 'holderId')
  .pipe(
    (service: NeoService, work: NeoWork) => service.environmentMoveNote(work),
    ['service', 'work'],
    'move'
  )
  .pipe(
    (
      service: NeoService,
      work: NeoWork,
      rootId: string,
      holderId: string,
      { id }: { id: string },
      move: string
    ) => {
      const item = service.consultations.reserve({
        id,
        requestKey: id,
        projectId: work.projectId!,
        originSessionId: work.originSessionId,
        sessionId: holderId,
        question: `${NEO_WORK_RETURN_REVIEW}${move}\n${JSON.stringify({ workId: work.id, originSessionId: work.originSessionId, originMessageId: work.originMessageId, status: work.status, executionSessionId: work.sessionId, title: work.title, report: work.report })}`,
      });
      return item?.id === id ? { value: { id } } : { reason: 'holder-busy' };
    },
    ['service', 'work', 'rootId', 'holderId', 'admission', 'move'],
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
