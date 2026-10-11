export interface BuiltinMcpServer {
  name: string;
  description: string;
  sourceType: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

export type BuiltinSkill =
  | {
      kind: 'mcp_server';
      name: string;
      displayName: string;
      description: string;
      appMcpServerName: string;
      enabled: boolean;
    }
  | {
      kind: 'builtin-command';
      name: string;
      displayName: string;
      description: string;
      commandName: string;
      enabled: boolean;
      spaceOnly?: boolean;
    };

export const BUILTIN_MCP_SERVERS: readonly BuiltinMcpServer[] = [
  {
    name: 'fetch-mcp',
    description: 'Fetch web pages and convert to Markdown for reading documentation and articles',
    sourceType: 'stdio',
    command: 'npx',
    args: ['-y', '@tokenizin/mcp-npx-fetch'],
    env: {},
    enabled: true,
  },
  {
    name: 'chrome-devtools',
    description:
      'Browser automation and DevTools integration via Chrome DevTools MCP (isolated mode)',
    sourceType: 'stdio',
    command: 'bunx',
    args: ['chrome-devtools-mcp@latest', '--isolated'],
    env: {},
    enabled: false,
  },
  {
    name: 'chrome-devtools-user',
    description:
      'Browser automation via Chrome DevTools MCP attached to the user’s own Chrome (auto-connect). Sees the user’s logins; used by the Neo life-admin pack.',
    sourceType: 'stdio',
    command: 'bunx',
    args: ['chrome-devtools-mcp@latest', '--autoConnect'],
    env: {},
    enabled: false,
  },
] as const;

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  {
    kind: 'mcp_server',
    name: 'fetch-mcp',
    displayName: 'Fetch MCP',
    description: 'Fetch web pages and convert to Markdown for reading documentation and articles',
    appMcpServerName: 'fetch-mcp',
    enabled: true,
  },
  {
    kind: 'mcp_server',
    name: 'chrome-devtools-mcp',
    displayName: 'Chrome DevTools (MCP)',
    description:
      'Browser automation and DevTools integration via Chrome DevTools MCP. Runs in isolated mode.',
    appMcpServerName: 'chrome-devtools',
    enabled: false,
  },
  {
    kind: 'mcp_server',
    name: 'chrome-devtools-user-mcp',
    displayName: 'Chrome DevTools (your Chrome)',
    description:
      'Browser automation via Chrome DevTools MCP attached to the user’s own Chrome after its consent prompt. Sees the user’s logins; used by the Neo life-admin pack.',
    appMcpServerName: 'chrome-devtools-user',
    enabled: false,
  },
  {
    kind: 'builtin-command',
    name: 'playwright',
    displayName: 'Playwright',
    description: 'Browser automation and testing via Playwright.',
    commandName: 'playwright',
    enabled: true,
  },
  {
    kind: 'builtin-command',
    name: 'playwright-interactive',
    displayName: 'Playwright Interactive',
    description: 'Interactive browser automation via Playwright with step-by-step control.',
    commandName: 'playwright-interactive',
    enabled: true,
  },
  {
    kind: 'builtin-command',
    name: 'space-coordination',
    displayName: 'Space Coordination (POC)',
    description:
      'POC fallback for Space task/workflow coordination through local runtime APIs instead of MCP.',
    commandName: 'space-coordination',
    enabled: true,
    spaceOnly: true,
  },
] as const;
