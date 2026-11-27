import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type CallToolRequest, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpFetch, type McpOAuthPreset, type McpRefreshFailure } from './mcp-fetch.ts';
import { admitsMcpGrant } from './mcp-oauth-provider.ts';
import type { McpGrant } from './status.ts';

type Admission = { generation: number; preset: McpOAuthPreset };
type Failure = McpRefreshFailure | 'unauthorized';
type CredentialHistory = Admission & { sent: Set<string> };
type RowClient = CredentialHistory & {
  sdk: Client;
  ready: Promise<void>;
  fault?: RowFailure;
};

export class RowFailure extends Error {
  constructor(reason: Failure) {
    super(reason);
  }
}

const boundedFailure = (error: unknown) =>
  error instanceof RowFailure ? error : new RowFailure('request_failed');

function visitStrings(value: unknown, visit: (text: string) => string): unknown {
  if (typeof value === 'string') return visit(value);
  if (Array.isArray(value)) return value.map((item) => visitStrings(item, visit));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [visit(key), visitStrings(item, visit)])
    );
  return value;
}

export function createMcpOAuthRowClient(options: {
  admission: (id: string) => Admission | undefined;
  grant: (id: string) => Promise<McpGrant | null>;
  refresh: (
    id: string,
    token: string
  ) => Promise<{ ok: true } | { ok: false; reason: McpRefreshFailure }>;
  closeSignal: AbortSignal;
}) {
  const rows = new Map<string, RowClient>();
  const histories = new Map<string, CredentialHistory>();
  const matching = (current: Admission | undefined, admitted: Admission) =>
    current?.generation === admitted.generation && current.preset === admitted.preset;

  function close(id: string, row = rows.get(id), fault?: RowFailure) {
    if (rows.get(id) !== row) return;
    if (!fault) {
      histories.get(id)?.sent.clear();
      histories.delete(id);
    }
    if (!row) return;
    row.fault = fault;
    rows.delete(id);
    void row.sdk.close().catch(() => {});
  }
  function closeAll() {
    for (const id of histories.keys()) close(id);
  }
  options.closeSignal.addEventListener('abort', closeAll, { once: true });

  function current(id: string, row: RowClient) {
    if (options.closeSignal.aborted || !matching(options.admission(id), row))
      throw new RowFailure('reconnect_needed');
    if (row.fault) throw row.fault;
    if (rows.get(id) !== row) throw new RowFailure('reconnect_needed');
  }

  function open(id: string, admitted: Admission) {
    const history = histories.get(id) ?? { ...admitted, sent: new Set<string>() };
    histories.set(id, history);
    const sdk = new Client({ name: 'HyperNeo', version: '1' });
    const bounded = createMcpFetch({
      preset: admitted.preset,
      tokenEndpoint: () => undefined,
      onCredentialSent: (value) => row.sent.add(value),
      onResponseTooLarge: () => close(id, row, new RowFailure('response_too_large')),
    });
    async function send(url: string | URL, init?: RequestInit, retry = true): Promise<Response> {
      current(id, row);
      const grant = await options.grant(id);
      current(id, row);
      if (!admitsMcpGrant(row.preset, row.generation, grant))
        throw new RowFailure('reconnect_needed');
      const token = grant.tokens.access_token;
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${token}`);
      const response = await bounded(url, { ...init, headers });
      const { status } = response;
      if (status !== 401 && status !== 403 && status !== 429) return response;
      await response.body?.cancel();
      if (status !== 401 || !retry)
        throw new RowFailure(status === 429 ? 'rate_limited' : 'unauthorized');
      current(id, row);
      const result = await options.refresh(id, token);
      if (!result.ok) throw new RowFailure(result.reason);
      return send(url, init, false);
    }
    const transport = new StreamableHTTPClientTransport(new URL(admitted.preset.url), {
      fetch: send,
    });
    const ready = sdk.connect(transport).catch((error) => {
      close(id, row, boundedFailure(error));
      throw error;
    });
    const row: RowClient = { ...history, sdk, ready };
    rows.set(id, row);
    return row;
  }

  async function request<T, R>(
    id: string,
    run: (sdk: Client) => Promise<T>,
    project: (result: T, redact: (text: string) => string) => R
  ): Promise<R> {
    const admitted = options.admission(id);
    const cached = histories.get(id);
    if (cached && (!admitted || !matching(cached, admitted))) close(id);
    if (options.closeSignal.aborted || !admitted) throw new RowFailure('reconnect_needed');
    const row = rows.get(id) ?? open(id, admitted);
    try {
      await row.ready;
      current(id, row);
      const result = await run(row.sdk);
      const grant = await options.grant(id);
      current(id, row);
      if (!admitsMcpGrant(row.preset, row.generation, grant))
        throw new RowFailure('reconnect_needed');
      const values = new Set([
        ...row.sent,
        grant.tokens.access_token,
        grant.tokens.refresh_token,
        grant.client.client_secret,
      ]);
      const pattern = [...values]
        .filter((value): value is string => !!value)
        .sort((a, b) => b.length - a.length)
        .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
      const secrets = new RegExp(pattern, 'g');
      return project(result, (text) => text.replace(secrets, '[redacted]'));
    } catch (error) {
      current(id, row);
      throw boundedFailure(error);
    }
  }

  return {
    close: (id: string) => close(id),
    recordCredential: (id: string, generation: number, value: string) => {
      const history = histories.get(id);
      if (history?.generation === generation) history.sent.add(value);
    },
    listTools: (id: string) =>
      request(
        id,
        (sdk) => sdk.listTools(),
        (result, redact) => {
          visitStrings(result.tools, (text) => {
            if (redact(text) !== text) throw new RowFailure('request_failed');
            return text;
          });
          return result;
        }
      ),
    callTool: (id: string, input: CallToolRequest['params']) =>
      request(
        id,
        (sdk) => sdk.callTool(input),
        (result, redact) => {
          if (result.isError) throw new RowFailure('request_failed');
          return CallToolResultSchema.parse(visitStrings(result, redact));
        }
      ),
  };
}
