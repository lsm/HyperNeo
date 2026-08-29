import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const RPC_TIMEOUT = 15_000;

const port = process.argv[2];
if (!port || !/^\d+$/.test(port)) {
  console.error('Usage: bun run scripts/seed-ui-demo.ts <port>');
  process.exit(1);
}

function rpcCall(ws: WebSocket, method: string, data: unknown = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timeout = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), RPC_TIMEOUT);
    const handler = (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string);
      if (msg.requestId === id || msg.id === id) {
        clearTimeout(timeout);
        ws.removeEventListener('message', handler);
        if (msg.type === 'RSP' && msg.error) {
          reject(new Error(`${method}: ${msg.error}`));
        } else {
          resolve(msg.data);
        }
      }
    };
    ws.addEventListener('message', handler);
    ws.send(
      JSON.stringify({
        id,
        type: 'REQ',
        sessionId: 'global',
        method,
        data,
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      })
    );
  });
}

function connectWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('WebSocket connection timed out')),
      RPC_TIMEOUT
    );
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('WebSocket error'));
    });
  });
}

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let messageSeq = 0;
const nextUuid = (prefix: string): string =>
  `${prefix}-${(++messageSeq).toString().padStart(4, '0')}-${randomUUID().slice(0, 8)}`;

async function inject(
  ws: WebSocket,
  sessionId: string,
  message: Record<string, unknown>
): Promise<void> {
  await rpcCall(ws, 'test.injectSDKMessage', {
    sessionId,
    message: { ...message, uuid: message.uuid ?? nextUuid('m'), session_id: sessionId },
  });
}

const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content },
  parent_tool_use_id: null,
  ...extra,
});

const userToolResult = (
  toolUseId: string,
  content: unknown,
  isError = false
): Record<string, unknown> => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
  },
  parent_tool_use_id: null,
});

const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', content },
  parent_tool_use_id: null,
  ...extra,
});

const system = (subtype: string, extra: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype,
  ...extra,
});

const resultSuccess = (result: string, extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 8421,
  duration_api_ms: 7300,
  num_turns: 6,
  result,
  stop_reason: 'end_turn',
  total_cost_usd: 0.0241,
  usage: {
    input_tokens: 12400,
    output_tokens: 1830,
    cache_read_input_tokens: 42100,
    cache_creation_input_tokens: 2900,
  },
  modelUsage: {
    'claude-sonnet-4': {
      inputTokens: 9800,
      outputTokens: 1510,
      cacheReadInputTokens: 42100,
      cacheCreationInputTokens: 2900,
      costUSD: 0.0212,
      contextWindow: 200000,
    },
  },
  permission_denials: [],
  ...extra,
});

const resultError = (subtype: string, errors: string[], extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype,
  is_error: true,
  duration_ms: 41230,
  duration_api_ms: 39100,
  num_turns: 32,
  result: '',
  total_cost_usd: 0.1877,
  usage: { input_tokens: 98200, output_tokens: 12400 },
  modelUsage: {},
  permission_denials: [
    { tool_name: 'Bash', tool_use_id: nextUuid('toolu') },
    { tool_name: 'Write', tool_use_id: nextUuid('toolu') },
  ],
  errors,
  ...extra,
});

async function createSession(ws: WebSocket, title: string, spaceId?: string): Promise<string> {
  const res = await rpcCall(ws, 'session.create', {
    workspacePath: WORKSPACE,
    title,
    createdBy: 'human',
    ...(spaceId ? { spaceId } : {}),
  });
  return res.sessionId as string;
}

const RAW_WORKSPACE = '/tmp/hyperneo-ui-demo-ws';
if (!existsSync(RAW_WORKSPACE)) {
  mkdirSync(RAW_WORKSPACE, { recursive: true });
  execSync('git init -q', { cwd: RAW_WORKSPACE });
  execSync('git commit -q --allow-empty -m init', { cwd: RAW_WORKSPACE });
}
const WORKSPACE = realpathSync(RAW_WORKSPACE);

const SEED_SESSION_TITLES = [
  'Markdown & rendering showcase',
  'Tool calls, errors & system events',
  'Rate-limited recovery',
  'Streaming refactor (live)',
  'Archived deps upgrade (done)',
  'Screenshot attachment',
  'Glass panel polish',
  'Token naming review',
  'Baseline re-run',
  'sdk migration worker',
];
const SEED_SPACE_NAME = 'Aurora Design System';

const ws = await connectWebSocket(`ws://localhost:${port}/ws`);

const health = await rpcCall(ws, 'system.health');
if (health?.status !== 'ok') {
  throw new Error(`Daemon health check failed: ${JSON.stringify(health)}`);
}

