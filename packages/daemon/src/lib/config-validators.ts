import type {
  SystemPromptConfig,
  ToolsSettings,
  AgentDefinition,
  SandboxSettings,
  McpServerConfig,
  McpStdioServerConfig,
  OutputFormatConfig,
  SdkBeta,
  EnvironmentSettings,
  ValidationResult,
  ToolsPresetConfig,
} from '@hyperneo/shared';

export function validateSystemPromptConfig(config: SystemPromptConfig): ValidationResult {
  if (typeof config === 'string') {
    if (config.length > 100000) {
      return { valid: false, error: 'System prompt too long (max 100KB)' };
    }
    return { valid: true };
  }

  if (typeof config === 'object' && config !== null) {
    if (config.type !== 'preset') {
      return {
        valid: false,
        error: 'System prompt object must have type: "preset"',
      };
    }
    if (config.preset !== 'claude_code') {
      return { valid: false, error: 'Only "claude_code" preset is supported' };
    }
    if (config.append !== undefined) {
      if (typeof config.append !== 'string') {
        return { valid: false, error: 'System prompt append must be a string' };
      }
      if (config.append.length > 50000) {
        return {
          valid: false,
          error: 'System prompt append too long (max 50KB)',
        };
      }
    }
    return { valid: true };
  }

  return { valid: false, error: 'Invalid system prompt configuration' };
}

export function validateToolsPresetConfig(config: ToolsPresetConfig): ValidationResult {
  if (Array.isArray(config)) {
    for (const tool of config) {
      if (typeof tool !== 'string' || tool.length === 0) {
        return { valid: false, error: 'Invalid tool name in tools array' };
      }
      if (tool.length > 200) {
        return {
          valid: false,
          error: `Tool name too long: ${tool.slice(0, 50)}...`,
        };
      }
    }
    return { valid: true };
  }

  if (typeof config === 'object' && config !== null) {
    if (config.type !== 'preset') {
      return { valid: false, error: 'Tools object must have type: "preset"' };
    }
    if (config.preset !== 'claude_code') {
      return {
        valid: false,
        error: 'Only "claude_code" tools preset is supported',
      };
    }
    return { valid: true };
  }

  return { valid: false, error: 'Invalid tools configuration' };
}

export function validateToolsConfig(config: Partial<ToolsSettings>): ValidationResult {
  if (config.tools !== undefined) {
    const toolsResult = validateToolsPresetConfig(config.tools);
    if (!toolsResult.valid) {
      return toolsResult;
    }
  }

  if (config.allowedTools !== undefined) {
    if (!Array.isArray(config.allowedTools)) {
      return { valid: false, error: 'allowedTools must be an array' };
    }
    for (const tool of config.allowedTools) {
      if (typeof tool !== 'string' || tool.length === 0) {
        return { valid: false, error: 'Invalid tool name in allowedTools' };
      }
    }
  }

  if (config.disallowedTools !== undefined) {
    if (!Array.isArray(config.disallowedTools)) {
      return { valid: false, error: 'disallowedTools must be an array' };
    }
    for (const tool of config.disallowedTools) {
      if (typeof tool !== 'string' || tool.length === 0) {
        return { valid: false, error: 'Invalid tool name in disallowedTools' };
      }
    }
  }

  return { valid: true };
}

export function validateAgentDefinition(name: string, agent: AgentDefinition): ValidationResult {
  if (!name || name.length === 0) {
    return { valid: false, error: 'Agent name is required' };
  }

  if (name.length > 100) {
    return {
      valid: false,
      error: `Agent name too long: ${name.slice(0, 50)}...`,
    };
  }

  if (!agent.description || agent.description.length === 0) {
    return { valid: false, error: `Agent ${name}: description is required` };
  }

  if (agent.description.length > 10000) {
    return {
      valid: false,
      error: `Agent ${name}: description too long (max 10KB)`,
    };
  }

  if (!agent.prompt || agent.prompt.length === 0) {
    return { valid: false, error: `Agent ${name}: prompt is required` };
  }

  if (agent.prompt.length > 100000) {
    return {
      valid: false,
      error: `Agent ${name}: prompt too long (max 100KB)`,
    };
  }

  if (agent.model !== undefined) {
    if (typeof agent.model !== 'string' || agent.model.length === 0) {
      return {
        valid: false,
        error: `Agent ${name}: model must be a non-empty string`,
      };
    }
  }

  if (agent.tools !== undefined) {
    if (!Array.isArray(agent.tools)) {
      return { valid: false, error: `Agent ${name}: tools must be an array` };
    }
    for (const tool of agent.tools) {
      if (typeof tool !== 'string' || tool.length === 0) {
        return { valid: false, error: `Agent ${name}: invalid tool name` };
      }
    }
  }

  if (agent.disallowedTools !== undefined) {
    if (!Array.isArray(agent.disallowedTools)) {
      return {
        valid: false,
        error: `Agent ${name}: disallowedTools must be an array`,
      };
    }
    for (const tool of agent.disallowedTools) {
      if (typeof tool !== 'string' || tool.length === 0) {
        return {
          valid: false,
          error: `Agent ${name}: invalid disallowed tool name`,
        };
      }
    }
  }

  return { valid: true };
}

