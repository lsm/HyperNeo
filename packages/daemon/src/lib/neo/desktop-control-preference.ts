import type { Database } from '../../storage/sqlite-compat.ts';
import type { NeoPackPreferenceDeclaration } from './pack-contract.ts';
import { getNeoPackPreference, saveNeoPackPreference } from './preferences.ts';

const address = {
  pack: 'core',
  scope: { kind: 'global' as const, key: '' },
  key: 'desktopControl',
};
const question = 'When a task needs your computer, may workers use it without asking?';

export const DESKTOP_CONTROL_PREFERENCE: NeoPackPreferenceDeclaration = {
  label: { en: 'Worker desktop control', 'zh-Hans': '工作者桌面控制' },
  question: { en: question, 'zh-Hans': '任务需要使用你的电脑时，是否不用问你就可以用？' },
  valueLabels: {
    true: { en: 'Use it without asking', 'zh-Hans': '直接使用，不用再问' },
    false: { en: 'Ask me for each task', 'zh-Hans': '每个任务都先问我' },
  },
  scope: 'global',
  type: { kind: 'boolean' },
  default: false,
  ask: question,
};

export const DESKTOP_CONTROL_ANSWERS: readonly string[] = ['No', 'Allow', 'Always allow'];

export function desktopControlPreference(db: Database): unknown {
  return getNeoPackPreference(db, address.pack, address.scope, address.key)?.value;
}

export function planDesktopControl(request: unknown, preference: unknown) {
  return request === true && preference === true ? 'allow' : 'off';
}

export function saveDesktopControlPreference(db: Database, value: boolean, now: number) {
  saveNeoPackPreference(db, address.pack, address.scope, address.key, value, now);
}
