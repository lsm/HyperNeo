#!/usr/bin/env bun
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let buffer = Buffer.alloc(0);
let sessionId = '';
let input = 0;
let eventId = 0;
let pendingAck: (() => void) | undefined;
const serial: { id: string; interaction: string; prompt: string }[] = [];
const queued: { id: string; messageId: string }[] = [];
const fixtureState = () => join(process.cwd(), `${sessionId}.fixture.json`);
const send = (message: unknown) => {
  const data = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(data)}\r\n\r\n${data}`);
};
const event = (type: string, data: unknown, id = `event-${++eventId}`, agentId?: string) => {
  const history = join(process.env.COPILOT_HOME!, 'session-state', sessionId);
  mkdirSync(history, { recursive: true });
  appendFileSync(
    join(history, 'events.jsonl'),
    JSON.stringify({
      id,
      type,
      data,
      timestamp: new Date().toISOString(),
      ...(agentId ? { agentId } : {}),
    }) + '\n'
  );
  send({
    jsonrpc: '2.0',
    method: 'session.event',
    params: {
      sessionId,
      event: {
        id,
        type,
        data,
        timestamp: new Date().toISOString(),
        parentId: null,
        ...(agentId ? { agentId } : {}),
      },
    },
  });
};
function receive(msg: { id?: number; method: string; params?: Record<string, unknown> }) {
  appendFileSync(
    join(process.cwd(), 'calls.jsonl'),
    `${JSON.stringify({ ...msg, pid: process.pid, secretPresent: !!process.env.ANTHROPIC_API_KEY, worktrees: process.env.HYPERNEO_WORKTREES })}\n`
  );
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'connect':
      reply({ protocolVersion: process.argv.includes('--bad-protocol') ? 99 : 3 });
      break;
    case 'status.get':
      reply({
        version: process.argv.includes('--wrong-version')
          ? 'unsupported-fixture'
          : process.argv.includes('--production-version')
            ? '1.0.83'
            : 'fixture-1',
        protocolVersion: 3,
      });
      break;
    case 'auth.getStatus':
      reply({ isAuthenticated: !process.argv.includes('--logged-out') });
      break;
    case 'models.list':
      reply({
        models: process.argv.includes('--no-models')
          ? []
          : [
              {
                id: 'synthetic-model',
                name: 'Synthetic',
                capabilities: {
                  supports: { vision: false, reasoningEffort: false },
                  limits: { max_context_window_tokens: 10000 },
                },
              },
            ],
      });
      break;
    case 'session.create':
      sessionId = String(msg.params?.sessionId);
      if (process.argv.includes('--durable-inputs')) writeFileSync(fixtureState(), '0');
      reply({ sessionId });
      break;
    case 'session.resume':
      sessionId = String(msg.params?.sessionId);
      if (process.argv.includes('--resume-error') || !existsSync(fixtureState())) {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32000,
            message: process.argv.includes('--resume-error')
              ? 'Synthetic resume rejection'
              : 'Missing fixture session',
          },
        });
        break;
      }
      input = Number(readFileSync(fixtureState(), 'utf8'));
      reply({ sessionId });
      break;
    case 'session.send': {
      const prompt = msg.params?.prompt;
      const id = prompt === 'hostile' ? '__proto__' : `input-${++input}`;
      if (process.argv.includes('--durable-inputs')) writeFileSync(fixtureState(), String(input));
      if (String(prompt).startsWith('serial:')) {
        serial.push({ id, interaction: `interaction-${input}`, prompt: String(prompt) });
        if (serial.length === 1) {
          event('user.message', {
            messageId: id,
            interactionId: serial[0].interaction,
            content: prompt,
            delivery: 'idle',
          });
          const timer = setInterval(() => {
            if (!existsSync(join(process.cwd(), 'release-serial'))) return;
            clearInterval(timer);
            for (const [index, queued] of serial.splice(0).entries()) {
              if (index)
                event('user.message', {
                  messageId: queued.id,
                  interactionId: queued.interaction,
                  content: queued.prompt,
                  delivery: 'queued',
                });
              event('assistant.message', {
                messageId: `reply-${queued.id}`,
                interactionId: queued.interaction,
                content:
                  queued.prompt === 'serial:long'
                    ? 'LONG_REPLY'.repeat(3000)
                    : `REPLY_${queued.prompt}`,
                phase: 'final_answer',
              });
            }
            event('session.idle', {});
          }, 5);
        }
        reply({ messageId: id });
        break;
      }
      if (prompt === 'queued') queued.push({ id: `queue-item-${input}`, messageId: id });
      if (prompt === 'crash') {
        reply({ messageId: id });
        setTimeout(() => process.exit(1), 5);
        break;
      }
      if (
        prompt !== 'queued' &&
        prompt !== 'permission-queued' &&
        prompt !== 'error-queued' &&
        prompt !== 'abort-queued'
      )
        event('user.message', {
          content: prompt,
          messageId: id,
          interactionId: `interaction-${input}`,
          delivery: 'idle',
        });
      if (prompt === 'history') {
        event('tool.execution_start', {
          toolCallId: 'tool-1',
          toolName: 'synthetic',
          arguments: { path: 'fixture.txt' },
        });
        event('tool.execution_complete', {
          toolCallId: 'tool-1',
          success: true,
          result: { content: 'SYNTHETIC_TOOL_RESULT' },
        });
        const data = {
          messageId: `reply-${input}`,
          interactionId: `interaction-${input}`,
          content: 'HISTORY_REPLY',
          phase: 'final_answer',
        };
        event('assistant.message', data);
        event('assistant.message', data);
        event('unknown.fixture', { content: 'NOT_VISIBLE' });
        event('session.idle', {});
      }
      if (prompt === 'hold') {
        event('assistant.message_delta', { messageId: 'partial', deltaContent: 'UNRELATED_DELTA' });
        event('assistant.message', {
          messageId: 'foreign',
          content: 'UNRELATED',
          interactionId: 'other',
        });
        event('assistant.turn_end', { turnId: '0' });
        event('assistant.idle', {});
      }
      if (prompt === 'finish') {
        const data = {
          messageId: 'reply-1',
          content: 'FIRST_REPLY',
          interactionId: 'interaction-1',
          phase: 'final_answer',
        };
        event('assistant.message', data, 'duplicate-reply');
        event('assistant.message', data, 'duplicate-reply-new-event-id');
        event('assistant.message', {
          messageId: 'reply-2',
          content: 'SECOND_REPLY',
          interactionId: `interaction-${input}`,
          phase: 'final_answer',
        });
        event('session.idle', {});
      }
      if (prompt === 'late')
        event('assistant.message', {
          messageId: 'late-reply',
          content: 'UNRELATED_AFTER_SETTLED',
          interactionId: 'interaction-1',
          phase: 'final_answer',
        });
      if (
        prompt === 'permission' ||
        prompt === 'permission-queued' ||
        prompt === 'permission-agent'
      ) {
        event(
          'permission.requested',
          {
            requestId: 'permission-1',
            permissionRequest: { kind: 'read', path: '/outside' },
          },
          undefined,
          prompt === 'permission-agent' ? 'child' : undefined
        );
        event('session.idle', {});
      }
      if (prompt === 'settled' || prompt === 'late-ack' || prompt === 'ping-ack') {
        event('assistant.message', {
          messageId: `reply-${input}`,
          content: `REPLY_${input}`,
          interactionId: `interaction-${input}`,
          phase: 'final_answer',
        });
        event('session.idle', {});
      }
      if (prompt === 'late-settled') {
        const timer = setInterval(() => {
          if (!existsSync(join(process.cwd(), 'release-settlement'))) return;
          clearInterval(timer);
          event('assistant.message', {
            messageId: `reply-${input}`,
            content: 'LATE_COMPLETE_REPLY',
            interactionId: `interaction-${input}`,
            phase: 'final_answer',
          });
          event('session.idle', {});
          appendFileSync(join(process.cwd(), 'settlement-emitted'), 'ready');
        }, 5);
      }
      if (prompt === 'stale-echo') {
        event('user.message', {
          messageId: 'input-1',
          interactionId: `interaction-${input}`,
          content: 'old',
        });
        event('assistant.message', {
          messageId: `reply-${input}`,
          interactionId: `interaction-${input}`,
          content: 'STALE_SAFE_REPLY',
          phase: 'final_answer',
        });
        event('session.idle', {});
      }
      if (prompt === 'fragments')
        for (let index = 0; index < 12; index++)
          event('assistant.message', {
            messageId: `fragment-${input}-${index}`,
            interactionId: 'interaction-1',
            content: `FRAGMENT_${index};`,
            phase: 'final_answer',
          });
      if (prompt === 'dedup-pressure') {
        for (let index = 0; index < 270; index++)
          event('assistant.message', {
            messageId: `pressure-${index}`,
            content: 'fragment',
            interactionId: `interaction-${input}`,
            phase: 'final_answer',
          });
      }
      if (prompt === 'ack-pressure')
        for (let index = 0; index < 513; index++) event('session.idle', {});
      if (prompt === 'error' || prompt === 'error-queued') {
        event('session.error', { errorType: 'fixture', message: 'Synthetic error' });
        event('session.idle', {});
      }
      if (prompt === 'abort-queued') event('session.idle', { aborted: true });
      if (prompt === 'empty') event('session.idle', {});
      if (
        process.argv.includes('--late-user-echo') &&
        prompt !== 'queued' &&
        !String(prompt).endsWith('-queued')
      )
        event('user.message', { messageId: id, interactionId: 'rewritten', content: prompt });
      if (prompt === 'held-ack') {
        const timer = setInterval(() => {
          if (!existsSync(join(process.cwd(), 'release-ack'))) return;
          clearInterval(timer);
          reply({ messageId: id });
        }, 5);
      } else if (prompt === 'ping-ack') pendingAck = () => reply({ messageId: id });
      else if (prompt === 'late-ack') setTimeout(() => reply({ messageId: id }), 20);
      else if (prompt !== 'lost-ack') reply({ messageId: id });
      break;
    }
    case 'session.queue.pendingItems':
      reply({
        items: queued.map((item) => ({
          ...item,
          kind: 'message',
          displayText: 'queued',
          agentMode: 'interactive',
        })),
        steeringMessages: [],
      });
      break;
    case 'session.queue.removeAt': {
      const index = queued.findIndex((item) => item.id === msg.params?.id);
      if (index >= 0) queued.splice(index, 1);
      reply({ removed: index >= 0 });
      break;
    }
    case 'session.abort':
      reply({});
      if (process.argv.includes('--abort-ack-only')) break;
      setTimeout(
        () => {
          event('abort', { reason: 'user_initiated' });
          event('session.idle', { aborted: true });
          if (process.argv.includes('--late-user-echo'))
            event('user.message', { messageId: `input-${input}`, interactionId: 'rewritten' });
          if (process.argv.includes('--idle-after-abort')) event('session.idle', {});
        },
        process.argv.includes('--delayed-abort') ? 2250 : 15
      );
      break;
    case 'ping':
      if (existsSync(join(process.cwd(), 'block-ping'))) break;
      if (process.argv.includes('--crash-on-ping')) process.exit(1);
      if (process.argv.includes('--initial-idle') && input === 0) event('session.idle', {});
      reply({ message: 'ok', timestamp: Date.now() });
      if (pendingAck) {
        setTimeout(pendingAck, 5);
        pendingAck = undefined;
      }
      break;
    case 'runtime.shutdown':
      if (process.argv.includes('--hang-stop')) break;
      if (process.argv.includes('--slow-stop')) {
        const timer = setInterval(() => {
          if (!existsSync(join(process.cwd(), 'release-shutdown'))) return;
          clearInterval(timer);
          reply({});
          setTimeout(() => process.exit(0), 5);
        }, 5);
        break;
      }
      reply({});
      setTimeout(() => process.exit(0), 5);
      break;
    default:
      reply({});
  }
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(
      buffer
        .subarray(0, end)
        .toString()
        .match(/Content-Length: (\d+)/i)?.[1]
    );
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    receive(message);
  }
});
process.stdin.on('end', () => process.exit(0));
