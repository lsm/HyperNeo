import { neoUserFolder } from '../../neo/folder.ts';
import { createWorkerNameSource } from '../../drivers/worker-names.ts';
import { PACKAGE_DOWNLOAD_WAIT_MS } from '../../agent/npm-package-download.ts';
import { findExecutable } from '../../drivers/find-executable.ts';
import { gitWorktreeProject } from '../../drivers/worktree-project.ts';
import { resolveNewSessionModel } from '../../session/new-session-model.ts';
import { workerWorktreeHasSubmodules } from '../../drivers/work-placement.ts';
import { releaseWorkerSandbox } from '../../drivers/worker-sandbox.ts';
import { sessionSdkPath } from '../../session/sdk-path.ts';
import { sdkPendingRemoval } from '../../../storage/repositories/sdk-message-transactions.ts';
import { copilotOwnsSession } from '../../drivers/copilot-find.ts';
import { createDriverHealthRuntime } from '../../drivers/driver-health-runtime.ts';
import { startCuChecker } from '../../drivers/codex-cu-reaper.ts';
import { createCopilotAdapter } from '../../drivers/copilot-adapter.ts';
import { dirname, resolve } from 'node:path';
import { ensureCodexDesktopProject } from '../../drivers/codex-desktop-project.ts';
import { neoWorkerPermissionMode } from '@hyperneo/shared/types/settings';
import { sleep } from '../../utils/sleep.ts';
import { withdrawOwnedInput } from '../../drivers/owned-input-withdrawal.ts';
import { readWorkInput } from '../../../storage/work-input.ts';
import {
  workStartPreparation,
  type WorkExecutionPreparer,
} from '../../drivers/start-preparation.ts';
import { mirrorNeoWorkspaceProjectsAsync } from '../../neo/project-mirror-async.ts';
import { NeoRepository } from '../../../storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../storage/repositories/neo-todo-session-repository.ts';
import { WorkDeliveryInputRepository } from '../../../storage/repositories/work-delivery-input-repository.ts';
import { readDriverOutcome } from '../../neo/driver-work.ts';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { codexStatePath } from '../../../storage/codex-desktop-read.ts';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import type { WorkChatKind, WorkChatMatch } from '../../../storage/work-chat-search.ts';
import {
  markWorkUnusable,
  readReusableWorkers,
  recordStartedWork,
  type StartedWork,
} from '../../../storage/work-started-sessions.ts';
import { resolveCopilotRuntime } from '../../providers/anthropic-copilot/copilot-cli-resolver.ts';
import {
  COPILOT_CLIENT,
  createCopilotDiscovery,
  listCopilotSessions,
  reuseCopilotSessionList,
} from '../../drivers/copilot-discovery.ts';
import {
  createClaudeDesktopAdapter,
  readClaudeDesktopRecords,
  readLiveClaudeSessions,
  type ClaudeDesktopAdapterDeps,
  type ClaudeRecordCache,
} from '../../drivers/claude-desktop-adapter.ts';
import { readHyperneoSdkSessions } from '../../drivers/claude-feed.ts';
import { createClaudeCodeAdapter } from '../../drivers/claude-code-adapter.ts';
import { startWorkSessionSync } from '../../drivers/work-session-sync.ts';
import { withClaudeRemoteControl } from '../../drivers/claude-remote-control.ts';
import {
  connectCodexAppServer,
  startCodexBootstrapServer,
} from '../../drivers/codex-app-server.ts';
import { startCodexDesktopTurn } from '../../drivers/codex-desktop-handoff.ts';
import {
  createCodexDesktopAdapter,
  type CodexSnapshot,
} from '../../drivers/codex-desktop-adapter.ts';
import { createFindWorkOperation } from '../../drivers/find-operation.ts';
import { createReadWorkOperation } from '../../drivers/read-operation.ts';
import {
  createHyperneoAdapter,
  type HyperneoSessionControl,
} from '../../drivers/hyperneo-adapter.ts';
import type { PlaceGroup, WorkAdapter } from '../../drivers/types.ts';
import {
  createWorkVerbOperations,
  type WorkSendUncertainty,
  type WorkVerbDeps,
} from '../../drivers/work-operations.ts';
import { sessionSender } from '../../messaging/message-send.ts';
import { renderAddress } from '../../mailbox/address.ts';
import { createNeoSessionArchiveOperation } from '../../neo/session-archive-operation.ts';
import { reject } from '../../drivers/work-operations.ts';
import { handoffPromptToMailbox } from '../../mailbox/handoff.ts';
import { invokeOperation } from '../../operations/invoke.ts';
import type { OperationCaller, OperationDefinition } from '../../operations/registry.ts';
import { neoFolder } from '../../neo/folder.ts';
import { neoStartPlace } from '../../neo/start-place.ts';
import { neoTodoRepository } from '../../neo/pack-contract.ts';
import { neoTodoPolicies } from '../../neo/packs/todo-policies.ts';
import { remoteDaemons } from '../../remote-daemons/registry.ts';
import { spawnProcess } from '../../runtime-spawn/index.ts';
import { WorktreeManager } from '../../worktree-manager.ts';
import { readWorkTurnPage, type WorkTurnPage } from '../../../storage/work-turn-page.ts';
import type { SessionManager } from '../../session/session-manager.ts';
import { ModelUnavailableError } from '../../session/session-lifecycle.ts';
import {
  THINKING_OPTIONS,
  type ModelInfo,
  type Provider,
  type SessionConfig,
} from '@hyperneo/shared';
import type { FamilyOperationContext } from './context.ts';
import { embedQueryOrNull } from '../../../storage/vector-similarity.ts';
import { usableModels } from '../../usable-models.ts';
import { planWorkPlacement, type GitCheckout } from '../../drivers/work-placement.ts';