async function cleanupPreviousRun(): Promise<void> {
  const spacesRes = await rpcCall(ws, 'space.list', { includeArchived: true });
  const spaces = Array.isArray(spacesRes) ? spacesRes : (spacesRes?.spaces ?? []);
  for (const space of spaces) {
    if (space.name === SEED_SPACE_NAME && space.workspacePath === WORKSPACE) {
      try {
        await rpcCall(ws, 'space.delete', { id: space.id });
      } catch (error) {
        console.error(`space.delete ${space.id} failed: ${String(error)}`);
      }
    }
  }
  const sessionsRes = await rpcCall(ws, 'session.list', { includeArchived: true });
  const sessions = Array.isArray(sessionsRes) ? sessionsRes : (sessionsRes?.sessions ?? []);
  for (const session of sessions) {
    if (SEED_SESSION_TITLES.includes(session.title) && session.workspacePath === WORKSPACE) {
      try {
        await rpcCall(ws, 'session.delete', { sessionId: session.id });
      } catch (error) {
        console.error(`session.delete ${session.id} failed: ${String(error)}`);
      }
    }
  }
}

await cleanupPreviousRun();

async function seedMarkdownShowcase(ws: WebSocket): Promise<string> {
  const sessionId = await createSession(ws, 'Markdown & rendering showcase');

  await inject(
    ws,
    sessionId,
    system('init', {
      model: 'claude-sonnet-4',
      cwd: WORKSPACE,
      tools: ['Read', 'Bash', 'Edit'],
      mcp_servers: [],
      slash_commands: [],
    })
  );
  await inject(
    ws,
    sessionId,
    user('Show me everything markdown can render — headings, tables, code, math, diagrams.')
  );

  const markdown = [
    '# Headings render themed',
    '',
    'Text with **bold**, *italic*, `inline code`, and a [link](https://example.com).',
    '',
    '> Blockquotes get the theme border treatment.',
    '',
    '## Tables',
    '',
    '| Token | Light | Dark |',
    '| --- | --- | --- |',
    '| `--bg` | `#e9e9ec` | `#0a0a0b` |',
    '| `--accent` | `#4f46e5` | `#6366f1` |',
    '',
    '## Code blocks',
    '',
    '```ts',
    'export const theme = { bg: "var(--bg)", fg: "var(--fg)" } satisfies Theme;',
    '```',
    '',
    '```python',
    'def luminance(oklch: float) -> float:',
    '    return oklch ** 2',
    '```',
    '',
    '```bash',
    'bun run check:raw-palette',
    '```',
    '',
    '## Math',
    '',
    'Inline $E = mc^2$ and display:',
    '',
    '$$\\int_0^1 x^2\\,dx = \\tfrac{1}{3}$$',
    '',
    '## Diagram',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[Boot script] --> B{data-theme}',
    '  B -->|dark| C[Dark tokens]',
    '  B -->|light| D[Light tokens]',
    '```',
    '',
    '- [x] Checkboxes',
    '- [ ] Render in both themes',
    '',
    '1. Ordered lists',
    '2. Also work',
  ].join('\n');

  await inject(ws, sessionId, assistant([{ type: 'text', text: markdown }]));
  await inject(ws, sessionId, resultSuccess('Rendered the full markdown showcase.'));
  await rpcCall(ws, 'session.update', {
    sessionId,
    metadata: {
      messageCount: 4,
      totalTokens: 5100,
      inputTokens: 4200,
      outputTokens: 900,
      totalCost: 0.024,
      toolCallCount: 0,
    },
  });
  return sessionId;
}

