#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const home = process.cwd();
const sessionId = '11111111-1111-4111-8111-111111111111';
let pending: number | string | undefined;
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id: number | string, result: unknown) => send({ jsonrpc: '2.0', id, result });
const update = (id: string, text: string) =>
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: id,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  });
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const msg = JSON.parse(line);
  appendFileSync(join(home, 'evidence/calls.jsonl'), JSON.stringify(msg) + '\n');
  switch (msg.method) {
    case 'initialize':
      reply(msg.id, {
        protocolVersion: process.argv.includes('--bad-version') ? 99 : 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } },
        agentInfo: { name: 'synthetic-copilot', version: 'fixture-1' },
        authMethods: [],
      });
      break;
    case 'session/list':
      if (existsSync(join(home, 'copilot-list.json'))) {
        reply(msg.id, {
          sessions: JSON.parse(readFileSync(join(home, 'copilot-list.json'), 'utf8')),
        });
        break;
      }
      reply(
        msg.id,
        msg.params?.cursor
          ? {
              sessions: [
                {
                  sessionId: '22222222-2222-4222-8222-222222222222',
                  cwd: '/synthetic/other-project',
                  title: 'Other task',
                  updatedAt: new Date().toISOString(),
                },
              ],
            }
          : {
              sessions: [
                {
                  sessionId,
                  cwd: home,
                  title: '[User]: Synthetic\n sum task',
                  updatedAt: new Date().toISOString(),
                },
              ],
              nextCursor: 'page-2',
            }
      );
      break;
    case 'session/load':
      reply(msg.id, {});
      break;
    case 'session/prompt':
      pending = msg.id;
      update('unrelated-session', 'Never attribute this reply');
      update(msg.params.sessionId, 'Synthetic working');
      break;
    case 'session/cancel':
      if (pending !== undefined) reply(pending, { stopReason: 'cancelled' });
      pending = undefined;
      break;
    default:
      if (msg.id !== undefined)
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: 'Synthetic fixture rejects unsupported methods' },
        });
  }
});
