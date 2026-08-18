// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import { ResultInfoDropdown } from '../ResultInfoDropdown';

type ResultMessage = Extract<SDKMessage, { type: 'result' }>;

function createUUID() {
  return crypto.randomUUID();
}

function createSuccessResult(overrides: Partial<ResultMessage> = {}): ResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 12_345,
    duration_api_ms: 9_876,
    is_error: false,
    num_turns: 7,
    result: 'all done',
    stop_reason: 'end_turn',
    total_cost_usd: 0.0523,
    usage: {
      input_tokens: 1_234,
      output_tokens: 567,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 100,
    },
    modelUsage: {
      'claude-3-5-sonnet-20241022': { input_tokens: 1_234, output_tokens: 567 },
    },
    permission_denials: [],
    uuid: createUUID(),
    session_id: 'test-session',
    ...overrides,
  };
}

function createErrorResult(overrides: Partial<ResultMessage> = {}): ResultMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    duration_ms: 4_321,
    duration_api_ms: 3_210,
    is_error: true,
    num_turns: 3,
    errors: ['Tool call failed: ENOENT', 'Timeout after 30s'],
    stop_reason: null,
    total_cost_usd: 0.0103,
    usage: {
      input_tokens: 500,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    permission_denials: [],
    uuid: createUUID(),
    session_id: 'test-session',
    ...overrides,
  };
}

describe('ResultInfoDropdown', () => {
  describe('Header', () => {
    it('renders "Run Complete" header for success subtype', () => {
      const { container } = render(<ResultInfoDropdown result={createSuccessResult()} />);
      expect(container.textContent).toContain('Run Complete');
      expect(container.textContent).toContain('success');
    });

    it('renders "Run Error" header for error subtypes', () => {
      const { container } = render(<ResultInfoDropdown result={createErrorResult()} />);
      expect(container.textContent).toContain('Run Error');
      expect(container.textContent).toContain('error_during_execution');
    });
  });

  describe('Usage block', () => {
    it('shows input + output token counts (humanized)', () => {
      const { container } = render(<ResultInfoDropdown result={createSuccessResult()} />);
      expect(container.textContent).toContain('Input');
      expect(container.textContent).toContain('Output');
      expect(container.textContent).toContain('1.2k');
      expect(container.textContent).toContain('567');
    });

    it('shows cache tokens only when present', () => {
      const { container: c1 } = render(<ResultInfoDropdown result={createSuccessResult()} />);
      expect(c1.textContent).toContain('Cache read');
      expect(c1.textContent).toContain('Cache write');

      const { container: c2 } = render(
        <ResultInfoDropdown
          result={createSuccessResult({
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          })}
        />
      );
      expect(c2.textContent).not.toContain('Cache read');
      expect(c2.textContent).not.toContain('Cache write');
    });
  });

  describe('Run block', () => {
    it('shows duration / API time / turns / cost', () => {
      const { container } = render(<ResultInfoDropdown result={createSuccessResult()} />);
      expect(container.textContent).toContain('12.3s');
      expect(container.textContent).toContain('9.9s');
      expect(container.textContent).toContain('7');
      expect(container.textContent).toContain('$0.0523');
    });
  });

  describe('Errors block', () => {
    it('lists each error string for error subtypes', () => {
      const { container } = render(<ResultInfoDropdown result={createErrorResult()} />);
      expect(container.textContent).toContain('Errors (2)');
      expect(container.textContent).toContain('Tool call failed: ENOENT');
      expect(container.textContent).toContain('Timeout after 30s');
    });

    it('does not render errors block for success subtype', () => {
      const { container } = render(<ResultInfoDropdown result={createSuccessResult()} />);
      expect(container.textContent).not.toContain('Errors (');
    });
  });

  describe('Models block', () => {
    it('lists model names from modelUsage', () => {
      const { container } = render(<ResultInfoDropdown result={createSuccessResult()} />);
      expect(container.textContent).toContain('claude-3-5-sonnet-20241022');
    });
  });

  describe('Theme', () => {
    it('uses emerald accent for success subtype', () => {
      const { container } = render(<ResultInfoDropdown result={createSuccessResult()} />);
      const wrapper = container.querySelector('[data-testid="result-info-dropdown"]');
      expect(wrapper?.className).toMatch(/emerald/);
      expect(wrapper?.className).not.toMatch(/amber/);
    });

    it('uses amber accent for error subtypes', () => {
      const { container } = render(<ResultInfoDropdown result={createErrorResult()} />);
      const wrapper = container.querySelector('[data-testid="result-info-dropdown"]');
      expect(wrapper?.className).toMatch(/amber/);
      expect(wrapper?.className).not.toMatch(/emerald/);
    });
  });
});
