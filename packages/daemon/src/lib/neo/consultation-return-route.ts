import type { NeoConsultation } from '@hyperneo/shared/types/neo-context';
import type { NeoInputOrigin } from '@hyperneo/shared/types/neo-message';
import type { NeoPublication, NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import type { NeoConsultationPublication } from '../../storage/repositories/neo-consultation-repository.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { admitNeoPublication } from './publication.ts';

type Stop = 'pending' | 'legacy' | 'inconsistent';
type ReturnItem = Pick<NeoConsultation, 'id' | 'status' | 'answer'> &
  Partial<Pick<NeoConsultation, 'sessionId'>>;
type Gate<T> = { value: T } | { reason: Stop };
export type NeoConsultationReturn = Stop | { kind: 'published'; publication: NeoPublication };

export function selectConsultationReturn(
  item: ReturnItem,
  association: NeoConsultationPublication | null,
  publication: NeoPublication | null
): Gate<NeoConsultationPublication> {
  if (item.status === 'pending') return { reason: 'pending' };
  if (!association) return { reason: publication ? 'inconsistent' : 'legacy' };
  return { value: association };
}

export function requireConsultationReceipt(
  association: NeoConsultationPublication,
  item: ReturnItem
): Gate<NeoConsultationPublication> {
  return item.status === 'reported' &&
    association.consultationId === item.id &&
    association.answer === item.answer
    ? { value: association }
    : { reason: 'inconsistent' };
}

export function requireConsultationPublication(
  association: NeoConsultationPublication,
  item: ReturnItem,
  publication: NeoPublication | null
): Gate<NeoPublication> {
  if (!publication) return { reason: 'inconsistent' };
  const { sequence, createdAt, ...input } = publication;
  return 'value' in admitNeoPublication(input) &&
    Number.isInteger(sequence) &&
    sequence > 0 &&
    Number.isFinite(Date.parse(createdAt)) &&
    publication.conversationId === association.conversationId &&
    publication.publicationId === association.publicationId &&
    createdAt === association.createdAt &&
    publication.fullText === association.answer &&
    publication.producerInput.sessionId === item.sessionId &&
    publication.producerInput.messageId === `neo-consult:${item.id}:request`
    ? { value: publication }
    : { reason: 'inconsistent' };
}

export function requireConsultationAsk(
  publication: NeoPublication,
  originalAsk: NeoInputOrigin | null
): Gate<NeoPublication> {
  return originalAsk !== null &&
    publication.askOrigin.sessionId === originalAsk.sessionId &&
    publication.askOrigin.messageId === originalAsk.messageId
    ? { value: publication }
    : { reason: 'inconsistent' };
}

export function requireConsultationPayload(
  publication: NeoPublication,
  captured: NeoPublicationInput | null | undefined
): Gate<NeoPublication> {
  return captured === undefined ||
    (captured !== null &&
      (Object.keys(captured) as (keyof NeoPublicationInput)[]).every(
        (key) => JSON.stringify(captured[key]) === JSON.stringify(publication[key])
      ))
    ? { value: publication }
    : { reason: 'inconsistent' };
}

export const planNeoConsultationReturn = (
  superpipe({})('neo-consultation-return-route') as PipelineAPI
)
  .input(['item', 'association', 'publication', 'originalAsk', 'captured'])
  .pipe(selectConsultationReturn, ['item', 'association', 'publication'], 'result:route')
  .pipe(requireConsultationReceipt, ['route', 'item'], 'result:route')
  .pipe(requireConsultationPublication, ['route', 'item', 'publication'], 'result:route')
  .pipe(requireConsultationAsk, ['route', 'originalAsk'], 'result:route')
  .pipe(requireConsultationPayload, ['route', 'captured'], 'result:route')
  .pipe(
    (publication: NeoPublication) => ({ kind: 'published' as const, publication }),
    'route',
    'route'
  )
  .end('route') as (
  item: ReturnItem,
  association: NeoConsultationPublication | null,
  publication: NeoPublication | null,
  originalAsk: NeoInputOrigin | null,
  captured?: NeoPublicationInput | null
) => NeoConsultationReturn;
