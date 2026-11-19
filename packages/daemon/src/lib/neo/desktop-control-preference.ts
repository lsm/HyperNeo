import type { Database } from '../../storage/sqlite-compat.ts';
import type { NeoPackPreferenceDeclaration } from './pack-contract.ts';
import { getNeoPackPreference } from './preferences.ts';

const address = {
  pack: 'core',
  scope: { kind: 'global' as const, key: '' },
  key: 'desktopControl',
};
const question = 'When a task needs your computer, may workers use it?';

export const DESKTOP_CONTROL_PREFERENCE: NeoPackPreferenceDeclaration = {
  label: { en: 'Worker desktop control', 'zh-Hans': '工作者桌面控制' },
  question: { en: question, 'zh-Hans': '任务需要使用你的电脑时，是否允许工作者使用？' },
  valueLabels: {
    true: { en: 'Allow for tasks that need it', 'zh-Hans': '允许需要使用电脑的任务' },
    false: { en: 'Keep manual approval per task', 'zh-Hans': '继续逐项手动批准' },
  },
  scope: 'global',
  type: { kind: 'boolean' },
  default: false,
  ask: question,
};

export function desktopControlQuestion(askId: string) {
  return {
    askId,
    requestId: 'core.desktopControl',
    hold: false as const,
    alternatives: [true, false].map((value) => [{ ...address, value }]),
  };
}

export function desktopControlPreference(db: Database): unknown {
  return getNeoPackPreference(db, address.pack, address.scope, address.key)?.value;
}

export function planDesktopControl(request: unknown, preference: unknown) {
  if (request !== true) return 'off';
  if (preference === true) return 'allow';
  return preference === undefined ? 'ask' : 'off';
}
