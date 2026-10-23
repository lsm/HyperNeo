import type { RemoteDaemonRegistry } from '../remote-daemons/registry.ts';
export type NeoDaemonCommit = { daemon: string; commit: string | null };

const GIT_SHA = /^[0-9a-f]{40}$/;
const NEO_DAEMON_READ_MS = 5000;

const sha = (value: unknown) => (typeof value === 'string' && GIT_SHA.test(value) ? value : null);

export async function readNeoDaemonCommits(
  local: { name: string; commit: string },
  remotes: Pick<RemoteDaemonRegistry, 'list' | 'request'>
): Promise<NeoDaemonCommit[]> {
  const read = await Promise.all(
    remotes.list().map(async ({ daemonId }) => {
      try {
        const snapshot = (await remotes.request(
          daemonId,
          'state.global.snapshot',
          { includeSessions: false },
          { timeoutMs: NEO_DAEMON_READ_MS }
        )) as { system?: { commit?: unknown } } | null;
        return { daemon: daemonId, commit: sha(snapshot?.system?.commit) };
      } catch {
        return { daemon: daemonId, commit: null };
      }
    })
  );
  return [{ daemon: local.name, commit: sha(local.commit) }, ...read];
}
