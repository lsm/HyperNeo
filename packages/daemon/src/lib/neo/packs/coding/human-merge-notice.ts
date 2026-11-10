import superpipe, { type PipelineAPI } from 'superpipe';
import type {
  NeoPublicationInput,
  NeoPublicationAppendResult,
} from '@hyperneo/shared/types/neo-publication';
import { neoDerivedId } from '../../derived-id.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { NeoRepository } from '../../../../storage/repositories/neo-repository.ts';
import { NeoPublicationRepository } from '../../../../storage/repositories/neo-publication-repository.ts';
import type { CodingLedgerRow } from './pr-ledger.ts';

export function codingHumanHandoffs(db: Database, rows: readonly CodingLedgerRow[]) {
  const conversation = new NeoRepository(db).readConversationId();
  const publications = new NeoPublicationRepository(db);
  return conversation
    ? rows.filter((row) => {
        const url =
          `https://${process.env.GH_HOST ?? 'github.com'}/${row.repo}/pull/${row.number}`.toLowerCase();
        return publications.get(conversation, neoDerivedId(`coding-no-checks:${url}:${row.head}`));
      })
    : [];
}

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
