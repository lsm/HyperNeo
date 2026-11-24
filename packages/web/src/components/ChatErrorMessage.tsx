import type { StructuredError } from '../types/error.ts';

export type ChatErrorDetails = Partial<
  Pick<StructuredError, 'title' | 'message' | 'recoverySuggestions'>
>;

const GENERIC_TITLE = /^(?:error(?: report)?|an unexpected error occurred)[.!]?$/i;
const SEPARATOR = /\s+[—–]\s+|:\s+|[.!?](?=\s+\p{Lu})/u;

function messageParts(message: string) {
  const [line = '', next = ''] = message
    .trim()
    .replace(/^Error:\s+/i, '')
    .split(/\s*\r?\n\s*/, 2);
  const codexStart = /^(Could not start Codex CLI) at ("[^"]+")\.\s*(.*)$/.exec(line);
  if (codexStart) {
    const [, title, path, diagnostic] = codexStart;
    const firstDetail = diagnostic.split(/(?<=[.!?])\s+/u, 1)[0];
    const settingsHint = diagnostic.match(/\bCheck the Codex CLI path in Settings[^.]*\.$/)?.[0];
    const cause = [`At ${path}.`, firstDetail, settingsHint === firstDetail ? null : settingsHint]
      .filter(Boolean)
      .join(' ');
    return { title, cause };
  }
  const separator = SEPARATOR.exec(line);
  if (!separator) return { title: line, cause: next };
  const rest = line.slice(separator.index + separator[0].length).trim();
  return { title: line.slice(0, separator.index), cause: rest.split(/(?<=[.!?])\s+/u, 1)[0] };
}

export function ChatErrorMessage({
  message,
  details,
}: {
  message: string;
  details?: ChatErrorDetails;
}) {
  const supplied = messageParts(message);
  const explicitTitle = details?.title?.trim();
  const suggestion = details?.recoverySuggestions?.[0]?.trim();
  const generic = GENERIC_TITLE.test(supplied.title);
  const technical = generic
    ? messageParts(details?.message?.split(/\r?\n/, 1)[0]?.replace(/^\w*Error:\s+/, '') ?? '')
    : undefined;
  const title =
    explicitTitle && !GENERIC_TITLE.test(explicitTitle)
      ? explicitTitle
      : technical?.title || supplied.title;
  const cause = generic
    ? suggestion || technical?.cause || supplied.cause
    : supplied.cause || (supplied.title !== title ? supplied.title : suggestion);

  return (
    <div class="min-w-0 [overflow-wrap:anywhere]">
      <strong class="block font-semibold">{title}</strong>
      {cause && cause !== title && <p class="mt-0.5">{cause}</p>}
    </div>
  );
}

export function isApiErrorText(message: string): boolean {
  return /^\s*(?:Error:\s*)?(?:\*\*)?API Error(?::|\s*\(\d{3}\))/i.test(message);
}

export function TranscriptErrorMessage({
  message,
  log = message,
}: {
  message: string;
  log?: string;
}) {
  return (
    <div class="space-y-2 text-sm text-danger">
      <ChatErrorMessage message={message} />
      <details class="text-xs text-fg-muted">
        <summary class="cursor-pointer">Details</summary>
        <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono">
          {log}
        </pre>
      </details>
    </div>
  );
}
