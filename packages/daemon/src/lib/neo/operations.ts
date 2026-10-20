import { neoTurnRequestKey } from './request-key.ts';
import { readNeoWorking } from './working.ts';
import { hostname } from 'node:os';
import {
  backfillNeoRepositoryIdentities,
  isNeoPlumbingFolder,
  neoProjectFolders,
} from './project-mirror.ts';
import { neoFolderPath } from './folder.ts';
import { isTempCwd } from '../drivers/claude-feed.ts';
import { createNeoProjectTreeOperations } from './project-tree-operations.ts';
import { createNeoProjectForgetOperation } from './project-forget-operation.ts';
import { neoMirroredAliases } from './project-cleanup.ts';
import { createNeoProjectCleanupApply } from './project-cleanup-apply.ts';
import type { PlaceGroup } from '../drivers/types.ts';
import { existsSync } from 'node:fs';
import { neoPromptText } from './reply-language.ts';
import {
  NEO_SNAPSHOT_UNCHANGED_GUIDANCE,
  planNeoSnapshotRead,
  rememberNeoSnapshotRead,
} from './snapshot-read.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { THINKING_LEVELS } from '@hyperneo/shared';
import { z } from 'zod';
import { NeoGithubReadResult, readNeoGithubRef } from './packs/coding/github-read.ts';
import {
  NeoGithubQuery,
  NeoGithubQueryResult,
  queryNeoGithub,
} from './packs/coding/github-query.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { defineOperation } from '../operations/registry.ts';
import { hashString32 } from '../runtime-hash.ts';
import type { NeoService } from './service.ts';
import type { NeoProject } from '@hyperneo/shared/types/neo-context';
import { type NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import {
  NEO_STANDING_RULE_MAX_CHARS,
  NEO_STANDING_RULES_MAX,
  neoStandingRules,
  type NeoSettings,
} from '@hyperneo/shared/types/settings';
import { createNeoIntakeOperation } from './intake.ts';
import { createNeoReorganizeOperation, type NeoReorganizeRuntime } from './reorganize-operation.ts';
import { readNeoProjectIdentities } from './project-merge.ts';
import { readWorkspaceIdentity } from '../drivers/code-identity.ts';
import { createNeoPublicationChangeOperations } from './publication-change-operation.ts';
import { createNeoPublicationOperation } from './publication-operation.ts';
import { createNeoConversationReadOperation } from './conversation-read-operation.ts';
import { NeoConversationReader } from '../../storage/repositories/neo-conversation-reader.ts';
import { createNeoPublicationReadOperation } from './publication-read-operation.ts';
import {
  createNeoConversationAskReadOperation,
  createNeoConversationImageReadOperation,
} from './conversation-ask-read-operation.ts';
import { createNeoDraftRecoveryOperation } from './draft-recovery-operation.ts';
import {
  fitNeoSnapshotBudget,
  NEO_MCP_SNAPSHOT_BUDGET,
  neoSnapshotOmitted,
} from './snapshot-compact.ts';
import { hasNeoHumanWorkInput, neoTurnOrigin } from './work-origin.ts';
import { invokeOperation } from '../operations/invoke.ts';
import {
  NEO_SESSION_MUTES_MAX,
  NeoSessionNoticeGroupSchema,
  NeoSessionNoticeSchema,
  latestNeoSessionNoticeGroups,
  planNeoSessionMutes,
  type NeoSessionNotice,
} from './session-watch.ts';
import {
  findNeoSessionNotice,
  requireNeoTrackRoot,
  requireNeoTrackableSession,
} from './session-track.ts';
import { createNeoQuestionOperations } from './question-operations.ts';
import { createNeoTodoOperations, type NeoTodoControls } from './todo-operations.ts';
import { createNeoAskRecordOperations } from './ask-record-operations.ts';
import { NeoAskEntrySchema, projectNeoAskEntries } from './ask-entries.ts';
import { createNeoPreferenceOperation } from './model-preference.ts';
import { planNeoRuleEdit, planNeoSavedRules, requireNeoRuleCitation } from './saved-rules.ts';

type ZodShape<T> = { [K in keyof Required<T>]: z.ZodType<T[K]> };

const Project = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  context: z.string(),
  parentId: z.string().nullable().optional(),
  epicUrl: z.string().nullable().optional(),
  workspaceAliases: z.array(z.string()).optional(),
  repository: z.string().optional(),
  folders: z
    .array(z.object({ machine: z.string(), folder: z.string() }))
    .optional()
    .describe(
      "The project's own folders: start and propose its work in one of these, not in a place found by text search."
    ),
  revision: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
} satisfies ZodShape<NeoProject>);
const Failure = z.object({ ok: z.literal(false), reason: z.string() });
const SnapshotOk = z.object({
  ok: z.literal(true),
  sessionId: z.string().nullable(),
  projects: z.array(Project),
  conversationId: z.string().nullable().optional(),
  projectRedirects: z.array(z.object({ sourceId: z.string(), targetId: z.string() })).optional(),
  standingRules: z.array(z.string()).optional(),
  sessionNotices: z.array(NeoSessionNoticeSchema).max(20).optional(),
  sessionNoticeGroups: z.array(NeoSessionNoticeGroupSchema).max(10).optional(),
  mutedSessions: z.array(z.string()).max(NEO_SESSION_MUTES_MAX).optional(),
  todoAsks: z.array(NeoAskEntrySchema).optional(),
  packRows: z
    .array(
      z.object({
        pack: z.string(),
        rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
      })
    )
    .optional(),
  omitted: z.object({ asks: z.number().int().optional() }).optional(),
  working: z
    .array(
      z.object({
        sessionId: z.string(),
        projectId: z.string().nullable(),
        title: z.string(),
        status: z.enum(['queued', 'processing', 'rate_limit_cooldown']),
      })
    )
    .max(100)
    .optional(),
  preferences: z
    .object({
      model: z.string(),
      provider: z.string(),
      thinkingLevel: z.enum(THINKING_LEVELS),
      saved: z.boolean(),
    })
    .nullable()
    .optional(),
  trimmed: z.string().optional(),
  rev: z.string().optional(),
} satisfies ZodShape<NeoSnapshot>);
const SnapshotUnchanged = z.object({
  ok: z.literal(true),
  unchanged: z.literal(true),
  rev: z.string(),
  note: z.string(),
});
const Snapshot = z.union([Failure, SnapshotUnchanged, SnapshotOk]);
const Scope = z
  .object({
    projectId: z.string().min(1).optional(),
    sinceRev: z.string().min(1).max(40).optional(),
  })
  .default({});
