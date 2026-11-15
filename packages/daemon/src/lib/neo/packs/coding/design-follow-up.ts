import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';

type Step = Pick<NeoTodo, 'id' | 'title' | 'position' | 'state'>;

export type CodingDesignGap = { todo: Step; pr: NeoWorkPr };

export function codingDesignWithoutFollowUp(
  todos: readonly Step[],
  prs: (todoId: string) => readonly NeoWorkPr[]
): CodingDesignGap | null {
  const live = todos.filter((todo) => todo.state !== 'removed');
  const last = live.reduce<Step | null>(
    (latest, todo) => (!latest || todo.position > latest.position ? todo : latest),
    null
  );
  const pr = last && prs(last.id).find((item) => item.state === 'MERGED' && item.design);
  return last && pr ? { todo: last, pr } : null;
}

export const codingDesignFollowUpRefusal = (gap: CodingDesignGap) =>
  `design_follow_up_missing: design PR ${gap.pr.url} merged in todo "${gap.todo.title}" (${gap.todo.id}) and no todo follows it. Add the follow-up PR todos from its Change section with neo.todo.add after:["${gap.todo.id}"] before settling.`;

export async function wakeCodingDesignFollowUps(
  repo: {
    readDesignGaps(): Promise<readonly (CodingDesignGap & { askId: string; askTitle: string })[]>;
  },
  wake: (key: string, text: string) => Promise<boolean>
): Promise<void> {
  for (const gap of await repo.readDesignGaps())
    await wake(
      `neo-design-follow-up:${gap.askId}:${gap.todo.id}:${gap.pr.url}`,
      `Design PR ${gap.pr.url}${gap.pr.title ? ` "${gap.pr.title}"` : ''} merged in ask "${gap.askTitle}" (${gap.askId}), and no todo follows it. Open the follow-up PR todos from the design's Change section with neo.todo.add after:["${gap.todo.id}"]; the ask cannot settle done until they exist.`
    ).catch(() => false);
}
