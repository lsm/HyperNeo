import { stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import type { NeoTodo, NeoTodoCheck } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import { ArtifactFileReadRepository } from '../../storage/repositories/artifact-file-read-repository.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import { DESKTOP_CONTROL_PREFERENCE } from './desktop-control-preference.ts';
import { SESSION_REUSE_PREFERENCE } from './session-reuse.ts';
import type { NeoPack, NeoTodoCheckResult, NeoTodoJudgement } from './pack-contract.ts';

const Text = z.string().trim().min(1);
const Check = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human_confirmed'), params: z.strictObject({ questionId: Text }) }),
  z.object({
    kind: z.literal('evidence'),
    params: z.union([
      z.strictObject({ artifact: Text }),
      z.strictObject({ path: Text.refine(isAbsolute, 'Use an absolute file path') }),
      z.strictObject({ url: Text.url().regex(/^https?:\/\//) }),
    ]),
  }),
]);
type CoreCheck = z.infer<typeof Check>;
export type NeoLinkExists = (url: string) => Promise<boolean>;
const unmet: NeoTodoCheckResult = { done: false, evidence: null };

function sentence(check: CoreCheck): string {
  if (check.kind === 'human_confirmed') return `The human answers card ${check.params.questionId}.`;
  if ('artifact' in check.params) return `Registered artifact ${check.params.artifact} exists.`;
  return 'url' in check.params
    ? `Link ${check.params.url} exists.`
    : `File ${check.params.path} exists.`;
}

function doneWhen(rule: NeoTodoCheck) {
  const parsed = rule.pack === 'core' ? Check.safeParse(rule) : null;
  return parsed?.success ? sentence(parsed.data) : null;
}

type CheckDraft = Pick<NeoTodo, 'check'> & { id?: string };
const invalid =
  'invalid_core_check: use human_confirmed {questionId}, evidence {path: absolute file path} or evidence {url: http(s) link} (on edit omit the check to keep the current one).';
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

/** @public */
export function neoEvidencePathRefusal(
  check: NeoTodoCheck | null | undefined,
  previous: NeoTodoCheck | null | undefined,
  dataDir: string
): string | null {
  const path = isEvidence(check) ? check.params.path : null;
  if (typeof path !== 'string' || JSON.stringify(check) === JSON.stringify(previous)) return null;
  const inside = relative(dataDir.toLowerCase(), path.toLowerCase());
  return inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)
    ? null
    : `evidence_in_data_dir: ${path} is inside the daemon data directory. Use a persistent location visible to the human.`;
}

export function neoLinkExists(packs: () => readonly NeoPack[]): NeoLinkExists {
  return async (url) => {
    for (const pack of packs()) {
      const known = await pack.linkExists?.(url);
      if (typeof known === 'boolean') return known;
    }
    return fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) }).then(
      async (response) => {
        await response.body?.cancel();
        return response.ok;
      },
      () => false
    );
  };
}

export const coreTodoPolicy = {
  doneWhen,
  refuse: (draft: CheckDraft, peers: readonly NeoTodo[] = []) => admit(draft, peers).refusal,
};

export function createCoreTodoPack(db: Database, linkExists: NeoLinkExists): NeoPack {
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
    if ('url' in check.params) return linkExists(check.params.url);
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
    preferences: {
      sessionReuse: SESSION_REUSE_PREFERENCE,
      desktopControl: DESKTOP_CONTROL_PREFERENCE,
    },
    instructions: () => null,
    readFacts: check,
    judge: (_todo, facts): NeoTodoJudgement => {
      const result = facts as NeoTodoCheckResult;
      return result.done ? { state: 'done', evidence: result.evidence } : { state: 'no_opinion' };
    },
    todos: {
      schema: () => {},
      writerAdd: true,
      check,
      ...coreTodoPolicy,
      statusLine: () => null,
    },
  };
}
