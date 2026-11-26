import { z } from 'zod';
import {
  OAuthClientInformationSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokensSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';

export const connectionProviders = ['google', 'microsoft'] as const;

const connectionProvider = z.enum(connectionProviders);

export const connectionStatus = z.object({
  id: z.string().min(1).max(200),
  provider: connectionProvider,
  accountId: z.string().min(1).max(200),
  email: z.string().email(),
  scopes: z.array(z.string().max(300)).max(20),
  health: z.enum(['healthy', 'reconnect_needed', 'disconnected']),
});

export type ConnectionStatus = z.infer<typeof connectionStatus>;

const graphScopes = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'Mail.ReadWrite',
  'Calendars.Read',
];

export const grantedScopes = (scope: string) =>
  scope
    .split(/\s+/)
    .filter(Boolean)
    .map((name) => {
      const short = name.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase();
      return graphScopes.find((known) => known.toLowerCase() === short) ?? name;
    });

export const googleConnections = (rows: ConnectionStatus[]) =>
  rows.filter((row) => row.provider === 'google');

export const googleClient = z.object({
  clientId: z.string().trim().min(1).max(500),
  clientSecret: z.string().max(1000).optional(),
});

export const googleConnectionAttempt = z.object({
  state: z.enum(['pending', 'complete', 'failed', 'missing']),
  loginId: z.string().optional(),
  connectionId: z.string().optional(),
  reason: z.string().optional(),
  authorizeUrl: z.string().url().optional(),
  storage: z
    .object({
      backend: z.enum(['keychain', 'keychain-unavailable', 'keychain-fallback', 'database']),
      keychainAvailable: z.boolean(),
      warning: z.string().optional(),
    })
    .optional(),
});

export type GoogleConnectionAttempt = z.infer<typeof googleConnectionAttempt>;

export const connectionTokens = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().finite().positive(),
  scopes: connectionStatus.shape.scopes,
  client: googleClient.optional(),
});

export type ConnectionTokens = z.infer<typeof connectionTokens>;

export const mcpGrant = z.object({
  generation: z.number().int().nonnegative(),
  scopes: z.array(z.string().max(300)).max(50),
  client: OAuthClientInformationSchema,
  tokens: OAuthTokensSchema,
  binding: z.object({
    resource: z.string().url(),
    authorizationServerUrl: z.string().url(),
    authorizationServerMetadata: OAuthMetadataSchema,
    resourceMetadata: OAuthProtectedResourceMetadataSchema.optional(),
    resourceMetadataUrl: z.string().optional(),
  }),
});

export type McpGrant = z.infer<typeof mcpGrant>;
