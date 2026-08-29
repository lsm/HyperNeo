import { h } from 'preact';
import type { ToolConfig, ToolCategory } from './tool-types.ts';
import { TodoViewer } from './TodoViewer.tsx';

const getProp = (input: unknown, key: string): string | undefined => {
  const obj = input as Record<string, unknown>;
  const value = obj?.[key];
  return typeof value === 'string' ? value : undefined;
};

const getPropAny = (input: unknown, key: string): unknown => {
  const obj = input as Record<string, unknown>;
  return obj?.[key];
};

const defaultToolConfigs: Record<string, ToolConfig> = {
  Write: {
    displayName: 'Write',
    category: 'file',
    summaryExtractor: (input) => extractFileName(getProp(input, 'file_path')),
    colors: {
      bg: 'bg-accent/10',
      text: 'text-accent-soft',
      border: 'border-accent/40',
      iconColor: 'text-success',
      lightText: 'text-accent',
    },
    hasLongOutput: false,
    defaultExpanded: false,
  },
  Edit: {
    displayName: 'Edit',
    category: 'file',
    summaryExtractor: (input) => extractFileName(getProp(input, 'file_path')),
    colors: {
      bg: 'bg-accent/10',
      text: 'text-accent-soft',
      border: 'border-accent/40',
      iconColor: 'text-success',
      lightText: 'text-accent',
    },
    hasLongOutput: false,
    defaultExpanded: false,
  },
  MultiEdit: {
    displayName: 'Multi Edit',
    category: 'file',
    summaryExtractor: (input) => extractFileName(getProp(input, 'file_path')),
    colors: {
      bg: 'bg-accent/10',
      text: 'text-accent-soft',
      border: 'border-accent/40',
      iconColor: 'text-success',
      lightText: 'text-accent',
    },
    hasLongOutput: false,
    defaultExpanded: false,
  },
  Read: {
    displayName: 'Read',
    category: 'file',
    summaryExtractor: (input) => extractFileName(getProp(input, 'file_path')),
    hasLongOutput: true,
    defaultExpanded: false,
  },
  NotebookEdit: {
    displayName: 'Notebook Edit',
    category: 'file',
    summaryExtractor: (input) => extractFileName(getProp(input, 'notebook_path')),
    colors: {
      bg: 'bg-accent/10',
      text: 'text-accent-soft',
      border: 'border-accent/40',
      iconColor: 'text-success',
      lightText: 'text-accent',
    },
    hasLongOutput: false,
    defaultExpanded: false,
  },

  Glob: {
    displayName: 'Glob',
    category: 'search',
    summaryExtractor: (input) => truncateString(getProp(input, 'pattern'), 50),
    hasLongOutput: true,
    defaultExpanded: false,
  },
  Grep: {
    displayName: 'Grep',
    category: 'search',
    summaryExtractor: (input) => truncateString(getProp(input, 'pattern'), 50),
    hasLongOutput: true,
    defaultExpanded: false,
  },

  Bash: {
    displayName: 'Bash',
    category: 'terminal',
    summaryExtractor: (input) => {
      const description = getProp(input, 'description');
      return description || truncateString(getProp(input, 'command'), 50);
    },
    hasLongOutput: true,
    defaultExpanded: false,
  },
  BashOutput: {
    displayName: 'Bash Output',
    category: 'terminal',
    summaryExtractor: (input) => `Shell: ${getProp(input, 'bash_id')?.slice(0, 8) || 'unknown'}`,
    hasLongOutput: true,
    defaultExpanded: false,
  },
  KillShell: {
    displayName: 'Kill Shell',
    category: 'terminal',
    summaryExtractor: (input) => `Shell: ${getProp(input, 'shell_id')?.slice(0, 8) || 'unknown'}`,
    hasLongOutput: false,
    defaultExpanded: false,
  },

  Task: {
    displayName: 'Task',
    category: 'agent',
    summaryExtractor: (input) => getProp(input, 'description') || 'Task execution',
    hasLongOutput: true,
    defaultExpanded: false,
  },
  Agent: {
    displayName: 'Agent',
    category: 'agent',
    summaryExtractor: (input) => getProp(input, 'description') || 'Agent execution',
    hasLongOutput: true,
    defaultExpanded: false,
  },
  TaskOutput: {
    displayName: 'Task Output',
    category: 'agent',
    summaryExtractor: (input) => getProp(input, 'task_id') || 'Task output',
    hasLongOutput: true,
    defaultExpanded: false,
  },
  TaskStop: {
    displayName: 'Stop Task',
    category: 'agent',
    summaryExtractor: (input) =>
      getProp(input, 'task_id') || getProp(input, 'shell_id') || 'Stop task',
    hasLongOutput: false,
    defaultExpanded: false,
  },

  WebFetch: {
    displayName: 'Web Fetch',
    category: 'web',
    summaryExtractor: (input) => truncateString(getProp(input, 'url'), 50),
    hasLongOutput: true,
    defaultExpanded: false,
  },
  WebSearch: {
    displayName: 'Web Search',
    category: 'web',
    summaryExtractor: (input) => truncateString(getProp(input, 'query'), 50),
    hasLongOutput: true,
    defaultExpanded: false,
  },

  TodoWrite: {
    displayName: 'Todo',
    category: 'todo',
    summaryExtractor: (input) => {
      const todos = getPropAny(input, 'todos');
      const count = Array.isArray(todos) ? todos.length : 0;
      return count ? `${count} todo${count !== 1 ? 's' : ''}` : 'Update todos';
    },
    customRenderer: ({ input }) => {
      const todos = getPropAny(input, 'todos');
      if (todos && Array.isArray(todos)) {
        return h(TodoViewer, { todos });
      }
      return null;
    },
    hasLongOutput: false,
    defaultExpanded: true,
  },

  ListMcpResourcesTool: {
    displayName: 'List MCP Resources',
    category: 'mcp',
    summaryExtractor: (input) => getProp(input, 'server') || 'All servers',
    hasLongOutput: true,
    defaultExpanded: false,
  },
  ReadMcpResourceTool: {
    displayName: 'Read MCP Resource',
    category: 'mcp',
    summaryExtractor: (input) => truncateString(getProp(input, 'uri'), 50),
    hasLongOutput: true,
    defaultExpanded: false,
  },

  AskUserQuestion: {
    displayName: 'AskUserQuestion',
    category: 'system',
    summaryExtractor: summarizeQuestionInput,
    hasLongOutput: false,
    defaultExpanded: true,
    colors: {
      bg: 'bg-cat-rose/30',
      text: 'text-rose-200',
      border: 'border-cat-rose/40',
      iconColor: 'text-rose-400',
      lightText: 'text-cat-rose',
    },
  },
  EnterPlanMode: {
    displayName: 'Plan Mode',
    category: 'system',
    summaryExtractor: () => 'Entering plan mode',
    hasLongOutput: false,
    defaultExpanded: false,
  },
  ExitPlanMode: {
    displayName: 'Exit Plan Mode',
    category: 'system',
    summaryExtractor: () => 'Exiting plan mode',
    hasLongOutput: false,
    defaultExpanded: false,
  },
  TimeMachine: {
    displayName: 'Time Machine',
    category: 'system',
    summaryExtractor: (input) => truncateString(getProp(input, 'message_prefix'), 40),
    hasLongOutput: false,
    defaultExpanded: false,
  },
  Thinking: {
    displayName: 'Thinking',
    category: 'system',
    summaryExtractor: (input) => {
      if (typeof input === 'string') {
        const charCount = input.length;
        return `${charCount} character${charCount !== 1 ? 's' : ''}`;
      }
      return 'Extended reasoning process';
    },
    hasLongOutput: true,
    defaultExpanded: false,
    colors: {
      bg: 'bg-warning/10',
      text: 'text-warning-soft',
      border: 'border-warning/40',
      iconColor: 'text-warning',
      lightText: 'text-warning',
    },
  },
};

