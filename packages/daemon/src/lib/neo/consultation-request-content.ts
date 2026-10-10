import { NEO_CONSULTATION_REQUEST } from '@hyperneo/prompts';
import type { NeoConsultation } from '@hyperneo/shared/types/neo-context';

type Request = Pick<NeoConsultation, 'id' | 'originMessageId' | 'question'>;

export function neoConsultationRequestContent(item: Request): string {
  return `${NEO_CONSULTATION_REQUEST}\n${JSON.stringify({ consultationId: item.id, originMessageId: item.originMessageId, question: item.question })}`;
}
