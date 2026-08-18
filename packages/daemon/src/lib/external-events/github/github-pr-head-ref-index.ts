export function addPullRequestNumberByHeadRef(
  pullRequestNumbersByHeadRef: Map<string, number[]>,
  headRef: string,
  prNumber: number
): void {
  const numbers = pullRequestNumbersByHeadRef.get(headRef) ?? [];
  if (!numbers.includes(prNumber)) numbers.push(prNumber);
  pullRequestNumbersByHeadRef.set(headRef, numbers);
}

export function removePullRequestNumberByHeadRef(
  pullRequestNumbersByHeadRef: Map<string, number[]>,
  headRef: string,
  prNumber: number
): void {
  const numbers = pullRequestNumbersByHeadRef.get(headRef);
  if (!numbers) return;
  const next = numbers.filter((number) => number !== prNumber);
  if (next.length > 0) {
    pullRequestNumbersByHeadRef.set(headRef, next);
  } else {
    pullRequestNumbersByHeadRef.delete(headRef);
  }
}
