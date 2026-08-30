// @ts-nocheck
import { describe, it, expect } from 'vitest';

import { render } from '@testing-library/preact';
import { MessageInfoDropdown } from '../MessageInfoDropdown';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import type { UUID } from 'crypto';

const createUUID = (): UUID => crypto.randomUUID() as UUID;

function createSessionInfo(
  overrides: Partial<Extract<SDKMessage, { type: 'system'; subtype: 'init' }>> = {}
): Extract<SDKMessage, { type: 'system'; subtype: 'init' }> {
  return {
    type: 'system',
    subtype: 'init',
    agents: [],
    apiKeySource: 'user',
    betas: [],
    claude_code_version: '1.2.3',
    cwd: '/home/user/project',
    tools: ['Read', 'Write', 'Bash', 'Glob', 'Grep'],
    mcp_servers: [],
    model: 'claude-3-5-sonnet-20241022',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: createUUID(),
    session_id: 'test-session',
    ...overrides,
  };
}

describe('MessageInfoDropdown', () => {
  describe('Header', () => {
    it('should render "Session Started" header', () => {
      const sessionInfo = createSessionInfo();
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).toContain('Session Started');
    });

    it('should show simplified model name (without "claude-" prefix)', () => {
      const sessionInfo = createSessionInfo({
        model: 'claude-3-5-sonnet-20241022',
      });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).toContain('3-5-sonnet-20241022');
      expect(container.textContent).not.toContain('claude-claude');
    });

    it('should strip "anthropic." prefix from model name', () => {
      const sessionInfo = createSessionInfo({
        model: 'anthropic.claude-3-opus-20240229',
      });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).not.toContain('anthropic.');
    });

    it('should show permission mode', () => {
      const sessionInfo = createSessionInfo({ permissionMode: 'acceptEdits' });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).toContain('acceptEdits');
    });

    it('should have lightning bolt icon', () => {
      const sessionInfo = createSessionInfo();
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });
  });

  describe('Working Directory', () => {
    it('should display working directory when present', () => {
      const sessionInfo = createSessionInfo({
        cwd: '/home/user/my-project',
      });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).toContain('Working Directory');
      expect(container.textContent).toContain('/home/user/my-project');
    });

    it('should have monospace font for path', () => {
      const sessionInfo = createSessionInfo({ cwd: '/test/path' });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      const pathElement = container.querySelector('.font-mono');
      expect(pathElement).toBeTruthy();
      expect(pathElement?.textContent).toContain('/test/path');
    });
  });

  describe('Tools', () => {
    it('should display tools section with count', () => {
      const sessionInfo = createSessionInfo({
        tools: ['Read', 'Write', 'Bash'],
      });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).toContain('Tools (3)');
    });

    it('should list all tools', () => {
      const sessionInfo = createSessionInfo({
        tools: ['Read', 'Write', 'Bash', 'Glob', 'Grep'],
      });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).toContain('Read');
      expect(container.textContent).toContain('Write');
      expect(container.textContent).toContain('Bash');
      expect(container.textContent).toContain('Glob');
      expect(container.textContent).toContain('Grep');
    });

    it('should not show tools section when empty', () => {
      const sessionInfo = createSessionInfo({ tools: [] });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).not.toContain('Tools (0)');
    });
  });

  describe('MCP Servers', () => {
    it('should display MCP servers section with count', () => {
      const sessionInfo = createSessionInfo({
        mcp_servers: [
          { name: 'filesystem', status: 'connected' },
          { name: 'database', status: 'failed' },
        ],
      });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).toContain('MCP Servers (2)');
    });

    it('should list server names and statuses', () => {
      const sessionInfo = createSessionInfo({
        mcp_servers: [
          { name: 'filesystem', status: 'connected' },
          { name: 'database', status: 'failed' },
        ],
      });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).toContain('filesystem');
      expect(container.textContent).toContain('connected');
      expect(container.textContent).toContain('database');
      expect(container.textContent).toContain('failed');
    });

    it('should show green indicator for connected servers', () => {
      const sessionInfo = createSessionInfo({
        mcp_servers: [{ name: 'test', status: 'connected' }],
      });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.querySelector('.bg-success')).toBeTruthy();
    });

    it('should show gray indicator for non-connected servers', () => {
      const sessionInfo = createSessionInfo({
        mcp_servers: [{ name: 'test', status: 'failed' }],
      });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.querySelector('.bg-fg-faint')).toBeTruthy();
    });

    it('should not show MCP servers section when empty', () => {
      const sessionInfo = createSessionInfo({ mcp_servers: [] });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).not.toContain('MCP Servers');
    });
  });

  describe('Slash Commands', () => {
    it('should display slash commands section with count', () => {
      const sessionInfo = createSessionInfo({
        slash_commands: ['help', 'clear', 'compact'],
      });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).toContain('Slash Commands (3)');
    });

    it('should list commands with leading slash', () => {
      const sessionInfo = createSessionInfo({
        slash_commands: ['help', 'clear', 'compact'],
      });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).toContain('/help');
      expect(container.textContent).toContain('/clear');
      expect(container.textContent).toContain('/compact');
    });

    it('should have monospace font for commands', () => {
      const sessionInfo = createSessionInfo({
        slash_commands: ['help'],
      });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      const cmdElement = container.querySelector('.font-mono');
      expect(cmdElement).toBeTruthy();
    });

    it('should not show slash commands section when empty', () => {
      const sessionInfo = createSessionInfo({ slash_commands: [] });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).not.toContain('Slash Commands');
    });
  });

  describe('Agents', () => {
    it('should display agents section with count', () => {
      const sessionInfo = createSessionInfo({
        agents: ['Explore', 'Plan'],
      });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).toContain('Agents (2)');
    });

    it('should list all agents', () => {
      const sessionInfo = createSessionInfo({
        agents: ['Explore', 'Plan', 'claude-code-guide'],
      });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).toContain('Explore');
      expect(container.textContent).toContain('Plan');
      expect(container.textContent).toContain('claude-code-guide');
    });

    it('should not show agents section when empty', () => {
      const sessionInfo = createSessionInfo({ agents: [] });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).not.toContain('Agents');
    });
  });

  describe('Footer Details', () => {
    it('should show API key source', () => {
      const sessionInfo = createSessionInfo({ apiKeySource: 'project' });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).toContain('API Key:');
      expect(container.textContent).toContain('project');
    });

    it('should show output style', () => {
      const sessionInfo = createSessionInfo({ output_style: 'streaming' });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).toContain('Output:');
      expect(container.textContent).toContain('streaming');
    });
  });

  describe('Styling', () => {
    it('should have sky color scheme', () => {
      const sessionInfo = createSessionInfo();
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.querySelector('.bg-sky-50, .dark\\:bg-sky-900\\/70')).toBeTruthy();
    });

    it('should have fixed width', () => {
      const sessionInfo = createSessionInfo();
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.querySelector('.w-80')).toBeTruthy();
    });

    it('should have max height with scroll', () => {
      const sessionInfo = createSessionInfo();
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.querySelector('.max-h-\\[60vh\\]')).toBeTruthy();
      expect(container.querySelector('.overflow-y-scroll')).toBeTruthy();
    });

    it('should have shadow for dropdown appearance', () => {
      const sessionInfo = createSessionInfo();
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.querySelector('.shadow-2xl')).toBeTruthy();
    });

    it('should have rounded corners', () => {
      const sessionInfo = createSessionInfo();
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.querySelector('.rounded-lg')).toBeTruthy();
    });
  });

  describe('Permission Mode Display', () => {
    it('should display default permission mode', () => {
      const sessionInfo = createSessionInfo({ permissionMode: 'default' });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).toContain('default');
    });

    it('should display acceptEdits permission mode', () => {
      const sessionInfo = createSessionInfo({ permissionMode: 'acceptEdits' });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).toContain('acceptEdits');
    });

    it('should display bypassPermissions mode', () => {
      const sessionInfo = createSessionInfo({
        permissionMode: 'bypassPermissions',
      });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).toContain('bypassPermissions');
    });
  });

  describe('Edge Cases', () => {
    it('should handle long working directory paths', () => {
      const longPath = '/very/long/path/that/goes/on/and/on/to/test/overflow/handling/properly';
      const sessionInfo = createSessionInfo({ cwd: longPath });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).toContain(longPath);
      expect(container.querySelector('.break-all')).toBeTruthy();
    });

    it('should handle many tools', () => {
      const tools = Array.from({ length: 20 }, (_, i) => `Tool${i}`);
      const sessionInfo = createSessionInfo({ tools });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).toContain('Tools (20)');
    });

    it('should handle many MCP servers', () => {
      const servers = Array.from({ length: 10 }, (_, i) => ({
        name: `server-${i}`,
        status: i % 2 === 0 ? 'connected' : 'failed',
      }));
      const sessionInfo = createSessionInfo({ mcp_servers: servers });
      const { container } = render(<MessageInfoDropdown sessionInfo={sessionInfo} />);

      expect(container.textContent).toContain('MCP Servers (10)');
    });
  });
});
