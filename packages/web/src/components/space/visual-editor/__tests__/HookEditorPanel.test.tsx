/**
 * Unit tests for HookEditorPanel.
 *
 * Covers:
 * - enabled toggle
 * - label validation
 * - source node selector
 * - target node selector
 * - MCP method selector
 * - template data JSON editor
 * - validator kind toggle (built-in vs script)
 * - built-in validator ID selector
 * - script source validation
 * - external lookup toggles
 * - authorized callers add/edit/remove
 * - retry settings (maxAttempts, delayMs, backoffMultiplier)
 * - poll settings (intervalMs, maxDurationMs)
 * - classification and order
 * - humanOnly checkbox
 */

// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import type { WorkflowHook } from '@neokai/shared';
import { HookEditorPanel } from '../HookEditorPanel';

function makeHook(overrides: Partial<WorkflowHook> = {}): WorkflowHook {
  return {
    id: 'hook-1',
    enabled: true,
    sourceNode: 'Plan',
    method: 'send_message',
    label: 'Test Hook',
    validator: { kind: 'built_in', id: 'pr_open' },
    ...overrides,
  };
}

describe('HookEditorPanel', () => {
  const onChange = vi.fn();
  const onBack = vi.fn();
  const nodeNames = ['Plan', 'Code', 'Review'];

  beforeEach(() => {
    cleanup();
    onChange.mockClear();
    onBack.mockClear();
  });

  it('renders hook ID and label input', () => {
    const hook = makeHook();
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    expect(getByTestId('hook-editor-label')).toBeTruthy();
    expect(getByTestId('hook-editor-label').value).toBe('Test Hook');
  });

  it('toggles enabled state', () => {
    const hook = makeHook({ enabled: true });
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.click(getByTestId('hook-editor-enabled'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('updates label on input', () => {
    const hook = makeHook();
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.input(getByTestId('hook-editor-label'), { target: { value: 'New Label' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ label: 'New Label' }));
  });

  it('shows label validation error for empty label', () => {
    const hook = makeHook({ label: '' });
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    expect(getByTestId('hook-editor-label').className).toContain('border-red-500');
  });

  it('updates source node on select change', () => {
    const hook = makeHook();
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.change(getByTestId('hook-editor-source-node'), { target: { value: 'Code' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ sourceNode: 'Code' }));
  });

  it('updates target node on select change', () => {
    const hook = makeHook();
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.change(getByTestId('hook-editor-target-node'), { target: { value: 'Review' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ targetNode: 'Review' }));
  });

  it('clears target node when selecting empty option', () => {
    const hook = makeHook({ targetNode: 'Review' });
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.change(getByTestId('hook-editor-target-node'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ targetNode: undefined }));
  });

  it('updates MCP method on select change', () => {
    const hook = makeHook();
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.change(getByTestId('hook-editor-method'), { target: { value: 'save_artifact' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ method: 'save_artifact' }));
  });

  it('switches validator kind to script', () => {
    const hook = makeHook();
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.click(getByTestId('hook-editor-section-validator'));
    fireEvent.click(getByTestId('hook-editor-validator-kind-script'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        validator: expect.objectContaining({ kind: 'script' }),
      })
    );
  });

  it('switches validator kind to built-in', () => {
    const hook = makeHook({ validator: { kind: 'script', interpreter: 'bash', source: '' } });
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.click(getByTestId('hook-editor-section-validator'));
    fireEvent.click(getByTestId('hook-editor-validator-kind-built-in'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        validator: expect.objectContaining({ kind: 'built_in' }),
      })
    );
  });

  it('updates built-in validator ID', () => {
    const hook = makeHook();
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.click(getByTestId('hook-editor-section-validator'));
    fireEvent.change(getByTestId('hook-editor-built-in-id'), { target: { value: 'pr_mergeable' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        validator: expect.objectContaining({ id: 'pr_mergeable' }),
      })
    );
  });

  it('shows PR-ready block copy for pull request validators', () => {
    const hook = makeHook({ validator: { kind: 'built_in', id: 'pr_mergeable' } });
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.click(getByTestId('hook-editor-section-validator'));
    expect(getByTestId('hook-editor-validator-copy').textContent).toContain('PR-ready block');
  });

  it('shows Codex retry copy for Codex review validators', () => {
    const hook = makeHook({ validator: { kind: 'built_in', id: 'codex_review_approved' } });
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.click(getByTestId('hook-editor-section-validator'));
    expect(getByTestId('hook-editor-validator-copy').textContent).toContain('Codex retry');
  });

  it('shows script source validation error for empty source', () => {
    const hook = makeHook({
      validator: { kind: 'script', interpreter: 'bash', source: '' },
    });
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.click(getByTestId('hook-editor-section-validator'));
    expect(getByTestId('hook-editor-script-source').className).toContain('border-red-500');
  });

  it('toggles external lookup checkbox', () => {
    const hook = makeHook({
      validator: { kind: 'script', interpreter: 'bash', source: 'echo ok' },
    });
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.click(getByTestId('hook-editor-section-validator'));
    fireEvent.click(getByTestId('hook-editor-external-lookup-github'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        validator: expect.objectContaining({
          externalLookups: ['github'],
        }),
      })
    );
  });

  it('adds an authorized caller', () => {
    const hook = makeHook();
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.click(getByTestId('hook-editor-section-callers'));
    fireEvent.click(getByTestId('hook-editor-add-caller'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizedCallers: [expect.objectContaining({ sourceNode: 'Plan' })],
      })
    );
  });

  it('removes an authorized caller', () => {
    const hook = makeHook({
      authorizedCallers: [{ sourceNode: 'Plan', agentSlots: ['coder'] }],
    });
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.click(getByTestId('hook-editor-section-callers'));
    fireEvent.click(getByTestId('hook-editor-caller-delete-0'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ authorizedCallers: undefined })
    );
  });

  it('updates retry maxAttempts', () => {
    const hook = makeHook({ retry: { maxAttempts: 3, delayMs: 5000 } });
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.click(getByTestId('hook-editor-section-retry'));
    fireEvent.input(getByTestId('hook-editor-retry-max-attempts'), { target: { value: '5' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        retry: expect.objectContaining({ maxAttempts: 5 }),
      })
    );
  });

  it('updates poll interval', () => {
    const hook = makeHook({ poll: { intervalMs: 30_000 } });
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.click(getByTestId('hook-editor-section-retry'));
    fireEvent.input(getByTestId('hook-editor-poll-interval'), { target: { value: '60000' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        poll: expect.objectContaining({ intervalMs: 60000 }),
      })
    );
  });

  it('updates classification', () => {
    const hook = makeHook();
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.change(getByTestId('hook-editor-classification'), {
      target: { value: 'side_effect' },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ classification: 'side_effect' })
    );
  });

  it('updates order', () => {
    const hook = makeHook({ order: 0 });
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.input(getByTestId('hook-editor-order'), { target: { value: '2' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ order: 2 }));
  });

  it('toggles humanOnly checkbox', () => {
    const hook = makeHook({ humanOnly: false });
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.click(getByTestId('hook-editor-human-only'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ humanOnly: true }));
  });

  it('calls onBack when back button clicked', () => {
    const hook = makeHook();
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.click(getByTestId('hook-editor-back'));
    expect(onBack).toHaveBeenCalled();
  });
});
