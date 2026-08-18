import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../src/storage/sqlite-compat';
import { createTables } from '../../../src/storage/schema';
import { SkillRepository } from '../../../src/storage/repositories/skill-repository';
import { AppMcpServerRepository } from '../../../src/storage/repositories/app-mcp-server-repository';
import {
  SkillsManager,
  resolveSkillRawUrl,
  resolveGitHubApiContentsUrl,
  validateCommandName,
} from '../../../src/lib/skills-manager';
import { noOpReactiveDb } from '../../helpers/reactive-database';
import type { AppSkill } from '@hyperneo/shared';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  createTables(db);
  return db;
}

function makeRepo(db: BunDatabase): SkillRepository {
  return new SkillRepository(db, noOpReactiveDb);
}

function makeMcpRepo(db: BunDatabase): AppMcpServerRepository {
  return new AppMcpServerRepository(db, noOpReactiveDb);
}

function makeManager(db: BunDatabase): { mgr: SkillsManager; mcpRepo: AppMcpServerRepository } {
  const mcpRepo = makeMcpRepo(db);
  const skillRepo = makeRepo(db);
  const mgr = new SkillsManager(skillRepo, mcpRepo);
  return { mgr, mcpRepo };
}

describe('SkillRepository', () => {
  let db: BunDatabase;
  let repo: SkillRepository;

  beforeEach(() => {
    db = makeDb();
    repo = makeRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  test('findAll returns empty array on fresh DB', () => {
    expect(repo.findAll()).toEqual([]);
  });

  test('insert and get round-trip', () => {
    const skill: AppSkill = {
      id: 'skill-1',
      name: 'test-skill',
      displayName: 'Test Skill',
      description: 'A test skill',
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'test-cmd' },
      enabled: true,
      builtIn: false,
      validationStatus: 'pending',
      createdAt: Date.now(),
    };
    repo.insert(skill);

    const found = repo.get('skill-1');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('skill-1');
    expect(found!.name).toBe('test-skill');
    expect(found!.displayName).toBe('Test Skill');
    expect(found!.config).toEqual({ type: 'builtin', commandName: 'test-cmd' });
    expect(found!.enabled).toBe(true);
    expect(found!.builtIn).toBe(false);
    expect(found!.validationStatus).toBe('pending');
  });

  test('get returns null for unknown id', () => {
    expect(repo.get('nonexistent')).toBeNull();
  });

  test('getByName returns skill by name', () => {
    const skill: AppSkill = {
      id: 'gbn-1',
      name: 'by-name',
      displayName: 'By Name',
      description: 'd',
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'cmd' },
      enabled: true,
      builtIn: false,
      validationStatus: 'pending',
      createdAt: 1,
    };
    repo.insert(skill);
    expect(repo.getByName('by-name')).not.toBeNull();
    expect(repo.getByName('nonexistent')).toBeNull();
  });

  test('findAll returns all inserted skills', () => {
    const base = {
      description: 'd',
      sourceType: 'builtin' as const,
      enabled: true,
      builtIn: false,
      validationStatus: 'pending' as const,
      createdAt: 1,
    };
    repo.insert({
      ...base,
      id: 'a',
      name: 'skill-a',
      displayName: 'A',
      config: { type: 'builtin', commandName: 'cmd-a' },
    });
    repo.insert({
      ...base,
      id: 'b',
      name: 'skill-b',
      displayName: 'B',
      config: { type: 'builtin', commandName: 'cmd-b' },
    });

    const all = repo.findAll();
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.id)).toContain('a');
    expect(all.map((s) => s.id)).toContain('b');
  });

  test('findEnabled returns only enabled skills', () => {
    const base = {
      description: 'd',
      sourceType: 'builtin' as const,
      builtIn: false,
      validationStatus: 'pending' as const,
      createdAt: 1,
    };
    repo.insert({
      ...base,
      id: 'e1',
      name: 'enabled-1',
      displayName: 'E1',
      config: { type: 'builtin', commandName: 'c1' },
      enabled: true,
    });
    repo.insert({
      ...base,
      id: 'e2',
      name: 'disabled-1',
      displayName: 'D1',
      config: { type: 'builtin', commandName: 'c2' },
      enabled: false,
    });

    const enabled = repo.findEnabled();
    expect(enabled).toHaveLength(1);
    expect(enabled[0].id).toBe('e1');
  });

  test('update modifies displayName and description', () => {
    const skill: AppSkill = {
      id: 'upd-1',
      name: 'upd',
      displayName: 'Old',
      description: 'Old desc',
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'cmd' },
      enabled: true,
      builtIn: false,
      validationStatus: 'pending',
      createdAt: 1,
    };
    repo.insert(skill);
    repo.update('upd-1', { displayName: 'New Name', description: 'New desc' });

    const found = repo.get('upd-1');
    expect(found!.displayName).toBe('New Name');
    expect(found!.description).toBe('New desc');
  });

  test('setEnabled toggles enabled flag', () => {
    const skill: AppSkill = {
      id: 'tog-1',
      name: 'tog',
      displayName: 'Tog',
      description: 'd',
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'cmd' },
      enabled: true,
      builtIn: false,
      validationStatus: 'pending',
      createdAt: 1,
    };
    repo.insert(skill);
    repo.setEnabled('tog-1', false);
    expect(repo.get('tog-1')!.enabled).toBe(false);
    repo.setEnabled('tog-1', true);
    expect(repo.get('tog-1')!.enabled).toBe(true);
  });

  test('setValidationStatus updates validation_status and returns true', () => {
    const skill: AppSkill = {
      id: 'val-1',
      name: 'val',
      displayName: 'Val',
      description: 'd',
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'cmd' },
      enabled: true,
      builtIn: false,
      validationStatus: 'pending',
      createdAt: 1,
    };
    repo.insert(skill);
    const changed = repo.setValidationStatus('val-1', 'valid');
    expect(changed).toBe(true);
    expect(repo.get('val-1')!.validationStatus).toBe('valid');
  });

  test('setValidationStatus returns false for unknown id', () => {
    expect(repo.setValidationStatus('ghost', 'valid')).toBe(false);
  });

  test('delete removes a skill and returns true', () => {
    const skill: AppSkill = {
      id: 'del-1',
      name: 'del',
      displayName: 'Del',
      description: 'd',
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'cmd' },
      enabled: true,
      builtIn: false,
      validationStatus: 'pending',
      createdAt: 1,
    };
    repo.insert(skill);
    expect(repo.delete('del-1')).toBe(true);
    expect(repo.get('del-1')).toBeNull();
  });

  test('delete returns false for unknown id', () => {
    expect(repo.delete('ghost')).toBe(false);
  });

  test('persistence across load cycles — re-open same DB path', () => {
    const tmpPath = `/tmp/skills-test-${Date.now()}.db`;
    const db1 = new BunDatabase(tmpPath);
    createTables(db1);
    const repo1 = new SkillRepository(db1, noOpReactiveDb);
    repo1.insert({
      id: 'persist-1',
      name: 'persist',
      displayName: 'Persist',
      description: 'd',
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'p-cmd' },
      enabled: true,
      builtIn: false,
      validationStatus: 'valid',
      createdAt: 42,
    });
    db1.close();

    const db2 = new BunDatabase(tmpPath);
    const repo2 = new SkillRepository(db2, noOpReactiveDb);
    const found = repo2.get('persist-1');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('persist');
    expect(found!.validationStatus).toBe('valid');
    db2.close();

    unlinkSync(tmpPath);
  }, 30_000);
});