async function seedToolGallery(ws: WebSocket): Promise<string> {
  const sessionId = await createSession(ws, 'Tool calls, errors & system events');
  await inject(
    ws,
    sessionId,
    system('init', {
      model: 'claude-sonnet-4',
      cwd: WORKSPACE,
      tools: ['Read', 'Grep', 'Bash', 'Edit', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task'],
      mcp_servers: [{ name: 'github', status: 'connected' }],
      slash_commands: [],
    })
  );
  await inject(ws, sessionId, user('Exercise every tool and system message type.'));

  await inject(
    ws,
    sessionId,
    assistant([
      {
        type: 'thinking',
        thinking:
          'The user wants a tour of tool rendering. I will call each tool category once, then surface a couple of error states.',
        signature: 'sig1',
      },
      { type: 'text', text: 'Running the tour — starting with file reads.' },
    ])
  );

  const readId = nextUuid('toolu');
  await inject(
    ws,
    sessionId,
    assistant([
      { type: 'tool_use', id: readId, name: 'Read', input: { file_path: 'src/theme.ts' } },
    ])
  );
  await inject(
    ws,
    sessionId,
    userToolResult(
      readId,
      '     1\texport const tokens = {\n     2\t  bg: "var(--bg)",\n     3\t  fg: "var(--fg)",\n     4\t};\n     5\t'
    )
  );

  const grepId = nextUuid('toolu');
  await inject(
    ws,
    sessionId,
    assistant([
      {
        type: 'tool_use',
        id: grepId,
        name: 'Grep',
        input: { pattern: 'var\\(--', path: 'src', output_mode: 'content' },
      },
    ])
  );
  await inject(
    ws,
    sessionId,
    userToolResult(
      grepId,
      'src/theme.ts:2:  bg: "var(--bg)",\nsrc/theme.ts:3:  fg: "var(--fg)",\nsrc/styles.css:114:  --glass-bg: rgb(17 17 19 / 0.7);'
    )
  );

  const bashId = nextUuid('toolu');
  await inject(
    ws,
    sessionId,
    assistant([
      {
        type: 'tool_use',
        id: bashId,
        name: 'Bash',
        input: { command: 'bun run check:raw-palette', description: 'Run the palette ratchet' },
      },
    ])
  );
  await inject(ws, sessionId, userToolResult(bashId, 'raw palette utilities: 358 (baseline 358)'));

  const bashErrId = nextUuid('toolu');
  await inject(
    ws,
    sessionId,
    assistant([
      {
        type: 'tool_use',
        id: bashErrId,
        name: 'Bash',
        input: { command: 'bun test --dry-run', description: 'Failing command' },
      },
    ])
  );
  await inject(
    ws,
    sessionId,
    userToolResult(
      bashErrId,
      'error: script "test" exits with a guard message\nhusky > commit-msg hook failed',
      true
    )
  );

  const editId = nextUuid('toolu');
  await inject(
    ws,
    sessionId,
    assistant([
      {
        type: 'tool_use',
        id: editId,
        name: 'Edit',
        input: {
          file_path: 'src/theme.ts',
          old_string: 'bg: "var(--bg)"',
          new_string: 'bg: "var(--bg)",\n  surface: "var(--surface)"',
        },
      },
    ])
  );
  await inject(
    ws,
    sessionId,
    userToolResult(editId, {
      type: 'text',
      file: {
        filePath: 'src/theme.ts',
        oldString: 'bg: "var(--bg)"',
        newString: 'bg: "var(--bg)",\n  surface: "var(--surface)"',
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-', '+', '+'] },
        ],
      },
    })
  );

  const webFetchId = nextUuid('toolu');
  await inject(
    ws,
    sessionId,
    assistant([
      {
        type: 'tool_use',
        id: webFetchId,
        name: 'WebFetch',
        input: { url: 'https://tailwindcss.com/docs/theme', prompt: 'Summarize @theme inline' },
      },
    ])
  );
  await inject(
    ws,
    sessionId,
    userToolResult(
      webFetchId,
      'The file tailwindcss.com/docs/theme summarizes: theme variables generate utilities; inline resolves vars at use-site.'
    )
  );

  const webSearchId = nextUuid('toolu');
  await inject(
    ws,
    sessionId,
    assistant([
      {
        type: 'tool_use',
        id: webSearchId,
        name: 'WebSearch',
        input: { query: 'tailwind v4 multi-theme data attribute' },
      },
    ])
  );
  await inject(
    ws,
    sessionId,
    userToolResult(
      webSearchId,
      'Results: tailwindcss.com/docs/dark-mode, simonswiss.com multi-theme strategy, github discussion 18471.'
    )
  );

  const todoId = nextUuid('toolu');
  await inject(
    ws,
    sessionId,
    assistant([
      {
        type: 'tool_use',
        id: todoId,
        name: 'TodoWrite',
        input: {
          todos: [
            { content: 'Migrate neutrals', status: 'completed', activeForm: 'Migrating neutrals' },
            {
              content: 'Collapse dark: pairs',
              status: 'in_progress',
              activeForm: 'Collapsing dark: pairs',
            },
            {
              content: 'Ratchet baseline to zero',
              status: 'pending',
              activeForm: 'Ratcheting baseline',
            },
          ],
        },
      },
    ])
  );
  await inject(ws, sessionId, userToolResult(todoId, 'Todos have been modified successfully.'));

  const mcpId = nextUuid('toolu');
  await inject(
    ws,
    sessionId,
    assistant([
      {
        type: 'tool_use',
        id: mcpId,
        name: 'mcp__github__get_pull_request',
        input: { owner: 'acme', repo: 'app', pull_number: 3285 },
      },
    ])
  );
  await inject(
    ws,
    sessionId,
    userToolResult(mcpId, '{"title": "feat(web): theme system", "state": "open", "reviews": 1}')
  );

  const subagentToolId = nextUuid('toolu');
  await inject(
    ws,
    sessionId,
    assistant([
      { type: 'text', text: 'Delegating the audit to a subagent.' },
      {
        type: 'tool_use',
        id: subagentToolId,
        name: 'Task',
        input: {
          description: 'Audit token coverage',
          prompt: 'Audit remaining raw palette utilities and report counts per area.',
          subagent_type: 'general-purpose',
        },
      },
    ])
  );
  await inject(
    ws,
    sessionId,
    assistant([{ type: 'text', text: 'Auditing now. First grepping the space components.' }], {
      parent_tool_use_id: subagentToolId,
      subagent_type: 'general-purpose',
    })
  );
  const nestedReadId = nextUuid('toolu');
  await inject(
    ws,
    sessionId,
    assistant(
      [
        {
          type: 'tool_use',
          id: nestedReadId,
          name: 'Read',
          input: { file_path: 'SpaceTasks.tsx' },
        },
      ],
      { parent_tool_use_id: subagentToolId }
    )
  );
  await inject(
    ws,
    sessionId,
    userToolResult(
      nestedReadId,
      '     1\texport function SpaceTasks() {\n     2\t  return null;\n     3\t}\n'
    )
  );
  await inject(
    ws,
    sessionId,
    assistant(
      [
        {
          type: 'text',
          text: 'Audit complete: 358 raw utilities remain, concentrated in space visuals and provider brand colors.',
        },
      ],
      { parent_tool_use_id: subagentToolId }
    )
  );
  await inject(
    ws,
    sessionId,
    system('task_notification', {
      task_id: subagentToolId,
      tool_use_id: subagentToolId,
      status: 'completed',
      output_file: '/tmp/audit.md',
      summary: '358 raw utilities remain across 9 areas.',
    })
  );

  const inFlightId = nextUuid('toolu');
  await inject(
    ws,
    sessionId,
    assistant([
      {
        type: 'tool_use',
        id: inFlightId,
        name: 'Bash',
        input: { command: 'bun run check', description: 'Long full check' },
      },
    ])
  );
  await inject(ws, sessionId, {
    type: 'tool_progress',
    tool_use_id: inFlightId,
    tool_name: 'Bash',
    parent_tool_use_id: null,
    elapsed_time_seconds: 14,
    data: { status: 'running' },
  });

  await inject(
    ws,
    sessionId,
    system('permission_denied', {
      tool_name: 'Write',
      tool_use_id: nextUuid('toolu'),
      message: 'Permission to write .env was denied',
      decision_reason_type: 'other',
      decision_reason: 'Protected file',
      agent_id: undefined,
    })
  );
  await inject(
    ws,
    sessionId,
    system('memory_recall', {
      mode: 'select',
      memories: [
        { path: 'CLAUDE.md', scope: 'project', content: 'PRs target dev directly' },
        { path: 'team/conventions.md', scope: 'team' },
      ],
    })
  );
  await inject(
    ws,
    sessionId,
    system('hook_started', { hook_id: 'h1', hook_name: 'format', hook_event: 'PostToolUse' })
  );
  await inject(
    ws,
    sessionId,
    system('hook_progress', {
      hook_id: 'h1',
      hook_name: 'format',
      hook_event: 'PostToolUse',
      stdout: 'Checked 2 files\n',
      stderr: '',
      output: '',
    })
  );
  await inject(
    ws,
    sessionId,
    system('hook_response', {
      hook_id: 'h1',
      hook_name: 'format',
      hook_event: 'PostToolUse',
      exit_code: 0,
      outcome: 'success',
      output: 'Formatted 2 files',
    })
  );
  await inject(
    ws,
    sessionId,
    system('hook_response', {
      hook_id: 'h2',
      hook_name: 'typecheck',
      hook_event: 'PreToolUse',
      exit_code: 2,
      outcome: 'error',
      output: 'tsc: 1 error',
      stderr: 'src/theme.ts(9,3): error TS2322',
    })
  );

  await inject(
    ws,
    sessionId,
    system('notification', {
      key: 'n-low',
      text: 'Context is at 62% — consider compacting soon.',
      priority: 'low',
      timeout_ms: 8000,
    })
  );
  await inject(
    ws,
    sessionId,
    system('notification', {
      key: 'n-medium',
      text: 'Checkpoint saved before refactor.',
      priority: 'medium',
      timeout_ms: 8000,
    })
  );
  await inject(
    ws,
    sessionId,
    system('notification', {
      key: 'n-high',
      text: 'Branch protection blocked the direct push to dev.',
      priority: 'high',
      timeout_ms: 8000,
    })
  );
  await inject(
    ws,
    sessionId,
    system('notification', {
      key: 'n-immediate',
      text: 'Provider credentials expired — sessions will fail until re-auth.',
      priority: 'immediate',
      timeout_ms: 8000,
    })
  );

  await inject(
    ws,
    sessionId,
    system('api_retry', {
      attempt: 2,
      max_retries: 10,
      retry_delay_ms: 4000,
      error_status: 429,
      error: 'rate_limit',
    })
  );
  await inject(
    ws,
    sessionId,
    system('informational', {
      content: 'The API is under heavy load; responses may be slower than usual.',
      level: 'warning',
    })
  );
  await inject(
    ws,
    sessionId,
    system('informational', {
      content: 'Consider splitting large files into modules.',
      level: 'suggestion',
    })
  );
  await inject(
    ws,
    sessionId,
    system('compact_boundary', {
      compact_metadata: { trigger: 'auto', pre_tokens: 158000, post_tokens: 22000 },
    })
  );
  await inject(
    ws,
    sessionId,
    system('files_persisted', {
      files: [],
      failed: [{ filename: 'dist/bundle.js', error: 'File exceeds 32MB limit' }],
    })
  );
  await inject(
    ws,
    sessionId,
    system('model_refusal_fallback', {
      api_refusal_category: 'unsafe-content',
      api_refusal_explanation: 'Fallback engaged after refusal',
    })
  );

  await inject(
    ws,
    sessionId,
    assistant([{ type: 'text', text: 'Retrying after the rate limit window…' }], {
      error: 'rate_limit',
    })
  );
  await inject(
    ws,
    sessionId,
    user('<local-command-stdout>3285 issues, 42 open, 0 stale</local-command-stdout>', {
      isReplay: true,
    })
  );
  await inject(
    ws,
    sessionId,
    user(
      '<local-command-stderr>Error: 429 {"error":{"message":"rate limited","type":"rate_limit_error"}}</local-command-stderr>',
      { isReplay: true }
    )
  );
  await inject(ws, sessionId, {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed_warning',
      resetsAt: Date.now() + 42_000,
      utilization: 0.88,
      windowMinutes: 5,
      rateLimitK_pct: 72,
    },
  });
  await inject(ws, sessionId, {
    type: 'auth_status',
    isAuthenticating: true,
    output: ['Waiting for OAuth flow to complete in browser…'],
  });

  const askId = nextUuid('toolu');
  await inject(
    ws,
    sessionId,
    assistant([
      { type: 'text', text: 'One decision before I finish:' },
      {
        type: 'tool_use',
        id: askId,
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'How should we ship the light theme?',
              header: 'Rollout',
              multiSelect: false,
              options: [
                {
                  label: 'Feature flag (Recommended)',
                  description: 'Ship dark-only behind default, flip after QA',
                },
                {
                  label: 'Direct cutover',
                  description: 'Light becomes available immediately in Settings',
                },
                {
                  label: 'Beta channel',
                  description: 'Opt-in toggle in Appearance for early users',
                },
              ],
            },
          ],
        },
      },
    ])
  );
  await inject(
    ws,
    sessionId,
    resultError('error_max_turns', [
      'Maximum turns (32) reached before completing the audit.',
      'The final codemod pass did not run.',
    ])
  );

  await rpcCall(ws, 'session.update', {
    sessionId,
    processingState: JSON.stringify({
      status: 'waiting_for_input',
      pendingQuestion: { toolUseId: askId },
    }),
    metadata: {
      messageCount: 28,
      totalTokens: 98200,
      inputTokens: 86000,
      outputTokens: 12200,
      totalCost: 0.21,
      toolCallCount: 12,
    },
  });
  return sessionId;
}

