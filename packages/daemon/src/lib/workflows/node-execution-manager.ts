import type { NodeExecutionStatus } from '@hyperneo/shared';

export const TERMINAL_NODE_EXECUTION_STATUSES = new Set<NodeExecutionStatus>(['idle', 'cancelled']);