const Save = z.object({
  id: z.string().min(1).max(100).optional(),
  title: z.string().trim().min(1).max(160),
  summary: z.string().max(1000),
  context: z.string().max(16000),
  expectedRevision: z.number().int().min(0),
});
type SaveRequest = z.infer<typeof Save>;

export function requireNeoProjectSaveId(
  input: Pick<SaveRequest, 'id' | 'expectedRevision'>,
  caller: OperationCaller
): { value: OperationCaller } | { reason: z.infer<typeof Failure> } {
  if (input.id && input.expectedRevision === 0)
    return {
      reason: {
        ok: false,
        reason: 'Omit id to create a project; the daemon assigns its id and returns it.',
      },
    };
  if (!input.id && input.expectedRevision > 0)
    return { reason: { ok: false, reason: 'Pass the id of the project you are updating.' } };
  return { value: caller };
}
const SessionMute = z.object({ key: z.string().trim().min(1).max(400), muted: z.boolean() });
const SessionMuteResult = z.union([
  Failure,
  z.object({ ok: z.literal(true), mutedSessions: z.array(z.string()) }),
]);
const SessionTrack = z.object({ key: z.string().trim().min(1).max(400) });
const SessionTrackResult = z.union([Failure, z.object({ ok: z.literal(true) })]);
const StandingRule = z.string().trim().min(1).max(NEO_STANDING_RULE_MAX_CHARS);
const SaveRules = z.object({
  add: z.array(StandingRule).max(NEO_STANDING_RULES_MAX).optional(),
  remove: z.array(StandingRule).max(NEO_STANDING_RULES_MAX).optional(),
  from: z.string().trim().min(1).max(2000).optional(),
});
const RulesResult = z.union([
  Failure,
  z.object({ ok: z.literal(true), standingRules: z.array(z.string()) }),
]);
const PackRead = z.object({ id: z.string().trim().min(1).max(80) });
const GithubRead = NeoGithubQuery.partial({ repo: true })
  .extend({ url: z.string().trim().min(1).max(500).optional() })
  .refine((input) => !input.url !== !input.repo, 'Pass either url or repo.');
