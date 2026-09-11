const SPACE_ATTACHMENT_COLUMNS = [
  'workflow_run_id',
  'preferred_workflow_id',
  'goal_id',
  'evolution_scope_id',
  'workspace_path',
  'task_agent_session_id',
  'post_approval_session_id',
] as const;

export function buildStandaloneTaskTableSql(createSql: string): string {
  let sql = createSql.replace(
    /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"space_tasks"|`space_tasks`|\[space_tasks\]|space_tasks)\s*\(/i,
    'CREATE TABLE "task_ownership_rebuild" ('
  );
  if (sql === createSql) throw new Error('Expected space_tasks CREATE TABLE definition');
  for (const [column, type] of [
    ['space_id', 'TEXT'],
    ['task_number', 'INTEGER'],
  ] as const) {
    const pattern = new RegExp(
      `([,(]\\s*)(?:"${column}"|\`${column}\`|\\[${column}\\]|${column})\\s+${type}\\s+NOT\\s+NULL\\b`,
      'i'
    );
    if (!pattern.test(sql)) throw new Error(`Expected non-null ${column} column`);
    sql = sql.replace(pattern, `$1"${column}" ${type}`);
  }
  const ownershipCheck =
    'CHECK ((space_id IS NULL AND task_number IS NULL) OR (space_id IS NOT NULL AND task_number IS NOT NULL))';
  const attachmentCheck = `CHECK (space_id IS NOT NULL OR (${SPACE_ATTACHMENT_COLUMNS.map((column) => `${column} IS NULL`).join(' AND ')}))`;
  if (!/\)\s*;?\s*$/.test(sql)) throw new Error('Expected closing task table definition');
  return sql.replace(/\)\s*;?\s*$/, `,\n${ownershipCheck},\n${attachmentCheck}\n)`);
}
