// @ts-nocheck
import { describe, it, expect } from 'vitest';

import { render } from '@testing-library/preact';
import { ToolProgressCard } from '../ToolProgressCard';

describe('ToolProgressCard', () => {
  const defaultProps = {
    toolName: 'Read',
    elapsedTime: 1.5,
    toolUseId: 'tool-use-123456789',
  };

  describe('Basic Rendering', () => {
    it('should render tool name', () => {
      const { container } = render(<ToolProgressCard {...defaultProps} />);
      expect(container.textContent).toContain('Read');
    });

    it('should render elapsed time', () => {
      const { container } = render(<ToolProgressCard {...defaultProps} />);
      expect(container.textContent).toContain('1.5s');
    });

    it('should render tool icon', () => {
      const { container } = render(<ToolProgressCard {...defaultProps} />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should apply custom className', () => {
      const { container } = render(
        <ToolProgressCard {...defaultProps} className="custom-progress-class" />
      );
      const wrapper = container.querySelector('.custom-progress-class');
      expect(wrapper).toBeTruthy();
    });
  });

  describe('Elapsed Time Formatting', () => {
    it('should format milliseconds for times less than 1 second', () => {
      const { container } = render(<ToolProgressCard {...defaultProps} elapsedTime={0.5} />);
      expect(container.textContent).toContain('500ms');
    });

    it('should format seconds for times less than 60 seconds', () => {
      const { container } = render(<ToolProgressCard {...defaultProps} elapsedTime={30.5} />);
      expect(container.textContent).toContain('30.5s');
    });

    it('should format minutes and seconds for times over 60 seconds', () => {
      const { container } = render(<ToolProgressCard {...defaultProps} elapsedTime={90} />);
      expect(container.textContent).toContain('1m 30s');
    });

    it('should handle zero elapsed time', () => {
      const { container } = render(<ToolProgressCard {...defaultProps} elapsedTime={0} />);
      expect(container.textContent).toContain('0ms');
    });
  });

  describe('Default Variant', () => {
    it('should render with rounded border', () => {
      const { container } = render(<ToolProgressCard {...defaultProps} />);
      const card = container.querySelector('.rounded-lg');
      expect(card).toBeTruthy();
    });

    it('should show animated tool icon', () => {
      const { container } = render(<ToolProgressCard {...defaultProps} />);
      const animatedIcon = container.querySelector('.animate-spin');
      expect(animatedIcon).toBeTruthy();
    });

    it('should show progress indicator dots', () => {
      const { container } = render(<ToolProgressCard {...defaultProps} />);
      const pulseDots = container.querySelectorAll('.animate-pulse');
      expect(pulseDots.length).toBe(3);
    });

    it('should show tool ID when no input provided', () => {
      const { container } = render(<ToolProgressCard {...defaultProps} />);
      expect(container.textContent).toContain('Tool ID:');
      expect(container.textContent).toContain('tool-use-123');
    });

    it('should show parent tool ID when provided', () => {
      const { container } = render(
        <ToolProgressCard {...defaultProps} parentToolUseId="parent-tool-abc" />
      );
      expect(container.textContent).toContain('parent:');
      expect(container.textContent).toContain('parent-t');
    });
  });

  describe('Compact Variant', () => {
    it('should render in compact style', () => {
      const { container } = render(<ToolProgressCard {...defaultProps} variant="compact" />);
      const card = container.querySelector('.py-1');
      expect(card).toBeTruthy();
    });

    it('should have smaller icon in compact mode', () => {
      const { container } = render(<ToolProgressCard {...defaultProps} variant="compact" />);
      const svg = container.querySelector('svg');
      expect(svg?.className).toContain('w-4');
    });

    it('should truncate tool name in compact mode', () => {
      const { container } = render(<ToolProgressCard {...defaultProps} variant="compact" />);
      const truncatedElement = container.querySelector('.truncate');
      expect(truncatedElement).toBeTruthy();
    });
  });

  describe('Inline Variant', () => {
    it('should render as inline element', () => {
      const { container } = render(<ToolProgressCard {...defaultProps} variant="inline" />);
      const card = container.querySelector('.inline-flex');
      expect(card).toBeTruthy();
    });

    it('should have smallest icon in inline mode', () => {
      const { container } = render(<ToolProgressCard {...defaultProps} variant="inline" />);
      const svg = container.querySelector('svg');
      expect(svg?.className).toContain('w-3');
    });

    it('should have xs text size in inline mode', () => {
      const { container } = render(<ToolProgressCard {...defaultProps} variant="inline" />);
      const text = container.querySelector('.text-xs');
      expect(text).toBeTruthy();
    });
  });

  describe('Tool Input Summary', () => {
    it('should show file path for Read tool', () => {
      const { container } = render(
        <ToolProgressCard {...defaultProps} toolInput={{ file_path: '/path/to/file.ts' }} />
      );
      expect(container.textContent).toContain('file.ts');
    });

    it('should show command for Bash tool', () => {
      const { container } = render(
        <ToolProgressCard
          toolName="Bash"
          elapsedTime={1}
          toolUseId="bash-123"
          toolInput={{
            command: 'npm install',
            description: 'Install dependencies',
          }}
        />
      );
      expect(container.textContent).toContain('Install dependencies');
    });

    it('should show pattern for Glob tool', () => {
      const { container } = render(
        <ToolProgressCard
          toolName="Glob"
          elapsedTime={1}
          toolUseId="glob-123"
          toolInput={{ pattern: '**/*.ts' }}
        />
      );
      expect(container.textContent).toContain('**/*.ts');
    });

    it('should show pattern for Grep tool', () => {
      const { container } = render(
        <ToolProgressCard
          toolName="Grep"
          elapsedTime={1}
          toolUseId="grep-123"
          toolInput={{ pattern: 'function.*test' }}
        />
      );
      expect(container.textContent).toContain('function.*test');
    });

    it('should show URL for WebFetch tool', () => {
      const { container } = render(
        <ToolProgressCard
          toolName="WebFetch"
          elapsedTime={1}
          toolUseId="web-123"
          toolInput={{ url: 'https://example.com' }}
        />
      );
      expect(container.textContent).toContain('https://example.com');
    });
  });

  describe('Tool Colors', () => {
    it('should have blue colors for file tools', () => {
      const { container } = render(<ToolProgressCard {...defaultProps} />);
      const card = container.querySelector('.bg-accent\\/10');
      expect(card).toBeTruthy();
    });

    it('should have purple colors for search tools', () => {
      const { container } = render(
        <ToolProgressCard toolName="Grep" elapsedTime={1} toolUseId="grep-123" />
      );
      const card = container.querySelector('[class*="bg-cat-purple"]');
      expect(card).toBeTruthy();
    });

    it('should have gray colors for terminal tools', () => {
      const { container } = render(
        <ToolProgressCard toolName="Bash" elapsedTime={1} toolUseId="bash-123" />
      );
      const card = container.querySelector('.bg-surface-raised');
      expect(card).toBeTruthy();
    });

    it('should have green colors for web tools', () => {
      const { container } = render(
        <ToolProgressCard toolName="WebFetch" elapsedTime={1} toolUseId="web-123" />
      );
      const card = container.querySelector('.bg-success\\/10');
      expect(card).toBeTruthy();
    });
  });

  describe('Different Tool Types', () => {
    const toolNames = [
      'Write',
      'Edit',
      'Read',
      'Glob',
      'Grep',
      'Bash',
      'Task',
      'Agent',
      'WebFetch',
      'WebSearch',
      'TodoWrite',
      'ExitPlanMode',
      'Thinking',
    ];

    toolNames.forEach((toolName) => {
      it(`should render ${toolName} tool correctly`, () => {
        const { container } = render(
          <ToolProgressCard
            toolName={toolName}
            elapsedTime={1}
            toolUseId={`${toolName.toLowerCase()}-123`}
          />
        );
        const svg = container.querySelector('svg');
        expect(svg).toBeTruthy();
      });
    });
  });

  describe('MCP Tools', () => {
    it('should render MCP tool', () => {
      const { container } = render(
        <ToolProgressCard toolName="mcp__server__read_file" elapsedTime={1} toolUseId="mcp-123" />
      );
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should show MCP tool short name', () => {
      const { container } = render(
        <ToolProgressCard toolName="mcp__filesystem__read" elapsedTime={1} toolUseId="mcp-123" />
      );
      expect(container.textContent).toContain('read');
    });
  });
});
