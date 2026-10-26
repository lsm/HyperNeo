import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { Database } from '../../storage/sqlite-compat.ts';

type NeoRuleRefusal = { reason: { ok: false; reason: string } };
const refuseRule = (reason: string): NeoRuleRefusal => ({ reason: { ok: false, reason } });

export function planNeoRuleEdit(
  current: readonly string[],
  edit: { add?: readonly string[]; remove?: readonly string[] }
): { value: string[] } | NeoRuleRefusal {
  const add = edit.add ?? [];
  const remove = edit.remove ?? [];
  if (!add.length && !remove.length) return refuseRule('Name a rule to add or remove.');
  const missing = remove.find((rule) => !current.includes(rule));
  if (missing !== undefined)
    return refuseRule(
      `"${missing}" is not a saved rule. Remove a rule by its exact text from neo.snapshot standingRules.`
    );
  const kept = current.filter((rule) => !remove.includes(rule));
  const rules = [...kept, ...[...new Set(add)].filter((rule) => !kept.includes(rule))];
  return { value: rules };
}

export function planNeoRuleSources(
  rules: readonly string[],
  current: Record<string, { sessionId: string; messageId: string }> = {},
  add: readonly string[] = [],
  approval?: { sessionId: string; messageId: string }
): Record<string, { sessionId: string; messageId: string }> {
  return Object.fromEntries([
    ...Object.entries(current).filter(([rule]) => rules.includes(rule)),
    ...(approval ? add.filter((rule) => rules.includes(rule)).map((rule) => [rule, approval]) : []),
  ]);
}

export function neoRuleApprovalMatches(
  db: Database,
  human: NeoConversationAsk | null,
  edit: { add?: readonly string[]; remove?: readonly string[] }
): boolean {
  if (human?.replyTo?.kind !== 'question') return false;
  const words =
    typeof human.content === 'string'
      ? human.content
      : human.content
          .flatMap((part: { type: string; text?: string }) =>
            part.type === 'text' ? [part.text] : []
          )
          .join(' ');
  if (words.trim() !== 'yes') return false;
  const proposal = db
    .prepare(`SELECT p.edit_json FROM neo_rule_proposals p
    JOIN neo_questions q ON q.id=p.question_id JOIN neo_asks a ON a.id=q.ask_id
    WHERE q.id=? AND a.session_id=? AND q.state='answered' AND q.kind='yesno'
      AND q.answered_by='chat' AND q.answer='"yes"' AND q.text=p.question_text`)
    .get(human.replyTo.id, human.askOrigin.sessionId) as { edit_json: string } | undefined;
  if (!proposal) return false;
  const approved = JSON.parse(proposal.edit_json) as { add?: string[]; remove?: string[] };
  return (
    JSON.stringify(edit.add ?? []) === JSON.stringify(approved.add ?? []) &&
    JSON.stringify(edit.remove ?? []) === JSON.stringify(approved.remove ?? [])
  );
}
