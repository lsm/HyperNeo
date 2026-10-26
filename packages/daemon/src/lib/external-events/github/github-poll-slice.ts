import { parseRateLimitHeaders } from '../../github/poll-source.ts';

export interface GitHubPollResume {
  stage: number;
  item?: string;
  page?: number;
  repo?: string;
  superseded?: string[];
  pending?: number;
  skipFeeds?: boolean;
}

export class GitHubPollSlice {
  private requests = 0;
  private limit = 64;
  next?: GitHubPollResume;

  constructor(
    readonly start: GitHubPollResume | undefined,
    private readonly reposRemaining = 1
  ) {}

  starts(stage: number): boolean {
    if (stage < 3 && (this.start?.stage ?? 0) >= 3) return !this.start?.skipFeeds;
    return stage >= (this.start?.stage ?? 0);
  }

  items<T>(stage: number, items: T[], key: (item: T) => string): T[] {
    if (!this.starts(stage)) return [];
    const resume = this.start;
    const index =
      resume?.stage === stage ? items.findIndex((item) => key(item) === resume.item) : 0;
    return items.slice(Math.max(0, index));
  }

  repos(item: string, repos: string[]): string[] {
    const resume = this.start;
    const index =
      resume?.stage === 3 && resume.item === item ? repos.indexOf(resume.repo ?? '') : 0;
    return repos.slice(Math.max(0, index));
  }

  page(stage: number, item: string, repo?: string): number {
    const resume = this.start;
    return resume?.stage === stage && resume.item === item && resume.repo === repo
      ? (resume.page ?? 1)
      : 1;
  }

  take(position: GitHubPollResume): boolean {
    if (this.requests >= this.limit) {
      this.next =
        position.stage < 3 && (this.start?.stage ?? 0) >= 3
          ? { ...this.start!, skipFeeds: true }
          : position;
      return false;
    }
    this.requests++;
    return true;
  }

  observe(response: Response): void {
    if (this.requests !== 1) return;
    const { remaining } = parseRateLimitHeaders(response);
    if (!Number.isFinite(remaining)) return;
    this.limit = Math.min(
      this.limit,
      1 + Math.max(0, Math.floor((remaining - 10) / this.reposRemaining))
    );
  }
}
