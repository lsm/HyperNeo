import type { Database } from '../../storage/sqlite-compat.ts';
import type { NeoPackPreferenceDeclaration } from './pack-contract.ts';
import { getNeoPackPreference } from './preferences.ts';

const values = ['long_lived', 'per_ask', 'per_todo'] as const;
export type SessionReuse = (typeof values)[number];

export const SESSION_REUSE_PREFERENCE: NeoPackPreferenceDeclaration = {
  label: { en: 'Session reuse', 'zh-Hans': '会话复用' },
  question: { en: 'How should sessions be reused?', 'zh-Hans': '如何复用会话？' },
  valueLabels: {
    long_lived: { en: 'Long-lived sessions', 'zh-Hans': '长期会话' },
    per_ask: { en: 'One session per matter', 'zh-Hans': '每件事一个会话' },
    per_todo: { en: 'One session per step', 'zh-Hans': '每个步骤一个会话' },
  },
  valueDescriptions: {
    long_lived: {
      en: 'Reuse a free worker in this folder.',
      'zh-Hans': '复用此文件夹中空闲的工作者。',
    },
    per_ask: {
      en: 'Reuse this matter’s worker and wait if it is busy.',
      'zh-Hans': '复用本事项的工作者，忙时等待。',
    },
    per_todo: { en: 'Start a new session for each step.', 'zh-Hans': '每个步骤启动一个新会话。' },
  },
  scope: 'project',
  type: { kind: 'enum', values },
  default: 'long_lived',
  ask: 'How should sessions be reused?',
};

export function sessionReuseFacts(
  db: Database,
  adapter: string,
  todoId: string,
  sessionId: string
) {
  const row = db
    .prepare(`SELECT a.id AS askId, a.project_id AS projectId
    FROM neo_todos t JOIN neo_asks a ON a.id = t.ask_id
    WHERE t.id = ? AND a.session_id = ? AND a.status = 'open'`)
    .get(todoId, sessionId) as { askId: string; projectId: string | null } | null;
  if (!row) return null;
  const scope = row.projectId
    ? { kind: 'project' as const, key: row.projectId }
    : { kind: 'global' as const, key: '' };
  const saved = getNeoPackPreference(db, 'core', scope, 'sessionReuse');
  const mode = values.find((value) => value === saved?.value) ?? 'long_lived';
  const workers = db
    .prepare(`SELECT json_extract(s.ref, '$.id') AS id,
      MAX(COALESCE(t.started_at, t.created_at)) AS usedAt
    FROM neo_todo_sessions s JOIN neo_todos t ON t.id = s.todo_id
    JOIN work_started_sessions w ON w.adapter = json_extract(s.ref, '$.adapter')
      AND w.id = json_extract(s.ref, '$.id') AND w.role = 'worker'
    WHERE t.ask_id = ? AND t.id <> ? AND json_extract(s.ref, '$.adapter') = ?
      AND json_extract(s.ref, '$.daemon') IS NULL AND w.released_at IS NULL
      AND (w.unusable_at IS NULL OR w.unusable_at <= ?)
    GROUP BY w.adapter, w.id ORDER BY usedAt DESC`)
    .all(row.askId, todoId, adapter, Date.now() - 3_600_000) as { id: string }[];
  return { ...row, scope, saved: !!saved, mode, sameAsk: workers.map(({ id }) => id) };
}

export function sessionReuseQuestion(facts: NonNullable<ReturnType<typeof sessionReuseFacts>>) {
  const prefix = `core.sessionReuse:${facts.scope.kind}:${facts.scope.key}:`;
  return {
    askId: facts.askId,
    requestId: `${prefix}${crypto.randomUUID()}`,
    prefix,
    hold: false as const,
    alternatives: values.map((value) => [
      { pack: 'core', scope: facts.scope, key: 'sessionReuse', value },
    ]),
  };
}