const WORK_CHAT_LIMIT = 200;
const SEARCH_REUSE_MS = 2_000;

export function newestAvailableModel(models: readonly ModelInfo[]): ModelInfo | null {
  return usableModels(models).reduce<ModelInfo | null>(
    (newest, model) => (!newest || model.releaseDate > newest.releaseDate ? model : newest),
    null
  );
}

async function readAvailableModels(): Promise<readonly ModelInfo[]> {
  const { getAvailableModels } = await import('../../model-service.ts');
  return getAvailableModels('global');
}

async function resolveDriverModel(models: readonly ModelInfo[], requested: string) {
  const { findInModels } = await import('../../model-service.ts');
  const available = usableModels(models);
  const exact = available.find((entry) => entry.id === requested);
  if (exact) return exact;
  const names = available.filter((entry) => entry.name?.toLowerCase() === requested.toLowerCase());
  if (names.length > 1)
    throw new ModelUnavailableError(
      `Model name '${requested}' is ambiguous: ${names.map((entry) => `${entry.id} (${entry.provider})`).join(', ')}. Choose an exact model ID.`
    );
  return names[0] ?? findInModels(available, requested) ?? null;
}

export async function createDriverSession(
  sessionManager: Pick<SessionManager, 'createSession' | 'getWorktreeManager'>,
  workspacePath: string,
  title: string,
  model?: string,
  availableModels: () => Promise<readonly ModelInfo[]> = readAvailableModels,
  provider?: string,
  effort?: string,
  inPlace = false,
  prepared?: { sessionId: string; projectPath: string }
): Promise<string> {
  const gitRoot = inPlace
    ? null
    : (await sessionManager.getWorktreeManager().detectGitSupport(workspacePath)).gitRoot;
  const placement = planWorkPlacement(await checkoutAt(gitRoot));
  const thinkingLevel = THINKING_OPTIONS.find(
    (entry) => entry.label.toLowerCase() === effort
  )?.value;
  const create = (config?: Partial<SessionConfig>) =>
    sessionManager.createSession({
      workspacePath,
      title,
      ...(prepared
        ? { sessionId: prepared.sessionId, executionProjectPath: prepared.projectPath }
        : {}),
      worktreeMode: placement.kind === 'worktree' ? 'worktree' : 'direct',
      toolProfile: 'worker',
      ...(config || thinkingLevel
        ? { config: { ...config, ...(thinkingLevel ? { thinkingLevel } : {}) } }
        : {}),
    });
  const selected = model
    ? await resolveDriverModel(usableModels(await availableModels(), provider), model)
    : null;
  if (model && !selected) throw new ModelUnavailableError(`Model '${model}' is not available.`);
  try {
    return await create(
      selected ? { model: selected.id, provider: selected.provider as Provider } : undefined
    );
  } catch (error) {
    if (model || !(error instanceof ModelUnavailableError)) throw error;
    const newest = newestAvailableModel(await availableModels());
    if (!newest) throw error;
    return create({ model: newest.id, provider: newest.provider as Provider });
  }
}

