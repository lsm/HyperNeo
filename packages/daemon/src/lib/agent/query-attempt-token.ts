export interface QueryAttemptToken {
  readonly attemptId: number;
  isLive(): boolean;
}

export class QueryAttemptRegistry {
  private current: QueryAttemptToken | null = null;
  private nextAttemptId = 1;

  static detached(): QueryAttemptToken {
    return { attemptId: 0, isLive: () => false };
  }

  allocate(): QueryAttemptToken {
    const token: QueryAttemptToken = {
      attemptId: this.nextAttemptId++,
      isLive: () => this.current === token,
    };
    this.current = token;
    return token;
  }

  invalidate(token: QueryAttemptToken): boolean {
    if (this.current !== token) return false;
    this.current = null;
    return true;
  }

  invalidateCurrent(): boolean {
    if (this.current === null) return false;
    this.current = null;
    return true;
  }
}
