import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import type { WorkChatKind, WorkChatMatch } from '../../../storage/work-chat-search.ts';
import {
  createClaudeDesktopAdapter,
  readClaudeDesktopRecords,
  readLiveClaudeSessions,
  type ClaudeRecordCache,
} from '../../drivers/claude-desktop-adapter.ts';
import { createClaudeCodeAdapter } from '../../drivers/claude-code-adapter.ts';
import { connectCodexAppServer } from '../../drivers/codex-app-server.ts';
import { createCodexDesktopAdapter } from '../../drivers/codex-desktop-adapter.ts';
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
import type { WorkAdapter } from '../../drivers/types.ts';
import { createWorkVerbOperations } from '../../drivers/work-operations.ts';
import { renderAddress } from '../../mailbox/address.ts';
import { handoffPromptToMailbox } from '../../mailbox/handoff.ts';
import { invokeOperation } from '../../operations/invoke.ts';
import type { OperationCaller, OperationDefinition } from '../../operations/registry.ts';
import { neoFolder } from '../../neo/folder.ts';
import { remoteDaemons } from '../../remote-daemons/registry.ts';
import { spawnProcess } from '../../runtime-spawn/index.ts';
import { readWorkTurns } from '../../../storage/work-turns.ts';
import type { FamilyOperationContext } from './context.ts';

const WORK_CHAT_LIMIT = 200;
const SEARCH_REUSE_MS = 2_000;

function hyperneoSessionControl(context: FamilyOperationContext): HyperneoSessionControl {
  const { sessionManager, internalEventBus } = context.deps;
  return {
    create: (workspacePath, title) => sessionManager.createSession({ workspacePath, title }),
    chooseWorktree: async (sessionId) => {
      await sessionManager.getSessionLifecycle().completeWorktreeChoice(sessionId, 'worktree');
    },
    announce: (sessionId) => {
      const session = sessionManager.getSessionFromDB(sessionId);
      if (session)
        internalEventBus.publish('session.created', { sessionId, session }).catch(() => {});
    },
    interrupt: (sessionId) => {
      if (!sessionManager.getCachedSession(sessionId)) return false;
      internalEventBus.publish('agent.interruptRequest', { sessionId }).catch(() => {});
      return true;
    },
  };
}

const CLAUDE_DESKTOP_SESSIONS = join(
  homedir(),
  'Library',
  'Application Support',
  'Claude',
  'claude-code-sessions'
);

function claudeCodeAdapters(
  searchChats: (text: string, kinds: readonly WorkChatKind[]) => Promise<readonly WorkChatMatch[]>
): WorkAdapter[] {
  if (!existsSync(join(homedir(), '.claude', 'projects'))) return [];
  const cache: ClaudeRecordCache = new Map();
  return [
    createClaudeCodeAdapter({
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
  searchChats: (text: string, kinds: readonly WorkChatKind[]) => Promise<readonly WorkChatMatch[]>
): WorkAdapter[] {
  const sessionsDir = CLAUDE_DESKTOP_SESSIONS;
  if (!existsSync(sessionsDir)) return [];
  return [
    createClaudeDesktopAdapter({
      sessionsDir,
      projectsDir: join(homedir(), '.claude', 'projects'),
      machine: hostname(),
      liveSessions: () => readLiveClaudeSessions(spawnProcess),
      spawn: spawnProcess,
      folderExists: existsSync,
      newId: () => crypto.randomUUID(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
      searchChats: (text) => searchChats(text, ['claude']),
    }),
  ];
}

function codexDesktopAdapters(
  searchChats: (text: string, kinds: readonly WorkChatKind[]) => Promise<readonly WorkChatMatch[]>
): WorkAdapter[] {
  const codexHome = join(homedir(), '.codex');
  const statePath = join(codexHome, 'state_5.sqlite');
  if (!existsSync(statePath)) return [];
  return [
    createCodexDesktopAdapter({
      statePath,
      worktreesDir: join(codexHome, 'worktrees'),
      machine: hostname(),
      now: Date.now,
      spawn: spawnProcess,
      appServer: () =>
        connectCodexAppServer(join(codexHome, 'app-server-control', 'app-server-control.sock')),
      folderExists: existsSync,
      searchChats: (text) => searchChats(text, ['codex']),
    }),
  ];
}

function spaceTaskControl(context: FamilyOperationContext): SpaceTaskControl {
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
        return { delivered: sent?.sendStatus !== 'deferred' };
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
    try {
      const vector = Float32Array.from(await embedder.embedQuery(text));
      return { vector, model: embedder.model };
    } catch {
      return undefined;
    }
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
  ): Promise<readonly WorkChatMatch[]> =>
    recent<{ chats: Promise<readonly WorkChatMatch[]> }>(
      recentSearches,
      `${kinds.join(',')}:${text}`,
      () => ({
        chats: recent(recentVectors, text, () => ({ semantic: embedQuery(text) })).semantic.then(
          (vectors) =>
            context.deps.db
              .getSDKMessageRepo()
              .searchWorkChats(text, WORK_CHAT_LIMIT, vectors, kinds)
        ),
      })
    ).chats;
  const ownChats = (text: string) => searchChats(text, ['message', 'task']);
  const adapters = [
    createHyperneoAdapter({
      db,
      machine,
      searchChats: ownChats,
      handoff: (sessionId, message, from) =>
        handoffPromptToMailbox({
          to: renderAddress({ kind: 'session', sessionId }),
          message: {
            type: 'user',
            message: { role: 'user', content: message },
            parent_tool_use_id: null,
          },
          origin: from,
          jobQueue: context.deps.jobQueue,
        }),
      sessions: hyperneoSessionControl(context),
      neoFolder,
      folderExists: existsSync,
    }),
    createSpaceAdapter({
      db,
      machine,
      searchChats: ownChats,
      tasks: spaceTaskControl(context),
    }),
    ...codexDesktopAdapters(searchChats),
    ...claudeDesktopAdapters(searchChats),
    ...claudeCodeAdapters(searchChats),
  ];
  const deps = { adapters: () => adapters, remote: remoteDaemons, daemonName: machine };
  const readTurns = (
    sessionId: string,
    around: string | undefined,
    before: number,
    after: number
  ) => readWorkTurns(db(), sessionId, around, before, after);
  return [
    createFindWorkOperation(deps),
    ...createWorkVerbOperations(deps),
    createReadWorkOperation({ readTurns, remote: remoteDaemons, daemonName: machine }),
  ];
}
