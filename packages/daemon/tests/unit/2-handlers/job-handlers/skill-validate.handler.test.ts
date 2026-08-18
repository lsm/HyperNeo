import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { createSkillValidateHandler } from '../../../../src/lib/job-handlers/skill-validate.handler';
import { SKILL_VALIDATE } from '../../../../src/lib/job-queue-constants';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository';
import type { SkillsManager } from '../../../../src/lib/skills-manager';
import type { AppMcpServerRepository } from '../../../../src/storage/repositories/app-mcp-server-repository';
import type { AppSkill } from '@hyperneo/shared';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeJob(payload: Record<string, unknown>): Job {
  return {
    id: 'test-job-id',
    queue: SKILL_VALIDATE,
    status: 'processing',
    payload,
    result: null,
    error: null,
    priority: 0,
    maxRetries: 3,
    retryCount: 0,
    runAt: Date.now(),
    createdAt: Date.now(),
    startedAt: Date.now(),
    completedAt: null,
  };
}

function makeSkill(overrides: Partial<AppSkill> = {}): AppSkill {
  return {
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
    ...overrides,
  };
}

function makeSkillsManager(
  impl?: Partial<Pick<SkillsManager, 'getSkill' | 'setSkillValidationStatus'>>
): SkillsManager {
  return {
    getSkill: impl?.getSkill ?? mock(() => makeSkill()),
    setSkillValidationStatus: impl?.setSkillValidationStatus ?? mock(() => makeSkill()),
  } as unknown as SkillsManager;
}

function makeAppMcpServerRepo(
  impl?: Partial<Pick<AppMcpServerRepository, 'get'>>
): AppMcpServerRepository {
  return {
    get: impl?.get ?? mock(() => null),
  } as unknown as AppMcpServerRepository;
}

describe('createSkillValidateHandler', () => {
  let handler: ReturnType<typeof createSkillValidateHandler>;

  beforeEach(() => {
    handler = createSkillValidateHandler(makeSkillsManager(), makeAppMcpServerRepo());
  });

  it('throws when skillId is missing from payload', async () => {
    const job = makeJob({});
    await expect(handler(job)).rejects.toThrow('Job payload missing required field: skillId');
  });

  it('throws when skillId is not a string', async () => {
    const job = makeJob({ skillId: 42 });
    await expect(handler(job)).rejects.toThrow('Job payload missing required field: skillId');
  });

  it('throws when skill is not found', async () => {
    const mgr = makeSkillsManager({ getSkill: mock(() => null) });
    handler = createSkillValidateHandler(mgr, makeAppMcpServerRepo());

    const job = makeJob({ skillId: 'nonexistent' });
    await expect(handler(job)).rejects.toThrow('Skill not found: nonexistent');
  });

  it('passes validation for builtin skill and returns { valid: true, skillId }', async () => {
    const skill = makeSkill({
      sourceType: 'builtin',
      config: { type: 'builtin', commandName: 'update-config' },
    });
    const setStatusMock = mock(() => makeSkill({ validationStatus: 'valid' }));
    const mgr = makeSkillsManager({
      getSkill: mock(() => skill),
      setSkillValidationStatus: setStatusMock,
    });
    handler = createSkillValidateHandler(mgr, makeAppMcpServerRepo());

    const job = makeJob({ skillId: 'skill-1' });
    const result = await handler(job);

    expect(result).toEqual({ valid: true, skillId: 'skill-1' });
    expect(setStatusMock).toHaveBeenCalledWith('skill-1', 'valid');
  });

  it('passes validation for plugin skill with accessible path', async () => {
    const pluginPath = mkdtempSync(join(tmpdir(), 'hyperneo-test-'));
    const skill = makeSkill({
      sourceType: 'plugin',
      config: { type: 'plugin', pluginPath },
    });
    const setStatusMock = mock(() => makeSkill({ validationStatus: 'valid' }));
    const mgr = makeSkillsManager({
      getSkill: mock(() => skill),
      setSkillValidationStatus: setStatusMock,
    });
    handler = createSkillValidateHandler(mgr, makeAppMcpServerRepo());

    const job = makeJob({ skillId: 'skill-1' });
    const result = await handler(job);

    expect(result).toEqual({ valid: true, skillId: 'skill-1' });
    expect(setStatusMock).toHaveBeenCalledWith('skill-1', 'valid');
  });

  it('fails validation for plugin skill with non-existent path and sets status to invalid', async () => {
    const pluginPath = '/nonexistent/path/that/does/not/exist';
    const skill = makeSkill({
      sourceType: 'plugin',
      config: { type: 'plugin', pluginPath },
    });
    const setStatusMock = mock(() => makeSkill());
    const mgr = makeSkillsManager({
      getSkill: mock(() => skill),
      setSkillValidationStatus: setStatusMock,
    });
    handler = createSkillValidateHandler(mgr, makeAppMcpServerRepo());

    const job = makeJob({ skillId: 'skill-1' });
    await expect(handler(job)).rejects.toThrow();
    expect(setStatusMock).toHaveBeenCalledWith('skill-1', 'invalid');
  });

  it('fails validation for mcp_server skill referencing non-existent MCP server and sets status to invalid', async () => {
    const skill = makeSkill({
      sourceType: 'mcp_server',
      config: { type: 'mcp_server', appMcpServerId: 'missing-server-id' },
      name: 'my-mcp-skill',
    });
    const setStatusMock = mock(() => makeSkill());
    const mcpRepo = makeAppMcpServerRepo({ get: mock(() => null) });
    const mgr = makeSkillsManager({
      getSkill: mock(() => skill),
      setSkillValidationStatus: setStatusMock,
    });
    handler = createSkillValidateHandler(mgr, mcpRepo);

    const job = makeJob({ skillId: 'skill-1' });
    await expect(handler(job)).rejects.toThrow(
      'mcp_server skill "my-mcp-skill": app_mcp_servers entry not found for id "missing-server-id"'
    );
    expect(setStatusMock).toHaveBeenCalledWith('skill-1', 'invalid');
  });

  it('passes validation for mcp_server skill when MCP server exists', async () => {
    const skill = makeSkill({
      sourceType: 'mcp_server',
      config: { type: 'mcp_server', appMcpServerId: 'existing-server-id' },
    });
    const setStatusMock = mock(() => makeSkill({ validationStatus: 'valid' }));
    const mcpRepo = makeAppMcpServerRepo({
      get: mock(() => ({ id: 'existing-server-id' }) as never),
    });
    const mgr = makeSkillsManager({
      getSkill: mock(() => skill),
      setSkillValidationStatus: setStatusMock,
    });
    handler = createSkillValidateHandler(mgr, mcpRepo);

    const job = makeJob({ skillId: 'skill-1' });
    const result = await handler(job);

    expect(result).toEqual({ valid: true, skillId: 'skill-1' });
    expect(setStatusMock).toHaveBeenCalledWith('skill-1', 'valid');
  });
});
