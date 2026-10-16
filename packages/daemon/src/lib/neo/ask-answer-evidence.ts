const PREFIX = 'The human answered: ';
const OPTION_PREFIX = 'The human answered with option: ';
const CITATION = / \(their message [^()]+\)$/;

export function neoAskAnswerEvidence(
  choice: string,
  messageId: string | null,
  option?: string
): string {
  return `${option ? OPTION_PREFIX + JSON.stringify({ choice, option }) : PREFIX + choice}${messageId ? ` (their message ${messageId})` : ''}`;
}

function readOptionEvidence(evidence: string): { choice: string; option: string } | null {
  try {
    const value: unknown = JSON.parse(evidence.slice(OPTION_PREFIX.length).replace(CITATION, ''));
    if (!value || typeof value !== 'object') return null;
    const { choice, option } = value as Record<string, unknown>;
    return typeof choice === 'string' && typeof option === 'string' ? { choice, option } : null;
  } catch {
    return null;
  }
}

export function readNeoAskAnswerChoice(evidence: string | null | undefined): string | null {
  if (evidence?.startsWith(OPTION_PREFIX)) return readOptionEvidence(evidence)?.choice ?? null;
  return evidence?.startsWith(PREFIX) ? evidence.slice(PREFIX.length).replace(CITATION, '') : null;
}

export function readNeoAskAnswerOption(evidence: string | null | undefined): string | null {
  return evidence?.startsWith(OPTION_PREFIX)
    ? (readOptionEvidence(evidence)?.option ?? null)
    : readNeoAskAnswerChoice(evidence);
}
