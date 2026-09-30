import type { SQLiteValue } from '../types.ts';
export const ACP_METADATA_CLEAR_PATHS = ['$.acpContextUsageEstimate', '$.acpSessionCommand'];

export interface SessionRuntimeSettingsSnapshot {
  readonly id: string;
  readonly incarnation: number;
  readonly config: string;
  readonly metadata: string;
  readonly sessionContext: string | null;
  readonly status: string;
  readonly type: string;
  readonly archivedAt: string | null;
  readonly processingState: string | null;
  readonly parentId: string | null;
  readonly workspacePath: string | null;
  readonly isWorktree: number;
  readonly worktreePath: string | null;
  readonly mainRepoPath: string | null;
  readonly worktreeBranch: string | null;
  readonly sdkSessionId: string | null;
  readonly acpSessionId: string | null;
  readonly sdkOriginPath: string | null;
}

export interface RuntimeSettingsPatch {
  readonly model?: string;
  readonly provider?: string;
  readonly thinkingLevel?: string;
  readonly clearAcpSession?: boolean;
  readonly clearSdkSession?: boolean;
}

export interface RuntimeSettingsPatchPlan {
  readonly configEntries: ReadonlyArray<readonly [path: string, value: string]>;
  readonly clearAcpMetadata: boolean;
  readonly clearAcpSession: boolean;
  readonly clearSdkSession: boolean;
}

export interface SessionRuntimeSettingsWrite {
  readonly sql: string;
  readonly values: readonly SQLiteValue[];
}

const INCARNATION_GUARD =
  'EXISTS (SELECT 1 FROM session_incarnations i WHERE i.session_id = sessions.id AND i.incarnation = ?)';

const quoteAll = (paths: readonly string[]): string => paths.map((path) => `'${path}'`).join(', ');

const CONFIG_KEYS = ['model', 'provider', 'thinkingLevel'] as const;
const CONFIG_PATH_BY_KEY = {
  model: '$.model',
  provider: '$.provider',
  thinkingLevel: '$.thinkingLevel',
} as const;

export const GUARDED_BY_COLUMN: Readonly<Record<string, keyof SessionRuntimeSettingsSnapshot>> = {
  config: 'config',
  metadata: 'metadata',
  session_context: 'sessionContext',
  status: 'status',
  type: 'type',
  archived_at: 'archivedAt',
  processing_state: 'processingState',
  parent_id: 'parentId',
  workspace_path: 'workspacePath',
  is_worktree: 'isWorktree',
  worktree_path: 'worktreePath',
  main_repo_path: 'mainRepoPath',
  worktree_branch: 'worktreeBranch',
  sdk_session_id: 'sdkSessionId',
  acp_session_id: 'acpSessionId',
  sdk_origin_path: 'sdkOriginPath',
};

function rawText(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string')
    throw new Error(`session runtime settings capture: ${column} is not text`);
  return value;
}

function requiredText(row: Record<string, unknown>, column: string): string {
  const value = rawText(row, column);
  if (value === null) throw new Error(`session runtime settings capture: missing ${column}`);
  return value;
}

function assertJsonObject(column: string, raw: string): void {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(`session runtime settings capture: ${column} is not a JSON object`);
}

export function sessionRuntimeSettingsSnapshotFromRow(
  row: Record<string, unknown>
): SessionRuntimeSettingsSnapshot {
  const id = requiredText(row, 'id');
  const incarnation = row.incarnation;
  if (typeof incarnation !== 'number' || !Number.isSafeInteger(incarnation) || incarnation < 1)
    throw new Error(`session runtime settings capture: missing insertion evidence for ${id}`);
  const config = requiredText(row, 'config');
  const metadata = requiredText(row, 'metadata');
  assertJsonObject('config', config);
  assertJsonObject('metadata', metadata);
  const isWorktree = row.is_worktree;
  if (typeof isWorktree !== 'number' || !Number.isInteger(isWorktree))
    throw new Error(`session runtime settings capture: is_worktree is not an integer for ${id}`);
  return {
    id,
    incarnation,
    config,
    metadata,
    sessionContext: rawText(row, 'session_context'),
    status: requiredText(row, 'status'),
    type: requiredText(row, 'type'),
    archivedAt: rawText(row, 'archived_at'),
    processingState: rawText(row, 'processing_state'),
    parentId: rawText(row, 'parent_id'),
    workspacePath: rawText(row, 'workspace_path'),
    isWorktree,
    worktreePath: rawText(row, 'worktree_path'),
    mainRepoPath: rawText(row, 'main_repo_path'),
    worktreeBranch: rawText(row, 'worktree_branch'),
    sdkSessionId: rawText(row, 'sdk_session_id'),
    acpSessionId: rawText(row, 'acp_session_id'),
    sdkOriginPath: rawText(row, 'sdk_origin_path'),
  };
}

export function planRuntimeSettingsPatch(patch: RuntimeSettingsPatch): RuntimeSettingsPatchPlan {
  const configEntries: Array<readonly [string, string]> = [];
  for (const key of CONFIG_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length === 0)
      throw new Error(`runtime settings write: ${key} must be a non-empty string`);
    configEntries.push([CONFIG_PATH_BY_KEY[key], value]);
  }
  if (configEntries.length === 0) throw new Error('runtime settings write: nothing to write');
  const clearAcpSession = patch.clearAcpSession === true;
  return {
    configEntries,
    clearAcpMetadata: clearAcpSession,
    clearAcpSession,
    clearSdkSession: patch.clearSdkSession === true,
  };
}

export function buildSessionRuntimeSettingsWrite(
  snapshot: SessionRuntimeSettingsSnapshot,
  plan: RuntimeSettingsPatchPlan
): SessionRuntimeSettingsWrite {
  if (plan.configEntries.length === 0) throw new Error('runtime settings write: empty patch plan');
  const paths = plan.configEntries.map(([path]) => `'${path}', ?`).join(', ');
  const sets = [`config = json_set(config, ${paths})`];
  const values: SQLiteValue[] = plan.configEntries.map(([, value]) => value);
  if (plan.clearAcpMetadata)
    sets.push(`metadata = json_remove(metadata, ${quoteAll(ACP_METADATA_CLEAR_PATHS)})`);
  if (plan.clearAcpSession) sets.push('acp_session_id = NULL');
  if (plan.clearSdkSession) sets.push('sdk_session_id = NULL', 'sdk_origin_path = NULL');
  values.push(snapshot.id);
  const guards: string[] = [];
  for (const column of Object.keys(GUARDED_BY_COLUMN)) {
    guards.push(`${column} IS ?`);
    values.push(snapshot[GUARDED_BY_COLUMN[column]]);
  }
  guards.push(INCARNATION_GUARD);
  values.push(snapshot.incarnation);
  return {
    sql: `UPDATE sessions SET ${sets.join(', ')} WHERE id = ? AND ${guards.join(' AND ')}`,
    values,
  };
}
