import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Rejected } from './types.ts';
import { reject } from './work-operations.ts';

export type ClaudeSessionOwner = 'desktop' | 'cli' | 'unknown';

export interface ClaudeSessionIdentity {
  sessionId: string;
  pid?: number;
}

const RegistrationSchema = z.object({
  pid: z.number().int().positive(),
  sessionId: z.string().min(1),
  procStart: z.union([z.number().positive(), z.string().min(1)]),
  entrypoint: z.string(),
  version: z.string(),
});

export function claudeSessionOwner(
  live: ClaudeSessionIdentity,
  registration: unknown
): ClaudeSessionOwner {
  const parsed = RegistrationSchema.safeParse(registration);
  if (!parsed.success) return 'unknown';
  const record = parsed.data;
  if (live.pid !== record.pid || live.sessionId !== record.sessionId) return 'unknown';
  if (record.entrypoint === 'claude-desktop') return 'desktop';
  return ['cli', 'sdk-cli', 'sdk-ts'].includes(record.entrypoint) ? 'cli' : 'unknown';
}

export async function readClaudeSessionOwner(
  live: ClaudeSessionIdentity,
  sessionsDir: string
): Promise<ClaudeSessionOwner> {
  if (!live.pid || !Number.isSafeInteger(live.pid) || live.pid <= 0) return 'unknown';
  try {
    const registration: unknown = JSON.parse(
      await readFile(join(sessionsDir, `${live.pid}.json`), 'utf8')
    );
    return claudeSessionOwner(live, registration);
  } catch {
    return 'unknown';
  }
}

export function requireClaudePeerOwner(
  sessionId: string,
  live: readonly (ClaudeSessionIdentity & { owner?: ClaudeSessionOwner })[]
): { value: ClaudeSessionIdentity & { owner: 'cli' | 'desktop' } } | { reason: Rejected } {
  const candidates = live.filter((session) => session.sessionId === sessionId);
  const session = candidates[0];
  return candidates.length === 1 &&
    (session.owner === 'cli' || session.owner === 'desktop') &&
    typeof session.pid === 'number' &&
    Number.isSafeInteger(session.pid) &&
    session.pid > 0
    ? { value: { sessionId, pid: session.pid, owner: session.owner } }
    : {
        reason: reject(
          'unreachable',
          'Claude session ownership is unknown or ambiguous. The daemon will not resume it or choose a fallback channel.'
        ),
      };
}

export function requireClaudeCliOwner(
  sessionId: string,
  live: readonly (ClaudeSessionIdentity & { owner?: ClaudeSessionOwner })[]
): { value: ClaudeSessionIdentity & { owner: 'cli' } } | { reason: Rejected } {
  const candidates = live.filter((session) => session.sessionId === sessionId);
  if (candidates.some((session) => session.owner === 'desktop')) {
    return {
      reason: reject(
        'unsupported',
        'Claude Desktop owns this session. Its management channel is unavailable to the daemon; open the session in Claude Desktop.'
      ),
    };
  }
  const session = candidates[0];
  return candidates.length === 1 && session.owner === 'cli' && session.pid
    ? { value: { sessionId: session.sessionId, pid: session.pid, owner: 'cli' } }
    : {
        reason: reject(
          'unreachable',
          'Claude session ownership is unknown. The daemon will not resume it or choose a fallback channel.'
        ),
      };
}
