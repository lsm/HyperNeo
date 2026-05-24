type RenderEnv = 'client' | 'server';
type HandoffState = 'pending' | 'complete';

/**
 * Environment detection and state management for SSR/client hydration.
 *
 * This class tracks whether we're running on the server or client,
 * and manages the "handoff" state during hydration to help components
 * know when it's safe to use client-only features.
 */
class Env {
  current: RenderEnv = this.detect();
  handoffState: HandoffState = 'pending';
  currentId = 0;

  /**
   * Set the current environment.
   * Resets handoff state and ID counter when environment changes.
   */
  set(env: RenderEnv): void {
    if (this.current === env) return;

    this.handoffState = 'pending';
    this.currentId = 0;
    this.current = env;
  }

  /**
   * Reset to the detected environment.
   */
  reset(): void {
    this.set(this.detect());
  }

  /**
   * Generate the next unique ID for this environment.
   */
  nextId(): number {
    return ++this.currentId;
  }

  /**
   * True if running on the server.
   */
  get isServer(): boolean {
    return this.current === 'server';
  }

  /**
   * True if running in the browser.
   */
  get isClient(): boolean {
    return this.current === 'client';
  }

  /**
   * Detect the current environment based on window/document availability.
   */
  private detect(): RenderEnv {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return 'server';
    }

    return 'client';
  }

  /**
   * Mark the handoff from server to client as complete.
   * Called after hydration finishes.
   */
  handoff(): void {
    if (this.handoffState === 'pending') {
      this.handoffState = 'complete';
    }
  }

  /**
   * True if the handoff from server to client is complete.
   */
  get isHandoffComplete(): boolean {
    return this.handoffState === 'complete';
  }
}

/**
 * Global environment instance for detecting server vs client context.
 *
 * @example
 * ```ts
 * if (env.isServer) {
 *   // Server-only code
 * }
 *
 * if (env.isClient && env.isHandoffComplete) {
 *   // Safe to use DOM after hydration
 * }
 * ```
 */
export const env = new Env();
