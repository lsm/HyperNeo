import { requireLocalTreeAuthor } from '../../project-author.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoProject } from '@hyperneo/shared/types/neo-context';
import { parseGitHubRefUrl } from '../../../github/parse-pr-url.ts';
import { defineOperation, type OperationCaller } from '../../../operations/registry.ts';
import type { NeoRepository } from '../../../../storage/repositories/neo-repository.ts';
import { type NeoRefState, type NeoRefStateReader } from './ask-prs.ts';

const Failure = z.object({ ok: z.literal(false), reason: z.string() });
const Move = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  expectedRevision: z.number().int().positive(),
});
const Section = z.object({ parentId: z.string().min(1), epicUrl: z.string().url() });
type Failure = z.infer<typeof Failure>;
type Gate<T> = { value: T } | { reason: Failure };

function normalizeNeoEpicUrl(url: string): string {
  return url
    .toLowerCase()
    .replace(/^http:/, 'https:')
    .replace(/\/$/, '');
}

function requireNeoSectionParent(parent: NeoProject | null): Gate<true> {
  return parent && parent.id !== 'inbox'
    ? { value: true }
    : { reason: { ok: false, reason: 'unknown_parent' } };
}

export function requireNeoEpic(
  states: readonly NeoRefState[],
  url: string
): Gate<{ url: string; title: string }> {
  const epic = states.find(
    (state) => state.url.toLowerCase() === url.toLowerCase() && state.kind === 'issue'
  );
  return epic?.title?.trim()
    ? { value: { url: epic.url.toLowerCase(), title: epic.title.trim().slice(0, 160) } }
    : { reason: { ok: false, reason: 'epic_unavailable' } };
}

export function createNeoProjectTreeOperations(repo: NeoRepository, read: NeoRefStateReader) {
  const authorize = (caller: OperationCaller) => requireLocalTreeAuthor(caller);
  const move = (superpipe({})('neo.project.move') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(authorize, 'caller', 'result:outcome')
    .pipe(
      (input: z.infer<typeof Move>) =>
        repo.moveProjectLater(input.id, input.parentId, input.expectedRevision),
      'input',
      'outcome'
    )
    .endAsync('outcome');
  const section = (superpipe({})('neo.project.section') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(authorize, 'caller', 'result:outcome')
    .pipe((input: z.infer<typeof Section>) => repo.getSectionParentLater(input.parentId), 'input', 'parent')
    .pipe(requireNeoSectionParent, 'parent', 'result:outcome')
    .pipe(
      (input: z.infer<typeof Section>) => normalizeNeoEpicUrl(input.epicUrl),
      'input',
      'epicUrl'
    )
    .pipe(
      (url: string) => {
        const ref = parseGitHubRefUrl(url);
        return ref && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/.test(url)
          ? { value: ref }
          : { reason: { ok: false, reason: 'invalid_epic_url' } };
      },
      'epicUrl',
      'result:outcome'
    )
    .pipe(
      (ref: NonNullable<ReturnType<typeof parseGitHubRefUrl>>) => read([ref]),
      'outcome',
      'states'
    )
    .pipe(requireNeoEpic, ['states', 'epicUrl'], 'result:outcome')
    .pipe(
      (epic: { url: string; title: string }, input: z.infer<typeof Section>) =>
        repo.createSectionLater(input.parentId, epic.url, epic.title),
      ['outcome', 'input'],
      'outcome'
    )
    .endAsync('outcome');
  return [
    defineOperation({
      name: 'neo.project.move',
      description:
        'Move an avatar under another parent or root, preserving its asks and context. Any local session; refuses cycles and stale revisions.',
      inputSchema: Move,
      resultSchema: z.union([Failure, z.object({ ok: z.literal(true) })]),
      policy: {
        safetyClass: 'mutate',
        roles: ['neo', 'workflow_worker', 'direct_task_worker', 'long_term_agent'],
      },
      execute: move as (
        input: z.infer<typeof Move>,
        caller: OperationCaller
      ) => Promise<{ ok: true } | Failure>,
    }),
    defineOperation({
      name: 'neo.project.section',
      description:
        'Create a section only when needed, from a GitHub epic issue under its code project. It inherits the parent’s workspaces; repeated calls reuse the same section. Any local session.',
      inputSchema: Section,
      resultSchema: z.union([Failure, z.object({ ok: z.literal(true), projectId: z.string() })]),
      policy: {
        safetyClass: 'mutate',
        roles: ['neo', 'workflow_worker', 'direct_task_worker', 'long_term_agent'],
      },
      execute: section as (
        input: z.infer<typeof Section>,
        caller: OperationCaller
      ) => Promise<{ ok: true; projectId: string } | Failure>,
    }),
  ];
}
