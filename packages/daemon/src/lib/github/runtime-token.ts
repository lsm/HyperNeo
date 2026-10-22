import superpipe, { type PipelineAPI } from 'superpipe';
import { spawnProcess, type SpawnFn } from '../runtime-spawn/index.ts';
import { collectWithMaxBuffer } from '../utils/script-utils.ts';
import { buildGitHubLookupEnv, DEFAULT_GH_LOOKUP_TIMEOUT_MS } from './gh-lookup-helpers.ts';

async function readCliToken(spawn: SpawnFn = spawnProcess): Promise<string | null> {
  let proc;
  try {
    const env = buildGitHubLookupEnv();
    proc = spawn(['gh', 'auth', 'token', '--hostname', env.GH_HOST || 'github.com'], {
      env: { ...env, GH_PROMPT_DISABLED: '1' },
      stdout: 'pipe',
      stderr: 'ignore',
    });
  } catch {
    return null;
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill('SIGKILL');
    } catch {}
  }, DEFAULT_GH_LOOKUP_TIMEOUT_MS);
  try {
    const [output, exit] = await Promise.all([
      collectWithMaxBuffer(proc.stdout, 16 * 1024),
      proc.exited,
    ]);
    return !timedOut && exit === 0 && !output.truncated ? output.text.trim() || null : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const resolveDaemonGithubToken = (superpipe({})('daemon-github-token') as PipelineAPI)
  .input(['readStored', 'spawn'])
  .pipe(
    async (read: () => Promise<string | null>) => ({
      token:
        (await read().catch(() => null)) ||
        (process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? null),
    }),
    'readStored',
    'result'
  )
  .pipe((result: { token: string | null }) => !!result.token, 'result', 'hasToken')
  .pipe('!hasToken')
  .pipe(async (spawn?: SpawnFn) => ({ token: await readCliToken(spawn) }), 'spawn', 'result')
  .endAsync('result') as (
  readStored: () => Promise<string | null>,
  spawn?: SpawnFn
) => Promise<{ token: string | null }>;

export async function readDaemonGithubToken(
  readStored: () => Promise<string | null>,
  spawn?: SpawnFn
): Promise<string | null> {
  return (await resolveDaemonGithubToken(readStored, spawn)).token;
}
