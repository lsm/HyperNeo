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

export function readNeoAskAnswerChoice(evidence: string | null | undefined): string | null {
  if (evidence?.startsWith(OPTION_PREFIX))
    return JSON.parse(evidence.slice(OPTION_PREFIX.length).replace(CITATION, '')).choice;
  return evidence?.startsWith(PREFIX) ? evidence.slice(PREFIX.length).replace(CITATION, '') : null;
}

export function readNeoAskAnswerOption(evidence: string | null | undefined): string | null {
  return evidence?.startsWith(OPTION_PREFIX)
    ? JSON.parse(evidence.slice(OPTION_PREFIX.length).replace(CITATION, '')).option
    : readNeoAskAnswerChoice(evidence);
}
