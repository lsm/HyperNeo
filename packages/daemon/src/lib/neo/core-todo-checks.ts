import { stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
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
  if (check.kind === 'human_confirmed') return `The human answers card ${check.params.questionId}.`;
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

type CheckDraft = Pick<NeoTodo, 'check'> & { id?: string };
const invalid =
  'invalid_core_check: use human_confirmed {questionId}, evidence {path: absolute file path} (on a todo, {} for a daemon-assigned path), or deployed {repo: lsm/HyperNeo, sha: full commit}.';
const admit = (superpipe({})('neo.todo.core-admission') as PipelineAPI)
  .input(['draft', 'peers'])
  .pipe(
    (draft: CheckDraft) => {
      const parsed = draft.check?.pack === 'core' ? Check.safeParse(draft.check) : null;
      return parsed?.success ? { value: parsed.data } : { reason: { refusal: invalid } };
    },
    'draft',
    'result:refusal'
  )
  .pipe(
    (check: CoreCheck, draft: CheckDraft, peers: readonly NeoTodo[]) => {
      const artifact =
        check.kind === 'evidence' && 'artifact' in check.params ? check.params.artifact : null;
      return {
        refusal:
          artifact &&
          !peers.some(
            (peer) =>
              peer.id === draft.id &&
              peer.check?.pack === 'core' &&
              peer.check.kind === 'evidence' &&
              peer.check.params.artifact === artifact
          )
            ? invalid
            : null,
      };
    },
    ['refusal', 'draft', 'peers'],
    'refusal'
  )
  .end('refusal') as (draft: CheckDraft, peers: readonly NeoTodo[]) => { refusal: string | null };

const isEvidence = (check: NeoTodoCheck | null | undefined): check is NeoTodoCheck =>
  check?.pack === 'core' && check.kind === 'evidence';

export const withAssignedEvidence = <T extends NeoTodoCheck | null | undefined>(
  check: T,
  file: string
): T | NeoTodoCheck =>
  isEvidence(check) && !Object.keys(check.params).length
    ? { ...check, params: { path: file } }
    : check;

export function neoEvidenceRefusal(
  check: NeoTodoCheck | null | undefined,
  repo: string | null | undefined,
  userFolder: string,
  previous?: NeoTodoCheck | null
): string | null {
  const path = isEvidence(check) ? check.params.path : null;
  if (!repo || typeof path !== 'string' || JSON.stringify(check) === JSON.stringify(previous))
    return null;
  const inside = relative(userFolder.toLowerCase(), path.toLowerCase());
  return inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)
    ? null
    : `evidence_in_user_folder: ${path} is in the human's folder, which holds only results they should see. Omit params.path; the daemon assigns one and gives it to the worker.`;
}

export const coreTodoPolicy = {
  doneWhen,
  refuse: (draft: CheckDraft, peers: readonly NeoTodo[] = []) => admit(draft, peers).refusal,
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
        question.state === 'answered' &&
        (Array.isArray(question.answer)
          ? question.answer.length > 0
          : typeof question.answer === 'string' && question.answer.trim().length > 0) &&
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
