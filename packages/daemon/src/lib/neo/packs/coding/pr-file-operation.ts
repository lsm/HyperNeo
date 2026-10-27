import { homedir } from 'node:os';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { NeoAskTodoRepository } from '../../../../storage/repositories/neo-ask-todo-repository.ts';
import { defineOperation, type OperationCaller } from '../../../operations/registry.ts';
import { getDataDir } from '../../../data-dir.ts';
import { ArtifactRefSchema, ArtifactRefusalSchema } from '../../../artifacts/file-contracts.ts';
import { readBoundPrSummary } from '../../../artifacts/pr-summary.ts';
import { readBoundGitBlob } from '../../../artifacts/git-blob.ts';
import { captureGitArtifact } from '../../../artifacts/git-capture.ts';

const inputSchema = z.strictObject({
  context: z.strictObject({ kind: z.enum(['todo', 'ask']), id: z.string().min(1).max(200) }),
  pr: z
    .string()
    .regex(
      /^(?:[\w.-]+\/[\w.-]+#[1-9]\d*|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*)$/
    )
    .meta({ examples: ['example/repo#1'] }),
  path: z.string().min(1).max(4096),
  headSha: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .meta({ examples: ['a'.repeat(40)] }),
  requestId: z.string().uuid(),
});
type Input = z.infer<typeof inputSchema>;
const refused = (reason: 'unavailable' | 'source_changed') => ({
  accepted: false as const,
  reason,
});

export function createCodingPrFileOperation(
  database: () => Database,
  data = getDataDir(),
  home = homedir(),
  readPr = readBoundPrSummary,
  readGit = readBoundGitBlob
) {
  function owns(input: Input, caller: OperationCaller) {
    const repo = new NeoAskTodoRepository(database());
    const todo = input.context.kind === 'todo' ? repo.getTodo(input.context.id) : null;
    const ask =
      input.context.kind === 'todo'
        ? todo && repo.getAsk(todo.askId)
        : repo.getAsk(input.context.id);
    return (
      caller.source === 'mcp' &&
      caller.role === 'neo' &&
      !!ask &&
      ask.sessionId === caller.sessionId
    );
  }
  async function plan(input: Input, caller: OperationCaller) {
    if (!owns(input, caller)) return { reason: refused('unavailable') };
    const [, owner, repo, number] =
      /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)(?:#|\/pull\/)([1-9]\d*)$/.exec(input.pr)!;
    const repository = `github.com/${owner}/${repo}`.toLowerCase();
    const pr = await readPr({ repository, number: Number(number) });
    return pr?.headSha === input.headSha && pr.files.some((file) => file.path === input.path)
      ? { value: { repository, sha: input.headSha, path: input.path, context: input.context } }
      : { reason: refused('source_changed') };
  }
  type Plan = Extract<Awaited<ReturnType<typeof plan>>, { value: unknown }>['value'];
  const capture = (superpipe({})('neo-coding-pr-file') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(plan, ['input', 'caller'], 'result:outcome')
    .pipe(
      async (selected: Plan, input: Input, caller: OperationCaller) => {
        const current = async () => {
          const checked = await plan(input, caller);
          return 'value' in checked && JSON.stringify(checked.value) === JSON.stringify(selected);
        };
        const result = await captureGitArtifact(
          database(),
          data,
          selected,
          input.requestId,
          current,
          readGit,
          home
        );
        const checked = await plan(input, caller);
        return 'reason' in checked ? checked.reason : result;
      },
      ['outcome', 'input', 'caller'],
      'outcome'
    )
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<unknown>;
  return defineOperation({
    name: 'neo.coding.pr.file',
    description:
      'Attach a complete PR file as an immutable document, never a diff. Owner Neo only. Pass an ask/todo context, GitHub owner/repo#N or PR URL, listed path, current 40-hex headSha and a stable requestId. Reuse the UUID only for identical inputs; a changed head/path/PR needs a fresh UUID. Returns an ArtifactRef usable in neo.question.ask artifacts. Explain changes in card text.',
    inputSchema,
    resultSchema: z.union([
      ArtifactRefusalSchema,
      z.strictObject({
        accepted: z.literal(false),
        reason: z.literal('size_limit'),
        actualBytes: z.number().int().nonnegative(),
        limitBytes: z.number().int().positive(),
      }),
      z.strictObject({ accepted: z.literal(true), artifact: ArtifactRefSchema }),
    ]),
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: capture,
  });
}
