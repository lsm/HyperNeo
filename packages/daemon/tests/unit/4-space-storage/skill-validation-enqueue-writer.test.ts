import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { SkillsManager } from '../../../src/lib/skills-manager';
import { Database } from '../../../src/storage/sqlite-compat';
import { createTables } from '../../../src/storage/schema';
import { createSpaceTables } from '../helpers/space-test-db';
import { bindGateway, DbGateway } from '../../../src/storage/db-gateway/db-gateway';
import { JobQueueRepository } from '../../../src/storage/repositories/job-queue-repository';
import { SkillRepository } from '../../../src/storage/repositories/skill-repository';
import { AppMcpServerRepository } from '../../../src/storage/repositories/app-mcp-server-repository';
import { noOpReactiveDb } from '../../helpers/reactive-database';

describe('SkillsManager validation admission writer', () => {
  let db: Database;
  let jobs: JobQueueRepository;
  let repo: SkillRepository;
  let manager: SkillsManager;
  let inline: DbGateway;
  const params = {
    name: 'synthetic-skill',
    displayName: 'Synthetic skill',
    description: 'Synthetic',
    sourceType: 'plugin' as const,
    config: { type: 'plugin' as const, pluginPath: '/synthetic/owned-skill' },
    enabled: false,
    validationStatus: 'pending' as const,
  };
  const pending = () => jobs.listJobs({ queue: 'skill.validate' });

  beforeEach(() => {
    db = new Database(':memory:');
    createTables(db);
    createSpaceTables(db);
    jobs = new JobQueueRepository(db);
    repo = new SkillRepository(db, noOpReactiveDb);
    inline = new DbGateway(':memory:', db);
    bindGateway(db, inline);
    manager = new SkillsManager(
      repo,
      new AppMcpServerRepository(db, noOpReactiveDb),
      { gateway: inline },
      jobs
    );
  });
  afterEach(() => db.close());

  test('create and config updates retain payload/retries while metadata updates do not enqueue', async () => {
    const before = Date.now();
    const skill = await manager.addSkill(params);
    expect(pending()).toHaveLength(1);
    expect(pending()[0].payload).toEqual({ skillId: skill.id });
    expect(pending()[0].maxRetries).toBe(3);
    expect(pending()[0].runAt).toBeGreaterThanOrEqual(before);
    expect(pending()[0].runAt).toBeLessThanOrEqual(Date.now());
    await manager.updateSkill(skill.id, { description: 'Metadata only' });
    expect(pending()).toHaveLength(1);
    await manager.setSkillValidationStatus(skill.id, 'valid');
    const updated = await manager.updateSkill(skill.id, { config: params.config });
    expect(updated.validationStatus).toBe('pending');
    expect(pending()).toHaveLength(2);
    expect(pending().every((job) => job.payload.skillId === skill.id && job.maxRetries === 3)).toBe(
      true
    );
  });

  for (const operation of ['create', 'update']) {
    test(`${operation} waits for admission after the registry write commits`, async () => {
      const existing = operation === 'update' ? await manager.addSkill(params) : null;
      const initialCount = pending().length;
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const requested = new Promise<void>((resolve) => {
        entered = resolve;
      });
      bindGateway(db, {
        call: async (...args) => {
          entered();
          await gate;
          return Reflect.apply(inline.call, inline, args);
        },
      } as DbGateway);
      let settled = false;
      const result = (
        existing
          ? manager.updateSkill(existing.id, { config: params.config })
          : manager.addSkill(params)
      ).then((skill) => {
        settled = true;
        return skill;
      });
      await requested;
      try {
        expect(settled).toBe(false);
        expect(repo.getByName(params.name)).not.toBeNull();
        expect(pending()).toHaveLength(initialCount);
      } finally {
        release();
      }
      const skill = await result;
      expect(pending()).toHaveLength(initialCount + 1);
      expect(pending().every((job) => job.payload.skillId === skill.id)).toBe(true);
    });
  }

  for (const failure of ['unavailable', 'insert', 'receipt', 'lost-after-commit']) {
    test(`${failure} preserves registry-first semantics without replaying admission on main`, async () => {
      if (failure === 'insert')
        db.exec(
          "CREATE TRIGGER reject_skill BEFORE INSERT ON job_queue BEGIN SELECT RAISE(ABORT, 'insert rejected'); END"
        );
      const getJob =
        failure === 'receipt'
          ? spyOn(JobQueueRepository.prototype, 'getJob').mockImplementation(() => {
              throw new Error('receipt unavailable');
            })
          : undefined;
      const enqueue = spyOn(jobs, 'enqueue');
      bindGateway(db, {
        call: async (...args) => {
          if (failure === 'unavailable') throw new Error('writer unavailable');
          const receipt = await Reflect.apply(inline.call, inline, args);
          if (failure === 'lost-after-commit') throw new Error('reply lost');
          return receipt;
        },
      } as DbGateway);
      try {
        await expect(manager.addSkill(params)).rejects.toThrow();
        expect(repo.getByName(params.name)).not.toBeNull();
        expect(enqueue).not.toHaveBeenCalled();
        expect(pending()).toHaveLength(failure === 'lost-after-commit' ? 1 : 0);
      } finally {
        getJob?.mockRestore();
        enqueue.mockRestore();
      }
    });
  }

  test('no-queue mode retains successful registry writes', async () => {
    const noQueue = new SkillsManager(repo, new AppMcpServerRepository(db, noOpReactiveDb), {
      gateway: inline,
    });
    const skill = await noQueue.addSkill(params);
    await noQueue.updateSkill(skill.id, { config: params.config });
    expect(pending()).toEqual([]);
    expect(repo.get(skill.id)?.validationStatus).toBe('pending');
  });
});
