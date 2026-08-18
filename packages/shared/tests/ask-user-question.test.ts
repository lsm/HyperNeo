import { describe, test, expect } from 'bun:test';
import {
  isAskUserQuestionToolUse,
  extractAskUserQuestion,
  hasAskUserQuestion,
} from '../src/sdk/type-guards';
import type { AskUserQuestionInput } from '../src/sdk/type-guards';
import type { SDKMessage } from '../src/sdk/sdk';

const baseProps = {
  uuid: 'test-uuid',
  session_id: 'test-session',
};

const sampleAskUserQuestionInput: AskUserQuestionInput = {
  questions: [
    {
      question: 'Which library should we use for date formatting?',
      header: 'Library',
      options: [
        { label: 'Day.js', description: 'Lightweight alternative to moment' },
        { label: 'date-fns', description: 'Modular date utility library' },
      ],
      multiSelect: false,
    },
  ],
};

describe('isAskUserQuestionToolUse', () => {
  test('should return true for AskUserQuestion tool use block', () => {
    const block = {
      type: 'tool_use' as const,
      id: 'tool-123',
      name: 'AskUserQuestion',
      input: sampleAskUserQuestionInput as unknown as Record<string, unknown>,
    };
    expect(isAskUserQuestionToolUse(block)).toBe(true);
  });

  test('should return false for other tool use blocks', () => {
    const block = {
      type: 'tool_use' as const,
      id: 'tool-123',
      name: 'Bash',
      input: { command: 'ls -la' },
    };
    expect(isAskUserQuestionToolUse(block)).toBe(false);
  });

  test('should return false for text blocks', () => {
    const block = {
      type: 'text' as const,
      text: 'Hello',
    };
    expect(isAskUserQuestionToolUse(block)).toBe(false);
  });

  test('should return false for thinking blocks', () => {
    const block = {
      type: 'thinking' as const,
      thinking: 'I should ask the user...',
    };
    expect(isAskUserQuestionToolUse(block)).toBe(false);
  });
});

describe('extractAskUserQuestion', () => {
  test('should extract AskUserQuestion from assistant message', () => {
    const msg = {
      ...baseProps,
      type: 'assistant' as const,
      parent_tool_use_id: null,
      message: {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'Let me ask you about that.' },
          {
            type: 'tool_use' as const,
            id: 'tool-123',
            name: 'AskUserQuestion',
            input: sampleAskUserQuestionInput,
          },
        ],
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    };

    const result = extractAskUserQuestion(msg as unknown as SDKMessage);

    expect(result).not.toBeNull();
    expect(result?.toolUseId).toBe('tool-123');
    expect(result?.input.questions).toHaveLength(1);
    expect(result?.input.questions[0].header).toBe('Library');
  });

  test('should return null for assistant message without AskUserQuestion', () => {
    const msg = {
      ...baseProps,
      type: 'assistant' as const,
      parent_tool_use_id: null,
      message: {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'Hello!' },
          {
            type: 'tool_use' as const,
            id: 'tool-456',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    };

    const result = extractAskUserQuestion(msg as unknown as SDKMessage);
    expect(result).toBeNull();
  });

  test('should return null for non-assistant messages', () => {
    const userMsg = {
      ...baseProps,
      type: 'user' as const,
      parent_tool_use_id: null,
      message: { role: 'user' as const, content: 'Hello' },
    };

    expect(extractAskUserQuestion(userMsg as unknown as SDKMessage)).toBeNull();
  });

  test('should return null for result messages', () => {
    const resultMsg = {
      ...baseProps,
      type: 'result' as const,
      subtype: 'success' as const,
      usage: { input_tokens: 100, output_tokens: 50 },
    };

    expect(extractAskUserQuestion(resultMsg as unknown as SDKMessage)).toBeNull();
  });
});

describe('hasAskUserQuestion', () => {
  test('should return true when AskUserQuestion is present', () => {
    const msg = {
      ...baseProps,
      type: 'assistant' as const,
      parent_tool_use_id: null,
      message: {
        role: 'assistant' as const,
        content: [
          {
            type: 'tool_use' as const,
            id: 'tool-123',
            name: 'AskUserQuestion',
            input: sampleAskUserQuestionInput,
          },
        ],
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    };

    expect(hasAskUserQuestion(msg as unknown as SDKMessage)).toBe(true);
  });

  test('should return false when AskUserQuestion is not present', () => {
    const msg = {
      ...baseProps,
      type: 'assistant' as const,
      parent_tool_use_id: null,
      message: {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'Hello!' }],
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    };

    expect(hasAskUserQuestion(msg as unknown as SDKMessage)).toBe(false);
  });
});

describe('AskUserQuestionInput type structure', () => {
  test('should have valid structure with single question', () => {
    const input: AskUserQuestionInput = {
      questions: [
        {
          question: 'What is your preference?',
          header: 'Preference',
          options: [
            { label: 'Option A', description: 'First choice' },
            { label: 'Option B', description: 'Second choice' },
          ],
          multiSelect: false,
        },
      ],
    };

    expect(input.questions).toHaveLength(1);
    expect(input.questions[0].options).toHaveLength(2);
    expect(input.questions[0].multiSelect).toBe(false);
  });

  test('should support multiple questions', () => {
    const input: AskUserQuestionInput = {
      questions: [
        {
          question: 'Which framework?',
          header: 'Framework',
          options: [
            { label: 'React', description: 'Popular UI library' },
            { label: 'Vue', description: 'Progressive framework' },
          ],
          multiSelect: false,
        },
        {
          question: 'Which features to include?',
          header: 'Features',
          options: [
            { label: 'TypeScript', description: 'Type safety' },
            { label: 'Testing', description: 'Unit tests' },
            { label: 'Linting', description: 'Code quality' },
          ],
          multiSelect: true,
        },
      ],
    };

    expect(input.questions).toHaveLength(2);
    expect(input.questions[0].multiSelect).toBe(false);
    expect(input.questions[1].multiSelect).toBe(true);
    expect(input.questions[1].options).toHaveLength(3);
  });
});
