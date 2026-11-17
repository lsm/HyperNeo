import type { NeoAttentionEvent, NeoAttentionKind } from '../../attention/decide.ts';
import type { NeoPack } from '../../pack-contract.ts';
import { STATE_TEXT } from './pr-sweep.ts';
import type { CodingTodoPrRepository } from './todo-prs.ts';

export type CodingAttend = (event: NeoAttentionEvent) => Promise<boolean>;

const told = {
  decide: () => 'wake' as const,
  render: ({ facts }: NeoAttentionEvent) => String(facts.text),
};

export const CODING_ATTENTION_KINDS: readonly NeoAttentionKind[] = [
  { id: 'coding.merge_held', ...told },
  { id: 'coding.merge_failing', ...told, ladder: [4 * 3_600_000] },
  { id: 'coding.merge_confirmed', ...told },
  { id: 'coding.github_budget', ...told },
  { id: 'coding.pr_unowned', ...told },
  { id: 'coding.pr_sweep', ...told },
  {
    id: 'coding.idle_with_open_pr',
    decide: () => 'digest',
    render: told.render,
    ladder: [4 * 3_600_000],
  },
  {
    id: 'coding.github_health',
    decide: () => 'digest',
    render: told.render,
    ladder: [24 * 3_600_000],
  },
];

type Waiting = Parameters<NonNullable<NonNullable<NeoPack['attention']>['scan']>>[1];

export const scanCodingIdleOpenPrs =
  (repo: Pick<CodingTodoPrRepository, 'readOpenLedger'>) =>
  async (_now: number, waiting: Waiting): Promise<NeoAttentionEvent[]> => {
    const idle = waiting.filter(({ facts }) => facts.worker?.status === 'idle');
    const prs = await repo.readOpenLedger(idle.map(({ todo }) => todo.id));
    return idle.flatMap(({ todo, facts }) => {
      const open = prs.filter((pr) => pr.todoId === todo.id);
      if (!open.length) return [];
      const list = open
        .map((pr) => `${pr.url} (${(pr.state && STATE_TEXT[pr.state]) ?? pr.state ?? 'open'})`)
        .join(', ');
      const one = open.length === 1;
      return [
        {
          kind: 'coding.idle_with_open_pr',
          subject: { type: 'todo', id: todo.id },
          since: Math.max(facts.worker?.since ?? 0, ...open.map((pr) => pr.since ?? 0)),
          facts: {
            text: `Todo "${todo.title}" (${todo.id}) has an idle worker and ${one ? 'an open pull request' : 'open pull requests'}: ${list}. Continue its worker if ${one ? 'the pull request needs' : 'one needs'} work; otherwise it waits on review, CI or the merge.`,
          },
        },
      ];
    });
  };

export const codingPrHeadEvent = (
  kind: string,
  pr: { url: string; head: string },
  since: number,
  text: string
): NeoAttentionEvent => ({
  kind,
  subject: { type: 'pr_head', id: `${pr.url}@${pr.head}` },
  since,
  facts: { text },
});
