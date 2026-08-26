import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  MAX_WORKSPACES_PER_SPACE,
  nodeWorkspaceValidationIo,
  validateWorkspaceRegistration,
  type WorkspaceRegistryClaim,
  type WorkspaceRegistrySnapshot,
  type WorkspaceValidationIo,
  type WorkspaceValidationVerdict,
} from '../../../../src/lib/space/workspaces/workspace-validation-pipeline';

const SPACE_A = 'space-a';
const SPACE_B = 'space-b';

function fakeIo(overrides: Partial<WorkspaceValidationIo> = {}): WorkspaceValidationIo {
  return {
    realpath: async (path) => path,
    isDirectory: async () => true,
    isGitRepositoryRoot: async () => true,
    ...overrides,
  };
}

function primaryClaim(spaceId: string, path: string): WorkspaceRegistryClaim {
  return { spaceId, path, source: 'space_primary_path' };
}

function registeredClaim(spaceId: string, path: string): WorkspaceRegistryClaim {
  return { spaceId, path, source: 'registered_workspace' };
}

function snapshot(
  claims: WorkspaceRegistryClaim[],
  workspaceCountForSpace = 0
): WorkspaceRegistrySnapshot {
  return { claims, workspaceCountForSpace };
}

async function validate(options: {
  io?: WorkspaceValidationIo;
  snap?: WorkspaceRegistrySnapshot;
  rawPath?: string;
  spaceId?: string;
}): Promise<WorkspaceValidationVerdict> {
  return validateWorkspaceRegistration(options.io ?? fakeIo(), options.snap ?? snapshot([]), {
    spaceId: options.spaceId ?? SPACE_A,
    rawPath: options.rawPath ?? '/repo',
  });
}

