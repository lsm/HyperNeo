import superpipe, { type PipelineAPI } from 'superpipe';
import type {
  NeoPublicationInput,
  NeoPublicationAppendResult,
} from '@hyperneo/shared/types/neo-publication';
import { neoDerivedId } from '../../derived-id.ts';

type Delivery = {
  conversation(): string | null;
  append(input: NeoPublicationInput): Promise<NeoPublicationAppendResult>;
  notify(conversation: string): void;
};
export const publishCodingHumanMerge = (superpipe({})('coding.publish-human-merge') as PipelineAPI)
  .input(['delivery', 'key', 'text'])
  .pipe(
    (delivery: Delivery) => {
      const conversation = delivery.conversation();
      return conversation ? { value: conversation } : { reason: false };
    },
    'delivery',
    'result:conversation'
  )
  .pipe(
    async (delivery: Delivery, conversation: string, key: string, text: string) => {
      const receipt = await delivery.append({
        conversationId: conversation,
        publicationId: neoDerivedId(key),
        shortText: text,
        fullText: text,
        links: [],
      });
      if (!receipt.accepted) return false;
      if (receipt.created) delivery.notify(conversation);
      return true;
    },
    ['delivery', 'conversation', 'key', 'text'],
    'accepted'
  )
  .endAsync('accepted') as (delivery: Delivery, key: string, text: string) => Promise<boolean>;
