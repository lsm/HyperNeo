import { useMemo, useState } from 'preact/hooks';
import { hasCodexReviewBotFeature } from '@neokai/shared';
import type {
  Gate,
  GateField,
  GateFieldType,
  GateFieldCheck,
  GateScript,
  GatePoll,
} from '@neokai/shared';

export interface GateEditorPanelProps {
  gate: Gate;
  onChange: (gate: Gate) => void;
  onBack: () => void;
  /** When true, renders just the content without the outer panel chrome (header is handled by parent). */
  embedded?: boolean;
}

const FIELD_TYPES: GateFieldType[] = ['boolean', 'string', 'number', 'map'];
const SCALAR_OPS = ['==', '!=', 'exists'] as const;
const LABEL_MAX_LENGTH = 20;
// TODO: Import all badge constants from EdgeRenderer once exported there:
//   DEFAULT_BADGE_COLOR, BADGE_BG, BADGE_BORDER, BADGE_HEIGHT, BADGE_RX,
//   BADGE_CHAR_WIDTH, BADGE_PADDING
const DEFAULT_BADGE_COLOR = '#3b82f6';
const BADGE_BG = '#0f1115';
const BADGE_BORDER = '#232733';
const BADGE_HEIGHT = 20;
const BADGE_RX = 10;
const BADGE_CHAR_WIDTH = 7;
const BADGE_PADDING = 8;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const SCRIPT_INTERPRETERS: GateScript['interpreter'][] = ['bash', 'node', 'python3'];
const SCRIPT_TIMEOUT_DEFAULT = 30;
const SCRIPT_TIMEOUT_MAX = 120;

const SCRIPT_PRESETS = {
  lint: {
    label: 'Lint Check',
    interpreter: 'bash' as const,
    source: 'npm run lint 2>/dev/null && echo \'{"passed":true}\' || echo \'{"passed":false}\'',
  },
  typecheck: {
    label: 'Type Check',
    interpreter: 'bash' as const,
    source: 'npx tsc --noEmit 2>/dev/null && echo \'{"passed":true}\' || echo \'{"passed":false}\'',
  },
} as const;

const POLL_MIN_INTERVAL_MS = 10_000;
const POLL_INTERVAL_PRESETS = [
  { label: '30s', valueMs: 30_000 },
  { label: '1m', valueMs: 60_000 },
  { label: '5m', valueMs: 300_000 },
];

// ---------------------------------------------------------------------------
// Lightweight client-side validation (mirrors daemon gate-evaluator.ts)
// ---------------------------------------------------------------------------

function validateLabel(value: string | undefined): string {
  if (!value) return '';
  if (value.length > LABEL_MAX_LENGTH)
    return `label: must be at most 20 characters, got ${value.length}`;
  return '';
}

function validateColor(value: string | undefined): string {
  if (!value) return '';
  if (!HEX_COLOR_RE.test(value)) return `color: expected hex format #rrggbb, got "${value}"`;
  return '';
}

function validateScriptInterpreter(value: string | undefined): string {
  if (!value) return 'interpreter is required';
  if (!SCRIPT_INTERPRETERS.includes(value as GateScript['interpreter'])) {
    return `interpreter: expected one of [bash, node, python3], got "${value}"`;
  }
  return '';
}

// NOTE: Frontend trims whitespace before checking for empty source, which is
// stricter than the backend `validateGateScript` (which only checks
// source.length === 0). This intentional divergence rejects whitespace-only
// scripts in the UI before they reach the daemon.
function validateScriptSource(value: string | undefined): string {
  if (!value || value.trim().length === 0) return 'source: script body is required';
  return '';
}

function validateScriptTimeout(value: number): string {
  if (isNaN(value)) return 'timeout: must be a number';
  if (value < 1) return 'timeout: must be at least 1 second';
  if (value > SCRIPT_TIMEOUT_MAX) return `timeout: must be at most ${SCRIPT_TIMEOUT_MAX} seconds`;
  return '';
}

function validateGateCompleteness(
  hasFields: boolean,
  hasScript: boolean,
  hasFeatures: boolean
): string {
  if (!hasFields && !hasScript && !hasFeatures) {
    return 'gate: must have at least one field, feature, or script check';
  }
  return '';
}

function defaultCheckForType(type: GateFieldType): GateFieldCheck {
  if (type === 'map') {
    return { op: 'count', match: 'approved', min: 1 };
  }
  return { op: 'exists' };
}

