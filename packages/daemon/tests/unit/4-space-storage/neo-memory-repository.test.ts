import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../src/storage/sqlite-compat.ts';
import { gatewayFor } from '../../../src/storage/db-gateway/db-gateway.ts';
import { runMigration542 } from '../../../src/storage/schema/m542-neo-memories.ts';
import { NeoMemoryRepository } from '../../../src/storage/repositories/neo-memory-repository.ts';

describe('NeoMemoryRepository', () => {
  let repo: NeoMemoryRepository;
  beforeEach(async () => {
    const db = new Database(':memory:');
    runMigration542(db);
    repo = new NeoMemoryRepository(gatewayFor(db));
    await repo.save({
      key: 'ci-runs-tests',
      content: 'Let CI run the daemon tests, not the laptop.',
    });
    await repo.save({
      key: 'pr-size',
      content: 'Keep each pull request near 300 production lines.',
    });
    await repo.save({ key: '时间', content: '告诉用户的时间一律用美国东部时间。' });
  });

  test('matches any term and segments Chinese trigrams', async () => {
    expect((await repo.search('where should the daemon tests run', 3)).map((m) => m.key)).toEqual([
      'ci-runs-tests',
    ]);
    expect(
      (await repo.search('pull request size or reviewer turnaround', 3)).map((m) => m.key)
    ).toEqual(['pr-size']);
    expect((await repo.search('提醒我会议用美国东部时间', 3)).map((m) => m.key)).toEqual(['时间']);
    expect(await repo.search('what is the weather', 3)).toEqual([]);
  });

  test('searches only the start of a huge pasted blob', async () => {
    const blob = 'a1'.repeat(50_000);
    expect((await repo.search(`daemon tests ${blob}`, 3)).map((m) => m.key)).toEqual([
      'ci-runs-tests',
    ]);
    expect(await repo.search(`${blob} daemon tests`, 3)).toEqual([]);
  });

  test('finds a memory from a sentence that ends with a period', async () => {
    await repo.save({ key: 'tz', content: 'Timezone: US Eastern for every time told.' });
    expect((await repo.search('Please use my timezone.', 3)).map((m) => m.key)).toEqual(['tz']);
  });

  test('still finds a memory from a long pasted message', async () => {
    const paste = Array.from({ length: 5000 }, (_, i) => `line${i}`).join(' ');
    expect((await repo.search(`daemon tests ${paste}`, 3)).map((m) => m.key)).toEqual([
      'ci-runs-tests',
    ]);
  });

  test('saves, updates, reads and deletes by key', async () => {
    await repo.save({
      key: 'pr-size',
      content: 'Keep each pull request near 200 production lines.',
    });
    expect((await repo.read('pr-size'))?.content).toBe(
      'Keep each pull request near 200 production lines.'
    );
    expect(await repo.search('300', 3)).toEqual([]);
    expect(await repo.delete('pr-size')).toBe(true);
    expect(await repo.read('pr-size')).toBeNull();
    expect(await repo.search('pull request', 3)).toEqual([]);
  });
});
