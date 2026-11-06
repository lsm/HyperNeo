import { useEffect, useState } from 'preact/hooks';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoPackSetting } from '@hyperneo/shared/types/neo-snapshot';
import { connectionManager } from '../../lib/connection-manager';
import { invokeOperation } from '../../lib/operations.ts';
import { locale } from '../../lib/i18n/index.ts';
import { CodingPackSettings } from './CodingPackSettings.tsx';
import { useNeoLanguageSetting } from '../../neo/useNeoLanguageSetting.ts';

type Label = readonly [string, string];
type Field = { label: Label; values: Record<string, Label> };
const field = (label: Label, values: Field['values']): Field => ({ label, values });
const delegation = {
  signIn: field(['Who signs in?', '谁来登录？'], {
    self: ['I sign in', '我来登录'],
    saved: ['Use my saved credentials', '使用我保存的登录信息'],
  }),
  verificationCodes: field(['Who handles verification codes?', '谁来处理验证码？'], {
    self: ['I handle them', '我来处理'],
    ask: ['Ask me in chat for the code', '在聊天中问我验证码'],
  }),
  formFill: field(['May the agent fill forms?', '可以代填表单吗？'], {
    ask: ['Ask me first', '先问我'],
    fill: ['Fill forms for me', '帮我填写表单'],
  }),
  payment: field(['Who completes payments?', '谁来完成付款？'], {
    self: ['I handle payments', '付款全部由我处理'],
    fillStop: ['Fill it, I press the last button', '帮我填写，最后由我点击'],
    confirmed: ['Press after my explicit yes', '经我明确同意后点击'],
  }),
  commitments: field(['May the agent make commitments?', '可以代我作出承诺吗？'], {
    ask: ['Ask me first', '先问我'],
    direct: ['Send, book, cancel or accept for me', '直接代我发送、预订、取消或接受条款'],
  }),
  humanStep: field(['Where do I handle my step?', '需要我操作时用什么设备？'], {
    computer: ['I can use a computer', '我可以使用电脑'],
    phoneOnly: ['Send it to my phone', '只发到我的手机'],
  }),
};
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

function EnumPackSettings({
  pack,
  title,
  fields,
}: {
  pack: string;
  title: Label;
  fields: Record<string, Field>;
}) {
  const [rows, setRows] = useState<NeoPackSetting[] | null>(null);
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
    invoke<{ preferences: NeoPackSetting[] }>('pack.preferences.list', { pack })
      .then((result) => setRows(result.preferences))
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
            <span class="text-sm font-medium text-fg">{text(field.label)}</span>
            <span class="block text-xs text-fg-faint">
              {text(values[key] === undefined ? ['Unanswered', '未设置'] : ['Saved', '已保存'])}
            </span>
            <select
              aria-label={text(field.label)}
              class="st-select w-full"
              disabled={saving}
              value={String(values[key] ?? '')}
              onChange={(event) => void save(key, event.currentTarget.value)}
            >
              <option value="" disabled>
                {text(['Unanswered', '未设置'])} — {text(Object.values(field.values)[0])}
              </option>
              {Object.entries(field.values).map(([value, label]) => (
                <option key={value} value={value}>
                  {text(label)}
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
      <EnumPackSettings
        pack="delegation"
        title={['Delegation preferences', '委托偏好']}
        fields={delegation}
      />
    </div>
  );
}
