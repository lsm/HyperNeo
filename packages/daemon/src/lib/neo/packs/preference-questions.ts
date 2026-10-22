import type { LanguageSetting } from '@hyperneo/shared/types/settings';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../../storage/sqlite-compat.ts';
import type { NeoAskTodoRepository } from '../../../storage/repositories/neo-ask-todo-repository.ts';
import { applyPackPreferenceAnswer } from '../../../storage/repositories/pack-preference-answer.ts';
import { defineOperation } from '../../operations/registry.ts';
import { PackPreferenceInput, validatePackPreference } from './preference-operations.ts';
import { formatPreferenceProposal } from './preference-proposal.ts';
import type { NeoPack } from '../pack-contract.ts';

const Ask = z
  .object({
    askId: z.string().min(1),
    requestId: z.string().min(1),
    values: z.array(PackPreferenceInput).min(1).max(20),
  })
  .strict();
const Result = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({ ok: z.literal(true), questionId: z.string().optional() }),
]);
const Apply = z.object({ questionId: z.string().min(1) }).strict();
const fail = (reason: string) => ({ reason: { ok: false as const, reason } });

export function createPackPreferenceQuestions(
  db: Database,
  store: NeoAskTodoRepository,
  packs: () => readonly NeoPack[],
  language: () => LanguageSetting | undefined
) {
  const ask = (superpipe({})('pack.preferences.ask') as PipelineAPI)
    .input(['input'])
    .pipe(
      (input: z.infer<typeof Ask>) => {
        if (store.getAsk(input.askId)?.status !== 'open') return fail('open_ask_required');
        for (const value of input.values) {
          const valid = validatePackPreference(value, packs());
          if ('reason' in valid) return { reason: valid.reason };
        }
        const keys = input.values.map((v) => JSON.stringify([v.pack, v.scope, v.key]));
        return new Set(keys).size === keys.length ? { value: input } : fail('duplicate_setting');
      },
      'input',
      'result:proposal'
    )
    .pipe(
      (input: z.infer<typeof Ask>) =>
        db.transaction(() => {
          const json = JSON.stringify(input.values);
          const prior = db
            .prepare(`SELECT p.question_id, p.values_json, q.ask_id, q.state FROM neo_pack_preference_proposals p
        JOIN neo_questions q ON q.id=p.question_id WHERE p.request_id=?`)
            .get(input.requestId) as
            | { question_id: string; values_json: string; ask_id: string; state: string }
            | undefined;
          if (prior) {
            if (prior.ask_id !== input.askId || prior.values_json !== json)
              return { ok: false as const, reason: 'proposal_is_immutable' };
            return prior.state === 'open'
              ? { ok: true as const, questionId: prior.question_id }
              : { ok: false as const, reason: 'question_closed' };
          }
          const questionId = crypto.randomUUID();
          const { text, noLabel, yesLabel } = formatPreferenceProposal(
            input.values,
            packs(),
            language()
          );
          store.askQuestion(
            questionId,
            input.askId,
            {
              text,
              kind: 'yesno',
              options: null,
              multiple: false,
              noLabel,
              yesLabel,
              startTodos: null,
            },
            Date.now()
          );
          db.prepare(`INSERT INTO neo_pack_preference_proposals (question_id, request_id, values_json, question_text)
        VALUES (?, ?, ?, ?)`).run(questionId, input.requestId, json, text);
          return { ok: true as const, questionId };
        })(),
      'proposal',
      'proposal'
    )
    .endAsync('proposal');
  const apply = (superpipe({})('pack.preferences.applyAnswer') as PipelineAPI)
    .input(['input'])
    .pipe(
      (input: z.infer<typeof Apply>) => applyPackPreferenceAnswer(db, input.questionId),
      'input',
      'outcome'
    )
    .endAsync('outcome');
  return [
    defineOperation({
      name: 'pack.preferences.ask',
      description:
        'Ask the human to apply typed pack settings. The daemon displays and binds this exact immutable proposal; no settings change until human yes. Reuse requestId for pending retries; question_closed means use a new requestId to ask again.',
      inputSchema: Ask,
      resultSchema: Result,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: ask,
    }),
    defineOperation({
      name: 'pack.preferences.applyAnswer',
      description:
        'Retry applying a bound settings question by questionId only. Requires the recorded human yes; accepts no replacement values. Already-applied answers never overwrite later human changes.',
      inputSchema: Apply,
      resultSchema: Result,
      policy: { safetyClass: 'mutate' },
      execute: apply,
    }),
  ];
}