const PackReadResult = z.union([
  Failure,
  z.object({
    ok: z.literal(true),
    pack: z.object({ id: z.string(), describe: z.string() }),
    instructions: z.string(),
  }),
]);
type Rejection = { ok: false; reason: string };

export function neoSnapshotRevision<T extends { ok: boolean }>(
  snapshot: T,
  sinceRev: string | undefined
): T | (T & { rev: string }) | { ok: true; unchanged: true; rev: string; note: string } {
  if (!snapshot.ok) return snapshot;
  const rev = hashString32(
    JSON.stringify(snapshot, (key, value) => (key === 'checkedAt' ? undefined : value))
  ).toString(36);
  return sinceRev === rev
    ? {
        ok: true,
        unchanged: true,
        rev,
        note: `unchanged since rev ${rev}: nothing changed since your last read. ${NEO_SNAPSHOT_UNCHANGED_GUIDANCE}`,
      }
    : { ...snapshot, rev };
}

export const NEO_HUMAN_TURN_REFUSAL =
  'Neo can do this only while answering the human’s own chat message, not from a system note.';

function readNeoRuleSource(service: NeoService, caller: OperationCaller): string | null {
  if (caller.source === 'rpc' && caller.principal === 'local') return null;
  if (!caller.sessionId || !caller.neoTurn) return '';
  return neoPromptText(
    service.db
      .getSDKMessageRepo()
      .getStoredPromptsByUuid(caller.sessionId, neoTurnOrigin(caller.neoTurn))
      .filter((message) => (message as { inputKind?: unknown }).inputKind === 'human')
  );
}

function isNeoHumanTurn(service: NeoService, caller: OperationCaller): boolean {
  if (caller.source === 'rpc' && caller.principal === 'local') return true;
  const turn = caller.neoTurn;
  if (!turn?.isLive() || !caller.sessionId) return false;
  return (
    service.db.getSession(caller.sessionId)?.status === 'active' &&
    service.ownsHumanMessage(caller) &&
    hasNeoHumanWorkInput(
      caller,
      service.db.getSDKMessageRepo().getStoredPromptsByUuid(caller.sessionId, neoTurnOrigin(turn))
    )
  );
}

function admitNeoCaller(
  service: NeoService,
  caller: OperationCaller,
  name: string
): { value: OperationCaller } | { reason: Rejection } {
  if (caller.source === 'rpc' && caller.principal === 'local') return { value: caller };
  const binding = caller.sessionId ? service.repo.getBindingBySession(caller.sessionId) : null;
  if (caller.source !== 'mcp' || binding?.kind !== 'neo')
    return { reason: { ok: false, reason: 'This operation belongs to Neo.' } };
  if (name === 'neo.rule.save' && !isNeoHumanTurn(service, caller))
    return { reason: { ok: false, reason: NEO_HUMAN_TURN_REFUSAL } };
  if (['neo.open', 'neo.restart', 'neo.session.track'].includes(name))
    return { reason: { ok: false, reason: 'This action needs the user.' } };
  return { value: caller };
}

