import type { NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoTodoPack } from './pack-contract.ts';

type Step = Pick<NeoTodo, 'id' | 'title' | 'state' | 'producesFollowUp' | 'dependsOn'>;

export function neoTodoWithoutFollowUp<T extends Step>(todos: readonly T[]): T | null {
  return (
    todos.find(
      (todo) =>
        todo.producesFollowUp &&
        todo.state === 'done' &&
        !todos.some((other) => other.state !== 'removed' && other.dependsOn?.includes(todo.id))
    ) ?? null
  );
}

export function neoTodoFollowUpRefusal(todos: readonly Step[]): string | null {
  const gap = neoTodoWithoutFollowUp(todos);
  return gap
    ? `follow_up_missing: todo "${gap.title}" (${gap.id}) produces follow-up work and no todo follows it. Add each follow-up with neo.todo.add after:["${gap.id}"] (unstarted is fine) before settling done, or settle dropped.`
    : null;
}

export const NEO_PLAN_SIGNOFF = 'plan-signoff';

type PlanFacts = {
  todo: NeoTodo;
  plan: boolean;
  steps: readonly NeoTodo[];
  cards: readonly NeoQuestion[];
};

export function livePlanSteps(todoId: string, todos: readonly NeoTodo[]): NeoTodo[] {
  return todos.filter((step) => step.state !== 'removed' && step.dependsOn?.includes(todoId));
}

export async function neoPlanFacts(
  todo: NeoTodo,
  todos: readonly NeoTodo[],
  cards: readonly NeoQuestion[],
  packs: readonly { todos?: Pick<NeoTodoPack, 'plan'> }[]
): Promise<PlanFacts> {
  const legacy = todo.planCheck && 'legacy' in todo.planCheck;
  let plan = !legacy && todo.plan === true;
  if (!legacy && !plan) {
    for (const pack of packs) {
      if (await pack.todos?.plan?.(todo)) {
        plan = true;
        break;
      }
    }
  }
  return {
    todo,
    plan,
    steps: livePlanSteps(todo.id, todos),
    cards: cards.filter((card) => card.todoId === todo.id && card.state === 'answered'),
  };
}

export function samePlanSteps(ids: readonly string[], steps: readonly NeoTodo[]): boolean {
  const supplied = new Set(ids);
  return ids.length === steps.length && steps.every((step) => supplied.has(step.id));
}

export function currentPlanCheck(todo: NeoTodo, steps: readonly NeoTodo[]): boolean {
  const check = todo.planCheck;
  return !!check && !('legacy' in check) && samePlanSteps(check.stepIds, steps);
}

/** @public */
export function neoPlanRefusal({ todo, plan, steps, cards }: PlanFacts): string | null {
  if (!plan) return steps.length ? null : neoTodoFollowUpRefusal([todo]);
  if (!steps.length) return 'plan_steps_missing: Add the plan steps as dependent todos.';
  if (todo.state === 'done') return null;
  if (!currentPlanCheck(todo, steps)) return 'plan_check_missing: Check the current plan steps.';
  const signed = cards.some(
    (card) =>
      card.cause === NEO_PLAN_SIGNOFF &&
      card.kind === 'choice' &&
      card.options?.length === 1 &&
      card.answeredBy !== null &&
      Array.isArray(card.answer) &&
      card.answer.length === 1 &&
      card.answer[0] === card.options[0] &&
      samePlanSteps(card.todos, steps)
  );
  return signed ? null : 'plan_signoff_missing: Ask the human to sign off on the current steps.';
}

/** @public */
export function neoPlanCheckBrief(todo: NeoTodo, steps: readonly NeoTodo[], notes: string): string {
  const plan = {
    title: todo.title,
    instruction: todo.instruction,
    doneWhen: todo.doneWhen,
    artifacts: todo.artifacts ?? [],
    evidence: todo.evidence,
    steps: steps.map(({ id, title, instruction }) => ({ id, title, instruction })),
  };
  return [
    'Check whether the recorded steps cover the recorded plan. Review its evidence and artifacts.',
    'Report to Neo using message.send with check: { verdict: "pass" or "fail", stepIds: the IDs below }.',
    JSON.stringify(plan, null, 2),
    'Notes from Neo:',
    notes,
  ].join('\n\n');
}
