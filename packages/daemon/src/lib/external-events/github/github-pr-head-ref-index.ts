/**
 * GitHub pull-request head-ref index maintenance — the two operations that
 * mutate the per-cycle `Map<headRefKey, number[]>` index the `/pulls` polling
 * handler keeps to map each head ref (a `repoPath@headSha` key from
 * {@link file://./github-pr-head-ref.ts} `headRefKey`) to the PR numbers whose
 * HEAD currently points there.
 *
 * Canonical home. These mutators previously lived inline at the bottom of
 * {@link file://./github-event-extension.ts} as
 * `addPullRequestNumberByHeadSha` / `removePullRequestNumberByHeadSha`; that
 * `headSha` name was a misnomer (the map is keyed by the composite head-ref
 * key, not a raw SHA), corrected to `headRef` on extraction. That file now
 * imports them from here.
 *
 * This is a Pattern-B leaf — a composed owner of a mutable invariant — rather
 * than a pure transform: both functions take the index by reference and
 * preserve its invariant. Every value is a deduplicated `number[]`, and no key
 * is left mapping to an empty list (the key is deleted when its last number is
 * removed), so key presence reliably means "at least one open PR points here".
 *
 * Narrow capability surface: {@link addPullRequestNumberByHeadRef} and
 * {@link removePullRequestNumberByHeadRef}. No module-private members.
 */

/**
 * Adds `prNumber` under `headRef`, creating the entry when the key is new and
 * deduping so the index never lists the same PR twice for one head. A brand-new
 * key is seeded with a fresh `number[]` (the index owns its arrays); an existing
 * key's array is appended to in place when the number is not already present.
 */
export function addPullRequestNumberByHeadRef(
  pullRequestNumbersByHeadRef: Map<string, number[]>,
  headRef: string,
  prNumber: number
): void {
  const numbers = pullRequestNumbersByHeadRef.get(headRef) ?? [];
  if (!numbers.includes(prNumber)) numbers.push(prNumber);
  pullRequestNumbersByHeadRef.set(headRef, numbers);
}

/**
 * Removes `prNumber` from under `headRef`. A missing key is a no-op; removing
 * the last number deletes the key outright so the index never carries an empty
 * list. Removing a number that is not present leaves the entry unchanged.
 */
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
