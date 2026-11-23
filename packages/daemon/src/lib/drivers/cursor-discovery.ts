import { spawn } from 'node:child_process';
import { basename, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { buildSafeProcessEnv } from '../safe-process-env.ts';
import { skipSpaceQuery } from './hyperneo-adapter.ts';
import type { FindQuery, PlaceGroup, WorkAdapter, WorkSummary } from './types.ts';

const ADAPTER = 'cursor-cli';
const InitializeResult = z.object({
  protocolVersion: z.literal(1),
  agentCapabilities: z.object({
    sessionCapabilities: z.object({ list: z.object({}) }),
  }),
});
const SessionList = z.object({
  sessions: z.array(
    z.object({
      sessionId: z.string().min(1),
      cwd: z.string().refine(isAbsolute),
      title: z.string().nullish(),
      updatedAt: z.string().nullish(),
    })
  ),
});
const Frame = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
type Session = z.infer<typeof SessionList>['sessions'][number];

async function listSessions(command: string, home: string, folder: string | undefined) {
  const signal = AbortSignal.timeout(10_000);
  const child = spawn(command, ['acp'], {
    cwd: home,
    env: buildSafeProcessEnv(),
    stdio: ['pipe', 'pipe', 'ignore'],
    signal,
    killSignal: 'SIGKILL',
    windowsHide: true,
  });
  const stopped = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.on('error', (error) => child.stdout.destroy(error));
  child.stdin.on('error', (error) => child.stdout.destroy(error));
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lines = reader[Symbol.asyncIterator]();

  async function request(id: number, method: string, params: object): Promise<unknown> {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    for (;;) {
      const line = await lines.next();
      if (line.done) throw new Error('Cursor CLI closed before replying.');
      const frame = Frame.safeParse(JSON.parse(line.value));
      if (!frame.success || frame.data.id !== id) continue;
      if (frame.data.error?.message === 'Authentication required')
        throw new Error('Cursor CLI authentication required. Run cursor-agent login.');
      if (frame.data.error) throw new Error(`Cursor CLI rejected ${method}.`);
      return frame.data.result;
    }
  }

  try {
    const init = await request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
    if (!InitializeResult.safeParse(init).success)
      throw new Error('Cursor CLI does not support ACP session listing.');
    const result = SessionList.safeParse(
      await request(2, 'session/list', folder ? { cwd: folder } : {})
    );
    if (!result.success) throw new Error('Cursor CLI returned invalid session metadata.');
    return result.data.sessions;
  } catch (error) {
    if (signal.aborted) throw new Error('Cursor CLI session discovery timed out.');
    if (error instanceof SyntaxError) throw new Error('Cursor CLI returned invalid ACP JSON.');
    throw error;
  } finally {
    reader.close();
    child.stdin.destroy();
    child.kill('SIGKILL');
    await stopped;
  }
}

function groupSessions(
  sessions: readonly Session[],
  query: FindQuery,
  machine: string
): PlaceGroup[] {
  const text = query.text?.toLowerCase();
  const groups = new Map<string, PlaceGroup>();
  for (const session of sessions) {
    const folder = session.cwd;
    if (query.folder && query.folder !== folder) continue;
    if (query.idPrefix && !session.sessionId.startsWith(query.idPrefix)) continue;
    const name = basename(folder) || folder;
    const title = session.title?.trim() || 'Untitled Cursor session';
    if (text && !`${title} ${folder}`.toLowerCase().includes(text)) continue;
    const place = { machine, folder, name };
    const lastActivityAt = Date.parse(session.updatedAt ?? '') || 0;
    const work: WorkSummary = {
      ref: { adapter: ADAPTER, id: session.sessionId },
      place,
      title,
      lastActivityAt,
      status: 'done',
    };
    const group = groups.get(folder);
    if (group) {
      group.work.push(work);
      group.openCount++;
      group.lastActivityAt = Math.max(group.lastActivityAt, lastActivityAt);
    } else {
      groups.set(folder, {
        place,
        work: [work],
        adapters: [ADAPTER],
        lastActivityAt,
        openCount: 1,
        archivedCount: 0,
      });
    }
  }
  return [...groups.values()];
}

const find = (superpipe({})('cursor-discovery-find') as PipelineAPI)
  .input(['query', 'command', 'home', 'machine'])
  .pipe(skipSpaceQuery, 'query', 'result:groups')
  .pipe(
    (command: string, home: string, query: FindQuery) => listSessions(command, home, query.folder),
    ['command', 'home', 'query'],
    'sessions'
  )
  .pipe(groupSessions, ['sessions', 'query', 'machine'], 'groups')
  .endAsync('groups') as (
  query: FindQuery,
  command: string,
  home: string,
  machine: string
) => Promise<PlaceGroup[]>;

export function createCursorDiscovery(command: string, home: string, machine: string): WorkAdapter {
  return {
    id: ADAPTER,
    capabilities: ['find'],
    find: (query) => find(query, command, home, machine),
  };
}
