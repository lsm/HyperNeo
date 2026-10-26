import { readFileSync } from 'node:fs';
import { replaceFileWithinWorkspace } from '../../src/lib/acp/acp-safe-fs-backend.ts';

const input = JSON.parse(readFileSync(0, 'utf8')) as {
  workspace: string;
  segments: string[];
  data: string | null;
};
try {
  await replaceFileWithinWorkspace(
    input.workspace,
    input.segments,
    input.data === null ? null : Buffer.from(input.data, 'base64')
  );
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error) {
  const failure = error as NodeJS.ErrnoException;
  process.stdout.write(JSON.stringify({ ok: false, message: failure.message, code: failure.code }));
  process.exitCode = 1;
}
