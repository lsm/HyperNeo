import { homedir } from 'node:os';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { spawnProcess } from '../../../runtime-spawn/index.ts';
import { readWorkspaceIdentity } from '../../../drivers/code-identity.ts';
import type { WorkRef } from '../../../drivers/types.ts';
import type { NeoTodoControls } from '../../todo-operations.ts';
import { neoRepositoryIdentity } from '../../project-mirror.ts';

export async function readCodingTodoWorker(
  ref: WorkRef,
  resolveTarget: NeoTodoControls['resolveTarget']
): ReturnType<NeoTodoControls['resolveTarget']> {
  const resolved = await resolveTarget(ref);
  if ('reason' in resolved) return resolved;
  const workerRemotes =
    !resolved.value.daemon && resolved.place?.folder
      ? (await readWorkspaceIdentity(resolved.place.folder)).remotes
      : resolved.place?.remotes;
  const canonicalRemotes =
    workerRemotes &&
    (await Promise.all(
      workerRemotes.map(async (remote) => {
        const repo = neoRepositoryIdentity(remote)?.match(
          /^repository:github\.com\/([\w.-]+\/[\w.-]+)$/
        )?.[1];
        if (!repo) return remote;
        const result = await runGhJson(
          [
            'gh',
            'api',
            '--hostname',
            'github.com',
            '--method',
            'GET',
            '--cache',
            '24h',
            `repos/${repo}`,
          ],
          homedir(),
          spawnProcess,
          { stripGHRepo: true }
        );
        const fullName = result.ok
          ? (result.data as { full_name?: unknown } | null)?.full_name
          : null;
        return typeof fullName === 'string' && /^[\w.-]+\/[\w.-]+$/.test(fullName)
          ? `https://github.com/${fullName}`
          : remote;
      })
    ));
  return {
    value: resolved.value,
    workerRemotes: canonicalRemotes && [
      ...new Set([...(workerRemotes ?? []), ...canonicalRemotes]),
    ],
  };
}
