import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import type { HyperNeoActionMessage } from '@hyperneo/shared';
import { SDKResumeChoiceMessage } from '../SDKResumeChoiceMessage';

function card(extra: Partial<HyperNeoActionMessage> = {}): HyperNeoActionMessage {
  return {
    type: 'hyperneo_action',
    uuid: 'card-1',
    session_id: 'session-1',
    action: 'sdk_resume_choice',
    resolved: false,
    timestamp: 0,
    ...extra,
  };
}

describe('SDKResumeChoiceMessage', () => {
  it('says the transcript was not found when it is missing', () => {
    const { container } = render(<SDKResumeChoiceMessage message={card()} sessionId="session-1" />);

    expect(container.textContent).toContain('Session transcript not found');
  });

  it('says the transcript could not be repaired, with the reason', () => {
    const { container } = render(
      <SDKResumeChoiceMessage
        message={card({ repairError: 'Could not find tool_use message for t9' })}
        sessionId="session-1"
      />
    );

    expect(container.textContent).toContain('Session transcript could not be repaired');
    expect(container.textContent).toContain('Could not find tool_use message for t9');
    expect(container.textContent).not.toContain('not found');
  });
});