async function checkoutAt(gitRoot: string | null): Promise<GitCheckout | null> {
  const repo = gitRoot ? await gitWorktreeProject(gitRoot) : null;
  return gitRoot && repo ? { repo, linked: repo !== gitRoot } : null;
}

async function readGitCheckout(folder: string): Promise<GitCheckout | null> {
  return checkoutAt((await new WorktreeManager().detectGitSupport(folder)).gitRoot);
}

export function hyperneoSessionControl(context: FamilyOperationContext): HyperneoSessionControl {
  const { sessionManager, internalEventBus, db } = context.deps;
  return {
    rename: async (ref, title) => {
      const session = sessionManager.getSessionFromDB(ref.id);
      if (!session) return reject('not_found', 'The session is gone.');
      await sessionManager.updateSession(ref.id, {
        title,
        metadata: { ...session.metadata, titleSetBy: 'user', titleGenerated: true },
      });
      return { ok: true, value: { renamed: true, title } };
    },
    withdraw: (sessionId, id, from) =>
      withdrawOwnedInput(sessionId, id, from, {
        db: db.getDatabase(),
        removeDeferred: async (target, dbId, jobId) => {
          const session = sessionManager.getCachedSession(target);
          if (session)
            return (await session.revokePendingDelivery(dbId, 'remove', 'deferred', jobId)).changed;
          const removed = await db.gateway.run(sdkPendingRemoval, {
            sessionId: target,
            messageDbId: dbId,
            mode: 'remove',
            expectedStatus: 'deferred',
            withdrawalJobId: jobId,
          });
          return !!removed?.uuid;
        },
      }),
    archive: async (ref, admit) => {
      const session = sessionManager.getSessionFromDB(ref.id);
      if (!session) return reject('not_found', 'The session is gone.');
      if (context.deps.db.listChildSessions(ref.id).length)
        return reject('unsupported', 'Archive sessions with clones in the session UI.');
      if (session.worktree) {
        const manager = sessionManager.getWorktreeManager();
        const commits = await manager.getCommitsAhead(session.worktree);
        const directory = session.worktree.worktreePath ?? session.workspacePath!;
        if (await workerWorktreeHasSubmodules(directory))
          return reject('unsupported', 'Submodule worktrees require manual verification; kept.');
        const git = await simpleGit(directory).status(['--ignore-submodules=none']);
        if (commits.hasCommitsAhead || !git.isClean())
          return reject(
            'unsupported',
            'The worktree has changes, unpushed commits or cannot be verified; kept. Manage its archive in the session UI.'
          );
      }
      const refused = admit();
      if (refused) return refused;
      const processing = sessionManager.getCachedSession(ref.id)?.getProcessingState().status;
      if (processing && !['idle', 'interrupted'].includes(processing))
        return reject('busy', 'The HyperNeo session still has a live turn.');
      if (session.status === 'archived') {
        await releaseWorkerSandbox(sessionSdkPath(session));
        return { ok: true, value: { archived: false } };
      }
      await sessionManager.archiveSessionResources(ref.id, 'ui_session_archive');
      return { ok: true, value: { archived: true } };
    },
    create: (workspacePath, title, model, provider, effort, inPlace, prepared) =>
      createDriverSession(
        sessionManager,
        workspacePath,
        title,
        model,
        readAvailableModels,
        provider,
        effort,
        inPlace,
        prepared
      ),
    resolveModel: async (model) => resolveDriverModel(await readAvailableModels(), model),
    resolveDefaultModel: async () => {
      const { decision } = await resolveNewSessionModel(
        undefined,
        undefined,
        db.getGlobalSettings(),
        context.deps.config.defaultModel
      );
      return decision.kind === 'model' && decision.provider
        ? { id: decision.id, provider: decision.provider }
        : decision.kind === 'unavailable'
          ? newestAvailableModel(await readAvailableModels())
          : null;
    },
    effort: (sessionId) =>
      THINKING_OPTIONS.find(
        (entry) => entry.value === sessionManager.getSessionFromDB(sessionId)?.config?.thinkingLevel
      )?.label.toLowerCase() ?? null,
    model: (sessionId) => sessionManager.getSessionFromDB(sessionId)?.config?.model ?? null,
    provider: (sessionId) => sessionManager.getSessionFromDB(sessionId)?.config?.provider ?? null,
    chooseWorktree: async (sessionId) => {
      await sessionManager.getSessionLifecycle().completeWorktreeChoice(sessionId, 'worktree');
    },
    announce: (sessionId) => {
      const session = sessionManager.getSessionFromDB(sessionId);
      if (session)
        internalEventBus.publish('session.created', { sessionId, session }).catch(() => {});
    },
    interrupt: async (sessionId) => {
      const session = sessionManager.getCachedSession(sessionId);
      if (!session) return false;
      await internalEventBus.publish('agent.interruptRequest', { sessionId });
      return (
        sessionManager.getCachedSession(sessionId) === session &&
        ['idle', 'interrupted'].includes(session.getProcessingState().status)
      );
    },
  };
}

