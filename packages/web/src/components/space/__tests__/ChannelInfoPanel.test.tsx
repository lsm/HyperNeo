// @ts-nocheck

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import type { ResolvedWorkflowChannel } from '../visual-editor/EdgeRenderer';
import { ChannelInfoPanel } from '../ChannelInfoPanel';

vi.mock('../../../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

function makeChannel(overrides: Partial<ResolvedWorkflowChannel> = {}): ResolvedWorkflowChannel {
  return {
    fromStepId: 'step-a',
    toStepId: 'step-b',
    direction: 'one-way',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('ChannelInfoPanel', () => {
  it('renders from→to node names', () => {
    const { getByText } = render(
      <ChannelInfoPanel
        channel={makeChannel()}
        fromNodeName="Planner"
        toNodeName="Coder"
        onClose={() => {}}
      />
    );
    expect(getByText('Planner')).toBeTruthy();
    expect(getByText('Coder')).toBeTruthy();
  });

  it('shows → arrow for one-way channels', () => {
    const { getByText } = render(
      <ChannelInfoPanel
        channel={makeChannel({ direction: 'one-way' })}
        fromNodeName="A"
        toNodeName="B"
        onClose={() => {}}
      />
    );
    expect(getByText('→')).toBeTruthy();
  });

  it('shows ⇄ arrow for bidirectional channels', () => {
    const { getByText } = render(
      <ChannelInfoPanel
        channel={makeChannel({ direction: 'bidirectional' })}
        fromNodeName="A"
        toNodeName="B"
        onClose={() => {}}
      />
    );
    expect(getByText('⇄')).toBeTruthy();
  });

  it('shows ↩ loop badge when isCyclic=true', () => {
    const { getByText } = render(
      <ChannelInfoPanel
        channel={makeChannel({ isCyclic: true })}
        fromNodeName="A"
        toNodeName="B"
        onClose={() => {}}
      />
    );
    expect(getByText('↩ loop')).toBeTruthy();
  });

  it('does not show ↩ loop badge when isCyclic is not set', () => {
    const { queryByText } = render(
      <ChannelInfoPanel
        channel={makeChannel()}
        fromNodeName="A"
        toNodeName="B"
        onClose={() => {}}
      />
    );
    expect(queryByText('↩ loop')).toBeNull();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    const { getByLabelText } = render(
      <ChannelInfoPanel channel={makeChannel()} fromNodeName="A" toNodeName="B" onClose={onClose} />
    );
    fireEvent.click(getByLabelText('Close channel info'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders with data-testid="channel-info-panel"', () => {
    const { getByTestId } = render(
      <ChannelInfoPanel
        channel={makeChannel()}
        fromNodeName="A"
        toNodeName="B"
        onClose={() => {}}
      />
    );
    expect(getByTestId('channel-info-panel')).toBeTruthy();
  });
});