async function seedErrorSession(ws: WebSocket): Promise<string> {
  const sessionId = await createSession(ws, 'Rate-limited recovery');
  await inject(ws, sessionId, user('Regenerate the migration report.'));
  await inject(ws, sessionId, assistant([{ type: 'text', text: 'Pulling usage numbers first…' }]));
  await inject(
    ws,
    sessionId,
    system('api_retry', {
      attempt: 4,
      max_retries: 10,
      retry_delay_ms: 32000,
      error_status: 529,
      error: 'overloaded',
    })
  );
  await inject(
    ws,
    sessionId,
    assistant([{ type: 'text', text: 'Provider overloaded — backing off.' }], {
      error: 'overloaded',
    })
  );
  await inject(ws, sessionId, {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      resetsAt: Date.now() + 120_000,
      utilization: 1.0,
      windowMinutes: 5,
      rateLimitK_pct: 100,
    },
  });
  await inject(
    ws,
    sessionId,
    resultError('error_during_execution', ['Provider API returned 529 overloaded three times.'])
  );
  await rpcCall(ws, 'session.update', {
    sessionId,
    processingState: JSON.stringify({
      status: 'rate_limit_cooldown',
      retryCount: 4,
      maxRetries: 10,
      retryAt: Date.now() + 120_000,
    }),
    metadata: {
      messageCount: 6,
      totalTokens: 9800,
      inputTokens: 8100,
      outputTokens: 1700,
      totalCost: 0.04,
      toolCallCount: 0,
    },
  });
  return sessionId;
}

