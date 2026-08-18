#!/usr/bin/env bun

import { createInterface } from 'node:readline';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

function sendResponse(id: number | string | null, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function sendError(id: number | string | null, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function sendNotification(method: string, params: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

let sessionId: string | null = null;

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: JsonRpcRequest | JsonRpcNotification;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  const isRequest = 'id' in msg && msg.id !== undefined;

  switch (msg.method) {
    case 'initialize': {
      if (isRequest) {
        sendResponse(msg.id, {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { close: null } },
          agentInfo: { name: 'mock-acp-server', version: '0.0.1' },
          authMethods: [{ id: 'none', name: 'None' }],
        });
      }
      break;
    }

    case 'authenticate': {
      if (isRequest) {
        sendResponse(msg.id, {});
      }
      break;
    }

    case 'session/new': {
      if (isRequest) {
        sessionId = 'mock-session-001';
        sendResponse(msg.id, {
          sessionId,
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              type: 'select',
              options: [{ name: 'Default', value: 'default' }],
              currentValue: 'default',
              category: 'model',
            },
          ],
          modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }] },
        });
      }
      break;
    }

    case 'session/prompt': {
      if (isRequest) {
        const params = msg.params as { sessionId: string; prompt: unknown[] };
        const sid = params.sessionId;

        sendNotification('session/update', {
          sessionId: sid,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Hello ' },
          },
        });
        sendNotification('session/update', {
          sessionId: sid,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'world' },
          },
        });
        sendNotification('session/update', {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-mock-1',
            title: 'Read file',
            rawInput: { path: '/tmp/test.txt' },
          },
        });
        sendNotification('session/update', {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-mock-1',
            title: 'Read file',
            status: 'completed',
          },
        });

        sendResponse(msg.id, { stopReason: 'end_turn' });
      }
      break;
    }

    case 'session/cancel': {
      break;
    }

    default: {
      if (isRequest) {
        sendError(msg.id, -32601, `Method not found: ${msg.method}`);
      }
    }
  }
});

rl.on('close', () => {
  process.exit(0);
});
