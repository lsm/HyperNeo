import { afterEach, describe, expect, it } from 'vitest';
import { en } from '../en.ts';
import { locale, systemLocale, t } from '../index.ts';
import { zhHans } from '../zh-Hans.ts';

afterEach(() => {
  locale.value = 'en';
});

describe('i18n', () => {
  it('has a non-empty Simplified Chinese value for every English key', () => {
    expect(Object.keys(zhHans).sort()).toEqual(Object.keys(en).sort());
    for (const value of Object.values(zhHans)) expect(value.trim()).not.toBe('');
  });

  it('picks zh-Hans only when the first browser language is Chinese', () => {
    expect(systemLocale(['zh-CN', 'en'])).toBe('zh-Hans');
    expect(systemLocale(['zh-Hant-TW'])).toBe('zh-Hans');
    expect(systemLocale(['en-US', 'zh-CN'])).toBe('en');
    expect(systemLocale([])).toBe('en');
  });

  it('interpolates named parameters in the current locale', () => {
    expect(t('todo.openTitle', { title: 'Fix login' })).toBe('Open Fix login');
    locale.value = 'zh-Hans';
    expect(t('todo.openTitle', { title: 'Fix login' })).toBe('打开 Fix login');
    expect(t('todo.doneWhen')).toBe('做完 = {doneWhen}');
  });
});
