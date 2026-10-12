import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { anthropicErrorStatus, assembleAnthropicMessage } from '../anthropic-non-streaming.ts';

function contentType(headers: OutgoingHttpHeaders): string {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type');
  return String(entry?.[1] ?? '');
}

export function collectMessageResponse(res: ServerResponse): ServerResponse {
  let status = 200;
  let headers: OutgoingHttpHeaders = {};
  let started = false;
  let ended = false;
  const chunks: string[] = [];
  const append = (chunk: unknown) => {
    if (chunk !== undefined && chunk !== null) chunks.push(String(chunk));
  };
  const finish = () => {
    const body = chunks.join('');
    if (status !== 200 || !contentType(headers).includes('event-stream')) {
      res.writeHead(status, headers);
      res.end(body);
      return;
    }
    const assembled = assembleAnthropicMessage(body);
    const json = { 'Content-Type': 'application/json' };
    if ('error' in assembled) {
      res.writeHead(anthropicErrorStatus(assembled.error), json);
      res.end(JSON.stringify({ type: 'error', error: assembled.error }));
      return;
    }
    res.writeHead(200, json);
    res.end(JSON.stringify(assembled.message));
  };
  const collector = {
    get headersSent() {
      return started;
    },
    get writableEnded() {
      return ended;
    },
    writeHead(code: number, head?: OutgoingHttpHeaders) {
      status = code;
      headers = head ?? {};
      started = true;
      return collector;
    },
    write(chunk: unknown) {
      started = true;
      append(chunk);
      return true;
    },
    end(chunk?: unknown) {
      if (ended) return collector;
      started = true;
      ended = true;
      append(typeof chunk === 'function' ? undefined : chunk);
      finish();
      return collector;
    },
  };
  return collector as unknown as ServerResponse;
}
