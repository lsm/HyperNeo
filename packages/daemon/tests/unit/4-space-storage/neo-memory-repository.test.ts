import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../src/storage/sqlite-compat.ts';
import { gatewayFor } from '../../../src/storage/db-gateway/db-gateway.ts';
import { runMigration542 } from '../../../src/storage/schema/m542-neo-memories.ts';
import { runMigration543 } from '../../../src/storage/schema/m543-neo-memory-vectors.ts';
import { NeoMemoryRepository } from '../../../src/storage/repositories/neo-memory-repository.ts';

describe('NeoMemoryRepository', () => {
  let repo: NeoMemoryRepository;
  beforeEach(async () => {
    const db = new Database(':memory:');
    runMigration542(db);
    runMigration543(db);
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

  test('reads both ends of a huge pasted message', async () => {
    const blob = 'a1'.repeat(50_000);
    const words = Array.from({ length: 200 }, (_, i) => `line${i}`).join(' ');
    for (const message of [
      `daemon tests ${blob}`,
      `${blob} daemon tests`,
      `${words} where do daemon tests go`,
    ])
      expect((await repo.search(message, 3)).map((m) => m.key)).toEqual(['ci-runs-tests']);
    expect(await repo.search(`${blob} daemon tests ${blob}`, 3)).toEqual([]);
  });

  test('finds an English memory from a Chinese query and nothing for an unrelated one', async () => {
    const concepts = [/daemon tests|测试/, /pull request|合并/, /时间|Eastern/];
    const embed = (text: string) => {
      const hit = concepts.findIndex((concept) => concept.test(text));
      return Float32Array.from([0, 1, 2, 3], (dim) => (dim === (hit < 0 ? 3 : hit) ? 1 : 0.1));
    };
    const db = new Database(':memory:');
    runMigration542(db);
    runMigration543(db);
    const vectors = new NeoMemoryRepository(gatewayFor(db), {
      model: 'concepts',
      dimensions: 4,
      embedQuery: embed,
      embedPassage: embed,
    });
    await vectors.save({ key: 'ci-runs-tests', content: 'Let CI run the daemon tests.' });
    await vectors.save({ key: 'pr-size', content: 'Keep each pull request small.' });
    expect((await vectors.search('测试应该在哪里跑', 3)).map((m) => m.key)).toEqual([
      'ci-runs-tests',
    ]);
    expect(await vectors.search('今天天气怎么样', 3)).toEqual([]);
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
