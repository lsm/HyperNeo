import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { createMcpFetch, type McpOAuthPreset, type McpRefreshFailure } from './mcp-fetch.ts';
import { type McpGrant, mcpGrant } from './status.ts';
import type { ConnectionVault } from './vault.ts';

type Draft = Partial<Omit<McpGrant, 'generation'>> & { verifier?: string };

const sameUrl = (a: string | undefined, b: string) =>
  !!a && new URL(a).href.replace(/\/$/, '') === new URL(b).href.replace(/\/$/, '');
const boundTo = (preset: McpOAuthPreset, binding: McpGrant['binding']) =>
  new URL(binding.resource).href === new URL(preset.resource ?? preset.url).href &&
  sameUrl(binding.authorizationServerUrl, preset.issuer) &&
  sameUrl(binding.authorizationServerMetadata.issuer, preset.issuer) &&
  binding.authorizationServerMetadata.authorization_endpoint === preset.authorizationEndpoint;
const withinMaximum = (preset: McpOAuthPreset, scopes: string[]) =>
  scopes.every((scope) => preset.scopes.includes(scope));
const scopeList = (scope: string | null | undefined) => scope?.split(/\s+/).filter(Boolean);

export function admitsMcpGrant(
  preset: McpOAuthPreset,
  generation: number,
  grant: McpGrant | null
): grant is McpGrant {
  return (
    grant?.generation === generation &&
    boundTo(preset, grant.binding) &&
    withinMaximum(preset, grant.scopes)
  );
}

export function createMcpOAuthProvider(options: {
  vault: ConnectionVault;
  serverId: string;
  preset: McpOAuthPreset;
  generation: number;
  redirectUrl: string;
  attempt?: { authorize: (url: URL) => void; client?: McpGrant['client'] };
  save?: (grant: McpGrant) => Promise<void>;
  onRefreshFailure?: (reason: McpRefreshFailure) => void;
  onCredentialSent?: (value: string) => void;
  timeoutMs?: number;
}) {
  const { preset, attempt } = options;
  let draft: Draft = attempt?.client ? { client: attempt.client } : {};
  const ready = attempt
    ? Promise.resolve()
    : options.vault.readMcp(options.serverId).then((grant) => {
        if (admitsMcpGrant(preset, options.generation, grant)) draft = grant;
      });
  const persist = async () => {
    const { client, tokens, binding, scopes } = draft;
    if (!client || !tokens || !binding || !scopes) throw new Error('request_failed');
    const grant = {
      generation: options.generation,
      client,
      tokens,
      binding,
      scopes,
    };
    await (options.save ? options.save(grant) : options.vault.replaceMcp(options.serverId, grant));
  };
  const provider: OAuthClientProvider = {
    redirectUrl: options.redirectUrl,
    clientMetadata: {
      client_name: 'HyperNeo',
      redirect_uris: [options.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: attempt?.client?.client_secret ? 'client_secret_post' : 'none',
      scope: preset.scopes.join(' '),
    },
    clientInformation: async () => {
      await ready;
      return draft.client;
    },
    saveClientInformation: (client) => {
      draft.client = mcpGrant.shape.client.parse(client);
    },
    tokens: async () => {
      await ready;
      return attempt ? undefined : draft.tokens;
    },
    saveTokens: async (tokens) => {
      await ready;
      const scopes = scopeList(tokens.scope) ?? (attempt ? preset.scopes : draft.scopes);
      if (!scopes || !withinMaximum(preset, scopes)) throw new Error('request_failed');
      draft.tokens = { refresh_token: draft.tokens?.refresh_token, ...tokens };
      draft.scopes = scopes;
      if (!attempt) await persist();
    },
    redirectToAuthorization: (url) => {
      if (!attempt) throw new Error('reconnect_needed');
      const scopes = scopeList(url.searchParams.get('scope')) ?? [];
      if (
        !draft.binding ||
        !boundTo(preset, draft.binding) ||
        url.origin + url.pathname !== preset.authorizationEndpoint ||
        !withinMaximum(preset, scopes)
      )
        throw new Error('request_failed');
      attempt.authorize(url);
    },
    saveCodeVerifier: (verifier) => {
      draft.verifier = verifier;
    },
    codeVerifier: () => {
      if (!draft.verifier) throw new Error('request_failed');
      return draft.verifier;
    },
    saveDiscoveryState: (state) => {
      const binding = mcpGrant.shape.binding.safeParse({
        ...state,
        resource: state.resourceMetadata?.resource ?? preset.resource ?? preset.url,
      });
      if (!binding.success || !boundTo(preset, binding.data)) throw new Error('request_failed');
      draft.binding = binding.data;
    },
    discoveryState: async () => {
      await ready;
      return draft.binding;
    },
  };
  const fetchFn = createMcpFetch({
    preset,
    tokenEndpoint: () => draft.binding?.authorizationServerMetadata.token_endpoint,
    onRefreshFailure: options.onRefreshFailure,
    onCredentialSent: options.onCredentialSent,
    timeoutMs: options.timeoutMs,
  });
  return { provider, fetch: fetchFn, commit: persist };
}
