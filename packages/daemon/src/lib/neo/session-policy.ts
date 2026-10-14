import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { Database } from '../../storage/database.ts';
import type { Session } from '@hyperneo/shared';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import superpipe, { type PipelineAPI } from 'superpipe';
import { invokeOperation, type OperationOutcome } from '../operations/invoke.ts';
import type { OperationRegistry } from '../operations/registry.ts';
import { getDataDir } from '../data-dir.ts';
import { OPERATIONS_MCP_SERVER_NAME } from '../mcp/built-in-servers.ts';
import { getSDKProjectDir } from '../sdk-session-file-manager.ts';
import { readNeoCatchUp, readNeoHolderView } from './catch-up.ts';
import { neoFolderPath } from './folder.ts';
import { neoSecretReadRules, neoToolGuard } from './look-up-guard.ts';
import { neoSettingsPackBriefs } from './packs/index.ts';
import type { NeoPackBrief } from './packs/types.ts';
import { neoPrompt } from './prompt.ts';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

function sdkTranscriptsExist(cwd: string): boolean {
  return [cwd, `/private${cwd}`].some((path) => existsSync(getSDKProjectDir(path)));
}

export function neoCoordinatorRuntimePath(sessionId: string): string {
  const legacy = join(tmpdir(), 'hyperneo-neo-context', sessionId.replace(/[^a-zA-Z0-9-]/g, '-'));
  return sdkTranscriptsExist(legacy)
    ? legacy
    : join(neoFolderPath(), '.coordinators', sessionId.replace(/[^a-zA-Z0-9-]/g, '-'));
}

export function sessionSdkPath(
  db: Database | undefined,
  session: Pick<Session, 'id' | 'workspacePath' | 'worktree'>
): string | null {
  return neoCoordinatorBinding(db, session.id)
    ? neoCoordinatorRuntimePath(session.id)
    : (session.worktree?.worktreePath ?? session.workspacePath);
}

export function neoCoordinatorBinding(
  db: Pick<Database, 'getDatabase'> | undefined,
  sessionId: string
): NeoBinding | null {
  if (!sessionId.startsWith('neo:') || !db) return null;
  const row = db
    .getDatabase()
    .prepare(
      "SELECT session_id AS sessionId, concern_id AS projectId, kind FROM neo_session_bindings WHERE session_id = ? AND kind IN ('neo', 'project')"
    )
    .get(sessionId) as NeoBinding | null;
  return row ?? null;
}

export function neoQueryContext(binding: NeoBinding, db: Database | undefined): string {
  const neoDb = db?.getDatabase();
  if (!neoDb) return '';
  return binding.kind === 'neo' ? readNeoCatchUp(neoDb) : readNeoHolderView(neoDb);
}

export function isNeoProjectSession(db: Database | undefined, sessionId: string): boolean {
  return neoCoordinatorBinding(db, sessionId)?.kind === 'project';
}

function renderNeoProjectSnapshot(outcome: OperationOutcome): string {
  if (
    outcome.kind !== 'completed' ||
    !outcome.value ||
    typeof outcome.value !== 'object' ||
    !('ok' in outcome.value) ||
    outcome.value.ok !== true ||
    'unchanged' in outcome.value
  )
    throw new Error('Could not read the fresh Neo project snapshot.');
  return `Current project snapshot from the daemon (authoritative for this fresh turn):\n${JSON.stringify(outcome.value)}`;
}

export const readNeoProjectSnapshot = (superpipe({})('neo-project-query-snapshot') as PipelineAPI)
  .input(['registry', 'sessionId'])
  .pipe(
    (registry: OperationRegistry, sessionId: string) =>
      invokeOperation(registry, 'neo.snapshot', {}, { source: 'mcp', sessionId }),
    ['registry', 'sessionId'],
    'snapshot'
  )
  .pipe(renderNeoProjectSnapshot, 'snapshot', 'context')
  .endAsync('context') as (registry: OperationRegistry, sessionId: string) => Promise<string>;

const NEO_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  'Bash',
];

export function neoCoordinatorDeniedReads(): string[] {
  return neoSecretReadRules();
}

export function neoCoordinatorNativeTools(projectId: string | null): string[] {
  return projectId ? ['AskUserQuestion', ...NEO_TOOLS] : [...NEO_TOOLS];
}

export function neoCoordinatorAllowedTools(projectId: string | null): string[] {
  return [...neoCoordinatorNativeTools(projectId), `mcp__${OPERATIONS_MCP_SERVER_NAME}__invoke`];
}

export function restrictNeoQuery(
  options: Options,
  projectId: string | null = null,
  sessionId?: string,
  catchUp = '',
  packs: readonly NeoPackBrief[] = neoSettingsPackBriefs()
): void {
  if (sessionId) {
    options.cwd = neoCoordinatorRuntimePath(sessionId);
    mkdirSync(options.cwd, { recursive: true });
  }
  const prompt = neoPrompt(projectId, packs);
  options.systemPrompt = {
    type: 'custom',
    prompt: catchUp ? `${prompt}\n\n${catchUp}` : prompt,
    snapshot: false,
  };
  const operations = options.mcpServers?.[OPERATIONS_MCP_SERVER_NAME];
  options.tools = neoCoordinatorNativeTools(projectId);
  options.additionalDirectories = [homedir()];
  options.agents = {};
  delete options.agent;
  options.plugins = [];
  options.settingSources = [];
  options.mcpServers = operations ? { [OPERATIONS_MCP_SERVER_NAME]: operations } : {};
  options.allowedTools = neoCoordinatorAllowedTools(projectId);
  options.disallowedTools = [...(options.disallowedTools ?? []), ...neoCoordinatorDeniedReads()];
  options.hooks = {
    ...options.hooks,
    PreToolUse: [
      {
        hooks: [
          neoToolGuard({
            home: homedir(),
            dataDir: getDataDir(),
            own: options.cwd ? [options.cwd] : [],
          }),
        ],
      },
      ...(options.hooks?.PreToolUse ?? []),
    ],
  };
}
