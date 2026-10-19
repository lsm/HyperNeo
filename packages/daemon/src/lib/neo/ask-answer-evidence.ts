const PREFIX = 'The human answered: ';
const OPTION_PREFIX = 'The human answered with option: ';
const CITATION = / \(their message [^()]+\)$/;

function readOptionEvidence(
  evidence: string
): { choice: string; option: string; at: number | null } | null {
  try {
    const value: unknown = JSON.parse(evidence.slice(OPTION_PREFIX.length).replace(CITATION, ''));
    if (!value || typeof value !== 'object') return null;
    const { choice, option, at } = value as Record<string, unknown>;
    return typeof choice === 'string' && typeof option === 'string'
      ? { choice, option, at: typeof at === 'number' && Number.isFinite(at) && at >= 0 ? at : null }
      : null;
  } catch {
    return null;
  }
}

export function readNeoAskAnswerChoice(evidence: string | null | undefined): string | null {
  if (evidence?.startsWith(OPTION_PREFIX)) return readOptionEvidence(evidence)?.choice ?? null;
  return evidence?.startsWith(PREFIX) ? evidence.slice(PREFIX.length).replace(CITATION, '') : null;
}

export function readNeoAskAnswerAt(evidence: string | null | undefined): number | null {
  return evidence?.startsWith(OPTION_PREFIX) ? (readOptionEvidence(evidence)?.at ?? null) : null;
}
