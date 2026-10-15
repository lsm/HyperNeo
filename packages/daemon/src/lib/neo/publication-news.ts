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

const CHECKING_LEAD =
  /^(?:(?:我(?:先|这就|马上|现在)?|先|稍等[，,。\s]*|请稍等[，,。\s]*)(?:去|来)?(?:核对|核实|查|看看|看一下|确认|检查|了解|整理|梳理|汇总)(?![了到过完好])|正在(?:核对|核实|查|看|确认|检查|整理)|稍等|请稍等|let me (?:check|look|see|find|pull|verify|confirm|gather|review)|i(?:'ll| will) (?:check|look|find|pull|verify|confirm|gather|review|get back)|i(?:'m| am) (?:checking|looking|pulling|gathering)|checking|looking into|one moment|give me a (?:moment|sec|second|minute)|hold on)/i;
const CHECKING_MAX_CHARS = 120;

type Draft = { shortText: string; fullText: string };
type Rejection = { accepted: false; reason: string; detail: string };

export function neoReplyText(text: string): string {
  return text.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
}

export function requirePublicationNews<T>(
  value: T,
  draft: Draft
): { value: T } | { reason: Rejection } {
  const empty = (value: string) => value === '' || ACKNOWLEDGEMENTS.has(value);
  if (empty(neoReplyText(draft.shortText)) && empty(neoReplyText(draft.fullText)))
    return {
      reason: {
        accepted: false,
        reason: 'empty_acknowledgement',
        detail:
          'This only acknowledges the message. Publish when you have something to tell the human, or end the turn.',
      },
    };
  const checking = (text: string) =>
    text.length <= CHECKING_MAX_CHARS && CHECKING_LEAD.test(text.trim());
  if (checking(draft.shortText) && checking(draft.fullText))
    return {
      reason: {
        accepted: false,
        reason: 'interim_refused',
        detail:
          'This only says you are about to look. Do the work, then publish the reply itself once, or end the turn.',
      },
    };
  return { value };
}
