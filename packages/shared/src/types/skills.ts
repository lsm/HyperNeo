export type SkillSourceType = 'builtin' | 'plugin' | 'mcp_server';

export interface BuiltinSkillConfig {
  type: 'builtin';
  commandName: string;
  spaceOnly?: boolean;
}

export interface PluginSkillConfig {
  type: 'plugin';
  pluginPath: string;
}

export interface McpServerSkillConfig {
  type: 'mcp_server';
  appMcpServerId: string;
}

export type AppSkillConfig = BuiltinSkillConfig | PluginSkillConfig | McpServerSkillConfig;

export type SkillValidationStatus = 'pending' | 'valid' | 'invalid' | 'unknown';

export interface AppSkill {
  id: string;
  name: string;
  displayName: string;
  description: string;
  sourceType: SkillSourceType;
  config: AppSkillConfig;
  enabled: boolean;
  builtIn: boolean;
  validationStatus: SkillValidationStatus;
  createdAt: number;
}

export type CreateSkillParams = Omit<AppSkill, 'id' | 'createdAt' | 'builtIn'>;

export interface UpdateSkillParams {
  displayName?: string;
  description?: string;
  enabled?: boolean;
  config?: AppSkillConfig;
}

export interface SkillEnablementOverride {
  skillId: string;
  enabled: boolean;
}

export interface InstallSkillFromGitParams {
  repoUrl: string;
  commandName: string;
}

export function isBuiltinSkillConfig(config: AppSkillConfig): config is BuiltinSkillConfig {
  return config.type === 'builtin';
}

export function isPluginSkillConfig(config: AppSkillConfig): config is PluginSkillConfig {
  return config.type === 'plugin';
}

export function isMcpServerSkillConfig(config: AppSkillConfig): config is McpServerSkillConfig {
  return config.type === 'mcp_server';
}
