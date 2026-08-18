import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { GitHubMappingRepository } from '../../../../src/storage/repositories/github-mapping-repository';
import type { CreateRoomGitHubMappingParams, RepositoryMapping } from '@hyperneo/shared';

function createRepositoryMapping(overrides: Partial<RepositoryMapping> = {}): RepositoryMapping {
  return {
    owner: 'testowner',
    repo: 'test-repo',
    ...overrides,
  };
}

function createMappingParams(
  overrides: Partial<CreateRoomGitHubMappingParams> = {}
): CreateRoomGitHubMappingParams {
  return {
    roomId: 'room-123',
    repositories: [createRepositoryMapping()],
    ...overrides,
  };
}

function createMappingTable(db: Database): void {
  db.exec(`
    CREATE TABLE room_github_mappings (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL UNIQUE,
      repositories TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

describe('GitHubMappingRepository', () => {
  let db: Database;
  let repository: GitHubMappingRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createMappingTable(db);
    repository = new GitHubMappingRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('createMapping', () => {
    it('should create a mapping with required fields', () => {
      const params = createMappingParams();
      const mapping = repository.createMapping(params);

      expect(mapping.id).toMatch(/^[\da-f-]{36}$/);
      expect(mapping.roomId).toBe('room-123');
      expect(mapping.repositories).toHaveLength(1);
      expect(mapping.repositories[0]?.owner).toBe('testowner');
      expect(mapping.repositories[0]?.repo).toBe('test-repo');
      expect(mapping.priority).toBe(0);
      expect(mapping.createdAt).toBeGreaterThan(0);
      expect(mapping.updatedAt).toBeGreaterThan(0);
    });

    it('should create a mapping with custom priority', () => {
      const params = createMappingParams({ priority: 10 });
      const mapping = repository.createMapping(params);

      expect(mapping.priority).toBe(10);
    });

    it('should create a mapping with multiple repositories', () => {
      const params = createMappingParams({
        repositories: [
          createRepositoryMapping({ owner: 'owner1', repo: 'repo1' }),
          createRepositoryMapping({ owner: 'owner2', repo: 'repo2' }),
        ],
      });
      const mapping = repository.createMapping(params);

      expect(mapping.repositories).toHaveLength(2);
      expect(mapping.repositories[0]?.owner).toBe('owner1');
      expect(mapping.repositories[1]?.owner).toBe('owner2');
    });

    it('should serialize repository labels and issueNumbers', () => {
      const params = createMappingParams({
        repositories: [
          createRepositoryMapping({
            labels: ['bug', 'priority'],
            issueNumbers: [1, 2, 3],
          }),
        ],
      });
      const mapping = repository.createMapping(params);

      expect(mapping.repositories[0]?.labels).toEqual(['bug', 'priority']);
      expect(mapping.repositories[0]?.issueNumbers).toEqual([1, 2, 3]);
    });
  });

  describe('getMapping', () => {
    it('should retrieve a mapping by ID', () => {
      const created = repository.createMapping(createMappingParams());
      const retrieved = repository.getMapping(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.roomId).toBe('room-123');
    });

    it('should return null for non-existent ID', () => {
      const retrieved = repository.getMapping('non-existent');
      expect(retrieved).toBeNull();
    });
  });

  describe('getMappingByRoomId', () => {
    it('should retrieve a mapping by room ID', () => {
      repository.createMapping(createMappingParams({ roomId: 'room-456' }));
      const retrieved = repository.getMappingByRoomId('room-456');

      expect(retrieved).not.toBeNull();
      expect(retrieved?.roomId).toBe('room-456');
    });

    it('should return null for non-existent room ID', () => {
      const retrieved = repository.getMappingByRoomId('non-existent');
      expect(retrieved).toBeNull();
    });
  });

  describe('listMappings', () => {
    it('should return empty array when no mappings exist', () => {
      const mappings = repository.listMappings();
      expect(mappings).toEqual([]);
    });

    it('should list all mappings', () => {
      repository.createMapping(createMappingParams({ roomId: 'room-1' }));
      repository.createMapping(createMappingParams({ roomId: 'room-2' }));

      const mappings = repository.listMappings();

      expect(mappings).toHaveLength(2);
    });

    it('should order by priority DESC', () => {
      repository.createMapping(createMappingParams({ roomId: 'room-1', priority: 5 }));
      repository.createMapping(createMappingParams({ roomId: 'room-2', priority: 10 }));
      repository.createMapping(createMappingParams({ roomId: 'room-3', priority: 2 }));

      const mappings = repository.listMappings();

      expect(mappings[0]?.roomId).toBe('room-2');
      expect(mappings[1]?.roomId).toBe('room-1');
      expect(mappings[2]?.roomId).toBe('room-3');
    });

    it('should order by created_at ASC when priority is equal', async () => {
      repository.createMapping(createMappingParams({ roomId: 'room-1', priority: 5 }));
      await new Promise((r) => setTimeout(r, 10));
      repository.createMapping(createMappingParams({ roomId: 'room-2', priority: 5 }));
      await new Promise((r) => setTimeout(r, 10));
      repository.createMapping(createMappingParams({ roomId: 'room-3', priority: 5 }));

      const mappings = repository.listMappings();

      expect(mappings[0]?.roomId).toBe('room-1');
      expect(mappings[1]?.roomId).toBe('room-2');
      expect(mappings[2]?.roomId).toBe('room-3');
    });
  });

  describe('listMappingsForRepository', () => {
    it('should return mappings that include the repository', () => {
      repository.createMapping(
        createMappingParams({
          roomId: 'room-1',
          repositories: [createRepositoryMapping({ owner: 'owner1', repo: 'repo1' })],
        })
      );
      repository.createMapping(
        createMappingParams({
          roomId: 'room-2',
          repositories: [
            createRepositoryMapping({ owner: 'owner1', repo: 'repo2' }),
            createRepositoryMapping({ owner: 'owner2', repo: 'repo1' }),
          ],
        })
      );

      const mappings = repository.listMappingsForRepository('owner1', 'repo1');

      expect(mappings).toHaveLength(1);
      expect(mappings[0]?.roomId).toBe('room-1');
    });

    it('should return empty array when no mappings match', () => {
      repository.createMapping(
        createMappingParams({
          repositories: [createRepositoryMapping({ owner: 'other', repo: 'other' })],
        })
      );

      const mappings = repository.listMappingsForRepository('owner1', 'repo1');
      expect(mappings).toEqual([]);
    });

    it('should respect priority ordering', () => {
      repository.createMapping(
        createMappingParams({
          roomId: 'room-1',
          priority: 5,
          repositories: [createRepositoryMapping({ owner: 'owner', repo: 'repo' })],
        })
      );
      repository.createMapping(
        createMappingParams({
          roomId: 'room-2',
          priority: 10,
          repositories: [createRepositoryMapping({ owner: 'owner', repo: 'repo' })],
        })
      );

      const mappings = repository.listMappingsForRepository('owner', 'repo');

      expect(mappings[0]?.roomId).toBe('room-2');
      expect(mappings[1]?.roomId).toBe('room-1');
    });
  });

  describe('updateMapping', () => {
    it('should update repositories', () => {
      const mapping = repository.createMapping(createMappingParams());

      const updated = repository.updateMapping(mapping.id, {
        repositories: [createRepositoryMapping({ owner: 'newowner', repo: 'newrepo' })],
      });

      expect(updated?.repositories).toHaveLength(1);
      expect(updated?.repositories[0]?.owner).toBe('newowner');
    });

    it('should update priority', () => {
      const mapping = repository.createMapping(createMappingParams());

      const updated = repository.updateMapping(mapping.id, { priority: 20 });

      expect(updated?.priority).toBe(20);
    });

    it('should update both repositories and priority', () => {
      const mapping = repository.createMapping(createMappingParams());

      const updated = repository.updateMapping(mapping.id, {
        repositories: [createRepositoryMapping({ owner: 'new', repo: 'new' })],
        priority: 15,
      });

      expect(updated?.repositories[0]?.owner).toBe('new');
      expect(updated?.priority).toBe(15);
    });

    it('should update updatedAt timestamp', async () => {
      const mapping = repository.createMapping(createMappingParams());
      const originalUpdatedAt = mapping.updatedAt;

      await new Promise((r) => setTimeout(r, 10));
      const updated = repository.updateMapping(mapping.id, { priority: 5 });

      expect(updated?.updatedAt).toBeGreaterThan(originalUpdatedAt);
    });

    it('should return null for non-existent ID', () => {
      const updated = repository.updateMapping('non-existent', { priority: 5 });
      expect(updated).toBeNull();
    });

    it('should return unchanged mapping when no fields provided', () => {
      const mapping = repository.createMapping(createMappingParams({ priority: 10 }));

      const updated = repository.updateMapping(mapping.id, {});

      expect(updated?.priority).toBe(10);
    });
  });

  describe('deleteMapping', () => {
    it('should delete a mapping by ID', () => {
      const mapping = repository.createMapping(createMappingParams());

      repository.deleteMapping(mapping.id);

      const retrieved = repository.getMapping(mapping.id);
      expect(retrieved).toBeNull();
    });

    it('should not throw for non-existent ID', () => {
      expect(() => repository.deleteMapping('non-existent')).not.toThrow();
    });
  });

  describe('deleteMappingByRoomId', () => {
    it('should delete a mapping by room ID', () => {
      repository.createMapping(createMappingParams({ roomId: 'room-to-delete' }));

      repository.deleteMappingByRoomId('room-to-delete');

      const retrieved = repository.getMappingByRoomId('room-to-delete');
      expect(retrieved).toBeNull();
    });

    it('should not throw for non-existent room ID', () => {
      expect(() => repository.deleteMappingByRoomId('non-existent')).not.toThrow();
    });
  });
});
