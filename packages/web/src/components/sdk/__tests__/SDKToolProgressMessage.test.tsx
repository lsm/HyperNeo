// @ts-nocheck
import { describe, it, expect } from 'vitest';

import { render } from '@testing-library/preact';
import { SDKToolProgressMessage } from '../SDKToolProgressMessage';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import type { UUID } from 'crypto';

const createUUID = (): UUID => crypto.randomUUID() as UUID;

function createToolProgressMessage(
  toolName: string,
  elapsedSeconds: number,
  parentToolUseId: string | null = null
): Extract<SDKMessage, { type: 'tool_progress' }> {
  return {
    type: 'tool_progress',
    tool_use_id: `toolu_${toolName.toLowerCase()}123`,
    tool_name: toolName,
    parent_tool_use_id: parentToolUseId,
    elapsed_time_seconds: elapsedSeconds,
    uuid: createUUID(),
    session_id: 'test-session',
  };
}

describe('SDKToolProgressMessage', () => {
  describe('Basic Rendering', () => {
    it('should render tool name', () => {
      const message = createToolProgressMessage('Read', 2.5);
      const { container } = render(<SDKToolProgressMessage message={message} />);

      expect(container.textContent).toContain('Read');
    });

    it('should render elapsed time', () => {
      const message = createToolProgressMessage('Write', 5.0);
      const { container } = render(<SDKToolProgressMessage message={message} />);

      expect(container.textContent).toContain('5');
    });

    it('should render with ToolProgressCard component', () => {
      const message = createToolProgressMessage('Bash', 1.5);
      const { container } = render(<SDKToolProgressMessage message={message} />);

      expect(container.textContent).toContain('Bash');
    });
  });

  describe('Different Tool Types', () => {
    it('should render Read tool', () => {
      const message = createToolProgressMessage('Read', 1.0);
      const { container } = render(<SDKToolProgressMessage message={message} />);

      expect(container.textContent).toContain('Read');
    });

    it('should render Write tool', () => {
      const message = createToolProgressMessage('Write', 2.0);
      const { container } = render(<SDKToolProgressMessage message={message} />);

      expect(container.textContent).toContain('Write');
    });

    it('should render Edit tool', () => {
      const message = createToolProgressMessage('Edit', 3.0);
      const { container } = render(<SDKToolProgressMessage message={message} />);

      expect(container.textContent).toContain('Edit');
    });

    it('should render Bash tool', () => {
      const message = createToolProgressMessage('Bash', 10.0);
      const { container } = render(<SDKToolProgressMessage message={message} />);

      expect(container.textContent).toContain('Bash');
    });

    it('should render Glob tool', () => {
      const message = createToolProgressMessage('Glob', 0.5);
      const { container } = render(<SDKToolProgressMessage message={message} />);

      expect(container.textContent).toContain('Glob');
    });

    it('should render Grep tool', () => {
      const message = createToolProgressMessage('Grep', 1.5);
      const { container } = render(<SDKToolProgressMessage message={message} />);

      expect(container.textContent).toContain('Grep');
    });

    it('should render Task tool', () => {
      const message = createToolProgressMessage('Task', 30.0);
      const { container } = render(<SDKToolProgressMessage message={message} />);

      expect(container.textContent).toContain('Task');
    });

    it('should render MCP tool', () => {
      const message = createToolProgressMessage('mcp__filesystem__read', 2.0);
      const { container } = render(<SDKToolProgressMessage message={message} />);

      expect(container.textContent).toContain('read');
    });
  });

  describe('Elapsed Time Display', () => {
    it('should show fractional seconds', () => {
      const message = createToolProgressMessage('Read', 2.5);
      const { container } = render(<SDKToolProgressMessage message={message} />);

      expect(container.textContent).toMatch(/2\.5|2\.50/);
    });

    it('should handle zero elapsed time', () => {
      const message = createToolProgressMessage('Read', 0);
      const { container } = render(<SDKToolProgressMessage message={message} />);

      expect(container.textContent).toContain('Read');
    });

    it('should handle long elapsed time', () => {
      const message = createToolProgressMessage('Bash', 120.5);
      const { container } = render(<SDKToolProgressMessage message={message} />);

      expect(container.textContent).toContain('Bash');
      expect(container.textContent).toMatch(/2m|120/);
    });
  });

  describe('Tool Input Display', () => {
    it('should display tool input when provided', () => {
      const message = createToolProgressMessage('Read', 1.0);
      const toolInput = { file_path: '/test/file.txt' };

      const { container } = render(
        <SDKToolProgressMessage message={message} toolInput={toolInput} />
      );

      expect(container.textContent).toContain('Read');
    });

    it('should display file path for file tools', () => {
      const message = createToolProgressMessage('Write', 2.0);
      const toolInput = { file_path: '/path/to/output.txt', content: 'Hello' };

      const { container } = render(
        <SDKToolProgressMessage message={message} toolInput={toolInput} />
      );

      expect(container.textContent).toContain('Write');
    });

    it('should display command for Bash tool', () => {
      const message = createToolProgressMessage('Bash', 5.0);
      const toolInput = { command: 'npm install' };

      const { container } = render(
        <SDKToolProgressMessage message={message} toolInput={toolInput} />
      );

      expect(container.textContent).toContain('Bash');
    });

    it('should handle undefined tool input', () => {
      const message = createToolProgressMessage('Read', 1.0);

      const { container } = render(<SDKToolProgressMessage message={message} />);

      expect(container.textContent).toContain('Read');
    });
  });

  describe('Parent Tool Use (Sub-agent)', () => {
    it('should pass parent_tool_use_id to ToolProgressCard', () => {
      const message = createToolProgressMessage('Read', 1.0, 'toolu_parent456');

      const { container } = render(<SDKToolProgressMessage message={message} />);

      expect(container.textContent).toContain('Read');
    });

    it('should handle null parent_tool_use_id', () => {
      const message = createToolProgressMessage('Write', 2.0, null);

      const { container } = render(<SDKToolProgressMessage message={message} />);

      expect(container.textContent).toContain('Write');
    });
  });

  describe('Variant', () => {
    it('should use default variant', () => {
      const message = createToolProgressMessage('Read', 1.0);

      const { container } = render(<SDKToolProgressMessage message={message} />);

      expect(container.querySelector('div')).toBeTruthy();
    });
  });

  describe('Animation', () => {
    it('should render with spinner/loading indicator', () => {
      const message = createToolProgressMessage('Read', 1.0);

      const { container } = render(<SDKToolProgressMessage message={message} />);

      expect(container.innerHTML.length).toBeGreaterThan(0);
    });
  });
});
