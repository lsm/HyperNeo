import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { ProcessJsonRpcTransport } from '../process-json-rpc.ts';
import { buildSafeProcessEnv } from '../safe-process-env.ts';
import { selectLocalStartFolder } from './start-folder.ts';
import type { StartRequest, WorkAdapter, WorkDetail } from './types.ts';
import { reject } from './work-operations.ts';

const START_TIMEOUT_MS = 15_000;
const RETAINED_TURNS = 100;
const MAX_REPLY_CHARS = 16_000;
const Session = z.object({ sessionId: z.string().min(1) });
const Update = Session.extend({
  update: z.object({
    sessionUpdate: z.literal('agent_message_chunk'),
    content: z.object({ type: z.literal('text'), text: z.string() }),
  }),
});
const Completion = z.object({ stopReason: z.string() });

async function openSession(transport: ProcessJsonRpcTransport, cwd: string) {
  const initialized = await transport.sendRequest('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  if (
    !('result' in initialized) ||
    !z.object({ protocolVersion: z.literal(1) }).safeParse(initialized.result).success
  ) {
    return reject(
      'unreachable',
      'Antigravity did not initialize an ACP version 1 connection.',
      true
    );
  }
  const opened = await transport.sendRequest('session/new', { cwd, mcpServers: [] });
  if ('error' in opened) {
    return reject(
      'unreachable',
      opened.error.code === -32000
        ? 'Sign in to Antigravity CLI before starting a session.'
        : `Antigravity rejected session creation (${opened.error.code}).`,
      true
    );
  }
  const session = Session.safeParse(opened.result);
  return session.success
    ? { ok: true as const, value: session.data.sessionId }
    : reject('not_delivered', 'Antigravity did not confirm the new session.', true);
}

export function createAntigravityStart(executable: string, machine: string, adapter: string) {
  const running = new Set<ProcessJsonRpcTransport>();
  const sessions = new Map<string, WorkDetail>();
  const completed = new Set<string>();
  let closing = false;

  const start: NonNullable<WorkAdapter['start']> = async (request: StartRequest) => {
    if (closing) return reject('unreachable', 'The Antigravity driver is shutting down.', true);
    if (request.model !== undefined || request.effort !== undefined) {
      return reject(
        request.model !== undefined ? 'unsupported_model' : 'unsupported_effort',
        'Choose the default Antigravity CLI configuration for this session.',
        true
      );
    }
    const selected = selectLocalStartFolder(
      request,
      {
        machine,
        homeDir: homedir(),
        folderExists: existsSync,
        makeFolder: mkdirSync,
      },
      'Antigravity needs a local workspace.'
    );
    if ('reason' in selected) return { ...selected.reason, notSent: true };
    const cwd = selected.value;
    if (!isAbsolute(cwd) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory())
      return reject('invalid_place', 'Antigravity needs an absolute workspace directory.', true);

    let sessionId: string | undefined;
    let reply = '';
    const transport = new ProcessJsonRpcTransport({
      command: executable,
      args: ['acp', '--sandbox', '--disable-telemetry'],
      cwd,
      env: buildSafeProcessEnv(),
      replaceEnv: true,
      onStderr: () => {},
      onRequest: ({ id, method }) => {
        if (method === 'session/request_permission')
          transport.sendResponse(id, { outcome: { outcome: 'cancelled' } });
        else transport.sendErrorResponse(id, { code: -32601, message: 'Method not supported' });
      },
      onNotification: ({ method, params }) => {
        if (method !== 'session/update') return;
        const update = Update.safeParse(params);
        if (update.success && update.data.sessionId === sessionId)
          reply += update.data.update.content.text.slice(0, MAX_REPLY_CHARS - reply.length);
      },
    });
    running.add(transport);
    const close = async () => {
      await transport.close();
      running.delete(transport);
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    let opened: Awaited<ReturnType<typeof openSession>>;
    try {
      opened = await Promise.race([
        openSession(transport, cwd),
        new Promise<never>((_, refuse) => {
          timer = setTimeout(
            () => refuse(new Error('Antigravity session creation timed out.')),
            START_TIMEOUT_MS
          );
        }),
      ]);
    } catch (error) {
      opened = reject(
        'unreachable',
        error instanceof Error ? error.message : 'Antigravity could not start.',
        true
      );
    } finally {
      clearTimeout(timer);
    }
    if (!opened.ok) {
      await close();
      return opened;
    }
    if (closing || sessions.has(opened.value)) {
      await close();
      return reject('not_delivered', 'Antigravity could not establish a new owned session.', true);
    }
    const id = opened.value;
    sessionId = id;
    const work: WorkDetail = {
      ref: { adapter, id },
      title: request.sessionTitle ?? request.title,
      place: { ...request.place, folder: cwd },
      execution: { machine, directory: cwd },
      status: 'running',
      lastActivityAt: Date.now(),
      watchHint: 'Open this session in Antigravity CLI. HyperNeo shows the most recent owned turn.',
    };
    sessions.set(id, work);
    const finish = (status: WorkDetail['status'], detail: string) => {
      const at = Date.now();
      sessions.set(id, {
        ...work,
        status,
        lastActivityAt: at,
        ...(reply ? { lastReply: reply, lastReplyAt: at } : {}),
        turnEnds: [{ id, at, startedAt: work.lastActivityAt, message: detail }],
      });
      completed.add(id);
      if (completed.size > RETAINED_TURNS) {
        const oldest = completed.values().next().value!;
        completed.delete(oldest);
        sessions.delete(oldest);
      }
    };
    void transport
      .sendRequest('session/prompt', {
        sessionId: id,
        prompt: [{ type: 'text', text: request.message }],
      })
      .then(
        (response) => {
          const result = Completion.safeParse('result' in response ? response.result : undefined);
          if (result.success && result.data.stopReason === 'end_turn') finish('done', reply);
          else if (result.success && result.data.stopReason === 'cancelled')
            finish('stopped', reply);
          else
            finish(
              'failed',
              'Antigravity did not complete the turn. Check the CLI session before retrying.'
            );
        },
        () =>
          finish(
            'failed',
            'Antigravity disconnected during the turn. Check the CLI session before retrying.'
          )
      )
      .finally(close);
    return { ok: true, value: work };
  };

  const status: NonNullable<WorkAdapter['status']> = async (ref) => {
    const work = sessions.get(ref.id);
    return work && ref.adapter === adapter
      ? { ok: true, value: work }
      : reject('not_found', 'This daemon has no retained Antigravity turn for that session.', true);
  };

  return {
    start,
    status,
    async close() {
      closing = true;
      await Promise.all([...running].map((transport) => transport.close()));
    },
  };
}