async function seedRunningSession(ws: WebSocket): Promise<string> {
  const sessionId = await createSession(ws, 'Streaming refactor (live)');
  await inject(ws, sessionId, user('Refactor the SettingsSection primitives.'));
  await inject(
    ws,
    sessionId,
    assistant([{ type: 'text', text: 'On it — reading the primitives first.' }])
  );
  const readId = nextUuid('toolu');
  await inject(
    ws,
    sessionId,
    assistant([
      { type: 'tool_use', id: readId, name: 'Read', input: { file_path: 'SettingsSection.tsx' } },
    ])
  );
  await inject(
    ws,
    sessionId,
    userToolResult(
      readId,
      '     1\texport function SettingsSection() {\n     2\t  return null;\n     3\t}\n'
    )
  );
  await inject(
    ws,
    sessionId,
    assistant([{ type: 'text', text: 'Refactor underway: extracting the row select next…' }])
  );
  await rpcCall(ws, 'session.update', {
    sessionId,
    processingState: JSON.stringify({
      status: 'processing',
      messageId: 'live-1',
      phase: 'streaming',
      streamingStartedAt: Date.now() - 9000,
    }),
    metadata: {
      messageCount: 5,
      totalTokens: 6400,
      inputTokens: 5300,
      outputTokens: 1100,
      totalCost: 0.03,
      toolCallCount: 1,
    },
  });
  return sessionId;
}

