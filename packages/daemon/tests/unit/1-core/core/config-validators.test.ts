import { describe, test, expect } from 'bun:test';
import {
  validateSystemPromptConfig,
  validateToolsPresetConfig,
  validateToolsConfig,
  validateAgentDefinition,
  validateAgentsConfig,
  validateSandboxConfig,
  validateMcpServerConfig,
  validateMcpServersConfig,
  validateOutputFormat,
  validateBetasConfig,
  validateEnvConfig,
} from '../../../../src/lib/config-validators';

describe('validateSystemPromptConfig', () => {
  test('accepts valid string prompt', () => {
    const result = validateSystemPromptConfig('You are a helpful assistant');
    expect(result.valid).toBe(true);
  });

  test('accepts empty string prompt', () => {
    const result = validateSystemPromptConfig('');
    expect(result.valid).toBe(true);
  });

  test('rejects string prompt over 100KB', () => {
    const longPrompt = 'x'.repeat(100001);
    const result = validateSystemPromptConfig(longPrompt);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('too long');
  });

  test('accepts valid claude_code preset', () => {
    const result = validateSystemPromptConfig({
      type: 'preset',
      preset: 'claude_code',
    });
    expect(result.valid).toBe(true);
  });

  test('accepts claude_code preset with append', () => {
    const result = validateSystemPromptConfig({
      type: 'preset',
      preset: 'claude_code',
      append: 'Additional instructions',
    });
    expect(result.valid).toBe(true);
  });

  test('rejects preset with invalid type', () => {
    const result = validateSystemPromptConfig({
      type: 'invalid',
      preset: 'claude_code',
    } as never);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('type: "preset"');
  });

  test('rejects preset with invalid preset name', () => {
    const result = validateSystemPromptConfig({
      type: 'preset',
      preset: 'invalid',
    } as never);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('claude_code');
  });

  test('rejects preset with non-string append', () => {
    const result = validateSystemPromptConfig({
      type: 'preset',
      preset: 'claude_code',
      append: 123 as never,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('append must be a string');
  });

  test('rejects preset with append over 50KB', () => {
    const result = validateSystemPromptConfig({
      type: 'preset',
      preset: 'claude_code',
      append: 'x'.repeat(50001),
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('append too long');
  });
});

describe('validateToolsPresetConfig', () => {
  test('accepts valid tool array', () => {
    const result = validateToolsPresetConfig(['Bash', 'Read', 'Write']);
    expect(result.valid).toBe(true);
  });

  test('accepts empty tool array', () => {
    const result = validateToolsPresetConfig([]);
    expect(result.valid).toBe(true);
  });

  test('rejects tool array with empty string', () => {
    const result = validateToolsPresetConfig(['Bash', '', 'Write']);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid tool name');
  });

  test('rejects tool array with non-string', () => {
    const result = validateToolsPresetConfig(['Bash', 123 as never, 'Write']);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid tool name');
  });

  test('rejects tool name over 200 chars', () => {
    const result = validateToolsPresetConfig(['x'.repeat(201)]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Tool name too long');
  });

  test('accepts valid claude_code preset', () => {
    const result = validateToolsPresetConfig({
      type: 'preset',
      preset: 'claude_code',
    });
    expect(result.valid).toBe(true);
  });

  test('rejects preset with invalid type', () => {
    const result = validateToolsPresetConfig({
      type: 'invalid',
      preset: 'claude_code',
    } as never);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('type: "preset"');
  });

  test('rejects preset with invalid preset name', () => {
    const result = validateToolsPresetConfig({
      type: 'preset',
      preset: 'custom',
    } as never);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('claude_code');
  });
});

describe('validateToolsConfig', () => {
  test('accepts valid tools config', () => {
    const result = validateToolsConfig({
      tools: ['Bash', 'Read'],
      allowedTools: ['Write'],
      disallowedTools: ['Edit'],
    });
    expect(result.valid).toBe(true);
  });

  test('accepts empty config', () => {
    const result = validateToolsConfig({});
    expect(result.valid).toBe(true);
  });

  test('rejects non-array allowedTools', () => {
    const result = validateToolsConfig({ allowedTools: 'Bash' as never });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('allowedTools must be an array');
  });

  test('rejects non-array disallowedTools', () => {
    const result = validateToolsConfig({ disallowedTools: 'Bash' as never });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('disallowedTools must be an array');
  });

  test('rejects empty string in allowedTools', () => {
    const result = validateToolsConfig({ allowedTools: ['Bash', ''] });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid tool name in allowedTools');
  });

  test('rejects empty string in disallowedTools', () => {
    const result = validateToolsConfig({ disallowedTools: ['Bash', ''] });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid tool name in disallowedTools');
  });
});

describe('validateAgentDefinition', () => {
  test('accepts valid agent definition', () => {
    const result = validateAgentDefinition('explorer', {
      description: 'Explores the codebase',
      prompt: 'You are a code explorer',
    });
    expect(result.valid).toBe(true);
  });

  test('accepts agent with optional fields', () => {
    const result = validateAgentDefinition('explorer', {
      description: 'Explores the codebase',
      prompt: 'You are a code explorer',
      model: 'haiku',
      tools: ['Read', 'Grep'],
      disallowedTools: ['Write'],
    });
    expect(result.valid).toBe(true);
  });

  test('rejects empty agent name', () => {
    const result = validateAgentDefinition('', {
      description: 'Explores the codebase',
      prompt: 'You are a code explorer',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Agent name is required');
  });

  test('rejects agent name over 100 chars', () => {
    const result = validateAgentDefinition('x'.repeat(101), {
      description: 'Explores the codebase',
      prompt: 'You are a code explorer',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Agent name too long');
  });

  test('rejects empty description', () => {
    const result = validateAgentDefinition('explorer', {
      description: '',
      prompt: 'You are a code explorer',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('description is required');
  });

  test('rejects description over 10KB', () => {
    const result = validateAgentDefinition('explorer', {
      description: 'x'.repeat(10001),
      prompt: 'You are a code explorer',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('description too long');
  });

  test('rejects empty prompt', () => {
    const result = validateAgentDefinition('explorer', {
      description: 'Explores the codebase',
      prompt: '',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('prompt is required');
  });

  test('rejects prompt over 100KB', () => {
    const result = validateAgentDefinition('explorer', {
      description: 'Explores the codebase',
      prompt: 'x'.repeat(100001),
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('prompt too long');
  });

  test('accepts valid model values', () => {
    for (const model of [
      'sonnet',
      'opus',
      'haiku',
      'fable',
      'inherit',
      'claude-fable-5',
    ] as const) {
      const result = validateAgentDefinition('explorer', {
        description: 'Explores the codebase',
        prompt: 'You are a code explorer',
        model,
      });
      expect(result.valid).toBe(true);
    }
  });

  test('rejects empty model value', () => {
    const result = validateAgentDefinition('explorer', {
      description: 'Explores the codebase',
      prompt: 'You are a code explorer',
      model: '',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('model must be a non-empty string');
  });

  test('rejects non-array tools', () => {
    const result = validateAgentDefinition('explorer', {
      description: 'Explores the codebase',
      prompt: 'You are a code explorer',
      tools: 'Read' as never,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('tools must be an array');
  });

  test('rejects non-array disallowedTools', () => {
    const result = validateAgentDefinition('explorer', {
      description: 'Explores the codebase',
      prompt: 'You are a code explorer',
      disallowedTools: 'Write' as never,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('disallowedTools must be an array');
  });
});

describe('validateAgentsConfig', () => {
  test('accepts valid agents config', () => {
    const result = validateAgentsConfig({
      explorer: {
        description: 'Explores the codebase',
        prompt: 'You are a code explorer',
      },
      planner: {
        description: 'Plans implementation',
        prompt: 'You are a planner',
      },
    });
    expect(result.valid).toBe(true);
  });

  test('accepts empty agents config', () => {
    const result = validateAgentsConfig({});
    expect(result.valid).toBe(true);
  });

  test('rejects config with invalid agent', () => {
    const result = validateAgentsConfig({
      explorer: {
        description: '',
        prompt: 'You are a code explorer',
      },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('description is required');
  });
});

describe('validateSandboxConfig', () => {
  test('accepts valid sandbox config', () => {
    const result = validateSandboxConfig({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      excludedCommands: ['rm', 'sudo'],
    });
    expect(result.valid).toBe(true);
  });

  test('accepts empty sandbox config', () => {
    const result = validateSandboxConfig({});
    expect(result.valid).toBe(true);
  });

  test('rejects non-array excludedCommands', () => {
    const result = validateSandboxConfig({ excludedCommands: 'rm' as never });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('excludedCommands must be an array');
  });

  test('rejects empty string in excludedCommands', () => {
    const result = validateSandboxConfig({ excludedCommands: ['rm', ''] });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid command');
  });

  test('validates network allowUnixSockets', () => {
    const result = validateSandboxConfig({
      network: { allowUnixSockets: ['/tmp/socket.sock'] },
    });
    expect(result.valid).toBe(true);
  });

  test('rejects non-array network.allowUnixSockets', () => {
    const result = validateSandboxConfig({
      network: { allowUnixSockets: '/tmp/socket.sock' as never },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('network.allowUnixSockets must be an array');
  });

  test('validates network allowedDomains', () => {
    const result = validateSandboxConfig({
      network: { allowedDomains: ['api.anthropic.com'] },
    });
    expect(result.valid).toBe(true);
  });

  test('rejects non-array network.allowedDomains', () => {
    const result = validateSandboxConfig({
      network: { allowedDomains: 'api.anthropic.com' as never },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('network.allowedDomains must be an array');
  });

  test('validates valid port numbers', () => {
    const result = validateSandboxConfig({
      network: { httpProxyPort: 8080, socksProxyPort: 1080 },
    });
    expect(result.valid).toBe(true);
  });

  test('rejects invalid httpProxyPort', () => {
    const result = validateSandboxConfig({
      network: { httpProxyPort: 65536 },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('valid port number');
  });

  test('rejects negative socksProxyPort', () => {
    const result = validateSandboxConfig({
      network: { socksProxyPort: -1 },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('valid port number');
  });

  test('validates ignoreViolations file patterns', () => {
    const result = validateSandboxConfig({
      ignoreViolations: { file: ['/tmp/*', '/var/log/*'] },
    });
    expect(result.valid).toBe(true);
  });

  test('rejects non-array ignoreViolations.file', () => {
    const result = validateSandboxConfig({
      ignoreViolations: { file: '/tmp/*' as never },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('ignoreViolations.file must be an array');
  });

  test('validates ignoreViolations network patterns', () => {
    const result = validateSandboxConfig({
      ignoreViolations: { network: ['*.example.com'] },
    });
    expect(result.valid).toBe(true);
  });

  test('rejects non-array ignoreViolations.network', () => {
    const result = validateSandboxConfig({
      ignoreViolations: { network: '*.example.com' as never },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('ignoreViolations.network must be an array');
  });
});

describe('validateMcpServerConfig', () => {
  test('accepts valid stdio MCP server', () => {
    const result = validateMcpServerConfig('memory', {
      command: 'npx',
      args: ['-y', '@anthropic-ai/mcp-memory'],
    });
    expect(result.valid).toBe(true);
  });

  test('accepts stdio server without explicit type', () => {
    const result = validateMcpServerConfig('memory', {
      command: 'npx',
    });
    expect(result.valid).toBe(true);
  });

  test('accepts stdio server with env', () => {
    const result = validateMcpServerConfig('memory', {
      type: 'stdio',
      command: 'npx',
      env: { API_KEY: 'secret' },
    });
    expect(result.valid).toBe(true);
  });

  test('rejects empty server name', () => {
    const result = validateMcpServerConfig('', { command: 'npx' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('MCP server name is required');
  });

  test('rejects server name over 100 chars', () => {
    const result = validateMcpServerConfig('x'.repeat(101), { command: 'npx' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('name too long');
  });

  test('rejects stdio server without command', () => {
    const result = validateMcpServerConfig('memory', {
      type: 'stdio',
    } as never);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('command is required');
  });

  test('rejects non-array args', () => {
    const result = validateMcpServerConfig('memory', {
      command: 'npx',
      args: 'some-arg' as never,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('args must be an array');
  });

  test('rejects non-string in args', () => {
    const result = validateMcpServerConfig('memory', {
      command: 'npx',
      args: ['valid', 123 as never],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('args must be strings');
  });

  test('rejects non-object env', () => {
    const result = validateMcpServerConfig('memory', {
      command: 'npx',
      env: 'API_KEY=secret' as never,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('env must be an object');
  });

  test('accepts valid SSE MCP server', () => {
    const result = validateMcpServerConfig('remote', {
      type: 'sse',
      url: 'https://mcp.example.com/sse',
    });
    expect(result.valid).toBe(true);
  });

  test('accepts valid HTTP MCP server', () => {
    const result = validateMcpServerConfig('remote', {
      type: 'http',
      url: 'https://mcp.example.com/api',
      headers: { Authorization: 'Bearer token' },
    });
    expect(result.valid).toBe(true);
  });

  test('rejects SSE server with invalid URL', () => {
    const result = validateMcpServerConfig('remote', {
      type: 'sse',
      url: 'not-a-valid-url',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('valid URL is required');
  });

  test('rejects HTTP server with non-object headers', () => {
    const result = validateMcpServerConfig('remote', {
      type: 'http',
      url: 'https://mcp.example.com/api',
      headers: 'Bearer token' as never,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('headers must be an object');
  });

  test('rejects invalid server type', () => {
    const result = validateMcpServerConfig('remote', {
      type: 'websocket' as never,
      url: 'wss://mcp.example.com',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('invalid type');
  });
});

describe('validateMcpServersConfig', () => {
  test('accepts valid servers config', () => {
    const result = validateMcpServersConfig({
      memory: { command: 'npx', args: ['-y', '@anthropic-ai/mcp-memory'] },
      remote: { type: 'sse', url: 'https://mcp.example.com/sse' },
    });
    expect(result.valid).toBe(true);
  });

  test('accepts empty servers config', () => {
    const result = validateMcpServersConfig({});
    expect(result.valid).toBe(true);
  });

  test('rejects config with invalid server', () => {
    const result = validateMcpServersConfig({
      memory: { type: 'stdio' } as never,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('command is required');
  });
});

describe('validateOutputFormat', () => {
  test('accepts valid JSON schema output format', () => {
    const result = validateOutputFormat({
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
      },
    });
    expect(result.valid).toBe(true);
  });

  test('rejects invalid type', () => {
    const result = validateOutputFormat({ type: 'xml' as never, schema: {} });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('type must be "json_schema"');
  });

  test('rejects missing schema', () => {
    const result = validateOutputFormat({ type: 'json_schema' } as never);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('schema is required');
  });

  test('rejects non-object schema', () => {
    const result = validateOutputFormat({
      type: 'json_schema',
      schema: 'not-an-object' as never,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('schema is required and must be an object');
  });

  test('rejects schema over 100KB', () => {
    const largeSchema: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++) {
      largeSchema[`property_${i}`] = {
        type: 'string',
        description: 'x'.repeat(20),
      };
    }
    const result = validateOutputFormat({
      type: 'json_schema',
      schema: largeSchema,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('schema too large');
  });
});

describe('validateBetasConfig', () => {
  test('accepts valid beta features', () => {
    const result = validateBetasConfig(['context-1m-2025-08-07']);
    expect(result.valid).toBe(true);
  });

  test('accepts empty betas array', () => {
    const result = validateBetasConfig([]);
    expect(result.valid).toBe(true);
  });

  test('rejects invalid beta feature', () => {
    const result = validateBetasConfig(['invalid-beta' as never]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid beta feature');
  });

  test('rejects non-array betas', () => {
    const result = validateBetasConfig('context-1m-2025-08-07' as never);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Betas must be an array');
  });
});

describe('validateEnvConfig', () => {
  test('accepts valid env config', () => {
    const result = validateEnvConfig({
      cwd: '/path/to/project',
      additionalDirectories: ['/path/to/other'],
      env: { NODE_ENV: 'development' },
      executable: 'bun',
      executableArgs: ['--watch'],
    });
    expect(result.valid).toBe(true);
  });

  test('accepts empty config', () => {
    const result = validateEnvConfig({});
    expect(result.valid).toBe(true);
  });

  test('rejects empty cwd string', () => {
    const result = validateEnvConfig({ cwd: '' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('cwd must be a non-empty string');
  });

  test('rejects non-string cwd', () => {
    const result = validateEnvConfig({ cwd: 123 as never });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('cwd must be a non-empty string');
  });

  test('rejects non-array additionalDirectories', () => {
    const result = validateEnvConfig({
      additionalDirectories: '/path' as never,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('additionalDirectories must be an array');
  });

  test('rejects empty string in additionalDirectories', () => {
    const result = validateEnvConfig({ additionalDirectories: ['/path', ''] });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid directory');
  });

  test('rejects non-object env', () => {
    const result = validateEnvConfig({ env: 'NODE_ENV=development' as never });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('env must be an object');
  });

  test('rejects non-string env value', () => {
    const result = validateEnvConfig({ env: { NODE_ENV: 123 as never } });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('must be a string or undefined');
  });

  test('accepts valid executable values', () => {
    for (const executable of ['bun', 'deno', 'node'] as const) {
      const result = validateEnvConfig({ executable });
      expect(result.valid).toBe(true);
    }
  });

  test('rejects invalid executable', () => {
    const result = validateEnvConfig({ executable: 'python' as never });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid executable');
  });

  test('rejects non-array executableArgs', () => {
    const result = validateEnvConfig({ executableArgs: '--watch' as never });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('executableArgs must be an array');
  });

  test('rejects non-string in executableArgs', () => {
    const result = validateEnvConfig({
      executableArgs: ['--watch', 123 as never],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('All executableArgs must be strings');
  });
});
