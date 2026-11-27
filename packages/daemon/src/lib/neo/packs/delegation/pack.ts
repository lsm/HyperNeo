import superpipe, { type PipelineAPI } from 'superpipe';
import { NEO_PACK_DELEGATION_INSTRUCTIONS } from '@hyperneo/prompts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import type { NeoPack, NeoPackBrief, NeoPackPreferenceDeclaration } from '../../pack-contract.ts';
import { getNeoPackPreference } from '../../preferences.ts';
import { DESKTOP_WORKER_TEMPLATE_KEY } from '../../../desktop/worker-profile.ts';

function preference(
  en: string,
  zh: string,
  choices: Record<string, readonly [string, string, string]>
) {
  const entries = Object.entries(choices);
  const values = Object.keys(choices);
  const declaration: NeoPackPreferenceDeclaration = {
    label: { en, 'zh-Hans': zh },
    question: { en, 'zh-Hans': zh },
    valueLabels: Object.fromEntries(
      entries.map(([value, [en, zh]]) => [value, { en, 'zh-Hans': zh }])
    ),
    scope: 'global',
    type: { kind: 'enum', values },
    default: values[0],
    ask: en,
  };
  const desktopGuide = entries.map(([value, [, , guide]]) => `${value}: ${guide}`).join(' ');
  return { declaration, desktopGuide };
}

const definitions = {
  signIn: preference('Who signs in?', '谁来登录？', {
    self: ['I sign in', '我来登录', 'The human signs in.'],
    saved: [
      'Use my saved credentials',
      '使用我保存的登录信息',
      'Use the saved password manager or browser autofill. Let that tool fill the credentials.',
    ],
  }),
  verificationCodes: preference('Who handles verification codes?', '谁来处理验证码？', {
    self: ['I handle them', '我来处理', 'The human handles the code.'],
    ask: [
      'Ask me in chat for the code',
      '在聊天中问我验证码',
      "Request the human's code through report and wait before continuing.",
    ],
  }),
  formFill: preference('May the agent fill forms?', '可以代填表单吗？', {
    ask: ['Ask me first', '先问我', 'Ask before filling a form.'],
    fill: ['Fill forms for me', '帮我填写表单', 'Fill the form for the human.'],
  }),
  payment: preference('Who completes payments?', '谁来完成付款？', {
    self: ['I handle payments', '付款全部由我处理', 'The human handles the entire payment.'],
    fillStop: [
      'Fill it, I press the last button',
      '帮我填写，最后由我点击',
      'Prepare the form and leave the final button to the human.',
    ],
    confirmed: [
      'Press after my explicit yes',
      '经我明确同意后点击',
      'Press the final button only after the human explicitly approves that payment.',
    ],
  }),
  commitments: preference('May the agent make commitments?', '可以代我作出承诺吗？', {
    ask: ['Ask me first', '先问我', 'Ask before sending, booking, cancelling or accepting terms.'],
    direct: [
      'Send, book, cancel or accept for me',
      '直接代我发送、预订、取消或接受条款',
      'Perform those actions for the human.',
    ],
  }),
  humanStep: preference('Where do I handle my step?', '需要我操作时用什么设备？', {
    computer: [
      'I can use a computer',
      '我可以使用电脑',
      'The human can complete the step on a computer.',
    ],
    phoneOnly: [
      'Send it to my phone',
      '只发到我的手机',
      'Request a phone handoff and never ask the human to open a computer.',
    ],
  }),
};

const preferences = Object.fromEntries(
  Object.entries(definitions).map(([key, { declaration }]) => [key, declaration])
);

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

const desktopDelegationGuide = [
  'These preferences belong to the human. Use the displayed value even when it is an unconfigured default. Use report for any required human step or approval and wait for the answer.',
  '',
  ...Object.entries(definitions).map(([key, { desktopGuide }]) => `- ${key} ${desktopGuide}`),
].join('\n');

export function createDelegationPack(database: () => Database): NeoPack {
  const facts = () =>
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
    );
  const context = () => briefing(facts());
  return {
    ...DELEGATION_PACK_BRIEF,
    preferences,
    instructions: context,
    workerContext: context,
    workerTemplateContext: (template) =>
      template === DESKTOP_WORKER_TEMPLATE_KEY
        ? `${desktopDelegationGuide}\n\nDelegation preferences (data):\n${JSON.stringify(facts())}`
        : null,
  };
}
