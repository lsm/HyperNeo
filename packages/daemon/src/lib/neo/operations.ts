import { neoSessionTrackRootRead } from '../../storage/repositories/neo-session-track-write.ts';
import { createNeoCardSearchOperation } from './card-search-operation.ts';
import { readNeoReply } from './intake.ts';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { globalSettingsWrites } from '../../storage/repositories/global-settings-writes.ts';
import { receivedNeoHumanInput } from './human-input.ts';
import { readNeoMessageStatuses, type NeoMessageStatusPresenter } from './message-status.ts';
import { WorkerIdentitySchema } from '../drivers/worker-identity-schema.ts';
import { createNeoRuleQuestions } from './rule-questions.ts';
import { createPackPreferenceQuestions } from './preference-questions.ts';
import { NeoSessionMessageRepository } from '../../storage/repositories/neo-session-message-repository.ts';
import {
  NeoConversationWakeRepository,
  NeoConversationWakeSchema,
} from '../../storage/repositories/neo-conversation-wake-repository.ts';
import { readNeoWorking } from './working.ts';
import { hostname } from 'node:os';
import {
  backfillNeoRepositoryIdentities,
  isNeoPlumbingFolder,
  neoProjectFolders,
} from './project-mirror.ts';
import { neoFolderPath } from './folder.ts';
import { isTempCwd } from '../drivers/claude-feed.ts';
import { createNeoProjectForgetOperation } from './project-forget-operation.ts';
import { neoMirroredAliases } from './project-cleanup.ts';
import { createNeoProjectCleanupApply } from './project-cleanup-apply.ts';
import type { PlaceGroup } from '../drivers/types.ts';
import { existsSync } from 'node:fs';
import { NEO_SNAPSHOT_UNCHANGED_GUIDANCE } from './snapshot-read.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { THINKING_LEVELS, type GlobalSettings } from '@hyperneo/shared';
import { z } from 'zod';
import type { OperationCaller } from '../operations/registry.ts';
import { defineOperation } from '../operations/registry.ts';
import { isLocalUser } from '../operations/caller.ts';
import { hashString32 } from '../runtime-hash.ts';
import type { NeoService } from './service.ts';
import type { NeoProject } from '@hyperneo/shared/types/neo-context';
import { type NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { NEO_STANDING_RULE_MAX_CHARS, neoStandingRules } from '@hyperneo/shared/types/settings';
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
import { invokeOperation } from '../operations/invoke.ts';
import {
  NEO_SESSION_MUTES_MAX,
  NeoSessionNoticeGroupSchema,
  NeoSessionNoticeSchema,
  latestNeoSessionNoticeGroups,
  neoSessionNoticeLine,
  type NeoSessionNotice,
} from './session-watch.ts';
import { findNeoSessionNotice } from './session-track.ts';
import { createNeoQuestionOperations } from './question-operations.ts';
import { createNeoTodoOperations, type NeoTodoControls } from './todo-operations.ts';
import { resolveNeoTodoTarget } from './todo-target.ts';
import { wireNeoTodoMutations } from './todo-mutation-operation.ts';
import { createArtifactRefReader } from '../artifacts/read-operations.ts';
import { createNeoAskRecordOperations } from './ask-record-operations.ts';
import { SessionGoalRepository } from '../../storage/repositories/session-goal-repository.ts';
import {
  createNeoDoneTodosOperation,
  createNeoAskReadOperation,
  NeoAskEntrySchema,
  neoSnapshotAskEntries,
  projectNeoAskEntries,
  summarizeNeoAskEntry,
} from './ask-entries.ts';
import {
  createPackPreferenceOperations,
  listPackPreferences,
  PackSettingSchema,
} from './preference-operations.ts';
import { createNeoPreferenceOperation } from './model-preference.ts';
import { readNeoRuleApproval } from '../../storage/repositories/neo-rule-answer.ts';

type ZodShape<T> = { [K in keyof Required<T>]: z.ZodType<T[K]> };

const Project = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  context: z.string(),
  parentId: z.string().nullable().optional(),
  epicUrl: z.string().nullable().optional(),
  homePath: z.string().nullable().optional(),
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
const NEO_SESSION_MESSAGES_SHOWN = 30;
const Failure = z.object({ ok: z.literal(false), reason: z.string() });
const HistoryCursor = z.object({ updatedAt: z.number().finite(), id: z.string().min(1) });
const SnapshotOk = z.object({
  ok: z.literal(true),
  sessionId: z.string().nullable(),
  session: WorkerIdentitySchema.nullable().optional(),
  projects: z.array(Project),
  conversationId: z.string().nullable().optional(),
  projectRedirects: z.array(z.object({ sourceId: z.string(), targetId: z.string() })).optional(),
  standingRules: z.array(z.string()).optional(),
  standingRuleSources: z
    .record(
      z.string(),
      z.union([
        z.object({ sessionId: z.string(), messageId: z.string() }),
        z.object({ questionId: z.string() }),
      ])
    )
    .optional(),
  sessionNotices: z.array(NeoSessionNoticeSchema).max(20).optional(),
  sessionNoticeGroups: z.array(NeoSessionNoticeGroupSchema).max(10).optional(),
  sessionMessages: z
    .array(
      z.object({
        messageId: z.string(),
        conversationId: z.string(),
        sequence: z.number(),
        fromSession: z.string(),
        fromName: z.string().nullable(),
        toSession: z.string(),
        toName: z.string().nullable(),
        text: z.string(),
        createdAt: z.string(),
        kind: z.enum(['session', 'worker-batch']),
      })
    )
    .max(NEO_SESSION_MESSAGES_SHOWN)
    .optional(),
  mutedSessions: z.array(z.string()).max(NEO_SESSION_MUTES_MAX).optional(),
  wakes: z.array(NeoConversationWakeSchema).optional(),
  todoAsks: z.array(NeoAskEntrySchema).optional(),
  historyCursor: HistoryCursor.nullable().optional(),
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
        worker: WorkerIdentitySchema.optional(),
        projectId: z.string().nullable(),
        title: z.string(),
        status: z.enum(['queued', 'processing', 'rate_limit_cooldown']),
      })
    )
    .max(100)
    .optional(),
  packPreferences: z.array(PackSettingSchema).optional(),
  preferences: z
    .object({
      model: z.string(),
      provider: z.string(),
      thinkingLevel: z.enum(THINKING_LEVELS),
      fallbacks: z
        .array(
          z.object({
            model: z.string(),
            provider: z.string(),
            thinkingLevel: z.enum(THINKING_LEVELS),
          })
        )
        .optional(),
      autoCompactPercent: z.number().int().optional(),
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
  add: z.array(StandingRule).optional(),
  remove: z.array(StandingRule).optional(),
  messageId: z.uuid().optional(),
});
const RulesResult = z.union([
  Failure,
  z.object({ ok: z.literal(true), standingRules: z.array(z.string()) }),
]);
const PackRead = z.object({ id: z.string().trim().min(1).max(80) });
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