const customToolConfigs: Map<string, ToolConfig> = new Map();

export function getCategoryColors(category: ToolCategory) {
  switch (category) {
    case 'file':
      return {
        bg: 'bg-accent/10',
        text: 'text-accent-soft',
        border: 'border-accent/40',
        iconColor: 'text-accent',
        lightText: 'text-accent',
      };
    case 'search':
      return {
        bg: 'bg-cat-purple/10',
        text: 'text-cat-purple',
        border: 'border-cat-purple/40',
        iconColor: 'text-cat-purple',
        lightText: 'text-cat-purple',
      };
    case 'terminal':
      return {
        bg: 'bg-surface-raised',
        text: 'text-fg',
        border: 'border-line',
        iconColor: 'text-fg-muted',
        lightText: 'text-fg-soft',
      };
    case 'agent':
      return {
        bg: 'bg-cat-indigo/10',
        text: 'text-cat-indigo',
        border: 'border-cat-indigo/40',
        iconColor: 'text-cat-indigo',
        lightText: 'text-cat-indigo',
      };
    case 'web':
      return {
        bg: 'bg-success/10',
        text: 'text-success-soft',
        border: 'border-success/40',
        iconColor: 'text-success',
        lightText: 'text-success-soft',
      };
    case 'todo':
      return {
        bg: 'bg-warning/10',
        text: 'text-warning-soft',
        border: 'border-warning/40',
        iconColor: 'text-warning',
        lightText: 'text-warning',
      };
    case 'mcp':
      return {
        bg: 'bg-cat-pink/10',
        text: 'text-pink-900 dark:text-pink-100',
        border: 'border-cat-pink/40',
        iconColor: 'text-cat-pink',
        lightText: 'text-cat-pink',
      };
    case 'system':
      return {
        bg: 'bg-cat-cyan/10',
        text: 'text-cat-cyan',
        border: 'border-cat-cyan/40',
        iconColor: 'text-cat-cyan',
        lightText: 'text-cat-cyan',
      };
    default:
      return {
        bg: 'bg-surface-raised',
        text: 'text-fg',
        border: 'border-line',
        iconColor: 'text-fg-muted',
        lightText: 'text-fg-soft',
      };
  }
}