async function seedEndedSession(ws: WebSocket): Promise<string> {
  const sessionId = await createSession(ws, 'Archived deps upgrade (done)');
  await inject(ws, sessionId, user('Upgrade biome to 2.4.'));
  await inject(
    ws,
    sessionId,
    assistant([{ type: 'text', text: 'Upgraded and reformatted 632 files; all checks green.' }])
  );
  await inject(
    ws,
    sessionId,
    resultSuccess('biome 2.4.16 applied, 632 files formatted, CI green.')
  );
  await rpcCall(ws, 'session.update', {
    sessionId,
    status: 'ended',
    metadata: {
      messageCount: 3,
      totalTokens: 2400,
      inputTokens: 1900,
      outputTokens: 500,
      totalCost: 0.01,
      toolCallCount: 0,
    },
  });
  return sessionId;
}

async function seedImageSession(ws: WebSocket): Promise<string> {
  const sessionId = await createSession(ws, 'Screenshot attachment');
  await inject(
    ws,
    sessionId,
    user([
      { type: 'text', text: 'This button looks off in light mode:' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG } },
    ])
  );
  await inject(
    ws,
    sessionId,
    assistant([
      {
        type: 'text',
        text: 'Thanks — the button uses `text-white` instead of `text-accent-fg`, so it breaks on light surfaces. Fixed in the next commit.',
      },
    ])
  );
  await inject(ws, sessionId, resultSuccess('Diagnosed the hardcoded white text.'));
  await rpcCall(ws, 'session.update', {
    sessionId,
    metadata: {
      messageCount: 3,
      totalTokens: 1800,
      inputTokens: 1400,
      outputTokens: 400,
      totalCost: 0.008,
      toolCallCount: 0,
    },
  });
  return sessionId;
}

