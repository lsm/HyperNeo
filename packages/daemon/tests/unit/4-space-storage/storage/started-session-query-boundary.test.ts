import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repositories = resolve(import.meta.dir, '../../../../src/storage/repositories');

test('release and reviewed ownership queries use the started-session table boundary', () => {
  const read = (file: string) => readFileSync(resolve(repositories, file), 'utf8');
  const ask = read('neo-ask-input-worker.ts');
  const start = ask.indexOf('export function releaseReuseFacts');
  const end = ask.indexOf('export type SessionReuseFacts');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const release = ask.slice(start, end);
  expect(release).not.toContain('work_started_sessions');
  expect(read('worker-ownership-read-worker.ts')).not.toContain('work_started_sessions');
  expect(read('worker-ownership-write-worker.ts')).not.toContain('work_started_sessions');
});
