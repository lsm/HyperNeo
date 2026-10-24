import type { Database } from '../sqlite-compat.ts';
import type { NeoPackSetting } from '@hyperneo/shared/types/neo-snapshot';

export function applyPackPreferenceAnswer(db: Database, questionId: string) {
  return db.transaction(() => {
    const row = db
      .prepare(`SELECT p.values_json, p.question_text, p.applied_at,
      q.state, q.kind, q.answer, q.answered_by, q.text FROM neo_pack_preference_proposals p
      JOIN neo_questions q ON q.id=p.question_id WHERE p.question_id=?`)
      .get(questionId) as
      | {
          values_json: string;
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
    if (row.applied_at !== null) return { ok: true as const };
    const values = JSON.parse(row.values_json) as NeoPackSetting[];
    const optOut = values.filter(
      (v) => v.pack === 'coding' && v.key === 'provenance' && v.value === true
    );
    const no = row.answer === JSON.stringify('no') && optOut.length > 0;
    if (
      row.state !== 'answered' ||
      row.kind !== 'yesno' ||
      (row.answer !== JSON.stringify('yes') && !no) ||
      !['button', 'chat'].includes(row.answered_by ?? '')
    )
      return { ok: false as const, reason: 'human_yes_required' };
    if (row.text !== row.question_text) throw new Error('proposal_question_changed');
    const insert = db.prepare(`INSERT INTO neo_pack_preferences
      (pack, scope_kind, scope_key, key, value_json, set_by, set_at) VALUES (?, ?, ?, ?, ?, 'human', ?)
      ON CONFLICT(pack, scope_kind, scope_key, key) DO UPDATE SET
      value_json=excluded.value_json, set_by=excluded.set_by, set_at=excluded.set_at`);
    const now = Date.now();
    for (const value of no ? optOut : values)
      insert.run(
        value.pack,
        value.scope.kind,
        value.scope.key,
        value.key,
        JSON.stringify(no ? false : value.value),
        now
      );
    db.prepare('UPDATE neo_pack_preference_proposals SET applied_at=? WHERE question_id=?').run(
      now,
      questionId
    );
    return { ok: true as const };
  })();
}
