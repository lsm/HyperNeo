import { ensureCodexDesktopProject } from '../../../packages/daemon/src/lib/drivers/codex-desktop-project.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connectCodexAppServer } from '../../../packages/daemon/src/lib/drivers/codex-app-server.ts';
import {
  createCodexDesktopAdapter,
  readCodexThread,
} from '../../../packages/daemon/src/lib/drivers/codex-desktop-adapter.ts';
import { startCodexDesktopTurn } from '../../../packages/daemon/src/lib/drivers/codex-desktop-handoff.ts';
import { withCodexDesktopIpc } from '../../../packages/daemon/src/lib/drivers/codex-desktop-ipc.ts';
import { createWorkVerbOperations } from '../../../packages/daemon/src/lib/drivers/work-operations.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { spawnProcess } from '../../../packages/daemon/src/lib/runtime-spawn/index.ts';

const [, , action, run] = process.argv;
if (!run || process.env.NODE_ENV !== 'test')
  throw new Error(
    'NODE_ENV=test bun codex-send.ts prepare|start|send|fallback|observe|stop <fresh-run-dir>'
  );
const home = join(homedir(), '.codex');
const socket = join(home, 'ipc/ipc.sock');
const statePath = join(home, 'state_5.sqlite');
const record = join(run, 'codex-send.json');
const appServer = () =>
  connectCodexAppServer(join(home, 'app-server-control/app-server-control.sock'));
