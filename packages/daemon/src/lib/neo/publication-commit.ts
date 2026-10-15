import type {
  NeoPublication,
  NeoPublicationAppendResult,
  NeoPublicationInput,
} from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  flagPublicationLanguage,
  type NeoPublicationLanguageMismatch,
  planPublicationLanguage,
  requirePublicationLanguage,
} from './publication-language.ts';
import { requirePublicationNews } from './publication-news.ts';

type Rejection = { accepted: false; reason: string; detail?: string };
type Receipt = NeoPublicationAppendResult | Rejection;

export interface NeoPublicationCommitDeps {
  commit(input: NeoPublicationInput, consultationId: string | undefined): Receipt;
  published(input: NeoPublicationInput, publication: NeoPublication): void;
  turnText(input: NeoPublicationInput): string | null;
}

export function explainNeoPublicationRefusal(receipt: Receipt): Receipt {
  return !receipt.accepted &&
    receipt.reason === 'trigger_already_published' &&
    !('detail' in receipt)
    ? {
        ...receipt,
        detail:
          'The human already has the answer for this trigger; its first answer closes it. A later fact goes out as its own outcome or trigger message. End the turn.',
      }
    : receipt;
}

export function createNeoPublicationCommit(deps: NeoPublicationCommitDeps) {
  return (superpipe({})('neo-publication-commit') as PipelineAPI)
    .input(['input', 'consultationId', 'fallback'])
    .pipe(
      (input: NeoPublicationInput) => requirePublicationNews(input, input),
      'input',
      'result:receipt'
    )
    .pipe(
      (input: NeoPublicationInput) => planPublicationLanguage(input, deps.turnText(input)),
      'input',
      'language'
    )
    .pipe(
      (
        input: NeoPublicationInput,
        language: NeoPublicationLanguageMismatch | null,
        fallback: boolean | undefined
      ) => requirePublicationLanguage(input, language, fallback === true),
      ['input', 'language', 'fallback'],
      'result:receipt'
    )
    .pipe(flagPublicationLanguage, ['input', 'language'], 'input')
    .pipe(
      (input: NeoPublicationInput, consultationId: string | undefined) =>
        deps.commit(input, consultationId),
      ['input', 'consultationId'],
      'receipt'
    )
    .pipe(
      (receipt: Receipt, input: NeoPublicationInput) => {
        if (receipt.accepted && receipt.created) deps.published(input, receipt.publication);
        return explainNeoPublicationRefusal(receipt);
      },
      ['receipt', 'input'],
      'receipt'
    )
    .end('receipt') as (
    input: NeoPublicationInput,
    consultationId?: string,
    fallback?: boolean
  ) => Receipt;
}
