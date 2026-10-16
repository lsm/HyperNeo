import type {
  NeoPublication,
  NeoPublicationAppendResult,
  NeoPublicationInput,
} from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';

type Rejection = { accepted: false; reason: string; detail?: string };
type Receipt = NeoPublicationAppendResult | Rejection;

export interface NeoPublicationCommitDeps {
  commit(input: NeoPublicationInput): Receipt;
  published(input: NeoPublicationInput, publication: NeoPublication): void;
}

export function createNeoPublicationCommit(deps: NeoPublicationCommitDeps) {
  return (superpipe({})('neo-publication-commit') as PipelineAPI)
    .input(['input'])
    .pipe((input: NeoPublicationInput) => deps.commit(input), 'input', 'receipt')
    .pipe(
      (receipt: Receipt, input: NeoPublicationInput) => {
        if (receipt.accepted && receipt.created) deps.published(input, receipt.publication);
        return receipt;
      },
      ['receipt', 'input'],
      'receipt'
    )
    .end('receipt') as (input: NeoPublicationInput) => Receipt;
}
