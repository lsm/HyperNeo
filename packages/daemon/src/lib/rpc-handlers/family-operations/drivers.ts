import { existsSync, mkdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { getDataDir } from '../../data-dir.ts';
import {
  createClaudeDesktopAdapter,
  readLiveClaudeSessions,
} from '../../drivers/claude-desktop-adapter.ts';
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
import { remoteDaemons } from '../../remote-daemons/registry.ts';
import { spawnProcess } from '../../runtime-spawn/index.ts';
import { readWorkTurns } from '../../../storage/work-turns.ts';
import type { FamilyOperationContext } from './context.ts';

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

function neoFolder(): string {
  const folder = join(getDataDir(), 'Neo');
  mkdirSync(folder, { recursive: true });
  return folder;
}

function claudeDesktopAdapters(): WorkAdapter[] {
  const sessionsDir = join(
    homedir(),
    'Library',
    'Application Support',
    'Claude',
    'claude-code-sessions'
  );
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
    }),
  ];
}

function codexDesktopAdapters(): WorkAdapter[] {
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
  const search = (text: string) =>
    context.deps.db.getSDKMessageRepo().searchMessages({ query: text, limit: 50 }).results;
  const adapters = [
    createHyperneoAdapter({
      db,
      machine,
      searchSessionIds: (text) =>
        new Set(search(text).flatMap((result) => (result.sessionId ? [result.sessionId] : []))),
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
      searchWorkIds: (text) =>
        new Set(
          search(text).flatMap((result) =>
            [result.taskId, result.sessionId].filter((id): id is string => Boolean(id))
          )
        ),
      tasks: spaceTaskControl(context),
    }),
    ...codexDesktopAdapters(),
    ...claudeDesktopAdapters(),
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