export function validateAgentsConfig(agents: Record<string, AgentDefinition>): ValidationResult {
  for (const [name, agent] of Object.entries(agents)) {
    const result = validateAgentDefinition(name, agent);
    if (!result.valid) {
      return result;
    }
  }
  return { valid: true };
}

export function validateSandboxConfig(config: SandboxSettings): ValidationResult {
  if (config.excludedCommands !== undefined) {
    if (!Array.isArray(config.excludedCommands)) {
      return { valid: false, error: 'excludedCommands must be an array' };
    }
    for (const cmd of config.excludedCommands) {
      if (typeof cmd !== 'string' || cmd.length === 0) {
        return { valid: false, error: 'Invalid command in excludedCommands' };
      }
    }
  }

  if (config.network !== undefined) {
    const network = config.network;

    if (network.allowUnixSockets !== undefined) {
      if (!Array.isArray(network.allowUnixSockets)) {
        return {
          valid: false,
          error: 'network.allowUnixSockets must be an array',
        };
      }
      for (const socket of network.allowUnixSockets) {
        if (typeof socket !== 'string' || socket.length === 0) {
          return { valid: false, error: 'Invalid Unix socket path' };
        }
      }
    }

    if (network.allowedDomains !== undefined) {
      if (!Array.isArray(network.allowedDomains)) {
        return {
          valid: false,
          error: 'network.allowedDomains must be an array',
        };
      }
      for (const domain of network.allowedDomains) {
        if (typeof domain !== 'string' || domain.length === 0) {
          return {
            valid: false,
            error: 'Invalid domain in network.allowedDomains',
          };
        }
      }
    }

    if (network.httpProxyPort !== undefined) {
      if (
        typeof network.httpProxyPort !== 'number' ||
        network.httpProxyPort < 1 ||
        network.httpProxyPort > 65535
      ) {
        return {
          valid: false,
          error: 'network.httpProxyPort must be a valid port number (1-65535)',
        };
      }
    }

    if (network.socksProxyPort !== undefined) {
      if (
        typeof network.socksProxyPort !== 'number' ||
        network.socksProxyPort < 1 ||
        network.socksProxyPort > 65535
      ) {
        return {
          valid: false,
          error: 'network.socksProxyPort must be a valid port number (1-65535)',
        };
      }
    }
  }

  if (config.ignoreViolations !== undefined) {
    const ignore = config.ignoreViolations;

    if (ignore.file !== undefined) {
      if (!Array.isArray(ignore.file)) {
        return {
          valid: false,
          error: 'ignoreViolations.file must be an array',
        };
      }
      for (const pattern of ignore.file) {
        if (typeof pattern !== 'string' || pattern.length === 0) {
          return {
            valid: false,
            error: 'Invalid pattern in ignoreViolations.file',
          };
        }
      }
    }

    if (ignore.network !== undefined) {
      if (!Array.isArray(ignore.network)) {
        return {
          valid: false,
          error: 'ignoreViolations.network must be an array',
        };
      }
      for (const pattern of ignore.network) {
        if (typeof pattern !== 'string' || pattern.length === 0) {
          return {
            valid: false,
            error: 'Invalid pattern in ignoreViolations.network',
          };
        }
      }
    }
  }

  return { valid: true };
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export function validateMcpServerConfig(name: string, config: McpServerConfig): ValidationResult {
  if (!name || name.length === 0) {
    return { valid: false, error: 'MCP server name is required' };
  }

  if (name.length > 100) {
    return {
      valid: false,
      error: `MCP server name too long: ${name.slice(0, 50)}...`,
    };
  }

  if (!config.type || config.type === 'stdio') {
    const stdioConfig = config as McpStdioServerConfig;
    if (!stdioConfig.command || stdioConfig.command.length === 0) {
      return {
        valid: false,
        error: `MCP server ${name}: command is required for stdio type`,
      };
    }

    if (stdioConfig.args !== undefined) {
      if (!Array.isArray(stdioConfig.args)) {
        return {
          valid: false,
          error: `MCP server ${name}: args must be an array`,
        };
      }
      for (const arg of stdioConfig.args) {
        if (typeof arg !== 'string') {
          return {
            valid: false,
            error: `MCP server ${name}: all args must be strings`,
          };
        }
      }
    }

    if (stdioConfig.env !== undefined) {
      if (typeof stdioConfig.env !== 'object' || stdioConfig.env === null) {
        return {
          valid: false,
          error: `MCP server ${name}: env must be an object`,
        };
      }
      for (const [key, value] of Object.entries(stdioConfig.env)) {
        if (typeof key !== 'string' || typeof value !== 'string') {
          return {
            valid: false,
            error: `MCP server ${name}: env values must be strings`,
          };
        }
      }
    }

    return { valid: true };
  }

  if (config.type === 'sse' || config.type === 'http') {
    if (!config.url || !isValidUrl(config.url)) {
      return {
        valid: false,
        error: `MCP server ${name}: valid URL is required for ${config.type} type`,
      };
    }

    if (config.headers !== undefined) {
      if (typeof config.headers !== 'object' || config.headers === null) {
        return {
          valid: false,
          error: `MCP server ${name}: headers must be an object`,
        };
      }
      for (const [key, value] of Object.entries(config.headers)) {
        if (typeof key !== 'string' || typeof value !== 'string') {
          return {
            valid: false,
            error: `MCP server ${name}: header values must be strings`,
          };
        }
      }
    }

    return { valid: true };
  }

  return {
    valid: false,
    error: `MCP server ${name}: invalid type '${config.type}'`,
  };
}

export function validateMcpServersConfig(
  servers: Record<string, McpServerConfig>
): ValidationResult {
  for (const [name, config] of Object.entries(servers)) {
    const result = validateMcpServerConfig(name, config);
    if (!result.valid) {
      return result;
    }
  }
  return { valid: true };
}

export function validateOutputFormat(config: OutputFormatConfig): ValidationResult {
  if (config.type !== 'json_schema') {
    return { valid: false, error: 'Output format type must be "json_schema"' };
  }

  if (!config.schema || typeof config.schema !== 'object' || config.schema === null) {
    return {
      valid: false,
      error: 'Output format schema is required and must be an object',
    };
  }

  try {
    const serialized = JSON.stringify(config.schema);
    if (serialized.length > 100000) {
      return {
        valid: false,
        error: 'Output format schema too large (max 100KB)',
      };
    }
  } catch {
    return { valid: false, error: 'Output format schema is not valid JSON' };
  }

  return { valid: true };
}

const VALID_BETAS: SdkBeta[] = ['context-1m-2025-08-07'];

export function validateBetasConfig(betas: SdkBeta[]): ValidationResult {
  if (!Array.isArray(betas)) {
    return { valid: false, error: 'Betas must be an array' };
  }

  for (const beta of betas) {
    if (!VALID_BETAS.includes(beta)) {
      return {
        valid: false,
        error: `Invalid beta feature: ${beta}. Valid options: ${VALID_BETAS.join(', ')}`,
      };
    }
  }

  return { valid: true };
}

export function validateEnvConfig(config: Partial<EnvironmentSettings>): ValidationResult {
  if (config.cwd !== undefined) {
    if (typeof config.cwd !== 'string' || config.cwd.length === 0) {
      return { valid: false, error: 'cwd must be a non-empty string' };
    }
  }

  if (config.additionalDirectories !== undefined) {
    if (!Array.isArray(config.additionalDirectories)) {
      return { valid: false, error: 'additionalDirectories must be an array' };
    }
    for (const dir of config.additionalDirectories) {
      if (typeof dir !== 'string' || dir.length === 0) {
        return {
          valid: false,
          error: 'Invalid directory in additionalDirectories',
        };
      }
    }
  }

  if (config.env !== undefined) {
    if (typeof config.env !== 'object' || config.env === null) {
      return { valid: false, error: 'env must be an object' };
    }
    for (const [key, value] of Object.entries(config.env)) {
      if (typeof key !== 'string') {
        return { valid: false, error: 'env keys must be strings' };
      }
      if (value !== undefined && typeof value !== 'string') {
        return {
          valid: false,
          error: `env value for '${key}' must be a string or undefined`,
        };
      }
    }
  }

  if (config.executable !== undefined) {
    const validExecutables = ['bun', 'deno', 'node'];
    if (!validExecutables.includes(config.executable)) {
      return {
        valid: false,
        error: `Invalid executable: ${config.executable}. Must be one of: ${validExecutables.join(', ')}`,
      };
    }
  }

  if (config.executableArgs !== undefined) {
    if (!Array.isArray(config.executableArgs)) {
      return { valid: false, error: 'executableArgs must be an array' };
    }
    for (const arg of config.executableArgs) {
      if (typeof arg !== 'string') {
        return { valid: false, error: 'All executableArgs must be strings' };
      }
    }
  }

  return { valid: true };
}
