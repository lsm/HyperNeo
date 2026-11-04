import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { WorkRef } from '../../../drivers/types.ts';
import type { NeoTodoCheckResult } from '../../pack-contract.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { NeoAskTodoRepository } from '../../../../storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../storage/repositories/neo-todo-session-repository.ts';
import { githubUrlKey, parsePrUrl } from '../../../github/parse-pr-url.ts';
import type { CodingStageFact } from './stage-facts.ts';
import type { CodingStageTarget } from './stage-preferences.ts';
import { sameCodingWorkRef } from './delivery-facts.ts';

const Params = z.object({
  parentTodoId: z.string().min(1),
  url: z.string().refine((url) => !!parsePrUrl(url)),
  head: z.string().regex(/^[a-f\d]{40}$/i),
  stage: z.enum(['review', 'verify']),
  acceptanceContract: z.string().trim().min(1),
});
type Params = z.infer<typeof Params>;
type Worker = { todo: NeoTodo; ref: WorkRef | null };
type Card = ReturnType<NeoTodoSessionRepository['readCard']>;
const label = (stage: Params['stage']) => (stage === 'review' ? 'Review' : 'Verify');

export function codingStageTodoParams(todo: Pick<NeoTodo, 'check'>): Params | null {
  if (todo.check?.pack !== 'coding' || todo.check.kind !== 'stage_result') return null;
  const parsed = Params.safeParse(todo.check.params);
  return parsed.success ? parsed.data : null;
}

export function describeCodingStageTodo(
  input: Params,
  target: z.infer<typeof CodingStageTarget>,
  sandbox = false
) {
  const params = Params.parse(input),
    pr = parsePrUrl(params.url)!;
  return {
    title: `${label(params.stage)} PR #${pr.number} at ${params.head}`,
    check: {
      pack: 'coding',
      kind: 'stage_result',
      params: { ...params, url: githubUrlKey(params.url) },
    },
    instruction: `PR: ${params.url}. PR number: ${pr.number}. Exact head: ${params.head}. Acceptance contract: ${params.acceptanceContract}. Preserve local work, fetch origin and +refs/pull/${pr.number}/head:refs/remotes/origin/pull/${pr.number}/head, check out exactly ${params.head} in your own folder and confirm git rev-parse HEAD before inspecting. Read the acceptance contract. A new head requires a new stage todo. Report your ${label(params.stage)} verdict and durable evidence to Neo for this head and contract; never merge or close the author's todo.`,
    target: {
      verb: 'start' as const,
      ...target,
      sandbox,
      preparationParameters: {
        stageTodo: true,
        pullRequest: Number(pr.number),
        head: params.head,
        role: params.stage,
      },
    },
    after: [],
    start: true,
  };
}

export function checkCodingStageTodo(
  todo: NeoTodo,
  card: Card,
  facts: readonly CodingStageFact[]
): NeoTodoCheckResult {
  const params = codingStageTodoParams(todo),
    ref = card?.ref;
  const fact =
    params &&
    ref &&
    facts.find(
      (fact) =>
        fact.head === params.head &&
        githubUrlKey(fact.url) === githubUrlKey(params.url) &&
        fact.stage === (params.stage === 'verify' ? 'qa' : 'review') &&
        fact.acceptanceContract === params.acceptanceContract &&
        fact.ref &&
        sameCodingWorkRef(fact.ref, ref) &&
        fact.actor.id === ref.id &&
        (fact.actor.kind === 'human'
          ? ref.adapter === 'human'
          : fact.actor.harness === ref.adapter && fact.actor.model === card.model)
    );
  return fact
    ? {
        done: true,
        evidence: `${label(params!.stage)} ${fact.verdict} at ${params!.head}: ${fact.evidence.join('; ')}`,
      }
    : { done: false, evidence: null };
}

function planExclusions(todo: NeoTodo, workers: readonly Worker[]) {
  const params = codingStageTodoParams(todo);
  if (!params) return { value: [] as WorkRef[] };
  const author = workers.find((worker) => worker.todo.id === params.parentTodoId)?.ref;
  if (!author) return { reason: 'stage_author_binding_missing' };
  const earlier = workers.filter((worker) => {
    const other = codingStageTodoParams(worker.todo);
    return (
      worker.todo.id !== todo.id &&
      other?.parentTodoId === params.parentTodoId &&
      githubUrlKey(other.url) === githubUrlKey(params.url) &&
      other.head === params.head
    );
  });
  if (
    params.stage === 'verify' &&
    !earlier.some((worker) => worker.ref && codingStageTodoParams(worker.todo)?.stage === 'review')
  )
    return { reason: 'stage_review_binding_missing' };
  return { value: [author, ...earlier.flatMap((worker) => (worker.ref ? [worker.ref] : []))] };
}

export const codingStageWorkerExclusions = (
  superpipe({})('coding.stage-worker-exclusions') as PipelineAPI
)
  .input(['db', 'todo'])
  .pipe(
    (db: Database, todo: NeoTodo): Worker[] =>
      codingStageTodoParams(todo)
        ? new NeoAskTodoRepository(db)
            .listTodos(todo.askId)
            .map((todo) => ({ todo, ref: new NeoTodoSessionRepository(db).readRef(todo.id) }))
        : [],
    ['db', 'todo'],
    'workers'
  )
  .pipe(planExclusions, ['todo', 'workers'], 'exclusions')
  .end('exclusions') as (db: Database, todo: NeoTodo) => { value: WorkRef[] } | { reason: string };
