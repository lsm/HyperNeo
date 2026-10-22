import { homedir } from 'node:os';
import {
  buildGitHubLookupEnv,
  DEFAULT_GH_LOOKUP_TIMEOUT_MS,
  readGhHttpResponse,
} from './gh-lookup-helpers.ts';
import { spawnProcess, type SpawnFn } from '../runtime-spawn/index.ts';
import { collectWithMaxBuffer, MAX_BUFFER_BYTES } from '../utils/script-utils.ts';

const GITHUB_RESPONSE_MAX_BYTES = 16 * 1_048_576;

export async function fetchGitHubViaCli(
  input: string | URL | Request,
  init: RequestInit = {},
  spawn: SpawnFn = spawnProcess
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (
    url.origin !== 'https://api.github.com' ||
    (init.method ?? (input instanceof Request ? input.method : 'GET')) !== 'GET'
  )
    throw new Error('GitHub CLI polling supports GitHub API GET requests only');
  init.signal?.throwIfAborted();
  const args = ['gh', 'api', '--include', '--hostname', 'github.com', '--method', 'GET'];
  const requestHeaders = new Headers(init.headers);
  for (const name of ['Accept', 'If-None-Match', 'X-GitHub-Api-Version', 'User-Agent']) {
    const value = requestHeaders.get(name);
    if (value) args.push('-H', `${name}: ${value}`);
  }
  args.push(`${url.pathname}${url.search}`);
  const env = buildGitHubLookupEnv();
  delete env.GH_REPO;
  env.GH_PROMPT_DISABLED = '1';
  const proc = spawn(args, { cwd: homedir(), env, stdout: 'pipe', stderr: 'pipe' });
  let stopped = false;
  const abort = () => {
    stopped = true;
    try {
      proc.kill('SIGKILL');
    } catch {}
  };
  const timer = setTimeout(abort, DEFAULT_GH_LOOKUP_TIMEOUT_MS);
  init.signal?.addEventListener('abort', abort, { once: true });
  if (init.signal?.aborted) abort();
  try {
    const [out, , code] = await Promise.all([
      collectWithMaxBuffer(proc.stdout, GITHUB_RESPONSE_MAX_BYTES),
      collectWithMaxBuffer(proc.stderr, MAX_BUFFER_BYTES),
      proc.exited,
    ]);
    if (stopped) throw new Error('GitHub CLI polling request interrupted or timed out');
    if (out.truncated) throw new Error('GitHub CLI polling response exceeded the size limit');
    const response = readGhHttpResponse(out.text);
    if (!response)
      throw new Error(
        'GitHub CLI polling unavailable; check gh authentication for the daemon account'
      );
    if (code !== 0 && response.status < 400 && response.status !== 304)
      throw new Error('GitHub CLI polling failed before a complete response');
    return new Response([204, 205, 304].includes(response.status) ? null : response.body, {
      status: response.status,
      headers: response.headers,
    });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', abort);
  }
}
