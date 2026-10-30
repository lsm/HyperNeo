import { homedir } from 'node:os';
import {
  buildGitHubLookupEnv,
  DEFAULT_GH_LOOKUP_TIMEOUT_MS,
} from '../../../github/gh-lookup-helpers.ts';
import type { SpawnFn } from '../../../runtime-spawn/index.ts';
import { collectWithMaxBuffer } from '../../../utils/script-utils.ts';
import type { CodingDaemonMergeFacts } from './daemon-merge-gates.ts';

export const CODING_DAEMON_MERGE_MAX_ATTEMPTS = 3;

export function planCodingMergeAttempt(
  head: string,
  facts: CodingDaemonMergeFacts & { mergeCommit?: string | null },
  error: string | null
) {
  if (facts.ok && facts.head === head && facts.state === 'MERGED' && facts.mergeCommit)
    return { kind: 'confirmed' as const, commit: facts.mergeCommit };
  if (facts.ok && facts.state === 'OPEN')
    return {
      kind: 'retry' as const,
      error:
        error || 'GitHub still reports the PR open; the previous attempt did not confirm a merge.',
    };
  return { kind: 'hold' as const };
}

export async function runCodingMergeAttempt(url: string, head: string, spawn: SpawnFn) {
  try {
    const proc = spawn(['gh', 'pr', 'merge', url, '--squash', '--match-head-commit', head], {
      cwd: homedir(),
      env: buildGitHubLookupEnv(),
      stdout: 'ignore',
      stderr: 'pipe',
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill('SIGKILL');
      } catch {}
    }, DEFAULT_GH_LOOKUP_TIMEOUT_MS);
    try {
      const [stderr, code] = await Promise.all([
        collectWithMaxBuffer(proc.stderr, 16 * 1024),
        proc.exited,
      ]);
      return timedOut
        ? 'gh pr merge timed out'
        : code === 0
          ? null
          : stderr.text.trim() || `gh pr merge exited with code ${code}`;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
