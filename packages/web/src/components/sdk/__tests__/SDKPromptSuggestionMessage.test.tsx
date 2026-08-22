// @ts-nocheck
import { describe, it, expect } from 'vitest';

import { render } from '@testing-library/preact';
import { SDKPromptSuggestionMessage } from '../SDKPromptSuggestionMessage';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import type { UUID } from 'crypto';

const createUUID = (): UUID => crypto.randomUUID() as UUID;

function createPromptSuggestionMessage(
  suggestion: string
): Extract<SDKMessage, { type: 'prompt_suggestion' }> {
  return {
    type: 'prompt_suggestion',
    suggestion,
    uuid: createUUID(),
    session_id: 'test-session',
  };
}

describe('SDKPromptSuggestionMessage', () => {
  it('should render the suggestion text', () => {
    const message = createPromptSuggestionMessage('Add unit tests for the renderer');
    const { container } = render(<SDKPromptSuggestionMessage message={message} />);

    expect(container.textContent).toContain('Add unit tests for the renderer');
  });

  it('should label the row as a suggested follow-up', () => {
    const message = createPromptSuggestionMessage('Run the test suite');
    const { container } = render(<SDKPromptSuggestionMessage message={message} />);

    expect(container.textContent).toContain('Suggested follow-up');
  });

  it('should expose a prompt-suggestion test id', () => {
    const message = createPromptSuggestionMessage('Summarize the diff');
    const { container } = render(<SDKPromptSuggestionMessage message={message} />);

    expect(container.querySelector('[data-testid="prompt-suggestion"]')).toBeTruthy();
  });

  it('should render nothing for a blank suggestion', () => {
    const message = createPromptSuggestionMessage('   ');
    const { container } = render(<SDKPromptSuggestionMessage message={message} />);

    expect(container.innerHTML).toBe('');
  });

  it('should render nothing for a missing suggestion', () => {
    const message = { ...createPromptSuggestionMessage('x'), suggestion: undefined };
    const { container } = render(<SDKPromptSuggestionMessage message={message} />);

    expect(container.innerHTML).toBe('');
  });
});
