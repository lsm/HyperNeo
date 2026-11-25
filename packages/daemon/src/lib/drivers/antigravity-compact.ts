import { z } from 'zod';
import { spawnProcess } from '../runtime-spawn/index.ts';
import { buildSafeProcessEnv } from '../safe-process-env.ts';
import { collectWithMaxBuffer, parseJsonStdout } from '../utils/script-utils.ts';
import type { Result } from './types.ts';
import { reject } from './work-operations.ts';

const Frame = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('step_update'),
    step_update: z.object({
      conversation_id: z.string(),
      step_index: z.number().int().nonnegative(),
      state: z.string(),
      step_type: z.string(),
    }),
  }),
  z.object({
    event: z.literal('result'),
    result: z.object({ conversation_id: z.string(), status: z.string() }),
  }),
]);

function confirmedCheckpoint(output: string, id: string): boolean {
  let input = -1;
  let checkpoint = -1;
  for (const line of output.split('\n')) {
    const frame = Frame.safeParse(parseJsonStdout(line));
    if (!frame.success) continue;
    if (frame.data.event === 'result') {
      const result = frame.data.result;
      return (
        result.conversation_id === id &&
        result.status === 'SUCCESS' &&
        input >= 0 &&
        checkpoint > input
      );
    }
    const step = frame.data.step_update;
    if (step.conversation_id !== id || step.state !== 'DONE') continue;
    if (step.step_type === 'user_input') input = Math.max(input, step.step_index);
    if (step.step_type === 'checkpoint' && input >= 0)
      checkpoint = Math.max(checkpoint, step.step_index);
  }
  return false;
}

async function runCli(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number
): Promise<string | null> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  if (deadline.aborted) return null;
  const child = spawnProcess(args, {
    cwd,
    env: buildSafeProcessEnv(),
    stdout: 'pipe',
    stderr: 'ignore',
    detached: true,
  });
  const kill = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  };
  deadline.addEventListener('abort', kill, { once: true });
  try {
    const [output, exit] = await Promise.all([
      collectWithMaxBuffer(child.stdout, 256 * 1024, deadline),
      child.exited,
    ]);
    return !deadline.aborted && exit === 0 && !output.truncated ? output.text : null;
  } finally {
    deadline.removeEventListener('abort', kill);
    if (child.exitCode === null) {
      kill();
      await child.exited.catch(() => {});
    }
  }
}

export async function compactAntigravity(
  executable: string,
  cwd: string,
  id: string,
  signal: AbortSignal
): Promise<Result<{ compacted: boolean }>> {
  try {
    const version = await runCli([executable, '--version'], cwd, signal, 5_000);
    const match = version?.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return reject('unreachable', 'Antigravity CLI did not report its version.', true);
    const [major, minor, patch] = match.slice(1).map(Number);
    if (major < 1 || (major === 1 && (minor < 2 || (minor === 2 && patch < 15))))
      return reject(
        'not_supported',
        'Antigravity CLI 1.2.15 or later is required to compact.',
        true
      );
    const output = await runCli(
      [
        executable,
        '--sandbox',
        '--conversation',
        id,
        '--settings',
        '{"disableSlashCommands":false}',
        '--print',
        '/compact',
        '--output-format',
        'stream-json',
        '--print-timeout',
        '90s',
      ],
      cwd,
      signal,
      95_000
    );
    if (output && confirmedCheckpoint(output, id)) return { ok: true, value: { compacted: true } };
  } catch {
    if (!signal.aborted)
      return reject('not_delivered', 'Could not run Antigravity CLI compaction.');
  }
  return signal.aborted
    ? reject('unreachable', 'The Antigravity driver is shutting down.')
    : reject('not_delivered', 'Antigravity CLI did not confirm a saved checkpoint.');
}
