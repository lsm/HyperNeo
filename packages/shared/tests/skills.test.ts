import { describe, expect, it } from 'bun:test';
import {
  isBuiltinSkillConfig,
  isMcpServerSkillConfig,
  isPluginSkillConfig,
} from '../src/types/skills.ts';
import type {
  AppSkill,
  AppSkillConfig,
  BuiltinSkillConfig,
  CreateSkillParams,
  McpServerSkillConfig,
  PluginSkillConfig,
  SkillSourceType,
  SkillValidationStatus,
  UpdateSkillParams,
} from '../src/types/skills.ts';

const builtinConfig: BuiltinSkillConfig = { type: 'builtin', commandName: 'update-config' };
const pluginConfig: PluginSkillConfig = {
  type: 'plugin',
  pluginPath: '/home/user/.hyperneo/skills/my-skill',
};
const mcpConfig: McpServerSkillConfig = { type: 'mcp_server', appMcpServerId: 'mcp-uuid-1234' };

const baseSkill: AppSkill = {
  id: 'skill-uuid-1',
  name: 'web-search',
  displayName: 'Web Search',
  description: 'Searches the web via an MCP server',
  sourceType: 'mcp_server',
  config: mcpConfig,
  enabled: true,
  builtIn: false,
  validationStatus: 'valid',
  createdAt: 1735689600000,
};

describe('SkillSourceType', () => {
  it('accepts valid source types', () => {
    const types: SkillSourceType[] = ['builtin', 'plugin', 'mcp_server'];
    expect(types).toHaveLength(3);
  });
});

describe('SkillValidationStatus', () => {
  it('accepts all valid statuses', () => {
    const statuses: SkillValidationStatus[] = ['pending', 'valid', 'invalid', 'unknown'];
    expect(statuses).toHaveLength(4);
  });
});

describe('AppSkillConfig discriminated union — type guards', () => {
  it('identifies BuiltinSkillConfig via type discriminator', () => {
    const config: AppSkillConfig = builtinConfig;
    expect(isBuiltinSkillConfig(config)).toBe(true);
    expect(isPluginSkillConfig(config)).toBe(false);
    expect(isMcpServerSkillConfig(config)).toBe(false);
  });

  it('identifies PluginSkillConfig via type discriminator', () => {
    const config: AppSkillConfig = pluginConfig;
    expect(isBuiltinSkillConfig(config)).toBe(false);
    expect(isPluginSkillConfig(config)).toBe(true);
    expect(isMcpServerSkillConfig(config)).toBe(false);
  });

  it('identifies McpServerSkillConfig via type discriminator', () => {
    const config: AppSkillConfig = mcpConfig;
    expect(isBuiltinSkillConfig(config)).toBe(false);
    expect(isPluginSkillConfig(config)).toBe(false);
    expect(isMcpServerSkillConfig(config)).toBe(true);
  });

  it('BuiltinSkillConfig has commandName', () => {
    if (isBuiltinSkillConfig(builtinConfig)) {
      expect(builtinConfig.commandName).toBe('update-config');
    } else {
      throw new Error('Expected BuiltinSkillConfig');
    }
  });

  it('PluginSkillConfig has pluginPath', () => {
    if (isPluginSkillConfig(pluginConfig)) {
      expect(pluginConfig.pluginPath).toBe('/home/user/.hyperneo/skills/my-skill');
    } else {
      throw new Error('Expected PluginSkillConfig');
    }
  });

  it('McpServerSkillConfig has appMcpServerId', () => {
    if (isMcpServerSkillConfig(mcpConfig)) {
      expect(mcpConfig.appMcpServerId).toBe('mcp-uuid-1234');
    } else {
      throw new Error('Expected McpServerSkillConfig');
    }
  });
});

