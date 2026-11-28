import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { WorkTurnPage } from '../../storage/work-turn-page.ts';
import { ProcessJsonRpcTransport } from '../process-json-rpc.ts';
import { buildSafeProcessEnv } from '../safe-process-env.ts';
import type { WorkAdapter } from './types.ts';

const TEXT_LIMIT = 16_000;
const MAX_PAGE_MESSAGES = 21;
const unavailable: WorkTurnPage = { turns: [], availability: 'reply_unavailable' };
const Init = z.object({
  protocolVersion: z.literal(1),
  agentCapabilities: z.object({ loadSession: z.literal(true) }),
});
const Replay = z.object({
  sessionId: z.string(),
  update: z.object({
    sessionUpdate: z.enum(['user_message_chunk', 'agent_message_chunk']),
    messageId: z.string().optional(),
    content: z.object({ type: z.literal('text'), text: z.string() }),
  }),
});

type ReadTurns = NonNullable<WorkAdapter['readTurns']>;
type Cursor = WorkTurnPage['nextCursor'];
type Message = {
  seq: number;
  role: 'user' | 'assistant';
  sourceId?: string;
  offset: number;
  size: number;
  text: string;
};

function replayWindow(
  prefix: string,
  sessionId: string,
  around: string | undefined,
  before: number,
  after: number,
  cursor: Cursor
) {
  const anchor =
    !cursor && around ? Number(new RegExp(`^${prefix}:(\\d+)$`).exec(around)?.[1]) : undefined;
  if (anchor !== undefined && (!Number.isSafeInteger(anchor) || anchor < 1)) return null;
  const resume = cursor?.resume;
  if (
    cursor &&
    (cursor.sessionId !== sessionId ||
      cursor.copilot ||
      (resume && (resume.seq < cursor.before || resume.through - resume.seq >= MAX_PAGE_MESSAGES)))
  )
    return null;
  const first = resume?.seq ?? (anchor ? Math.max(1, anchor - before) : 1);
  const last = resume?.through ?? (cursor ? cursor.before - 1 : anchor ? anchor + after : Infinity);
  const limit = resume ? MAX_PAGE_MESSAGES : before + after + 1;
  const messages: Message[] = [];
  let seq = 0;
  let current: Message | undefined;

  const flush = () => {
    if (!current || current.seq < first || current.seq > last) return;
    messages.push(current);
    if (messages.length > limit) messages.shift();
  };

  const accept = (params: unknown) => {
    const parsed = Replay.safeParse(params);
    if (!parsed.success || parsed.data.sessionId !== sessionId) return;
    const { sessionUpdate, messageId, content } = parsed.data.update;
    if (!content.text) return;
    const role = sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant';
    if (
      !current ||
      current.role !== role ||
      (messageId ? current.sourceId !== messageId : role === 'user')
    ) {
      flush();
      seq += 1;
      current = {
        seq,
        role,
        sourceId: messageId,
        offset: resume?.seq === seq ? resume.offset : 0,
        size: 0,
        text: '',
      };
    }
    const start = Math.max(0, current.offset - current.size);
    if (start < content.text.length && current.text.length < TEXT_LIMIT)
      current.text += content.text.slice(start, start + TEXT_LIMIT - current.text.length);
    current.size += content.text.length;
  };

  const page = (): WorkTurnPage => {
    flush();
    if (
      (anchor && anchor > seq) ||
      (resume && (resume.through > seq || resume.through < resume.seq))
    )
      return unavailable;
    if (!messages.length) return cursor ? { turns: [], availability: 'complete' } : unavailable;
    const boundary = resume ? cursor!.before : messages[0].seq;
    const through = messages.at(-1)!.seq;
    const turns: WorkTurnPage['turns'] = [];
    let remaining = TEXT_LIMIT;
    for (const message of messages) {
      if (message.offset > message.size) return unavailable;
      let text = message.text.slice(0, remaining);
      if (message.offset + text.length < message.size) text = text.replace(/[\uD800-\uDBFF]$/, '');
      const offset = message.offset + text.length;
      const textComplete = offset === message.size;
      if (text) {
        turns.push({
          messageId: `${prefix}:${message.seq}`,
          role: message.role,
          at: 0,
          text,
          textOffset: message.offset,
          textComplete,
        });
      }
      if (!textComplete) {
        return {
          turns,
          availability: 'incomplete',
          nextCursor: {
            sessionId,
            before: boundary,
            resume: { seq: message.seq, offset, through },
          },
        };
      }
      remaining -= text.length;
    }
    return boundary > 1
      ? { turns, availability: 'incomplete', nextCursor: { sessionId, before: boundary } }
      : { turns, availability: 'complete' };
  };
  return { accept, page };
}

export function createAcpReplayHistory(
  executable: string,
  args: readonly string[],
  prefix: string,
  readOwnedFolder: (id: string) => Promise<string | undefined>
): ReadTurns {
  return async (sessionId, around, before, after, cursor) => {
    const cwd = await readOwnedFolder(sessionId);
    if (!cwd || !isAbsolute(cwd)) return null;
    const window = replayWindow(prefix, sessionId, around, before, after, cursor);
    if (!window) return unavailable;
    let loading = false;
    const transport = new ProcessJsonRpcTransport({
      command: executable,
      args: [...args],
      cwd,
      env: buildSafeProcessEnv(),
      replaceEnv: true,
      requestTimeoutMs: 8_000,
      onStderr: () => {},
      onNotification: ({ method, params }) => {
        if (loading && method === 'session/update') window.accept(params);
      },
    });
    try {
      const init = await transport.sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      if (!('result' in init) || !Init.safeParse(init.result).success) return unavailable;
      loading = true;
      const loaded = await transport.sendRequest(
        'session/load',
        { sessionId, cwd, mcpServers: [] },
        {
          onResponseFrame: () => {
            loading = false;
          },
        }
      );
      return 'result' in loaded ? window.page() : unavailable;
    } catch {
      return unavailable;
    } finally {
      await transport.close();
    }
  };
}

export const createAntigravityHistory = (
  executable: string,
  readOwnedFolder: (id: string) => Promise<string | undefined>
): ReadTurns =>
  createAcpReplayHistory(
    executable,
    ['acp', '--sandbox', '--disable-telemetry'],
    'agy',
    readOwnedFolder
  );
