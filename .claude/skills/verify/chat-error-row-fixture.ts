import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DaemonAppContext } from '../../../packages/daemon/src/app.ts';
import { NeoConversationAskRepository } from '../../../packages/daemon/src/storage/repositories/neo-conversation-ask-repository.ts';
import { SDKMessageRepository } from '../../../packages/daemon/src/storage/repositories/sdk-message-repository.ts';
import { SpaceRepository } from '../../../packages/daemon/src/storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../packages/daemon/src/storage/repositories/space-task-repository.ts';
import type { SDKMessage } from '../../../packages/shared/src/sdk/sdk.d.ts';

export async function seedChatErrorCases(app: DaemonAppContext, run: string, worker: string) {
  await app.spaceRuntimeService?.ready();
  await app.jobProcessor.stop();
  const db = app.db.getDatabase();
  const messages = new SDKMessageRepository(db);
  const { root: neo } = JSON.parse(readFileSync(`${run}/evidence/steps-seed.json`, 'utf8'));
  const request = 'Please check whether the deployment is ready.';
  const writeTranscript = (sessionId: string, title: string, taskContext?: object) => {
    db.prepare(
      `INSERT INTO sessions(id,title,workspace_path,type,session_context,created_at,last_active_at,status,config,metadata)
       VALUES (?,?,?,'worker',?,datetime('now'),datetime('now'),'active','{"queryMode":"manual"}','{}')`
    ).run(
      sessionId,
      title,
      run,
      taskContext ? JSON.stringify(taskContext) : null
    );
    for (let index = 0; index < (taskContext ? 1 : 25); index++) {
      const content = index === 24 || taskContext ? request : `Check the earlier deployment item ${index + 1}.`;
      messages.saveUserMessage(
        sessionId,
        {
          type: 'user',
          uuid: crypto.randomUUID(),
          session_id: sessionId,
          parent_tool_use_id: null,
          timestamp: Date.now() + index,
          message: { role: 'user', content },
        } as unknown as SDKMessage,
        'consumed',
        'human'
      );
    }
  };

  const duplicateStartup = crypto.randomUUID();
  const usage = crypto.randomUUID();
  const connection = crypto.randomUUID();
  const taskSession = crypto.randomUUID();
  const space = new SpaceRepository(db).createSpace({
    name: 'Deployment Operations',
    slug: 'deployment-operations',
    workspacePath: run,
  });
  const tasks = new SpaceTaskRepository(db);
  const task = tasks.createTask({
    spaceId: space.id,
    title: 'Check deployment readiness',
    status: 'open',
  });
  writeTranscript(taskSession, 'Deployment task agent', { spaceId: space.id, taskId: task.id });
  tasks.updateTask(task.id, { taskAgentSessionId: taskSession });
  writeTranscript(duplicateStartup, 'Deployment readiness');
  writeTranscript(usage, 'Deployment readiness');
  writeTranscript(connection, 'Deployment readiness');

  const neoRequest = 'Can you check the deployment for me?';
  const requestId = crypto.randomUUID();
  const publicAsk = new NeoConversationAskRepository(db).append({
    conversationId: neo.slice(4),
    requestId,
    askOrigin: { sessionId: neo, messageId: requestId },
    content: neoRequest,
  });
  assert(publicAsk.accepted);

  const raw = 'Full client log for this controlled fixture';
  const cases = [
    {
      name: 'wrong-path',
      sessionId: worker,
      path: `/session/${worker}`,
      request: 'Synthetic request that failed',
      title: 'Codex could not start',
      cause: 'No executable was found at /example/tools/codex-old.',
      userMessage: 'An unexpected error occurred. Please try again.',
      category: 'system',
      code: 'NOT_FOUND',
      message: 'spawn /example/tools/codex-old ENOENT',
      explicitTitle: true,
    },
    {
      name: 'duplicate-startup',
      sessionId: duplicateStartup,
      path: `/session/${duplicateStartup}`,
      request,
      title: 'Could not start Codex CLI',
      cause: 'At "/example/tools/oxap". Usage: oxap [OPTIONS] <COMMAND>.',
      userMessage: 'Could not start Codex CLI at "/example/tools/oxap". Usage: oxap [OPTIONS] <COMMAND>. Check the Codex CLI path in Settings → Providers.',
      category: 'validation',
      code: 'UNKNOWN',
      message: 'Could not start Codex CLI at "/example/tools/oxap". Usage: oxap [OPTIONS] <COMMAND>. Check the Codex CLI path in Settings → Providers.',
    },
    {
      name: 'usage-limit',
      sessionId: usage,
      path: `/session/${usage}`,
      request,
      title: 'Usage limit reached',
      cause: 'Your Codex usage resets at 9 PM.',
      userMessage: 'Usage limit reached. Your Codex usage resets at 9 PM.',
      category: 'rate_limit',
      code: 'QUOTA_EXCEEDED',
      message: 'HTTP 429: usage limit reached',
    },
    {
      name: 'lost-connection',
      sessionId: connection,
      path: `/session/${connection}`,
      request,
      title: 'Lost connection',
      cause: 'Check your network connection, then resend your message.',
      userMessage: 'Lost connection: Check your network connection, then resend your message.',
      category: 'connection',
      code: 'CONNECTION_REFUSED',
      message: 'WebSocket closed before the response arrived',
    },
    {
      name: 'neo',
      sessionId: neo,
      path: '/neo',
      request: neoRequest,
      title: 'Rate limited',
      cause: 'Wait a minute before sending another request.',
      userMessage: 'Rate limited. Wait a minute before sending another request.',
      category: 'rate_limit',
      code: 'RATE_LIMITED',
      message: 'HTTP 429: request rate exceeded',
    },
    {
      name: 'space',
      sessionId: taskSession,
      path: `/space/${space.id}/task/${task.id}`,
      request,
      title: 'Anthropic authentication failed',
      cause: 'Sign in to Anthropic to resume the task.',
      userMessage: 'Anthropic authentication failed. Sign in to Anthropic to resume the task.',
      category: 'provider_auth_error',
      code: 'UNAUTHORIZED',
      message: 'HTTP 401: provider sign-in expired',
    },
  ];
  for (const entry of cases) {
    if (entry.name === 'duplicate-startup') {
      assert(messages.saveSDKMessage(
        entry.sessionId,
        {
          type: 'assistant',
          uuid: crypto.randomUUID(),
          session_id: entry.sessionId,
          parent_tool_use_id: null,
          error: 'invalid_request',
          message: { role: 'assistant', content: [{ type: 'text', text: entry.message }] },
        } as unknown as SDKMessage
      ));
    }
    await app.internalEventBus.publishAsync('session.error', {
      sessionId: entry.sessionId,
      error: entry.userMessage,
      details: {
        category: entry.category,
        code: entry.code,
        ...(entry.explicitTitle ? { title: entry.title } : {}),
        userMessage: entry.userMessage,
        message: `${entry.message}\n${raw}`,
        recoverySuggestions: [entry.cause],
        metadata: entry.name === 'space' ? { providerId: 'anthropic' } : undefined,
        recoverable: true,
        timestamp: new Date().toISOString(),
      },
    });
  }
  return { cases, raw };
}
