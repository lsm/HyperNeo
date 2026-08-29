// @ts-nocheck
import { describe, it, expect } from 'vitest';

import { render, fireEvent, waitFor } from '@testing-library/preact';
import { SubagentBlock } from '../SubagentBlock';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import type { AgentInput } from '@hyperneo/shared/sdk/sdk-tools.d.ts';
import type { UUID } from 'crypto';

const createUUID = (): UUID => crypto.randomUUID() as UUID;

function createAgentInput(subagentType: string, description: string, prompt: string): AgentInput {
  return {
    subagent_type: subagentType,
    description,
    prompt,
  };
}

function createNestedAssistantMessage(text: string): SDKMessage {
  return {
    type: 'assistant',
    message: {
      id: 'msg_nested',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    parent_tool_use_id: 'toolu_task123',
    uuid: createUUID(),
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

function createNestedUserMessage(text: string): SDKMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: text,
    },
    parent_tool_use_id: 'toolu_task123',
    uuid: createUUID(),
    session_id: 'test-session',
  };
}

function createNestedToolUseMessage(): SDKMessage {
  return {
    type: 'assistant',
    message: {
      id: 'msg_tool',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_nested123',
          name: 'Read',
          input: { file_path: '/test/file.txt' },
        },
      ],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    parent_tool_use_id: 'toolu_task123',
    uuid: createUUID(),
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

function createNestedThinkingMessage(): SDKMessage {
  return {
    type: 'assistant',
    message: {
      id: 'msg_thinking',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'Let me analyze this problem step by step...',
        },
      ],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    parent_tool_use_id: 'toolu_task123',
    uuid: createUUID(),
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

function createNestedResultMessage(result: string, isError = false): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    result,
    is_error: isError,
    parent_tool_use_id: 'toolu_task123',
    uuid: createUUID(),
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

function createNestedSystemMessage(
  subtype?: string,
  fields: Record<string, unknown> = {}
): SDKMessage {
  return {
    type: 'system',
    subtype: subtype || 'status',
    parent_tool_use_id: 'toolu_task123',
    uuid: createUUID(),
    session_id: 'test-session',
    ...fields,
  } as unknown as SDKMessage;
}

function createNestedUserMessageWithArrayContent(): SDKMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'Some user text content' },
        { type: 'tool_result', tool_use_id: 'toolu_123', content: 'Tool result' },
      ],
    },
    parent_tool_use_id: 'toolu_task123',
    uuid: createUUID(),
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

function createNestedUserMessageWithOnlyToolResult(): SDKMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_123', content: 'Tool result only' }],
    },
    parent_tool_use_id: 'toolu_task123',
    uuid: createUUID(),
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

