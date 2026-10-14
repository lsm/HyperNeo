import {
  NEO_CONSULTATION_INTERNAL_REQUEST,
  NEO_CONSULTATION_REQUEST,
  NEO_CROSS_PROJECT_REQUEST,
  NEO_WORK_REVIEW_REQUEST,
} from '@hyperneo/prompts';
import type { NeoConsultation } from '@hyperneo/shared/types/neo-context';
import { neoReviewWorkId } from './ask-origin.ts';

type Request = Pick<NeoConsultation, 'id' | 'originMessageId' | 'question'>;

export function neoConsultationRequestContent(
  item: Request,
  returnToRoot = false,
  humanMessageId?: string,
  triggered = true
): string {
  const header = neoReviewWorkId(item.id)
    ? NEO_WORK_REVIEW_REQUEST
    : returnToRoot
      ? NEO_CROSS_PROJECT_REQUEST
      : triggered
        ? NEO_CONSULTATION_REQUEST
        : NEO_CONSULTATION_INTERNAL_REQUEST;
  return `${header}\n${JSON.stringify({ consultationId: item.id, originMessageId: item.originMessageId, question: item.question, ...(humanMessageId ? { humanMessageId } : {}) })}`;
}
