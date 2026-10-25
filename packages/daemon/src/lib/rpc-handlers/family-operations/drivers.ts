import { sdkPendingRemoval } from '../../../storage/repositories/sdk-message-transactions.ts';
import { copilotOwnsSession } from '../../drivers/copilot-find.ts';
import { createCopilotAdapter } from '../../drivers/copilot-adapter.ts';
import { dirname, resolve } from 'node:path';
import { ensureCodexDesktopProject } from '../../drivers/codex-desktop-project.ts';
import { neoWorkerPermissionMode } from '@hyperneo/shared/types/settings';
import { sleep } from '../../utils/sleep.ts';
import { withdrawOwnedInput } from '../../drivers/owned-input-withdrawal.ts';
import {
  workStartPreparation,
  type WorkExecutionPreparer,
} from '../../drivers/start-preparation.ts';
import { mirrorNeoWorkspaceProjectsAsync } from '../../neo/project-mirror-async.ts';
import { NeoRepository } from '../../../storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../storage/repositories/neo-ask-todo-repository.ts';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { codexStatePath } from '../../../storage/codex-desktop-read.ts';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import type { WorkChatKind, WorkChatMatch } from '../../../storage/work-chat-search.ts';
import { recordStartedWork, type StartedWork } from '../../../storage/work-started-sessions.ts';
import {
  ACP_AGENTS,
  createAcpAgentAdapter,
  findAcpAgentBinary,
  gitWorktreeProject,
  listAcpAgentSessions,
  reuseAcpSessionList,
} from '../../drivers/acp-agent-adapter.ts';
import {
  createClaudeDesktopAdapter,
  readClaudeDesktopRecords,
  readLiveClaudeSessions,
  type ClaudeDesktopAdapterDeps,
  type ClaudeRecordCache,
} from '../../drivers/claude-desktop-adapter.ts';
import { readHyperneoSdkSessions } from '../../drivers/claude-feed.ts';
import { createClaudeCodeAdapter } from '../../drivers/claude-code-adapter.ts';
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
import {
  createSpaceAdapter,
  type SpaceTaskControl,
  spaceTaskCaller,
  taskOperationRejection,
} from '../../drivers/space-adapter.ts';
import type { PlaceGroup, WorkAdapter } from '../../drivers/types.ts';
import { createWorkVerbOperations } from '../../drivers/work-operations.ts';
import { renderAddress } from '../../mailbox/address.ts';
import { createNeoSessionArchiveOperation } from '../../neo/session-archive-operation.ts';
import { reject } from '../../drivers/work-operations.ts';
import { handoffPromptToMailbox } from '../../mailbox/handoff.ts';
import { invokeOperation } from '../../operations/invoke.ts';
import type { OperationCaller, OperationDefinition } from '../../operations/registry.ts';
import { neoFolder } from '../../neo/folder.ts';
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
  effort?: string
): Promise<string> {
  const { gitRoot } = await sessionManager.getWorktreeManager().detectGitSupport(workspacePath);
  const placement = planWorkPlacement(await checkoutAt(gitRoot));
  const thinkingLevel = THINKING_OPTIONS.find(
    (entry) => entry.label.toLowerCase() === effort
  )?.value;
  const create = (config?: Partial<SessionConfig>) =>
    sessionManager.createSession({
      workspacePath,
      title,
      worktreeMode: placement.kind === 'worktree' ? 'worktree' : 'direct',
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
  const { sessionManager, internalEventBus, db, jobQueue } = context.deps;
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
        jobs: jobQueue,
        transaction: (effect) => db.getDatabase().transaction(effect)(),
        messageId: (target, uuid) => db.getSDKMessageRepo().findMessageIdByUuid(target, uuid),
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
        const git = await simpleGit(
          session.worktree.worktreePath ?? session.workspacePath!
        ).status();
        if (commits.hasCommitsAhead || !git.isClean())
          return reject(
            'unsupported',
            'The worktree has changes or cannot be verified; archive it in the session UI.'
          );
      }
      const refused = admit();
      if (refused) return refused;
      const processing = sessionManager.getCachedSession(ref.id)?.getProcessingState().status;
      if (processing && !['idle', 'interrupted'].includes(processing))
        return reject('busy', 'The HyperNeo session still has a live turn.');
      if (session.status === 'archived') return { ok: true, value: { archived: false } };
      await sessionManager.archiveSessionResources(ref.id, 'ui_session_archive');
      return { ok: true, value: { archived: true } };
    },
    create: (workspacePath, title, model, provider, effort) =>
      createDriverSession(
        sessionManager,
        workspacePath,
        title,
        model,
        readAvailableModels,
        provider,
        effort
      ),
    resolveModel: async (model) => resolveDriverModel(await readAvailableModels(), model),
    effort: (sessionId) =>
      THINKING_OPTIONS.find(
        (entry) => entry.value === sessionManager.getSessionFromDB(sessionId)?.config?.thinkingLevel
      )?.label.toLowerCase() ?? null,
    model: (sessionId) => sessionManager.getSessionFromDB(sessionId)?.config?.model ?? null,
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
  inbox: FamilyOperationContext['claudeInbox']
): WorkAdapter[] {
  if (!existsSync(join(homedir(), '.claude', 'projects'))) return [];
  const cache: ClaudeRecordCache = new Map();
  return [
    createClaudeCodeAdapter({
      sendInbox: inbox?.send,
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
  permissionMode: () => string
): WorkAdapter[] {
  const sessionsDir = CLAUDE_DESKTOP_SESSIONS;
  if (!existsSync(sessionsDir)) return [];
  const deps: ClaudeDesktopAdapterDeps = {
    mods: mods?.ready,
    sessionsDir,
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

function acpAgentAdapters(
  ownSessions: () => ReadonlySet<string>,
  context: FamilyOperationContext
): WorkAdapter[] {
  return ACP_AGENTS.flatMap((agent) => {
    const command = findAcpAgentBinary(agent.bin);
    if (!command) return [];
    const directory = join(dirname(resolve(context.deps.config.dbPath)), 'copilot-workers');
    const adapters = [
      createAcpAgentAdapter({
        agent,
        machine: hostname(),
        now: Date.now,
        listSessions: reuseAcpSessionList(() => listAcpAgentSessions(command, agent), Date.now),
        ownSessions: () => {
          const ids = ownSessions();
          return {
            has: (id: string) =>
              ids.has(id) || (agent.id === 'copilot-cli' && copilotOwnsSession(directory, id)),
          };
        },
        projectFolder: gitWorktreeProject,
        ...(agent.app && existsSync(agent.app.path) ? { link: agent.app.link } : {}),
      }),
    ];
    if (agent.id !== 'copilot-cli') return adapters;
    const adapter = createCopilotAdapter(adapters[0], {
      cliPath: command,
      directory,
      projectFolder: gitWorktreeProject,
      machine: hostname(),
      env: process.env,
      homeDir: homedir(),
      folderExists: existsSync,
      makeFolder: (folder) => mkdirSync(folder),
    });
    context.driverCleanup?.push(() => adapter.close());
    return [adapter];
  });
}

function codexDesktopAdapters(
  readSnapshot: (statePath: string, includeClosed: boolean) => Promise<CodexSnapshot>,
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

export function spaceTaskControl(context: FamilyOperationContext): SpaceTaskControl {
  const invoke = async (name: string, input: unknown, caller: OperationCaller) => {
    const outcome = await invokeOperation(
      context.deps.sessionManager.getOperationRegistry(),
      name,
      input,
      spaceTaskCaller(caller)
    );
    return outcome.kind === 'completed' ? outcome.value : outcome.message;
  };
  return {
    rename: async (target, title, caller) => {
      const result = await invoke(
        target.agentId ? 'agent.update' : 'task.update',
        target.agentId
          ? { spaceId: target.spaceId, agentId: target.agentId, name: title }
          : { taskId: target.taskId, title },
        caller
      );
      const reason = taskOperationRejection(result);
      return reason
        ? reject('not_delivered', reason)
        : { ok: true, value: { renamed: true, title } };
    },
    create: async (spaceId, title, description, caller) => {
      const created = await invoke('task.create', { spaceId, title, description }, caller);
      const reason = taskOperationRejection(created);
      return reason === null ? { taskId: (created as { id: string }).id } : { reason };
    },
    messageAgent: async (agent, message, { from, caller }) => {
      const sent = (await invoke(
        'message.send',
        {
          agent: { space: agent.spaceId, agent: agent.id },
          message: {
            type: 'user',
            message: { role: 'user', content: message },
            parent_tool_use_id: null,
            ...(from === 'chat' ? {} : { inputKind: 'task' }),
          },
          from,
        },
        caller
      )) as { kind?: unknown; reason?: unknown } | string;
      if (typeof sent === 'object' && sent?.kind === 'accepted') return { accepted: true };
      return {
        reason:
          typeof sent === 'string' ? sent : String(sent?.reason ?? 'message.send refused it.'),
      };
    },
    message: async (taskId, node, message, fromHuman) => {
      try {
        const ensured = await context.spaceRuntimeService.ensureToolTargetSession({
          kind: 'worker',
          taskId,
          agentName: node.agentName,
          workflowNodeId: node.workflowNodeId,
          waitCapMs: 0,
        });
        const sessionId = ensured.kind === 'resolved' ? ensured.sessionId : node.agentSessionId;
        if (!sessionId)
          return { reason: 'reason' in ensured ? ensured.reason : 'No worker session.' };
        const messageId = await context.taskAgentManager.injectSubSessionMessage(
          sessionId,
          message,
          !fromHuman
        );
        const sent = context.deps.db.getSDKMessageRepo().getDeliveryContent(sessionId, messageId);
        return {
          delivered: sent?.sendStatus !== 'deferred',
          ...(sent && messageId ? { receipt: { executionId: sessionId, inputId: messageId } } : {}),
        };
      } catch (error) {
        return { reason: error instanceof Error ? error.message : String(error) };
      }
    },
    cancel: async (taskId, caller) => {
      const reason = taskOperationRejection(
        await invoke('task.transition', { taskId, status: 'cancelled' }, caller)
      );
      return reason === null ? { cancelled: true } : { reason };
    },
  };
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
  const adapters = [
    createHyperneoAdapter({
      prepareExecution,
      projects: () => context.deps.db.workspaceHistory.projects(),
      db,
      machine,
      searchChats: ownChats,
      handoff: (sessionId, message, from, messageUuid, deliveryMode) =>
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
          jobQueue: context.deps.jobQueue,
        }),
      sessions: hyperneoSessionControl(context),
      neoFolder,
      folderExists: existsSync,
      makeFolder: (folder: string) => mkdirSync(folder),
      homeDir: homedir(),
    }),
    createSpaceAdapter({
      db,
      machine,
      searchChats: ownChats,
      tasks: spaceTaskControl(context),
    }),
    ...codexDesktopAdapters(
      (statePath, includeClosed) =>
        context.deps.db.readCodexSnapshotAsync(statePath, includeClosed),
      searchChats,
      prepareExecution
    ),
    ...claudeDesktopAdapters(
      searchChats,
      prepareExecution,
      context.claudeInbox,
      context.claudeDesktopMods,
      () => neoWorkerPermissionMode(context.deps.db.getGlobalSettings().neo)
    ),
    ...claudeCodeAdapters(searchChats, () => readHyperneoSdkSessions(db()), context.claudeInbox),
    ...acpAgentAdapters(
      () => new Set(context.deps.db.listAcpSessionIds().map((session) => session.acpSessionId)),
      context
    ),
  ];
  const deps = {
    adapters: () => adapters,
    remote: remoteDaemons,
    daemonName: machine,
    isOpenTodo: (todoId: string, sessionId: string) => {
      const store = new NeoAskTodoRepository(db());
      const todo = store.getTodo(todoId);
      const ask = todo ? store.getAsk(todo.askId) : null;
      return ask?.status === 'open' && ask.sessionId === sessionId;
    },
    recordStarted: (ref: StartedWork) => recordStartedWork(db(), ref),
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
    ...createWorkVerbOperations(deps),
    createNeoSessionArchiveOperation({ ...deps, db: context.deps.db }),
    createReadWorkOperation({ readTurns, remote: remoteDaemons, daemonName: machine }),
  ];
}
