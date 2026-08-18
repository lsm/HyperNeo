// @ts-nocheck

import {
  getToolSummary,
  getToolDisplayName,
  getToolColors,
  getIconSizeClasses,
  formatElapsedTime,
  truncateText,
  getOutputDisplayText,
  hasCustomRenderer,
  getCustomRenderer,
  shouldExpandByDefault,
} from '../tool-utils';

describe('tool-utils', () => {
  describe('getToolSummary', () => {
    it('should extract file name from Read tool input', () => {
      const summary = getToolSummary('Read', { file_path: '/path/to/file.ts' });
      expect(summary).toBe('file.ts');
    });

    it('should extract file name from Write tool input', () => {
      const summary = getToolSummary('Write', {
        file_path: '/dir/output.json',
        content: '{}',
      });
      expect(summary).toBe('output.json');
    });

    it('should extract file name from Edit tool input', () => {
      const summary = getToolSummary('Edit', {
        file_path: '/src/index.ts',
        old_string: 'a',
        new_string: 'b',
      });
      expect(summary).toBe('index.ts');
    });

    it('should extract pattern from Glob tool input', () => {
      const summary = getToolSummary('Glob', { pattern: '**/*.ts' });
      expect(summary).toBe('**/*.ts');
    });

    it('should extract pattern from Grep tool input', () => {
      const summary = getToolSummary('Grep', { pattern: 'function test' });
      expect(summary).toBe('function test');
    });

    it('should prefer description over command for Bash', () => {
      const summary = getToolSummary('Bash', {
        command: 'npm install',
        description: 'Install deps',
      });
      expect(summary).toBe('Install deps');
    });

    it('should use command when no description for Bash', () => {
      const summary = getToolSummary('Bash', { command: 'npm install' });
      expect(summary).toBe('npm install');
    });

    it('should extract URL from WebFetch input', () => {
      const summary = getToolSummary('WebFetch', {
        url: 'https://example.com',
      });
      expect(summary).toBe('https://example.com');
    });

    it('should extract query from WebSearch input', () => {
      const summary = getToolSummary('WebSearch', { query: 'how to test' });
      expect(summary).toBe('how to test');
    });

    it('should count todos for TodoWrite', () => {
      const summary = getToolSummary('TodoWrite', {
        todos: [
          { content: '1', status: 'pending', activeForm: '' },
          { content: '2', status: 'pending', activeForm: '' },
        ],
      });
      expect(summary).toBe('2 todos');
    });

    it('should use singular for single todo', () => {
      const summary = getToolSummary('TodoWrite', {
        todos: [{ content: '1', status: 'pending', activeForm: '' }],
      });
      expect(summary).toBe('1 todo');
    });

    it('should return fallback for unknown tool', () => {
      const summary = getToolSummary('UnknownTool', {});
      expect(summary).toBe('Tool execution');
    });

    it('should return MCP server name for MCP tools', () => {
      const summary = getToolSummary('mcp__filesystem__read', {});
      expect(summary).toBe('filesystem');
    });
  });

  describe('getToolDisplayName', () => {
    it('should return display name for known tools', () => {
      expect(getToolDisplayName('Read')).toBe('Read');
      expect(getToolDisplayName('Write')).toBe('Write');
      expect(getToolDisplayName('Edit')).toBe('Edit');
      expect(getToolDisplayName('NotebookEdit')).toBe('Notebook Edit');
      expect(getToolDisplayName('WebFetch')).toBe('Web Fetch');
      expect(getToolDisplayName('WebSearch')).toBe('Web Search');
      expect(getToolDisplayName('TodoWrite')).toBe('Todo');
      expect(getToolDisplayName('BashOutput')).toBe('Bash Output');
      expect(getToolDisplayName('KillShell')).toBe('Kill Shell');
      expect(getToolDisplayName('ExitPlanMode')).toBe('Exit Plan Mode');
      expect(getToolDisplayName('TimeMachine')).toBe('Time Machine');
    });

    it('should return tool name for unknown tools', () => {
      expect(getToolDisplayName('CustomTool')).toBe('CustomTool');
    });

    it('should extract short name for MCP tools', () => {
      expect(getToolDisplayName('mcp__server__read_file')).toBe('read_file');
      expect(getToolDisplayName('mcp__fs__list')).toBe('list');
    });
  });

  describe('getToolColors', () => {
    it('should return blue colors for file tools', () => {
      const colors = getToolColors('Read');
      expect(colors.bg).toContain('blue');
      expect(colors.iconColor).toContain('blue');
    });

    it('should return purple colors for search tools', () => {
      const colors = getToolColors('Grep');
      expect(colors.bg).toContain('purple');
      expect(colors.iconColor).toContain('purple');
    });

    it('should return gray colors for terminal tools', () => {
      const colors = getToolColors('Bash');
      expect(colors.bg).toContain('gray');
      expect(colors.iconColor).toContain('gray');
    });

    it('should return indigo colors for agent tools', () => {
      const colors = getToolColors('Task');
      expect(colors.bg).toContain('indigo');
      expect(colors.iconColor).toContain('indigo');
    });

    it('should return green colors for web tools', () => {
      const colors = getToolColors('WebFetch');
      expect(colors.bg).toContain('green');
      expect(colors.iconColor).toContain('green');
    });

    it('should return amber colors for todo tools', () => {
      const colors = getToolColors('TodoWrite');
      expect(colors.bg).toContain('amber');
      expect(colors.iconColor).toContain('amber');
    });

    it('should return pink colors for MCP tools', () => {
      const colors = getToolColors('mcp__server__tool');
      expect(colors.bg).toContain('pink');
      expect(colors.iconColor).toContain('pink');
    });

    it('should return cyan colors for system tools', () => {
      const colors = getToolColors('ExitPlanMode');
      expect(colors.bg).toContain('cyan');
      expect(colors.iconColor).toContain('cyan');
    });

    it('should return amber colors for Thinking tool', () => {
      const colors = getToolColors('Thinking');
      expect(colors.bg).toContain('amber');
      expect(colors.iconColor).toContain('amber');
    });

    it('should return gray colors for unknown tools', () => {
      const colors = getToolColors('UnknownTool');
      expect(colors.bg).toContain('gray');
    });
  });

  describe('getIconSizeClasses', () => {
    it('should return xs classes', () => {
      expect(getIconSizeClasses('xs')).toBe('w-3 h-3');
    });

    it('should return sm classes', () => {
      expect(getIconSizeClasses('sm')).toBe('w-4 h-4');
    });

    it('should return md classes', () => {
      expect(getIconSizeClasses('md')).toBe('w-5 h-5');
    });

    it('should return lg classes', () => {
      expect(getIconSizeClasses('lg')).toBe('w-6 h-6');
    });

    it('should return xl classes', () => {
      expect(getIconSizeClasses('xl')).toBe('w-8 h-8');
    });

    it('should return md classes for unknown size', () => {
      // @ts-expect-error Testing invalid input
      expect(getIconSizeClasses('unknown')).toBe('w-5 h-5');
    });
  });

  describe('formatElapsedTime', () => {
    it('should format milliseconds for times less than 1 second', () => {
      expect(formatElapsedTime(0.5)).toBe('500ms');
      expect(formatElapsedTime(0.123)).toBe('123ms');
      expect(formatElapsedTime(0.001)).toBe('1ms');
    });

    it('should format seconds for times less than 60 seconds', () => {
      expect(formatElapsedTime(1)).toBe('1.0s');
      expect(formatElapsedTime(30.5)).toBe('30.5s');
      expect(formatElapsedTime(59.9)).toBe('59.9s');
    });

    it('should format minutes and seconds for times over 60 seconds', () => {
      expect(formatElapsedTime(60)).toBe('1m 0s');
      expect(formatElapsedTime(90)).toBe('1m 30s');
      expect(formatElapsedTime(125)).toBe('2m 5s');
      expect(formatElapsedTime(3600)).toBe('60m 0s');
    });

    it('should handle zero', () => {
      expect(formatElapsedTime(0)).toBe('0ms');
    });

    it('should handle very small values', () => {
      expect(formatElapsedTime(0.0001)).toBe('0ms');
    });
  });

  describe('truncateText', () => {
    it('should not truncate short text', () => {
      expect(truncateText('hello', 10)).toBe('hello');
    });

    it('should truncate long text with ellipsis', () => {
      expect(truncateText('hello world', 8)).toBe('hello wo...');
    });

    it('should handle exact length', () => {
      expect(truncateText('hello', 5)).toBe('hello');
    });

    it('should handle empty string', () => {
      expect(truncateText('', 10)).toBe('');
    });

    it('should handle zero max length', () => {
      expect(truncateText('hello', 0)).toBe('...');
    });
  });

  describe('getOutputDisplayText', () => {
    it('should return empty string for null', () => {
      expect(getOutputDisplayText(null)).toBe('');
    });

    it('should return empty string for undefined', () => {
      expect(getOutputDisplayText(undefined)).toBe('');
    });

    it('should return string output as-is', () => {
      expect(getOutputDisplayText('hello world')).toBe('hello world');
    });

    it('should extract content property from object', () => {
      expect(getOutputDisplayText({ content: 'extracted content' })).toBe('extracted content');
    });

    it('should format object as JSON', () => {
      const result = getOutputDisplayText({ key: 'value', count: 42 });
      expect(result).toContain('"key"');
      expect(result).toContain('"value"');
      expect(result).toContain('42');
    });

    it('should handle nested objects', () => {
      const result = getOutputDisplayText({ outer: { inner: 'value' } });
      expect(result).toContain('inner');
      expect(result).toContain('value');
    });

    it('should convert primitives to string', () => {
      expect(getOutputDisplayText(42)).toBe('42');
      expect(getOutputDisplayText(true)).toBe('true');
    });
  });

  describe('hasCustomRenderer', () => {
    it('should return true for TodoWrite', () => {
      expect(hasCustomRenderer('TodoWrite')).toBe(true);
    });

    it('should return false for Read', () => {
      expect(hasCustomRenderer('Read')).toBe(false);
    });

    it('should return false for unknown tools', () => {
      expect(hasCustomRenderer('UnknownTool')).toBe(false);
    });
  });

  describe('getCustomRenderer', () => {
    it('should return renderer function for TodoWrite', () => {
      const renderer = getCustomRenderer('TodoWrite');
      expect(typeof renderer).toBe('function');
    });

    it('should return undefined for tools without custom renderer', () => {
      expect(getCustomRenderer('Read')).toBeUndefined();
    });
  });

  describe('shouldExpandByDefault', () => {
    it('should return true for TodoWrite', () => {
      expect(shouldExpandByDefault('TodoWrite')).toBe(true);
    });

    it('should return false for Read', () => {
      expect(shouldExpandByDefault('Read')).toBe(false);
    });

    it('should return false for most tools', () => {
      expect(shouldExpandByDefault('Write')).toBe(false);
      expect(shouldExpandByDefault('Edit')).toBe(false);
      expect(shouldExpandByDefault('Bash')).toBe(false);
      expect(shouldExpandByDefault('Grep')).toBe(false);
      expect(shouldExpandByDefault('WebFetch')).toBe(false);
    });

    it('should return false for unknown tools', () => {
      expect(shouldExpandByDefault('UnknownTool')).toBe(false);
    });
  });
});
