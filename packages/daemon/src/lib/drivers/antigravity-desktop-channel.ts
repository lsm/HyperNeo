import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Result } from './types.ts';
import { reject } from './work-operations.ts';

export const ANTIGRAVITY_DESKTOP_UNAVAILABLE =
  'Open Antigravity Desktop on this machine to control its conversations.';
const SERVICE = 'exa.language_server_pb.LanguageServerService';
const Advertisement = z.object({
  pid: z.number().int().gt(1),
  httpPort: z.number().int().min(1024).max(65535),
  csrfToken: z.string().regex(/^[\w-]{16,256}$/),
});
type Endpoint = z.infer<typeof Advertisement>;

function readPrivateFile(path: string): string | null {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) return null;
    const bytes = Buffer.alloc(4097);
    const size = readSync(fd, bytes);
    return size < bytes.length ? bytes.toString('utf8', 0, size) : null;
  } finally {
    closeSync(fd);
  }
}

function ownsListener(port: number, pid: number) {
  const lsof = process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof';
  try {
    const owners = execFileSync(
      lsof,
      ['-nP', '-a', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-Fp'],
      { encoding: 'utf8', timeout: 500, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const processes = owners.split('\n').filter((line) => line.startsWith('p'));
    return processes.length === 1 && processes[0] === `p${pid}`;
  } catch {
    return false;
  }
}

export function readAntigravityDesktopEndpoint(home: string): Endpoint | null {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
  const directory = join(home, '.gemini', 'antigravity', 'daemon');
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return null;
  }
  const live: Endpoint[] = [];
  for (const name of names) {
    const port = /^hub_(\d+)\.json$/.exec(name)?.[1];
    if (!port) continue;
    try {
      const text = readPrivateFile(join(directory, name));
      const parsed = text === null ? undefined : Advertisement.safeParse(JSON.parse(text)).data;
      if (parsed?.httpPort === Number(port) && ownsListener(parsed.httpPort, parsed.pid))
        live.push(parsed);
    } catch {}
  }
  return live.length === 1 ? live[0] : null;
}

export function antigravityDesktopControlAvailable(home: string) {
  return readAntigravityDesktopEndpoint(home) !== null;
}

export async function callAntigravityDesktop<Value>(
  endpoint: Endpoint,
  method: string,
  body: Record<string, unknown>,
  schema: z.ZodType<Value>,
  timeoutMs = 10_000
): Promise<Result<Value>> {
  if (!ownsListener(endpoint.httpPort, endpoint.pid))
    return reject('unreachable', ANTIGRAVITY_DESKTOP_UNAVAILABLE, true);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${endpoint.httpPort}/${SERVICE}/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        'x-codeium-csrf-token': endpoint.csrfToken,
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return reject('unreachable', `Antigravity Desktop did not answer ${method}.`);
  }
  const reply = await response.json().catch(() => undefined);
  if (response.status === 404)
    return reject('not_found', 'Antigravity Desktop conversation not found.', true);
  if (!response.ok)
    return reject('unreachable', `Antigravity Desktop rejected ${method} (${response.status}).`);
  const parsed = schema.safeParse(reply);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : reject('unreachable', `Antigravity Desktop returned an unexpected ${method} reply.`);
}
