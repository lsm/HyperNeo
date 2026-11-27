import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpFetch, type McpOAuthPreset, type McpRefreshFailure } from './mcp-fetch.ts';
import { admitsMcpGrant } from './mcp-oauth-provider.ts';
import type { McpGrant } from './status.ts';

type Admission = { generation: number; preset: McpOAuthPreset };
type Failure = McpRefreshFailure | 'unauthorized';
type RowClient = Admission & {
  sdk: Client;
  ready: Promise<void>;
  fault?: RowFailure;
};

class RowFailure extends Error {
  constructor(reason: Failure) {
    super(reason);
  }
}

const boundedFailure = (error: unknown) =>
  error instanceof RowFailure ? error : new RowFailure('request_failed');

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
  const matching = (current: Admission | undefined, admitted: Admission) =>
    current?.generation === admitted.generation && current.preset === admitted.preset;

  function close(id: string, row = rows.get(id), fault?: RowFailure) {
    if (!row || rows.get(id) !== row) return;
    row.fault = fault;
    rows.delete(id);
    void row.sdk.close().catch(() => {});
  }
  function closeAll() {
    for (const id of rows.keys()) close(id);
  }
  options.closeSignal.addEventListener('abort', closeAll, { once: true });

  function current(id: string, row: RowClient) {
    if (options.closeSignal.aborted || !matching(options.admission(id), row))
      throw new RowFailure('reconnect_needed');
    if (row.fault) throw row.fault;
    if (rows.get(id) !== row) throw new RowFailure('reconnect_needed');
  }

  function open(id: string, admitted: Admission) {
    const sdk = new Client({ name: 'HyperNeo', version: '1' });
    const bounded = createMcpFetch({
      preset: admitted.preset,
      tokenEndpoint: () => undefined,
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
    const row: RowClient = { ...admitted, sdk, ready };
    rows.set(id, row);
    return row;
  }

  async function request<T>(id: string, run: (sdk: Client) => Promise<T>): Promise<T> {
    const admitted = options.admission(id);
    const cached = rows.get(id);
    if (cached && (!admitted || !matching(cached, admitted))) close(id);
    if (options.closeSignal.aborted || !admitted) throw new RowFailure('reconnect_needed');
    const row = rows.get(id) ?? open(id, admitted);
    try {
      await row.ready;
      current(id, row);
      const result = await run(row.sdk);
      current(id, row);
      return result;
    } catch (error) {
      current(id, row);
      throw boundedFailure(error);
    }
  }

  return {
    close: (id: string) => close(id),
    listTools: (id: string) => request(id, (sdk) => sdk.listTools()),
    callTool: (id: string, input: CallToolRequest['params']) =>
      request(id, (sdk) => sdk.callTool(input)),
  };
}
