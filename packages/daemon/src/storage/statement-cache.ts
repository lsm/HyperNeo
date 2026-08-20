export const STATEMENT_CACHE_CAPACITY = 500;

export class StatementCache<T> {
  private readonly statements = new Map<string, T>();

  constructor(private readonly capacity: number) {}

  get(sql: string): T | undefined {
    return this.statements.get(sql);
  }

  set(sql: string, statement: T): void {
    if (this.statements.size >= this.capacity) {
      const oldest = this.statements.keys().next().value;
      if (oldest !== undefined) {
        this.statements.delete(oldest);
      }
    }
    this.statements.set(sql, statement);
  }

  clear(): void {
    this.statements.clear();
  }
}
