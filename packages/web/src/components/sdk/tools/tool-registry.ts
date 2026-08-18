import { h } from 'preact';
import type { ToolConfig, ToolCategory } from './tool-types.ts';
import { TodoViewer } from './TodoViewer.tsx';
import { borderColors } from '../../../lib/design-tokens.ts';

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
      bg: 'bg-blue-50 dark:bg-blue-900/20',
      text: 'text-blue-900 dark:text-blue-100',
      border: borderColors.tool.file,
      iconColor: 'text-green-600 dark:text-green-400',
      lightText: 'text-blue-700 dark:text-blue-300',
    },
    hasLongOutput: false,
    defaultExpanded: false,
  },
  Edit: {
    displayName: 'Edit',
    category: 'file',
    summaryExtractor: (input) => extractFileName(getProp(input, 'file_path')),
    colors: {
      bg: 'bg-blue-50 dark:bg-blue-900/20',
      text: 'text-blue-900 dark:text-blue-100',
      border: borderColors.tool.file,
      iconColor: 'text-green-600 dark:text-green-400',
      lightText: 'text-blue-700 dark:text-blue-300',
    },
    hasLongOutput: false,
    defaultExpanded: false,
  },
  MultiEdit: {
    displayName: 'Multi Edit',
    category: 'file',
    summaryExtractor: (input) => extractFileName(getProp(input, 'file_path')),
    colors: {
      bg: 'bg-blue-50 dark:bg-blue-900/20',
      text: 'text-blue-900 dark:text-blue-100',
      border: borderColors.tool.file,
      iconColor: 'text-green-600 dark:text-green-400',
      lightText: 'text-blue-700 dark:text-blue-300',
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
      bg: 'bg-blue-50 dark:bg-blue-900/20',
      text: 'text-blue-900 dark:text-blue-100',
      border: borderColors.tool.file,
      iconColor: 'text-green-600 dark:text-green-400',
      lightText: 'text-blue-700 dark:text-blue-300',
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
      bg: 'bg-rose-950/30',
      text: 'text-rose-200',
      border: 'border-rose-200 dark:border-rose-800',
      iconColor: 'text-rose-400',
      lightText: 'text-rose-300',
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
      bg: 'bg-amber-50 dark:bg-amber-900/20',
      text: 'text-amber-900 dark:text-amber-100',
      border: borderColors.semantic.warning,
      iconColor: 'text-amber-600 dark:text-amber-400',
      lightText: 'text-amber-700 dark:text-amber-300',
    },
  },
};

const customToolConfigs: Map<string, ToolConfig> = new Map();

export function getCategoryColors(category: ToolCategory) {
  switch (category) {
    case 'file':
      return {
        bg: 'bg-blue-50 dark:bg-blue-900/20',
        text: 'text-blue-900 dark:text-blue-100',
        border: borderColors.tool.file,
        iconColor: 'text-blue-600 dark:text-blue-400',
        lightText: 'text-blue-700 dark:text-blue-300',
      };
    case 'search':
      return {
        bg: 'bg-purple-50 dark:bg-purple-900/20',
        text: 'text-purple-900 dark:text-purple-100',
        border: borderColors.tool.search,
        iconColor: 'text-purple-600 dark:text-purple-400',
        lightText: 'text-purple-700 dark:text-purple-300',
      };
    case 'terminal':
      return {
        bg: 'bg-gray-50 dark:bg-gray-900/20',
        text: 'text-gray-900 dark:text-gray-100',
        border: borderColors.tool.terminal,
        iconColor: 'text-gray-600 dark:text-gray-400',
        lightText: 'text-gray-700 dark:text-gray-300',
      };
    case 'agent':
      return {
        bg: 'bg-indigo-50 dark:bg-indigo-900/20',
        text: 'text-indigo-900 dark:text-indigo-100',
        border: borderColors.tool.agent,
        iconColor: 'text-indigo-600 dark:text-indigo-400',
        lightText: 'text-indigo-700 dark:text-indigo-300',
      };
    case 'web':
      return {
        bg: 'bg-green-50 dark:bg-green-900/20',
        text: 'text-green-900 dark:text-green-100',
        border: borderColors.tool.web,
        iconColor: 'text-green-600 dark:text-green-400',
        lightText: 'text-green-700 dark:text-green-300',
      };
    case 'todo':
      return {
        bg: 'bg-amber-50 dark:bg-amber-900/20',
        text: 'text-amber-900 dark:text-amber-100',
        border: borderColors.tool.todo,
        iconColor: 'text-amber-600 dark:text-amber-400',
        lightText: 'text-amber-700 dark:text-amber-300',
      };
    case 'mcp':
      return {
        bg: 'bg-pink-50 dark:bg-pink-900/20',
        text: 'text-pink-900 dark:text-pink-100',
        border: borderColors.tool.mcp,
        iconColor: 'text-pink-600 dark:text-pink-400',
        lightText: 'text-pink-700 dark:text-pink-300',
      };
    case 'system':
      return {
        bg: 'bg-cyan-50 dark:bg-cyan-900/20',
        text: 'text-cyan-900 dark:text-cyan-100',
        border: borderColors.tool.system,
        iconColor: 'text-cyan-600 dark:text-cyan-400',
        lightText: 'text-cyan-700 dark:text-cyan-300',
      };
    default:
      return {
        bg: 'bg-gray-50 dark:bg-gray-900/20',
        text: 'text-gray-900 dark:text-gray-100',
        border: borderColors.semantic.neutral,
        iconColor: 'text-gray-600 dark:text-gray-400',
        lightText: 'text-gray-700 dark:text-gray-300',
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