export const CLAUDE_DESKTOP_SESSIONS = join(
  homedir(),
  'Library',
  'Application Support',
  'Claude',
  'claude-code-sessions'
);

export async function ownClaudeSessions(
  started: readonly StartedWork[],
  desktopSessionsDir: string
): Promise<Set<string>> {
  const desktop = new Set(
    started.flatMap((ref) => (ref.adapter === 'claude-desktop' ? [ref.id] : []))
  );
  const records = desktop.size ? await readClaudeDesktopRecords(desktopSessionsDir, new Map()) : [];
  return new Set([
    ...started.flatMap((ref) => (ref.adapter === 'claude-code' ? [ref.id] : [])),
    ...records.flatMap((record) =>
      desktop.has(record.sessionId) && record.cliSessionId ? [record.cliSessionId] : []
    ),
  ]);
}

function claudeCodeAdapters(
  searchChats: (text: string, kinds: readonly WorkChatKind[]) => Promise<readonly WorkChatMatch[]>,
  ownedSessions: () => ReadonlySet<string>,
  inbox: FamilyOperationContext['claudeInbox'],
  desktop: WorkAdapter | undefined
): WorkAdapter[] {
  const cache: ClaudeRecordCache = new Map();
  return [
    createClaudeCodeAdapter({
      sendInbox: inbox?.send,
      desktopSend: desktop?.send,
      desktopRecords: async () =>
        existsSync(CLAUDE_DESKTOP_SESSIONS)
          ? readClaudeDesktopRecords(CLAUDE_DESKTOP_SESSIONS, cache)
          : [],
      projectsDir: join(homedir(), '.claude', 'projects'),
      liveSessions: () => readLiveClaudeSessions(spawnProcess),
      ownedSessions,
      machine: hostname(),
      searchChats: (text) => searchChats(text, ['claude']),
      desktopSessions: async () =>
        new Set(
          (existsSync(CLAUDE_DESKTOP_SESSIONS)
            ? await readClaudeDesktopRecords(CLAUDE_DESKTOP_SESSIONS, cache)
            : []
          ).flatMap((record) => record.cliSessionId ?? [])
        ),
    }),
  ];
}

