import { DRAFT_CHAR_LIMIT } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { SQLiteValue } from '../types.ts';

export interface SessionInputDraftSnapshot {
  readonly id: string;
  readonly incarnation: number;
  readonly draft: string | null;
  readonly voicePending: string | null;
}

type DraftWrite = { snapshot: SessionInputDraftSnapshot; text: string | null };
type Refusal = { kind: 'invalid_input_draft_write' };
type SqlWrite = { sql: string; values: readonly SQLiteValue[] };

function validText(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= DRAFT_CHAR_LIMIT);
}

export function sessionInputDraftSnapshotFromRow(
  row: Record<string, unknown>
): SessionInputDraftSnapshot | null {
  if (typeof row.metadata !== 'string') return null;
  try {
    const metadata: unknown = JSON.parse(row.metadata);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const values = metadata as Record<string, unknown>;
    const draft = values.inputDraft ?? null;
    const voicePending = values.inputDraftVoicePending ?? null;
    const snapshot = {
      id: row.id,
      incarnation: row.incarnation,
      draft,
      voicePending,
    } as SessionInputDraftSnapshot;
    const admitted = admitSessionInputDraftWrite(snapshot, draft as string | null);
    return 'value' in admitted ? admitted.value.snapshot : null;
  } catch {
    return null;
  }
}

export function admitSessionInputDraftWrite(
  snapshot: SessionInputDraftSnapshot,
  text: string | null
): { value: DraftWrite } | { reason: Refusal } {
  return snapshot &&
    typeof snapshot.id === 'string' &&
    snapshot.id.length > 0 &&
    snapshot.id.length <= 200 &&
    Number.isSafeInteger(snapshot.incarnation) &&
    snapshot.incarnation > 0 &&
    validText(snapshot.draft) &&
    validText(snapshot.voicePending) &&
    validText(text)
    ? { value: { snapshot, text } }
    : { reason: { kind: 'invalid_input_draft_write' } };
}

function buildSessionInputDraftSql({ snapshot, text }: DraftWrite): SqlWrite {
  const safeMetadata = "CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END";
  const update =
    text === null
      ? "json_remove(metadata, '$.inputDraft')"
      : "json_set(metadata, '$.inputDraft', ?)";
  return {
    sql: `UPDATE sessions SET metadata = ${update}
          WHERE id = ? AND status = 'active' AND archived_at IS NULL AND json_valid(metadata)
            AND json_type(${safeMetadata}) = 'object'
            AND COALESCE(json_type(${safeMetadata}, '$.inputDraft'), 'null') IN ('null', 'text')
            AND COALESCE(json_type(${safeMetadata}, '$.inputDraftVoicePending'), 'null') IN ('null', 'text')
            AND json_extract(${safeMetadata}, '$.inputDraft') IS ?
            AND json_extract(${safeMetadata}, '$.inputDraftVoicePending') IS ?
            AND EXISTS (SELECT 1 FROM session_incarnations i
                        WHERE i.session_id = sessions.id AND i.incarnation = ?)`,
    values: [
      ...(text === null ? [] : [text]),
      snapshot.id,
      snapshot.draft,
      snapshot.voicePending,
      snapshot.incarnation,
    ],
  };
}

export const planSessionInputDraftWrite = (
  superpipe({})('session-input-draft-conditional-write') as PipelineAPI
)
  .input(['snapshot', 'text'])
  .pipe(admitSessionInputDraftWrite, ['snapshot', 'text'], 'result:write')
  .pipe(buildSessionInputDraftSql, 'write', 'write')
  .end('write') as (snapshot: SessionInputDraftSnapshot, text: string | null) => SqlWrite | Refusal;
