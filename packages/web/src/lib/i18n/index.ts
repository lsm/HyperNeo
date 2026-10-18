import { signal } from '@preact/signals';
import type { LanguageSetting } from '@hyperneo/shared/types/settings';
import { en } from './en.ts';
import { zhHans } from './zh-Hans.ts';

export type Locale = 'en' | 'zh-Hans';
export type MessageKey = keyof typeof en;

const catalogs: Record<Locale, Record<MessageKey, string>> = { en, 'zh-Hans': zhHans };

export function systemLocale(languages: readonly string[]): Locale {
  return languages[0]?.toLowerCase().startsWith('zh') ? 'zh-Hans' : 'en';
}

const browserLocale = () =>
  systemLocale(typeof navigator === 'undefined' ? [] : navigator.languages);

export const locale = signal<Locale>(browserLocale());

export function applyLanguage(language: LanguageSetting | undefined): void {
  locale.value = language === 'en' || language === 'zh-Hans' ? language : browserLocale();
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = catalogs[locale.value][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match
  );
}