function claudeDesktopAdapters(
  searchChats: (text: string, kinds: readonly WorkChatKind[]) => Promise<readonly WorkChatMatch[]>,
  prepareExecution: WorkExecutionPreparer,
  inbox: FamilyOperationContext['claudeInbox'],
  mods: FamilyOperationContext['claudeDesktopMods'],
  permissionMode: () => string,
  readInput: NonNullable<ClaudeDesktopAdapterDeps['readInput']>,
  readRecords: NonNullable<ClaudeDesktopAdapterDeps['readRecords']>
): WorkAdapter[] {
  const sessionsDir = CLAUDE_DESKTOP_SESSIONS;
  const deps: ClaudeDesktopAdapterDeps = {
    readInput,
    mods: mods?.ready,
    sessionsDir,
    readRecords,
    sendInbox: inbox?.send,
    admitInbox: inbox?.admit,
    prepareExecution,
    projectsDir: join(homedir(), '.claude', 'projects'),
    machine: hostname(),
    liveSessions: () => readLiveClaudeSessions(spawnProcess),
    spawn: spawnProcess,
    folderExists: existsSync,
    makeFolder: (folder: string) => mkdirSync(folder),
    homeDir: homedir(),
    gitCheckout: readGitCheckout,
    newId: () => crypto.randomUUID(),
    sleep,
    now: Date.now,
    searchChats: (text) => searchChats(text, ['claude']),
    permissionMode,
  };
  return [withClaudeRemoteControl(createClaudeDesktopAdapter(deps), deps)];
}

function copilotAdapters(
  ownSessions: () => ReadonlySet<string>,
  context: FamilyOperationContext
): WorkAdapter[] {
  if (!findExecutable(COPILOT_CLIENT.bin)) return [];
  const directory = join(dirname(resolve(context.deps.config.dbPath)), 'copilot-workers');
  const resolveCliPath = async (waitMs?: number) =>
    (await resolveCopilotRuntime(process.env, waitMs)).path;
  const discovery = createCopilotDiscovery({
    machine: hostname(),
    now: Date.now,
    listSessions: reuseCopilotSessionList(
      async () => listCopilotSessions(await resolveCliPath(PACKAGE_DOWNLOAD_WAIT_MS)),
      Date.now
    ),
    ownSessions: () => {
      const ids = ownSessions();
      return { has: (id: string) => ids.has(id) || copilotOwnsSession(directory, id) };
    },
    projectFolder: gitWorktreeProject,
    ...(existsSync(COPILOT_CLIENT.app.path) ? { link: COPILOT_CLIENT.app.link } : {}),
  });
  const adapter = createCopilotAdapter(discovery, {
    resolveCliPath,
    directory,
    projectFolder: gitWorktreeProject,
    gitCheckout: readGitCheckout,
    spawn: spawnProcess,
    worktreesDir: join(directory, 'worktrees'),
    machine: hostname(),
    env: process.env,
    homeDir: homedir(),
    folderExists: existsSync,
    makeFolder: (folder) => mkdirSync(folder),
  });
  context.driverCleanup?.push(() => adapter.close());
  return [adapter];
}

