import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { BUILD_METADATA } from '../build-metadata.ts';
import { defineOperation } from '../operations/registry.ts';

const Result = z.strictObject({
  commit: z.string().min(1),
  version: z.string().min(1),
  pid: z.number().int().positive(),
  startedAt: z.number().int().nonnegative(),
  uptime: z.number().nonnegative(),
  health: z.enum(['ok', 'fail']),
});

type BuildStatus = z.infer<typeof Result>;
const startedAt = Math.round(Date.now() - process.uptime() * 1000);

function readBuildStatus(probe: () => unknown): BuildStatus {
  let health: BuildStatus['health'] = 'ok';
  try {
    probe();
  } catch {
    health = 'fail';
  }
  return {
    commit: BUILD_METADATA.commit,
    version: BUILD_METADATA.version,
    pid: process.pid,
    startedAt,
    uptime: process.uptime() * 1000,
    health,
  };
}

export function createBuildOperation(probe: () => unknown) {
  const read = (superpipe({})('system-build') as PipelineAPI)
    .input(['probe'])
    .pipe(readBuildStatus, 'probe', 'status')
    .end('status') as (probe: () => unknown) => BuildStatus;
  return defineOperation({
    name: 'system.build',
    description:
      'Read the running daemon build commit, version, PID, process startedAt (Unix milliseconds), uptime (milliseconds), and health (ok if a read-only database probe succeeds, fail otherwise). No session data or configuration.',
    inputSchema: z.strictObject({}).default({}),
    resultSchema: Result,
    policy: { safetyClass: 'read' },
    execute: async () => read(probe),
  });
}
