import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { NeoPack, NeoTodoCheckResult } from './pack-contract.ts';

export function questionCheckTodo(question: NeoQuestion, todo: NeoTodo | null): NeoTodo {
  return {
    id: question.id,
    askId: question.askId,
    title: question.text,
    position: 0,
    doneWhen: '',
    instruction: null,
    named: null,
    repo: null,
    state: 'todo',
    reason: null,
    blockedReason: null,
    nextAction: null,
    blockedBy: null,
    priority: 'normal',
    dependsOn: null,
    replacedBy: null,
    addedAfterStart: false,
    report: null,
    evidence: null,
    createdAt: question.createdAt,
    updatedAt: question.createdAt,
    startedAt: null,
    finishedAt: null,
    ...todo,
    check: question.retireWhen ?? todo?.check ?? null,
  };
}

export function passedQuestionCheck(result: NeoTodoCheckResult | null) {
  return result?.done && !result.failed && result.evidence?.trim()
    ? { value: result.evidence }
    : { reason: null };
}

export function createQuestionRetirement(
  store: NeoAskTodoRepository,
  packs: () => readonly NeoPack[]
) {
  return (superpipe({})('neo.question.retire-when') as PipelineAPI)
    .input(['question', 'todo', 'now'])
    .pipe(questionCheckTodo, ['question', 'todo'], 'checked')
    .pipe(
      (todo: NeoTodo) =>
        packs()
          .find((pack) => pack.id === todo.check?.pack)
          ?.todos?.check(todo, 'question') ?? null,
      'checked',
      'observed'
    )
    .pipe(passedQuestionCheck, 'observed', 'result:retired')
    .pipe(
      async (question: NeoQuestion, todo: NeoTodo, evidence: string, now: number) => {
        const retired = await store.write(
          'retireCheckedQuestion',
          question,
          todo.check,
          evidence,
          now
        );
        return retired ? { value: retired } : { reason: null };
      },
      ['question', 'checked', 'retired', 'now'],
      'result:retired'
    )
    .endAsync('retired') as (
    question: NeoQuestion,
    todo: NeoTodo | null,
    now: number
  ) => Promise<NeoQuestion | null>;
}
