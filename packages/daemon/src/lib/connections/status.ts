import { z } from 'zod';

export const connectionStatus = z.object({
  id: z.string().min(1).max(200),
  provider: z.literal('google'),
  accountId: z.string().min(1).max(200),
  email: z.string().email(),
  scopes: z.array(z.string().max(300)).max(20),
  health: z.enum(['healthy', 'reconnect_needed', 'disconnected']),
});

export type ConnectionStatus = z.infer<typeof connectionStatus>;

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
