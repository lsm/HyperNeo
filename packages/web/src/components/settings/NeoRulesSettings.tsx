import { useEffect, useState } from 'preact/hooks';
import { NEO_STANDING_RULE_MAX_CHARS, NEO_STANDING_RULES_MAX } from '@hyperneo/shared';
import { connectionManager } from '../../lib/connection-manager';
import { invokeOperation } from '../../lib/operations.ts';
import { connectionState, globalSettings } from '../../lib/state.ts';
import { Button } from '../ui/Button';

type RuleEdit = { add: [string] } | { remove: [string] };

export function NeoRulesSettings() {
  const savedRules = globalSettings.value?.neo?.standingRules;
  const [rules, setRules] = useState<string[]>(savedRules ?? []);
  const [text, setText] = useState('');
  const [edit, setEdit] = useState<RuleEdit | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => setRules(savedRules ?? []), [savedRules]);

  const rule = text.trim();
  const problem =
    rules.length >= NEO_STANDING_RULES_MAX
      ? `Neo keeps at most ${NEO_STANDING_RULES_MAX} rules; remove one first.`
      : rules.includes(rule)
        ? 'This rule is already saved.'
        : '';
  const busy = saving || edit !== null || connectionState.value !== 'connected';

  function ask(next: RuleEdit) {
    setError('');
    setEdit(next);
  }

  async function confirm() {
    if (!edit) return;
    setSaving(true);
    setError('');
    try {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) throw new Error('Reconnect before changing Neo rules.');
      const result = await invokeOperation<
        { ok: true; standingRules: string[] } | { ok: false; reason: string }
      >(hub, 'neo.rule.save', edit);
      if (!result.ok) throw new Error(result.reason);
      setRules(result.standingRules);
      if ('add' in edit) setText('');
      setEdit(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the Neo rule.');
    } finally {
      setSaving(false);
    }
  }

  function confirmation(change: RuleEdit) {
    const adding = 'add' in change;
    return (
      <div
        role="alertdialog"
        aria-label={adding ? 'Add Neo rule' : 'Remove Neo rule'}
        class="space-y-2 rounded-lg border border-line-strong bg-surface-raised p-3"
      >
        <p class="text-sm text-fg-soft">
          {adding ? 'Neo will follow this rule from now on:' : 'Neo will stop following:'}
        </p>
        <p class="text-sm text-fg whitespace-pre-wrap break-words rounded border border-line bg-surface px-3 py-2">
          {adding ? change.add[0] : change.remove[0]}
        </p>
        {error ? <p class="text-xs text-danger">{error}</p> : null}
        <div class="flex justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={saving} onClick={() => setEdit(null)}>
            Cancel
          </Button>
          <Button
            variant={adding ? 'primary' : 'danger'}
            size="sm"
            disabled={saving}
            onClick={confirm}
          >
            {adding ? 'Add' : 'Remove'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <section
      aria-label="Neo standing rules"
      class="space-y-3 rounded-xl border border-line bg-surface p-4"
    >
      <div>
        <h4 class="text-[13px] font-semibold text-fg">Standing rules</h4>
        <p class="text-xs text-fg-faint mt-0.5">
          Lasting instructions Neo follows in every conversation. Each change is confirmed and saved
          one rule at a time.
        </p>
      </div>
      <p class="text-xs text-fg-faint">
        {rules.length} of {NEO_STANDING_RULES_MAX} rules
      </p>
      {rules.length ? (
        <ol class="space-y-2">
          {rules.map((saved, index) => (
            <li key={saved} class="space-y-2">
              <div class="flex items-start gap-2 rounded-lg border border-line bg-surface-raised px-3 py-2">
                <span class="w-5 shrink-0 text-xs font-medium leading-6 text-fg-faint">
                  {index + 1}.
                </span>
                <span class="flex-1 min-w-0 text-sm leading-6 text-fg-soft whitespace-pre-wrap break-words">
                  {saved}
                </span>
                <Button
                  variant="secondary"
                  size="xs"
                  disabled={busy}
                  aria-label={`Remove Neo rule ${index + 1}`}
                  onClick={() => ask({ remove: [saved] })}
                >
                  Remove
                </Button>
              </div>
              {edit && 'remove' in edit && edit.remove[0] === saved ? confirmation(edit) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p class="text-xs text-fg-faint">No standing rules saved.</p>
      )}
      {edit && 'remove' in edit && !rules.includes(edit.remove[0]) ? confirmation(edit) : null}
      <div class="space-y-1">
        <textarea
          aria-label="New Neo rule"
          rows={2}
          class="w-full rounded border border-line bg-surface px-2 py-1 text-sm text-fg"
          placeholder="Add one rule, e.g. Open every PR from a fresh worktree."
          value={text}
          disabled={edit !== null}
          onInput={(event) => setText(event.currentTarget.value)}
        />
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span
            class={`text-xs ${rule.length > NEO_STANDING_RULE_MAX_CHARS ? 'text-danger' : 'text-fg-faint'}`}
          >
            {rule.length} / {NEO_STANDING_RULE_MAX_CHARS} characters
          </span>
          <Button
            size="sm"
            disabled={
              busy || !rule || rule.length > NEO_STANDING_RULE_MAX_CHARS || Boolean(problem)
            }
            onClick={() => ask({ add: [rule] })}
          >
            Add rule
          </Button>
        </div>
        {rule && problem ? <p class="text-xs text-warning">{problem}</p> : null}
      </div>
      {edit && 'add' in edit ? confirmation(edit) : null}
    </section>
  );
}
