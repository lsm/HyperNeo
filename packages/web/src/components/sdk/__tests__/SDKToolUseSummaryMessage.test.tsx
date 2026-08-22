// @ts-nocheck
import { describe, it, expect } from 'vitest';

import { render } from '@testing-library/preact';
import { SDKToolUseSummaryMessage } from '../SDKToolUseSummaryMessage';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import type { UUID } from 'crypto';

const createUUID = (): UUID => crypto.randomUUID() as UUID;

function createToolUseSummaryMessage(
  summary: string,
  precedingToolUseIds: string[] = []
): Extract<SDKMessage, { type: 'tool_use_summary' }> {
  return {
    type: 'tool_use_summary',
    summary,
    preceding_tool_use_ids: precedingToolUseIds,
    uuid: createUUID(),
    session_id: 'test-session',
  };
}

describe('SDKToolUseSummaryMessage', () => {
  it('should render the summary text', () => {
    const message = createToolUseSummaryMessage('Searched the codebase for renderers');
    const { container } = render(<SDKToolUseSummaryMessage message={message} />);

    expect(container.textContent).toContain('Searched the codebase for renderers');
  });

  it('should label the row as a tool summary', () => {
    const message = createToolUseSummaryMessage('Read three files');
    const { container } = render(<SDKToolUseSummaryMessage message={message} />);

    expect(container.textContent).toContain('Tool summary');
  });

  it('should expose a tool-use-summary test id', () => {
    const message = createToolUseSummaryMessage('Ran the formatter');
    const { container } = render(<SDKToolUseSummaryMessage message={message} />);

    expect(container.querySelector('[data-testid="tool-use-summary"]')).toBeTruthy();
  });

  it('should show the preceding tool use count', () => {
    const message = createToolUseSummaryMessage('Edited two files', [
      'toolu_first',
      'toolu_second',
    ]);
    const { container } = render(<SDKToolUseSummaryMessage message={message} />);

    expect(container.textContent).toContain('2 tool uses');
  });

  it('should use the singular form for a single preceding tool use', () => {
    const message = createToolUseSummaryMessage('Edited one file', ['toolu_only']);
    const { container } = render(<SDKToolUseSummaryMessage message={message} />);

    expect(container.textContent).toContain('1 tool use');
    expect(container.textContent).not.toContain('1 tool uses');
  });

  it('should omit the count when there are no preceding tool uses', () => {
    const message = createToolUseSummaryMessage('Standalone summary');
    const { container } = render(<SDKToolUseSummaryMessage message={message} />);

    expect(container.textContent).not.toContain('tool use');
    expect(container.textContent).toContain('Standalone summary');
  });

  it('should render nothing for a blank summary', () => {
    const message = createToolUseSummaryMessage('   ');
    const { container } = render(<SDKToolUseSummaryMessage message={message} />);

    expect(container.innerHTML).toBe('');
  });
});
