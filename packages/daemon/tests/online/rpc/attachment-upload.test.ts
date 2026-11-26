import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

test('paired attachment uploads validate streamed bytes, publish atomically and expire', async () => {
  const root = fileURLToPath(new URL('../../../../..', import.meta.url));
  const scratch = await mkdtemp(join(tmpdir(), 'attachment-upload-test-'));
  const evidence = join(scratch, 'evidence');
  const run = promisify(execFile);
  try {
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: root });
    await run(
      'bash',
      [
        '.claude/skills/verify/proof-run.sh',
        evidence,
        '.claude/skills/verify/attachment-upload.ts',
        stdout.trim(),
      ],
      { cwd: root, env: { PATH: process.env.PATH, TMPDIR: tmpdir() }, timeout: 50_000 }
    ).catch(async (error: unknown) => {
      const log = await readFile(join(evidence, 'proof.log'), 'utf8').catch(() => '');
      throw new Error(`Attachment upload proof failed:\n${log}`, { cause: error });
    });
    const proof = JSON.parse(await readFile(join(evidence, 'attachment-upload.json'), 'utf8'));
    expect(proof.passed).toBe(true);
    process.stdout.write(`Attachment upload proof: ${JSON.stringify(proof)}\n`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
