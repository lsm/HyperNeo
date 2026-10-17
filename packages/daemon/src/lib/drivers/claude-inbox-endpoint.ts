import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import {
  claudeSessionOwner,
  requireClaudePeerOwner,
  type ClaudeSessionIdentity,
  type ClaudeSessionOwner,
} from './claude-session-owner.ts';
import type { Rejected } from './types.ts';
import { reject } from './work-operations.ts';

const InboxRegistrationSchema = z.object({
  sessionId: z.string().uuid(),
  pid: z.number().int().positive(),
  version: z.enum(['2.1.295', '2.1.299']),
  messagingSocketPath: z.string().min(1),
  peerProtocol: z.number().optional(),
  peerFeatures: z.array(z.string()).optional(),
});

export interface ClaudeCliInboxEndpoint {
  sessionId: string;
  pid: number;
  version: '2.1.295' | '2.1.299';
  socketPath: string;
}

export function requireClaudeInboxEndpoint(
  live: ClaudeSessionIdentity & { owner?: ClaudeSessionOwner },
  registration: unknown
): { value: ClaudeCliInboxEndpoint } | { reason: Rejected } {
  const owner = requireClaudePeerOwner(live.sessionId, [
    { ...live, owner: claudeSessionOwner(live, registration) },
  ]);
  if ('reason' in owner) return owner;
  if (live.owner !== undefined && live.owner !== owner.value.owner)
    return { reason: reject('unreachable', 'Claude ownership changed since live discovery.') };
  const parsed = InboxRegistrationSchema.safeParse(registration);
  if (!parsed.success)
    return {
      reason: reject('unsupported', 'No registered inbox with a verified Claude protocol.'),
    };
  const record = parsed.data;
  const verified =
    owner.value.owner === 'desktop'
      ? record.version === '2.1.299' &&
        record.peerProtocol === 1 &&
        record.peerFeatures?.includes('notify_idle')
      : record.version === '2.1.295';
  if (!verified)
    return {
      reason: reject('unsupported', 'No registered inbox with a verified Claude protocol.'),
    };
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

export async function readClaudeSenderSession(
  from: string,
  sessionsDir: string
): Promise<string | null> {
  const path = from.startsWith('uds:') ? from.slice(4) : '';
  const pid = /^(\d+)(?:-[0-9a-f]{8})?\.sock$/.exec(basename(path))?.[1];
  if (!pid || !isAbsolute(path)) return null;
  try {
    const registration = JSON.parse(await readFile(join(sessionsDir, `${pid}.json`), 'utf8'));
    return registration?.messagingSocketPath === path && typeof registration.sessionId === 'string'
      ? registration.sessionId
      : null;
  } catch {
    return null;
  }
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
  .pipe(requireClaudePeerOwner, ['sessionId', 'live'], 'result:target')
  .pipe((target: ClaudeSessionIdentity) => target, 'target', 'identity')
  .pipe(readRegistration, ['identity', 'sessionsDir'], 'registration')
  .pipe(requireClaudeInboxEndpoint, ['identity', 'registration'], 'result:target')
  .endAsync('target') as (
  sessionId: string,
  live: readonly (ClaudeSessionIdentity & { owner?: ClaudeSessionOwner })[],
  sessionsDir: string
) => Promise<ClaudeCliInboxEndpoint | Rejected>;
