import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { Database } from '../sqlite-compat.ts';
import { neoStandingRules } from '@hyperneo/shared/types/settings';
import { SettingsRepository } from './settings-repository.ts';
import { planNeoRuleEdit, planNeoRuleSources } from '../../lib/neo/saved-rules.ts';

function readNeoRuleProposal(db: Database, questionId: string) {
  const row = db
    .prepare(`SELECT p.edit_json, p.question_text, p.applied_at,
      q.state, q.kind, q.answer, q.answered_by, q.text, a.session_id FROM neo_rule_proposals p
      JOIN neo_questions q ON q.id=p.question_id JOIN neo_asks a ON a.id=q.ask_id WHERE p.question_id=?`)
    .get(questionId) as
    | {
        edit_json: string;
        session_id: string;
        question_text: string;
        applied_at: number | null;
        state: string;
        kind: string;
        answer: string | null;
        answered_by: string | null;
        text: string;
      }
    | undefined;
  return row;
}

export function applyNeoRuleAnswer(
  db: Database,
  questionId: string,
  approval?: { sessionId: string; messageId: string }
) {
  return db.transaction(() => {
    const row = readNeoRuleProposal(db, questionId);
    if (!row) return { ok: false as const, reason: 'no_bound_proposal' };
    if (row.applied_at !== null) return { ok: true as const, changed: false };
    if (
      row.state !== 'answered' ||
      row.kind !== 'yesno' ||
      row.answer !== JSON.stringify('yes') ||
      !['button', 'chat'].includes(row.answered_by ?? '')
    )
      return { ok: false as const, reason: 'human_yes_required' };
    if (row.text !== row.question_text) throw new Error('proposal_question_changed');
    const settings = new SettingsRepository(db);
    const current = settings.getGlobalSettings();
    const edit = JSON.parse(row.edit_json) as { add?: string[]; remove?: string[] };
    const plan = planNeoRuleEdit(neoStandingRules(current.neo), edit);
    if ('reason' in plan) return plan.reason;
    settings.updateGlobalSettings({
      neo: {
        ...current.neo,
        standingRules: plan.value,
        standingRuleSources: planNeoRuleSources(
          plan.value,
          current.neo?.standingRuleSources,
          edit.add,
          approval ?? { questionId }
        ),
      },
    });
    const now = Date.now();
    db.prepare('UPDATE neo_rule_proposals SET applied_at=? WHERE question_id=?').run(
      now,
      questionId
    );
    return { ok: true as const, changed: true };
  })();
}

export function readNeoRuleApproval(
  db: Database,
  human: NeoConversationAsk | null,
  edit: { add?: readonly string[]; remove?: readonly string[] }
): false | { applied: boolean } {
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
  const proposal = readNeoRuleProposal(db, human.replyTo.id);
  if (
    !proposal ||
    proposal.session_id !== human.askOrigin.sessionId ||
    proposal.state !== 'answered' ||
    proposal.kind !== 'yesno' ||
    proposal.answered_by !== 'chat' ||
    proposal.answer !== JSON.stringify('yes') ||
    proposal.text !== proposal.question_text
  )
    return false;
  const approved = JSON.parse(proposal.edit_json) as { add?: string[]; remove?: string[] };
  return JSON.stringify(edit.add ?? []) === JSON.stringify(approved.add ?? []) &&
    JSON.stringify(edit.remove ?? []) === JSON.stringify(approved.remove ?? [])
    ? { applied: proposal.applied_at !== null }
    : false;
}
