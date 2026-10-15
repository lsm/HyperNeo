import type {
  NeoPublication,
  NeoPublicationAppendResult,
  NeoPublicationInput,
} from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';
import { requirePublicationNews } from './publication-news.ts';

type Rejection = { accepted: false; reason: string; detail?: string };
type Receipt = NeoPublicationAppendResult | Rejection;

export interface NeoPublicationCommitDeps {
  commit(input: NeoPublicationInput, consultationId: string | undefined): Receipt;
  published(input: NeoPublicationInput, publication: NeoPublication): void;
}

export function createNeoPublicationCommit(deps: NeoPublicationCommitDeps) {
  return (superpipe({})('neo-publication-commit') as PipelineAPI)
    .input(['input', 'consultationId'])
    .pipe(
      (input: NeoPublicationInput) => requirePublicationNews(input, input),
      'input',
      'result:receipt'
    )
    .pipe(
      (input: NeoPublicationInput, consultationId: string | undefined) =>
        deps.commit(input, consultationId),
      ['input', 'consultationId'],
      'receipt'
    )
    .pipe(
      (receipt: Receipt, input: NeoPublicationInput) => {
        if (receipt.accepted && receipt.created) deps.published(input, receipt.publication);
        return receipt;
      },
      ['receipt', 'input'],
      'receipt'
    )
    .end('receipt') as (input: NeoPublicationInput, consultationId?: string) => Receipt;
}
