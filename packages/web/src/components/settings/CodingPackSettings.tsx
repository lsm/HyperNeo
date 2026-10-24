import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { NeoPackSetting } from '@hyperneo/shared/types/neo-snapshot';
import { connectionManager } from '../../lib/connection-manager';
import { invokeOperation } from '../../lib/operations.ts';
import { Button } from '../ui/Button';

type Scope = { kind: 'global' | 'repo'; key: string };
type Key = 'mergePolicy' | 'reviewBot' | 'humanSignoff';

const MERGE_POLICIES = [
  ['review_bot', 'CI and review bot approval'],
  ['ci_only', 'CI passes'],
  ['human', 'Human approval'],
] as const;
const GLOBAL: Scope = { kind: 'global', key: '' };
const sameScope = (a: NeoPackSetting['scope'], b: Scope) =>
  a.kind === b.kind && a.key.toLowerCase() === b.key.toLowerCase();

function hub() {
  const current = connectionManager.getHubIfConnected();
  if (!current) throw new Error('Reconnect before changing Coding pack settings.');
  return current;
}

export function CodingPackSettings() {
  const [rows, setRows] = useState<NeoPackSetting[] | null>(null);
  const [repo, setRepo] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [bot, setBot] = useState('');
  const [globs, setGlobs] = useState('');

  async function load() {
    const result = await invokeOperation<{ preferences: NeoPackSetting[] }>(
      hub(),
      'pack.preferences.list',
      { pack: 'coding' }
    );
    setRows(result.preferences);
  }
  useEffect(() => {
    load().catch((cause) =>
      setError(cause instanceof Error ? cause.message : 'Could not load Coding pack settings.')
    );
  }, []);

  const repoName = repo.trim();
  const repos = [
    ...new Set(rows?.filter((row) => row.scope.kind === 'repo').map((row) => row.scope.key)),
  ];
  const scope: Scope = repoName
    ? {
        kind: 'repo',
        key: repos.find((key) => key.toLowerCase() === repoName.toLowerCase()) ?? repoName,
      }
    : GLOBAL;
  const scopeName = scope.kind === 'repo' ? scope.key : 'pack global';
  const read = (key: Key) => {
    const own = rows?.find((row) => row.key === key && sameScope(row.scope, scope));
    const inherited = rows?.find((row) => row.key === key && sameScope(row.scope, GLOBAL));
    const saved = own ?? inherited;
    return {
      value: saved?.value,
      state: own ? `Saved for ${scopeName}` : saved ? 'Inherited from pack global' : 'Unanswered',
    };
  };
  const merge = read('mergePolicy');
  const reviewBot = read('reviewBot');
  const signoff = read('humanSignoff');
  const savedBot = typeof reviewBot.value === 'string' ? reviewBot.value : '';
  const savedGlobs = Array.isArray(signoff.value) ? signoff.value.join('\n') : '';
  useEffect(() => setBot(savedBot), [savedBot]);
  useEffect(() => setGlobs(savedGlobs), [savedGlobs]);

  async function save(key: Key, value: unknown) {
    setSaving(true);
    setError('');
    try {
      const address = { pack: 'coding', scope, key };
      const result = await invokeOperation<{ ok: true } | { ok: false; reason: string }>(
        hub(),
        'pack.preferences.set',
        { ...address, value }
      );
      if (!result.ok) throw new Error(result.reason);
      const { preference } = await invokeOperation<{ preference: NeoPackSetting | null }>(
        hub(),
        'pack.preferences.get',
        address
      );
      if (
        !preference ||
        !sameScope(preference.scope, scope) ||
        JSON.stringify(preference.value) !== JSON.stringify(value)
      )
        throw new Error(`The saved ${key} did not read back for ${scopeName}.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the Coding pack setting.');
    } finally {
      setSaving(false);
    }
  }

  function field(label: string, state: string, control: ComponentChildren) {
    return (
      <div role="group" aria-label={label} class="space-y-1.5">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <span class="text-sm font-medium text-fg">{label}</span>
          <span data-state class="text-xs text-fg-faint">
            {state}
          </span>
        </div>
        {control}
      </div>
    );
  }

  const input = 'w-full rounded border border-line bg-surface px-2 py-1 text-sm text-fg';
  return (
    <section
      aria-label="Coding pack settings"
      class="space-y-4 rounded-xl border border-line bg-surface p-4"
    >
      <div>
        <h4 class="text-[13px] font-semibold text-fg">Coding pack</h4>
        <p class="text-xs text-fg-faint mt-0.5">
          How Neo merges pull requests. Answers for a repository override pack global; a repository
          without its own answer uses pack global. Only you can change these.
        </p>
      </div>
      <label class="block space-y-1">
        <span class="text-xs text-fg-soft">Repository</span>
        <input
          aria-label="Repository"
          list="coding-pack-repos"
          class={input}
          placeholder="owner/name — leave empty for pack global"
          value={repo}
          onInput={(event) => setRepo(event.currentTarget.value)}
        />
        <datalist id="coding-pack-repos">
          {repos.map((key) => (
            <option key={key} value={key} />
          ))}
        </datalist>
      </label>
      <p class="text-xs text-fg-soft">Editing: {scopeName}</p>
      {error ? (
        <p role="alert" class="text-xs text-danger">
          {error}
        </p>
      ) : null}
      {rows === null ? (
        <p class="text-xs text-fg-faint">Loading…</p>
      ) : (
        <div class="space-y-4">
          {field(
            'Merge policy',
            merge.state,
            <select
              aria-label="Merge policy"
              class="st-select"
              disabled={saving}
              value={typeof merge.value === 'string' ? merge.value : ''}
              onChange={(event) => void save('mergePolicy', event.currentTarget.value)}
            >
              {merge.value === undefined ? (
                <option value="" disabled>
                  Unanswered
                </option>
              ) : null}
              {MERGE_POLICIES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          )}
          {merge.value === 'review_bot'
            ? field(
                'Review bot',
                reviewBot.state,
                <div class="flex gap-2">
                  <input
                    aria-label="Review bot"
                    class={input}
                    placeholder="GitHub login"
                    value={bot}
                    disabled={saving}
                    onInput={(event) => setBot(event.currentTarget.value)}
                  />
                  <Button
                    size="sm"
                    disabled={saving || !bot.trim()}
                    onClick={() => void save('reviewBot', bot.trim())}
                  >
                    Save
                  </Button>
                </div>
              )
            : null}
          {field(
            'Human sign-off paths or labels',
            signoff.state,
            <div class="space-y-1.5">
              {Array.isArray(signoff.value) && signoff.value.length === 0 ? (
                <p class="text-xs text-fg-soft">No extra human sign-off paths or labels</p>
              ) : null}
              <textarea
                aria-label="Human sign-off paths or labels"
                rows={3}
                class={input}
                placeholder="One path glob or label per line"
                value={globs}
                disabled={saving}
                onInput={(event) => setGlobs(event.currentTarget.value)}
              />
              <div class="flex justify-end">
                <Button
                  size="sm"
                  aria-label="Save sign-off paths"
                  disabled={saving}
                  onClick={() =>
                    void save(
                      'humanSignoff',
                      globs
                        .split('\n')
                        .map((line) => line.trim())
                        .filter(Boolean)
                    )
                  }
                >
                  Save
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
