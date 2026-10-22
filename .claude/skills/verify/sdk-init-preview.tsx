import { render } from 'preact';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import { SDKSystemMessage } from '../../../packages/web/src/components/sdk/SDKSystemMessage.tsx';
import { SDKMessageRenderer } from '../../../packages/web/src/components/sdk/SDKMessageRenderer.tsx';
const message = {
  claude_code_version: 'synthetic', output_style: 'default', skills: [], plugins: [], type: 'system', subtype: 'init', uuid: 'synthetic-init', session_id: 'synthetic',
  model: 'synthetic-init-model', cwd: '/synthetic/project', permissionMode: 'default',
  tools: ['Read', 'Write'], mcp_servers: [{ name: 'synthetic-mcp', status: 'connected' }],
  agents: ['Explore'], slash_commands: ['help'], apiKeySource: 'user',
} as Extract<SDKMessage, { type: 'system'; subtype: 'init' }>;
render(<main class="p-4 space-y-4 text-fg bg-surface min-h-screen">
  <h1>Component-only initialization preview</h1>
  <p>These variants have no active app caller; this fixture is not a runtime journey.</p>
  <section aria-label="Direct component"><SDKSystemMessage message={message} /></section>
  <section aria-label="Gated component"><SDKMessageRenderer message={message} taskContext /></section>
</main>, document.getElementById('root')!);