function extractFileName(path: string | undefined): string | null {
  if (!path) return null;
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function truncateString(str: string | undefined, maxLength: number): string | null {
  if (!str) return null;
  return str.length > maxLength ? str.slice(0, maxLength) + '...' : str;
}

function summarizeQuestionInput(input: unknown): string {
  const questions = getPropAny(input, 'questions');
  if (!Array.isArray(questions) || questions.length === 0) return 'Ask user';
  const firstQuestion = questions.find(
    (question): question is Record<string, unknown> => !!question && typeof question === 'object'
  );
  const text = firstQuestion ? getProp(firstQuestion, 'question') : undefined;
  if (!text) return `${questions.length} question${questions.length !== 1 ? 's' : ''}`;
  const suffix = questions.length > 1 ? ` (+${questions.length - 1})` : '';
  return `${truncateString(text, 60) ?? text}${suffix}`;
}

export function getToolConfig(toolName: string): ToolConfig {
  const customConfig = customToolConfigs.get(toolName);
  if (customConfig) return customConfig;

  const defaultConfig = defaultToolConfigs[toolName];
  if (defaultConfig) return defaultConfig;

  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const serverName = parts[1] || 'unknown';
    const toolShortName = parts.slice(2).join('__') || toolName;

    return {
      displayName: toolShortName,
      category: 'mcp',
      summaryExtractor: () => `${serverName}`,
      hasLongOutput: true,
      defaultExpanded: false,
    };
  }

  return {
    displayName: toolName,
    category: 'unknown',
    summaryExtractor: (input) => {
      if (input && typeof input === 'object') {
        const obj = input as Record<string, unknown>;
        const keys = Object.keys(obj);
        if (keys.length > 0) {
          const firstKey = keys[0];
          const value = obj[firstKey];
          if (typeof value === 'string') {
            return truncateString(value, 40);
          }
        }
      }
      return null;
    },
    hasLongOutput: false,
    defaultExpanded: false,
  };
}
