import type { SessionReuseFacts } from '../../storage/repositories/neo-ask-input-worker.ts';
import type { NeoPackPreferenceDeclaration } from './pack-contract.ts';

export const SESSION_REUSE_VALUES = ['long_lived', 'per_ask', 'per_todo'] as const;

export const SESSION_REUSE_PREFERENCE: NeoPackPreferenceDeclaration = {
  label: { en: 'Session reuse', 'zh-Hans': '会话复用' },
  question: { en: 'How should sessions be reused?', 'zh-Hans': '如何复用会话？' },
  valueLabels: {
    long_lived: { en: 'Reuse when free', 'zh-Hans': '空闲就复用' },
    per_ask: { en: 'One session per matter', 'zh-Hans': '每件事一个会话' },
    per_todo: { en: 'One session per step', 'zh-Hans': '每个步骤一个会话' },
  },
  valueDescriptions: {
    long_lived: {
      en: 'Reuse this matter’s free worker; start a new session otherwise.',
      'zh-Hans': '复用本事项空闲的工作者，否则启动新会话。',
    },
    per_ask: {
      en: 'Reuse this matter’s worker and wait if it is busy.',
      'zh-Hans': '复用本事项的工作者，忙时等待。',
    },
    per_todo: { en: 'Start a new session for each step.', 'zh-Hans': '每个步骤启动一个新会话。' },
  },
  scope: 'project',
  type: { kind: 'enum', values: SESSION_REUSE_VALUES },
  default: 'long_lived',
  ask: 'How should sessions be reused?',
};

export function sessionReuseQuestion(facts: SessionReuseFacts) {
  const prefix = `core.sessionReuse:${facts.scope.kind}:${facts.scope.key}:`;
  return {
    requestId: `${prefix}${crypto.randomUUID()}`,
    prefix,
    hold: false as const,
    alternatives: SESSION_REUSE_VALUES.map((value) => [
      { pack: 'core', scope: facts.scope, key: 'sessionReuse', value },
    ]),
  };
}
