import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const run = process.argv[2];
const sid = 'synthetic-card-reply-acp';
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id: number | string, result: unknown) => send({ jsonrpc: '2.0', id, result });
let proxy: ReturnType<typeof spawn> | undefined;
let nextId = 0;
const pending = new Map<number, (value: unknown) => void>();
const call = (method: string, params: unknown) =>
  new Promise<unknown>((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    proxy!.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
const update = (text: string) =>
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: sid,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  });
createInterface({ input: process.stdin })
  .on('line', async (line) => {
    const message = JSON.parse(line);
    if (message.method === 'initialize')
      reply(message.id, {
        protocolVersion: 1,
        agentCapabilities: { mcpCapabilities: { http: false, sse: false } },
        agentInfo: { name: 'synthetic-card-reply', version: '1' },
        authMethods: [],
      });
    else if (message.method === 'session/new') {
      const server = message.params.mcpServers.find(
        (server: { name: string }) => server.name === 'hyperneo-operations'
      );
      proxy = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'inherit'] });
      createInterface({ input: proxy.stdout! }).on('line', (line) => {
        const response = JSON.parse(line);
        pending.get(response.id)?.(response);
        pending.delete(response.id);
      });
      await call('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'synthetic', version: '1' },
      });
      reply(message.id, { sessionId: sid });
    } else if (message.method === 'session/prompt') {
      const text = JSON.stringify(message.params.prompt);
      appendFileSync(
        join(run, 'evidence/acp-protocol.jsonl'),
        JSON.stringify({ event: 'prompt', text }) + '\n'
      );
      update('Synthetic prompt accepted');
      while (!existsSync(join(run, 'release-tools')))
        await new Promise((resolve) => setTimeout(resolve, 10));
      const background = text.includes('BACKGROUND_CARD');
      const input = {
        retireWhen: {
          pack: 'core',
          kind: 'evidence',
          params: { path: join(run, 'question-no-longer-needed') },
        },
        askId: 'costco',
        kind: 'choice',
        text: background ? 'Background card' : '周六还是周日去 Costco？',
        options: ['周六', '周日'],
      };
      for (let i = 0; i < (background ? 1 : 2); i++) {
        const receipt = await call('tools/call', {
          name: 'invoke',
          arguments: { name: 'neo.question.ask', input },
        });
        appendFileSync(
          join(run, 'evidence/acp-protocol.jsonl'),
          JSON.stringify({ event: 'receipt', background, input, receipt }) + '\n'
        );
      }
      update('Done.');
      reply(message.id, { stopReason: 'end_turn' });
    } else if (message.id !== undefined) reply(message.id, {});
  })
  .on('close', () => proxy?.kill());
process.on('exit', () => proxy?.kill());
