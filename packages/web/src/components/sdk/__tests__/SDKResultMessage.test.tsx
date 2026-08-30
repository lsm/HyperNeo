// @ts-nocheck
import { describe, it, expect } from 'vitest';

import { render, fireEvent } from '@testing-library/preact';
import { SDKResultMessage } from '../SDKResultMessage';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import type { UUID } from 'crypto';

const createUUID = (): UUID => crypto.randomUUID() as UUID;

function createSuccessResult(
  overrides: Partial<Extract<SDKMessage, { type: 'result'; subtype: 'success' }>> = {}
): Extract<SDKMessage, { type: 'result' }> {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 5000,
    duration_api_ms: 4500,
    is_error: false,
    num_turns: 3,
    result: 'Task completed successfully',
    total_cost_usd: 0.0125,
    usage: {
      input_tokens: 1500,
      output_tokens: 500,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 100,
    },
    modelUsage: {
      'claude-3-5-sonnet-20241022': {
        inputTokens: 1500,
        outputTokens: 500,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 100,
        webSearchRequests: 0,
        costUSD: 0.0125,
        contextWindow: 200000,
      },
    },
    permission_denials: [],
    uuid: createUUID(),
    session_id: 'test-session',
    ...overrides,
  } as unknown as Extract<SDKMessage, { type: 'result' }>;
}