async function seedSpace(ws: WebSocket): Promise<{ spaceId: string; taskIds: string[] }> {
  const space = await rpcCall(ws, 'space.create', {
    workspacePath: WORKSPACE,
    name: 'Aurora Design System',
    description: 'Single-CSS design tokens across web and desktop shells.',
    backgroundContext: 'Tailwind v4 CSS-first config; tokens live in packages/web/src/styles.css.',
    autonomyLevel: 3,
    maxConcurrentTasks: 4,
  });
  const spaceId = space.id as string;

  const mk = (title: string, description: string, priority: string, labels: string[]) =>
    rpcCall(ws, 'spaceTask.create', { spaceId, title, description, priority, labels }).then(
      (t) => t.id as string
    );

  const t1 = await mk(
    'Scaffold two-layer token architecture',
    'Layer-1 per-theme vars plus @theme inline namespace in styles.css.',
    'urgent',
    ['tokens', 'foundation']
  );
  const t2 = await mk(
    'Extract glass workspace classes',
    'Move GLASS_* constants into .glass-* CSS classes driven by --glass-* vars.',
    'high',
    ['space', 'css']
  );
  const t3 = await mk(
    'Migrate sdk components',
    'Collapse ~450 light/dark pairs into semantic tokens.',
    'high',
    ['sdk', 'migration']
  );
  const t4 = await mk(
    'Codemod + ratchet tooling',
    'codemod-theme.ts and check-raw-palette.ts wired into the check chain.',
    'normal',
    ['tooling']
  );
  const t5 = await mk(
    'Retire TS token modules',
    'Delete design-tokens.ts / indicator-tokens.ts after inlining.',
    'normal',
    ['cleanup']
  );
  const t6 = await mk(
    'Light-theme QA sweep',
    'Manual pass over chat, settings, space in light mode.',
    'low',
    ['qa']
  );
  const t7 = await mk(
    'Mermaid theme-aware init',
    'Re-initialize mermaid per resolved theme and re-render.',
    'normal',
    ['chat']
  );
  const t8 = await mk(
    'Provider brand one-offs',
    'Allowlist remaining brand hex values with reasons.',
    'low',
    ['tokens', 'debt']
  );
  const t9 = await mk(
    'E2E: theme switch persistence',
    'Playwright spec for light/dark/system across reload.',
    'normal',
    ['e2e']
  );

  await rpcCall(ws, 'spaceTask.update', {
    spaceId,
    taskId: t1,
    status: 'done',
    result: 'Two-layer architecture merged in c0151cbd23.',
  });
  await rpcCall(ws, 'spaceTask.update', {
    spaceId,
    taskId: t2,
    status: 'done',
    result: 'Glass classes extracted; dark output unchanged.',
  });
  await rpcCall(ws, 'spaceTask.update', { spaceId, taskId: t3, status: 'in_progress' });
  await rpcCall(ws, 'spaceTask.submitForReview', {
    spaceId,
    taskId: t4,
    reason: 'Ratchet at 358, wired into root check.',
  });
  await rpcCall(ws, 'spaceTask.approvePendingCompletion', {
    spaceId,
    taskId: t4,
    approved: true,
    reason: 'Solid tooling.',
  });
  await rpcCall(ws, 'spaceTask.submitForReview', {
    spaceId,
    taskId: t5,
    reason: 'Modules deleted; all consumers inlined. Ready for review.',
  });
  await rpcCall(ws, 'spaceTask.update', { spaceId, taskId: t6, status: 'in_progress' });
  await rpcCall(ws, 'spaceTask.update', { spaceId, taskId: t6, status: 'stopped' });
  await rpcCall(ws, 'spaceTask.update', {
    spaceId,
    taskId: t7,
    status: 'done',
    result: 'Mermaid re-inits per theme; markdown re-renders on switch.',
  });
  await rpcCall(ws, 'spaceTask.update', {
    spaceId,
    taskId: t8,
    status: 'blocked',
    blockReason: 'human_input_requested',
  });
  await rpcCall(ws, 'spaceTask.update', { spaceId, taskId: t9, dependsOn: [t6] });

  const agentsRes = await rpcCall(ws, 'spaceAgent.list', { spaceId });
  const agents = (Array.isArray(agentsRes) ? agentsRes : (agentsRes?.agents ?? [])) as Array<{
    id: string;
    name: string;
  }>;
  const nodeAgent = (index: number) =>
    agents[index % Math.max(agents.length, 1)] ?? { id: 'unknown', name: 'Coder' };
  const first = nodeAgent(0);
  const second = nodeAgent(1 % Math.max(agents.length, 1));
  const third = nodeAgent(2 % Math.max(agents.length, 1));

  await rpcCall(ws, 'spaceWorkflow.create', {
    spaceId,
    name: 'Token migration pipeline',
    description: 'Codemod, verify, tighten baseline per area.',
    handle: 'token-migration',
    tags: ['tokens'],
    nodes: [
      {
        id: 'codemod',
        name: 'Codemod',
        agents: [{ agentId: first.id, name: first.name }],
        transitions: [{ id: 't1', target: 'Verify', label: 'done' }],
      },
      {
        id: 'verify',
        name: 'Verify',
        agents: [{ agentId: second.id, name: second.name }],
        transitions: [{ id: 't2', target: 'Tighten baseline', label: 'green' }],
      },
      {
        id: 'ratchet',
        name: 'Tighten baseline',
        agents: [{ agentId: third.id, name: third.name }],
      },
    ],
    startNodeId: 'codemod',
    endNodeId: 'ratchet',
  });
  await rpcCall(ws, 'spaceWorkflow.create', {
    spaceId,
    name: 'Light-theme QA loop',
    description: 'Screenshot compare, triage drift, file follow-ups.',
    handle: 'light-qa',
    tags: ['qa', 'theming'],
    nodes: [
      {
        id: 'capture',
        name: 'Capture screenshots',
        agents: [{ agentId: first.id, name: first.name }],
        transitions: [{ id: 't1', target: 'Triage drift', label: 'captured' }],
      },
      { id: 'triage', name: 'Triage drift', agents: [{ agentId: second.id, name: second.name }] },
    ],
    startNodeId: 'capture',
    endNodeId: 'triage',
  });

  await rpcCall(ws, 'spaceGoal.create', {
    spaceId,
    title: 'Zero raw palette utilities',
    description: 'Drive the ratchet baseline to intentional one-offs only.',
    type: 'measurable',
    priority: 'high',
    labels: ['theming'],
    metrics: { rawPaletteCount: 358 },
    progress: 95,
    summary: '7277 → 358 raw utilities; remaining are brand one-offs pending allowlist.',
    nextSteps: ['Allowlist provider brand colors', 'Ratchet components/space to zero'],
  });
  await rpcCall(ws, 'spaceGoal.create', {
    spaceId,
    title: 'Weekly theme regression check',
    description: 'Recurring screenshot diff across both themes.',
    type: 'recurring',
    priority: 'normal',
    checkInCronExpression: '0 9 * * 1',
    checkInTimezone: 'America/New_York',
  });

  await rpcCall(ws, 'spaceLongHorizonAgent.create', {
    spaceId,
    handle: 'palette-warden',
    displayName: 'Palette Warden',
    instructions:
      'Watch PRs for new raw palette utilities and nudge authors toward semantic tokens.',
    autonomyLevel: 3,
  });

  const scope = await rpcCall(ws, 'evolution.scope.create', {
    params: {
      spaceId,
      kind: 'project',
      name: 'Single-CSS theming',
      objective: 'One CSS file drives the entire app look-and-feel across themes.',
      metricDefinitions: [
        { key: 'rawPalette', label: 'Raw palette utilities', direction: 'decrease', unit: 'count' },
        {
          key: 'themedComponents',
          label: 'Token-only components',
          direction: 'increase',
          unit: '%',
        },
      ],
    },
  });
  await rpcCall(ws, 'evolution.evidence.addManualNote', {
    scopeId: scope.scope.id,
    summary: 'Migration landed: 95% of raw palette utilities replaced across 605 files.',
  });
  await rpcCall(ws, 'evolution.evidence.addMetricSnapshot', {
    scopeId: scope.scope.id,
    values: { rawPalette: 358, themedComponents: 95 },
    source: 'manual',
    note: 'Post-migration baseline.',
  });

  await rpcCall(ws, 'agentMemory.write', {
    spaceId,
    key: 'token-conventions',
    content:
      'Use bg-surface/text-fg-muted/border-line; cat-* hues for categorical; never raw gray-*/blue-*.',
    tags: ['theming', 'conventions'],
  });
  await rpcCall(ws, 'agentMemory.write', {
    spaceId,
    key: 'ratchet-workflow',
    content:
      'Run scripts/codemod-theme.ts per area, tighten raw-palette-baseline.json in the same PR.',
    tags: ['tooling'],
  });

  const runningSession = await createSession(ws, 'Glass panel polish', spaceId);
  await inject(
    ws,
    runningSession,
    user('The amber primary button needs a softer shadow in light mode.')
  );
  await inject(
    ws,
    runningSession,
    assistant([{ type: 'text', text: 'Tuning --glass-accent-shadow for the light block now.' }])
  );
  await rpcCall(ws, 'session.update', {
    sessionId: runningSession,
    processingState: JSON.stringify({ status: 'processing', messageId: 'g1', phase: 'thinking' }),
  });

  const waitingSession = await createSession(ws, 'Token naming review', spaceId);
  await inject(ws, waitingSession, user('Should categorical hues be cat-* or hue-*?'));
  await inject(
    ws,
    waitingSession,
    assistant([
      {
        type: 'text',
        text: 'I would keep cat-* — shorter and greppable. Your call before I rename.',
      },
    ])
  );
  await rpcCall(ws, 'session.update', {
    sessionId: waitingSession,
    processingState: JSON.stringify({ status: 'waiting_for_input' }),
  });

  const endedSession = await createSession(ws, 'Baseline re-run', spaceId);
  await inject(ws, endedSession, user('Re-run the raw palette count.'));
  await inject(
    ws,
    endedSession,
    assistant([{ type: 'text', text: '358 across 10 areas; baseline matches.' }])
  );
  await rpcCall(ws, 'session.update', { sessionId: endedSession, status: 'ended' });

  const taskAgent = await createSession(ws, 'sdk migration worker', spaceId);
  await rpcCall(ws, 'session.update', {
    sessionId: taskAgent,
    type: 'space_task_agent',
    context: { spaceId, taskId: t3 },
  });
  await inject(
    ws,
    taskAgent,
    system('init', {
      model: 'claude-sonnet-4',
      cwd: WORKSPACE,
      tools: ['Read', 'Grep', 'Bash'],
      mcp_servers: [],
      slash_commands: [],
    })
  );
  await inject(
    ws,
    taskAgent,
    assistant([
      { type: 'text', text: 'Starting the sdk sweep: collapsing light/dark pairs per component.' },
    ])
  );
  const tRead = nextUuid('toolu');
  await inject(
    ws,
    taskAgent,
    assistant([
      {
        type: 'tool_use',
        id: tRead,
        name: 'Bash',
        input: {
          command: 'grep -rc "dark:" src/components/sdk | head',
          description: 'Count dark: pairs',
        },
      },
    ])
  );
  await inject(
    ws,
    taskAgent,
    userToolResult(tRead, 'SDKSystemMessage.tsx:12\nToolResultCard.tsx:8\nTodoViewer.tsx:5')
  );
  await inject(
    ws,
    taskAgent,
    assistant([
      {
        type: 'text',
        text: 'Pairs collapsed in the three heaviest files; moving to the tool viewers next.',
      },
    ])
  );

  return { spaceId, taskIds: [t1, t2, t3, t4, t5, t6, t7, t8, t9] };
}

const markdownSession = await seedMarkdownShowcase(ws);
const toolSession = await seedToolGallery(ws);
const rateLimitSession = await seedErrorSession(ws);
const runningSession = await seedRunningSession(ws);
const endedSession = await seedEndedSession(ws);
const imageSession = await seedImageSession(ws);
const space = await seedSpace(ws);

const sessionIds = [
  markdownSession,
  toolSession,
  rateLimitSession,
  runningSession,
  endedSession,
  imageSession,
];
const counts = await Promise.all(
  sessionIds.map((id) => rpcCall(ws, 'message.count', { sessionId: id }))
);
const tasksRes = await rpcCall(ws, 'spaceTask.list', { spaceId: space.spaceId });
const taskCount = (Array.isArray(tasksRes) ? tasksRes : (tasksRes?.tasks ?? [])).length;

console.log('Seeded UI demo data:');
for (const [i, id] of sessionIds.entries()) {
  console.log(`  chat session ${id} (${counts[i]?.count ?? 0} messages)`);
}
console.log(`  space ${space.spaceId} with ${taskCount} tasks`);
console.log(
  'Open http://localhost:' +
    port +
    ' — check the sidebar sessions, then the space pages (tasks/sessions/goals/forge/memories).'
);
ws.close();