describe('workspace-validation-pipeline', () => {
  describe('realpath gate', () => {
    test('rejects a path that cannot be resolved', async () => {
      const verdict = await validate({
        io: fakeIo({
          realpath: async () => {
            throw new Error('ENOENT');
          },
        }),
        rawPath: '/gone',
      });
      expect(verdict.accepted).toBe(false);
      if (verdict.accepted) return;
      expect(verdict.reason).toBe('path_not_found');
      expect(verdict.canonicalPath).toBeNull();
      expect(verdict.message).toContain('/gone');
    });

    test('later gates compare against the canonicalized path', async () => {
      const verdict = await validate({
        io: fakeIo({ realpath: async () => '/real/repo' }),
        snap: snapshot([primaryClaim(SPACE_B, '/real/repo')]),
        rawPath: '/link/repo',
      });
      expect(verdict.accepted).toBe(false);
      if (verdict.accepted) return;
      expect(verdict.reason).toBe('path_claimed_by_another_space');
      expect(verdict.conflictPath).toBe('/real/repo');
    });

    test('rejects a resolved path that is not an accessible directory', async () => {
      const verdict = await validate({
        io: fakeIo({ isDirectory: async () => false }),
      });
      expect(verdict.accepted).toBe(false);
      if (verdict.accepted) return;
      expect(verdict.reason).toBe('path_not_a_directory');
      expect(verdict.canonicalPath).toBe('/repo');
    });
  });

  describe('git repository root gate', () => {
    test('hard-fails when the path is not a git repository root', async () => {
      const verdict = await validate({
        io: fakeIo({ isGitRepositoryRoot: async () => false }),
      });
      expect(verdict.accepted).toBe(false);
      if (verdict.accepted) return;
      expect(verdict.reason).toBe('not_a_git_repository_root');
      expect(verdict.message).toContain('/repo');
    });

    test('runs before registry gates', async () => {
      const verdict = await validate({
        io: fakeIo({
          isGitRepositoryRoot: async () => false,
        }),
        snap: snapshot([primaryClaim(SPACE_B, '/repo')], MAX_WORKSPACES_PER_SPACE),
      });
      expect(verdict.accepted).toBe(false);
      if (verdict.accepted) return;
      expect(verdict.reason).toBe('not_a_git_repository_root');
    });
  });

  describe('cross-space exclusivity gate', () => {
    test('rejects a path claimed as another space primary', async () => {
      const verdict = await validate({
        snap: snapshot([primaryClaim(SPACE_B, '/repo')]),
      });
      expect(verdict.accepted).toBe(false);
      if (verdict.accepted) return;
      expect(verdict.reason).toBe('path_claimed_by_another_space');
      expect(verdict.conflictSpaceId).toBe(SPACE_B);
      expect(verdict.conflictPath).toBe('/repo');
    });

    test('rejects a path claimed as another space secondary workspace', async () => {
      const verdict = await validate({
        snap: snapshot([registeredClaim(SPACE_B, '/repo')]),
      });
      expect(verdict.accepted).toBe(false);
      if (verdict.accepted) return;
      expect(verdict.reason).toBe('path_claimed_by_another_space');
      expect(verdict.conflictSpaceId).toBe(SPACE_B);
    });

    test('rejects when only an archived-style claim holds the path', async () => {
      const verdict = await validate({
        snap: snapshot([primaryClaim('archived-space', '/repo')]),
      });
      expect(verdict.accepted).toBe(false);
      if (verdict.accepted) return;
      expect(verdict.reason).toBe('path_claimed_by_another_space');
      expect(verdict.conflictSpaceId).toBe('archived-space');
    });

    test('reports a duplicate instead of a foreign claim when this space already holds the row', async () => {
      const verdict = await validate({
        snap: snapshot([registeredClaim(SPACE_A, '/repo')]),
      });
      expect(verdict.accepted).toBe(false);
      if (verdict.accepted) return;
      expect(verdict.reason).toBe('duplicate_of_registered_workspace');
      expect(verdict.conflictSpaceId).toBe(SPACE_A);
    });

    test('reports a duplicate when re-registering the space primary path', async () => {
      const verdict = await validate({
        snap: snapshot([primaryClaim(SPACE_A, '/repo')]),
      });
      expect(verdict.accepted).toBe(false);
      if (verdict.accepted) return;
      expect(verdict.reason).toBe('duplicate_of_registered_workspace');
    });

    test('prefers the foreign claim when both a foreign and an own claim exist', async () => {
      const verdict = await validate({
        snap: snapshot([registeredClaim(SPACE_A, '/repo'), primaryClaim(SPACE_B, '/repo')]),
      });
      expect(verdict.accepted).toBe(false);
      if (verdict.accepted) return;
      expect(verdict.reason).toBe('path_claimed_by_another_space');
      expect(verdict.conflictSpaceId).toBe(SPACE_B);
    });
  });

  describe('nesting ambiguity gate', () => {
    test('rejects a candidate inside a same-space workspace', async () => {
      const verdict = await validate({
        snap: snapshot([registeredClaim(SPACE_A, '/work')]),
        rawPath: '/work/sub-repo',
      });
      expect(verdict.accepted).toBe(false);
      if (verdict.accepted) return;
      expect(verdict.reason).toBe('ambiguous_nesting');
      expect(verdict.nestingDirection).toBe('candidate_inside_existing');
      expect(verdict.conflictPath).toBe('/work');
    });

    test('rejects a candidate containing a same-space workspace', async () => {
      const verdict = await validate({
        snap: snapshot([registeredClaim(SPACE_A, '/work/sub-repo')]),
        rawPath: '/work',
      });
      expect(verdict.accepted).toBe(false);
      if (verdict.accepted) return;
      expect(verdict.reason).toBe('ambiguous_nesting');
      expect(verdict.nestingDirection).toBe('existing_inside_candidate');
      expect(verdict.conflictPath).toBe('/work/sub-repo');
    });

    test('applies the same rule to the space primary path', async () => {
      const verdict = await validate({
        snap: snapshot([primaryClaim(SPACE_A, '/work')]),
        rawPath: '/work/sub-repo',
      });
      expect(verdict.accepted).toBe(false);
      if (verdict.accepted) return;
      expect(verdict.reason).toBe('ambiguous_nesting');
      expect(verdict.nestingDirection).toBe('candidate_inside_existing');
    });

    test('does not treat a shared path prefix as nesting', async () => {
      const verdict = await validate({
        snap: snapshot([registeredClaim(SPACE_A, '/repo')]),
        rawPath: '/repository',
      });
      expect(verdict.accepted).toBe(true);
      if (!verdict.accepted) return;
      expect(verdict.canonicalPath).toBe('/repository');
    });

    test('allows nesting across different spaces', async () => {
      const verdict = await validate({
        snap: snapshot([registeredClaim(SPACE_B, '/work')]),
        rawPath: '/work/sub-repo',
      });
      expect(verdict.accepted).toBe(true);
      if (!verdict.accepted) return;
      expect(verdict.canonicalPath).toBe('/work/sub-repo');
    });
  });

  describe('per-space cap gate', () => {
    test('accepts at one below the cap', async () => {
      const verdict = await validate({
        snap: snapshot([], MAX_WORKSPACES_PER_SPACE - 1),
      });
      expect(verdict.accepted).toBe(true);
    });

    test('rejects at the cap and reports the limit', async () => {
      const verdict = await validate({
        snap: snapshot([], MAX_WORKSPACES_PER_SPACE),
      });
      expect(verdict.accepted).toBe(false);
      if (verdict.accepted) return;
      expect(verdict.reason).toBe('workspace_cap_reached');
      expect(verdict.limit).toBe(MAX_WORKSPACES_PER_SPACE);
    });
  });

  describe('pipeline outcome', () => {
    test('accepts with the canonical path when every gate passes', async () => {
      const verdict = await validate({
        io: fakeIo({ realpath: async () => '/canonical/repo' }),
        rawPath: '/raw/repo',
      });
      expect(verdict).toEqual({ accepted: true, canonicalPath: '/canonical/repo' });
    });

    test('rejects an empty raw path as not found', async () => {
      const verdict = await validate({ rawPath: '' });
      expect(verdict.accepted).toBe(false);
      if (verdict.accepted) return;
      expect(verdict.reason).toBe('path_not_found');
    });
  });

  describe('nodeWorkspaceValidationIo against a real filesystem', () => {
    let root: string;

    beforeAll(async () => {
      root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'ws-validation-')));
      await fs.mkdir(join(root, 'plain-dir'));
      await fs.writeFile(join(root, 'a-file'), 'x');
      execSync('git init -q', { cwd: root });
      await fs.mkdir(join(root, 'repo-inner-dir'));
      execSync('git init -q', { cwd: join(root, 'sibling-repo') });
      await fs.symlink(join(root, 'sibling-repo'), join(root, 'repo-link'));
    });

    afterAll(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });

    function ioPath(name: string): string {
      return join(root, name);
    }

    test('reports a missing path', async () => {
      const verdict = await validate({
        io: nodeWorkspaceValidationIo,
        rawPath: join(root, 'does-not-exist'),
      });
      expect(verdict.accepted).toBe(false);
      if (verdict.accepted) return;
      expect(verdict.reason).toBe('path_not_found');
    });

    test('reports a regular file as not a directory', async () => {
      const verdict = await validate({
        io: nodeWorkspaceValidationIo,
        rawPath: ioPath('a-file'),
      });
      expect(verdict.accepted).toBe(false);
      if (verdict.accepted) return;
      expect(verdict.reason).toBe('path_not_a_directory');
    });

    test('reports a plain directory as not a git repository root', async () => {
      const verdict = await validate({
        io: nodeWorkspaceValidationIo,
        rawPath: ioPath('plain-dir'),
      });
      expect(verdict.accepted).toBe(false);
      if (verdict.accepted) return;
      expect(verdict.reason).toBe('not_a_git_repository_root');
    });

    test('accepts a git repository root', async () => {
      const verdict = await validate({
        io: nodeWorkspaceValidationIo,
        rawPath: root,
      });
      expect(verdict).toEqual({ accepted: true, canonicalPath: root });
    });

    test('rejects a subdirectory inside a git repository', async () => {
      const verdict = await validate({
        io: nodeWorkspaceValidationIo,
        rawPath: ioPath('repo-inner-dir'),
      });
      expect(verdict.accepted).toBe(false);
      if (verdict.accepted) return;
      expect(verdict.reason).toBe('not_a_git_repository_root');
    });

    test('resolves a symlinked repository to its canonical root', async () => {
      const verdict = await validate({
        io: nodeWorkspaceValidationIo,
        rawPath: ioPath('repo-link'),
      });
      expect(verdict).toEqual({ accepted: true, canonicalPath: ioPath('sibling-repo') });
    });

    test('rejects a bare repository', async () => {
      const bare = join(root, 'bare-repo.git');
      execSync('git init -q --bare bare-repo.git', { cwd: root });
      const verdict = await validate({
        io: nodeWorkspaceValidationIo,
        rawPath: bare,
      });
      expect(verdict.accepted).toBe(false);
      if (verdict.accepted) return;
      expect(verdict.reason).toBe('not_a_git_repository_root');
    });
  });
});
