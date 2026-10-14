import { NEO_CONSULTATION_REQUEST, NEO_CROSS_PROJECT_REQUEST } from '@hyperneo/prompts';
import type { NeoConsultation } from '@hyperneo/shared/types/neo-context';

type Request = Pick<NeoConsultation, 'id' | 'originMessageId' | 'question'>;

export function neoConsultationRequestContent(
  item: Request,
  returnToRoot = false,
  humanMessageId?: string
): string {
  return `${returnToRoot ? NEO_CROSS_PROJECT_REQUEST : NEO_CONSULTATION_REQUEST}\n${JSON.stringify({ consultationId: item.id, originMessageId: item.originMessageId, question: item.question, ...(humanMessageId ? { humanMessageId } : {}) })}`;
}
