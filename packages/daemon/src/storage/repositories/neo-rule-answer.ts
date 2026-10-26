import type { Database } from '../sqlite-compat.ts';
import { neoStandingRules } from '@hyperneo/shared/types/settings';
import { SettingsRepository } from './settings-repository.ts';
import { planNeoRuleEdit, planNeoRuleSources } from '../../lib/neo/saved-rules.ts';

export function applyNeoRuleAnswer(
  db: Database,
  questionId: string,
  approval?: { sessionId: string; messageId: string }
) {
  return db.transaction(() => {
    const row = db
      .prepare(`SELECT p.edit_json, p.question_text, p.applied_at,
      q.state, q.kind, q.answer, q.answered_by, q.text FROM neo_rule_proposals p
      JOIN neo_questions q ON q.id=p.question_id WHERE p.question_id=?`)
      .get(questionId) as
      | {
          edit_json: string;
          question_text: string;
          applied_at: number | null;
          state: string;
          kind: string;
          answer: string | null;
          answered_by: string | null;
          text: string;
        }
      | undefined;
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
          approval
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