function modeButtonClass(active: boolean): string {
  return active
    ? 'border-blue-500 bg-blue-500/10 text-blue-200'
    : 'border-dark-600 bg-dark-800 text-gray-400 hover:border-dark-500 hover:text-gray-200';
}

export function GateEditorPanel({
  gate,
  onChange,
  onBack,
  embedded = false,
}: GateEditorPanelProps) {
  const [expandedField, setExpandedField] = useState<number | null>(null);

  // Validation errors computed from current gate state
  const labelError = useMemo(() => validateLabel(gate.label), [gate.label]);
  const colorError = useMemo(() => validateColor(gate.color), [gate.color]);

  // Script state: track enabled, interpreter, source, and timeout (in seconds)
  const scriptEnabled = !!gate.script;
  const scriptInterpreter = gate.script?.interpreter ?? 'bash';
  const scriptSource = gate.script?.source ?? '';
  const scriptTimeoutSec = gate.script?.timeoutMs
    ? Math.round(gate.script.timeoutMs / 1000)
    : SCRIPT_TIMEOUT_DEFAULT;
  const codexReviewBotEnabled = hasCodexReviewBotFeature(gate);

  // Gate-level validation: must have at least one of fields, features, or script
  const hasFields = (gate.fields ?? []).length > 0;
  const hasFeatures = codexReviewBotEnabled;
  const gateError = useMemo(
    () => validateGateCompleteness(hasFields, scriptEnabled, hasFeatures),
    [hasFields, scriptEnabled, hasFeatures]
  );

  // Script validation errors (only shown when script is enabled)
  const scriptInterpreterError = useMemo(
    () => (scriptEnabled ? validateScriptInterpreter(scriptInterpreter) : ''),
    [scriptEnabled, scriptInterpreter]
  );
  const scriptSourceError = useMemo(
    () => (scriptEnabled ? validateScriptSource(scriptSource) : ''),
    [scriptEnabled, scriptSource]
  );
  const scriptTimeoutError = useMemo(
    () => (scriptEnabled ? validateScriptTimeout(scriptTimeoutSec) : ''),
    [scriptEnabled, scriptTimeoutSec]
  );

  // Derived badge preview values
  const badgeLabel = gate.label ?? 'Gate';
  const badgeColor = gate.color ?? DEFAULT_BADGE_COLOR;

  function updateGate(partial: Partial<Gate>) {
    onChange({ ...gate, ...partial });
  }

  function updateField(index: number, updated: GateField) {
    const next = [...(gate.fields ?? [])];
    next[index] = updated;
    updateGate({ fields: next });
  }

  function addField() {
    const newField: GateField = {
      name: '',
      type: 'boolean',
      writers: ['*'],
      check: { op: 'exists' },
    };
    updateGate({ fields: [...(gate.fields ?? []), newField] });
    setExpandedField((gate.fields ?? []).length);
  }

  function deleteField(index: number) {
    const next = (gate.fields ?? []).filter((_, i) => i !== index);
    updateGate({ fields: next });
    if (expandedField === index) setExpandedField(null);
    else if (expandedField !== null && expandedField > index) setExpandedField(expandedField - 1);
  }

  function addApprovalPreset() {
    const preset: GateField = {
      name: 'approved',
      type: 'boolean',
      writers: [],
      check: { op: '==', value: true },
    };
    updateGate({ fields: [...(gate.fields ?? []), preset] });
  }

  function addTaskResultPreset() {
    const preset: GateField = {
      name: 'result',
      type: 'string',
      writers: ['*'],
      check: { op: '==', value: 'passed' },
    };
    updateGate({ fields: [...(gate.fields ?? []), preset] });
  }

  function toggleScriptEnabled(checked: boolean) {
    if (checked) {
      updateGate({
        script: { interpreter: 'bash', source: '', timeoutMs: SCRIPT_TIMEOUT_DEFAULT * 1000 },
      });
    } else {
      updateGate({ script: undefined });
    }
  }

  function updateScriptPartial(partial: Partial<GateScript>) {
    const current = gate.script ?? {
      interpreter: 'bash',
      source: '',
      timeoutMs: SCRIPT_TIMEOUT_DEFAULT * 1000,
    };
    updateGate({ script: { ...current, ...partial } });
  }

  function toggleCodexReviewBot(checked: boolean) {
    updateGate({
      features: {
        ...gate.features,
        codex_review_bot: checked ? true : undefined,
      },
    });
  }

  // NOTE: Presets reset timeout to the default (30s). If the user has
  // customized the timeout, clicking a preset will overwrite it.
  function applyScriptPreset(key: keyof typeof SCRIPT_PRESETS) {
    const preset = SCRIPT_PRESETS[key];
    updateGate({
      script: {
        interpreter: preset.interpreter,
        source: preset.source,
        timeoutMs: SCRIPT_TIMEOUT_DEFAULT * 1000,
      },
    });
  }

  return (
    <div
      data-testid="gate-editor-panel"
      class={
        embedded
          ? 'flex-1 overflow-y-auto px-4 py-4 space-y-3 text-sm text-white'
          : 'flex flex-col gap-3 p-4 bg-dark-850 border border-dark-700 rounded-lg text-sm text-white max-h-full overflow-y-auto'
      }
    >
      {/* Header — only shown in standalone mode; embedded mode uses parent's header */}
      {!embedded && (
        <div class="flex items-center gap-2">
          <button
            type="button"
            data-testid="gate-editor-back"
            onClick={onBack}
            class="text-gray-400 hover:text-white transition-colors text-xs"
            aria-label="Back"
          >
            &larr;
          </button>
          <span class="font-semibold text-white text-sm">Gate Editor</span>
        </div>
      )}

      {/* Gate ID */}
      <div class="space-y-1">
        <label class="text-[11px] uppercase tracking-[0.12em] text-gray-400">Gate ID</label>
        <div class="text-xs font-mono bg-dark-800 rounded px-2 py-1.5 text-gray-400 border border-dark-700 truncate">
          {gate.id}
        </div>
      </div>

      {/* Description */}
      <div class="space-y-1">
        <label class="text-[11px] uppercase tracking-[0.12em] text-gray-400">Description</label>
        <input
          type="text"
          data-testid="gate-editor-description"
          value={gate.description ?? ''}
          placeholder="What does this gate check?"
          onInput={(e) =>
            updateGate({ description: (e.currentTarget as HTMLInputElement).value || undefined })
          }
          class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-700"
        />
      </div>

      {/* Badge Preview */}
      <div class="space-y-1">
        <label class="text-[11px] uppercase tracking-[0.12em] text-gray-400">Badge Preview</label>
        <div class="flex items-center justify-center py-2">
          <svg
            data-testid="gate-editor-badge-preview"
            width={badgeLabel.length * BADGE_CHAR_WIDTH + BADGE_PADDING * 2}
            height={BADGE_HEIGHT}
          >
            <rect
              x={0}
              y={0}
              width={badgeLabel.length * BADGE_CHAR_WIDTH + BADGE_PADDING * 2}
              height={BADGE_HEIGHT}
              rx={BADGE_RX}
              fill={BADGE_BG}
              stroke={BADGE_BORDER}
              strokeWidth="1"
            />
            <text
              x={BADGE_PADDING}
              y={BADGE_HEIGHT / 2}
              dominantBaseline="central"
              fontSize="11"
              fontWeight="600"
              letterSpacing="0.06em"
              fill={badgeColor}
            >
              {badgeLabel}
            </text>
          </svg>
        </div>
      </div>

      {/* Badge Label */}
      <div class="space-y-1">
        <div class="flex items-center justify-between">
          <label class="text-[11px] uppercase tracking-[0.12em] text-gray-400">Badge Label</label>
          <span
            data-testid="gate-editor-label-count"
            class="text-[10px] text-gray-400 tabular-nums"
          >
            {(gate.label ?? '').length}/{LABEL_MAX_LENGTH}
          </span>
        </div>
        <input
          type="text"
          data-testid="gate-editor-label"
          value={gate.label ?? ''}
          placeholder="Leave empty for heuristic"
          maxLength={LABEL_MAX_LENGTH}
          onInput={(e) => {
            const value = (e.currentTarget as HTMLInputElement).value;
            updateGate({ label: value || undefined });
          }}
          class={`w-full text-xs bg-dark-800 border rounded px-2 py-1.5 text-gray-200 focus:outline-none placeholder-gray-700 ${
            labelError
              ? 'border-red-500 focus:border-red-500'
              : 'border-dark-600 focus:border-blue-500'
          }`}
        />
        {labelError && (
          <p data-testid="gate-editor-label-error" class="text-[10px] text-red-400">
            {labelError}
          </p>
        )}
      </div>

      {/* Badge Color */}
      <div class="space-y-1">
        <div class="flex items-center justify-between">
          <label class="text-[11px] uppercase tracking-[0.12em] text-gray-400">Badge Color</label>
          {gate.color && (
            <button
              type="button"
              data-testid="gate-editor-color-reset"
              onClick={() => updateGate({ color: undefined })}
              class="text-[10px] text-gray-400 hover:text-gray-300 underline transition-colors"
            >
              Reset
            </button>
          )}
        </div>
        <div class="flex items-center gap-2">
          <input
            type="color"
            data-testid="gate-editor-color"
            value={gate.color ?? DEFAULT_BADGE_COLOR}
            onChange={(e) => updateGate({ color: (e.currentTarget as HTMLInputElement).value })}
            class="w-8 h-8 rounded border border-dark-600 bg-dark-800 cursor-pointer p-0"
          />
          <span class="text-xs font-mono text-gray-400">{gate.color ?? DEFAULT_BADGE_COLOR}</span>
        </div>
        {colorError && (
          <p data-testid="gate-editor-color-error" class="text-[10px] text-red-400">
            {colorError}
          </p>
        )}
      </div>

      {/* Reset on cycle */}
      <label class="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          data-testid="gate-editor-reset-on-cycle"
          checked={gate.resetOnCycle}
          onChange={(e) =>
            updateGate({ resetOnCycle: (e.currentTarget as HTMLInputElement).checked })
          }
          class="rounded border-dark-600 text-blue-500 focus:ring-blue-500"
        />
        <span class="text-xs text-gray-400">Reset on cycle</span>
      </label>

      {/* Gate-level validation error */}
      {gateError && (
        <p data-testid="gate-editor-gate-error" class="text-[10px] text-red-400">
          {gateError}
        </p>
      )}

      {/* Gate Features */}
      <div class="space-y-2">
        <label class="text-[11px] uppercase tracking-[0.12em] text-gray-400">Features</label>
        <label class="flex items-start gap-2 cursor-pointer rounded border border-dark-700 bg-dark-800 px-2 py-2">
          <input
            type="checkbox"
            data-testid="gate-editor-feature-codex-review-bot"
            checked={codexReviewBotEnabled}
            onChange={(e) => toggleCodexReviewBot((e.currentTarget as HTMLInputElement).checked)}
            class="mt-0.5 rounded border-dark-600 text-blue-500 focus:ring-blue-500"
          />
          <span class="space-y-0.5">
            <span class="block text-xs text-gray-200">Codex Review Bot</span>
            <span class="block text-[11px] text-gray-500 leading-snug">
              Require codex[bot] +1 before this gate opens. If Codex has not reacted, reviewers
              should wait or comment @codex review on the PR.
            </span>
          </span>
        </label>
      </div>

      {/* Fields */}
      <div class="space-y-2">
        <label class="text-[11px] uppercase tracking-[0.12em] text-gray-400">Fields</label>
        {(gate.fields ?? []).length === 0 && (
          <p class="text-xs text-gray-400 italic">
            {scriptEnabled ? 'No fields defined' : 'No fields — gate always opens'}
          </p>
        )}
        {(gate.fields ?? []).map((field, i) => (
          <FieldCard
            key={i}
            field={field}
            index={i}
            expanded={expandedField === i}
            onToggle={() => setExpandedField(expandedField === i ? null : i)}
            onChange={(updated) => updateField(i, updated)}
            onDelete={() => deleteField(i)}
          />
        ))}
      </div>

      {/* Add field */}
      <button
        type="button"
        data-testid="gate-editor-add-field"
        onClick={addField}
        class="w-full rounded border border-dashed border-dark-500 px-2 py-1.5 text-xs text-gray-400 hover:border-blue-500 hover:text-blue-300 transition-colors"
      >
        + Add Field
      </button>

      {/* Presets */}
      <div class="space-y-1">
        <label class="text-[11px] uppercase tracking-[0.12em] text-gray-400">Presets</label>
        <div class="flex gap-2">
          <button
            type="button"
            data-testid="gate-editor-preset-approval"
            onClick={addApprovalPreset}
            class={`flex-1 rounded border px-2 py-1.5 text-xs transition-colors ${modeButtonClass(false)}`}
          >
            Approval
          </button>
          <button
            type="button"
            data-testid="gate-editor-preset-result"
            onClick={addTaskResultPreset}
            class={`flex-1 rounded border px-2 py-1.5 text-xs transition-colors ${modeButtonClass(false)}`}
          >
            Task Result
          </button>
        </div>
      </div>

      {/* Script Check */}
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <label class="text-[11px] uppercase tracking-[0.12em] text-gray-400">Script Check</label>
          <button
            type="button"
            data-testid="gate-editor-script-enabled"
            role="switch"
            aria-checked={scriptEnabled}
            onClick={() => toggleScriptEnabled(!scriptEnabled)}
            class={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              scriptEnabled ? 'bg-blue-500' : 'bg-dark-600'
            }`}
          >
            <span
              class={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                scriptEnabled ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        {scriptEnabled && (
          <div class="space-y-2 pl-1 border-l-2 border-blue-500/30">
            {/* Interpreter */}
            <div class="space-y-0.5">
              <label class="text-[10px] uppercase tracking-wider text-gray-400">Interpreter</label>
              <select
                data-testid="gate-editor-script-interpreter"
                value={scriptInterpreter}
                onChange={(e) =>
                  updateScriptPartial({
                    interpreter: e.currentTarget.value as GateScript['interpreter'],
                  })
                }
                class={`w-full text-xs bg-dark-800 border rounded px-2 py-1 text-gray-200 focus:outline-none ${
                  scriptInterpreterError
                    ? 'border-red-500 focus:border-red-500'
                    : 'border-dark-600 focus:border-blue-500'
                }`}
              >
                {SCRIPT_INTERPRETERS.map((interp) => (
                  <option key={interp} value={interp}>
                    {interp}
                  </option>
                ))}
              </select>
              {scriptInterpreterError && (
                <p
                  data-testid="gate-editor-script-interpreter-error"
                  class="text-[10px] text-red-400"
                >
                  {scriptInterpreterError}
                </p>
              )}
            </div>

            {/* Source */}
            <div class="space-y-0.5">
              <label class="text-[10px] uppercase tracking-wider text-gray-400">
                Script Source
              </label>
              <textarea
                data-testid="gate-editor-script-source"
                value={scriptSource}
                placeholder="# Enter your script here..."
                rows={6}
                onInput={(e) => updateScriptPartial({ source: e.currentTarget.value })}
                class={`w-full text-xs bg-dark-800 border rounded px-2 py-1.5 text-gray-200 font-mono focus:outline-none placeholder-gray-700 resize-y leading-relaxed ${
                  scriptSourceError
                    ? 'border-red-500 focus:border-red-500'
                    : 'border-dark-600 focus:border-blue-500'
                }`}
              />
              {scriptSourceError && (
                <p data-testid="gate-editor-script-source-error" class="text-[10px] text-red-400">
                  {scriptSourceError}
                </p>
              )}
            </div>

            {/* Timeout */}
            <div class="space-y-0.5">
              <label class="text-[10px] uppercase tracking-wider text-gray-400">
                Timeout (seconds)
              </label>
              <input
                type="number"
                data-testid="gate-editor-script-timeout"
                value={scriptTimeoutSec}
                min={1}
                max={SCRIPT_TIMEOUT_MAX}
                onInput={(e) => {
                  const val = Number((e.currentTarget as HTMLInputElement).value);
                  if (isNaN(val)) return;
                  const clamped = Math.max(1, Math.min(SCRIPT_TIMEOUT_MAX, val));
                  updateScriptPartial({ timeoutMs: clamped * 1000 });
                }}
                class={`w-full text-xs bg-dark-800 border rounded px-2 py-1 text-gray-200 font-mono focus:outline-none ${
                  scriptTimeoutError
                    ? 'border-red-500 focus:border-red-500'
                    : 'border-dark-600 focus:border-blue-500'
                }`}
              />
              {scriptTimeoutError && (
                <p data-testid="gate-editor-script-timeout-error" class="text-[10px] text-red-400">
                  {scriptTimeoutError}
                </p>
              )}
            </div>

            {/* Script Presets */}
            <div class="space-y-1">
              <label class="text-[10px] uppercase tracking-wider text-gray-400">
                Script Presets
              </label>
              <div class="flex gap-2">
                <button
                  type="button"
                  data-testid="gate-editor-preset-lint"
                  onClick={() => applyScriptPreset('lint')}
                  class={`flex-1 rounded border px-2 py-1.5 text-xs transition-colors ${modeButtonClass(false)}`}
                >
                  Lint Check
                </button>
                <button
                  type="button"
                  data-testid="gate-editor-preset-typecheck"
                  onClick={() => applyScriptPreset('typecheck')}
                  class={`flex-1 rounded border px-2 py-1.5 text-xs transition-colors ${modeButtonClass(false)}`}
                >
                  Type Check
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Gate Poll */}
      <PollSection gate={gate} onChange={updateGate} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// PollSection sub-component
// ---------------------------------------------------------------------------

interface PollSectionProps {
  gate: Gate;
  onChange: (partial: Partial<Gate>) => void;
}

function PollSection({ gate, onChange }: PollSectionProps) {
  const pollEnabled = !!gate.poll;
  const pollIntervalSec = gate.poll ? Math.round(gate.poll.intervalMs / 1000) : 30;
  const pollScript = gate.poll?.script ?? '';
  const pollTarget = gate.poll?.target ?? 'to';
  const pollTemplate = gate.poll?.messageTemplate ?? '';

  const intervalError = useMemo(() => {
    if (!pollEnabled) return '';
    const ms = pollIntervalSec * 1000;
    if (ms < POLL_MIN_INTERVAL_MS) return 'interval: minimum is 10 seconds';
    return '';
  }, [pollEnabled, pollIntervalSec]);

  const scriptError = useMemo(() => {
    if (!pollEnabled) return '';
    if (!pollScript.trim()) return 'script: required when poll is enabled';
    return '';
  }, [pollEnabled, pollScript]);

  function togglePollEnabled(checked: boolean) {
    if (checked) {
      onChange({
        poll: {
          intervalMs: 30_000,
          script: '',
          target: 'to',
        },
      });
    } else {
      onChange({ poll: undefined });
    }
  }

  function updatePoll(partial: Partial<GatePoll>) {
    const current = gate.poll ?? {
      intervalMs: 30_000,
      script: '',
      target: 'to' as const,
    };
    onChange({ poll: { ...current, ...partial } });
  }

  return (
    <div class="space-y-2" data-testid="gate-editor-poll-section">
      <div class="flex items-center justify-between">
        <label class="text-[11px] uppercase tracking-[0.12em] text-gray-400">
          Poll (Periodic Script)
        </label>
        <button
          type="button"
          data-testid="gate-editor-poll-enabled"
          role="switch"
          aria-checked={pollEnabled}
          onClick={() => togglePollEnabled(!pollEnabled)}
          class={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            pollEnabled ? 'bg-blue-500' : 'bg-dark-600'
          }`}
        >
          <span
            class={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              pollEnabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {pollEnabled && (
        <div class="space-y-2 pl-1 border-l-2 border-blue-500/30">
          {/* Interval */}
          <div class="space-y-0.5">
            <label class="text-[10px] uppercase tracking-wider text-gray-400">
              Interval (seconds)
            </label>
            <div class="flex gap-1.5 mb-1">
              {POLL_INTERVAL_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  data-testid={`gate-editor-poll-interval-preset-${preset.label}`}
                  onClick={() => updatePoll({ intervalMs: preset.valueMs })}
                  class={`rounded border px-2 py-1 text-[11px] transition-colors ${
                    pollIntervalSec * 1000 === preset.valueMs
                      ? 'border-blue-500 bg-blue-500/10 text-blue-200'
                      : 'border-dark-600 bg-dark-800 text-gray-400 hover:border-dark-500'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <input
              type="number"
              data-testid="gate-editor-poll-interval"
              value={pollIntervalSec}
              min={10}
              onInput={(e) => {
                const val = Number((e.currentTarget as HTMLInputElement).value);
                if (isNaN(val)) return;
                updatePoll({ intervalMs: Math.max(10, val) * 1000 });
              }}
              class={`w-full text-xs bg-dark-800 border rounded px-2 py-1 text-gray-200 font-mono focus:outline-none ${
                intervalError
                  ? 'border-red-500 focus:border-red-500'
                  : 'border-dark-600 focus:border-blue-500'
              }`}
            />
            {intervalError && (
              <p data-testid="gate-editor-poll-interval-error" class="text-[10px] text-red-400">
                {intervalError}
              </p>
            )}
          </div>

          {/* Script */}
          <div class="space-y-0.5">
            <label class="text-[10px] uppercase tracking-wider text-gray-400">Poll Script</label>
            <textarea
              data-testid="gate-editor-poll-script"
              value={pollScript}
              placeholder={
                'if [ -z "$PR_URL" ]; then exit 0; fi\ngh api "repos/$REPO_OWNER/$REPO_NAME/pulls/$PR_NUMBER/comments" \\\n  --jq \'.[-1] | .body\''
              }
              rows={4}
              onInput={(e) => updatePoll({ script: e.currentTarget.value })}
              class={`w-full text-xs bg-dark-800 border rounded px-2 py-1.5 text-gray-200 font-mono focus:outline-none placeholder-gray-700 resize-y leading-relaxed ${
                scriptError
                  ? 'border-red-500 focus:border-red-500'
                  : 'border-dark-600 focus:border-blue-500'
              }`}
            />
            {scriptError && (
              <p data-testid="gate-editor-poll-script-error" class="text-[10px] text-red-400">
                {scriptError}
              </p>
            )}
          </div>

          {/* Target */}
          <div class="space-y-0.5">
            <label class="text-[10px] uppercase tracking-wider text-gray-400">Target Node</label>
            <select
              data-testid="gate-editor-poll-target"
              value={pollTarget}
              onChange={(e) => updatePoll({ target: e.currentTarget.value as 'from' | 'to' })}
              class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1 text-gray-200 focus:outline-none focus:border-blue-500"
            >
              <option value="to">To node (target)</option>
              <option value="from">From node (source)</option>
            </select>
          </div>

          {/* Message Template */}
          <div class="space-y-0.5">
            <label class="text-[10px] uppercase tracking-wider text-gray-400">
              Message Template
            </label>
            <input
              type="text"
              data-testid="gate-editor-poll-template"
              value={pollTemplate}
              placeholder="Use {{output}} as placeholder"
              onInput={(e) =>
                updatePoll({
                  messageTemplate: (e.currentTarget as HTMLInputElement).value || undefined,
                })
              }
              class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-700"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FieldCard sub-component
// ---------------------------------------------------------------------------

interface FieldCardProps {
  field: GateField;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onChange: (field: GateField) => void;
  onDelete: () => void;
}

function FieldCard({ field, index, expanded, onToggle, onChange, onDelete }: FieldCardProps) {
  function updateField(partial: Partial<GateField>) {
    onChange({ ...field, ...partial });
  }

  function handleTypeChange(type: GateFieldType) {
    updateField({ type, check: defaultCheckForType(type) });
  }

  function handleScalarOpChange(op: '==' | '!=' | 'exists') {
    if (op === 'exists') {
      updateField({ check: { op: 'exists' } });
    } else {
      updateField({ check: { op, value: field.check.op !== 'count' ? field.check.value : '' } });
    }
  }

  return (
    <div
      data-testid={`gate-field-card-${index}`}
      class="border border-dark-600 rounded bg-dark-800 overflow-hidden"
    >
      {/* Collapsed header */}
      <button
        type="button"
        class="w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-dark-750 transition-colors"
        onClick={onToggle}
      >
        <span class="text-gray-400">{expanded ? '\u25BC' : '\u25B6'}</span>
        <span class="font-mono text-gray-200 truncate flex-1">{field.name || '(unnamed)'}</span>
        <span class="text-gray-400 text-[11px]">{field.type}</span>
      </button>

      {expanded && (
        <div class="px-3 pb-3 space-y-2 border-t border-dark-700 pt-2">
          {/* Name */}
          <div class="space-y-0.5">
            <label class="text-[10px] uppercase tracking-wider text-gray-400">Name</label>
            <input
              type="text"
              data-testid={`gate-field-name-${index}`}
              value={field.name}
              placeholder="field_name"
              onInput={(e) => updateField({ name: (e.currentTarget as HTMLInputElement).value })}
              class="w-full text-xs bg-dark-900 border border-dark-600 rounded px-2 py-1 text-gray-200 font-mono focus:outline-none focus:border-blue-500 placeholder-gray-700"
            />
          </div>

          {/* Type */}
          <div class="space-y-0.5">
            <label class="text-[10px] uppercase tracking-wider text-gray-400">Type</label>
            <select
              data-testid={`gate-field-type-${index}`}
              value={field.type}
              onChange={(e) =>
                handleTypeChange((e.currentTarget as HTMLSelectElement).value as GateFieldType)
              }
              class="w-full text-xs bg-dark-900 border border-dark-600 rounded px-2 py-1 text-gray-200 focus:outline-none focus:border-blue-500"
            >
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          {/* Writers */}
          <div class="space-y-0.5">
            <label class="text-[10px] uppercase tracking-wider text-gray-400">
              Writers (comma-separated)
            </label>
            <input
              type="text"
              data-testid={`gate-field-writers-${index}`}
              value={field.writers.join(', ')}
              placeholder="*, human, coder"
              onInput={(e) => {
                const raw = (e.currentTarget as HTMLInputElement).value;
                const writers = raw
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean);
                updateField({ writers });
              }}
              class="w-full text-xs bg-dark-900 border border-dark-600 rounded px-2 py-1 text-gray-200 font-mono focus:outline-none focus:border-blue-500 placeholder-gray-700"
            />
          </div>

          {/* Check config — adapts to type */}
          <div class="space-y-0.5">
            <label class="text-[10px] uppercase tracking-wider text-gray-400">Check</label>
            {field.type === 'map' ? (
              // Map check: match + min
              <div class="space-y-1">
                <input
                  type="text"
                  data-testid={`gate-field-match-${index}`}
                  value={field.check.op === 'count' ? String(field.check.match ?? '') : ''}
                  placeholder="match value"
                  onInput={(e) => {
                    const match = (e.currentTarget as HTMLInputElement).value;
                    const min = field.check.op === 'count' ? field.check.min : 1;
                    updateField({ check: { op: 'count', match, min } });
                  }}
                  class="w-full text-xs bg-dark-900 border border-dark-600 rounded px-2 py-1 text-gray-200 font-mono focus:outline-none focus:border-blue-500 placeholder-gray-700"
                />
                <div class="flex items-center gap-2">
                  <label class="text-[10px] text-gray-400">Min count</label>
                  <input
                    type="number"
                    min={1}
                    data-testid={`gate-field-min-${index}`}
                    value={field.check.op === 'count' ? field.check.min : 1}
                    onInput={(e) => {
                      const min = Number((e.currentTarget as HTMLInputElement).value);
                      const match = field.check.op === 'count' ? field.check.match : 'approved';
                      updateField({ check: { op: 'count', match, min: Math.max(1, min) } });
                    }}
                    class="w-16 text-xs bg-dark-900 border border-dark-600 rounded px-2 py-1 text-gray-200 font-mono focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>
            ) : (
              // Scalar check: op + value
              <div class="space-y-1">
                <select
                  data-testid={`gate-field-op-${index}`}
                  value={field.check.op === 'count' ? '==' : field.check.op}
                  onChange={(e) =>
                    handleScalarOpChange(
                      (e.currentTarget as HTMLSelectElement).value as '==' | '!=' | 'exists'
                    )
                  }
                  class="w-full text-xs bg-dark-900 border border-dark-600 rounded px-2 py-1 text-gray-200 focus:outline-none focus:border-blue-500"
                >
                  {SCALAR_OPS.map((op) => (
                    <option key={op} value={op}>
                      {op === 'exists' ? 'Exists' : op === '==' ? 'Equals (==)' : 'Not Equal (!=)'}
                    </option>
                  ))}
                </select>
                {field.check.op !== 'exists' && field.check.op !== 'count' && (
                  <input
                    type="text"
                    data-testid={`gate-field-value-${index}`}
                    value={
                      field.check.value === true
                        ? 'true'
                        : field.check.value === false
                          ? 'false'
                          : String(field.check.value ?? '')
                    }
                    placeholder="expected value"
                    onInput={(e) => {
                      const raw = (e.currentTarget as HTMLInputElement).value;
                      let value: unknown = raw;
                      if (field.type === 'boolean') {
                        value = raw === 'true';
                      } else if (field.type === 'number') {
                        const n = Number(raw);
                        value = isNaN(n) ? raw : n;
                      }
                      updateField({
                        check: { op: field.check.op as '==' | '!=', value },
                      });
                    }}
                    class="w-full text-xs bg-dark-900 border border-dark-600 rounded px-2 py-1 text-gray-200 font-mono focus:outline-none focus:border-blue-500 placeholder-gray-700"
                  />
                )}
              </div>
            )}
          </div>

          {/* Delete field */}
          <button
            type="button"
            data-testid={`gate-field-delete-${index}`}
            onClick={onDelete}
            class="w-full rounded px-2 py-1 text-xs text-red-400 border border-red-800 hover:bg-red-900/30 transition-colors"
          >
            Delete field
          </button>
        </div>
      )}
    </div>
  );
}
