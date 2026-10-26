import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { isLocalUser } from '../../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../../operations/registry.ts';
import { neoFolderPath } from '../folder.ts';
import type { NeoService } from '../service.ts';
import { NeoHomeRepository, type HomeResult } from './repository.ts';
import { requireHomeConfirmation } from './confirmation.ts';
import { reportHomeConflict, requireHomeChoice } from './conflicts.ts';
import { HomeReadInput, HomeReadResult } from './read.ts';
import { HomeSaveInput, HomeSaveResult, requireHomePath } from './save.ts';

export function createNeoHomeOperations(
  service: Pick<NeoService, 'repo' | 'todos' | 'defaultSessionId'>,
  home = new NeoHomeRepository(neoFolderPath(), service.repo)
) {
  const owner = (caller: OperationCaller) =>
    isLocalUser(caller) ||
    (caller.source === 'mcp' &&
      !!caller.sessionId &&
      caller.sessionId === service.defaultSessionId())
      ? { value: caller }
      : { reason: { ok: false, reason: 'This operation belongs to root Neo or the user.' } };
  const init = (superpipe({})('neo.home.init') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(owner, 'caller', 'result:outcome')
    .pipe(
      (input: { remoteUrl?: string }, caller: OperationCaller) =>
        input.remoteUrl && !isLocalUser(caller)
          ? {
              reason: {
                ok: false,
                reason: 'human_selection_required: ask the local user to select the home remote.',
              },
            }
          : { value: input },
      ['input', 'caller'],
      'result:outcome'
    )
    .pipe((input: { remoteUrl?: string }) => home.init(input.remoteUrl), 'outcome', 'outcome')
    .endAsync('outcome') as (input: unknown, caller: OperationCaller) => Promise<HomeResult>;
  const save = (superpipe({})('neo.home.save') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(owner, 'caller', 'result:outcome')
    .pipe(requireHomePath, 'input', 'result:outcome')
    .pipe(
      (input: HomeSaveInput) =>
        requireHomeConfirmation(input, service.todos, service.defaultSessionId()),
      'outcome',
      'result:outcome'
    )
    .pipe(
      (input) => requireHomeChoice(input, service.todos, service.defaultSessionId(), home.root),
      'outcome',
      'result:outcome'
    )
    .pipe((input) => home.save(input), 'outcome', 'outcome')
    .pipe(
      (result) => reportHomeConflict(result, service.todos, service.defaultSessionId()),
      'outcome',
      'outcome'
    )
    .endAsync('outcome') as (
    input: HomeSaveInput,
    caller: OperationCaller
  ) => Promise<HomeSaveResult>;
  const read = (superpipe({})('neo.home.read') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(owner, 'caller', 'result:outcome')
    .pipe(requireHomePath, 'input', 'result:outcome')
    .pipe((input: HomeReadInput) => home.read(input), 'outcome', 'outcome')
    .pipe(
      (result) => reportHomeConflict(result, service.todos, service.defaultSessionId()),
      'outcome',
      'outcome'
    )
    .endAsync('outcome') as (
    input: HomeReadInput,
    caller: OperationCaller
  ) => Promise<HomeReadResult>;
  return [
    defineOperation({
      name: 'neo.home.read',
      description:
        'Read a complete curated home document and its SHA-256. With origin/upstream, synchronizes using bounded noninteractive fetch and isolated rebase for each read through the same path as a human RPC read. Publishes only a fast-forward that preserves ignored and untracked files. Local-only reads include human edits; synchronization relies on Git merge errors rather than a blanket dirty-state refusal. A sync conflict returns questionId for one human choice with a full-version document; answering alone does not apply it; neo.home.save can apply the exact recorded version choice. includeRemote optionally adds the browser origin URL without fetching. Never initializes or authors a commit. Refuses internal, ignored or symlink paths and non-UTF-8 content. Root Neo or the local user only.',
      inputSchema: HomeReadInput,
      resultSchema: HomeReadResult,
      policy: { safetyClass: 'read', roles: ['neo'] },
      execute: (input, caller) => read(input, caller),
    }),
    defineOperation({
      name: 'neo.home.save',
      description:
        'Save one curated document and commit locally. With a configured origin/upstream, fetches and rebases in an isolated worktree before a protected fast-forward, then writes and pushes. Network steps are noninteractive and stop after 30 seconds. A conflict leaves the original home untouched and returns questionId for one human choice with a full-version document; answering alone does not apply that choice; conflictQuestionId applies a human Keep local/Use remote answer from its recorded path and version to one regular conflicting document using exact selected bytes and a merge preserving both histories. Multi-file, deletion and Review together choices require further review. Direction/mandate still need a separate exact-path/SHA questionId; the version choice never bypasses it. RPC remote publication uses a revision lease; push_failed retains the named local commit for retry. Allows unrelated staged, edited and untracked home files; commits only the requested document and any confirmed decision log. Refuses credential-like content when origin is configured, and internal/ignored paths. Direction and mandate require questionId: a matching human yes on a root-Neo question bound to the exact path and content SHA-256. Appends the confirmed decision and commits both files with Neo-Confirmed-By. Root Neo or the local user only; Neo owns its home and can edit, repair and commit directly with normal tools. This operation retains a human-facing RPC for confirmed mandate/direction receipts with a decision log; direct edits do not attest human approval. Credential publication checks cover these RPC paths; direct git use follows the prompt rule against publishing credentials and is not constrained by this RPC gate.',
      inputSchema: HomeSaveInput,
      resultSchema: HomeSaveResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: (input, caller) => save(input, caller),
    }),
    defineOperation({
      name: 'neo.home.init',
      description:
        'Initialize the local Neo home repository, ignore coordinator transcripts, and assign stable project folders. The local human may supply remoteUrl once to clone an existing shared home; origin/upstream remember the selection. Preserves local transcripts and refuses existing documents or a different origin. Clone is noninteractive with a 30-second timeout. After first setup, call neo.home.github with the current root askId to offer its private remote once. Uses the configured git identity; fix identity/signing configuration and retry if commit fails. Root Neo or the local user only.',
      inputSchema: z.object({ remoteUrl: z.string().trim().min(1).optional() }),
      resultSchema: z.union([
        z.object({ ok: z.literal(false), reason: z.string() }),
        z.object({
          ok: z.literal(true),
          path: z.string(),
          projects: z.array(z.object({ id: z.string(), homePath: z.string() })),
        }),
      ]),
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: (input, caller) => init(input, caller),
    }),
  ];
}
