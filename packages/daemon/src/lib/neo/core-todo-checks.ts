import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { NeoTodo, NeoTodoCheck } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import { ArtifactFileReadRepository } from '../../storage/repositories/artifact-file-read-repository.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import { BUILD_METADATA } from '../build-metadata.ts';
import type { NeoPack, NeoTodoCheckResult, NeoTodoJudgement } from './pack-contract.ts';

const Text = z.string().trim().min(1);
const Check = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human_confirmed'), params: z.strictObject({ questionId: Text }) }),
  z.object({
    kind: z.literal('evidence'),
    params: z.union([
      z.strictObject({ artifact: Text }),
      z.strictObject({ path: Text.refine(isAbsolute, 'Use an absolute file path') }),
    ]),
  }),
  z.object({
    kind: z.literal('deployed'),
    params: z.strictObject({
      repo: Text.regex(/^lsm\/hyperneo$/i),
      sha: z.string().regex(/^[0-9a-f]{40}$/),
    }),
  }),
]);
type CoreCheck = z.infer<typeof Check>;
type Contains = (repo: string, sha: string, build: string) => Promise<boolean>;
const unmet: NeoTodoCheckResult = { done: false, evidence: null };

function sentence(check: CoreCheck): string {
  if (check.kind === 'human_confirmed')
    return `The human answers yes to card ${check.params.questionId}.`;
  if (check.kind === 'evidence')
    return 'artifact' in check.params
      ? `Registered artifact ${check.params.artifact} exists.`
      : `File ${check.params.path} exists.`;
  return `The running daemon build contains ${check.params.repo}@${check.params.sha}.`;
}

function doneWhen(rule: NeoTodoCheck) {
  const parsed = rule.pack === 'core' ? Check.safeParse(rule) : null;
  return parsed?.success ? sentence(parsed.data) : null;
}

export const coreTodoPolicy = {
  doneWhen,
  refuse: (draft: Pick<NeoTodo, 'check'>) =>
    doneWhen(draft.check!)
      ? null
      : 'invalid_core_check: use human_confirmed {questionId}, evidence {artifact} or {path}, or deployed {repo: lsm/HyperNeo, sha: full commit}.',
};

export function createCoreTodoPack(db: Database, contains: Contains): NeoPack {
  const store = new NeoAskTodoRepository(db);
  const artifacts = new ArtifactFileReadRepository(db);
  async function observe(todo: NeoTodo, check: CoreCheck): Promise<boolean> {
    if (check.kind === 'human_confirmed') {
      const question = store.getQuestion(check.params.questionId);
      return (
        !!question &&
        question.askId === todo.askId &&
        question.kind === 'yesno' &&
        question.state === 'answered' &&
        question.answer === 'yes' &&
        question.answeredBy !== null
      );
    }
    if (check.kind === 'evidence') {
      if ('artifact' in check.params) {
        const artifact = artifacts.get(check.params.artifact);
        return (
          !!artifact &&
          (artifact.context_kind === 'ask'
            ? artifact.context_id === todo.askId
            : artifact.context_id === todo.id)
        );
      }
      return stat(check.params.path).then(
        (file) => file.isFile(),
        () => false
      );
    }
    const build = BUILD_METADATA.commit;
    return (
      /^[0-9a-f]{40}$/.test(build) &&
      (build === check.params.sha ||
        (await contains(check.params.repo.toLowerCase(), check.params.sha, build)))
    );
  }
  const check = (superpipe({})('neo.todo.core-check') as PipelineAPI)
    .input(['todo'])
    .pipe(
      (todo: NeoTodo) => {
        const parsed = todo.check?.pack === 'core' ? Check.safeParse(todo.check) : null;
        return parsed?.success ? { value: parsed.data } : { reason: unmet };
      },
      'todo',
      'result:observed'
    )
    .pipe(
      async (todo: NeoTodo, rule: CoreCheck): Promise<NeoTodoCheckResult> => {
        const done = await observe(todo, rule);
        return { done, evidence: done ? sentence(rule) : null };
      },
      ['todo', 'observed'],
      'observed'
    )
    .endAsync('observed') as (todo: NeoTodo) => Promise<NeoTodoCheckResult>;
  return {
    id: 'core',
    describe: 'Shared completion checks',
    instructions: () => null,
    readFacts: check,
    judge: (_todo, facts): NeoTodoJudgement => {
      const result = facts as NeoTodoCheckResult;
      return result.done ? { state: 'done', evidence: result.evidence } : { state: 'no_opinion' };
    },
    todos: {
      schema: () => {},
      check,
      ...coreTodoPolicy,
      statusLine: () => null,
    },
  };
}
