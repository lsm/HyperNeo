import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import {
  claudeSessionOwner,
  requireClaudeCliOwner,
  type ClaudeSessionIdentity,
  type ClaudeSessionOwner,
} from './claude-session-owner.ts';
import type { Rejected } from './types.ts';
import { reject } from './work-operations.ts';

const InboxRegistrationSchema = z.object({
  sessionId: z.string().uuid(),
  pid: z.number().int().positive(),
  version: z.literal('2.1.295'),
  messagingSocketPath: z.string().min(1),
});

export interface ClaudeCliInboxEndpoint {
  sessionId: string;
  pid: number;
  version: '2.1.295';
  socketPath: string;
}

export function requireClaudeInboxEndpoint(
  live: ClaudeSessionIdentity,
  registration: unknown
): { value: ClaudeCliInboxEndpoint } | { reason: Rejected } {
  const owner = requireClaudeCliOwner(live.sessionId, [
    { ...live, owner: claudeSessionOwner(live, registration) },
  ]);
  if ('reason' in owner) return owner;
  const parsed = InboxRegistrationSchema.safeParse(registration);
  if (!parsed.success)
    return {
      reason: reject('unsupported', 'No registered inbox with a verified Claude protocol.'),
    };
  const record = parsed.data;
  if (
    !isAbsolute(record.messagingSocketPath) ||
    !new RegExp(`^${record.pid}(?:-[a-f0-9]{8})?\\.sock$`).test(
      basename(record.messagingSocketPath)
    )
  )
    return {
      reason: reject('unreachable', 'The registered Claude inbox does not match its live PID.'),
    };
  return {
    value: {
      sessionId: record.sessionId,
      pid: record.pid,
      version: record.version,
      socketPath: record.messagingSocketPath,
    },
  };
}

async function readRegistration(
  live: ClaudeSessionIdentity,
  sessionsDir: string
): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(sessionsDir, `${live.pid}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export const readClaudeInboxEndpoint = (superpipe({})('read-claude-inbox-endpoint') as PipelineAPI)
  .input(['sessionId', 'live', 'sessionsDir'])
  .pipe(requireClaudeCliOwner, ['sessionId', 'live'], 'result:target')
  .pipe((target: ClaudeSessionIdentity) => target, 'target', 'identity')
  .pipe(readRegistration, ['identity', 'sessionsDir'], 'registration')
  .pipe(requireClaudeInboxEndpoint, ['identity', 'registration'], 'result:target')
  .endAsync('target') as (
  sessionId: string,
  live: readonly (ClaudeSessionIdentity & { owner?: ClaudeSessionOwner })[],
  sessionsDir: string
) => Promise<ClaudeCliInboxEndpoint | Rejected>;