describe('AppSkill', () => {
  it('has all required fields', () => {
    expect(baseSkill.id).toBe('skill-uuid-1');
    expect(baseSkill.name).toBe('web-search');
    expect(baseSkill.displayName).toBe('Web Search');
    expect(baseSkill.description).toBeTruthy();
    expect(baseSkill.sourceType).toBe('mcp_server');
    expect(baseSkill.enabled).toBe(true);
    expect(baseSkill.builtIn).toBe(false);
    expect(baseSkill.validationStatus).toBe('valid');
  });

  it('createdAt is a number (Unix ms)', () => {
    expect(typeof baseSkill.createdAt).toBe('number');
    expect(baseSkill.createdAt).toBe(1735689600000);
  });

  it('config is accessible as McpServerSkillConfig when sourceType is mcp_server', () => {
    if (isMcpServerSkillConfig(baseSkill.config)) {
      expect(baseSkill.config.appMcpServerId).toBe('mcp-uuid-1234');
    } else {
      throw new Error('Expected McpServerSkillConfig');
    }
  });

  it('supports builtin sourceType with BuiltinSkillConfig', () => {
    const skill: AppSkill = {
      ...baseSkill,
      id: 'skill-builtin-1',
      sourceType: 'builtin',
      config: builtinConfig,
      builtIn: true,
    };
    expect(skill.sourceType).toBe('builtin');
    if (isBuiltinSkillConfig(skill.config)) {
      expect(skill.config.commandName).toBe('update-config');
    } else {
      throw new Error('Expected BuiltinSkillConfig');
    }
  });

  it('supports plugin sourceType with PluginSkillConfig', () => {
    const skill: AppSkill = {
      ...baseSkill,
      id: 'skill-plugin-1',
      sourceType: 'plugin',
      config: pluginConfig,
    };
    expect(skill.sourceType).toBe('plugin');
    if (isPluginSkillConfig(skill.config)) {
      expect(skill.config.pluginPath).toBe('/home/user/.hyperneo/skills/my-skill');
    } else {
      throw new Error('Expected PluginSkillConfig');
    }
  });
});

describe('CreateSkillParams', () => {
  it('excludes id, createdAt, builtIn', () => {
    const params: CreateSkillParams = {
      name: 'my-skill',
      displayName: 'My Skill',
      description: 'Does something useful',
      sourceType: 'plugin',
      config: pluginConfig,
      enabled: true,
      validationStatus: 'pending',
    };
    expect('id' in params).toBe(false);
    expect('createdAt' in params).toBe(false);
    expect('builtIn' in params).toBe(false);
    expect(params.name).toBe('my-skill');
  });

  it('includes name, sourceType, and validationStatus (immutable post-creation fields)', () => {
    const params: CreateSkillParams = {
      name: 'my-skill',
      displayName: 'My Skill',
      description: 'Desc',
      sourceType: 'builtin',
      config: builtinConfig,
      enabled: true,
      validationStatus: 'pending',
    };
    expect(params.name).toBe('my-skill');
    expect(params.sourceType).toBe('builtin');
    expect(params.validationStatus).toBe('pending');
  });
});

describe('UpdateSkillParams', () => {
  it('restricts to user-editable fields only', () => {
    const patch: UpdateSkillParams = {
      displayName: 'New Name',
      description: 'New description',
      enabled: false,
      config: pluginConfig,
    };
    expect(patch.displayName).toBe('New Name');
    expect(patch.description).toBe('New description');
    expect(patch.enabled).toBe(false);
  });

  it('allows empty update object', () => {
    const patch: UpdateSkillParams = {};
    expect(Object.keys(patch)).toHaveLength(0);
  });

  it('allows partial update with only enabled', () => {
    const patch: UpdateSkillParams = { enabled: false };
    expect(patch.enabled).toBe(false);
  });

  it('does not include name, sourceType, or validationStatus', () => {
    const patch: UpdateSkillParams = { displayName: 'Test' };
    expect('name' in patch).toBe(false);
    expect('sourceType' in patch).toBe(false);
    expect('validationStatus' in patch).toBe(false);
  });
});
