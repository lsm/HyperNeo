import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { createMcpFetch, type McpOAuthPreset } from './mcp-fetch.ts';
import { mcpGrant, type McpGrant } from './status.ts';
import type { ConnectionVault } from './vault.ts';

type Draft = Partial<Omit<McpGrant, 'generation'>> & { verifier?: string };

const sameUrl = (a: string | undefined, b: string) =>
  !!a && new URL(a).href.replace(/\/$/, '') === new URL(b).href.replace(/\/$/, '');
const boundTo = (
  preset: McpOAuthPreset,
  state: { authorizationServerUrl: string; authorizationServerMetadata?: { issuer: string } }
) =>
  sameUrl(state.authorizationServerUrl, preset.issuer) &&
  sameUrl(state.authorizationServerMetadata?.issuer, preset.issuer);
const withinMaximum = (preset: McpOAuthPreset, scopes: string[]) =>
  scopes.every((scope) => preset.scopes.includes(scope));
const scopeList = (scope: string | null | undefined) => scope?.split(/\s+/).filter(Boolean);

export function createMcpOAuthProvider(options: {
  vault: ConnectionVault;
  serverId: string;
  preset: McpOAuthPreset;
  generation: number;
  redirectUrl: string;
  client?: { clientId: string; clientSecret?: string };
  attempt?: { authorize: (url: URL) => void };
  fetchImpl?: typeof fetch;
}) {
  const { preset, attempt } = options;
  let draft: Draft = {};
  const ready = attempt
    ? Promise.resolve()
    : options.vault.readMcp(options.serverId).then((grant) => {
        if (grant?.generation === options.generation && boundTo(preset, grant.binding))
          draft = grant;
      });
  const persist = async () => {
    const { client, tokens, binding, scopes } = draft;
    if (!client || !tokens || !binding || !scopes) throw new Error('request_failed');
    await options.vault.replaceMcp(options.serverId, {
      generation: options.generation,
      client,
      tokens,
      binding,
      scopes,
    });
  };
  const provider: OAuthClientProvider = {
    redirectUrl: options.redirectUrl,
    clientMetadata: {
      client_name: 'HyperNeo',
      redirect_uris: [options.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: options.client?.clientSecret ? 'client_secret_post' : 'none',
      scope: preset.scopes.join(' '),
    },
    clientInformation: async () => {
      await ready;
      const preRegistered = options.client && {
        client_id: options.client.clientId,
        client_secret: options.client.clientSecret,
        issuer: preset.issuer,
      };
      return (draft.client as OAuthClientInformationMixed | undefined) ?? preRegistered;
    },
    saveClientInformation: (client) => {
      draft.client = client;
    },
    tokens: async () => {
      await ready;
      return attempt ? undefined : (draft.tokens as OAuthTokens | undefined);
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
      if (!boundTo(preset, state)) throw new Error('request_failed');
      draft.binding = mcpGrant.shape.binding.parse(state);
    },
    discoveryState: async () => {
      await ready;
      return draft.binding as OAuthDiscoveryState | undefined;
    },
  };
  const fetchFn = createMcpFetch({
    preset,
    tokenEndpoint: () => draft.binding?.authorizationServerMetadata.token_endpoint,
    fetchImpl: options.fetchImpl,
  });
  return { provider, fetch: fetchFn, commit: persist };
}