function codexDesktopAdapters(
  readSnapshot: (
    statePath: string,
    includeClosed: boolean,
    idPrefix?: string
  ) => Promise<CodexSnapshot>,
  searchChats: (text: string, kinds: readonly WorkChatKind[]) => Promise<readonly WorkChatMatch[]>,
  prepareExecution: WorkExecutionPreparer
): WorkAdapter[] {
  const codexHome = join(homedir(), '.codex');
  const statePath = codexStatePath(homedir());
  if (!existsSync(statePath)) return [];
  return [
    createCodexDesktopAdapter({
      statePath,
      readSnapshot,
      desktopSocketPath: join(codexHome, 'ipc', 'ipc.sock'),
      prepareExecution,
      worktreesDir: join(codexHome, 'worktrees'),
      machine: hostname(),
      now: Date.now,
      spawn: spawnProcess,
      appServer: () =>
        connectCodexAppServer(join(codexHome, 'app-server-control', 'app-server-control.sock')),
      bootstrapServer: () => startCodexBootstrapServer(),
      prepareDesktopProject: (folder) => ensureCodexDesktopProject(folder, codexHome, spawnProcess),
      startDesktopTurn: (threadId, request) =>
        startCodexDesktopTurn(join(codexHome, 'ipc', 'ipc.sock'), spawnProcess, threadId, request),
      folderExists: existsSync,
      makeFolder: (folder: string) => mkdirSync(folder),
      homeDir: homedir(),
      gitCheckout: readGitCheckout,
      newId: () => crypto.randomUUID(),
      searchChats: (text) => searchChats(text, ['codex']),
    }),
  ];
}

