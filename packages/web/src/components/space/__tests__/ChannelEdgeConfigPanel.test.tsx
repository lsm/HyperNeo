/**
 * Unit tests for ChannelEdgeConfigPanel — gate summary section
 *
 * Tests:
 * - Gate without label, color, or script shows standard display
 * - Gate with custom label shows a label badge
 * - Gate with custom color shows a colored dot
 * - Gate with both label and color shows both indicators
 * - Gate with script configured shows lightning bolt indicator
 * - Gate with label, color, and script shows all three indicators
 * - Gate with script but no fields does NOT show "No fields defined yet"
 * - Gate with no fields and no script shows "No fields defined yet"
 * - Gate with both fields and script renders field rows
 * - No gate shows "No gate — always open" text
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/preact';
import type { Gate, WorkflowChannel } from '@neokai/shared';
import { ChannelEdgeConfigPanel } from '../visual-editor/ChannelEdgeConfigPanel';

// ============================================================================
// Helpers
// ============================================================================

function makeChannel(overrides: Partial<WorkflowChannel> = {}): WorkflowChannel {
  return {
    from: 'agent-a',
    to: 'agent-b',
    ...overrides,
  };
}

function makeGate(overrides: Partial<Gate> = {}): Gate {
  return {
    id: 'gate-abc123',
    resetOnCycle: false,
    ...overrides,
  };
}

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    index: 0,
    channel: makeChannel(),
    gates: [],
    onChange: vi.fn(),
    onDelete: vi.fn(),
    onGatesChange: vi.fn(),
    onEditGate: vi.fn(),
    onClose: vi.fn(),
    showHeader: false,
    showDirectionControls: false,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ChannelEdgeConfigPanel — gate summary', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows "No gate — always open" when no gate is assigned', () => {
    const channel = makeChannel({ gateId: undefined });
    const { getByText, queryByTestId } = render(
      <ChannelEdgeConfigPanel {...defaultProps({ channel, gates: [] })} />
    );
    expect(getByText('No gate \u2014 always open')).toBeTruthy();
    expect(queryByTestId('gate-color-dot')).toBeNull();
    expect(queryByTestId('gate-label-badge')).toBeNull();
    expect(queryByTestId('gate-script-indicator')).toBeNull();
  });

  it('shows gate ID only when gate has no label, color, or script', () => {
    const gate = makeGate();
    const channel = makeChannel({ gateId: gate.id });
    const { getByText, queryByTestId } = render(
      <ChannelEdgeConfigPanel {...defaultProps({ channel, gates: [gate] })} />
    );
    expect(getByText(gate.id)).toBeTruthy();
    expect(queryByTestId('gate-color-dot')).toBeNull();
    expect(queryByTestId('gate-label-badge')).toBeNull();
    expect(queryByTestId('gate-script-indicator')).toBeNull();
  });

  it('shows label badge when gate has a custom label', () => {
    const gate = makeGate({ label: 'Quality Check' });
    const channel = makeChannel({ gateId: gate.id });
    const { getByTestId } = render(
      <ChannelEdgeConfigPanel {...defaultProps({ channel, gates: [gate] })} />
    );
    const badge = getByTestId('gate-label-badge');
    expect(badge.textContent).toBe('Quality Check');
    expect(badge.getAttribute('title')).toBe('Quality Check');
  });

  it('shows colored dot when gate has a custom color', () => {
    const gate = makeGate({ color: '#ff6600' });
    const channel = makeChannel({ gateId: gate.id });
    const { getByTestId } = render(
      <ChannelEdgeConfigPanel {...defaultProps({ channel, gates: [gate] })} />
    );
    const dot = getByTestId('gate-color-dot');
    expect(dot.style.backgroundColor).toBe('#ff6600');
    expect(dot.getAttribute('title')).toBe('Color: #ff6600');
  });

  it('shows both colored dot and label badge when gate has both label and color', () => {
    const gate = makeGate({ label: 'Deploy Gate', color: '#22c55e' });
    const channel = makeChannel({ gateId: gate.id });
    const { getByTestId } = render(
      <ChannelEdgeConfigPanel {...defaultProps({ channel, gates: [gate] })} />
    );

    const dot = getByTestId('gate-color-dot');
    expect(dot.style.backgroundColor).toBe('#22c55e');

    const badge = getByTestId('gate-label-badge');
    expect(badge.textContent).toBe('Deploy Gate');
    // Badge text color should use the gate's color
    expect(badge.style.color).toBe('#22c55e');
  });

  it('shows script indicator with interpreter name in title when gate has a script', () => {
    const gate = makeGate({
      script: { interpreter: 'python3', source: 'print("check")' },
    });
    const channel = makeChannel({ gateId: gate.id });
    const { getByTestId } = render(
      <ChannelEdgeConfigPanel {...defaultProps({ channel, gates: [gate] })} />
    );
    const indicator = getByTestId('gate-script-indicator');
    expect(indicator.getAttribute('title')).toBe('Script: python3');
    expect(indicator.textContent).toBe('\u26A1');
  });

  it('shows script indicator with bash interpreter', () => {
    const gate = makeGate({
      script: { interpreter: 'bash', source: 'exit 0' },
    });
    const channel = makeChannel({ gateId: gate.id });
    const { getByTestId } = render(
      <ChannelEdgeConfigPanel {...defaultProps({ channel, gates: [gate] })} />
    );
    expect(getByTestId('gate-script-indicator').getAttribute('title')).toBe('Script: bash');
  });

  it('shows all three indicators (label, color, script) together', () => {
    const gate = makeGate({
      label: 'Critical Review',
      color: '#ef4444',
      script: { interpreter: 'node', source: 'console.log("ok")' },
    });
    const channel = makeChannel({ gateId: gate.id });
    const { getByTestId } = render(
      <ChannelEdgeConfigPanel {...defaultProps({ channel, gates: [gate] })} />
    );

    expect(getByTestId('gate-color-dot').style.backgroundColor).toBe('#ef4444');
    expect(getByTestId('gate-label-badge').textContent).toBe('Critical Review');
    expect(getByTestId('gate-label-badge').style.color).toBe('#ef4444');
    expect(getByTestId('gate-script-indicator').getAttribute('title')).toBe('Script: node');
  });

  it('does not show "No fields defined yet" when gate has script but no fields', () => {
    const gate = makeGate({
      fields: [],
      script: { interpreter: 'bash', source: 'true' },
    });
    const channel = makeChannel({ gateId: gate.id });
    const { queryByText } = render(
      <ChannelEdgeConfigPanel {...defaultProps({ channel, gates: [gate] })} />
    );
    expect(queryByText('No fields defined yet')).toBeNull();
  });

  it('shows "No fields defined yet" when gate has no fields and no script', () => {
    const gate = makeGate({ fields: [] });
    const channel = makeChannel({ gateId: gate.id });
    const { getByText } = render(
      <ChannelEdgeConfigPanel {...defaultProps({ channel, gates: [gate] })} />
    );
    expect(getByText('No fields defined yet')).toBeTruthy();
  });

  it('shows "No fields defined yet" when gate has undefined fields and no script', () => {
    const gate = makeGate({ fields: undefined });
    const channel = makeChannel({ gateId: gate.id });
    const { getByText } = render(
      <ChannelEdgeConfigPanel {...defaultProps({ channel, gates: [gate] })} />
    );
    expect(getByText('No fields defined yet')).toBeTruthy();
  });

  it('renders field rows when gate has both fields and script', () => {
    const gate = makeGate({
      fields: [
        {
          name: 'approved',
          type: 'boolean',
          writers: [],
          check: { op: '==', value: true },
        },
        { name: 'score', type: 'number', writers: ['*'], check: { op: 'exists' } },
      ],
      script: { interpreter: 'bash', source: 'true' },
    });
    const channel = makeChannel({ gateId: gate.id });
    const { getByText, getByTestId, queryByText } = render(
      <ChannelEdgeConfigPanel {...defaultProps({ channel, gates: [gate] })} />
    );
    // Field rows should still be rendered alongside the script indicator
    expect(getByText('approved')).toBeTruthy();
    expect(getByText('score')).toBeTruthy();
    expect(queryByText('No fields defined yet')).toBeNull();
    expect(getByTestId('gate-script-indicator')).toBeTruthy();
  });

  it('does not show label badge color when gate has label but no color', () => {
    const gate = makeGate({ label: 'Test Gate' });
    const channel = makeChannel({ gateId: gate.id });
    const { getByTestId } = render(
      <ChannelEdgeConfigPanel {...defaultProps({ channel, gates: [gate] })} />
    );
    const badge = getByTestId('gate-label-badge');
    // When no color is set, the style.color should be empty string (undefined coerced)
    expect(badge.style.color).toBe('');
  });
});
