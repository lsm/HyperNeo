import { signal } from '@preact/signals';
import type { Locale } from '../lib/i18n/index.ts';
import { en } from '../lib/i18n/en.ts';
import { zhHans } from '../lib/i18n/zh-Hans.ts';

let timer: ReturnType<typeof setInterval> | undefined;
const refresh = () => {
  clearInterval(timer);
  neoNow.value = Date.now();
  if (document.visibilityState === 'visible')
    timer = setInterval(() => {
      neoNow.value = Date.now();
    }, 30_000);
};
export const neoNow = signal(Date.now(), {
  watched() {
    if (typeof document === 'undefined') return;
    refresh();
    document.addEventListener('visibilitychange', refresh);
  },
  unwatched() {
    clearInterval(timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', refresh);
  },
});

export function neoRelativeTime(at: number | null | undefined, now: number, locale: Locale) {
  if (!at || !Number.isFinite(at) || at < 0 || !Number.isFinite(new Date(at).getTime()))
    return null;
  const date = new Date(at);
  const current = new Date(now);
  const age = Math.max(0, now - at);
  const words = locale === 'en' ? en : zhHans;
  const format = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, options).format(date);
  const time = format({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const previousDay = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 1);
  let label: string;
  if (age < 60_000) label = words['time.justNow'];
  else if (age < 3_600_000)
    label = new Intl.RelativeTimeFormat(locale).format(-Math.floor(age / 60_000), 'minute');
  else if (age < 86_400_000)
    label = new Intl.RelativeTimeFormat(locale).format(-Math.floor(age / 3_600_000), 'hour');
  else if (date.toDateString() === previousDay.toDateString())
    label = `${words['time.yesterday']} ${time}`;
  else
    label = format({
      year: date.getFullYear() === current.getFullYear() ? undefined : 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  return {
    label,
    iso: date.toISOString(),
    full: format({
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }),
  };
}
