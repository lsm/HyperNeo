import assert from 'node:assert/strict';
import type { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

export async function waitForSdkBodyCopy(db: Database, timeoutMs = 30_000): Promise<void> {
  const complete = db.prepare('SELECT 1 FROM migration_markers WHERE key IN (?,?)');
  const deadline = performance.now() + timeoutMs;
  while (!complete.get('sdk_message_bodies_copy_v1:complete', 'sdk_message_bodies_copy_v1:reversed')) {
    assert(performance.now() < deadline, 'Startup SDK body copy did not settle before reader measurement');
    await new Promise((done) => setTimeout(done, 10));
  }
}
