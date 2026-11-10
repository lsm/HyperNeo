import { SettingsRepository } from './settings-repository.ts';
import { planNeoRelayAnswer, type NeoRelayInput } from '../../lib/neo/relay-plan.ts';
import { enqueueMailboxEntry } from '../../lib/mailbox/enqueue.ts';
import { createMailboxEntry } from '../../lib/mailbox/entry.ts';
import { renderAddress } from '../../lib/mailbox/address.ts';
import { JobQueueRepository } from './job-queue-repository.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';

export type NeoAskInputClaim = {
  sessionId: string;
  messageId: string;
  askId?: string;
  title: string;
  request: string;
};

class NeoAskInputs {
  constructor(private readonly db: Database) {}

  relayAnswer(input: NeoRelayInput) {
    return this.db.transaction(() => {
      const store = new NeoAskTodoRepository(this.db);
      const question = store.getQuestion(input.questionId);
      const links = this.db
        .prepare(`SELECT
        EXISTS(SELECT 1 FROM neo_rule_proposals WHERE question_id=?) AS ruleProposal,
        EXISTS(SELECT 1 FROM neo_pack_preference_proposals WHERE question_id=?) AS preferenceProposal`)
        .get(input.questionId, input.questionId) as {
        ruleProposal: number;
        preferenceProposal: number;
      };
      const plan = planNeoRelayAnswer(
        new SettingsRepository(this.db).getGlobalSettings().neo,
        question
          ? {
              ...question,
              ruleProposal: !!links.ruleProposal,
              preferenceProposal: !!links.preferenceProposal,
            }
          : null,
        input
      );
      if ('reason' in plan) return { reason: { ok: false, reason: plan.reason } };
      const ask = store.getAsk(question!.askId);
      if (!ask)
        return { reason: { ok: false, reason: 'ask_missing: the card’s ask is unavailable.' } };
      const answered = store.answerQuestion(
        question!,
        plan.answer,
        'chat',
        input.at,
        undefined,
        plan.provenance
      );
      if (!answered)
        return {
          reason: { ok: false, reason: 'question_not_open: the card was already answered.' },
        };
      const to = { kind: 'session' as const, sessionId: ask.sessionId };
      const queued = enqueueMailboxEntry(
        new JobQueueRepository(this.db),
        createMailboxEntry({
          to,
          origin: renderAddress(to),
          messageUuid: `neo-relay-answer:${question!.id}`,
          message: {
            type: 'user',
            parent_tool_use_id: null,
            inputKind: 'system',
            neoWakeEvent: true,
            message: {
              content: `Relayed by ${plan.provenance.viaName}, ${input.when}, ${input.where}:\n${input.words}\n\nAnswer to card ${question!.id}: ${question!.text}`,
            },
          },
        })
      );
      if (queued.kind === 'rejected') throw new Error(queued.reason);
      return { value: answered.id };
    })();
  }

  owner(sessionId: string, messageId: string): string | null {
    const row = this.db
      .prepare(`SELECT ask_id AS askId FROM neo_ask_inputs
        WHERE session_id = ? AND message_id = ?
        AND ask_id IN (SELECT id FROM neo_asks WHERE status = 'open')`)
      .get(sessionId, messageId) as { askId: string } | null;
    return row?.askId ?? null;
  }

  claimNeoInputAsk(input: NeoAskInputClaim): string | { reason: string } {
    const store = new NeoAskTodoRepository(this.db);
    const owner =
      store.findAsk(input.sessionId, input.messageId, null)?.id ??
      this.owner(input.sessionId, input.messageId);
    if (owner) return owner;
    const target = input.askId ? store.getAsk(input.askId) : null;
    if (input.askId && target?.sessionId !== input.sessionId)
      return { reason: 'not_owned: this ask is unknown or belongs to another session.' };
    if (input.askId && target?.status !== 'open')
      return { reason: 'ask_settled: this ask is no longer open. Omit askId to open a new card.' };
    const now = Date.now();
    const askId =
      input.askId ??
      store.openAsk({
        id: crypto.randomUUID(),
        projectId: null,
        sessionId: input.sessionId,
        originMessageId: input.messageId,
        title: input.title,
        request: input.request,
        createdAt: now,
      }).id;
    this.db
      .prepare(`INSERT INTO neo_ask_inputs (session_id, message_id, ask_id, bound_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(session_id, message_id) DO UPDATE
        SET ask_id = excluded.ask_id, bound_at = excluded.bound_at`)
      .run(input.sessionId, input.messageId, askId, now);
    return askId;
  }
}

export const neoAskInputReads = defineRepositoryOp('neo.askInputs.read', 'read', NeoAskInputs, [
  'owner',
]);
export const neoAskInputWrites = defineRepositoryOp('neo.askInputs.write', 'write', NeoAskInputs, [
  'claimNeoInputAsk',
  'relayAnswer',
]);
