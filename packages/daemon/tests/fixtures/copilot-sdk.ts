#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
let buffer = Buffer.alloc(0);
let sessionId = '';
let input = 0;
let eventId = 0;
const send = (message: unknown) => {
  const data = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(data)}\r\n\r\n${data}`);
};
const event = (type: string, data: unknown, id = `event-${++eventId}`, agentId?: string) =>
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
function receive(msg: { id?: number; method: string; params?: Record<string, unknown> }) {
  appendFileSync(
    join(process.cwd(), 'calls.jsonl'),
    `${JSON.stringify({ ...msg, pid: process.pid, secretPresent: !!process.env.ANTHROPIC_API_KEY })}\n`
  );
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'connect':
      reply({ protocolVersion: process.argv.includes('--bad-protocol') ? 99 : 3 });
      break;
    case 'status.get':
      reply({ version: 'fixture-1', protocolVersion: 3 });
      break;
    case 'session.create':
      sessionId = String(msg.params?.sessionId);
      reply({ sessionId });
      break;
    case 'session.send': {
      const prompt = msg.params?.prompt;
      const id = prompt === 'hostile' ? '__proto__' : `input-${++input}`;
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
      if (prompt === 'settled' || prompt === 'late-ack') {
        event('assistant.message', {
          messageId: `reply-${input}`,
          content: `REPLY_${input}`,
          interactionId: `interaction-${input}`,
          phase: 'final_answer',
        });
        event('session.idle', {});
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
      if (prompt === 'late-ack') setTimeout(() => reply({ messageId: id }), 20);
      else if (prompt !== 'lost-ack') reply({ messageId: id });
      break;
    }
    case 'session.abort':
      reply({});
      if (process.argv.includes('--abort-ack-only')) break;
      setTimeout(() => {
        event('abort', { reason: 'user_initiated' });
        event('session.idle', { aborted: true });
        if (process.argv.includes('--late-user-echo'))
          event('user.message', { messageId: `input-${input}`, interactionId: 'rewritten' });
        if (process.argv.includes('--idle-after-abort')) event('session.idle', {});
      }, 15);
      break;
    case 'ping':
      if (process.argv.includes('--initial-idle') && input === 0) event('session.idle', {});
      reply({ message: 'ok', timestamp: Date.now() });
      break;
    case 'runtime.shutdown':
      if (process.argv.includes('--hang-stop')) break;
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