export function registerDriverOperations(context: FamilyOperationContext): OperationDefinition[] {
  const prepareExecution: WorkExecutionPreparer = (request, location) =>
    workStartPreparation.prepare(request, location, context.executionPreparations?.() ?? [], {
      run: async (command, directory) => {
        const process = spawnProcess([...command], {
          cwd: directory,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [code, stdout, stderr] = await Promise.all([
          process.exited,
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
        ]);
        return { code, stdout, stderr };
      },
    });
  const db = () => context.deps.db.getDatabase();
  const machine = hostname();
  const recentVectors = new Map<string, { at: number; semantic: ReturnType<typeof embedQuery> }>();
  const recentSearches = new Map<
    string,
    { at: number; chats: Promise<readonly WorkChatMatch[]> }
  >();
  const embedQuery = async (text: string) => {
    const embedder = context.deps.db.getEmbedder();
    if (!context.deps.db.getSDKMessageRepo().hasTurnVectors(embedder.model)) return undefined;
    const vector = await embedQueryOrNull(embedder, text);
    return vector ? { vector, model: embedder.model } : undefined;
  };
  const recent = <Value>(
    cache: Map<string, { at: number } & Value>,
    key: string,
    make: () => Value
  ): Value => {
    const now = Date.now();
    for (const [stale, entry] of cache) if (now - entry.at >= SEARCH_REUSE_MS) cache.delete(stale);
    const found = cache.get(key);
    if (found) return found;
    const made = make();
    cache.set(key, { ...made, at: now });
    return made;
  };
  const searchChats = (
    text: string,
    kinds: readonly WorkChatKind[]
  ): Promise<readonly WorkChatMatch[]> => {
    const key = `${kinds.join(',')}:${text}`;
    return recent<{ chats: Promise<readonly WorkChatMatch[]> }>(recentSearches, key, () => {
      const chats = recent(recentVectors, text, () => ({
        semantic: embedQuery(text),
      })).semantic.then((vectors) =>
        context.deps.db.searchWorkChatsAsync(text, WORK_CHAT_LIMIT, vectors, kinds)
      );
      void chats.catch(() => {
        if (recentSearches.get(key)?.chats === chats) recentSearches.delete(key);
      });
      return { chats };
    }).chats;
  };
  const ownChats = (text: string) => searchChats(text, ['message', 'task']);
  const desktop = claudeDesktopAdapters(
    searchChats,
    prepareExecution,
    context.claudeInbox,
    context.claudeDesktopMods,
    () => neoWorkerPermissionMode(context.deps.db.getGlobalSettings().neo),
    (sessionId, marker) =>
      context.deps.db.gateway.call(readWorkInput, 'find', sessionId, {
        adapter: 'claude-code',
        marker,
      }),
    (sessionsDir) => context.deps.db.readClaudeRecordsAsync(sessionsDir)
  );
  context.driverCleanup?.push(
    startCuChecker(() => context.deps.db.getGlobalSettings().codexCuAutoReap !== false)
  );
  const codex = () =>
    codexDesktopAdapters(
      (statePath, includeClosed, idPrefix) =>
        context.deps.db.readCodexSnapshotAsync(statePath, includeClosed, idPrefix),
      searchChats,
      prepareExecution
    );
  const adapters = [
    createHyperneoAdapter({
      readTurnEnds: (sessionId, since) =>
        context.deps.db.readHyperneoTurnEndsAsync(sessionId, since),
      readTurnFacts: (sessionId, cursor, limit) =>
        context.deps.db.readHyperneoTurnFactsAsync(sessionId, cursor, limit),
      prepareExecution,
      projects: () => context.deps.db.workspaceHistory.projects(),
      db,
      machine,
      searchChats: ownChats,
      handoff: (sessionId, message, from, messageUuid, deliveryMode, once) =>
        handoffPromptToMailbox({
          to: renderAddress({ kind: 'session', sessionId }),
          message: {
            type: 'user',
            message: { role: 'user', content: message },
            parent_tool_use_id: null,
          },
          origin: from,
          messageUuid,
          deliveryMode,
          once,
          jobQueue: context.deps.jobQueue,
        }),
      sessions: hyperneoSessionControl(context),
      neoFolder,
      folderExists: existsSync,
      makeFolder: (folder: string) => mkdirSync(folder),
      homeDir: homedir(),
    }),
    ...codex(),
    ...desktop,
    ...claudeCodeAdapters(
      searchChats,
      () => readHyperneoSdkSessions(db()),
      context.claudeInbox,
      desktop[0]
    ),
    ...copilotAdapters(
      () => new Set(context.deps.db.listAcpSessionIds().map((session) => session.acpSessionId)),
      context
    ),
  ];
  let selectedCodex = adapters.some((adapter) => adapter.id === 'codex-desktop')
    ? codexStatePath(homedir())
    : null;
  const currentAdapters = () => {
    const path = codexStatePath(homedir());
    const selected = existsSync(path) ? path : null;
    if (selected !== selectedCodex) {
      selectedCodex = selected;
      const index = adapters.findIndex((adapter) => adapter.id === 'codex-desktop');
      if (index >= 0) adapters.splice(index, 1);
      if (selected) adapters.push(...codex());
    }
    return [
      adapters[0],
      ...(context.extensionAdapters?.({ searchChats: ownChats }) ?? []),
      ...adapters.slice(1),
    ];
  };
  const folder = neoUserFolder(context.deps.config.workspaceRoot);
  context.workerNameSource?.(
    createWorkerNameSource(currentAdapters, { machine, folder, name: folder })
  );
  const health = createDriverHealthRuntime(context, currentAdapters);
  startWorkSessionSync(context.deps.db.gateway, context.deps.jobProcessor, currentAdapters);
  const deps = {
    adapters: currentAdapters,
    health: health.read,
    remote: remoteDaemons,
    daemonName: machine,
    startPlace: neoStartPlace({
      db: db(),
      machine,
      workspaceRoot: context.deps.config.workspaceRoot,
      repository: (todo, ask) =>
        neoTodoRepository(todo ?? { check: null, named: null }, neoTodoPolicies(db()), {
          ask,
          todo,
          start: true,
        }),
    }),
    isOpenTodo: (todoId: string, sessionId: string) => {
      const store = new NeoAskTodoRepository(db());
      const todo = store.getTodo(todoId);
      const ask = todo ? store.getAsk(todo.askId) : null;
      return (
        !!todo &&
        ['todo', 'doing', 'blocked'].includes(todo.state) &&
        ask?.status === 'open' &&
        ask.sessionId === sessionId
      );
    },
    todoWorker: {
      on: (todoId, ref) => new NeoTodoSessionRepository(db()).sendsNow(todoId, ref),
      wait: (todoId, ref, message) =>
        new NeoTodoSessionRepository(db()).write('queueOn', todoId, ref, message),
    } satisfies WorkVerbDeps['todoWorker'],
    workInputs: {
      accept: (todoId, from, target, message) =>
        new WorkDeliveryInputRepository(db()).accept(todoId, from, target, message, Date.now()),
      recordOutcome: (id, target, outcome) =>
        new WorkDeliveryInputRepository(db()).recordOutcome(
          id,
          readDriverOutcome(target, { kind: 'completed', value: outcome }),
          Date.now()
        ),
      recordFailure: (id, error) =>
        new WorkDeliveryInputRepository(db()).recordOutcome(
          id,
          { failure: String(error) },
          Date.now()
        ),
    } satisfies WorkVerbDeps['workInputs'],
    recordStarted: (ref: StartedWork) => recordStartedWork(db(), ref),
    freeWorkers: (adapter: string, todoId?: string, sessionId?: string) =>
      readReusableWorkers(db(), adapter, todoId, sessionId),
    markUnusable: (ref: StartedWork) => markWorkUnusable(db(), ref),
    reportUncertain: async (report: WorkSendUncertainty) => {
      const to = sessionSender(report.from) ?? new NeoRepository(db()).defaultBinding()?.sessionId;
      if (!to) throw new Error('No originating session or default Neo for the uncertainty report.');
      const completion =
        report.lastCompletion === undefined
          ? 'unavailable'
          : new Date(report.lastCompletion).toISOString();
      const outcome = await invokeOperation(
        context.deps.sessionManager.getOperationRegistry(),
        'message.send',
        {
          to,
          kind: 'blocked',
          text: `Codex Desktop handoff uncertain for ${report.ref.id}. ${report.detail} Last confirmed engine completion: ${completion}. Inspect work.status and the Desktop queue; do not automatically replay or start another writer. Engine completion does not prove this input was consumed.`,
          idempotencyKey: `desktop-send-uncertain:${report.id}`,
          from: `session:codex-desktop:${report.ref.id}`,
        },
        { source: 'rpc' }
      );
      if (outcome.kind !== 'completed' || (outcome.value as { kind: string }).kind !== 'accepted')
        throw new Error(JSON.stringify(outcome));
    },
    namedFolder: {
      machine,
      homeDir: homedir(),
      isDirectory: (folder: string) => {
        try {
          return statSync(folder).isDirectory();
        } catch {
          return false;
        }
      },
    },
    ownPlaces: (caller: OperationCaller) => {
      const repo = new NeoRepository(db());
      const projectId = caller.sessionId
        ? repo.getBindingBySession(caller.sessionId)?.projectId
        : null;
      return new Set(
        projectId
          ? repo
              .workspaceAliases(projectId)
              .flatMap((alias) => (alias.startsWith('folder:') ? [alias.slice(7)] : []))
          : []
      );
    },
    mirrorProjects: async (groups: readonly PlaceGroup[]) => {
      if (await mirrorNeoWorkspaceProjectsAsync(context.deps.db, groups))
        context.deps.messageHub.event('neo.changed', {});
    },
  };
  const readTurns = (
    sessionId: string,
    around: string | undefined,
    before: number,
    after: number,
    cursor?: WorkTurnPage['nextCursor']
  ) => {
    for (const adapter of adapters) {
      const page = adapter.readTurns?.(sessionId, around, before, after, cursor);
      if (page) return page;
    }
    return cursor?.copilot
      ? null
      : readWorkTurnPage(db(), sessionId, around, before, after, cursor);
  };
  return [
    createFindWorkOperation(deps),
    health.operation,
    ...createWorkVerbOperations(deps),
    createNeoSessionArchiveOperation({ ...deps, db: context.deps.db }),
    createReadWorkOperation({
      readTurns,
      readInput: async (sessionId, input) =>
        input.adapter === 'codex-desktop' || input.adapter === 'claude-code'
          ? context.deps.db.gateway.call(readWorkInput, 'find', sessionId, {
              adapter: input.adapter,
              marker: input.marker,
            })
          : (adapters
              .find((adapter) => adapter.id === input.adapter)
              ?.readInput?.(sessionId, input.marker) ?? null),
      remote: remoteDaemons,
      daemonName: machine,
    }),
  ];
}
