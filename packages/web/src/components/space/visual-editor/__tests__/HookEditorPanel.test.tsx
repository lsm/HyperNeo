// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import type { WorkflowHook } from '@hyperneo/shared';
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

  it('updates source node and matching callers on select change', () => {
    const hook = makeHook({ authorizedCallers: [{ sourceNode: 'Plan' }] });
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.change(getByTestId('hook-editor-source-node'), { target: { value: 'Code' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceNode: 'Code',
        authorizedCallers: [expect.objectContaining({ sourceNode: 'Code' })],
      })
    );
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

  it('updates MCP method and clears target for non-message methods', () => {
    const hook = makeHook({ targetNode: 'Review' });
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.change(getByTestId('hook-editor-method'), { target: { value: 'save_artifact' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'save_artifact', targetNode: undefined })
    );
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

  it('disables unsupported built-in validator controls', () => {
    const hook = makeHook();
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.click(getByTestId('hook-editor-section-validator'));
    expect(getByTestId('hook-editor-validator-kind-built-in').disabled).toBe(true);
    expect(getByTestId('hook-editor-built-in-id').disabled).toBe(true);
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

  it('keeps invalid template JSON draft editable without updating hook', () => {
    const hook = makeHook({ templateData: { ok: true } });
    const { getByTestId, getByText } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.input(getByTestId('hook-editor-template-data'), { target: { value: '{nope' } });
    expect(getByTestId('hook-editor-template-data').value).toBe('{nope');
    expect(getByText(/Expected property name/)).toBeTruthy();
    expect(onChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ templateData: expect.anything() })
    );
  });

  it('rejects non-object template JSON values', () => {
    const hook = makeHook({ templateData: { ok: true } });
    const { getByTestId, getByText } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.input(getByTestId('hook-editor-template-data'), { target: { value: '[]' } });
    expect(getByTestId('hook-editor-template-data').value).toBe('[]');
    expect(getByText(/must be a JSON object/)).toBeTruthy();
    expect(onChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ templateData: expect.anything() })
    );
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

  it('keeps at least one authorized caller', () => {
    const hook = makeHook({
      authorizedCallers: [{ sourceNode: 'Plan', agentSlots: ['coder'] }],
    });
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.click(getByTestId('hook-editor-section-callers'));
    const deleteButton = getByTestId('hook-editor-caller-delete-0') as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);
    fireEvent.click(deleteButton);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('restricts caller source and slot filters in the editor', () => {
    const hook = makeHook({
      authorizedCallers: [{ sourceNode: 'Plan', agentSlots: ['coder'] }],
    });
    const { getByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.click(getByTestId('hook-editor-section-callers'));
    expect((getByTestId('hook-editor-caller-source-0') as HTMLSelectElement).disabled).toBe(true);
    expect((getByTestId('hook-editor-caller-slots-0') as HTMLInputElement).disabled).toBe(true);
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

  it('hides retry inputs for pr_ready validators', () => {
    const hook = makeHook({ validator: { kind: 'built_in', id: 'pr_ready' } });
    const { getByTestId, queryByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.click(getByTestId('hook-editor-section-retry'));
    expect(getByTestId('hook-editor-pr-ready-retry-note').textContent).toContain('PR-ready');
    expect(queryByTestId('hook-editor-retry-max-attempts')).toBeNull();
    expect(queryByTestId('hook-editor-retry-delay')).toBeNull();
    expect(queryByTestId('hook-editor-retry-backoff')).toBeNull();
  });

  it('shows unsupported poll notice without editable poll controls', () => {
    const hook = makeHook({ poll: { intervalMs: 30_000 } });
    const { getByTestId, queryByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    fireEvent.click(getByTestId('hook-editor-section-retry'));
    expect(getByTestId('hook-editor-poll-unsupported').textContent).toContain('not supported yet');
    expect(queryByTestId('hook-editor-poll-interval')).toBeNull();
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

  it('shows unsupported human-only notice without checkbox', () => {
    const hook = makeHook({ humanOnly: true });
    const { getByText, queryByTestId } = render(
      <HookEditorPanel hook={hook} onChange={onChange} onBack={onBack} nodeNames={nodeNames} />
    );
    expect(getByText(/Human-only hooks are not supported yet/)).toBeTruthy();
    expect(queryByTestId('hook-editor-human-only')).toBeNull();
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
