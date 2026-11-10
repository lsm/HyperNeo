import { neoToolDescription } from '@hyperneo/prompts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { NEO_STANDING_RULE_MAX_CHARS, neoStandingRules } from '@hyperneo/shared/types/settings';
import { applyNeoRuleAnswer } from '../../storage/repositories/neo-rule-answer.ts';
import { defineOperation } from '../operations/registry.ts';
import { openHumanCard } from './human-card.ts';
import { planNeoRuleEdit } from './saved-rules.ts';
import type { NeoService } from './service.ts';

const Rule = z.string().trim().min(1).max(NEO_STANDING_RULE_MAX_CHARS);
const Edit = z
  .object({
    add: z.array(Rule).optional(),
    remove: z.array(Rule).optional(),
  })
  .strict();
const Ask = Edit.extend({ askId: z.string().min(1), requestId: z.string().min(1) }).strict();
const Result = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({ ok: z.literal(true), questionId: z.string().optional() }),
]);
const Apply = z.object({ questionId: z.string().min(1) }).strict();
const fail = (reason: string) => ({ reason: { ok: false as const, reason } });

export function createNeoRuleQuestions(service: NeoService) {
  const db = service.db.getDatabase();
  const store = service.todos;
  const ask = (superpipe({})('neo.rule.ask') as PipelineAPI)
    .input(['input'])
    .pipe(
      (input: z.infer<typeof Ask>) => {
        if (store.getAsk(input.askId)?.status !== 'open') return fail('open_ask_required');
        return { value: input };
      },
      'input',
      'result:proposal'
    )
    .pipe(
      (input: z.infer<typeof Ask>) =>
        db.transaction(() => {
          const edit = Edit.parse({ add: input.add, remove: input.remove });
          const json = JSON.stringify(edit);
          const prior = db
            .prepare(`SELECT p.question_id, p.edit_json, q.ask_id, q.state FROM neo_rule_proposals p
        JOIN neo_questions q ON q.id=p.question_id WHERE p.request_id=?`)
            .get(input.requestId) as
            | { question_id: string; edit_json: string; ask_id: string; state: string }
            | undefined;
          if (prior) {
            if (prior.ask_id !== input.askId || prior.edit_json !== json)
              return { ok: false as const, reason: 'proposal_is_immutable' };
            return prior.state === 'open'
              ? { ok: true as const, questionId: prior.question_id }
              : { ok: false as const, reason: 'question_closed' };
          }
          const valid = planNeoRuleEdit(neoStandingRules(service.db.getGlobalSettings().neo), edit);
          if ('reason' in valid) return valid.reason;
          const questionId = crypto.randomUUID();
          const text = `Apply these standing-rule changes?\n\n${JSON.stringify(edit)}`;
          openHumanCard(
            store,
            questionId,
            input.askId,
            {
              text,
              kind: 'yesno',
              options: null,
              multiple: false,
              noLabel: 'Keep current rules',
              yesLabel: 'Apply these rule changes',
              startTodos: null,
            },
            Date.now()
          );
          db.prepare(`INSERT INTO neo_rule_proposals (question_id, request_id, edit_json, question_text)
        VALUES (?, ?, ?, ?)`).run(questionId, input.requestId, json, text);
          return { ok: true as const, questionId };
        })(),
      'proposal',
      'proposal'
    )
    .endAsync('proposal');
  const apply = (superpipe({})('neo.rule.applyAnswer') as PipelineAPI)
    .input(['input'])
    .pipe(
      (input: z.infer<typeof Apply>) => applyNeoRuleAnswer(db, input.questionId),
      'input',
      'outcome'
    )
    .pipe(
      (result: ReturnType<typeof applyNeoRuleAnswer>) => {
        if (result.ok && result.changed) {
          service.publishSettings?.(service.db.getGlobalSettings());
          service.notifyChanged();
          void service.rulesChanged();
        }
        return result.ok ? { ok: true as const } : result;
      },
      'outcome',
      'outcome'
    )
    .endAsync('outcome');
  return [
    defineOperation({
      name: 'neo.rule.ask',
      description: neoToolDescription('neo.rule.ask'),
      inputSchema: Ask,
      resultSchema: Result,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: ask,
    }),
    defineOperation({
      name: 'neo.rule.applyAnswer',
      description: neoToolDescription('neo.rule.applyAnswer'),
      inputSchema: Apply,
      resultSchema: Result,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: apply,
    }),
  ];
}
