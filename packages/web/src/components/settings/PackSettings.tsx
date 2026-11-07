import { useEffect, useState } from 'preact/hooks';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoPackSetting } from '@hyperneo/shared/types/neo-snapshot';
import { connectionManager } from '../../lib/connection-manager';
import { invokeOperation } from '../../lib/operations.ts';
import { locale } from '../../lib/i18n/index.ts';
import { CodingPackSettings } from './CodingPackSettings.tsx';
import { useNeoLanguageSetting } from '../../neo/useNeoLanguageSetting.ts';

type Label = readonly [string, string];
type PackLabel = { en: string; 'zh-Hans': string };
type Field = { label: PackLabel; valueLabels: Record<string, PackLabel> };
const global = { kind: 'global', key: '' } as const;
const text = (label: Label) => label[locale.value === 'zh-Hans' ? 1 : 0];
const globalValues = (superpipe({})('pack.settings-values') as PipelineAPI)
  .input(['rows', 'pack'])
  .pipe(
    (rows: NeoPackSetting[], pack: string) =>
      Object.fromEntries(
        rows
          .filter((row) => row.pack === pack && row.scope.kind === 'global' && row.scope.key === '')
          .map((row) => [row.key, row.value])
      ),
    ['rows', 'pack'],
    'values'
  )
  .end('values') as (rows: NeoPackSetting[], pack: string) => Record<string, unknown>;

function EnumPackSettings({ pack, title }: { pack: string; title: Label }) {
  const [rows, setRows] = useState<NeoPackSetting[] | null>(null);
  const [fields, setFields] = useState<Record<string, Field>>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const values = globalValues(rows ?? [], pack);
  const invoke = async <T,>(name: Parameters<typeof invokeOperation>[1], input: unknown) => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub)
      throw new Error(
        text(['Reconnect before changing pack preferences.', '请重新连接后再修改偏好。'])
      );
    return invokeOperation<T>(hub, name, input);
  };
  useEffect(() => {
    invoke<{ preferences: NeoPackSetting[]; declarations: Record<string, Field> }>(
      'pack.preferences.list',
      { pack }
    )
      .then((result) => {
        setFields(result.declarations);
        setRows(result.preferences);
      })
      .catch((cause) => setError(String(cause)));
  }, [pack]);
  async function save(key: string, value: string) {
    setSaving(true);
    setError('');
    try {
      const address = { pack, scope: global, key };
      const result = await invoke<{ ok: boolean; reason?: string }>('pack.preferences.set', {
        ...address,
        value,
      });
      if (!result.ok) throw new Error(result.reason);
      const { preference } = await invoke<{ preference: NeoPackSetting | null }>(
        'pack.preferences.get',
        address
      );
      if (!preference || globalValues([preference], pack)[key] !== value)
        throw new Error(text(['The saved value did not read back.', '未能确认保存的值。']));
      setRows((current) => [...(current ?? []).filter((row) => row.key !== key), preference]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section
      aria-label={text(title)}
      class="space-y-4 rounded-xl border border-line bg-surface p-4"
    >
      <h4 class="text-[13px] font-semibold text-fg">{text(title)}</h4>
      <p class="text-xs text-fg-faint">
        {text([
          'Shared by Neo and every worker. Only you can change these.',
          'Neo 和所有工作会话共同遵循，仅由你修改。',
        ])}
      </p>
      {error && (
        <p role="alert" class="text-xs text-danger">
          {error}
        </p>
      )}
      {rows === null ? (
        <p>{text(['Loading…', '加载中…'])}</p>
      ) : (
        Object.entries(fields).map(([key, field]) => (
          <label key={key} class="block space-y-1">
            <span class="text-sm font-medium text-fg">
              {field.label[locale.value === 'zh-Hans' ? 'zh-Hans' : 'en']}
            </span>
            <span class="block text-xs text-fg-faint">
              {text(values[key] === undefined ? ['Unanswered', '未设置'] : ['Saved', '已保存'])}
            </span>
            <select
              aria-label={field.label[locale.value === 'zh-Hans' ? 'zh-Hans' : 'en']}
              class="st-select w-full"
              disabled={saving}
              value={String(values[key] ?? '')}
              onChange={(event) => void save(key, event.currentTarget.value)}
            >
              <option value="" disabled>
                {text(['Unanswered', '未设置'])} —{' '}
                {Object.values(field.valueLabels)[0][locale.value === 'zh-Hans' ? 'zh-Hans' : 'en']}
              </option>
              {Object.entries(field.valueLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label[locale.value === 'zh-Hans' ? 'zh-Hans' : 'en']}
                </option>
              ))}
            </select>
          </label>
        ))
      )}
    </section>
  );
}

export function PackSettings() {
  useNeoLanguageSetting();
  return (
    <div class="space-y-4">
      <CodingPackSettings />
      <EnumPackSettings pack="delegation" title={['Delegation preferences', '委托偏好']} />
    </div>
  );
}
