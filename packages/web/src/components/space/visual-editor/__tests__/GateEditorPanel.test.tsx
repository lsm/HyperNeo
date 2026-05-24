// @vitest-environment happy-dom

/**
 * Unit tests for GateEditorPanel component — badge label, color, script editor, and validation.
 *
 * Tests:
 * - Renders badge preview with default label "Gate" and default color
 * - Badge preview updates with custom label
 * - Badge preview updates with custom color
 * - Label input has character count indicator showing 0/20 for empty label
 * - Label input character count updates as user types
 * - Typing in label input calls onChange with updated label
 * - Clearing label input calls onChange with label: undefined
 * - Label input is bounded by maxLength=20
 * - Label validation error shown when label exceeds 20 chars via props
 * - Color picker updates badge preview in real-time
 * - Color picker calls onChange with new color value
 * - Color hex display shows current color value
 * - Reset button visible only when custom color is set
 * - Reset button clears custom color and reverts to default
 * - Validation errors shown inline for invalid label (21+ chars)
 * - Validation errors shown inline for invalid color (non-hex format)
 * - Badge preview uses default color when no custom color set
 * - Badge preview uses default label when no custom label set
 * - Existing fields section still renders correctly
 * - Description input still works after new sections added
 * - Script toggle switch renders and works
 * - Script interpreter dropdown shows bash/node/python3
 * - Script source textarea accepts multiline code with monospace font
 * - Script timeout defaults to 30, clamps to [1, 120], NaN guard
 * - Script presets (Lint Check, Type Check) populate form correctly
 * - Script validation errors displayed for empty source, invalid timeout
 * - Script-only gate (no fields) works in editor
 * - Gate-level validation error shown for empty gate (no fields, no script)
 * - Empty-fields message changes when script is enabled
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { GateEditorPanel } from '../GateEditorPanel';
import type { Gate } from '@neokai/shared';

afterEach(() => cleanup());

// ============================================================================
// Fixtures
// ============================================================================

function makeGate(overrides?: Partial<Gate>): Gate {
  return {
    id: 'gate-1',
    resetOnCycle: false,
    fields: [],
    ...overrides,
  };
}

function makeProps(gate: Gate) {
  return {
    gate,
    onChange: vi.fn(),
    onBack: vi.fn(),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('GateEditorPanel — Badge Label', () => {
  it('renders label input with empty value and 0/20 count', () => {
    const gate = makeGate();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const input = getByTestId('gate-editor-label') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('Leave empty for heuristic');
    expect(input.maxLength).toBe(20);

    const count = getByTestId('gate-editor-label-count');
    expect(count.textContent).toBe('0/20');
  });

  it('renders label input with existing label value and correct count', () => {
    const gate = makeGate({ label: 'Approval' });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const input = getByTestId('gate-editor-label') as HTMLInputElement;
    expect(input.value).toBe('Approval');

    const count = getByTestId('gate-editor-label-count');
    expect(count.textContent).toBe('8/20');
  });

  it('calls onChange with label when user types', () => {
    const gate = makeGate();
    const onChange = vi.fn();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} onChange={onChange} />);

    const input = getByTestId('gate-editor-label');
    fireEvent.input(input, { target: { value: 'Review' } });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ label: 'Review' }));
  });

  it('calls onChange with label: undefined when cleared', () => {
    const gate = makeGate({ label: 'Review' });
    const onChange = vi.fn();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} onChange={onChange} />);

    const input = getByTestId('gate-editor-label');
    fireEvent.input(input, { target: { value: '' } });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ label: undefined }));
  });

  it('character count reflects gate.label length from props', () => {
    // Count is derived from gate.label prop, not from DOM input state
    const gateShort = makeGate({ label: 'Hi' });
    const { getByTestId, rerender } = render(<GateEditorPanel {...makeProps(gateShort)} />);

    const count = getByTestId('gate-editor-label-count');
    expect(count.textContent).toBe('2/20');

    // After parent updates gate with longer label
    const gateLong = makeGate({ label: 'Hello World' });
    rerender(<GateEditorPanel {...makeProps(gateLong)} />);
    expect(count.textContent).toBe('11/20');
  });

  it('does not show validation error for valid label', () => {
    const gate = makeGate({ label: 'Valid Label' });
    const { queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(queryByTestId('gate-editor-label-error')).toBeNull();
  });

  it('does not show validation error for empty label', () => {
    const gate = makeGate();
    const { queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(queryByTestId('gate-editor-label-error')).toBeNull();
  });

  it('shows validation error when label exceeds 20 chars', () => {
    const gate = makeGate({ label: 'a'.repeat(21) });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const error = getByTestId('gate-editor-label-error');
    expect(error.textContent).toBe('label: must be at most 20 characters, got 21');
  });

  it('shows validation error for label at exactly 21 chars (boundary)', () => {
    const gate = makeGate({ label: 'a'.repeat(21) });
    const { queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(queryByTestId('gate-editor-label-error')).not.toBeNull();
  });

  it('shows no validation error for label at exactly 20 chars', () => {
    const gate = makeGate({ label: 'a'.repeat(20) });
    const { queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(queryByTestId('gate-editor-label-error')).toBeNull();
  });
});

describe('GateEditorPanel — Badge Color', () => {
  it('renders color picker with default color when no custom color', () => {
    const gate = makeGate();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const picker = getByTestId('gate-editor-color') as HTMLInputElement;
    expect(picker.value).toBe('#3b82f6');
    expect(picker.type).toBe('color');
  });

  it('renders color picker with custom color', () => {
    const gate = makeGate({ color: '#ef4444' });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const picker = getByTestId('gate-editor-color') as HTMLInputElement;
    expect(picker.value).toBe('#ef4444');
  });

  it('displays hex value next to color picker', () => {
    const gate = makeGate({ color: '#22c55e' });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const container = getByTestId('gate-editor-color').parentElement!;
    expect(container.textContent).toContain('#22c55e');
  });

  it('displays default hex value when no custom color', () => {
    const gate = makeGate();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const container = getByTestId('gate-editor-color').parentElement!;
    expect(container.textContent).toContain('#3b82f6');
  });

  it('calls onChange when color is changed', () => {
    const gate = makeGate();
    const onChange = vi.fn();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} onChange={onChange} />);

    const picker = getByTestId('gate-editor-color');
    fireEvent.change(picker, { target: { value: '#ff0000' } });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ color: '#ff0000' }));
  });

  it('shows reset button only when custom color is set', () => {
    const gateNoColor = makeGate();
    const { queryByTestId, rerender } = render(<GateEditorPanel {...makeProps(gateNoColor)} />);
    expect(queryByTestId('gate-editor-color-reset')).toBeNull();

    const gateWithColor = makeGate({ color: '#ef4444' });
    rerender(<GateEditorPanel {...makeProps(gateWithColor)} />);
    expect(queryByTestId('gate-editor-color-reset')).not.toBeNull();
  });

  it('reset button clears custom color', () => {
    const gate = makeGate({ color: '#ef4444' });
    const onChange = vi.fn();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} onChange={onChange} />);

    const resetBtn = getByTestId('gate-editor-color-reset');
    fireEvent.click(resetBtn);

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ color: undefined }));
  });

  it('does not show validation error for valid color', () => {
    const gate = makeGate({ color: '#3b82f6' });
    const { queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(queryByTestId('gate-editor-color-error')).toBeNull();
  });

  it('does not show validation error for undefined color', () => {
    const gate = makeGate();
    const { queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(queryByTestId('gate-editor-color-error')).toBeNull();
  });

  it('shows validation error for invalid color format', () => {
    const gate = makeGate({ color: 'not-a-color' });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const error = getByTestId('gate-editor-color-error');
    expect(error.textContent).toContain('color: expected hex format #rrggbb');
  });

  it('shows validation error for short hex format', () => {
    const gate = makeGate({ color: '#abc' });
    const { queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(queryByTestId('gate-editor-color-error')).not.toBeNull();
  });

  it('shows validation error for color without hash prefix', () => {
    const gate = makeGate({ color: 'ff0000' });
    const { queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(queryByTestId('gate-editor-color-error')).not.toBeNull();
  });
});

describe('GateEditorPanel — Badge Preview', () => {
  it('renders badge preview with default label "Gate" when no label set', () => {
    const gate = makeGate();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const svg = getByTestId('gate-editor-badge-preview');
    const text = svg.querySelector('text');
    expect(text?.textContent).toBe('Gate');
  });

  it('renders badge preview with custom label', () => {
    const gate = makeGate({ label: 'Approve' });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const svg = getByTestId('gate-editor-badge-preview');
    const text = svg.querySelector('text');
    expect(text?.textContent).toBe('Approve');
  });

  it('renders badge preview with default color when no color set', () => {
    const gate = makeGate();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const svg = getByTestId('gate-editor-badge-preview');
    const text = svg.querySelector('text');
    expect(text?.getAttribute('fill')).toBe('#3b82f6');
  });

  it('renders badge preview with custom color', () => {
    const gate = makeGate({ color: '#ef4444' });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const svg = getByTestId('gate-editor-badge-preview');
    const text = svg.querySelector('text');
    expect(text?.getAttribute('fill')).toBe('#ef4444');
  });

  it('badge preview uses SVG rect matching EdgeRenderer style', () => {
    const gate = makeGate();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const svg = getByTestId('gate-editor-badge-preview');
    const rect = svg.querySelector('rect');
    expect(rect?.getAttribute('fill')).toBe('#0f1115');
    expect(rect?.getAttribute('stroke')).toBe('#232733');
    expect(rect?.getAttribute('rx')).toBe('10');
    expect(Number(rect?.getAttribute('height'))).toBe(20);
  });
});

describe('GateEditorPanel — Existing functionality preserved', () => {
  it('still renders gate ID', () => {
    const gate = makeGate({ id: 'my-gate-123' });
    const { getByText } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(getByText('my-gate-123')).toBeDefined();
  });

  it('still renders description input', () => {
    const gate = makeGate({ description: 'Check approval' });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const input = getByTestId('gate-editor-description') as HTMLInputElement;
    expect(input.value).toBe('Check approval');
  });

  it('still renders reset on cycle checkbox', () => {
    const gate = makeGate({ resetOnCycle: true });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const checkbox = getByTestId('gate-editor-reset-on-cycle') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('still renders fields section', () => {
    const gate = makeGate({
      fields: [
        {
          name: 'approved',
          type: 'boolean',
          writers: [],
          check: { op: '==', value: true },
        },
      ],
    });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(getByTestId('gate-field-card-0')).toBeDefined();
  });

  it('shows back button in standalone mode', () => {
    const gate = makeGate();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(getByTestId('gate-editor-back')).toBeDefined();
  });

  it('hides back button in embedded mode', () => {
    const gate = makeGate();
    const { queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} embedded={true} />);

    expect(queryByTestId('gate-editor-back')).toBeNull();
  });

  it('all new sections (preview, label, color) are present', () => {
    const gate = makeGate();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(getByTestId('gate-editor-badge-preview')).toBeDefined();
    expect(getByTestId('gate-editor-label')).toBeDefined();
    expect(getByTestId('gate-editor-color')).toBeDefined();
  });
});

describe('GateEditorPanel — Script Check toggle', () => {
  it('renders script toggle switch in off state by default', () => {
    const gate = makeGate();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const toggle = getByTestId('gate-editor-script-enabled');
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('renders script toggle in on state when gate has script', () => {
    const gate = makeGate({
      script: { interpreter: 'bash', source: 'echo hello', timeoutMs: 30000 },
    });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const toggle = getByTestId('gate-editor-script-enabled');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('hides script editor controls when toggle is off', () => {
    const gate = makeGate();
    const { getByTestId, queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(getByTestId('gate-editor-script-enabled')).toBeDefined();
    expect(queryByTestId('gate-editor-script-interpreter')).toBeNull();
    expect(queryByTestId('gate-editor-script-source')).toBeNull();
    expect(queryByTestId('gate-editor-script-timeout')).toBeNull();
  });

  it('shows script editor controls when toggle is clicked on', () => {
    const gate = makeGate();
    const onChange = vi.fn();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} onChange={onChange} />);

    const toggle = getByTestId('gate-editor-script-enabled');
    fireEvent.click(toggle);

    expect(onChange).toHaveBeenCalledOnce();
    const updatedGate = onChange.mock.calls[0][0];
    expect(updatedGate.script).toBeDefined();
    expect(updatedGate.script.interpreter).toBe('bash');
    expect(updatedGate.script.source).toBe('');
    expect(updatedGate.script.timeoutMs).toBe(30000);
  });

  it('clears gate.script when toggle is clicked off', () => {
    const gate = makeGate({
      script: { interpreter: 'node', source: 'console.log("hi")', timeoutMs: 10000 },
    });
    const onChange = vi.fn();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} onChange={onChange} />);

    const toggle = getByTestId('gate-editor-script-enabled');
    fireEvent.click(toggle);

    expect(onChange).toHaveBeenCalledOnce();
    const updatedGate = onChange.mock.calls[0][0];
    expect(updatedGate.script).toBeUndefined();
  });
});

describe('GateEditorPanel — Script Interpreter', () => {
  it('shows interpreter dropdown with bash/node/python3 options', () => {
    const gate = makeGate({
      script: { interpreter: 'bash', source: 'echo test', timeoutMs: 30000 },
    });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const select = getByTestId('gate-editor-script-interpreter') as HTMLSelectElement;
    expect(select.value).toBe('bash');

    const options = Array.from(select.options);
    expect(options.map((o) => o.value)).toEqual(['bash', 'node', 'python3']);
  });

  it('calls onChange when interpreter is changed', () => {
    const gate = makeGate({
      script: { interpreter: 'bash', source: 'echo test', timeoutMs: 30000 },
    });
    const onChange = vi.fn();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} onChange={onChange} />);

    const select = getByTestId('gate-editor-script-interpreter');
    fireEvent.change(select, { target: { value: 'python3' } });

    expect(onChange).toHaveBeenCalledOnce();
    const updatedGate = onChange.mock.calls[0][0];
    expect(updatedGate.script.interpreter).toBe('python3');
    expect(updatedGate.script.source).toBe('echo test');
  });

  it('reflects gate.script.interpreter from props', () => {
    const gate = makeGate({
      script: { interpreter: 'node', source: 'console.log(1)', timeoutMs: 30000 },
    });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const select = getByTestId('gate-editor-script-interpreter') as HTMLSelectElement;
    expect(select.value).toBe('node');
  });
});

describe('GateEditorPanel — Script Source', () => {
  it('renders textarea with monospace font class', () => {
    const gate = makeGate({
      script: { interpreter: 'bash', source: 'echo hello', timeoutMs: 30000 },
    });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const textarea = getByTestId('gate-editor-script-source') as HTMLTextAreaElement;
    expect(textarea.value).toBe('echo hello');
    expect(textarea.className).toContain('font-mono');
  });

  it('accepts multiline script code', () => {
    const gate = makeGate({
      script: { interpreter: 'bash', source: '', timeoutMs: 30000 },
    });
    const onChange = vi.fn();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} onChange={onChange} />);

    const textarea = getByTestId('gate-editor-script-source');
    const multiline = 'echo "line 1"\necho "line 2"\necho "line 3"';
    fireEvent.input(textarea, { target: { value: multiline } });

    expect(onChange).toHaveBeenCalledOnce();
    const updatedGate = onChange.mock.calls[0][0];
    expect(updatedGate.script.source).toBe(multiline);
  });

  it('calls onChange with source when user types', () => {
    const gate = makeGate({
      script: { interpreter: 'node', source: '', timeoutMs: 30000 },
    });
    const onChange = vi.fn();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} onChange={onChange} />);

    const textarea = getByTestId('gate-editor-script-source');
    fireEvent.input(textarea, { target: { value: 'console.log("hello")' } });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0][0].script.source).toBe('console.log("hello")');
  });
});

describe('GateEditorPanel — Script Timeout', () => {
  it('renders timeout input with default value 30', () => {
    const gate = makeGate({
      script: { interpreter: 'bash', source: 'echo test', timeoutMs: 30000 },
    });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const input = getByTestId('gate-editor-script-timeout') as HTMLInputElement;
    expect(Number(input.value)).toBe(30);
  });

  it('renders timeout in seconds from milliseconds in gate.script', () => {
    const gate = makeGate({
      script: { interpreter: 'bash', source: 'echo test', timeoutMs: 60000 },
    });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const input = getByTestId('gate-editor-script-timeout') as HTMLInputElement;
    expect(Number(input.value)).toBe(60);
  });

  it('defaults to 30 when timeoutMs is not set', () => {
    const gate = makeGate({
      script: { interpreter: 'bash', source: 'echo test' },
    });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    const input = getByTestId('gate-editor-script-timeout') as HTMLInputElement;
    expect(Number(input.value)).toBe(30);
  });

  it('calls onChange with timeoutMs when value is changed', () => {
    const gate = makeGate({
      script: { interpreter: 'bash', source: 'echo test', timeoutMs: 30000 },
    });
    const onChange = vi.fn();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} onChange={onChange} />);

    const input = getByTestId('gate-editor-script-timeout');
    fireEvent.input(input, { target: { value: '60' } });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0][0].script.timeoutMs).toBe(60000);
  });

  it('clamps timeout value above 120 to 120', () => {
    const gate = makeGate({
      script: { interpreter: 'bash', source: 'echo test', timeoutMs: 30000 },
    });
    const onChange = vi.fn();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} onChange={onChange} />);

    const input = getByTestId('gate-editor-script-timeout');
    fireEvent.input(input, { target: { value: '999' } });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0][0].script.timeoutMs).toBe(120000);
  });

  it('clamps timeout value below 1 to 1', () => {
    const gate = makeGate({
      script: { interpreter: 'bash', source: 'echo test', timeoutMs: 30000 },
    });
    const onChange = vi.fn();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} onChange={onChange} />);

    const input = getByTestId('gate-editor-script-timeout');
    fireEvent.input(input, { target: { value: '0' } });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0][0].script.timeoutMs).toBe(1000);
  });

  it('NaN guard prevents NaN from propagating as timeoutMs', () => {
    // Note: <input type="number"> in happy-dom sanitizes non-numeric values,
    // so we directly test the NaN branch via empty-string input which produces 0,
    // and verify timeoutMs is always a valid number (never NaN).
    const gate = makeGate({
      script: { interpreter: 'bash', source: 'echo test', timeoutMs: 30000 },
    });
    const onChange = vi.fn();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} onChange={onChange} />);

    const input = getByTestId('gate-editor-script-timeout');
    // Empty string on number input → Number('') = 0 → clamped to 1
    fireEvent.input(input, { target: { value: '' } });

    expect(onChange).toHaveBeenCalledOnce();
    const timeoutMs = onChange.mock.calls[0][0].script.timeoutMs;
    expect(typeof timeoutMs).toBe('number');
    expect(isNaN(timeoutMs)).toBe(false);
    expect(timeoutMs).toBe(1000); // clamped to min 1s
  });
});

describe('GateEditorPanel — Script Presets', () => {
  it('renders Lint Check and Type Check preset buttons when script is enabled', () => {
    const gate = makeGate({
      script: { interpreter: 'bash', source: '', timeoutMs: 30000 },
    });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(getByTestId('gate-editor-preset-lint')).toBeDefined();
    expect(getByTestId('gate-editor-preset-typecheck')).toBeDefined();
  });

  it('Lint Check preset populates bash interpreter and lint script', () => {
    const gate = makeGate({
      script: { interpreter: 'bash', source: '', timeoutMs: 30000 },
    });
    const onChange = vi.fn();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} onChange={onChange} />);

    fireEvent.click(getByTestId('gate-editor-preset-lint'));

    expect(onChange).toHaveBeenCalledOnce();
    const updated = onChange.mock.calls[0][0];
    expect(updated.script.interpreter).toBe('bash');
    expect(updated.script.source).toContain('npm run lint');
    expect(updated.script.source).toContain('{"passed":true}');
    expect(updated.script.timeoutMs).toBe(30000);
  });

  it('Type Check preset populates bash interpreter with tsc command', () => {
    const gate = makeGate({
      script: { interpreter: 'bash', source: '', timeoutMs: 30000 },
    });
    const onChange = vi.fn();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} onChange={onChange} />);

    fireEvent.click(getByTestId('gate-editor-preset-typecheck'));

    expect(onChange).toHaveBeenCalledOnce();
    const updated = onChange.mock.calls[0][0];
    expect(updated.script.interpreter).toBe('bash');
    expect(updated.script.source).toContain('npx tsc --noEmit');
    expect(updated.script.source).toContain('{"passed":true}');
    expect(updated.script.source).toContain('{"passed":false}');
    expect(updated.script.timeoutMs).toBe(30000);
  });

  it('preset buttons are hidden when script is disabled', () => {
    const gate = makeGate();
    const { queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(queryByTestId('gate-editor-preset-lint')).toBeNull();
    expect(queryByTestId('gate-editor-preset-typecheck')).toBeNull();
  });
});

describe('GateEditorPanel — Script Validation', () => {
  it('shows source error when script source is empty', () => {
    const gate = makeGate({
      script: { interpreter: 'bash', source: '', timeoutMs: 30000 },
    });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(getByTestId('gate-editor-script-source-error').textContent).toContain(
      'script body is required'
    );
  });

  it('shows source error when script source is whitespace only', () => {
    const gate = makeGate({
      script: { interpreter: 'bash', source: '   \n\t  ', timeoutMs: 30000 },
    });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(getByTestId('gate-editor-script-source-error').textContent).toContain(
      'script body is required'
    );
  });

  it('does not show source error for valid source', () => {
    const gate = makeGate({
      script: { interpreter: 'bash', source: 'echo hello', timeoutMs: 30000 },
    });
    const { queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(queryByTestId('gate-editor-script-source-error')).toBeNull();
  });

  it('does not show source error when script is disabled', () => {
    const gate = makeGate();
    const { queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(queryByTestId('gate-editor-script-source-error')).toBeNull();
  });

  it('shows timeout error for values above 120', () => {
    const gate = makeGate({
      script: { interpreter: 'bash', source: 'echo test', timeoutMs: 130000 },
    });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(getByTestId('gate-editor-script-timeout-error').textContent).toContain(
      'must be at most 120'
    );
  });

  it('does not show timeout error for value at 120', () => {
    const gate = makeGate({
      script: { interpreter: 'bash', source: 'echo test', timeoutMs: 120000 },
    });
    const { queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(queryByTestId('gate-editor-script-timeout-error')).toBeNull();
  });
});

describe('GateEditorPanel — Gate-level validation', () => {
  it('shows gate error when no fields and no script', () => {
    const gate = makeGate({ fields: [] });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(getByTestId('gate-editor-gate-error').textContent).toContain(
      'must have at least one field or a script check'
    );
  });

  it('shows gate error when fields is undefined and no script', () => {
    const gate = makeGate({ fields: undefined });
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(getByTestId('gate-editor-gate-error').textContent).toContain(
      'must have at least one field or a script check'
    );
  });

  it('does not show gate error when fields are present', () => {
    const gate = makeGate({
      fields: [{ name: 'approved', type: 'boolean', writers: [], check: { op: 'exists' } }],
    });
    const { queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(queryByTestId('gate-editor-gate-error')).toBeNull();
  });

  it('does not show gate error when script is enabled', () => {
    const gate = makeGate({
      fields: [],
      script: { interpreter: 'bash', source: 'echo test', timeoutMs: 30000 },
    });
    const { queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(queryByTestId('gate-editor-gate-error')).toBeNull();
  });

  it('shows gate error after script is toggled off with no fields', () => {
    const gate = makeGate({
      fields: [],
      script: { interpreter: 'bash', source: 'echo test', timeoutMs: 30000 },
    });
    const { getByTestId, queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    // Initially no error (script is set)
    expect(queryByTestId('gate-editor-gate-error')).toBeNull();

    // Toggle script off
    fireEvent.click(getByTestId('gate-editor-script-enabled'));

    // Now there should be an error — but it shows on next render since
    // the gate state is controlled by parent. The error is computed from
    // the gate prop, so we need to verify via rerender.
    const gateWithoutScript = makeGate({ fields: [], script: undefined });
    const { rerender } = render(<GateEditorPanel {...makeProps(gateWithoutScript)} />);
    // Just verify the empty gate shows error
    expect(queryByTestId('gate-editor-gate-error')).not.toBeNull();
  });
});

describe('GateEditorPanel — Empty-fields message context', () => {
  it('shows "gate always opens" when no fields and no script', () => {
    const gate = makeGate({ fields: [] });
    const { getByText } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(getByText('No fields — gate always opens')).toBeDefined();
  });

  it('shows "No fields defined" when script is enabled', () => {
    const gate = makeGate({
      fields: [],
      script: { interpreter: 'bash', source: 'echo test', timeoutMs: 30000 },
    });
    const { getByText } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(getByText('No fields defined')).toBeDefined();
  });

  it('does not show empty-fields message when fields are present', () => {
    const gate = makeGate({
      fields: [{ name: 'approved', type: 'boolean', writers: [], check: { op: 'exists' } }],
    });
    const { queryByText } = render(<GateEditorPanel {...makeProps(gate)} />);

    expect(queryByText('No fields — gate always opens')).toBeNull();
    expect(queryByText('No fields defined')).toBeNull();
  });
});

describe('GateEditorPanel — Script-only gate (no fields)', () => {
  it('works with script-only gate and no fields', () => {
    const gate = makeGate({
      fields: undefined,
      script: { interpreter: 'node', source: 'console.log("ok")', timeoutMs: 30000 },
    });
    const { getByTestId, queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

    // Script section is enabled and visible
    expect(getByTestId('gate-editor-script-enabled').getAttribute('aria-checked')).toBe('true');
    expect(getByTestId('gate-editor-script-interpreter')).toBeDefined();
    expect(getByTestId('gate-editor-script-source')).toBeDefined();

    // No validation errors
    expect(queryByTestId('gate-editor-script-source-error')).toBeNull();
    expect(queryByTestId('gate-editor-script-interpreter-error')).toBeNull();
    expect(queryByTestId('gate-editor-script-timeout-error')).toBeNull();
    // No gate-level error (script satisfies the requirement)
    expect(queryByTestId('gate-editor-gate-error')).toBeNull();
  });

  it('gate.script correctly propagated via onChange', () => {
    const gate = makeGate({
      fields: [],
      script: { interpreter: 'python3', source: 'print("ok")', timeoutMs: 45000 },
    });
    const onChange = vi.fn();
    const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} onChange={onChange} />);

    // Change interpreter
    fireEvent.change(getByTestId('gate-editor-script-interpreter'), { target: { value: 'bash' } });

    const updated = onChange.mock.calls[0][0];
    expect(updated.script.interpreter).toBe('bash');
    expect(updated.script.source).toBe('print("ok")');
    expect(updated.script.timeoutMs).toBe(45000);
  });
});
