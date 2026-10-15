const PREFIX = 'The human answered: ';
const CITATION = / \(their message [^()]+\)$/;

export function neoAskAnswerEvidence(choice: string, messageId: string | null): string {
  return `${PREFIX}${choice}${messageId ? ` (their message ${messageId})` : ''}`;
}

export function readNeoAskAnswerChoice(evidence: string | null | undefined): string | null {
  return evidence?.startsWith(PREFIX) ? evidence.slice(PREFIX.length).replace(CITATION, '') : null;
}
