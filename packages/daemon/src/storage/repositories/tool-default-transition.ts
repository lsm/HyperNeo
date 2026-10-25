import type {
  SessionToolChoiceKey,
  SessionToolSelection,
} from '@hyperneo/shared/types/session-tool-choice';
import { isDeepStrictEqual } from 'node:util';
import superpipe, { type PipelineAPI } from 'superpipe';
import { ChangeRecorder, defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import { SpaceRepository } from './space-repository.ts';
import { McpEnablementRepository } from './mcp-enablement-repository.ts';
import {
  captureToolPreferenceRow,
  commitToolPreferenceRows,
  commitToolDefaultUpdate,
} from './tool-preference-commit.ts';
import { projectLegacyToolDefaultUpdate } from '../../lib/tools/legacy-tool-preferences.ts';
import { projectLegacySessionToolSelection } from '../../lib/tools/session-tool-choice.ts';
import { SkillRepository } from './skill-repository.ts';
import { AppMcpServerRepository } from './app-mcp-server-repository.ts';

type Calls<R, K extends keyof R> = {
  [M in K]: R[M] extends (...args: infer A) => unknown ? { method: M; args: A } : never;
}[K];
export type ToolDefaultMutation =
  | ({ repository: 'skills' } & Calls<
      SkillRepository,
      'insert' | 'update' | 'delete' | 'setEnabled' | 'setValidationStatus'
    >)
  | ({ repository: 'registry' } & Calls<AppMcpServerRepository, 'create' | 'update' | 'delete'>)
  | { repository: 'overrides'; method: 'setOverride'; args: ['space', string, string, boolean] }
  | { repository: 'overrides'; method: 'clearOverride'; args: ['space', string, string] };
export interface ToolDefaultTransition {
  spaceId?: string;
  mutations: ToolDefaultMutation[];
  edits: Array<{ key: SessionToolChoiceKey; selected: boolean | null }>;
}

export type ToolDefaultTransitionResult =
  | { ok: true; results: unknown[]; changed: boolean }
  | {
      ok: false;
      reason: 'default_target_not_found' | 'selection_version_unsupported' | 'superseded';
    };

const methods = {
  skills: ['insert', 'update', 'delete', 'setEnabled', 'setValidationStatus'],
  registry: ['create', 'update', 'delete'],
  overrides: ['setOverride', 'clearOverride'],
};
function capture(db: Database, request: ToolDefaultTransition) {
  const local = new ChangeRecorder();
  const changes = local as unknown as ReactiveDatabase;
  const repos = {
    skills: new SkillRepository(db, changes),
    registry: new AppMcpServerRepository(db, changes),
    overrides: new McpEnablementRepository(db, changes),
  };
  const global = captureToolPreferenceRow(db, { table: 'global_settings', id: 1 });
  const targets = request.spaceId
    ? [captureToolPreferenceRow(db, { table: 'spaces', id: request.spaceId })]
    : [
        global,
        ...new SpaceRepository(db)
          .listSpaces(true)
          .map((space) => captureToolPreferenceRow(db, { table: 'spaces', id: space.id })),
      ];
  const sources =
    request.spaceId && request.edits.some((edit) => edit.selected === null)
      ? [global, ...targets]
      : targets;
  const defaults = new Map<string | number, SessionToolSelection | undefined>();
  for (const target of sources) {
    if (!target.row) return { reason: { ok: false, reason: 'default_target_not_found' } };
    const config = JSON.parse(
      String(target.row[target.key.table === 'spaces' ? 'config' : 'settings'] ?? '{}')
    );
    if (!config || typeof config !== 'object' || Array.isArray(config))
      throw new Error('Tool defaults must contain a JSON object');
    if (
      Object.hasOwn(config, 'toolSelectionDefaults') &&
      (!config.toolSelectionDefaults || config.toolSelectionDefaults.version !== 1)
    )
      return { reason: { ok: false, reason: 'selection_version_unsupported' } };
    defaults.set(target.key.id, config.toolSelectionDefaults);
  }
  return { value: { repos, local, targets, defaults, before: catalog(repos) } };
}
function catalog(repos: {
  skills: SkillRepository;
  registry: AppMcpServerRepository;
  overrides: McpEnablementRepository;
}) {
  return {
    skills: repos.skills.findAll(),
    registry: repos.registry.list(),
    overrides: repos.overrides.listAll().filter((override) => override.scopeType === 'space'),
  };
}
type Prepared = Extract<ReturnType<typeof capture>, { value: unknown }>['value'];
function commit(
  prepared: Prepared,
  db: Database,
  request: ToolDefaultTransition,
  changes: ChangeRecorder
) {
  const results: unknown[] = [];
  const outcome = commitToolPreferenceRows(db, prepared.targets, () => {
    for (const mutation of request.mutations) {
      if ((mutation.repository === 'overrides') !== !!request.spaceId)
        throw new Error('Default mutation scope mismatch');
      if (!methods[mutation.repository].includes(mutation.method))
        throw new Error('Unsupported default mutation');
      if (
        mutation.repository === 'overrides' &&
        (mutation.args[0] !== 'space' || mutation.args[1] !== request.spaceId)
      )
        throw new Error('Space override scope mismatch');
      const repo = prepared.repos[mutation.repository] as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      if (
        mutation.repository === 'skills' &&
        mutation.method !== 'insert' &&
        !prepared.repos.skills.get(mutation.args[0])
      )
        return false;
      const result = repo[mutation.method](...mutation.args);
      if ((result === false && mutation.method !== 'clearOverride') || result === null)
        return false;
      results.push(result);
    }
    const after = catalog(prepared.repos);
    const inherited =
      prepared.defaults.get(1) ??
      projectLegacySessionToolSelection({
        ...prepared.before,
        session: { id: 'defaults:global' },
        overrides: [],
      });
    for (const target of prepared.targets) {
      const spaceId = target.key.table === 'spaces' ? target.key.id : undefined;
      const session = {
        id: `defaults:${spaceId ?? 'global'}`,
        context: spaceId ? { spaceId } : {},
      };
      const edits = request.edits
        .filter(
          (edit) =>
            request.spaceId ||
            !spaceId ||
            !prepared.before.overrides.some(
              (override) => override.scopeId === spaceId && `mcp:${override.serverId}` === edit.key
            )
        )
        .map((edit) => ({
          key: edit.key,
          selected: edit.selected ?? !!inherited.choices[edit.key]?.selected,
        }));
      const projection = projectLegacyToolDefaultUpdate(
        { ...prepared.before, session },
        { ...after, session },
        edits,
        prepared.defaults.get(target.key.id)
      );
      if (!projection.ok) return false;
      const baseline =
        prepared.defaults.get(target.key.id) ??
        projectLegacySessionToolSelection({ ...prepared.before, session });
      if (isDeepStrictEqual(projection.selection, baseline)) continue;
      if (commitToolDefaultUpdate(db, target, [], projection.selection, () => true) !== 'won')
        return false;
      prepared.local.notifyChange(target.key.table);
    }
    return true;
  });
  if (outcome !== 'won') return { ok: false, reason: 'superseded' };
  for (const change of prepared.local.changes) changes.notifyChange(change.table, change.scope);
  return { ok: true, results, changed: prepared.local.changes.length > 0 };
}
const transition = (superpipe({})('transition-tool-defaults') as PipelineAPI)
  .input(['db', 'request', 'changes'])
  .pipe(capture, ['db', 'request'], 'result:transition')
  .pipe(commit, ['transition', 'db', 'request', 'changes'], 'transition')
  .end('transition') as (
  db: Database,
  request: ToolDefaultTransition,
  changes: ChangeRecorder
) => ToolDefaultTransitionResult;
class ToolDefaultTransitionRepository {
  constructor(
    private db: Database,
    private changes?: ReactiveDatabase
  ) {}
  apply(request: ToolDefaultTransition) {
    return transition(this.db, request, (this.changes ?? new ChangeRecorder()) as ChangeRecorder);
  }
}
export const toolDefaultTransitions = defineRepositoryOp(
  'tool_defaults.transition',
  'write',
  ToolDefaultTransitionRepository,
  ['apply']
);
