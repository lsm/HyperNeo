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

export const connectionTokens = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().finite().positive(),
  scopes: connectionStatus.shape.scopes,
});

export type ConnectionTokens = z.infer<typeof connectionTokens>;
