import type {
  WorkflowHook,
  WorkflowHookExternalLookup,
  WorkflowHookMcpMethod,
  WorkflowHookValidatorId,
} from '@hyperneo/shared';
import { useEffect, useMemo, useState } from 'preact/hooks';

export interface HookEditorPanelProps {
  hook: WorkflowHook;
  onChange: (hook: WorkflowHook) => void;
  onBack: () => void;
  nodeNames: string[];
  embedded?: boolean;
}

const MCP_METHODS: WorkflowHookMcpMethod[] = [
  'send_message',
  'save_artifact',
  'create_standalone_task',
  'mark_complete',
  'submit_for_approval',
  'approve_task',
];

const BUILT_IN_VALIDATORS: WorkflowHookValidatorId[] = [
  'pr_open',
  'pr_mergeable',
  'pr_ready',
  'pr_merged',
  'review_posted',
  'github_review_approved',
  'codex_review_approved',
  'artifact_exists',
  'task_reported_status',
  'post_approval_only',
];

const BUILT_IN_VALIDATOR_COPY: Record<WorkflowHookValidatorId, string> = {
  pr_open: 'PR-ready block: requires an open pull request URL before this hook can pass.',
  pr_mergeable: 'PR-ready block: requires GitHub to report the pull request as mergeable.',
  pr_ready: 'PR-ready block: requires an open, mergeable pull request with approval checks passed.',
  pr_merged: 'Merge gate: requires the pull request to be MERGED before this hook can pass.',
  review_posted:
    'Review-posted gate: requires a fresh GitHub review (or, on an own PR, a comment) since the workflow started.',
  github_review_approved: 'Requires an approved GitHub review on the pull request.',
  codex_review_approved:
    'Codex retry: blocks until Codex approval is available, then retry safely.',
  artifact_exists: 'Requires the workflow run to have a matching saved artifact.',
  task_reported_status: 'Requires the task to report the expected status.',
  post_approval_only:
    'Post-approval gate: blocks the channel until the task is approved and a post-approval merge reason is set.',
};

const EXTERNAL_LOOKUPS: WorkflowHookExternalLookup[] = ['github'];

const SCRIPT_TIMEOUT_DEFAULT = 30_000;
const SCRIPT_TIMEOUT_MAX = 120_000;

function validateLabel(value: string | undefined): string {
  if (!value || value.trim().length === 0) return 'label is required';
  if (value.length > 40) return `label: must be at most 40 characters, got ${value.length}`;
  return '';
}

function validateSourceNode(value: string | undefined): string {
  if (!value || value.trim().length === 0) return 'source node is required';
  return '';
}

function validateMethod(value: string | undefined): string {
  if (!value) return 'MCP method is required';
  if (!MCP_METHODS.includes(value as WorkflowHookMcpMethod)) {
    return `method: expected one of [${MCP_METHODS.join(', ')}]`;
  }
  return '';
}

function validateBuiltInId(value: string | undefined): string {
  if (!value) return 'validator ID is required';
  if (!BUILT_IN_VALIDATORS.includes(value as WorkflowHookValidatorId)) {
    return `validator: expected one of [${BUILT_IN_VALIDATORS.join(', ')}]`;
  }
  return '';
}

function validateScriptSource(value: string | undefined): string {
  if (!value || value.trim().length === 0) return 'script source is required';
  return '';
}

function isTemplateDataObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function modeButtonClass(active: boolean): string {
  return active
    ? 'border-accent bg-accent/10 text-accent-soft'
    : 'border-line-strong bg-surface-raised text-fg-muted hover:border-line-strong hover:text-fg-soft';
}

