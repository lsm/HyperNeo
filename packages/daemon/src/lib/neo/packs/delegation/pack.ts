import superpipe, { type PipelineAPI } from 'superpipe';
import { NEO_PACK_DELEGATION_INSTRUCTIONS } from '@hyperneo/prompts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import type { NeoPack, NeoPackBrief, NeoPackPreferenceDeclaration } from '../../pack-contract.ts';
import { getNeoPackPreference } from '../../preferences.ts';

const preference = (
  en: string,
  zh: string,
  choices: Record<string, readonly [string, string]>
): NeoPackPreferenceDeclaration => ({
  label: { en, 'zh-Hans': zh },
  valueLabels: Object.fromEntries(
    Object.entries(choices).map(([value, [en, zh]]) => [value, { en, 'zh-Hans': zh }])
  ),
  scope: 'global',
  type: { kind: 'enum', values: Object.keys(choices) },
  default: Object.keys(choices)[0],
  ask: en,
});

const preferences = {
  signIn: preference('Who signs in?', '谁来登录？', {
    self: ['I sign in', '我来登录'],
    saved: ['Use my saved credentials', '使用我保存的登录信息'],
  }),
  verificationCodes: preference('Who handles verification codes?', '谁来处理验证码？', {
    self: ['I handle them', '我来处理'],
    ask: ['Ask me in chat for the code', '在聊天中问我验证码'],
  }),
  formFill: preference('May the agent fill forms?', '可以代填表单吗？', {
    ask: ['Ask me first', '先问我'],
    fill: ['Fill forms for me', '帮我填写表单'],
  }),
  payment: preference('Who completes payments?', '谁来完成付款？', {
    self: ['I handle payments', '付款全部由我处理'],
    fillStop: ['Fill it, I press the last button', '帮我填写，最后由我点击'],
    confirmed: ['Press after my explicit yes', '经我明确同意后点击'],
  }),
  commitments: preference('May the agent make commitments?', '可以代我作出承诺吗？', {
    ask: ['Ask me first', '先问我'],
    direct: ['Send, book, cancel or accept for me', '直接代我发送、预订、取消或接受条款'],
  }),
  humanStep: preference('Where do I handle my step?', '需要我操作时用什么设备？', {
    computer: ['I can use a computer', '我可以使用电脑'],
    phoneOnly: ['Send it to my phone', '只发到我的手机'],
  }),
};

export const DELEGATION_PACK_BRIEF: NeoPackBrief = {
  id: 'delegation',
  describe: 'Shared human preferences for delegated account, form and transaction work.',
  guidance: NEO_PACK_DELEGATION_INSTRUCTIONS,
  alwaysEnabled: true,
};

const briefing = (superpipe({})('delegation.briefing') as PipelineAPI)
  .input('facts')
  .pipe(
    (facts: Record<string, { value: unknown; configured: boolean }>) =>
      `${NEO_PACK_DELEGATION_INSTRUCTIONS}\n\nDelegation preferences (data):\n${JSON.stringify(facts)}`,
    'facts',
    'text'
  )
  .end('text') as (facts: Record<string, { value: unknown; configured: boolean }>) => string;

export function createDelegationPack(database: () => Database): NeoPack {
  const context = () =>
    briefing(
      Object.fromEntries(
        Object.entries(preferences).map(([key, declaration]) => {
          const saved = getNeoPackPreference(
            database(),
            'delegation',
            { kind: 'global', key: '' },
            key
          );
          return [key, { value: saved?.value ?? declaration.default, configured: saved !== null }];
        })
      )
    );
  return {
    ...DELEGATION_PACK_BRIEF,
    preferences,
    instructions: context,
    workerContext: context,
  };
}