export function neoReorganizeRuntime(service: NeoService): NeoReorganizeRuntime {
  return {
    getBinding: (sessionId) => service.repo.getBindingBySession(sessionId),
    rootSessionId: () => service.repo.defaultBinding()?.sessionId ?? null,
    recordIdentities: async () => {
      if (backfillNeoRepositoryIdentities(service.db.getDatabase())) service.notifyChanged();
      const merges = service.repo.projectMerges;
      merges.recordIdentities(
        await readNeoProjectIdentities(merges.localFolders(hostname()), readWorkspaceIdentity)
      );
    },
    projectFacts: () => service.repo.projectCleanupFacts(),
    machine: () => hostname(),
    cleanup: createNeoProjectCleanupApply(service),
    mirroredAliases: async (folders) => {
      const caller = {
        source: 'internal' as const,
        sessionId: service.repo.defaultBinding()?.sessionId,
        role: 'neo' as const,
      };
      const places: PlaceGroup[] = [];
      for (const folder of folders) {
        const outcome = await invokeOperation(
          service.sessions.getOperationRegistry(),
          'work.find',
          { folder, includeClosed: true, localOnly: true, limit: 50 },
          caller
        );
        const value =
          outcome.kind === 'completed'
            ? (outcome.value as {
                places?: PlaceGroup[];
                unreachable?: unknown[];
                more?: boolean;
              } | null)
            : null;
        if (!value?.places || value.unreachable?.length || value.more) return null;
        places.push(...value.places);
      }
      const local = {
        machine: hostname(),
        neoFolder: neoFolderPath(),
        isTemp: isTempCwd,
        exists: existsSync,
      };
      return neoMirroredAliases(places, (place) => isNeoPlumbingFolder(place, local));
    },
    log: (line) => service.logReorganize(line),
  };
}

