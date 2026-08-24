import { AsyncLocalStorage } from 'node:async_hooks';

export type ProviderEnvRole = 'owner' | 'reader';

export interface ProviderEnvLeaseToken {
  readonly id: number;
  readonly enrolledAs: string;
}

interface LeaseState {
  token: ProviderEnvLeaseToken;
  depth: number;
}

interface LeaseWaiter {
  name: string;
  resolve: (token: ProviderEnvLeaseToken) => void;
}

export class ProviderEnvCoordinator {
  private readonly roles = new Map<string, ProviderEnvRole>();
  private readonly context = new AsyncLocalStorage<ProviderEnvLeaseToken>();
  private current: LeaseState | null = null;
  private readonly queue: LeaseWaiter[] = [];
  private nextId = 1;

  registerOwner(name: string): void {
    this.enroll(name, 'owner');
  }

  registerReader(name: string): void {
    this.enroll(name, 'reader');
  }

  roleOf(name: string): ProviderEnvRole | null {
    return this.roles.get(name) ?? null;
  }

  isLeaseHeld(): boolean {
    return this.current !== null;
  }

  activeHolder(): ProviderEnvLeaseToken | null {
    const token = this.current?.token ?? null;
    return token ? { id: token.id, enrolledAs: token.enrolledAs } : null;
  }

  async acquire(
    name: string,
    holder?: ProviderEnvLeaseToken | null
  ): Promise<ProviderEnvLeaseToken> {
    this.assertEnrolled(name);
    const propagated = holder ?? this.context.getStore() ?? null;
    if (propagated) {
      if (!this.current || this.current.token !== propagated) {
        throw new Error(`provider-env-coordinator: stale lease token #${propagated.id}`);
      }
      this.current.depth += 1;
      return this.current.token;
    }
    if (!this.current) {
      return this.admit(name);
    }
    return new Promise((resolve) => this.queue.push({ name, resolve }));
  }

  release(token: ProviderEnvLeaseToken): void {
    if (!this.current || this.current.token !== token) {
      throw new Error(`provider-env-coordinator: release by non-holder token #${token.id}`);
    }
    this.current.depth -= 1;
    if (this.current.depth > 0) {
      return;
    }
    const next = this.queue.shift() ?? null;
    this.current = null;
    if (next) {
      next.resolve(this.admit(next.name));
    }
  }

  async runWithLease<T>(
    name: string,
    fn: (token: ProviderEnvLeaseToken) => T | Promise<T>
  ): Promise<T> {
    const token = await this.acquire(name);
    return this.context.run(token, async () => {
      try {
        return await fn(token);
      } finally {
        this.release(token);
      }
    });
  }

  private enroll(name: string, role: ProviderEnvRole): void {
    const existing = this.roles.get(name);
    if (existing) {
      throw new Error(`provider-env-coordinator: '${name}' already enrolled as ${existing}`);
    }
    this.roles.set(name, role);
  }

  private assertEnrolled(name: string): void {
    if (!this.roles.has(name)) {
      throw new Error(`provider-env-coordinator: '${name}' is not enrolled`);
    }
  }

  private admit(name: string): ProviderEnvLeaseToken {
    const token: ProviderEnvLeaseToken = { id: this.nextId, enrolledAs: name };
    this.nextId += 1;
    this.current = { token, depth: 1 };
    return token;
  }
}