if (action === 'prepare') {
  mkdirSync(join(run, 'workspace'), { recursive: true });
  const server = await appServer();
  let threadId: string;
  try {
    const result = (await server.call('thread/start', {
      cwd: join(run, 'workspace'),
      approvalPolicy: 'never',
      sandbox: 'read-only',
    })) as { thread: { id: string } };
    threadId = result.thread.id;
    await server.call('thread/name/set', { threadId, name: 'HyperNeo work.send verification' });
    await server.call('thread/archive', { threadId });
    await server.call('thread/unarchive', { threadId });
  } finally {
    await server.close();
  }
  writeFileSync(
    record,
    JSON.stringify({ threadId, marker: `STEER_VERIFIED_${crypto.randomUUID()}` })
  );
  await startCodexDesktopTurn(socket, spawnProcess, threadId, {
    threadId,
    input: [
      {
        type: 'text',
        text_elements: [],
        text: 'Isolated driver verification. Do not read files, credentials, or run tests. Run sleep 45 with your shell tool, then reply ORIGINAL_ONLY. If a follow-up requests a token, replace the final reply with that token. Do nothing else.',
      },
    ],
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'readOnly' },
  });
  console.log(JSON.stringify({ threadId, link: `codex://threads/${threadId}` }));
} else {
  const { threadId, marker } = JSON.parse(readFileSync(record, 'utf8')) as {
    threadId: string;
    marker: string;
  };
  if (action === 'start') {
    const response = await withCodexDesktopIpc(socket, async ({ call }) => {
      const owner = await call(
        'thread-owner-discovery',
        { hostId: 'local', conversationId: threadId },
        1
      );
      if (!owner.handledByClientId) throw new Error('Verification thread has no Desktop owner');
      return call(
        'thread-follower-start-turn',
        {
          conversationId: threadId,
          turnStart: {
            request: {
              threadId,
              approvalPolicy: 'never',
              sandboxPolicy: { type: 'readOnly' },
              input: [
                {
                  type: 'text',
        text_elements: [],
                  text: 'Do not read files or credentials. Run sleep 45, then reply ORIGINAL_ONLY unless a follow-up requests a different token. Do nothing else.',
                },
              ],
            },
            context: { inheritThreadSettings: false },
          },
        },
        2,
        owner.handledByClientId
      );
    });
    writeFileSync(join(run, 'start-result.json'), JSON.stringify(response, null, 2));
    console.log(JSON.stringify(response));
    if (response.resultType !== 'success')
      throw new Error(response.error ?? 'Desktop did not start the verification turn');
  } else if (action === 'send' || action === 'fallback') {
    const deps = {
      statePath,
      desktopSocketPath: socket,
      worktreesDir: join(home, 'worktrees'),
      machine: 'verify',
      now: Date.now,
      spawn: spawnProcess,
      appServer,
      bootstrapServer: appServer,
      prepareDesktopProject: (folder) => ensureCodexDesktopProject(folder, home, spawnProcess),
      startDesktopTurn: (id: string, request: Record<string, unknown>) =>
        startCodexDesktopTurn(socket, spawnProcess, id, request),
      folderExists: () => true,
      makeFolder: () => {},
      homeDir: homedir(),
      gitCheckout: async () => null,
      newId: () => crypto.randomUUID(),
    };
    const registry = createOperationRegistry(
      createWorkVerbOperations({
        adapters: () => [createCodexDesktopAdapter(deps)],
        isOpenTodo: (id, sessionId) => id === 'verify-codex-send-todo' && sessionId === 'verify-codex-send',
        daemonName: 'verify',
        remote: {
          list: () => [],
          invoke: async () => {
            throw new Error('No remote daemon');
          },
        },
      })
    );
    const outcome = await invokeOperation(
      registry,
      'work.send',
      {
        ref: { adapter: 'codex-desktop', id: threadId },
        message: `Reply with exactly ${marker}`,
        todoId: 'verify-codex-send-todo',
      },
      { source: 'mcp', role: 'neo', sessionId: 'verify-codex-send' }
    );
    writeFileSync(join(run, `${action}-result.json`), JSON.stringify(outcome, null, 2));
    console.log(JSON.stringify(outcome));
    const value =
      outcome.kind === 'completed'
        ? (outcome.value as {
            ok: boolean;
            value?: { steeredIntoTurnId?: string; startedTurnId?: string; queuedSubmissionId?: string };
          })
        : null;
    if (action === 'send' && (!value?.ok || !value.value?.steeredIntoTurnId))
      throw new Error('REPRO: work.send did not steer the running Desktop turn');
    if (
      action === 'fallback' &&
      (!value?.ok || !value.value?.startedTurnId || value.value.queuedSubmissionId)
    )
      throw new Error('Not verified: idle Desktop did not confirm a new turn');
  } else if (action === 'observe') {
    const detail = readCodexThread(statePath, threadId);
    if (!detail) throw new Error('Verification thread not found');
    const entries = readFileSync(detail.thread.rolloutPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const evidence = entries.filter(
      (entry) =>
        entry.type === 'event_msg' &&
        ['task_started', 'task_complete', 'turn_aborted', 'user_message', 'agent_message'].includes(
          entry.payload?.type
        )
    );
    writeFileSync(join(run, 'rollout-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
    const sent = JSON.parse(readFileSync(join(run, 'send-result.json'), 'utf8'));
    const turnId = sent.value?.value?.steeredIntoTurnId;
    if (turnId) {
      const completed = evidence.find(
        (entry) => entry.payload.type === 'task_complete' && entry.payload.turn_id === turnId
      );
      if (completed?.payload.last_agent_message !== marker)
        throw new Error('Not verified: the steered turn has not replied with the requested token');
      const acceptance = {
        threadId,
        turnId,
        steered: true,
        queued: !!sent.value.value.queuedSubmissionId,
        reply: completed.payload.last_agent_message,
      };
      writeFileSync(join(run, 'acceptance.json'), JSON.stringify(acceptance, null, 2));
      console.log(JSON.stringify(acceptance));
    }
  } else if (action === 'stop') {
    console.log(
      JSON.stringify(
        await withCodexDesktopIpc(socket, async ({ call }) => {
          const owner = await call(
            'thread-owner-discovery',
            { hostId: 'local', conversationId: threadId },
            1
          );
          if (!owner.handledByClientId) throw new Error('Verification thread has no Desktop owner');
          return call(
            'thread-follower-interrupt-turn',
            { conversationId: threadId, mode: 'user-stop' },
            4,
            owner.handledByClientId
          );
        })
      )
    );
  } else throw new Error(`Unknown action: ${action}`);
}
