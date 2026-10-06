import { TOOL_SUMMARY_INPUT_FIELDS, WHOLE_INPUT_TOOLS } from '@hyperneo/shared';
import { describe, expect, it } from 'vitest';
import { getToolConfig } from '../tool-registry.ts';

const TOOL_NAMES = [
  'Write',
  'Edit',
  'MultiEdit',
  'Read',
  'NotebookEdit',
  'Glob',
  'Grep',
  'Bash',
  'BashOutput',
  'KillShell',
  'Task',
  'Agent',
  'TaskOutput',
  'TaskStop',
  'WebFetch',
  'WebSearch',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'EnterPlanMode',
  'ExitPlanMode',
  'TimeMachine',
  'Thinking',
  'mcp__server__tool',
];

function readFields(toolName: string): string[] {
  const read = new Set<string>();
  const input = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (typeof key === 'string') read.add(key);
        return 'value';
      },
    }
  );
  getToolConfig(toolName).summaryExtractor?.(input);
  return [...read];
}

describe('tool title fields', () => {
  it('builds every one-line title from fields the thin message feed keeps', () => {
    const kept = new Set(TOOL_SUMMARY_INPUT_FIELDS);
    const missing = TOOL_NAMES.filter((name) => !WHOLE_INPUT_TOOLS.includes(name)).flatMap((name) =>
      readFields(name)
        .filter((field) => !kept.has(field))
        .map((field) => `${name}.${field}`)
    );
    expect(missing).toEqual([]);
  });
});