function createUnknownMessage(): SDKMessage {
  return {
    type: 'unknown_type' as never,
    parent_tool_use_id: 'toolu_task123',
    uuid: createUUID(),
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

describe('SubagentBlock', () => {
  describe('Basic Rendering', () => {
    it('should render subagent type badge', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

      expect(container.textContent).toContain('Explore');
    });

    it('should render description', () => {
      const input = createAgentInput('Plan', 'Create a plan', 'Design the architecture');
      const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

      expect(container.textContent).toContain('Create a plan');
    });

    it('should be expandable', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

      const button = container.querySelector('button');
      expect(button).toBeTruthy();
    });
  });

  describe('Subagent Types', () => {
    it('should render Explore type with cyan color scheme', () => {
      const input = createAgentInput('Explore', 'Explore codebase', 'Find relevant files');
      const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

      expect(container.querySelector('.bg-cat-cyan\\/10')).toBeTruthy();
    });

    it('should render Plan type with violet color scheme', () => {
      const input = createAgentInput('Plan', 'Create plan', 'Design solution');
      const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

      expect(container.querySelector('.bg-cat-violet\\/10')).toBeTruthy();
    });

    it('should render claude-code-guide type with amber color scheme', () => {
      const input = createAgentInput('claude-code-guide', 'Get guidance', 'How to do X');
      const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

      expect(container.querySelector('.bg-warning\\/10')).toBeTruthy();
    });

    it('should render general-purpose type with indigo color scheme', () => {
      const input = createAgentInput('general-purpose', 'General task', 'Do something');
      const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

      expect(container.querySelector('.bg-cat-indigo\\/10')).toBeTruthy();
    });

    it('should render unknown type with default indigo color scheme', () => {
      const input = createAgentInput('custom-type', 'Custom task', 'Custom prompt');
      const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

      expect(container.querySelector('.bg-cat-indigo\\/10')).toBeTruthy();
    });

    it('should render general-purpose fallback when subagent_type is undefined', () => {
      const input: AgentInput = { description: 'Unnamed task', prompt: 'Do something' };
      const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

      expect(container.querySelector('.bg-cat-indigo\\/10')).toBeTruthy();
      expect(container.textContent).toContain('general-purpose');
    });
  });

  describe('Expanded State', () => {
    it('should show input section when expanded', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Input');
      expect(container.textContent).toContain('Search for test files');
    });

    it('should show output section when expanded', async () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const output = 'Found 5 test files in the project.';
      const { container } = render(
        <SubagentBlock input={input} output={output} toolId="toolu_task123" />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Output');
      await waitFor(() => {
        expect(container.textContent).toContain('Found 5 test files');
      });
    });

    it('should show "No output yet..." when output is empty', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('No output yet');
    });

    it('should collapse when button is clicked again', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

      const button = container.querySelector('button')!;

      fireEvent.click(button);
      expect(container.textContent).toContain('Input');

      fireEvent.click(button);
      expect(container.querySelector('.border-t')).toBeFalsy();
    });
  });

  describe('Nested Messages', () => {
    it('should show nested messages section when messages are provided', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [createNestedAssistantMessage('I found the files.')];

      const { container } = render(
        <SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Messages (1)');
    });

    it('should render nested assistant messages', async () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [createNestedAssistantMessage('I found 3 test files.')];

      const { container } = render(
        <SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      await waitFor(() => {
        expect(container.textContent).toContain('I found 3 test files');
      });
    });

    it('should visually mark replaced nested assistant messages', async () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessage = createNestedAssistantMessage('Superseded nested answer.');
      const nestedMessages = [nestedMessage];
      const replacementStatusMap = new Map([[nestedMessage.uuid, 'superseded']]);

      const { container } = render(
        <SubagentBlock
          input={input}
          toolId="toolu_task123"
          nestedMessages={nestedMessages}
          replacementStatusMap={replacementStatusMap}
        />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      await waitFor(() => {
        expect(container.textContent).toContain('Superseded by replacement');
        expect(container.textContent).toContain('Superseded nested answer');
      });
      expect(
        container.querySelector('[data-message-replacement-status="superseded"]')
      ).toBeTruthy();
    });

    it('shows live progress while the subagent card is running', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');

      const { container } = render(
        <SubagentBlock
          input={input}
          toolId="toolu_task123"
          isRunning={true}
          taskProgress={
            {
              type: 'system',
              subtype: 'task_progress',
              task_id: 'task-1',
              tool_use_id: 'toolu_task123',
              description: 'searching',
              usage: { total_tokens: 12400, tool_uses: 3, duration_ms: 8200 },
              last_tool_name: 'Bash',
              summary: 'checking files',
              uuid: 'progress-1',
              session_id: 'session-1',
            } as never
          }
        />
      );

      expect(container.textContent).toContain('Running · 12.4k tok · 3 tools · 8.2s · last: Bash');
      expect(container.textContent).toContain('checking files');
      expect(container.querySelector('[aria-label="running task progress"]')).toBeTruthy();
    });

    it('should render nested user messages', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [createNestedUserMessage('Check in the src folder.')];

      const { container } = render(
        <SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Check in the src folder');
    });

    it('hides stale nested progress after terminal task_notification arrives', async () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [createNestedToolUseMessage()];
      const toolResultsMap = new Map([['toolu_nested123', { content: 'File content here' }]]);
      const taskProgressMap = new Map([
        [
          'toolu_nested123',
          {
            type: 'system',
            subtype: 'task_progress',
            task_id: 't',
            tool_use_id: 'toolu_nested123',
            description: 'reading',
            usage: { total_tokens: 12400, tool_uses: 3, duration_ms: 8200 },
            last_tool_name: 'Read',
          } as never,
        ],
      ]);
      const taskNotificationsMap = new Map([
        [
          'toolu_nested123',
          {
            type: 'system',
            subtype: 'task_notification',
            task_id: 't',
            tool_use_id: 'toolu_nested123',
            status: 'completed',
            output_file: '/tmp/o',
            summary: 'read ok',
          } as never,
        ],
      ]);

      const { container } = render(
        <SubagentBlock
          input={input}
          toolId="toolu_task123"
          nestedMessages={nestedMessages}
          toolResultsMap={toolResultsMap}
          taskProgressMap={taskProgressMap}
          taskNotificationsMap={taskNotificationsMap}
          isRunning={true}
        />
      );

      fireEvent.click(container.querySelector('button')!);
      await waitFor(() => expect(container.textContent).toContain('Read'));
      expect(container.querySelector('[aria-label="running task progress"]')).toBeFalsy();
      expect(container.textContent).not.toContain('Running · 12.4k tok');
      expect(container.querySelector('[aria-label="task completed"]')).toBeTruthy();
    });

    it('folds a nested tool_use task_notification onto the nested ToolResultCard', async () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [createNestedToolUseMessage()];
      const toolResultsMap = new Map([['toolu_nested123', { content: 'File content here' }]]);
      const taskNotificationsMap = new Map([
        [
          'toolu_nested123',
          {
            type: 'system',
            subtype: 'task_notification',
            task_id: 't',
            tool_use_id: 'toolu_nested123',
            status: 'completed',
            output_file: '/tmp/o',
            summary: 'read ok',
          } as never,
        ],
      ]);

      const { container } = render(
        <SubagentBlock
          input={input}
          toolId="toolu_task123"
          nestedMessages={nestedMessages}
          toolResultsMap={toolResultsMap}
          taskNotificationsMap={taskNotificationsMap}
        />
      );

      fireEvent.click(container.querySelector('button')!);
      await waitFor(() => expect(container.textContent).toContain('Read'));
      const cardButtons = container.querySelectorAll('button');
      const nestedCardButton = Array.from(cardButtons).find((b) =>
        b.textContent?.includes('Read')
      )!;
      fireEvent.click(nestedCardButton);

      await waitFor(() => {
        expect(container.textContent).toContain('read ok');
        expect(container.querySelector('[aria-label="task completed"]')).toBeTruthy();
      });
    });

    it('suppresses the standalone nested task_notification row when it is folded', async () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [
        createNestedToolUseMessage(),
        createNestedSystemMessage('task_notification', {
          task_id: 't',
          tool_use_id: 'toolu_nested123',
          status: 'completed',
          output_file: '/tmp/o',
          summary: 'read ok',
        }),
      ];
      const toolResultsMap = new Map([['toolu_nested123', { content: 'File content here' }]]);
      const taskNotificationsMap = new Map([
        [
          'toolu_nested123',
          {
            type: 'system',
            subtype: 'task_notification',
            task_id: 't',
            tool_use_id: 'toolu_nested123',
            status: 'completed',
            output_file: '/tmp/o',
            summary: 'read ok',
          } as never,
        ],
      ]);

      const { container } = render(
        <SubagentBlock
          input={input}
          toolId="toolu_task123"
          nestedMessages={nestedMessages}
          toolResultsMap={toolResultsMap}
          taskNotificationsMap={taskNotificationsMap}
        />
      );

      fireEvent.click(container.querySelector('button')!);
      await waitFor(() => expect(container.textContent).toContain('Read'));

      const checks = container.querySelectorAll('[aria-label="task completed"]');
      expect(checks).toHaveLength(1);
      const headings = container.querySelectorAll('div.font-semibold');
      const dupTaskCompleted = Array.from(headings).filter((h) =>
        h.textContent?.includes('Task completed')
      );
      expect(dupTaskCompleted).toHaveLength(0);
    });

    it('should render nested tool use blocks', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [createNestedToolUseMessage()];
      const toolResultsMap = new Map([['toolu_nested123', { content: 'File content here' }]]);

      const { container } = render(
        <SubagentBlock
          input={input}
          toolId="toolu_task123"
          nestedMessages={nestedMessages}
          toolResultsMap={toolResultsMap}
        />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Read');
    });

    it('should show message count correctly', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [
        createNestedAssistantMessage('First message'),
        createNestedAssistantMessage('Second message'),
        createNestedAssistantMessage('Third message'),
      ];

      const { container } = render(
        <SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Messages (3)');
    });
  });

  describe('Output Extraction', () => {
    it('should extract text from string output', async () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const output = 'Simple text output';

      const { container } = render(
        <SubagentBlock input={input} output={output} toolId="toolu_task123" />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      await waitFor(() => {
        expect(container.textContent).toContain('Simple text output');
      });
    });

    it('should extract text from object output with content field', async () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const output = { content: 'Content from object' };

      const { container } = render(
        <SubagentBlock input={input} output={output} toolId="toolu_task123" />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      await waitFor(() => {
        expect(container.textContent).toContain('Content from object');
      });
    });

    it('should extract text from object output with text field', async () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const output = { text: 'Text from object' };

      const { container } = render(
        <SubagentBlock input={input} output={output} toolId="toolu_task123" />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      await waitFor(() => {
        expect(container.textContent).toContain('Text from object');
      });
    });

    it('should render markdown in output', async () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const output = '# Heading\n\nSome **bold** text.';

      const { container } = render(
        <SubagentBlock input={input} output={output} toolId="toolu_task123" />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      await waitFor(() => {
        expect(container.textContent).toContain('Heading');
        expect(container.textContent).toContain('bold');
      });
    });
  });

  describe('Error State', () => {
    it('should show error icon when isError is true', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');

      const { container } = render(
        <SubagentBlock input={input} isError={true} toolId="toolu_task123" />
      );

      const svg = container.querySelector('svg.text-danger');
      expect(svg).toBeTruthy();
    });

    it('should apply error styling to output text', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const output = 'An error occurred';

      const { container } = render(
        <SubagentBlock input={input} output={output} isError={true} toolId="toolu_task123" />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.querySelector('.text-danger')).toBeTruthy();
    });
  });

  describe('Styling', () => {
    it('should have border and rounded corners', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

      expect(container.querySelector('.border')).toBeTruthy();
      expect(container.querySelector('.rounded-lg')).toBeTruthy();
    });

    it('should apply custom className', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const { container } = render(
        <SubagentBlock input={input} toolId="toolu_task123" className="custom-class" />
      );

      expect(container.querySelector('.custom-class')).toBeTruthy();
    });

    it('should have full width header button', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

      const button = container.querySelector('button');
      expect(button?.className).toContain('w-full');
    });
  });

  describe('Chevron Rotation', () => {
    it('should rotate chevron when expanded', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

      const button = container.querySelector('button')!;

      const chevrons = button.querySelectorAll('svg');
      const chevron = chevrons[chevrons.length - 1];

      expect(chevron?.className.baseVal || chevron?.getAttribute('class')).not.toContain(
        'rotate-180'
      );

      fireEvent.click(button);
      const rotatedChevrons = button.querySelectorAll('svg');
      const rotatedChevron = rotatedChevrons[rotatedChevrons.length - 1];
      expect(rotatedChevron?.className.baseVal || rotatedChevron?.getAttribute('class')).toContain(
        'rotate-180'
      );
    });
  });

  describe('Output Extraction Advanced', () => {
    it('should extract text from content array with text blocks', async () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const output = {
        content: [
          { type: 'text', text: 'First block' },
          { type: 'text', text: 'Second block' },
        ],
      };

      const { container } = render(
        <SubagentBlock input={input} output={output} toolId="toolu_task123" />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      await waitFor(() => {
        expect(container.textContent).toContain('First block');
        expect(container.textContent).toContain('Second block');
      });
    });

    it('should extract text from content array with content field in blocks', async () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const output = {
        content: [{ type: 'document', content: 'Document content here' }],
      };

      const { container } = render(
        <SubagentBlock input={input} output={output} toolId="toolu_task123" />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      await waitFor(() => {
        expect(container.textContent).toContain('Document content here');
      });
    });

    it('should extract text from content array with string items', async () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const output = {
        content: ['String item 1', 'String item 2'],
      };

      const { container } = render(
        <SubagentBlock input={input} output={output} toolId="toolu_task123" />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      await waitFor(() => {
        expect(container.textContent).toContain('String item 1');
        expect(container.textContent).toContain('String item 2');
      });
    });

    it('should extract text from result field', async () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const output = { result: 'Result text here' };

      const { container } = render(
        <SubagentBlock input={input} output={output} toolId="toolu_task123" />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      await waitFor(() => {
        expect(container.textContent).toContain('Result text here');
      });
    });

    it('should fallback to JSON stringify for unknown object structure', async () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const output = { unknown_field: 'value', another: 123 };

      const { container } = render(
        <SubagentBlock input={input} output={output} toolId="toolu_task123" />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      await waitFor(() => {
        expect(container.textContent).toContain('unknown_field');
        expect(container.textContent).toContain('value');
      });
    });

    it('should convert non-object non-string to string', async () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const output = 12345;

      const { container } = render(
        <SubagentBlock input={input} output={output} toolId="toolu_task123" />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      await waitFor(() => {
        expect(container.textContent).toContain('12345');
      });
    });
  });

  describe('Nested Message Types', () => {
    it('should render thinking blocks in assistant messages', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [createNestedThinkingMessage()];

      const { container } = render(
        <SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Let me analyze this problem');
    });

    it('should render result messages', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [createNestedResultMessage('The operation completed successfully')];

      const { container } = render(
        <SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Result');
      expect(container.textContent).toContain('The operation completed successfully');
    });

    it('should render error result messages with error styling', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [createNestedResultMessage('Error occurred', true)];

      const { container } = render(
        <SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.querySelector('.border-danger\\/40, .text-danger')).toBeTruthy();
    });

    it('should skip system init messages', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [createNestedSystemMessage('init')];

      const { container } = render(
        <SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).not.toContain('System: init');
    });

    it('should render visible system messages through the SDK system renderer', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [
        createNestedSystemMessage('informational', {
          level: 'warning',
          content: 'Task running longer than expected',
          prevent_continuation: false,
        }),
      ];

      const { container } = render(
        <SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Info: warning');
      expect(container.textContent).toContain('Task running longer than expected');
    });

    it('should suppress nested transcript-only info and stale worker shutdown rows', async () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [
        createNestedSystemMessage('informational', {
          level: 'info',
          content: 'hidden transcript detail',
        }),
        createNestedSystemMessage('worker_shutting_down', {
          reason: 'host_exit',
        }),
        createNestedAssistantMessage('newer visible work'),
      ];

      const { container } = render(
        <SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).not.toContain('hidden transcript detail');
      expect(container.textContent).not.toContain('Worker shutting down');
      expect(container.textContent).not.toContain('host_exit');
      await waitFor(() => {
        expect(container.textContent).toContain('newer visible work');
      });
    });

    it('should render nested worker shutdown only at the live tail', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [
        createNestedAssistantMessage('last visible work'),
        createNestedSystemMessage('worker_shutting_down', {
          reason: 'host_exit',
        }),
      ];

      const { container } = render(
        <SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Worker shutting down');
      expect(container.textContent).toContain('host_exit');
    });

    it('should hide nested system messages in the centralized HIDDEN set', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [
        createNestedSystemMessage('task_started', {
          description: 'nested task',
        }),
        createNestedSystemMessage('task_progress', {
          description: 'progress update',
        }),
      ];

      const { container } = render(
        <SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).not.toContain('task_started');
      expect(container.textContent).not.toContain('task_progress');
    });

    it('should apply conditional hides to nested system messages', async () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [
        createNestedSystemMessage('files_persisted', {
          failed: [],
          succeeded: ['file.txt'],
        }),
        createNestedSystemMessage('plugin_install', {
          status: 'installed',
          plugin: 'test-plugin',
        }),
        createNestedSystemMessage('plugin_install', {
          status: 'started',
          plugin: 'test-plugin',
        }),
        createNestedAssistantMessage('visible work'),
      ];

      const { container } = render(
        <SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).not.toContain('files_persisted');
      expect(container.textContent).not.toContain('plugin_install');
      await waitFor(() => {
        expect(container.textContent).toContain('visible work');
      });
    });

    it('should render nested permission_denied with the SDK system renderer', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [
        createNestedSystemMessage('permission_denied', {
          tool_name: 'Bash',
          decision_reason: 'Auto-denied by mode',
          message: 'Tool use was not allowed',
          agent_id: 'toolu_task123',
        }),
      ];

      const { container } = render(
        <SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Permission denied');
      expect(container.textContent).toContain('Bash');
      expect(container.textContent).toContain('Auto-denied by mode');
    });

    it('should preserve nested SDK system notices without specialized renderers', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [
        createNestedSystemMessage('generic_system_event', {
          detail: 'unrecognized event',
        }),
      ];

      const { container } = render(
        <SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Messages (1)');
      expect(container.textContent).toContain('System: generic_system_event');
    });

    it('should skip user messages with only tool results', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [createNestedUserMessageWithOnlyToolResult()];

      const { container } = render(
        <SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).not.toContain('Tool result only');
    });

    it('should render user messages with mixed content', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [createNestedUserMessageWithArrayContent()];

      const { container } = render(
        <SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Some user text content');
    });

    it('should render unknown message types with details', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [createUnknownMessage()];

      const { container } = render(
        <SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Unknown message type');
    });

    it('should render tool use with error result', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [createNestedToolUseMessage()];
      const toolResultsMap = new Map([
        ['toolu_nested123', { content: { is_error: true, error: 'File not found' } }],
      ]);

      const { container } = render(
        <SubagentBlock
          input={input}
          toolId="toolu_task123"
          nestedMessages={nestedMessages}
          toolResultsMap={toolResultsMap}
        />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Read');
    });

    it('should handle result message without result text', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [
        {
          type: 'result',
          subtype: 'empty',
          parent_tool_use_id: 'toolu_task123',
          uuid: createUUID(),
          session_id: 'test-session',
        } as unknown as SDKMessage,
      ];

      const { container } = render(
        <SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Messages (1)');
    });

    it('should hide system message without subtype', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [
        {
          type: 'system',
          parent_tool_use_id: 'toolu_task123',
          uuid: createUUID(),
          session_id: 'test-session',
        } as unknown as SDKMessage,
      ];

      const { container } = render(
        <SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).not.toContain('System: message');
      expect(container.textContent).not.toContain('Messages (1)');
    });
  });

  describe('Tool Results with Output Removed', () => {
    it('should handle isOutputRemoved flag', () => {
      const input = createAgentInput('Explore', 'Find files', 'Search for test files');
      const nestedMessages = [createNestedToolUseMessage()];
      const toolResultsMap = new Map([
        ['toolu_nested123', { content: 'Large content', isOutputRemoved: true }],
      ]);

      const { container } = render(
        <SubagentBlock
          input={input}
          toolId="toolu_task123"
          nestedMessages={nestedMessages}
          toolResultsMap={toolResultsMap}
        />
      );

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Read');
    });
  });
});