function createErrorResult(
  errorSubtype:
    | 'error_during_execution'
    | 'error_max_turns'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries' = 'error_during_execution'
): Extract<SDKMessage, { type: 'result' }> {
  return {
    type: 'result',
    subtype: errorSubtype,
    duration_ms: 2000,
    duration_api_ms: 1800,
    is_error: true,
    num_turns: 1,
    total_cost_usd: 0.005,
    usage: {
      input_tokens: 500,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    errors: ['Something went wrong', 'Additional error info'],
    uuid: createUUID(),
    session_id: 'test-session',
  } as unknown as Extract<SDKMessage, { type: 'result' }>;
}

function createResultWithPermissionDenials(): Extract<SDKMessage, { type: 'result' }> {
  return {
    ...createSuccessResult(),
    permission_denials: [
      {
        tool_name: 'Bash',
        tool_use_id: 'toolu_bash123',
        tool_input: { command: 'rm -rf /' },
      },
      {
        tool_name: 'Write',
        tool_use_id: 'toolu_write456',
        tool_input: { file_path: '/etc/passwd', content: 'malicious' },
      },
    ],
  } as unknown as Extract<SDKMessage, { type: 'result' }>;
}

function createResultWithStructuredOutput(): Extract<SDKMessage, { type: 'result' }> {
  return {
    ...createSuccessResult(),
    structured_output: {
      summary: 'Analysis complete',
      findings: [
        { type: 'info', message: 'Found 5 files' },
        { type: 'warning', message: '2 files need attention' },
      ],
    },
  } as unknown as Extract<SDKMessage, { type: 'result' }>;
}

describe('SDKResultMessage', () => {
  describe('Compact Summary (Collapsed State)', () => {
    it('should show token summary', () => {
      const message = createSuccessResult();
      const { container } = render(<SDKResultMessage message={message} />);

      expect(container.textContent).toContain('1500');
      expect(container.textContent).toContain('500');
      expect(container.textContent).toContain('tokens');
    });

    it('should handle missing usage gracefully', () => {
      const message = createSuccessResult({ usage: undefined as unknown });
      const { container } = render(<SDKResultMessage message={message} />);

      expect(container.textContent).toContain('0→0 tokens');
    });

    it('should show cost', () => {
      const message = createSuccessResult();
      const { container } = render(<SDKResultMessage message={message} />);

      expect(container.textContent).toContain('$0.0125');
    });

    it('should show duration', () => {
      const message = createSuccessResult();
      const { container } = render(<SDKResultMessage message={message} />);

      expect(container.textContent).toContain('5.00s');
    });

    it('should show success icon for successful result', () => {
      const message = createSuccessResult();
      const { container } = render(<SDKResultMessage message={message} />);

      const svg = container.querySelector('svg.text-success');
      expect(svg).toBeTruthy();
    });

    it('should show error icon for error result', () => {
      const message = createErrorResult();
      const { container } = render(<SDKResultMessage message={message} />);

      const svg = container.querySelector('svg.text-danger');
      expect(svg).toBeTruthy();
    });

    it('should have expandable button', () => {
      const message = createSuccessResult();
      const { container } = render(<SDKResultMessage message={message} />);

      const button = container.querySelector('button');
      expect(button).toBeTruthy();
    });
  });

  describe('Expanded Details', () => {
    it('should expand when button is clicked', () => {
      const message = createSuccessResult();
      const { container } = render(<SDKResultMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Input Tokens');
    });

    it('should show full statistics when expanded', () => {
      const message = createSuccessResult();
      const { container } = render(<SDKResultMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Input Tokens');
      expect(container.textContent).toContain('Output Tokens');
      expect(container.textContent).toContain('Cost');
      expect(container.textContent).toContain('Duration');
    });

    it('should show cache statistics when present', () => {
      const message = createSuccessResult();
      const { container } = render(<SDKResultMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Cache Read');
      expect(container.textContent).toContain('200');
    });

    it('should show turns and API time', () => {
      const message = createSuccessResult();
      const { container } = render(<SDKResultMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('3 turns');
      expect(container.textContent).toContain('API time');
      expect(container.textContent).toContain('4.50s');
    });

    it('should collapse when button is clicked again', () => {
      const message = createSuccessResult();
      const { container } = render(<SDKResultMessage message={message} />);

      const button = container.querySelector('button')!;

      fireEvent.click(button);
      expect(container.textContent).toContain('Input Tokens');

      fireEvent.click(button);
      expect(container.querySelector('.grid-cols-2')).toBeFalsy();
    });
  });

  describe('Model Usage Breakdown', () => {
    it('should show model usage when expanded', () => {
      const message = createSuccessResult();
      const { container } = render(<SDKResultMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Model Usage Breakdown');
      expect(container.textContent).toContain('claude-3-5-sonnet-20241022');
    });

    it('should show per-model statistics', () => {
      const message = createSuccessResult();
      const { container } = render(<SDKResultMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Input: 1,500');
      expect(container.textContent).toContain('Output: 500');
      expect(container.textContent).toContain('Context: 200,000');
    });
  });

  describe('Permission Denials', () => {
    it('should show permission denials when present', () => {
      const message = createResultWithPermissionDenials();
      const { container } = render(<SDKResultMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Permissions Denied');
      expect(container.textContent).toContain('2');
    });

    it('should list denied tools', () => {
      const message = createResultWithPermissionDenials();
      const { container } = render(<SDKResultMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Bash');
      expect(container.textContent).toContain('Write');
    });

    it('should not show permission denials section when empty', () => {
      const message = createSuccessResult();
      const { container } = render(<SDKResultMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).not.toContain('Permissions Denied');
    });
  });

  describe('Structured Output', () => {
    it('should show structured output when present', () => {
      const message = createResultWithStructuredOutput();
      const { container } = render(<SDKResultMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Structured Output');
    });

    it('should render structured output as JSON', () => {
      const message = createResultWithStructuredOutput();
      const { container } = render(<SDKResultMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('summary');
      expect(container.textContent).toContain('Analysis complete');
    });
  });

  describe('Error Results', () => {
    it('should show errors section for error results', () => {
      const message = createErrorResult();
      const { container } = render(<SDKResultMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Errors');
      expect(container.textContent).toContain('Something went wrong');
      expect(container.textContent).toContain('Additional error info');
    });

    it('should have error styling', () => {
      const message = createErrorResult();
      const { container } = render(<SDKResultMessage message={message} />);

      expect(container.querySelector('[class*="bg-danger/10"]')).toBeTruthy();
    });
  });

  describe('Success Result', () => {
    it('should show result text when expanded', () => {
      const message = createSuccessResult();
      const { container } = render(<SDKResultMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('Result');
      expect(container.textContent).toContain('Task completed successfully');
    });
  });

  describe('Styling', () => {
    it('should have success styling for successful result', () => {
      const message = createSuccessResult();
      const { container } = render(<SDKResultMessage message={message} />);

      expect(container.querySelector('[class*="bg-success/10"]')).toBeTruthy();
    });

    it('should have error styling for error result', () => {
      const message = createErrorResult();
      const { container } = render(<SDKResultMessage message={message} />);

      expect(container.querySelector('[class*="bg-danger/10"]')).toBeTruthy();
    });

    it('should have rounded border', () => {
      const message = createSuccessResult();
      const { container } = render(<SDKResultMessage message={message} />);

      expect(container.querySelector('.rounded')).toBeTruthy();
    });
  });

  describe('Number Formatting', () => {
    it('should format large numbers with commas', () => {
      const message = createSuccessResult({
        usage: {
          input_tokens: 150000,
          output_tokens: 50000,
          cache_read_input_tokens: 20000,
          cache_creation_input_tokens: 10000,
        },
      });
      const { container } = render(<SDKResultMessage message={message} />);

      const button = container.querySelector('button')!;
      fireEvent.click(button);

      expect(container.textContent).toContain('150,000');
      expect(container.textContent).toContain('50,000');
    });

    it('should format cost with 4 decimal places', () => {
      const message = createSuccessResult({ total_cost_usd: 0.00015 });
      const { container } = render(<SDKResultMessage message={message} />);

      expect(container.textContent).toMatch(/\$0\.000[12]/);
    });

    it('should format duration with 2 decimal places', () => {
      const message = createSuccessResult({ duration_ms: 12345 });
      const { container } = render(<SDKResultMessage message={message} />);

      expect(container.textContent).toContain('12.35s');
    });
  });

  describe('Error Types', () => {
    it('should handle max_turns error', () => {
      const message = createErrorResult('error_max_turns');
      const { container } = render(<SDKResultMessage message={message} />);

      expect(container.querySelector('button')).toBeTruthy();
    });

    it('should handle max_budget_usd error', () => {
      const message = createErrorResult('error_max_budget_usd');
      const { container } = render(<SDKResultMessage message={message} />);

      expect(container.querySelector('button')).toBeTruthy();
    });

    it('should handle structured_output_retries error', () => {
      const message = createErrorResult('error_max_structured_output_retries');
      const { container } = render(<SDKResultMessage message={message} />);

      expect(container.querySelector('button')).toBeTruthy();
    });
  });
});
