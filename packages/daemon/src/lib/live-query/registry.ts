import type { NamedQuery } from './types.ts';
import { mayChangeSessionList } from '../../storage/repositories/session-list-live-read.ts';
import {
  SESSION_GROUP_MESSAGES_BY_GROUP_SQL,
  DEBOUNCE_SESSION_GROUP_MESSAGES_MS,
  mapSessionGroupMessageRow,
} from './queries/session-groups.ts';
import {
  SPACE_TASK_ACTIVITY_BY_TASK_SQL,
  mapSpaceTaskActivityRow,
  NODE_EXECUTIONS_BY_RUN_SQL,
} from './queries/task-activity.ts';
import {
  DEBOUNCE_SPACE_TASK_FEEDS_MS,
  SPACE_TASK_MESSAGES_BY_TASK_SQL,
  mapSpaceTaskMessageRow,
} from './queries/task-messages.ts';
import { buildTaskScopeFilter } from './queries/task-delivery.ts';
import { SPACE_TASK_MESSAGES_BY_TASK_COMPACT_SQL } from './queries/compact-task-messages.ts';
import { SPACE_TASK_ACTIVE_TURN_ENTRIES_BY_TASK_SQL } from './queries/task-active-turn.ts';
import { mapActiveTurnEntryRow } from '../rpc-handlers/activity-preview.ts';
import {
  MCP_SERVERS_GLOBAL_SQL,
  mapMcpServerRow,
  SKILLS_LIST_SQL,
  mapSkillRow,
  MCP_ENABLEMENT_BY_SPACE_SQL,
  mapMcpEnablementBySpaceRow,
} from './queries/settings.ts';
import {
  SPACE_WORKSPACES_BY_SPACE_SQL,
  mapSpaceWorkspaceRow,
  buildSpaceWorkspacesScopeFilter,
} from './queries/workspaces.ts';
import {
  SPACE_SESSIONS_BY_SPACE_SQL,
  DEBOUNCE_SPACE_SESSIONS_MS,
  mapSpaceSessionRow,
  buildSpaceSessionsScopeFilter,
  SESSIONS_LIST_SQL,
  DEBOUNCE_SESSION_LIST_MS,
  mapSessionRow,
} from './queries/sessions.ts';
import {
  MESSAGES_BY_SESSION_SQL,
  messageRowFingerprint,
  DEBOUNCE_SDK_MESSAGES_MS,
  mapMessageRow,
  mapThinMessageRow,
} from './queries/messages.ts';
import { expandSessionMessages } from './queries/message-children.ts';

export const NAMED_QUERY_REGISTRY = new Map<string, NamedQuery>([
  [
    'sessionGroupMessages.byGroup',
    {
      sql: SESSION_GROUP_MESSAGES_BY_GROUP_SQL,
      paramCount: 1,
      debounceMs: DEBOUNCE_SESSION_GROUP_MESSAGES_MS,
      mapRow: mapSessionGroupMessageRow,
      buildScopeFilter: (params, db) => {
        const groupId = params[0] as string;
        const stmt = db.prepare(
          'SELECT 1 FROM session_group_members WHERE group_id = ? AND session_id = ? LIMIT 1'
        );
        return (scope) => {
          if (!scope.sessionId) return true;
          return !!stmt.get(groupId, scope.sessionId);
        };
      },
    },
  ],
  [
    'spaceTaskActivity.byTask',
    {
      sql: SPACE_TASK_ACTIVITY_BY_TASK_SQL,
      paramCount: 1,
      debounceMs: DEBOUNCE_SPACE_TASK_FEEDS_MS,
      mapRow: mapSpaceTaskActivityRow,
      buildScopeFilter: buildTaskScopeFilter,
    },
  ],
  [
    'spaceTaskMessages.byTask',
    {
      sql: SPACE_TASK_MESSAGES_BY_TASK_SQL,
      paramCount: 1,
      debounceMs: DEBOUNCE_SPACE_TASK_FEEDS_MS,
      mapRow: mapSpaceTaskMessageRow,
      buildScopeFilter: buildTaskScopeFilter,
    },
  ],
  [
    'spaceTaskMessages.byTask.compact',
    {
      sql: SPACE_TASK_MESSAGES_BY_TASK_COMPACT_SQL,
      paramCount: 2,
      debounceMs: DEBOUNCE_SPACE_TASK_FEEDS_MS,
      mapRow: mapSpaceTaskMessageRow,
      buildScopeFilter: buildTaskScopeFilter,
    },
  ],
  [
    'spaceTaskActiveTurn.byTask',
    {
      sql: SPACE_TASK_ACTIVE_TURN_ENTRIES_BY_TASK_SQL,
      paramCount: 1,
      debounceMs: DEBOUNCE_SPACE_TASK_FEEDS_MS,
      mapRow: mapActiveTurnEntryRow,
      buildScopeFilter: buildTaskScopeFilter,
    },
  ],
  [
    'mcpServers.global',
    {
      sql: MCP_SERVERS_GLOBAL_SQL,
      paramCount: 0,
      mapRow: mapMcpServerRow,
    },
  ],
  [
    'skills.list',
    {
      sql: SKILLS_LIST_SQL,
      paramCount: 0,
      mapRow: mapSkillRow,
    },
  ],
  [
    'mcpEnablement.bySpace',
    {
      sql: MCP_ENABLEMENT_BY_SPACE_SQL,
      paramCount: 1,
      mapRow: mapMcpEnablementBySpaceRow,
    },
  ],
  [
    'spaceWorkspaces.bySpace',
    {
      sql: SPACE_WORKSPACES_BY_SPACE_SQL,
      paramCount: 1,
      mapRow: mapSpaceWorkspaceRow,
      buildScopeFilter: buildSpaceWorkspacesScopeFilter,
    },
  ],
  [
    'nodeExecutions.byRun',
    {
      sql: NODE_EXECUTIONS_BY_RUN_SQL,
      paramCount: 1,
    },
  ],
  [
    'spaceSessions.bySpace',
    {
      sql: SPACE_SESSIONS_BY_SPACE_SQL,
      paramCount: 1,
      debounceMs: DEBOUNCE_SPACE_SESSIONS_MS,
      mapRow: mapSpaceSessionRow,
      buildScopeFilter: buildSpaceSessionsScopeFilter,
    },
  ],
  [
    'messages.bySession',
    {
      sql: MESSAGES_BY_SESSION_SQL,
      expandRows: expandSessionMessages,
      paramCount: 2,
      debounceMs: DEBOUNCE_SDK_MESSAGES_MS,
      mapRow: mapMessageRow,
      buildScopeFilter: (params) => {
        const targetSessionId = params[0] as string;
        return (scope) => {
          if (!scope.sessionId) return true;
          return scope.sessionId === targetSessionId;
        };
      },
      rowFingerprint: messageRowFingerprint,
    },
  ],
  [
    'sessions.list',
    {
      sql: SESSIONS_LIST_SQL,
      paramCount: 1,
      debounceMs: DEBOUNCE_SESSION_LIST_MS,
      mapRow: mapSessionRow,
      buildScopeFilter: () => mayChangeSessionList,
    },
  ],
]);

NAMED_QUERY_REGISTRY.set('messages.bySession.compact', {
  ...NAMED_QUERY_REGISTRY.get('messages.bySession')!,
  sql: `-- thin feed: its own engine entry, so metadata is not shared
${MESSAGES_BY_SESSION_SQL}`,
  mapRow: mapThinMessageRow,
});
