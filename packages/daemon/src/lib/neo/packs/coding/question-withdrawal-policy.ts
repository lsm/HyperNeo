import type { NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import { parsePrUrl } from '../../../github/parse-pr-url.ts';
import { extractNeoAskRefs, type NeoRef, type NeoRefState } from './ask-prs.ts';

type Candidate = { id: string; refs: NeoRef[] };
type Withdrawal = { id: string; evidence: string };
const key = (ref: NeoRef) => `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();

function candidates(items: readonly NeoAskItem[]): Candidate[] {
  return items.flatMap((item) => {
    if (
      item.removed ||
      item.state !== 'needs_you' ||
      item.kind === 'action' ||
      item.kind === 'approval'
    )
      return [];
    const text = [item.text, item.question, ...(item.watch ?? [])].filter(Boolean).join('\n');
    const refs = extractNeoAskRefs(
      {
        ask: text,
        doneWhen: '',
        outcome: null,
      },
      []
    );
    if (
      /(?<![\w./#-])#\d+\b/.test(text) &&
      new Set(refs.map((ref) => `${ref.owner}/${ref.repo}`.toLowerCase())).size !== 1
    )
      return [];
    return refs.length > 0 && refs.length < 10 ? [{ id: item.id, refs }] : [];
  });
}

function withdrawals(candidates: Candidate[], states: readonly NeoRefState[]): Withdrawal[] {
  const byKey = new Map<string, NeoRefState[]>();
  for (const state of states) {
    const ref = parsePrUrl(state.url);
    if (!ref || ref.host.toLowerCase() !== 'github.com') continue;
    const id = key({ ...ref, number: Number(ref.number) });
    byKey.set(id, [...(byKey.get(id) ?? []), state]);
  }
  return candidates.flatMap((item) => {
    const matched = item.refs.map((ref) => byKey.get(key(ref)) ?? []);
    if (
      matched.some(
        (entries) =>
          !entries.length ||
          entries.some((state) => state.kind !== 'pr' || state.state === 'OPEN') ||
          new Set(entries.map((state) => state.state)).size !== 1
      )
    )
      return [];
    return [
      {
        id: item.id,
        evidence: `Question obsolete: ${matched.map(([state]) => `${state.url} ${state.state === 'MERGED' ? 'merged' : 'closed unmerged'}`).join('; ')}.`,
      },
    ];
  });
}

const plan = (superpipe({})('neo-pr-question-withdrawal') as PipelineAPI)
  .input(['items', 'states'])
  .pipe(candidates, 'items', 'candidates')
  .pipe(withdrawals, ['candidates', 'states'], 'withdrawals')
  .end('withdrawals') as (
  items: readonly NeoAskItem[],
  states: readonly NeoRefState[]
) => Withdrawal[];

export const neoPrQuestionWithdrawalPolicy = {
  plan,
  refs: (items: readonly NeoAskItem[]): NeoRef[] => [
    ...new Map(
      candidates(items)
        .flatMap((item) => item.refs)
        .map((ref) => [key(ref), ref])
    ).values(),
  ],
};
