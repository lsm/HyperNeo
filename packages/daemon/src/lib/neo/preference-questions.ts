import { neoToolDescription } from '@hyperneo/prompts';
import type { LanguageSetting } from '@hyperneo/shared/types/settings';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../storage/sqlite-compat.ts';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import { applyPackPreferenceAnswer } from '../../storage/repositories/pack-preference-answer.ts';
import { defineOperation } from '../operations/registry.ts';
import { choiceCard, openHumanCard } from './human-card.ts';
import { PackPreferenceInput, validatePackPreference } from './preference-operations.ts';
import { formatPreferenceChoice, formatPreferenceProposal } from './preference-proposal.ts';
import { getNeoPackPreference } from './preferences.ts';
import type { NeoPack } from './pack-contract.ts';

const Values = z.array(PackPreferenceInput).min(1).max(20);
const Ask = z
  .object({
    askId: z.string().min(1),
    requestId: z.string().min(1),
    values: Values.optional(),
    alternatives: z.array(Values).min(2).max(5).optional(),
    hold: z.literal(false).optional(),
  })
  .strict()
  .refine((input) => !input.values !== !input.alternatives, 'values_or_alternatives');
const Result = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({ ok: z.literal(true), questionId: z.string().optional() }),
]);
const Apply = z.object({ questionId: z.string().min(1) }).strict();
const fail = (reason: string) => ({ reason: { ok: false as const, reason } });

function cardLanguage(db: Database, language: LanguageSetting | undefined): LanguageSetting {
  if (language && language !== 'system') return language;
  const row = db
    .prepare(`SELECT payload_json AS payload FROM neo_conversation_asks
    ORDER BY sequence DESC LIMIT 1`)
    .get() as { payload: string } | null;
  const content = row ? (JSON.parse(row.payload) as { content?: unknown }).content : '';
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  return /[\u3400-\u9fff]/u.test(text) ? 'zh-Hans' : 'en';
}

export function createPackPreferenceQuestions(
  db: Database,
  store: NeoAskTodoRepository,
  packs: () => readonly NeoPack[],
  language: () => LanguageSetting | undefined,
  refresh: () => Promise<void>
) {
  const ask = (superpipe({})('pack.preferences.ask') as PipelineAPI)
    .input(['input'])
    .pipe(
      (input: z.infer<typeof Ask>) => {
        if (store.getAsk(input.askId)?.status !== 'open') return fail('open_ask_required');
        for (const values of input.alternatives ?? [input.values!]) {
          for (const value of values) {
            const valid = validatePackPreference(value, packs());
            if ('reason' in valid) return { reason: valid.reason };
          }
          const keys = values.map((v) => JSON.stringify([v.pack, v.scope, v.key]));
          if (new Set(keys).size !== keys.length) return fail('duplicate_setting');
        }
        const options = input.alternatives?.map((values) => JSON.stringify(values)) ?? [];
        return new Set(options).size === options.length
          ? { value: input }
          : fail('duplicate_alternative');
      },
      'input',
      'result:proposal'
    )
    .pipe(
      (input: z.infer<typeof Ask>) =>
        db.transaction(() => {
          const json = JSON.stringify(
            input.hold === false
              ? { values: input.values, alternatives: input.alternatives, hold: false }
              : input.alternatives
                ? { alternatives: input.alternatives }
                : input.values
          );
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
          const card = input.alternatives
            ? formatPreferenceChoice(
                input.alternatives,
                packs(),
                cardLanguage(db, language()),
                input.alternatives
                  .flat()
                  .some((entry) => getNeoPackPreference(db, entry.pack, entry.scope, entry.key))
              )
            : formatPreferenceProposal(input.values!, packs(), language());
          const options =
            'options' in card ? [...card.options, card.keep] : [card.apply, card.keep];
          if (new Set(options).size !== options.length)
            return { ok: false as const, reason: 'duplicate_alternative' };
          const { text } = card;
          const draft = choiceCard(text, options);
          openHumanCard(
            store,
            questionId,
            input.askId,
            input.hold === false ? { ...draft, todos: [] } : draft,
            Date.now()
          );
          db.prepare(`INSERT INTO neo_pack_preference_proposals (question_id, request_id, values_json, question_text)
        VALUES (?, ?, ?, ?)`).run(questionId, input.requestId, json, text);
          return { ok: true as const, questionId };
        }, 'immediate')(),
      'proposal',
      'proposal'
    )
    .endAsync('proposal');
  const apply = (superpipe({})('pack.preferences.applyAnswer') as PipelineAPI)
    .input(['input'])
    .pipe(
      async (input: z.infer<typeof Apply>) => {
        const result = applyPackPreferenceAnswer(db, input.questionId);
        if (!result.ok) return result;
        if (result.applied) await refresh();
        return { ok: true as const };
      },
      'input',
      'outcome'
    )
    .endAsync('outcome');
  return [
    defineOperation({
      name: 'pack.preferences.ask',
      description: neoToolDescription('pack.preferences.ask'),
      inputSchema: Ask,
      resultSchema: Result,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: ask,
    }),
    defineOperation({
      name: 'pack.preferences.applyAnswer',
      description: neoToolDescription('pack.preferences.applyAnswer'),
      inputSchema: Apply,
      resultSchema: Result,
      policy: { safetyClass: 'mutate' },
      execute: apply,
    }),
  ];
}
