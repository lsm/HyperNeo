import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import type { WorkflowChannel } from '@hyperneo/shared';
import { ChannelEdgeConfigPanel } from '../visual-editor/ChannelEdgeConfigPanel';

function makeChannel(overrides: Partial<WorkflowChannel> = {}): WorkflowChannel {
  return {
    from: 'agent-a',
    to: 'agent-b',
    ...overrides,
  };
}

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    index: 0,
    channel: makeChannel(),
    onChange: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
    showHeader: false,
    ...overrides,
  };
}

describe('ChannelEdgeConfigPanel', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders channel from and to agents', () => {
    const channel = makeChannel({ from: 'agent-a', to: 'agent-b' });
    const { getByText } = render(<ChannelEdgeConfigPanel {...defaultProps({ channel })} />);
    expect(getByText('agent-a')).toBeTruthy();
    expect(getByText('agent-b')).toBeTruthy();
  });

  it('renders multiple "to" agents joined by comma', () => {
    const channel = makeChannel({ from: 'agent-a', to: ['agent-b', 'agent-c'] });
    const { getByText } = render(<ChannelEdgeConfigPanel {...defaultProps({ channel })} />);
    expect(getByText('agent-b, agent-c')).toBeTruthy();
  });

  it('renders cyclic info with max-cycles input when shouldBeCyclic is true', () => {
    const channel = makeChannel({ maxCycles: 7 });
    const { getByTestId } = render(
      <ChannelEdgeConfigPanel {...defaultProps({ channel, shouldBeCyclic: true })} />
    );
    expect(getByTestId('channel-cyclic-info')).toBeTruthy();
    const input = getByTestId('channel-max-cycles-input') as HTMLInputElement;
    expect(input.value).toBe('7');
  });

  it('defaults max-cycles to 5 when channel has no maxCycles', () => {
    const { getByTestId } = render(
      <ChannelEdgeConfigPanel {...defaultProps({ shouldBeCyclic: true })} />
    );
    const input = getByTestId('channel-max-cycles-input') as HTMLInputElement;
    expect(input.value).toBe('5');
  });

  it('calls onChange with the new maxCycles when the input changes', () => {
    const onChange = vi.fn();
    const channel = makeChannel({ maxCycles: 5 });
    const { getByTestId } = render(
      <ChannelEdgeConfigPanel {...defaultProps({ channel, onChange, shouldBeCyclic: true })} />
    );
    const input = getByTestId('channel-max-cycles-input');
    fireEvent.change(input, { target: { value: '12' } });
    expect(onChange).toHaveBeenCalledWith(0, { ...channel, maxCycles: 12 });
  });

  it('does not render cyclic info when shouldBeCyclic is false', () => {
    const { queryByTestId } = render(
      <ChannelEdgeConfigPanel {...defaultProps({ shouldBeCyclic: false })} />
    );
    expect(queryByTestId('channel-cyclic-info')).toBeNull();
    expect(queryByTestId('channel-max-cycles-input')).toBeNull();
  });

  it('renders Delete channel button and calls onDelete with the index', () => {
    const onDelete = vi.fn();
    const { getByTestId } = render(
      <ChannelEdgeConfigPanel {...defaultProps({ index: 2, onDelete })} />
    );
    const button = getByTestId('delete-channel-button');
    expect(button.textContent).toBe('Delete channel');
    fireEvent.click(button);
    expect(onDelete).toHaveBeenCalledWith(2);
  });

  it('renders close button when showHeader is true', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(
      <ChannelEdgeConfigPanel {...defaultProps({ onClose, showHeader: true })} />
    );
    const button = getByTestId('channel-close-button');
    fireEvent.click(button);
    expect(onClose).toHaveBeenCalled();
  });
});