export function createNeoOperations(service: NeoService) {
  function path<I, O>(name: string, action: (input: I, caller: OperationCaller) => O | Promise<O>) {
    return (superpipe({})(name) as PipelineAPI)
      .input(['input', 'caller'])
      .pipe(
        (caller: OperationCaller) => admitNeoCaller(service, caller, name),
        'caller',
        'result:admission'
      )
      .pipe(action, ['input', 'admission'], 'admission')
      .endAsync('admission') as (input: I, caller: OperationCaller) => Promise<O | Rejection>;
  }
  function snapshot(caller: OperationCaller, requested?: string) {
    const built = buildSnapshot(caller, requested);
    return caller.source !== 'rpc'
      ? neoSnapshotOmitted(fitNeoSnapshotBudget(built, NEO_MCP_SNAPSHOT_BUDGET), built)
      : built;
  }
  function buildSnapshot(caller: OperationCaller, requested: string | undefined) {
    const scope = requested
      ? (service.repo.projectMerges.resolve(requested) ?? requested)
      : undefined;
    const detailed = caller.source === 'rpc';
    const all = service.repo.listProjects();
    const projects = all.filter((item) => !scope || item.id === scope);
    const repositories = service.repo.repositories();
    const asks = service.todos.listAsks(scope, caller.source === 'rpc' ? 50 : 10);
    const unlisted = service.todos.countAsks(scope) - asks.length;
    const todoAsks = projectNeoAskEntries(
      asks,
      service.todos,
      service.todoSessions,
      service.installedPacks()
    );
    return {
      ok: true as const,
      sessionId: service.defaultSessionId() ?? null,
      standingRules: neoStandingRules(service.db.getGlobalSettings?.().neo),
      ...(caller.source === 'rpc'
        ? {
            conversationId: service.repo.conversationId(),
            projectRedirects: service.repo.projectMerges.redirects(),
          }
        : {}),
      projects: projects.map((item) => {
        const aliases = service.repo.workspaceAliases(item.id, all);
        const folders = neoProjectFolders(aliases);
        return {
          ...item,
          ...(item.epicUrl ? { workspaceAliases: aliases } : {}),
          ...(repositories.get(item.id) ? { repository: repositories.get(item.id) } : {}),
          ...(folders.length ? { folders } : {}),
          context: detailed ? item.context : '',
        };
      }),
      ...(caller.source === 'rpc' ? { sessionNotices: service.sessionNotices } : {}),
      sessionNoticeGroups: latestNeoSessionNoticeGroups(service.sessionNoticeGroups),
      mutedSessions: service.db.getGlobalSettings?.().neo?.mutedSessions ?? [],
      preferences: service.modelPreference(),
      todoAsks,
      ...(unlisted > 0 ? { omitted: { asks: unlisted } } : {}),
      packRows: service.packs().flatMap((pack) => {
        const rows = pack.snapshotRows?.(
          scope ? service.repo.allRepositories(scope) : null,
          Date.now(),
          todoAsks
            .filter((entry) => entry.ask.status === 'open')
            .flatMap((entry) => entry.todos.map((todo) => todo.id))
        );
        return rows?.length ? [{ pack: pack.id, rows }] : [];
      }),
      working: readNeoWorking(service.db.getDatabase()).slice(0, 100),
    };
  }
  const muteSession = (superpipe({})('neo.session.mute') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (caller: OperationCaller) => admitNeoCaller(service, caller, 'neo.session.mute'),
      'caller',
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof SessionMute>) => ({
        mutedSessions: planNeoSessionMutes(
          service.db.getGlobalSettings().neo?.mutedSessions ?? [],
          input.key,
          input.muted
        ),
      }),
      'input',
      'planned'
    )
    .pipe(
      (planned: { mutedSessions: string[] }) => {
        const neo = service.db.getGlobalSettings().neo;
        const updated = service.db.updateGlobalSettings({
          neo: { ...neo, mutedSessions: planned.mutedSessions },
        });
        service.publishSettings?.(updated);
        service.notifyChanged();
        return { ok: true as const, mutedSessions: planned.mutedSessions };
      },
      'planned',
      'admission'
    )
    .end('admission') as (
    input: z.infer<typeof SessionMute>,
    caller: OperationCaller
  ) => z.infer<typeof SessionMuteResult>;
  const trackSession = (superpipe({})('neo.session.track') as PipelineAPI)
    .input(['input', 'caller', 'now'])
    .pipe(
      (caller: OperationCaller) => admitNeoCaller(service, caller, 'neo.session.track'),
      'caller',
      'result:track'
    )
    .pipe(() => requireNeoTrackRoot(service.defaultSessionId()), 'caller', 'result:track')
    .pipe((root: string) => root, 'track', 'root')
    .pipe(
      (input: z.infer<typeof SessionTrack>) =>
        findNeoSessionNotice(service.trackableNotices, input.key),
      'input',
      'result:track'
    )
    .pipe(
      (notice: NeoSessionNotice, now: number) =>
        requireNeoTrackableSession(notice, service.followedCardRefs(now)),
      ['track', 'now'],
      'result:track'
    )
    .pipe(
      (root: string, notice: NeoSessionNotice, now: number) =>
        service.trackSession(root, notice, now),
      ['root', 'track', 'now'],
      'track'
    )
    .endAsync('track') as (
    input: z.infer<typeof SessionTrack>,
    caller: OperationCaller,
    now: number
  ) => Promise<z.infer<typeof SessionTrackResult>>;
  const saveRules = (superpipe({})('neo.rule.save') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (caller: OperationCaller) => admitNeoCaller(service, caller, 'neo.rule.save'),
      'caller',
      'result:save'
    )
    .pipe(
      (input: z.infer<typeof SaveRules>, caller: OperationCaller) =>
        requireNeoRuleCitation(input, input.from, readNeoRuleSource(service, caller)),
      ['input', 'caller'],
      'result:save'
    )
    .pipe(() => ({ neo: service.db.getGlobalSettings().neo }), 'input', 'current')
    .pipe(
      (input: z.infer<typeof SaveRules>, current: { neo?: NeoSettings }) =>
        planNeoRuleEdit(neoStandingRules(current.neo), input),
      ['input', 'current'],
      'result:save'
    )
    .pipe(
      (rules: string[], current: { neo?: NeoSettings }) => {
        const updated = service.db.updateGlobalSettings({
          neo: { ...current.neo, standingRules: rules },
        });
        service.publishSettings?.(updated);
      },
      ['save', 'current']
    )
    .pipe(
      (caller: OperationCaller, rules: string[], current: { neo?: NeoSettings }) =>
        service.noteSavedRules(caller, planNeoSavedRules(neoStandingRules(current.neo), rules)),
      ['caller', 'save', 'current']
    )
    .pipe((rules: string[]) => ({ ok: true as const, standingRules: rules }), 'save', 'save')
    .end('save') as (
    input: z.infer<typeof SaveRules>,
    caller: OperationCaller
  ) => z.infer<typeof RulesResult>;
  const read = path('neo.snapshot', (input: z.infer<typeof Scope>, caller) => {
    const read = neoSnapshotRevision(snapshot(caller, input.projectId), input.sinceRev);
    const turn = caller.source === 'mcp' ? caller.neoTurn?.messageId : undefined;
    if (!caller.sessionId || !turn) return read;
    const key = [caller.sessionId, turn, input.projectId].join('\n');
    const planned = planNeoSnapshotRead(
      read,
      service.snapshotReads.get(key) ?? null,
      service.db.getSDKMessageRepo().latestCompactionSeq(caller.sessionId)
    );
    if (planned.remember) rememberNeoSnapshotRead(service.snapshotReads, key, planned.remember);
    return planned.result;
  });
  const restart = path('neo.restart', () => service.restart());
  const open = path('neo.open', async (input: z.infer<typeof Scope>, caller) => {
    const projectId = input.projectId
      ? (service.repo.projectMerges.resolve(input.projectId) ?? input.projectId)
      : null;
    if (projectId && !service.repo.getProject(projectId))
      return { ok: false as const, reason: 'Project not found.' };
    setTimeout(
      () =>
        void invokeOperation(
          service.sessions.getOperationRegistry(),
          'work.find',
          { limit: 50 },
          caller
        ).catch(() => null),
      0
    );
    const sessionId = await service.open();
    return { ...snapshot(caller), sessionId };
  });
  const save = (superpipe({})('neo.project.save') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: SaveRequest, caller: OperationCaller) =>
        admitNeoCaller(service, caller, 'neo.project.save'),
      ['input', 'caller'],
      'result:admission'
    )
    .pipe(
      (input: SaveRequest, caller: OperationCaller) => requireNeoProjectSaveId(input, caller),
      ['input', 'admission'],
      'result:admission'
    )
    .pipe(
      (input: SaveRequest, caller: OperationCaller) => ({
        ...input,
        id: input.id ?? neoTurnRequestKey(caller, 'neo.project.save', input),
      }),
      ['input', 'admission'],
      'request'
    )
    .pipe(
      (input: SaveRequest, request: SaveRequest & { id: string }, caller: OperationCaller) => {
        const created = input.id ? null : service.repo.getProject(request.id);
        return created ? { reason: { ok: true as const, project: created } } : { value: caller };
      },
      ['input', 'request', 'admission'],
      'result:admission'
    )
    .pipe(
      (input: SaveRequest & { id: string }) => {
        const project = service.repo.saveProject(input, input.expectedRevision);
        return project
          ? { ok: true as const, project }
          : {
              ok: false as const,
              reason: 'superseded: read the current project before saving again',
            };
      },
      'request',
      'admission'
    )
    .endAsync('admission') as (
    input: SaveRequest,
    caller: OperationCaller
  ) => Promise<
    | z.infer<typeof Failure>
    | { ok: true; project: NonNullable<ReturnType<NeoService['repo']['getProject']>> }
  >;
  const readGithub = path(
    'neo.github.read',
    async (
      input: z.infer<typeof GithubRead>
    ): Promise<NeoGithubReadResult | NeoGithubQueryResult> =>
      input.url
        ? await readNeoGithubRef(service, input.url)
        : await queryNeoGithub((args: string[]) => service.listGithub(args), {
            ...input,
            repo: input.repo!,
          })
  );
  const readPack = path('neo.pack.read', ({ id }: z.infer<typeof PackRead>) => {
    const pack = service.pack(id);
    if (!pack)
      return { ok: false as const, reason: `pack_not_found: no pack "${id}" is installed.` };
    const instructions = pack.instructions();
    return instructions === null
      ? {
          ok: false as const,
          reason: `pack_without_instructions: "${id}" carries no instructions to read.`,
        }
      : { ok: true as const, pack: { id: pack.id, describe: pack.describe }, instructions };
  });
  const todoControls: NeoTodoControls = {
    start: (todoId) => service.todoRunner.start(todoId),
    proceed: (todoId, message) => service.todoRunner.proceed(todoId, message),
    retry: (todoId) => service.todoRunner.retry(todoId),
    stop: (todo) => service.todoRunner.stop(todo),
  };
  return [
    ...createNeoProjectTreeOperations(service.repo),
    createNeoProjectForgetOperation(service.repo),
    createNeoIntakeOperation(service.db, service.repo, (sessionId) => {
      service.notifyChanged();
      void service.steerHumanMessages(sessionId);
    }),
    createNeoReorganizeOperation(neoReorganizeRuntime(service)),
    createNeoPublicationOperation(service.publish),
    ...createNeoPublicationChangeOperations({
      getBinding: (id) => service.repo.getBindingBySession(id),
      getRootBinding: () => service.repo.defaultBinding(),
      publications: service.publications,
      resolveAskOrigin: (input) => service.resolveAskOrigin(input),
      resolveHumanAskOrigin: (input) => service.resolveHumanAskOrigin(input),
      notify: (conversationId) => {
        service.notifyChanged();
        service.notifyPublicationsChanged(conversationId);
      },
    }),
    createNeoPublicationReadOperation(service.repo, service.publications),
    createNeoConversationReadOperation(
      service.repo,
      new NeoConversationReader(service.db.getDatabase())
    ),
    createNeoConversationAskReadOperation(service.repo, service.asks, (sessionId, messageId) =>
      service.db.getSDKMessageRepo().getUserSendStatus(sessionId, messageId)
    ),
    createNeoConversationImageReadOperation(service.repo, service.asks),
    createNeoDraftRecoveryOperation(service),
    createNeoPreferenceOperation(service),
    ...createNeoTodoOperations(service.todos, service.todoSessions, todoControls, () =>
      service.installedPacks()
    ),
    ...createNeoAskRecordOperations(
      service.todos,
      service.todoSessions,
      todoControls,
      (projectId) => service.repo.resolveProjectRef(projectId),
      (sessionId) => {
        const binding = service.repo.getBindingBySession(sessionId);
        return binding?.kind === 'neo';
      },
      () => service.repo.listProjects(),
      () => service.installedPacks()
    ),
    ...createNeoQuestionOperations(
      service.todos,
      (ask, question, note) =>
        service.deliverForward(
          ask.sessionId,
          `neo-question:${question.id}`,
          note,
          ask.sessionId,
          ask.originMessageId ? { sessionId: ask.sessionId, messageId: ask.originMessageId } : null,
          'continues'
        ),
      (todoId) => service.todoRunner.start(todoId)
    ),
    defineOperation({
      name: 'neo.open',
      description:
        'Open the one Neo conversation; a projectId is checked and opens the same session.',
      inputSchema: Scope,
      resultSchema: Snapshot,
      policy: { safetyClass: 'human_only' },
      execute: open,
    }),
    defineOperation({
      name: 'neo.restart',
      description:
        'Give root Neo a fresh context in the same session and conversation. Its first input is a visible note with the open asks, their todos and the unanswered questions.',
      inputSchema: z.object({}).strict(),
      resultSchema: z.union([Failure, z.object({ ok: z.literal(true), sessionId: z.string() })]),
      policy: { safetyClass: 'human_only' },
      execute: restart,
    }),
    defineOperation({
      name: 'neo.rule.save',
      description:
        'Add or remove standing rules (neo.snapshot standingRules); the other rules stay. Only while answering the human’s own message, when they state or correct something lasting about how work should go (what done means, where a project lives, which app to use) or answer your question about it: pass add with the new rule, remove with the exact text of a rule they replaced or withdrew, and from with the words of their message that state it, quoted exactly. Up to 20 rules of up to 500 characters.',
      inputSchema: SaveRules,
      resultSchema: RulesResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => saveRules(input, caller),
    }),
    defineOperation({
      name: 'neo.session.mute',
      description:
        'Mute or unmute notices about a session the human started themselves. key is the notice key from snapshot.sessionNoticeGroups or sessionNotices; a muted session gets no more needs-you or failed notices until unmuted. snapshot.mutedSessions lists the muted keys.',
      inputSchema: SessionMute,
      resultSchema: SessionMuteResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => muteSession(input, caller),
    }),
    defineOperation({
      name: 'neo.session.track',
      description:
        'Track a session the human started themselves, from its notice: key is the notice key from snapshot.sessionNoticeGroups or sessionNotices. The tap is the human’s approval: the daemon opens an ask with one todo that follows the session from the tap on, without sending it anything, and tells Neo the askId and todoId. Neo hears when the session stops before the todo is done.',
      inputSchema: SessionTrack,
      resultSchema: SessionTrackResult,
      policy: { safetyClass: 'human_only' },
      execute: (input, caller) => trackSession(input, caller, Date.now()),
    }),
    defineOperation({
      name: 'neo.github.read',
      description:
        'Read GitHub as it is now. With {url}, one pull request or issue: a pull request returns its state (OPEN, MERGED or CLOSED), checks (passing, failing, pending or none), review verdict on its current head (approved, changes_requested or none), merge blockers and title; an issue returns its state, how it closed (completed, not_planned or duplicate), the merged pull request that closed it, and its parent issue. With {repo: "owner/name", kind: "pr" or "issue", state: "open", "merged", "closed" or "all", by: "created", "updated", "merged" or "closed", since, until (ISO times) or withinHours (the last N hours up to now), limit}, a list: every match in that window with number, title, url, state, createdAt, updatedAt, mergedAt and closedAt, newest first, truncated when more matched than limit, and window {by, since, until} saying what the read covered (until is the read time when you leave it out, so leave it out for "recently" or "last N hours"). by defaults to merged for state merged, closed for closed, otherwise created. Use the list for any question about what happened in a time range ("which PRs merged in the last 2 hours") instead of guessing numbers and reading them one by one. Read-only.',
      inputSchema: GithubRead,
      resultSchema: z.union([NeoGithubReadResult, NeoGithubQueryResult]),
      policy: { safetyClass: 'read', roles: ['neo'] },
      execute: readGithub,
    }),
    defineOperation({
      name: 'neo.pack.read',
      description:
        'Read the full instructions of an installed domain pack (enabled or not), the guidance an ask names with its pack field: what work in that domain looks like and what done means there. neo.snapshot and the system prompt carry only each enabled pack’s one-line describe.',
      inputSchema: PackRead,
      resultSchema: PackReadResult,
      policy: { safetyClass: 'read', roles: ['neo'] },
      execute: readPack,
    }),
    defineOperation({
      name: 'neo.snapshot',
      description:
        'Read durable project summaries and todo asks. Pass projectId to load that project’s full context. todoAsks holds each ask with its todos (state, report, evidence) and open questions; packRows holds pack facts, such as the coding pack’s pull request ledger with each PR’s state and owner. A list that does not hold every ask says so in omitted ({asks}: how many were left out), so never answer all or none from it. A snapshot over 40 KB is trimmed and carries a trimmed note saying what was cut. Every snapshot carries rev; pass it back as sinceRev and an unchanged snapshot answers only {unchanged: true, rev}, so read again only after something happened.',
      inputSchema: Scope,
      resultSchema: Snapshot,
      policy: { safetyClass: 'read', roles: ['neo'] },
      execute: read,
    }),
    defineOperation({
      name: 'neo.project.save',
      description:
        'Create a continuing context only when needed, or update an existing context with revision protection. Never one project per message. To create, omit id and pass expectedRevision 0; the daemon assigns the id and returns it, and a retry of the same call in one Neo turn returns the same project; a call outside a Neo turn always creates a new one. To update, pass the id and current revision.',
      inputSchema: Save,
      resultSchema: z.union([Failure, z.object({ ok: z.literal(true), project: Project })]),
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: save,
    }),
  ];
}
