import type { LanguageSetting } from '@hyperneo/shared/types/settings';
import type { z } from 'zod';
import type { PackPreferenceInput } from './preference-operations.ts';
import type { NeoPack } from '../pack-contract.ts';

type Input = z.infer<typeof PackPreferenceInput>;

function markdown(text: string): string {
  return text
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/[\\`*_[\]{}()#+.!|<>]/g, '\\$&');
}

function literal(value: unknown): string {
  const raw = String(value);
  const text = (/\r|\n/.test(raw) ? JSON.stringify(raw) : raw).replace(/\|/g, '\\|');
  const fence = '`'.repeat(
    Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length)) + 1
  );
  return `${fence} ${text} ${fence}`;
}

export function formatPreferenceProposal(
  values: readonly Input[],
  packs: readonly NeoPack[],
  language: LanguageSetting | undefined
) {
  const locale =
    language === 'en' || language === 'zh-Hans'
      ? language
      : Intl.DateTimeFormat().resolvedOptions().locale.startsWith('zh')
        ? 'zh-Hans'
        : 'en';
  const zh = locale === 'zh-Hans';
  const groups = new Map<string, { scope: Input['scope']; rows: string[] }>();
  for (const input of values) {
    const declaration = packs.find((pack) => pack.id === input.pack)!.preferences![input.key];
    const valueKey = Array.isArray(input.value) ? JSON.stringify(input.value) : String(input.value);
    const label = Object.hasOwn(declaration.valueLabels, valueKey)
      ? declaration.valueLabels[valueKey]
      : undefined;
    const value = label
      ? markdown(label[locale])
      : Array.isArray(input.value)
        ? input.value.map(literal).join(', ')
        : literal(input.value);
    const groupKey = JSON.stringify([input.scope.kind, input.scope.key]);
    const group = groups.get(groupKey) ?? { scope: input.scope, rows: [] };
    group.rows.push(`| ${markdown(declaration.label[locale])} | ${value} |`);
    groups.set(groupKey, group);
  }
  const tables = Array.from(groups.values(), ({ scope, rows }) => {
    const heading =
      scope.kind === 'global'
        ? zh
          ? '所有仓库'
          : 'All repositories'
        : scope.kind === 'project'
          ? `${zh ? '项目：' : 'Project: '}${scope.key}`
          : scope.key;
    return [
      `### ${markdown(heading)}`,
      '',
      zh ? '| 设置 | 值 |' : '| Setting | Value |',
      '| --- | --- |',
      ...rows,
    ].join('\n');
  });
  return {
    text: [zh ? '应用这些设置？' : 'Apply these settings?', ...tables].join('\n\n'),
    noLabel: zh ? '保留当前设置' : 'Keep current settings',
    yesLabel: zh ? '应用这些设置' : 'Apply these settings',
  };
}
