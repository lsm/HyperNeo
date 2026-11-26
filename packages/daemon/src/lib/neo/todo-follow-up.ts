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

type PlanPacks = readonly { todos?: Pick<NeoTodoPack, 'plan'> }[];

export async function neoPackPlan(todo: NeoTodo, packs: PlanPacks): Promise<boolean> {
  if (todo.plan || (todo.planCheck && 'legacy' in todo.planCheck)) return false;
  for (const pack of packs) {
    if (await pack.todos?.plan?.(todo)) return true;
  }
  return false;
}

export async function neoPackPlanIds(todos: readonly NeoTodo[], packs: PlanPacks) {
  if (!packs.some((pack) => pack.todos?.plan)) return [];
  const plans = await Promise.all(
    todos.map(async (todo) => ((await neoPackPlan(todo, packs)) ? todo.id : null))
  );
  return plans.filter((id) => id !== null);
}

export function neoRecordedPlanFacts(
  todo: NeoTodo,
  todos: readonly NeoTodo[],
  cards: readonly NeoQuestion[],
  packPlan = false
): PlanFacts {
  return {
    todo,
    plan: !(todo.planCheck && 'legacy' in todo.planCheck) && (todo.plan === true || packPlan),
    steps: livePlanSteps(todo.id, todos),
    cards: cards.filter((card) => card.todoId === todo.id && card.state === 'answered'),
  };
}

export async function neoPlanFacts(
  todo: NeoTodo,
  todos: readonly NeoTodo[],
  cards: readonly NeoQuestion[],
  packs: PlanPacks
): Promise<PlanFacts> {
  return neoRecordedPlanFacts(todo, todos, cards, await neoPackPlan(todo, packs));
}

export async function neoAskPlanGap(
  askId: string,
  family: readonly NeoTodo[],
  packs: PlanPacks
): Promise<{ todo: NeoTodo; reason: string } | null> {
  const todos = family.filter((todo) => todo.askId === askId);
  for (const todo of todos) {
    if (todo.state !== 'done') continue;
    const facts = await neoPlanFacts(todo, family, [], packs);
    const reason = neoPlanRefusal(facts.plan ? facts : neoRecordedPlanFacts(todo, todos, []));
    if (reason) return { todo, reason };
  }
  return null;
}

export function samePlanSteps(ids: readonly string[], steps: readonly NeoTodo[]): boolean {
  const supplied = new Set(ids);
  return ids.length === steps.length && steps.every((step) => supplied.has(step.id));
}

function currentPlanCheck(todo: NeoTodo, steps: readonly NeoTodo[]): boolean {
  const check = todo.planCheck;
  return !!check && !('legacy' in check) && samePlanSteps(check.stepIds, steps);
}

export function neoPlanRefusal(
  { todo, plan, steps, cards }: PlanFacts,
  through: 'steps' | 'check' | 'signoff' = 'signoff'
): string | null {
  if (!plan) return steps.length ? null : neoTodoFollowUpRefusal([todo]);
  if (!steps.length) return 'plan_steps_missing: Add the plan steps as dependent todos.';
  if (through === 'steps' || todo.state === 'done') return null;
  if (!currentPlanCheck(todo, steps)) return 'plan_check_missing: Check the current plan steps.';
  if (through === 'check') return null;
  const signed = cards.some((card) => {
    const picked = [card.answer].flat();
    return (
      card.cause === NEO_PLAN_SIGNOFF &&
      card.kind === 'choice' &&
      card.options?.length === 1 &&
      card.answeredBy !== null &&
      picked.length === 1 &&
      picked[0] === card.options[0] &&
      samePlanSteps(card.todos, steps)
    );
  });
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
