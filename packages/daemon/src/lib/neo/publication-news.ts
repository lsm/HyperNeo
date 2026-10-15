const ACKNOWLEDGEMENTS = new Set([
  '收到',
  '我收到了',
  '收到了',
  '我听到了',
  '听到了',
  '好的',
  '好',
  '明白',
  '明白了',
  '了解',
  '知道了',
  'ok',
  'okay',
  'gotit',
  'noted',
  'onit',
  'roger',
  'sure',
  'willdo',
  'understood',
  'received',
  'iheardyou',
  'heard',
]);

type Draft = { shortText: string; fullText: string; interim?: true };
type Rejection = { accepted: false; reason: string; detail: string };

export function neoReplyText(text: string): string {
  return text.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
}

export function requirePublicationNews<T>(
  value: T,
  draft: Draft
): { value: T } | { reason: Rejection } {
  const empty = (value: string) => value === '' || ACKNOWLEDGEMENTS.has(value);
  return draft.interim ||
    (empty(neoReplyText(draft.shortText)) && empty(neoReplyText(draft.fullText)))
    ? {
        reason: {
          accepted: false,
          reason: 'no_news',
          detail:
            'Speak when there is something new for the human: a result, a change, something they must do, or something that broke. Acknowledgements and progress updates are not published; end the turn.',
        },
      }
    : { value };
}
