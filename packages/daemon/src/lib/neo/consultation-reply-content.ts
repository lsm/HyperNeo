import {
  NEO_CONSULTATION_SETTLED,
  NEO_CONSULTATION_SETTLED_FAILED,
  NEO_CONSULTATION_SETTLED_REPORTED,
  NEO_CONSULTATION_SETTLED_STOPPED,
} from '@hyperneo/prompts';
import type { NeoConsultation } from '@hyperneo/shared/types/neo-context';
import superpipe, { type PipelineAPI } from 'superpipe';
import { CONSULTATION_STOPPED } from './consultation-policy.ts';

type Reply = Pick<NeoConsultation, 'id' | 'originMessageId' | 'projectId' | 'status' | 'answer'>;

function selectSettledReply(item: Reply): { value: Reply } | { reason: null } {
  return item.status === 'pending' ? { reason: null } : { value: item };
}

function presentReply(item: Reply): string {
  const replyGuidance =
    item.status === 'reported'
      ? NEO_CONSULTATION_SETTLED_REPORTED
      : item.answer === CONSULTATION_STOPPED
        ? NEO_CONSULTATION_SETTLED_STOPPED
        : NEO_CONSULTATION_SETTLED_FAILED;
  return `${NEO_CONSULTATION_SETTLED}\n${JSON.stringify({ consultationId: item.id, originMessageId: item.originMessageId, projectId: item.projectId, status: item.status, answer: item.answer, replyGuidance })}`;
}

export const neoConsultationReplyContent = (
  superpipe({})('neo-consultation-reply-content') as PipelineAPI
)
  .input('item')
  .pipe(selectSettledReply, 'item', 'result:reply')
  .pipe(presentReply, 'reply', 'reply')
  .end('reply') as (item: Reply) => string | null;
