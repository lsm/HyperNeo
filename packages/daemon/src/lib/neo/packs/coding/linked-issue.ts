export function requireCodingLinkedIssue(
  facts: { closingIssuesReferences?: readonly { url: string }[] },
  mirrors: readonly (readonly string[])[]
): string | null {
  const closing = new Set(
    (facts.closingIssuesReferences ?? []).flatMap(({ url }) => {
      const match = url.match(
        /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)\/?$/i
      );
      return match ? [`${match[1]}#${match[2]}`.toLowerCase()] : [];
    })
  );
  const missing = mirrors.find((refs) => !refs.some((ref) => closing.has(ref.toLowerCase())));
  return missing
    ? `linked_issue_required: the PR must close ${missing.join(' or ') || 'its pending tracker item'}.`
    : null;
}