function admitNeoCaller(
  service: NeoService,
  caller: OperationCaller,
  name: string
): { value: OperationCaller } | { reason: Rejection } {
  if (isLocalUser(caller)) return { value: caller };
  const binding = caller.sessionId ? service.repo.getBindingBySession(caller.sessionId) : null;
  if (caller.source !== 'mcp' || binding?.kind !== 'neo')
    return { reason: { ok: false, reason: 'This operation belongs to Neo.' } };
  if (['neo.restart', 'neo.session.track'].includes(name))
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
  const mutationGateway = gatewayFor(service.db.getDatabase());
  const messageStatuses: NeoMessageStatusPresenter = (items) =>
    readNeoMessageStatuses((refs) => service.db.getNeoMessageStatusFactsAsync(refs), items);
  const snapshots = new Map<string, ReturnType<typeof buildSnapshot>>();
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
  async function snapshot(caller: OperationCaller, requested?: string) {
    if (caller.source !== 'rpc') {
      const built = await buildSnapshot(caller, requested);
      return neoSnapshotOmitted(fitNeoSnapshotBudget(built, NEO_MCP_SNAPSHOT_BUDGET), built);
    }
    const key = requested ?? '';
    let pending = snapshots.get(key);
    if (!pending) {
      pending = new Promise<void>((done) => setTimeout(done, 0)).then(async () => {
        try {
          return await buildSnapshot(caller, requested);
        } finally {
          snapshots.delete(key);
        }
      });
      snapshots.set(key, pending);
    }
    return pending;
  }
  async function buildSnapshot(caller: OperationCaller, requested: string | undefined) {
    const scope = requested
      ? (service.repo.projectMerges.resolve(requested) ?? requested)
      : undefined;
    const detailed = caller.source === 'rpc';
    const all = service.repo.listProjects();
    const projects = all.filter((item) => !scope || item.id === scope);
    const repositories = service.repo.repositories();
    const { asks, unlisted, facts, historyCursor } = await service.todos.read(
      'snapshot',
      scope,
      10,
      detailed
    );
    const { todoAsks, pinned } = neoSnapshotAskEntries(
      projectNeoAskEntries(asks, facts, service.installedPacks()),
      detailed ? 20 : undefined
    );
    const identities = new Map<string, ReturnType<typeof service.readWorker>>();
    const worker = (ref: Parameters<typeof service.readWorker>[0]) => {
      const key = JSON.stringify(ref);
      if (!identities.has(key)) identities.set(key, service.readWorker(ref));
      return identities.get(key)!;
    };
    const notices = async (items: readonly NeoSessionNotice[]) =>
      Promise.all(
        items.map(async (notice) => {
          const current = await worker(notice.ref);
          return { ...notice, worker: current, title: current.name ?? current.id };
        })
      );
    const entries = await Promise.all(
      todoAsks.map(async (entry) => ({
        ...entry,
        todos: await Promise.all(
          entry.todos.map(async (todo) => ({
            ...todo,
            worker: todo.worker ? await worker(todo.worker) : null,
          }))
        ),
      }))
    );
    const groups = await Promise.all(
      latestNeoSessionNoticeGroups(service.sessionNoticeGroups).map(async (group) => {
        const current = await notices(group.notices);
        return { ...group, ...neoSessionNoticeLine(current), notices: current };
      })
    );
    const sessionId = service.defaultSessionId() ?? null;
    return {
      ok: true as const,
      sessionId,
      session: sessionId ? await worker({ adapter: 'hyperneo', id: sessionId }) : null,
      standingRules: neoStandingRules(service.db.getGlobalSettings?.().neo),
      standingRuleSources: service.db.getGlobalSettings?.().neo?.standingRuleSources,
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
      ...(caller.source === 'rpc' ? { sessionNotices: await notices(service.sessionNotices) } : {}),
      sessionNoticeGroups: groups,
      ...(caller.source === 'rpc'
        ? {
            sessionMessages: await Promise.all(
              new NeoSessionMessageRepository(service.db.getDatabase())
                .latest(service.repo.conversationId() ?? '', NEO_SESSION_MESSAGES_SHOWN)
                .map((message) => service.messageNames(message))
            ),
            wakes: new NeoConversationWakeRepository(service.db.getDatabase()).latest(
              service.repo.conversationId() ?? '',
              NEO_SESSION_MESSAGES_SHOWN
            ),
          }
        : {}),
      mutedSessions: service.db.getGlobalSettings?.().neo?.mutedSessions ?? [],
      preferences: service.modelPreference(),
      packPreferences: listPackPreferences(service.db.getDatabase()),
      todoAsks: detailed ? entries.map(summarizeNeoAskEntry) : entries,
      ...(detailed ? { historyCursor } : {}),
      ...(unlisted > 0 ? { omitted: { asks: unlisted } } : {}),
      packRows: service.packs().flatMap((pack) => {
        const rows = pack.snapshotRows?.(
          scope ? service.repo.allRepositories(scope) : null,
          Date.now(),
          pinned
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
      (input: z.infer<typeof SessionMute>) =>
        gatewayFor(service.db.getDatabase()).call(
          globalSettingsWrites,
          'neoMute',
          input.key,
          input.muted
        ),
      'input',
      'updated'
    )
    .pipe(
      (updated: GlobalSettings) => {
        service.publishSettings?.(updated);
        service.notifyChanged();
        return { ok: true as const, mutedSessions: updated.neo!.mutedSessions! };
      },
      'updated',
      'admission'
    )
    .endAsync('admission') as (
    input: z.infer<typeof SessionMute>,
    caller: OperationCaller
  ) => Promise<z.infer<typeof SessionMuteResult>>;
  const trackSession = (superpipe({})('neo.session.track') as PipelineAPI)
    .input(['input', 'caller', 'now'])
    .pipe(
      (caller: OperationCaller) => admitNeoCaller(service, caller, 'neo.session.track'),
      'caller',
      'result:track'
    )
    .pipe(() => service.runDbOp(neoSessionTrackRootRead, null), 'caller', 'result:track')
    .pipe((root: string) => root, 'track', 'root')
    .pipe(
      (input: z.infer<typeof SessionTrack>) =>
        findNeoSessionNotice(service.trackableNotices, input.key),
      'input',
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
      (_input: z.infer<typeof SaveRules>, caller: OperationCaller) =>
        admitNeoCaller(service, caller, 'neo.rule.save'),
      ['input', 'caller'],
      'result:save'
    )
    .pipe(
      (input: z.infer<typeof SaveRules>, caller: OperationCaller) => {
        if (isLocalUser(caller) && !input.messageId) return { value: caller };
        const human =
          input.messageId && caller.sessionId
            ? receivedNeoHumanInput(service, caller.sessionId, input.messageId)
            : null;
        const approval = readNeoRuleApproval(service.db.getDatabase(), human, input);
        return approval
          ? approval.applied
            ? {
                reason: {
                  ok: true as const,
                  standingRules: neoStandingRules(service.db.getGlobalSettings().neo),
                },
              }
            : { value: caller }
          : {
              reason: {
                ok: false as const,
                reason:
                  'Cite a received human yes to the exact neo.rule.ask proposal in this conversation, or use neo.rule.ask for confirmation.',
              },
            };
      },
      ['input', 'save'],
      'result:save'
    )
    .pipe(
      (input: z.infer<typeof SaveRules>, caller: OperationCaller) =>
        gatewayFor(service.db.getDatabase()).call(
          globalSettingsWrites,
          'neoRules',
          input,
          input.messageId && caller.sessionId
            ? { sessionId: caller.sessionId, messageId: input.messageId }
            : undefined
        ),
      ['input', 'caller'],
      'result:save'
    )
    .pipe(
      (updated: GlobalSettings) => {
        service.publishSettings?.(updated);
        return { ok: true as const, standingRules: updated.neo!.standingRules! };
      },
      'save',
      'save'
    )
    .endAsync('save') as (
    input: z.infer<typeof SaveRules>,
    caller: OperationCaller
  ) => Promise<z.infer<typeof RulesResult>>;
  const read = path('neo.snapshot', async (input: z.infer<typeof Scope>, caller) => {
    return neoSnapshotRevision(await snapshot(caller, input.projectId), input.sinceRev);
  });
  const restart = path('neo.restart', () => service.restart());
  const open = path('neo.open', async (input: z.infer<typeof Scope>, caller) => {
    const projectId = input.projectId
      ? (service.repo.projectMerges.resolve(input.projectId) ?? input.projectId)
      : null;
    if (projectId && !service.repo.getProject(projectId))
      return { ok: false as const, reason: 'Project not found.' };
    const sessionId = await service.open();
    const view = await snapshot(caller);
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
    return { ...view, sessionId };
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
      (input: SaveRequest) => ({
        ...input,
        id: input.id ?? crypto.randomUUID(),
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
    resolveTarget: (ref) =>
      resolveNeoTodoTarget(ref, (name, input) =>
        invokeOperation(service.sessions.getOperationRegistry(), name, input, {
          source: 'internal',
          role: 'neo',
        })
      ),
    recompute: (todo, patch) => service.todoRunner.recompute(todo, patch),
    start: (todoId) => service.todoRunner.start(todoId),
    proceed: (todoId, message) => service.todoRunner.proceed(todoId, message),
    retry: (todoId) => service.todoRunner.retry(todoId),
    stop: (todo) => service.todoRunner.stop(todo),
  };
  return [
    ...service.packOperations,
    createNeoProjectForgetOperation(service.repo, (repos) => {
      for (const pack of service.installedPacks()) pack.forgetRepositories?.(repos);
    }),
    createNeoIntakeOperation(
      service.db,
      service.repo,
      (_sessionId, questionId) => {
        service.notifyChanged();
        if (questionId) void service.deliverQuestionAnswers(questionId);
      },
      service.todos
    ),
    createNeoReorganizeOperation(neoReorganizeRuntime(service)),
    createNeoPublicationOperation(service.publish),
    ...createNeoPublicationChangeOperations({
      getBinding: (id) => service.repo.getBindingBySession(id),
      getRootBinding: () => service.repo.defaultBinding(),
      publications: service.publications,
      notify: (conversationId) => {
        service.notifyChanged();
        service.notifyPublicationsChanged(conversationId);
      },
    }),
    createNeoPublicationReadOperation(service.repo, service.publications),
    createNeoConversationReadOperation(
      service.repo,
      new NeoConversationReader(service.db.getDatabase(), messageStatuses),
      (message) => service.messageNames(message),
      service.db.getDatabase()
    ),
    createNeoConversationAskReadOperation(
      service.repo,
      service.asks,
      messageStatuses,
      service.db.getDatabase()
    ),
    createNeoConversationImageReadOperation(service.repo, service.asks),
    createNeoDraftRecoveryOperation(service),
    ...createNeoRuleQuestions(service),
    ...createPackPreferenceQuestions(
      service.db.getDatabase(),
      service.todos,
      () => service.installedPacks(),
      () => service.db.getGlobalSettings().language
    ),
    createNeoPreferenceOperation(service),
    ...createPackPreferenceOperations(service.db.getDatabase(), () => service.installedPacks()),
    ...wireNeoTodoMutations(
      createNeoTodoOperations(
        service.todos,
        service.todoSessions,
        todoControls,
        () => service.installedPacks(),
        createArtifactRefReader(() => service.db.getDatabase()),
        (todos) => service.todoWorkers(todos)
      ),
      {
        gateway: mutationGateway,
        write: mutationGateway.run.bind(mutationGateway),
        packs: () => service.installedPacks(),
        artifact: createArtifactRefReader(() => service.db.getDatabase()),
        stop: (todo) => service.todoRunner.stop(todo),
        start: (id) => service.todoRunner.start(id),
        changed: () => service.notifyChanged(),
        project: (todos) => service.todoWorkers(todos),
      }
    ),
    createNeoCardSearchOperation(
      (query, cursor, limit) => service.db.searchNeoCardsAsync(query, cursor, limit),
      (caller) => admitNeoCaller(service, caller, 'neo.ask.search')
    ),
    createNeoAskReadOperation(
      service.todos,
      () => service.installedPacks(),
      (caller) => admitNeoCaller(service, caller, 'neo.ask.read'),
      (todos) => service.todoWorkers(todos)
    ),
    createNeoDoneTodosOperation(
      service.todos,
      service.todoSessions,
      () => service.installedPacks(),
      (caller) => admitNeoCaller(service, caller, 'neo.ask.doneTodos'),
      (todos) => service.todoWorkers(todos)
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
      () => service.installedPacks(),
      (id) => new SessionGoalRepository(service.db.getDatabase()).get(id),
      (todos) => service.todoWorkers(todos),
      { gateway: mutationGateway, changed: () => service.notifyChanged() }
    ),
    ...createNeoQuestionOperations(
      service.todos,
      (ask, question, note) =>
        service.deliverForward(
          ask.sessionId,
          `neo-question:${question.id}`,
          note,
          ask.sessionId,
          'event'
        ),
      (todoId) => service.todoRunner.start(todoId),
      (caller, id) => !!caller.sessionId && !!receivedNeoHumanInput(service, caller.sessionId, id),
      createArtifactRefReader(() => service.db.getDatabase()),
      (ref) => service.readQuestionSource(ref),
      (caller, ids, askId) => {
        const consumed = caller.consumedInputId;
        const source = ids ?? (consumed ? [consumed] : []);
        const inputs = caller.sessionId
          ? source.map((id) => receivedNeoHumanInput(service, caller.sessionId!, id))
          : [];
        const conversationId = service.repo.conversationId();
        const related = inputs.every(
          (input) =>
            !input?.replyTo ||
            input.replyTo.kind === 'message' ||
            readNeoReply(input.replyTo, service.todos)?.ask?.id === askId
        );
        return conversationId && inputs.length && inputs.every(Boolean) && related
          ? {
              conversationId,
              sourceMessageIds: source,
              language: service.db.getGlobalSettings().language,
            }
          : null;
      },
      (id) => service.notifyPublicationsChanged(id),
      (questionId) => service.deliverQuestionAnswers(questionId)
    ),
    defineOperation({
      name: 'neo.open',
      description:
        'Open the one Neo conversation; a projectId is checked and opens the same session. The bound Neo session may open itself.',
      inputSchema: Scope,
      resultSchema: Snapshot,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
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
        'Prefer neo.rule.ask for human confirmation first. Directly add or remove standing rules only with human approval: pass messageId from the approving human message’s [message id: ...] line. The daemon records that message reference with each added rule, so consent stays traceable; paraphrasing is allowed. The message must be a consumed human yes replying to the immutable neo.rule.ask proposal for these exact add/remove arrays in this Neo conversation; system notes and other sessions cannot authorize edits. Remove uses exact saved rule text. Already-applied approvals return the current rules without replaying the edit. Each rule may have up to 500 characters.',
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
    ...service.installedPacks().flatMap((pack) =>
      (pack.operations ?? []).map((operation) => ({
        ...operation,
        execute: path(operation.name, operation.execute),
      }))
    ),
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
      name: 'neo.ask.history',
      description:
        'Page older finished/dropped Work summaries, twenty at a time. Pass the snapshot historyCursor as before, then nextCursor until null. Attention-needed asks stay in neo.snapshot. Open full bodies with neo.ask.read.',
      inputSchema: z.object({ projectId: z.string().optional(), before: HistoryCursor }),
      resultSchema: z.union([
        Failure,
        z.object({
          ok: z.literal(true),
          entries: z.array(NeoAskEntrySchema),
          nextCursor: HistoryCursor.nullable(),
        }),
      ]),
      policy: { safetyClass: 'read', roles: ['neo'] },
      execute: path(
        'neo.ask.history',
        async (input: { projectId?: string; before: z.infer<typeof HistoryCursor> }) => {
          const scope = input.projectId
            ? (service.repo.projectMerges.resolve(input.projectId) ?? input.projectId)
            : undefined;
          const page = await service.todos.read('snapshot', scope, 21, true, input.before);
          const asks = page.asks.slice(0, 20);
          const last = asks.at(-1);
          return {
            ok: true as const,
            entries: neoSnapshotAskEntries(
              projectNeoAskEntries(asks, page.facts, service.installedPacks()),
              20
            ).todoAsks.map(summarizeNeoAskEntry),
            nextCursor:
              page.asks.length > 20 && last ? { updatedAt: last.updatedAt, id: last.id } : null,
          };
        }
      ),
    }),
    defineOperation({
      name: 'neo.snapshot',
      description:
        'Read durable project summaries and todo asks. Pass projectId to load that project’s full context. RPC includes every open/attention-needed ask plus the ten most recently updated finished/dropped asks; historyCursor pages older outcomes through neo.ask.history. RPC todoAsks are summaries with counts, todo states and one-line statuses; instructions, reports and question text load through neo.ask.read when the card is opened. MCP todoAsks retain full todo details, ordered blocked, failed, doing, not started, done, then removed, and open questions; doneCount is how many of its todos are done, and an ask with more than 3 done todos (20 for RPC clients) lists none of its done todos, so read them with neo.ask.doneTodos; packRows holds pack facts, such as the coding pack’s pull request ledger with each PR’s state and owner. A list that does not hold every ask says so in omitted ({asks}: how many were left out), so never answer all or none from it. MCP snapshots over 40 KB are trimmed and carry a trimmed note saying what was cut. Every snapshot carries rev; pass it back as sinceRev and an unchanged snapshot answers only {unchanged: true, rev}, so read again only after something happened.',
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
