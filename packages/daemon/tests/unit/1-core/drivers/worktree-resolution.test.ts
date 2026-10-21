import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { delayedWorktree, syntheticCodex } from '../../../helpers/worktree-delay.ts';

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe('Codex discovery with delayed worktree storage', () => {
  test('keeps the event loop responsive while resolving the actual .git pointer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'worktree-delay-'));
    const fixture = delayedWorktree(root);
    const adapter = syntheticCodex(root, fixture.folder, fixture.project);
    let previous = performance.now(),
      maxLagMs = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxLagMs = Math.max(maxLagMs, now - previous - 10);
      previous = now;
    }, 10);
    try {
      await fixture.ready;
      await wait(30);
      const groups = await adapter.find({ includeClosed: false, limit: 20 });
      await wait(20);
      expect(await fixture.closed).toBe(0);
      expect(groups).toHaveLength(1);
      expect(groups[0].place.folder).toBe(fixture.project);
      expect(groups[0].work[0].ref.id).toBe('thread');
      expect(groups[0].work[0].place.folder).toBe(fixture.folder);
      expect(maxLagMs).toBeLessThan(250);
    } finally {
      clearInterval(timer);
      fixture.writer.kill();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);
});