export function HookEditorPanel({
  hook,
  onChange,
  onBack,
  nodeNames,
  embedded = false,
}: HookEditorPanelProps) {
  const [expandedSection, setExpandedSection] = useState<string | null>('basic');
  const [templateDataDraft, setTemplateDataDraft] = useState(() =>
    hook.templateData ? JSON.stringify(hook.templateData, null, 2) : ''
  );
  const [templateDataError, setTemplateDataError] = useState<string | null>(null);

  useEffect(() => {
    setTemplateDataDraft(hook.templateData ? JSON.stringify(hook.templateData, null, 2) : '');
    setTemplateDataError(null);
  }, [hook.id, hook.templateData]);

  const labelError = useMemo(() => validateLabel(hook.label), [hook.label]);
  const sourceNodeError = useMemo(() => validateSourceNode(hook.sourceNode), [hook.sourceNode]);
  const methodError = useMemo(() => validateMethod(hook.method), [hook.method]);

  const validatorKind = hook.validator.kind;
  const builtInId = validatorKind === 'built_in' ? hook.validator.id : '';
  const scriptSource = validatorKind === 'script' ? hook.validator.source : '';
  const scriptTimeout =
    validatorKind === 'script'
      ? (hook.validator.timeoutMs ?? SCRIPT_TIMEOUT_DEFAULT)
      : SCRIPT_TIMEOUT_DEFAULT;
  const scriptExternalLookups =
    validatorKind === 'script' ? (hook.validator.externalLookups ?? []) : [];

  const builtInIdError = useMemo(
    () => (validatorKind === 'built_in' ? validateBuiltInId(builtInId) : ''),
    [validatorKind, builtInId]
  );
  const scriptSourceError = useMemo(
    () => (validatorKind === 'script' ? validateScriptSource(scriptSource) : ''),
    [validatorKind, scriptSource]
  );

  const isPrReadyValidator = validatorKind === 'built_in' && builtInId === 'pr_ready';
  const isCodexApprovalValidator =
    validatorKind === 'built_in' && builtInId === 'codex_review_approved';
  const maxAttempts = hook.retry?.maxAttempts ?? (isCodexApprovalValidator ? 0 : 3);
  const delayMs = hook.retry?.delayMs ?? (isCodexApprovalValidator ? 60_000 : 5_000);
  const backoffMultiplier = hook.retry?.backoffMultiplier ?? 1;

  function updateHook(partial: Partial<WorkflowHook>) {
    onChange({ ...hook, ...partial });
  }

  function updateSourceNode(sourceNode: string) {
    onChange({
      ...hook,
      sourceNode,
      authorizedCallers: (hook.authorizedCallers ?? [{ sourceNode }]).map((caller) => ({
        ...caller,
        sourceNode: caller.sourceNode === hook.sourceNode ? sourceNode : caller.sourceNode,
        agentSlots: caller.sourceNode === hook.sourceNode ? undefined : caller.agentSlots,
      })),
    });
  }

  function updateMethod(method: WorkflowHookMcpMethod) {
    onChange({
      ...hook,
      method,
      targetNode: method === 'send_message' ? hook.targetNode : undefined,
    });
  }

  function updateValidator(partial: Partial<WorkflowHook['validator']>) {
    const current = hook.validator;
    onChange({ ...hook, validator: { ...current, ...partial } as WorkflowHook['validator'] });
  }

  function updateRetry(partial: Partial<NonNullable<WorkflowHook['retry']>>) {
    const current = hook.retry ?? {
      maxAttempts: isCodexApprovalValidator ? 0 : 3,
      delayMs: isCodexApprovalValidator ? 60_000 : 5_000,
    };
    onChange({ ...hook, retry: { ...current, ...partial } });
  }

  function updateTemplateData(raw: string) {
    setTemplateDataDraft(raw);
    try {
      const parsed = raw.trim() ? JSON.parse(raw) : undefined;
      if (parsed !== undefined && !isTemplateDataObject(parsed)) {
        setTemplateDataError('Template data must be a JSON object');
        return;
      }
      setTemplateDataError(null);
      updateHook({ templateData: parsed });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid JSON';
      setTemplateDataError(message);
    }
  }

  function addAuthorizedCaller() {
    const next = [...(hook.authorizedCallers ?? [])];
    next.push({ sourceNode: hook.sourceNode ?? nodeNames[0] ?? '' });
    updateHook({ authorizedCallers: next });
  }

  function updateAuthorizedCaller(
    index: number,
    caller: NonNullable<WorkflowHook['authorizedCallers']>[number]
  ) {
    const next = [...(hook.authorizedCallers ?? [])];
    next[index] = { ...caller, sourceNode: hook.sourceNode };
    updateHook({ authorizedCallers: next });
  }

  function removeAuthorizedCaller(index: number) {
    const current = hook.authorizedCallers ?? [];
    if (current.length <= 1) return;
    const next = [...current];
    next.splice(index, 1);
    updateHook({ authorizedCallers: next });
  }

  function toggleExternalLookup(lookup: WorkflowHookExternalLookup) {
    const current = new Set(scriptExternalLookups);
    if (current.has(lookup)) current.delete(lookup);
    else current.add(lookup);
    if (validatorKind === 'script') {
      updateValidator({ externalLookups: Array.from(current) });
    }
  }

  const sections: { id: string; label: string }[] = [
    { id: 'basic', label: 'Basic' },
    { id: 'validator', label: 'Validator' },
    { id: 'callers', label: 'Callers' },
    { id: 'retry', label: 'Retry / Poll' },
  ];

  return (
    <div
      data-testid="hook-editor-panel"
      class={
        embedded
          ? 'flex-1 overflow-y-auto px-4 py-4 space-y-3 text-sm text-accent-fg'
          : 'flex flex-col gap-3 p-4 bg-surface-overlay border border-line rounded-lg text-sm text-accent-fg max-h-full overflow-y-auto'
      }
    >
      {!embedded && (
        <div class="flex items-center gap-2">
          <button
            type="button"
            data-testid="hook-editor-back"
            onClick={onBack}
            class="text-fg-muted hover:text-accent-fg transition-colors text-xs"
            aria-label="Back"
          >
            &larr;
          </button>
          <span class="font-semibold text-accent-fg text-sm">Hook Editor</span>
        </div>
      )}

      <div class="flex items-center justify-between">
        <label class="text-[11px] uppercase tracking-[0.12em] text-fg-muted">Enabled</label>
        <button
          type="button"
          data-testid="hook-editor-enabled"
          role="switch"
          aria-checked={hook.enabled}
          onClick={() => updateHook({ enabled: !hook.enabled })}
          class={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            hook.enabled ? 'bg-accent' : 'bg-line-strong'
          }`}
        >
          <span
            class={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              hook.enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      <div class="flex gap-1.5">
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            data-testid={`hook-editor-section-${s.id}`}
            onClick={() => setExpandedSection(expandedSection === s.id ? null : s.id)}
            class={`rounded border px-2 py-1 text-[11px] transition-colors ${
              expandedSection === s.id ? modeButtonClass(true) : modeButtonClass(false)
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {expandedSection === 'basic' && (
        <div class="space-y-3" data-testid="hook-editor-basic-section">
          <div class="space-y-1">
            <label class="text-[11px] uppercase tracking-[0.12em] text-fg-muted">Hook ID</label>
            <div class="text-xs font-mono bg-surface-raised rounded px-2 py-1.5 text-fg-muted border border-line truncate">
              {hook.id}
            </div>
          </div>

          <div class="space-y-1">
            <label class="text-[11px] uppercase tracking-[0.12em] text-fg-muted">Label</label>
            <input
              type="text"
              data-testid="hook-editor-label"
              value={hook.label ?? ''}
              placeholder="Human-readable label"
              onInput={(e) => updateHook({ label: (e.currentTarget as HTMLInputElement).value })}
              class={`w-full text-xs bg-surface-raised border rounded px-2 py-1.5 text-fg-soft focus:outline-none placeholder-gray-700${
                labelError
                  ? 'border-danger focus:border-danger'
                  : 'border-line-strong focus:border-accent'
              }`}
            />
            {labelError && <p class="text-[10px] text-danger">{labelError}</p>}
          </div>

          <div class="space-y-1">
            <label class="text-[11px] uppercase tracking-[0.12em] text-fg-muted">Source Node</label>
            <select
              data-testid="hook-editor-source-node"
              value={hook.sourceNode}
              onChange={(e) => updateSourceNode(e.currentTarget.value)}
              class={`w-full text-xs bg-surface-raised border rounded px-2 py-1 text-fg-soft focus:outline-none${
                sourceNodeError
                  ? 'border-danger focus:border-danger'
                  : 'border-line-strong focus:border-accent'
              }`}
            >
              {nodeNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            {sourceNodeError && <p class="text-[10px] text-danger">{sourceNodeError}</p>}
          </div>

          <div class="space-y-1">
            <label class="text-[11px] uppercase tracking-[0.12em] text-fg-muted">
              Target Node <span class="text-fg-faint">(optional)</span>
            </label>
            <select
              data-testid="hook-editor-target-node"
              value={hook.method === 'send_message' ? (hook.targetNode ?? '') : ''}
              disabled={hook.method !== 'send_message'}
              onChange={(e) =>
                updateHook({
                  targetNode: e.currentTarget.value || undefined,
                })
              }
              class="w-full text-xs bg-surface-raised border border-line-strong rounded px-2 py-1 text-fg-soft focus:outline-none focus:border-accent disabled:opacity-50"
            >
              <option value="">— Any target —</option>
              {nodeNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          <div class="space-y-1">
            <label class="text-[11px] uppercase tracking-[0.12em] text-fg-muted">MCP Method</label>
            <select
              data-testid="hook-editor-method"
              value={hook.method}
              onChange={(e) => updateMethod(e.currentTarget.value as WorkflowHookMcpMethod)}
              class={`w-full text-xs bg-surface-raised border rounded px-2 py-1 text-fg-soft focus:outline-none${
                methodError
                  ? 'border-danger focus:border-danger'
                  : 'border-line-strong focus:border-accent'
              }`}
            >
              {MCP_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            {methodError && <p class="text-[10px] text-danger">{methodError}</p>}
          </div>

          <div class="space-y-1">
            <label class="text-[11px] uppercase tracking-[0.12em] text-fg-muted">
              Template Data <span class="text-fg-faint">(JSON)</span>
            </label>
            <textarea
              data-testid="hook-editor-template-data"
              value={templateDataDraft}
              placeholder='{"key": "value"}'
              rows={4}
              onInput={(e) => updateTemplateData(e.currentTarget.value)}
              class={`w-full text-xs bg-surface-raised border rounded px-2 py-1.5 text-fg-soft font-mono focus:outline-none placeholder-gray-700 resize-y leading-relaxed ${
                templateDataError
                  ? 'border-danger focus:border-danger'
                  : 'border-line-strong focus:border-accent'
              }`}
            />
            {templateDataError && <p class="text-[10px] text-danger">{templateDataError}</p>}
          </div>

          <div class="grid grid-cols-2 gap-2">
            <div class="space-y-1">
              <label class="text-[11px] uppercase tracking-[0.12em] text-fg-muted">
                Classification
              </label>
              <select
                data-testid="hook-editor-classification"
                value={hook.classification ?? 'validation'}
                onChange={(e) =>
                  updateHook({
                    classification: e.currentTarget.value as 'validation' | 'side_effect',
                  })
                }
                class="w-full text-xs bg-surface-raised border border-line-strong rounded px-2 py-1 text-fg-soft focus:outline-none focus:border-accent"
              >
                <option value="validation">validation</option>
                <option value="side_effect">side_effect</option>
              </select>
            </div>
            <div class="space-y-1">
              <label class="text-[11px] uppercase tracking-[0.12em] text-fg-muted">Order</label>
              <input
                type="number"
                data-testid="hook-editor-order"
                value={hook.order ?? 0}
                min={0}
                onInput={(e) => {
                  const val = Number((e.currentTarget as HTMLInputElement).value);
                  if (isNaN(val)) return;
                  updateHook({ order: Math.max(0, val) });
                }}
                class="w-full text-xs bg-surface-raised border border-line-strong rounded px-2 py-1 text-fg-soft font-mono focus:outline-none focus:border-accent"
              />
            </div>
          </div>

          <p class="rounded border border-warning/50 bg-warning/10 px-2 py-1.5 text-[11px] text-warning-soft">
            Human-only hooks are not supported yet, so this editor only creates agent-triggered
            hooks.
          </p>
        </div>
      )}

      {expandedSection === 'validator' && (
        <div class="space-y-3" data-testid="hook-editor-validator-section">
          <div class="flex items-center gap-2">
            <button
              type="button"
              data-testid="hook-editor-validator-kind-built-in"
              disabled
              title="Built-in validator selection is not yet available in this editor."
              class={`flex-1 rounded border px-2 py-1.5 text-xs transition-colors opacity-50 cursor-not-allowed ${
                validatorKind === 'built_in' ? modeButtonClass(true) : modeButtonClass(false)
              }`}
            >
              Built-in (coming soon)
            </button>
            <button
              type="button"
              data-testid="hook-editor-validator-kind-script"
              onClick={() =>
                updateHook({
                  validator: {
                    kind: 'script',
                    interpreter: 'bash',
                    source: '',
                    timeoutMs: SCRIPT_TIMEOUT_DEFAULT,
                  },
                })
              }
              class={`flex-1 rounded border px-2 py-1.5 text-xs transition-colors ${
                validatorKind === 'script' ? modeButtonClass(true) : modeButtonClass(false)
              }`}
            >
              Script
            </button>
          </div>

          {validatorKind === 'built_in' && (
            <div class="space-y-1">
              <label class="text-[11px] uppercase tracking-[0.12em] text-fg-muted">Validator</label>
              <select
                data-testid="hook-editor-built-in-id"
                value={builtInId}
                disabled
                onChange={(e) =>
                  updateValidator({
                    id: e.currentTarget.value as WorkflowHookValidatorId,
                  })
                }
                class={`w-full text-xs bg-surface-raised border rounded px-2 py-1 text-fg-soft focus:outline-none opacity-60 ${
                  builtInIdError
                    ? 'border-danger focus:border-danger'
                    : 'border-line-strong focus:border-accent'
                }`}
              >
                {BUILT_IN_VALIDATORS.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
              {!builtInIdError && builtInId && (
                <p class="text-[10px] text-fg-muted" data-testid="hook-editor-validator-copy">
                  {BUILT_IN_VALIDATOR_COPY[builtInId as WorkflowHookValidatorId]}
                </p>
              )}
              {builtInIdError && <p class="text-[10px] text-danger">{builtInIdError}</p>}
            </div>
          )}

          {validatorKind === 'script' && (
            <div class="space-y-2 pl-1 border-l-2 border-accent/30">
              <div class="space-y-0.5">
                <label class="text-[10px] uppercase tracking-wider text-fg-muted">
                  Interpreter
                </label>
                <select
                  data-testid="hook-editor-script-interpreter"
                  value="bash"
                  disabled
                  class="w-full text-xs bg-surface-raised border border-line-strong rounded px-2 py-1 text-fg-soft focus:outline-none opacity-60"
                >
                  <option value="bash">bash</option>
                </select>
              </div>

              <div class="space-y-0.5">
                <label class="text-[10px] uppercase tracking-wider text-fg-muted">Source</label>
                <textarea
                  data-testid="hook-editor-script-source"
                  value={scriptSource}
                  placeholder="# Enter your script here..."
                  rows={6}
                  onInput={(e) => updateValidator({ source: e.currentTarget.value })}
                  class={`w-full text-xs bg-surface-raised border rounded px-2 py-1.5 text-fg-soft font-mono focus:outline-none placeholder-gray-700 resize-y leading-relaxed ${
                    scriptSourceError
                      ? 'border-danger focus:border-danger'
                      : 'border-line-strong focus:border-accent'
                  }`}
                />
                {scriptSourceError && <p class="text-[10px] text-danger">{scriptSourceError}</p>}
              </div>

              <div class="space-y-0.5">
                <label class="text-[10px] uppercase tracking-wider text-fg-muted">
                  Timeout (ms)
                </label>
                <input
                  type="number"
                  data-testid="hook-editor-script-timeout"
                  value={scriptTimeout}
                  min={1000}
                  max={SCRIPT_TIMEOUT_MAX}
                  onInput={(e) => {
                    const val = Number((e.currentTarget as HTMLInputElement).value);
                    if (isNaN(val)) return;
                    updateValidator({
                      timeoutMs: Math.max(1000, Math.min(SCRIPT_TIMEOUT_MAX, val)),
                    });
                  }}
                  class="w-full text-xs bg-surface-raised border border-line-strong rounded px-2 py-1 text-fg-soft font-mono focus:outline-none focus:border-accent"
                />
              </div>

              <div class="space-y-1">
                <label class="text-[10px] uppercase tracking-wider text-fg-muted">
                  External Lookups
                </label>
                <div class="flex flex-wrap gap-2">
                  {EXTERNAL_LOOKUPS.map((lookup) => (
                    <label key={lookup} class="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        data-testid={`hook-editor-external-lookup-${lookup}`}
                        checked={scriptExternalLookups.includes(lookup)}
                        onChange={() => toggleExternalLookup(lookup)}
                        class="rounded border-line-strong text-accent focus:ring-accent"
                      />
                      <span class="text-xs text-fg-muted">{lookup}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {expandedSection === 'callers' && (
        <div class="space-y-3" data-testid="hook-editor-callers-section">
          {(hook.authorizedCallers ?? []).length === 0 && (
            <p class="text-xs text-fg-muted italic">
              No authorized callers — hook will fail closed.
            </p>
          )}

          {(hook.authorizedCallers ?? []).map((caller, i) => (
            <div key={i} class="border border-line-strong rounded bg-surface-raised p-2 space-y-2">
              <div class="space-y-1">
                <label class="text-[10px] uppercase tracking-wider text-fg-muted">
                  Source Node
                </label>
                <select
                  data-testid={`hook-editor-caller-source-${i}`}
                  value={hook.sourceNode}
                  disabled
                  onChange={(e) =>
                    updateAuthorizedCaller(i, { ...caller, sourceNode: e.currentTarget.value })
                  }
                  class="w-full text-xs bg-surface border border-line rounded px-2 py-1 text-fg-soft focus:outline-none focus:border-accent opacity-60"
                >
                  <option value={hook.sourceNode}>{hook.sourceNode}</option>
                </select>
                <p class="text-[10px] text-fg-faint">
                  Caller source follows the hook source so this hook can match at runtime.
                </p>
              </div>

              <div class="space-y-1">
                <label class="text-[10px] uppercase tracking-wider text-fg-muted">
                  Agent Slots <span class="text-fg-faint">(comma-separated, empty = any)</span>
                </label>
                <input
                  type="text"
                  data-testid={`hook-editor-caller-slots-${i}`}
                  value={caller.agentSlots?.join(', ') ?? ''}
                  placeholder="reviewer, coder"
                  disabled
                  title="Slot filtering is not supported by this editor yet. Leave empty to allow any slot on the source node."
                  onInput={(e) => {
                    const raw = (e.currentTarget as HTMLInputElement).value;
                    const slots = raw
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean);
                    updateAuthorizedCaller(i, {
                      ...caller,
                      agentSlots: slots.length > 0 ? slots : undefined,
                    });
                  }}
                  class="w-full text-xs bg-surface border border-line rounded px-2 py-1 text-fg-soft font-mono focus:outline-none focus:border-accent placeholder-gray-700 disabled:opacity-50"
                />
                <p class="text-[10px] text-fg-faint">
                  Slot filters are not supported in this editor yet; empty means any slot.
                </p>
              </div>

              <button
                type="button"
                data-testid={`hook-editor-caller-delete-${i}`}
                onClick={() => removeAuthorizedCaller(i)}
                disabled={(hook.authorizedCallers ?? []).length <= 1}
                class="w-full rounded px-2 py-1 text-xs text-danger border border-danger hover:bg-danger/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {(hook.authorizedCallers ?? []).length <= 1
                  ? 'At least one caller required'
                  : 'Remove caller'}
              </button>
            </div>
          ))}

          <button
            type="button"
            data-testid="hook-editor-add-caller"
            onClick={addAuthorizedCaller}
            class="w-full rounded border border-dashed border-line-strong px-2 py-1.5 text-xs text-fg-muted hover:border-accent hover:text-accent-soft transition-colors"
          >
            + Add Caller
          </button>
        </div>
      )}

      {expandedSection === 'retry' && (
        <div class="space-y-3" data-testid="hook-editor-retry-section">
          <div class="space-y-2">
            <label class="text-[11px] uppercase tracking-[0.12em] text-fg-muted">
              Retry Settings
            </label>
            {isPrReadyValidator ? (
              <p
                class="rounded border border-accent/50 bg-accent/10 px-2 py-1.5 text-[11px] text-accent-soft"
                data-testid="hook-editor-pr-ready-retry-note"
              >
                PR-ready hooks retry on transient GitHub states without a visible attempt cap. Retry
                fields are hidden so saved behavior matches built-in workflow defaults.
              </p>
            ) : (
              <div class="grid grid-cols-3 gap-2">
                <div class="space-y-0.5">
                  <label class="text-[10px] text-fg-muted">Max attempts</label>
                  <input
                    type="number"
                    data-testid="hook-editor-retry-max-attempts"
                    value={maxAttempts}
                    min={1}
                    max={20}
                    onInput={(e) => {
                      const val = Number((e.currentTarget as HTMLInputElement).value);
                      if (isNaN(val)) return;
                      updateRetry({
                        maxAttempts: Math.max(isCodexApprovalValidator ? 0 : 1, Math.min(20, val)),
                      });
                    }}
                    class="w-full text-xs bg-surface-raised border border-line-strong rounded px-2 py-1 text-fg-soft font-mono focus:outline-none focus:border-accent"
                  />
                </div>
                <div class="space-y-0.5">
                  <label class="text-[10px] text-fg-muted">Delay (ms)</label>
                  <input
                    type="number"
                    data-testid="hook-editor-retry-delay"
                    value={delayMs}
                    min={0}
                    step={1000}
                    onInput={(e) => {
                      const val = Number((e.currentTarget as HTMLInputElement).value);
                      if (isNaN(val)) return;
                      updateRetry({ delayMs: Math.max(0, val) });
                    }}
                    class="w-full text-xs bg-surface-raised border border-line-strong rounded px-2 py-1 text-fg-soft font-mono focus:outline-none focus:border-accent"
                  />
                </div>
                <div class="space-y-0.5">
                  <label class="text-[10px] text-fg-muted">Backoff</label>
                  <input
                    type="number"
                    data-testid="hook-editor-retry-backoff"
                    value={backoffMultiplier}
                    min={1}
                    max={10}
                    step={0.1}
                    onInput={(e) => {
                      const val = Number((e.currentTarget as HTMLInputElement).value);
                      if (isNaN(val)) return;
                      updateRetry({ backoffMultiplier: Math.max(1, Math.min(10, val)) });
                    }}
                    class="w-full text-xs bg-surface-raised border border-line-strong rounded px-2 py-1 text-fg-soft font-mono focus:outline-none focus:border-accent"
                  />
                </div>
              </div>
            )}
          </div>

          <p
            class="rounded border border-warning/50 bg-warning/10 px-2 py-1.5 text-[11px] text-warning-soft"
            data-testid="hook-editor-poll-unsupported"
          >
            Polling hooks are not supported yet, so poll settings are not saved by this editor.
          </p>
        </div>
      )}
    </div>
  );
}
