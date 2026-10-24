export const COMPILED_WORKER_ENTRYPOINTS = [
  'packages/daemon/src/lib/db-query/db-query-worker.ts',
  'packages/daemon/src/lib/event-loop-watchdog-worker.ts',
  'packages/daemon/src/lib/message-search-merge-worker.ts',
  'packages/daemon/src/lib/message-search-worker.ts',
  'packages/daemon/src/lib/neo/project-mirror-worker.ts',
  'packages/daemon/src/storage/db-gateway/db-gateway-worker.ts',
  'packages/daemon/src/storage/repositories/agent-memory-embed-worker.ts',
  'packages/daemon/src/storage/sdk-message-body-admission-worker.ts',
  'packages/daemon/src/storage/sdk-message-body-backup-worker.ts',
  'packages/daemon/src/storage/sdk-status-worker.ts',
];

if (import.meta.main) process.stdout.write(COMPILED_WORKER_ENTRYPOINTS.join(' '));
