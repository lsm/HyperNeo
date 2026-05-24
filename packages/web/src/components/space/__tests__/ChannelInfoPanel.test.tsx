// @ts-nocheck
/**
 * Unit tests for ChannelInfoPanel
 *
 * Tests:
 * 1. Renders from→to node names
 * 2. Shows gate label when gateType is set
 * 3. Shows runtime status dot and label for all three: open/waiting_human/blocked
 * 4. Shows "No gate" when no gate type and no status
 * 5. Shows ↩ loop badge when isCyclic=true
 * 6. Calls onClose when close button is clicked
 * 7. Shows ⇄ arrow for bidirectional channels, → for one-way
 */

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

  it('shows gate label when gateType is set', () => {
    const { getByText } = render(
      <ChannelInfoPanel
        channel={makeChannel({ gateType: 'human' })}
        fromNodeName="A"
        toNodeName="B"
        onClose={() => {}}
      />
    );
    expect(getByText('Human Approval')).toBeTruthy();
  });

  it('shows custom gateLabel when provided', () => {
    const { getByText } = render(
      <ChannelInfoPanel
        channel={makeChannel({ gateType: 'condition', gateLabel: 'Tests Pass' })}
        fromNodeName="A"
        toNodeName="B"
        onClose={() => {}}
      />
    );
    expect(getByText('Tests Pass')).toBeTruthy();
  });

  it('shows runtime status open', () => {
    const { getByText } = render(
      <ChannelInfoPanel
        channel={makeChannel({ runtimeStatus: 'open' })}
        fromNodeName="A"
        toNodeName="B"
        onClose={() => {}}
      />
    );
    expect(getByText('Open')).toBeTruthy();
  });

  it('shows runtime status waiting_human', () => {
    const { getByText } = render(
      <ChannelInfoPanel
        channel={makeChannel({ runtimeStatus: 'waiting_human' })}
        fromNodeName="A"
        toNodeName="B"
        onClose={() => {}}
      />
    );
    expect(getByText('Waiting for Approval')).toBeTruthy();
  });

  it('shows runtime status blocked', () => {
    const { getByText } = render(
      <ChannelInfoPanel
        channel={makeChannel({ runtimeStatus: 'blocked' })}
        fromNodeName="A"
        toNodeName="B"
        onClose={() => {}}
      />
    );
    expect(getByText('Blocked')).toBeTruthy();
  });

  it('shows "No gate" when no gate type and no status', () => {
    const { getByText } = render(
      <ChannelInfoPanel
        channel={makeChannel()}
        fromNodeName="A"
        toNodeName="B"
        onClose={() => {}}
      />
    );
    expect(getByText('No gate')).toBeTruthy();
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
