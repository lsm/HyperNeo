import type { NamedQuery } from '../types.ts';
import { mapActiveTurnEntryRow } from '../../rpc-handlers/activity-preview.ts';
import { buildTaskScopeFilter } from '../queries/task-delivery.ts';
import {
  DEBOUNCE_SPACE_TASK_FEEDS_MS,
  SPACE_TASK_MESSAGES_BY_TASK_SQL,
  mapSpaceTaskMessageRow,
} from './task-messages.ts';
import { SPACE_TASK_MESSAGES_BY_TASK_COMPACT_SQL } from './compact-task-messages.ts';
import { SPACE_TASK_ACTIVE_TURN_ENTRIES_BY_TASK_SQL } from './task-active-turn.ts';

export const SPACE_LIVE_QUERIES: Record<string, NamedQuery> = {
  'spaceTaskMessages.byTask': {
    sql: SPACE_TASK_MESSAGES_BY_TASK_SQL,
    paramCount: 1,
    debounceMs: DEBOUNCE_SPACE_TASK_FEEDS_MS,
    mapRow: mapSpaceTaskMessageRow,
    buildScopeFilter: buildTaskScopeFilter,
  },
  'spaceTaskMessages.byTask.compact': {
    sql: SPACE_TASK_MESSAGES_BY_TASK_COMPACT_SQL,
    paramCount: 2,
    debounceMs: DEBOUNCE_SPACE_TASK_FEEDS_MS,
    mapRow: mapSpaceTaskMessageRow,
    buildScopeFilter: buildTaskScopeFilter,
  },
  'spaceTaskActiveTurn.byTask': {
    sql: SPACE_TASK_ACTIVE_TURN_ENTRIES_BY_TASK_SQL,
    paramCount: 1,
    debounceMs: DEBOUNCE_SPACE_TASK_FEEDS_MS,
    mapRow: mapActiveTurnEntryRow,
    buildScopeFilter: buildTaskScopeFilter,
  },
};
