import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const cwd = process.argv[2],
  sid = 'synthetic-acp-retry';
const send = (x: unknown) => process.stdout.write(JSON.stringify(x) + '\n');
const reply = (id: string | number, result: unknown) => send({ jsonrpc: '2.0', id, result });
const update = (text: string) =>
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: sid,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  });
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  appendFileSync(
    join(cwd, 'acp-calls.jsonl'),
    JSON.stringify({ pid: process.pid, method: msg.method, params: msg.params }) + '\n'
  );
  if (msg.method === 'initialize')
    reply(msg.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: 'synthetic-retry', version: '1' },
      authMethods: [],
    });
  else if (msg.method === 'session/new') reply(msg.id, { sessionId: sid });
  else if (msg.method === 'session/load') reply(msg.id, {});
  else if (msg.method === 'session/prompt') {
    update('Synthetic ACP accepted');
    if (!existsSync(join(cwd, 'failed-once'))) {
      writeFileSync(join(cwd, 'failed-once'), 'yes');
      const timer = setInterval(() => {
        if (existsSync(join(cwd, 'release-error'))) {
          clearInterval(timer);
          send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: 'TypeError: fetch failed' },
          });
        }
      }, 20);
    } else {
      update('ACP_RETRY_OK');
      reply(msg.id, { stopReason: 'end_turn' });
    }
  } else if (msg.method === 'session/cancel') {
  } else if (msg.id !== undefined) reply(msg.id, {});
});
