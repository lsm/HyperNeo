export interface ArtifactPrSummary {
  readonly url: string;
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'OPEN' | 'MERGED' | 'CLOSED';
  readonly headSha: string;
  readonly checks: 'pending' | 'failing' | 'passing' | 'none';
  readonly review: 'approved' | 'changes_requested' | 'none';
  readonly changedFiles: number;
  readonly files: readonly { path: string; additions: number; deletions: number }[];
  readonly filesTruncated: boolean;
}
