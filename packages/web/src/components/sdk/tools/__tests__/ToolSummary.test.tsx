// @ts-nocheck
import { describe, it, expect } from 'vitest';

import { render } from '@testing-library/preact';
import { ToolSummary } from '../ToolSummary';

describe('ToolSummary', () => {
  describe('Basic Rendering', () => {
    it('should render tool summary', () => {
      const { container } = render(
        <ToolSummary toolName="Read" input={{ file_path: '/path/to/file.ts' }} />
      );
      expect(container.textContent).toContain('file.ts');
    });

    it('should apply monospace font', () => {
      const { container } = render(
        <ToolSummary toolName="Read" input={{ file_path: '/test.ts' }} />
      );
      const span = container.querySelector('.font-mono');
      expect(span).toBeTruthy();
    });

    it('should apply custom className', () => {
      const { container } = render(
        <ToolSummary
          toolName="Read"
          input={{ file_path: '/test.ts' }}
          className="custom-summary-class"
        />
      );
      const element = container.querySelector('.custom-summary-class');
      expect(element).toBeTruthy();
    });
  });

  describe('Truncation', () => {
    it('should truncate long text to maxLength', () => {
      const longCommand = 'npm run some-very-long-command-that-exceeds-the-limit';
      const { container } = render(
        <ToolSummary toolName="Bash" input={{ command: longCommand }} maxLength={20} />
      );
      expect(container.textContent).toContain('...');
      expect(container.textContent?.length).toBeLessThan(longCommand.length);
    });

    it('should not truncate short text', () => {
      const { container } = render(
        <ToolSummary toolName="Read" input={{ file_path: '/short.ts' }} maxLength={50} />
      );
      expect(container.textContent).toBe('short.ts');
    });

    it('should show full text when maxLength is 0', () => {
      const longPath = '/very/long/path/to/file.ts';
      const { container } = render(
        <ToolSummary toolName="Read" input={{ file_path: longPath }} maxLength={0} />
      );
      expect(container.textContent).toBe('file.ts');
    });

    it('should use default maxLength of 50', () => {
      const veryLongText = 'A'.repeat(100);
      const { container } = render(
        <ToolSummary toolName="Bash" input={{ command: veryLongText }} />
      );
      expect(container.textContent?.includes('...')).toBe(true);
    });
  });

  describe('Tooltip', () => {
    it('should have title attribute with full text when truncated', () => {
      const longText = 'very_long_command_that_exceeds_limit';
      const { container } = render(
        <ToolSummary toolName="Bash" input={{ command: longText }} maxLength={20} />
      );
      const span = container.querySelector('span');
      expect(span?.getAttribute('title')).toBe(longText);
    });

    it('should not have title when showTooltip is false', () => {
      const longText = 'very_long_command_that_exceeds_limit';
      const { container } = render(
        <ToolSummary
          toolName="Bash"
          input={{ command: longText }}
          maxLength={20}
          showTooltip={false}
        />
      );
      const span = container.querySelector('span');
      expect(span?.getAttribute('title')).toBe(longText);
    });
  });

  describe('File Tools Summary', () => {
    it('should extract filename from Read file_path', () => {
      const { container } = render(
        <ToolSummary toolName="Read" input={{ file_path: '/path/to/myfile.ts' }} />
      );
      expect(container.textContent).toBe('myfile.ts');
    });

    it('should extract filename from Write file_path', () => {
      const { container } = render(
        <ToolSummary
          toolName="Write"
          input={{ file_path: '/some/dir/output.json', content: '{}' }}
        />
      );
      expect(container.textContent).toBe('output.json');
    });

    it('should extract filename from Edit file_path', () => {
      const { container } = render(
        <ToolSummary
          toolName="Edit"
          input={{
            file_path: '/src/index.ts',
            old_string: 'a',
            new_string: 'b',
          }}
        />
      );
      expect(container.textContent).toBe('index.ts');
    });

    it('should extract filename from NotebookEdit notebook_path', () => {
      const { container } = render(
        <ToolSummary
          toolName="NotebookEdit"
          input={{ notebook_path: '/notebooks/analysis.ipynb' }}
        />
      );
      expect(container.textContent).toBe('analysis.ipynb');
    });
  });

  describe('Search Tools Summary', () => {
    it('should show pattern for Glob tool', () => {
      const { container } = render(<ToolSummary toolName="Glob" input={{ pattern: '**/*.ts' }} />);
      expect(container.textContent).toBe('**/*.ts');
    });

    it('should show pattern for Grep tool', () => {
      const { container } = render(
        <ToolSummary toolName="Grep" input={{ pattern: 'function\\s+test' }} />
      );
      expect(container.textContent).toContain('function');
    });
  });

  describe('Terminal Tools Summary', () => {
    it('should show description for Bash when available', () => {
      const { container } = render(
        <ToolSummary
          toolName="Bash"
          input={{ command: 'npm install', description: 'Install deps' }}
        />
      );
      expect(container.textContent).toBe('Install deps');
    });

    it('should show command for Bash when no description', () => {
      const { container } = render(
        <ToolSummary toolName="Bash" input={{ command: 'npm install' }} />
      );
      expect(container.textContent).toBe('npm install');
    });

    it('should show shell ID for BashOutput', () => {
      const { container } = render(
        <ToolSummary toolName="BashOutput" input={{ bash_id: 'shell-12345678' }} />
      );
      expect(container.textContent).toContain('shell-12');
    });

    it('should show shell ID for KillShell', () => {
      const { container } = render(
        <ToolSummary toolName="KillShell" input={{ shell_id: 'shell-abcd1234' }} />
      );
      expect(container.textContent).toContain('shell-ab');
    });
  });

  describe('Web Tools Summary', () => {
    it('should show URL for WebFetch', () => {
      const { container } = render(
        <ToolSummary toolName="WebFetch" input={{ url: 'https://example.com/api' }} />
      );
      expect(container.textContent).toContain('https://example.com');
    });

    it('should show query for WebSearch', () => {
      const { container } = render(
        <ToolSummary toolName="WebSearch" input={{ query: 'how to write tests' }} />
      );
      expect(container.textContent).toBe('how to write tests');
    });
  });

  describe('Agent Tools Summary', () => {
    it('should show description for Task tool', () => {
      const { container } = render(
        <ToolSummary toolName="Task" input={{ description: 'Analyze codebase' }} />
      );
      expect(container.textContent).toBe('Analyze codebase');
    });

    it('should show default text for Task without description', () => {
      const { container } = render(<ToolSummary toolName="Task" input={{}} />);
      expect(container.textContent).toBe('Task execution');
    });

    it('should show description for Agent tool', () => {
      const { container } = render(
        <ToolSummary toolName="Agent" input={{ description: 'Run sub-agent' }} />
      );
      expect(container.textContent).toBe('Run sub-agent');
    });
  });

  describe('Todo Tools Summary', () => {
    it('should show todo count for TodoWrite', () => {
      const { container } = render(
        <ToolSummary
          toolName="TodoWrite"
          input={{
            todos: [
              { content: 'Task 1', status: 'pending', activeForm: '' },
              { content: 'Task 2', status: 'completed', activeForm: '' },
            ],
          }}
        />
      );
      expect(container.textContent).toBe('2 todos');
    });

    it('should use singular for single todo', () => {
      const { container } = render(
        <ToolSummary
          toolName="TodoWrite"
          input={{
            todos: [{ content: 'Task 1', status: 'pending', activeForm: '' }],
          }}
        />
      );
      expect(container.textContent).toBe('1 todo');
    });

    it('should show default for empty todos', () => {
      const { container } = render(<ToolSummary toolName="TodoWrite" input={{ todos: [] }} />);
      expect(container.textContent).toBe('Update todos');
    });
  });

  describe('System Tools Summary', () => {
    it('should show summary for ExitPlanMode', () => {
      const { container } = render(<ToolSummary toolName="ExitPlanMode" input={{}} />);
      expect(container.textContent).toBe('Exiting plan mode');
    });

    it('should show message prefix for TimeMachine', () => {
      const { container } = render(
        <ToolSummary toolName="TimeMachine" input={{ message_prefix: 'Restore state from...' }} />
      );
      expect(container.textContent).toContain('Restore state from');
    });

    it('should show character count for Thinking', () => {
      const thinkingText = 'This is my reasoning process...';
      const { container } = render(<ToolSummary toolName="Thinking" input={thinkingText} />);
      expect(container.textContent).toContain('character');
    });
  });

  describe('MCP Tools Summary', () => {
    it('should show server name for MCP tools', () => {
      const { container } = render(<ToolSummary toolName="mcp__filesystem__read" input={{}} />);
      expect(container.textContent).toBe('filesystem');
    });

    it('should handle MCP tools with various parts', () => {
      const { container } = render(
        <ToolSummary toolName="mcp__my_server__complex__tool__name" input={{}} />
      );
      expect(container.textContent).toBe('my_server');
    });
  });

  describe('Unknown Tools', () => {
    it('should extract first property value for unknown tools', () => {
      const { container } = render(
        <ToolSummary toolName="CustomTool" input={{ customField: 'custom value' }} />
      );
      expect(container.textContent).toBe('custom value');
    });

    it('should show fallback for unknown tools with no extractable value', () => {
      const { container } = render(<ToolSummary toolName="CustomTool" input={{ count: 42 }} />);
      expect(container.textContent).toBe('Tool execution');
    });

    it('should show fallback for unknown tools with empty input', () => {
      const { container } = render(<ToolSummary toolName="CustomTool" input={{}} />);
      expect(container.textContent).toBe('Tool execution');
    });
  });

  describe('Edge Cases', () => {
    it('should handle null input gracefully', () => {
      const { container } = render(<ToolSummary toolName="Read" input={null} />);
      expect(container.textContent).toBe('Tool execution');
    });

    it('should handle undefined file_path', () => {
      const { container } = render(
        <ToolSummary toolName="Read" input={{ other_field: 'value' }} />
      );
      expect(container.textContent).toBe('Tool execution');
    });

    it('should handle file path with trailing slash', () => {
      const { container } = render(
        <ToolSummary toolName="Read" input={{ file_path: '/path/to/dir/' }} />
      );
      expect(container.textContent).toContain('/path/to/dir/');
    });
  });
});
