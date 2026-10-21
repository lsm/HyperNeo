import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { isLocalUser } from '../../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../../operations/registry.ts';
import { neoFolderPath } from '../folder.ts';
import { readNeoQuestion } from '../question-operations.ts';
import type { NeoService } from '../service.ts';
import { NeoHomeRepository } from './repository.ts';

const Input = z.union([
  z.object({ askId: z.string().min(1) }).strict(),
  z.object({ questionId: z.string().min(1) }).strict(),
]);
const Result = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({
    ok: z.literal(true),
    status: z.enum(['local', 'proposed', 'created']),
    questionId: z.string().nullable(),
    repository: z.string().nullable(),
  }),
]);
type Proposal = {
  question_id: string | null;
  repository: string | null;
  question_text: string | null;
  state: 'local' | 'proposed' | 'creating' | 'created';
};
const fail = (reason: string) => ({ reason: { ok: false as const, reason } });

export function createNeoHomeGithubOperation(
  service: Pick<NeoService, 'db' | 'repo' | 'todos' | 'defaultSessionId'>,
  home = new NeoHomeRepository(neoFolderPath(), service.repo)
) {
  const db = service.db.getDatabase();
  const prior = () =>
    db.prepare('SELECT * FROM neo_home_github WHERE id=1').get() as Proposal | undefined;
  const receipt = (row: Proposal) =>
    row.state === 'creating'
      ? {
          ok: false as const,
          reason:
            'creation_unconfirmed: reconcile the prior attempt with the human; never replay creation.',
        }
      : {
          ok: true as const,
          status: row.state,
          questionId: row.question_id,
          repository: row.repository,
        };
  const text = (repository: string) =>
    `Create private GitHub repository ${repository} and push this Neo home's committed curated history? Coordinator transcripts stay ignored. No keeps this home local.`;
  const run = (superpipe({})('neo.home.github') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (caller: OperationCaller) =>
        isLocalUser(caller) ||
        (caller.source === 'mcp' &&
          !!caller.sessionId &&
          caller.sessionId === service.defaultSessionId())
          ? { value: caller }
          : fail('root_neo_required'),
      'caller',
      'result:outcome'
    )
    .pipe(
      (input: z.infer<typeof Input>) => {
        if ('questionId' in input) {
          const row = prior();
          const q = service.todos.getQuestion(input.questionId);
          const read = readNeoQuestion(q);
          return row?.question_id === input.questionId &&
            row.repository &&
            q &&
            read.ok &&
            read.answeredByHuman &&
            q.kind === 'yesno' &&
            q.answer === 'yes' &&
            q.answeredAt !== null &&
            q.text === row.question_text &&
            q.text === text(row.repository) &&
            service.todos.getAsk(q.askId)?.sessionId === service.defaultSessionId()
            ? { value: input }
            : fail(
                'confirmation_required: use the bound root-Neo question answered yes by the human.'
              );
        }
        const ask = service.todos.getAsk(input.askId);
        return ask?.status === 'open' &&
          !!service.defaultSessionId() &&
          ask.sessionId === service.defaultSessionId()
          ? { value: input }
          : fail('open_root_ask_required');
      },
      'input',
      'result:outcome'
    )
    .pipe(
      async (input: z.infer<typeof Input>) => {
        let row = prior();
        if ('askId' in input) {
          if (row) return receipt(row);
          const initialized = await home.init();
          if (!initialized.ok) return initialized;
          const available = await home.github(['auth', 'status']).catch(() => null);
          const owner =
            available?.code === 0
              ? await home.github(['api', 'user', '--jq', '.login']).catch(() => null)
              : null;
          return db.transaction(() => {
            const existing = prior();
            if (existing) return receipt(existing);
            if (!owner || owner.code || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner.text)) {
              db.prepare("INSERT INTO neo_home_github (id,state) VALUES (1,'local')").run();
            } else {
              const repository = `${owner.text}/neo-home`;
              const questionId = crypto.randomUUID();
              const body = text(repository);
              service.todos.askQuestion(
                questionId,
                input.askId,
                {
                  text: body,
                  kind: 'yesno',
                  options: null,
                  multiple: false,
                  noLabel: 'Keep local',
                  yesLabel: 'Create private repo',
                  startTodos: null,
                },
                Date.now()
              );
              db.prepare(
                "INSERT INTO neo_home_github (id,question_id,repository,question_text,state) VALUES (?,?,?,?,'proposed')"
              ).run(1, questionId, repository, body);
            }
            return receipt(prior()!);
          })();
        }
        if (row!.state === 'created') return receipt(row!);
        const created = await home.createGithub(
          row!.repository!,
          () =>
            db
              .prepare(
                "UPDATE neo_home_github SET state='creating' WHERE id=1 AND state='proposed'"
              )
              .run().changes === 1
        );
        if (!created.ok) return created;
        db.prepare("UPDATE neo_home_github SET state='created' WHERE id=1").run();
        row = prior()!;
        return receipt(row);
      },
      'outcome',
      'outcome'
    )
    .endAsync('outcome');
  return defineOperation({
    name: 'neo.home.github',
    description:
      'After local setup, propose a private GitHub neo-home once on an open root-Neo ask using askId. Without GitHub it stays local; repeats reuse the stored proposal, including a no. To create and push, pass questionId only: requires the exact daemon-bound human yes. External creation is reserved once; creation_unconfirmed needs human reconciliation and never replays. Does not clone or change existing origin. Root Neo or local human only.',
    inputSchema: Input,
    resultSchema: Result,
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: run,
  });
}
