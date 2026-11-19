import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repositories = resolve(import.meta.dir, '../../../../src/storage/repositories');

test('release and reviewed ownership queries use the started-session table boundary', () => {
  const read = (file: string) => readFileSync(resolve(repositories, file), 'utf8');
  const ask = read('neo-ask-input-worker.ts');
  const release = ask.slice(
    ask.indexOf('export function releaseReuseFacts'),
    ask.indexOf('export type SessionReuseFacts')
  );
  expect(release).not.toContain('work_started_sessions');
  expect(read('worker-ownership-read-worker.ts')).not.toContain('work_started_sessions');
  expect(read('worker-ownership-write-worker.ts')).not.toContain('work_started_sessions');
});
