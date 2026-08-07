/**
 * SQLite compatibility layer — runtime-agnostic entry point.
 *
 * Single source of truth for the synchronous SQLite handle used across the
 * daemon's storage layer. All repositories and tests import `Database` from
 * here rather than from `bun:sqlite` / `node:sqlite` directly.
 *
 * The daemon runs under two runtimes during the Bun→Deno migration:
 *   - Bun  (CLI / `make dev` / production binary) — uses `bun:sqlite`.
 *   - Node (Vitest suite, `tsx`, and Deno later) — uses `node:sqlite`.
 *
 * Neither module can be statically imported in a file loaded by BOTH runtimes:
 * `node:sqlite` does not exist under Bun, and `bun:sqlite` does not exist under
 * Node. So this entry cannot statically `import` either; it top-level-`await`s a
 * dynamic `import()` of the right one and re-exports the constructor. The TYPE is
 * sourced (type-only) from the Node wrapper so call-site types are unchanged.
 *
 * - Under Bun: `bun:sqlite`'s native `Database` IS the contract the rest of the
 *   codebase targets (null `get()`, FK-OFF default, nested `transaction()` via
 *   SAVEPOINT, `query`/`run`, `<TRow,TParams>` generics). It is re-exported
 *   directly — no wrapper needed.
 * - Under Node: `./sqlite-node.ts` wraps `node:sqlite`'s `DatabaseSync` to
 *   provide that same contract (see that file for the behavioural notes).
 *
 * No call site uses `instanceof Database`, so a structurally-compatible class
 * substituted per-runtime is safe.
 */

import type { Database as NodeDatabase } from './sqlite-node';

const isBun = typeof Bun !== 'undefined';

// Top-level await: select the runtime-appropriate constructor. The ternary's
// `await import(...)` is only evaluated for the active runtime, so the other
// module (and its missing native import) is never loaded.
const Database: typeof NodeDatabase = isBun
  ? ((await import('bun:sqlite')).Database as unknown as typeof NodeDatabase)
  : (await import('./sqlite-node.ts')).Database;

export { Database };
export type Database = NodeDatabase;

// Preserve the type-only exports the barrel historically exposed (erased at
// runtime — no load of sqlite-node under Bun). `StatementSync` is a value and is
// not re-exported here; nothing outside the Node wrapper imports it.
export type { DatabaseSync, Statement, SqliteDatabase } from './sqlite-node';