describe('SkillsManager', () => {
  let db: BunDatabase;
  let mgr: SkillsManager;
  let mcpRepo: AppMcpServerRepository;

  beforeEach(() => {
    db = makeDb();
    ({ mgr, mcpRepo } = makeManager(db));
  });

  afterEach(() => {
    db.close();
  });

  test('addSkill creates a skill with generated id and createdAt', () => {
    const skill = mgr.addSkill({
      name: 'my-skill',
      displayName: 'My Skill',
      description: 'Does something',
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'my-cmd' },
      enabled: true,
      validationStatus: 'pending',
    });

    expect(skill.id).toBeTruthy();
    expect(skill.name).toBe('my-skill');
    expect(skill.builtIn).toBe(false);
    expect(skill.createdAt).toBeGreaterThan(0);
  });

  test('listSkills returns all skills', () => {
    mgr.addSkill({
      name: 's1',
      displayName: 'S1',
      description: 'd',
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'c1' },
      enabled: true,
      validationStatus: 'pending',
    });
    mgr.addSkill({
      name: 's2',
      displayName: 'S2',
      description: 'd',
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'c2' },
      enabled: true,
      validationStatus: 'pending',
    });
    expect(mgr.listSkills()).toHaveLength(2);
  });

  test('getSkill returns null for unknown id', () => {
    expect(mgr.getSkill('unknown')).toBeNull();
  });

  test('updateSkill modifies displayName', () => {
    const skill = mgr.addSkill({
      name: 'upd',
      displayName: 'Old',
      description: 'd',
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'cmd' },
      enabled: true,
      validationStatus: 'pending',
    });
    const updated = mgr.updateSkill(skill.id, { displayName: 'New' });
    expect(updated.displayName).toBe('New');
  });

  test('updateSkill throws for unknown id', () => {
    expect(() => mgr.updateSkill('ghost', { displayName: 'x' })).toThrow('not found');
  });

  test('setSkillEnabled toggles enabled', () => {
    const skill = mgr.addSkill({
      name: 'toggle',
      displayName: 'T',
      description: 'd',
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'cmd' },
      enabled: true,
      validationStatus: 'pending',
    });
    const disabled = mgr.setSkillEnabled(skill.id, false);
    expect(disabled.enabled).toBe(false);
  });

  test('setSkillValidationStatus updates status and returns updated skill', () => {
    const skill = mgr.addSkill({
      name: 'valst',
      displayName: 'V',
      description: 'd',
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'cmd' },
      enabled: true,
      validationStatus: 'pending',
    });
    const updated = mgr.setSkillValidationStatus(skill.id, 'valid');
    expect(updated.validationStatus).toBe('valid');
  });

  test('setSkillValidationStatus throws for unknown id', () => {
    expect(() => mgr.setSkillValidationStatus('ghost', 'valid')).toThrow('not found');
  });

  test('getEnabledSkills filters disabled skills', () => {
    mgr.addSkill({
      name: 'on',
      displayName: 'On',
      description: 'd',
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'c1' },
      enabled: true,
      validationStatus: 'pending',
    });
    const off = mgr.addSkill({
      name: 'off',
      displayName: 'Off',
      description: 'd',
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'c2' },
      enabled: false,
      validationStatus: 'pending',
    });
    const enabled = mgr.getEnabledSkills();
    expect(enabled.map((s) => s.id)).not.toContain(off.id);
    expect(enabled).toHaveLength(1);
  });

  test('addSkill throws a friendly error on duplicate name', () => {
    mgr.addSkill({
      name: 'dupe',
      displayName: 'Dupe',
      description: 'd',
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'cmd' },
      enabled: true,
      validationStatus: 'pending',
    });
    expect(() =>
      mgr.addSkill({
        name: 'dupe',
        displayName: 'Dupe 2',
        description: 'd',
        sourceType: 'builtin',
        config: { type: 'builtin', commandName: 'cmd2' },
        enabled: true,
        validationStatus: 'pending',
      })
    ).toThrow('already exists');
  });

  test('removeSkill returns false for built-in skill', () => {
    const repo = makeRepo(db);
    repo.insert({
      id: 'builtin-1',
      name: 'bi',
      displayName: 'BI',
      description: 'd',
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'cmd' },
      enabled: true,
      builtIn: true,
      validationStatus: 'valid',
      createdAt: Date.now(),
    });
    expect(mgr.removeSkill('builtin-1')).toBe(false);
    expect(mgr.getSkill('builtin-1')).not.toBeNull();
  });

  test('removeSkill returns false for unknown id', () => {
    expect(mgr.removeSkill('ghost')).toBe(false);
  });

  test('removeSkill deletes non-built-in skill', () => {
    const skill = mgr.addSkill({
      name: 'rem',
      displayName: 'R',
      description: 'd',
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'cmd' },
      enabled: true,
      validationStatus: 'pending',
    });
    expect(mgr.removeSkill(skill.id)).toBe(true);
    expect(mgr.getSkill(skill.id)).toBeNull();
  });

  test('addSkill rejects mismatched sourceType and config.type', () => {
    expect(() =>
      mgr.addSkill({
        name: 'mismatch',
        displayName: 'M',
        description: 'd',
        sourceType: 'builtin',
        // @ts-expect-error — intentional mismatch for testing runtime guard
        config: { type: 'plugin', pluginPath: '/some/path' },
        enabled: true,
        validationStatus: 'pending',
      })
    ).toThrow('must match config.type');
  });

  test('addSkill with plugin: valid absolute path passes', () => {
    const skill = mgr.addSkill({
      name: 'plugin-ok',
      displayName: 'P',
      description: 'd',
      sourceType: 'plugin',
      config: { type: 'plugin', pluginPath: '/usr/local/plugins/myplugin' },
      enabled: true,
      validationStatus: 'pending',
    });
    expect(skill.name).toBe('plugin-ok');
  });

  test('addSkill with plugin: empty pluginPath throws', () => {
    expect(() =>
      mgr.addSkill({
        name: 'plugin-empty',
        displayName: 'P',
        description: 'd',
        sourceType: 'plugin',
        config: { type: 'plugin', pluginPath: '' },
        enabled: true,
        validationStatus: 'pending',
      })
    ).toThrow('pluginPath must not be empty');
  });

  test('addSkill with plugin: relative path throws', () => {
    expect(() =>
      mgr.addSkill({
        name: 'plugin-rel',
        displayName: 'P',
        description: 'd',
        sourceType: 'plugin',
        config: { type: 'plugin', pluginPath: 'relative/path' },
        enabled: true,
        validationStatus: 'pending',
      })
    ).toThrow('absolute path');
  });

  test('addSkill with plugin: path traversal with ../ throws', () => {
    expect(() =>
      mgr.addSkill({
        name: 'plugin-traverse',
        displayName: 'P',
        description: 'd',
        sourceType: 'plugin',
        config: { type: 'plugin', pluginPath: '/plugins/../etc/passwd' },
        enabled: true,
        validationStatus: 'pending',
      })
    ).toThrow('traversal');
  });

  test('addSkill with plugin: path traversal at end (/foo/..) throws', () => {
    expect(() =>
      mgr.addSkill({
        name: 'plugin-traverse-end',
        displayName: 'P',
        description: 'd',
        sourceType: 'plugin',
        config: { type: 'plugin', pluginPath: '/plugins/foo/..' },
        enabled: true,
        validationStatus: 'pending',
      })
    ).toThrow('traversal');
  });

  test('addSkill with mcp_server: valid appMcpServerId passes', () => {
    const server = mcpRepo.create({ name: 'test-server', sourceType: 'stdio', command: 'npx' });
    const skill = mgr.addSkill({
      name: 'mcp-ok',
      displayName: 'MCP',
      description: 'd',
      sourceType: 'mcp_server',
      config: { type: 'mcp_server', appMcpServerId: server.id },
      enabled: true,
      validationStatus: 'pending',
    });
    expect(skill.name).toBe('mcp-ok');
  });

  test('addSkill with mcp_server: non-existent appMcpServerId throws', () => {
    expect(() =>
      mgr.addSkill({
        name: 'mcp-bad',
        displayName: 'MCP',
        description: 'd',
        sourceType: 'mcp_server',
        config: { type: 'mcp_server', appMcpServerId: 'does-not-exist' },
        enabled: true,
        validationStatus: 'pending',
      })
    ).toThrow('not found');
  });

  test('addSkill with mcp_server: empty appMcpServerId throws', () => {
    expect(() =>
      mgr.addSkill({
        name: 'mcp-empty',
        displayName: 'MCP',
        description: 'd',
        sourceType: 'mcp_server',
        config: { type: 'mcp_server', appMcpServerId: '' },
        enabled: true,
        validationStatus: 'pending',
      })
    ).toThrow('appMcpServerId must not be empty');
  });

  test('addSkill with builtin: valid commandName passes', () => {
    const skill = mgr.addSkill({
      name: 'bi-ok',
      displayName: 'BI',
      description: 'd',
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'update-config' },
      enabled: true,
      validationStatus: 'pending',
    });
    expect(skill.name).toBe('bi-ok');
  });

  test('addSkill with builtin: empty commandName throws', () => {
    expect(() =>
      mgr.addSkill({
        name: 'bi-empty',
        displayName: 'BI',
        description: 'd',
        sourceType: 'builtin',
        config: { type: 'builtin', commandName: '' },
        enabled: true,
        validationStatus: 'pending',
      })
    ).toThrow('commandName must not be empty');
  });

  test('updateSkill validates new config', () => {
    const skill = mgr.addSkill({
      name: 'upd-val',
      displayName: 'U',
      description: 'd',
      sourceType: 'plugin',
      config: { type: 'plugin', pluginPath: '/good/path' },
      enabled: true,
      validationStatus: 'pending',
    });

    expect(() =>
      mgr.updateSkill(skill.id, { config: { type: 'plugin', pluginPath: 'bad/relative' } })
    ).toThrow('absolute path');
  });

  test('initializeBuiltins registers playwright skill', () => {
    mgr.initializeBuiltins();

    const skill = mgr.listSkills().find((s) => s.name === 'playwright');
    expect(skill).toBeDefined();
    expect(skill!.displayName).toBe('Playwright');
    expect(skill!.sourceType).toBe('builtin');
    expect(skill!.builtIn).toBe(true);
    expect(skill!.enabled).toBe(true);
    expect(skill!.validationStatus).toBe('valid');
  });

  test('initializeBuiltins playwright has correct commandName', () => {
    mgr.initializeBuiltins();

    const skill = mgr.listSkills().find((s) => s.name === 'playwright')!;
    expect(skill.config.type).toBe('builtin');
    if (skill.config.type === 'builtin') {
      expect(skill.config.commandName).toBe('playwright');
    }
  });

  test('initializeBuiltins playwright is included in getEnabledSkills', () => {
    mgr.initializeBuiltins();

    const enabled = mgr.getEnabledSkills();
    expect(enabled.some((s) => s.name === 'playwright')).toBe(true);
  });

  test('initializeBuiltins playwright cannot be deleted (builtIn guard)', () => {
    mgr.initializeBuiltins();

    const skill = mgr.listSkills().find((s) => s.name === 'playwright')!;
    expect(mgr.removeSkill(skill.id)).toBe(false);
    expect(mgr.getSkill(skill.id)).not.toBeNull();
  });

  test('initializeBuiltins playwright is idempotent', () => {
    mgr.initializeBuiltins();
    mgr.initializeBuiltins();

    const skills = mgr.listSkills().filter((s) => s.name === 'playwright');
    expect(skills).toHaveLength(1);
  });

  test('initializeBuiltins registers playwright-interactive skill', () => {
    mgr.initializeBuiltins();

    const skill = mgr.listSkills().find((s) => s.name === 'playwright-interactive');
    expect(skill).toBeDefined();
    expect(skill!.displayName).toBe('Playwright Interactive');
    expect(skill!.sourceType).toBe('builtin');
    expect(skill!.builtIn).toBe(true);
    expect(skill!.enabled).toBe(true);
    expect(skill!.validationStatus).toBe('valid');
  });

  test('initializeBuiltins playwright-interactive has correct commandName', () => {
    mgr.initializeBuiltins();

    const skill = mgr.listSkills().find((s) => s.name === 'playwright-interactive')!;
    expect(skill.config.type).toBe('builtin');
    if (skill.config.type === 'builtin') {
      expect(skill.config.commandName).toBe('playwright-interactive');
    }
  });

  test('initializeBuiltins playwright-interactive is included in getEnabledSkills', () => {
    mgr.initializeBuiltins();

    const enabled = mgr.getEnabledSkills();
    expect(enabled.some((s) => s.name === 'playwright-interactive')).toBe(true);
  });

  test('initializeBuiltins playwright-interactive cannot be deleted (builtIn guard)', () => {
    mgr.initializeBuiltins();

    const skill = mgr.listSkills().find((s) => s.name === 'playwright-interactive')!;
    expect(mgr.removeSkill(skill.id)).toBe(false);
    expect(mgr.getSkill(skill.id)).not.toBeNull();
  });

  test('initializeBuiltins playwright-interactive is idempotent', () => {
    mgr.initializeBuiltins();
    mgr.initializeBuiltins();

    const skills = mgr.listSkills().filter((s) => s.name === 'playwright-interactive');
    expect(skills).toHaveLength(1);
  });

  test('initializeBuiltins registers chrome-devtools-mcp skill', () => {
    mgr.initializeBuiltins();

    const skill = mgr.listSkills().find((s) => s.name === 'chrome-devtools-mcp');
    expect(skill).toBeDefined();
    expect(skill!.displayName).toBe('Chrome DevTools (MCP)');
    expect(skill!.sourceType).toBe('mcp_server');
    expect(skill!.builtIn).toBe(true);
    expect(skill!.enabled).toBe(false);
    expect(skill!.validationStatus).toBe('valid');
  });

  test('initializeBuiltins creates backing app_mcp_servers entry chrome-devtools if absent', () => {
    mgr.initializeBuiltins();

    const server = mcpRepo.getByName('chrome-devtools');
    expect(server).not.toBeNull();
    expect(server!.command).toBe('bunx');
    expect(server!.sourceType).toBe('stdio');
    expect(server!.args).toEqual(['chrome-devtools-mcp@latest', '--isolated']);
  });

  test('initializeBuiltins chrome-devtools-mcp skill config references the app_mcp_servers entry', () => {
    mgr.initializeBuiltins();

    const skill = mgr.listSkills().find((s) => s.name === 'chrome-devtools-mcp')!;
    const server = mcpRepo.getByName('chrome-devtools');
    expect(skill).toBeDefined();
    expect(server).not.toBeNull();

    expect(skill.config.type).toBe('mcp_server');
    if (skill.config.type === 'mcp_server') {
      expect(skill.config.appMcpServerId).toBe(server!.id);
    }
  });

  test('initializeBuiltins chrome-devtools-mcp is disabled by default', () => {
    mgr.initializeBuiltins();

    const skill = mgr.listSkills().find((s) => s.name === 'chrome-devtools-mcp')!;
    expect(skill.enabled).toBe(false);

    const enabled = mgr.getEnabledSkills();
    expect(enabled.some((s) => s.name === 'chrome-devtools-mcp')).toBe(false);
  });

  test('initializeBuiltins chrome-devtools-mcp cannot be deleted (builtIn guard)', () => {
    mgr.initializeBuiltins();

    const skill = mgr.listSkills().find((s) => s.name === 'chrome-devtools-mcp')!;
    expect(mgr.removeSkill(skill.id)).toBe(false);
    expect(mgr.getSkill(skill.id)).not.toBeNull();
  });

  test('initializeBuiltins chrome-devtools-mcp is idempotent', () => {
    mgr.initializeBuiltins();
    mgr.initializeBuiltins();

    const skills = mgr.listSkills().filter((s) => s.name === 'chrome-devtools-mcp');
    expect(skills).toHaveLength(1);
    const servers = mcpRepo.list().filter((s) => s.name === 'chrome-devtools');
    expect(servers).toHaveLength(1);
  });

  test('initializeBuiltins reuses pre-existing chrome-devtools app_mcp_servers entry', () => {
    const seeded = mcpRepo.create({
      name: 'chrome-devtools',
      description: 'Seeded by seed-defaults',
      sourceType: 'stdio',
      command: 'bunx',
      args: ['chrome-devtools-mcp@latest', '--isolated'],
      env: {},
      enabled: false,
    });

    mgr.initializeBuiltins();

    const servers = mcpRepo.list().filter((s) => s.name === 'chrome-devtools');
    expect(servers).toHaveLength(1);

    const skill = mgr.listSkills().find((s) => s.name === 'chrome-devtools-mcp')!;
    expect(skill.config.type).toBe('mcp_server');
    if (skill.config.type === 'mcp_server') {
      expect(skill.config.appMcpServerId).toBe(seeded.id);
    }
  });

  test('initializeBuiltins registers fetch-mcp skill', () => {
    mgr.initializeBuiltins();

    const skill = mgr.listSkills().find((s) => s.name === 'fetch-mcp');
    expect(skill).toBeDefined();
    expect(skill!.displayName).toBe('Fetch MCP');
    expect(skill!.sourceType).toBe('mcp_server');
    expect(skill!.builtIn).toBe(true);
    expect(skill!.enabled).toBe(true);
    expect(skill!.validationStatus).toBe('valid');
  });

  test('initializeBuiltins creates backing app_mcp_servers entry fetch-mcp if absent', () => {
    mgr.initializeBuiltins();

    const server = mcpRepo.getByName('fetch-mcp');
    expect(server).not.toBeNull();
    expect(server!.command).toBe('npx');
    expect(server!.sourceType).toBe('stdio');
    expect(server!.args).toEqual(['-y', '@tokenizin/mcp-npx-fetch']);
  });

  test('initializeBuiltins fetch-mcp skill config references the app_mcp_servers entry', () => {
    mgr.initializeBuiltins();

    const skill = mgr.listSkills().find((s) => s.name === 'fetch-mcp')!;
    const server = mcpRepo.getByName('fetch-mcp');
    expect(skill).toBeDefined();
    expect(server).not.toBeNull();

    expect(skill.config.type).toBe('mcp_server');
    if (skill.config.type === 'mcp_server') {
      expect(skill.config.appMcpServerId).toBe(server!.id);
    }
  });

  test('initializeBuiltins fetch-mcp is enabled by default and included in getEnabledSkills', () => {
    mgr.initializeBuiltins();

    const skill = mgr.listSkills().find((s) => s.name === 'fetch-mcp')!;
    expect(skill.enabled).toBe(true);

    const enabled = mgr.getEnabledSkills();
    expect(enabled.some((s) => s.name === 'fetch-mcp')).toBe(true);
  });

  test('initializeBuiltins fetch-mcp cannot be deleted (builtIn guard)', () => {
    mgr.initializeBuiltins();

    const skill = mgr.listSkills().find((s) => s.name === 'fetch-mcp')!;
    expect(mgr.removeSkill(skill.id)).toBe(false);
    expect(mgr.getSkill(skill.id)).not.toBeNull();
  });

  test('initializeBuiltins fetch-mcp is idempotent', () => {
    mgr.initializeBuiltins();
    mgr.initializeBuiltins();

    const skills = mgr.listSkills().filter((s) => s.name === 'fetch-mcp');
    expect(skills).toHaveLength(1);
    const servers = mcpRepo.list().filter((s) => s.name === 'fetch-mcp');
    expect(servers).toHaveLength(1);
  });

  test('initializeBuiltins reuses pre-existing fetch-mcp app_mcp_servers entry', () => {
    const seeded = mcpRepo.create({
      name: 'fetch-mcp',
      description: 'Seeded by seed-defaults',
      sourceType: 'stdio',
      command: 'npx',
      args: ['-y', '@tokenizin/mcp-npx-fetch'],
      env: {},
      enabled: true,
    });

    mgr.initializeBuiltins();

    const servers = mcpRepo.list().filter((s) => s.name === 'fetch-mcp');
    expect(servers).toHaveLength(1);

    const skill = mgr.listSkills().find((s) => s.name === 'fetch-mcp')!;
    expect(skill.config.type).toBe('mcp_server');
    if (skill.config.type === 'mcp_server') {
      expect(skill.config.appMcpServerId).toBe(seeded.id);
    }
  });

  test('initializeBuiltins registers all five built-in skills total', () => {
    mgr.initializeBuiltins();

    const builtIns = mgr.listSkills().filter((s) => s.builtIn);
    expect(builtIns).toHaveLength(5);
    const names = builtIns.map((s) => s.name);
    expect(names).toContain('fetch-mcp');
    expect(names).toContain('chrome-devtools-mcp');
    expect(names).toContain('playwright');
    expect(names).toContain('playwright-interactive');
    expect(names).toContain('space-coordination');
  });

  test('ensureBuiltinPluginWrappers materialises a wrapper for each builtin-typed skill', async () => {
    const { mkdtemp, rm, readFile, stat } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const tmpRoot = await mkdtemp(join(tmpdir(), 'kai-skills-mgr-wrap-'));
    try {
      const wrappersRoot = join(tmpRoot, 'skill-plugins');
      const skillsRoot = join(tmpRoot, 'skills');

      mgr.initializeBuiltins();
      const result = await mgr.ensureBuiltinPluginWrappers(wrappersRoot, skillsRoot);

      expect(result.size).toBe(3);
      expect(result.has('playwright')).toBe(true);
      expect(result.has('playwright-interactive')).toBe(true);
      expect(result.has('space-coordination')).toBe(true);
      expect(result.has('fetch-mcp')).toBe(false);
      expect(result.has('chrome-devtools-mcp')).toBe(false);
      expect(result.has('chrome-devtools')).toBe(false);

      const manifest = JSON.parse(
        await readFile(join(wrappersRoot, 'playwright', '.claude-plugin', 'plugin.json'), 'utf8')
      );
      expect(manifest.name).toBe('playwright');

      const spaceSkill = await readFile(join(skillsRoot, 'space-coordination', 'SKILL.md'), 'utf8');
      expect(spaceSkill).toContain('Space Coordination (POC)');
      expect(spaceSkill).toContain('create_standalone_task');

      const wst = await stat(wrappersRoot);
      expect(wst.isDirectory()).toBe(true);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('ensureBuiltinPluginWrappers survives bundled asset directory setup failures', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const tmpRoot = await mkdtemp(join(tmpdir(), 'kai-skills-mgr-bad-asset-'));
    try {
      const wrappersRoot = join(tmpRoot, 'skill-plugins');
      const skillsRoot = join(tmpRoot, 'skills');

      mgr.initializeBuiltins();
      await writeFile(skillsRoot, 'not a directory');

      const result = await mgr.ensureBuiltinPluginWrappers(wrappersRoot, skillsRoot);

      expect(result.has('playwright')).toBe(true);
      expect(result.has('playwright-interactive')).toBe(true);
      expect(result.has('space-coordination')).toBe(true);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('ensureBuiltinPluginWrappers is safe when no builtin skills are registered', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const tmpRoot = await mkdtemp(join(tmpdir(), 'kai-skills-mgr-empty-'));
    try {
      const wrappersRoot = join(tmpRoot, 'skill-plugins');
      const skillsRoot = join(tmpRoot, 'skills');
      const result = await mgr.ensureBuiltinPluginWrappers(wrappersRoot, skillsRoot);
      expect(result.size).toBe(0);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('resolveSkillRawUrl', () => {
  test('converts GitHub tree URL to raw SKILL.md URL', () => {
    expect(
      resolveSkillRawUrl('https://github.com/openai/skills/tree/main/skills/.curated/playwright')
    ).toBe(
      'https://raw.githubusercontent.com/openai/skills/main/skills/.curated/playwright/SKILL.md'
    );
  });

  test('passes through raw githubusercontent URLs unchanged', () => {
    const raw =
      'https://raw.githubusercontent.com/openai/skills/main/skills/.curated/playwright/SKILL.md';
    expect(resolveSkillRawUrl(raw)).toBe(raw);
  });

  test('converts GitHub blob URL to raw content URL', () => {
    expect(
      resolveSkillRawUrl(
        'https://github.com/openai/skills/blob/main/skills/.curated/playwright/SKILL.md'
      )
    ).toBe(
      'https://raw.githubusercontent.com/openai/skills/main/skills/.curated/playwright/SKILL.md'
    );
  });

  test('throws for unrecognised URL', () => {
    expect(() => resolveSkillRawUrl('https://gitlab.com/foo/bar')).toThrow(
      'Cannot resolve raw content URL'
    );
  });

  test('handles branch name with dots (e.g. v2.0) in tree URL', () => {
    expect(resolveSkillRawUrl('https://github.com/org/repo/tree/v2.0/path/to/skill')).toBe(
      'https://raw.githubusercontent.com/org/repo/v2.0/path/to/skill/SKILL.md'
    );
  });

  test('throws when tree URL has no path after branch', () => {
    expect(() => resolveSkillRawUrl('https://github.com/org/repo/tree/main')).toThrow(
      'Cannot resolve raw content URL'
    );
  });

  test('throws when blob URL has no path after branch', () => {
    expect(() => resolveSkillRawUrl('https://github.com/org/repo/blob/main')).toThrow(
      'Cannot resolve raw content URL'
    );
  });
});

describe('validateCommandName', () => {
  test('accepts valid command names', () => {
    expect(() => validateCommandName('playwright')).not.toThrow();
    expect(() => validateCommandName('playwright-interactive')).not.toThrow();
    expect(() => validateCommandName('my-skill-v2')).not.toThrow();
    expect(() => validateCommandName('web_search')).not.toThrow();
  });

  test('throws for empty string', () => {
    expect(() => validateCommandName('')).toThrow('must not be empty');
  });

  test('throws for whitespace-only string', () => {
    expect(() => validateCommandName('   ')).toThrow('must not be empty');
  });

  test('throws for path with forward slash (path traversal prevention)', () => {
    expect(() => validateCommandName('../../etc/passwd')).toThrow('path separators');
  });

  test('throws for path with backslash', () => {
    expect(() => validateCommandName('foo\\bar')).toThrow('path separators');
  });

  test('throws for string containing null byte', () => {
    expect(() => validateCommandName('foo\0bar')).toThrow('null bytes');
  });

  test('throws for bare "." name', () => {
    expect(() => validateCommandName('.')).toThrow('"." or ".."');
  });

  test('throws for bare ".." name', () => {
    expect(() => validateCommandName('..')).toThrow('"." or ".."');
  });

  test('throws for name starting with a dot', () => {
    expect(() => validateCommandName('.hidden')).toThrow('must not start with a dot');
  });
});

describe('resolveGitHubApiContentsUrl', () => {
  test('converts a GitHub tree URL to GitHub API contents URL', () => {
    expect(
      resolveGitHubApiContentsUrl(
        'https://github.com/openai/skills/tree/main/skills/.curated/playwright'
      )
    ).toBe(
      'https://api.github.com/repos/openai/skills/contents/skills/.curated/playwright?ref=main'
    );
  });

  test('handles nested paths correctly', () => {
    expect(
      resolveGitHubApiContentsUrl('https://github.com/owner/repo/tree/main/some/deep/path')
    ).toBe('https://api.github.com/repos/owner/repo/contents/some/deep/path?ref=main');
  });

  test('throws for non-github.com URL', () => {
    expect(() => resolveGitHubApiContentsUrl('https://gitlab.com/foo/bar')).toThrow(
      'expected a github.com URL'
    );
  });

  test('throws for github.com URL without /tree/', () => {
    expect(() => resolveGitHubApiContentsUrl('https://github.com/openai/skills')).toThrow('/tree/');
  });

  test('throws for tree URL without a path after branch', () => {
    expect(() => resolveGitHubApiContentsUrl('https://github.com/openai/skills/tree/main')).toThrow(
      'path after the branch'
    );
  });
});

describe('SkillsManager.installSkillFromGit', () => {
  let db: BunDatabase;
  let mgr: SkillsManager;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createTables(db);
    const mcpRepo = new AppMcpServerRepository(db, noOpReactiveDb);
    const skillRepo = new SkillRepository(db, noOpReactiveDb);
    mgr = new SkillsManager(skillRepo, mcpRepo);
  });

  afterEach(() => {
    db.close();
  });

  function makeGitHubApiFetch(fileContent: string = '# Playwright Skill\n\nContent here') {
    return async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.includes('api.github.com')) {
        return new Response(
          JSON.stringify([
            {
              name: 'SKILL.md',
              type: 'file',
              download_url: 'https://raw.githubusercontent.com/mock/SKILL.md',
              url: '',
            },
          ]),
          { status: 200 }
        );
      }
      return new Response(fileContent, { status: 200 });
    };
  }

  test('registers skill in DB and writes SKILL.md to ~/.hyperneo/skills/', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeGitHubApiFetch() as typeof globalThis.fetch;

    try {
      const skill = await mgr.installSkillFromGit(
        'https://github.com/openai/skills/tree/main/skills/.curated/playwright',
        'playwright-test'
      );

      expect(skill.name).toBe('playwright-test');
      expect(skill.sourceType).toBe('builtin');
      expect(skill.enabled).toBe(true);
      expect(skill.builtIn).toBe(false);
      expect(skill.config.type).toBe('builtin');
      if (skill.config.type === 'builtin') {
        expect(skill.config.commandName).toBe('playwright-test');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('is idempotent — second call returns existing skill unchanged', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeGitHubApiFetch() as typeof globalThis.fetch;

    try {
      const skill1 = await mgr.installSkillFromGit(
        'https://github.com/openai/skills/tree/main/skills/.curated/playwright',
        'pw-idem'
      );
      const skill2 = await mgr.installSkillFromGit(
        'https://github.com/openai/skills/tree/main/skills/.curated/playwright',
        'pw-idem'
      );
      expect(skill1.id).toBe(skill2.id);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('throws for commandName with path traversal characters', async () => {
    await expect(
      mgr.installSkillFromGit(
        'https://github.com/openai/skills/tree/main/skills/.curated/playwright',
        '../../etc/passwd'
      )
    ).rejects.toThrow('path separators');
  });

  test('throws for commandName starting with a dot', async () => {
    await expect(
      mgr.installSkillFromGit(
        'https://github.com/openai/skills/tree/main/skills/.curated/playwright',
        '.hidden-skill'
      )
    ).rejects.toThrow('must not start with a dot');
  });

  test('is truly idempotent — does not call fetch on second call', async () => {
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      fetchCalls++;
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.includes('api.github.com')) {
        return new Response(
          JSON.stringify([
            {
              name: 'SKILL.md',
              type: 'file',
              download_url: 'https://raw.githubusercontent.com/mock/SKILL.md',
              url: '',
            },
          ]),
          { status: 200 }
        );
      }
      return new Response('# Content', { status: 200 });
    }) as typeof globalThis.fetch;

    try {
      await mgr.installSkillFromGit(
        'https://github.com/openai/skills/tree/main/skills/.curated/playwright',
        'idem-fetch-test'
      );
      const firstCallCount = fetchCalls;
      expect(firstCallCount).toBeGreaterThan(0);

      await mgr.installSkillFromGit(
        'https://github.com/openai/skills/tree/main/skills/.curated/playwright',
        'idem-fetch-test'
      );
      expect(fetchCalls).toBe(firstCallCount);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('throws when GitHub API returns non-ok status', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('Not Found', {
        status: 404,
        statusText: 'Not Found',
      })) as typeof globalThis.fetch;

    try {
      await expect(
        mgr.installSkillFromGit(
          'https://github.com/openai/skills/tree/main/skills/.curated/playwright',
          'bad-skill'
        )
      ).rejects.toThrow('404');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('falls back to single SKILL.md fetch for raw URL', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('# Content', { status: 200 })) as typeof globalThis.fetch;

    try {
      const skill = await mgr.installSkillFromGit(
        'https://raw.githubusercontent.com/openai/skills/main/skill.md',
        'no-workspace-skill'
      );
      expect(skill.name).toBe('no-workspace-skill');
      expect(skill.enabled).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('throws when GitHub API returns an entry with path traversal in its name', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr =
        typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url;
      if (urlStr.includes('api.github.com')) {
        return new Response(
          JSON.stringify([
            {
              name: '../../etc/cron.d/backdoor',
              type: 'file',
              download_url: 'https://raw.githubusercontent.com/mock/backdoor',
              url: '',
            },
          ]),
          { status: 200 }
        );
      }
      return new Response('malicious content', { status: 200 });
    }) as typeof globalThis.fetch;

    try {
      await expect(
        mgr.installSkillFromGit(
          'https://github.com/evil/repo/tree/main/skills/malicious',
          'safe-name'
        )
      ).rejects.toThrow('Unsafe entry name');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('throws when GitHub API returns an entry with a leading-dot name', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr =
        typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url;
      if (urlStr.includes('api.github.com')) {
        return new Response(
          JSON.stringify([
            {
              name: '.env',
              type: 'file',
              download_url: 'https://raw.githubusercontent.com/mock/.env',
              url: '',
            },
          ]),
          { status: 200 }
        );
      }
      return new Response('SECRET=bad', { status: 200 });
    }) as typeof globalThis.fetch;

    try {
      await expect(
        mgr.installSkillFromGit(
          'https://github.com/evil/repo/tree/main/skills/dotenv',
          'dot-entry-skill'
        )
      ).rejects.toThrow('Unsafe entry name');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('throws when directory nesting exceeds max depth', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr =
        typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url;
      if (urlStr.includes('api.github.com') || urlStr.includes('deep')) {
        return new Response(
          JSON.stringify([
            {
              name: 'deep',
              type: 'dir',
              download_url: null,
              url: 'https://api.github.com/repos/mock/repo/contents/deep',
            },
          ]),
          { status: 200 }
        );
      }
      return new Response('', { status: 200 });
    }) as typeof globalThis.fetch;

    try {
      await expect(
        mgr.installSkillFromGit('https://github.com/mock/repo/tree/main/skills/deep', 'deep-skill')
      ).rejects.toThrow('maximum nesting depth');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('throws when total file count exceeds max files', async () => {
    const originalFetch = globalThis.fetch;
    const manyFiles = Array.from({ length: 101 }, (_, i) => ({
      name: `file${i}.md`,
      type: 'file',
      download_url: `https://raw.githubusercontent.com/mock/file${i}.md`,
      url: '',
    }));
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr =
        typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url;
      if (urlStr.includes('api.github.com')) {
        return new Response(JSON.stringify(manyFiles), { status: 200 });
      }
      return new Response('# content', { status: 200 });
    }) as typeof globalThis.fetch;

    try {
      await expect(
        mgr.installSkillFromGit('https://github.com/mock/repo/tree/main/skills/huge', 'huge-skill')
      ).rejects.toThrow('maximum file count');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
