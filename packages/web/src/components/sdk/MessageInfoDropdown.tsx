import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';

type SystemInitMessage = Extract<SDKMessage, { type: 'system'; subtype: 'init' }>;

const ROOM_AGENT_TOOLS = [
  'room_complete_goal',
  'room_create_task',
  'room_spawn_worker',
  'room_wait_for_review',
  'room_escalate',
  'room_update_goal_progress',
  'room_list_goals',
  'room_list_jobs',
  'room_list_tasks',
  'room_update_prompts',
];

interface Props {
  sessionInfo: SystemInitMessage;
}

export function MessageInfoDropdown({ sessionInfo }: Props) {
  const simplifiedModel = sessionInfo.model.replace('claude-', '').replace('anthropic.', '');

  const isRoomSession = sessionInfo.session_id?.startsWith('room:');
  const displayTools = isRoomSession ? ROOM_AGENT_TOOLS : (sessionInfo.tools ?? []);

  return (
    <div class="w-80 max-h-[60vh] overflow-y-scroll bg-sky-50 dark:bg-sky-900/70 rounded-lg border border-info/40 p-3 space-y-3 shadow-2xl backdrop-blur-sm">
      <div class="flex items-center gap-2 pb-2 border-b border-info/40">
        <svg class="w-4 h-4 text-info" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M13 10V3L4 14h7v7l9-11h-7z"
          />
        </svg>
        <div class="text-sm">
          <span class="font-medium text-info-soft">Session Started</span>
          <span class="text-info ml-2">
            {simplifiedModel} • {sessionInfo.permissionMode}
          </span>
        </div>
      </div>

      {sessionInfo.cwd && (
        <div>
          <div class="text-xs font-medium text-info-soft mb-1">Working Directory</div>
          <div class="font-mono text-xs text-info-soft bg-info/15 rounded px-2 py-1 break-all">
            {sessionInfo.cwd}
          </div>
        </div>
      )}

      {displayTools.length > 0 && (
        <div>
          <div class="text-xs font-medium text-info-soft mb-1">Tools ({displayTools.length})</div>
          <div class="flex flex-wrap gap-1">
            {displayTools.map((tool: string) => (
              <span key={tool} class="px-2 py-0.5 bg-info/15 text-info-soft rounded text-xs">
                {tool}
              </span>
            ))}
          </div>
        </div>
      )}

      {sessionInfo.mcp_servers && sessionInfo.mcp_servers.length > 0 && (
        <div>
          <div class="text-xs font-medium text-info-soft mb-1">
            MCP Servers ({sessionInfo.mcp_servers.length})
          </div>
          <div class="space-y-1">
            {sessionInfo.mcp_servers.map((server: { name: string; status: string }) => (
              <div key={server.name} class="flex items-center gap-2">
                <div
                  class={`w-1.5 h-1.5 rounded-full ${
                    server.status === 'connected' ? 'bg-success' : 'bg-fg-faint'
                  }`}
                  title={server.status}
                />
                <span class="text-xs text-info">{server.name}</span>
                <span class="text-xs text-info">({server.status})</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {sessionInfo.slash_commands && sessionInfo.slash_commands.length > 0 && (
        <div>
          <div class="text-xs font-medium text-info-soft mb-1">
            Slash Commands ({sessionInfo.slash_commands.length})
          </div>
          <div class="flex flex-wrap gap-1">
            {sessionInfo.slash_commands.map((cmd: string) => (
              <span
                key={cmd}
                class="px-2 py-0.5 bg-info/15 text-info-soft rounded text-xs font-mono"
              >
                /{cmd}
              </span>
            ))}
          </div>
        </div>
      )}

      {sessionInfo.agents && sessionInfo.agents.length > 0 && (
        <div>
          <div class="text-xs font-medium text-info-soft mb-1">
            Agents ({sessionInfo.agents.length})
          </div>
          <div class="flex flex-wrap gap-1">
            {sessionInfo.agents.map((agent: string) => (
              <span key={agent} class="px-2 py-0.5 bg-info/15 text-info-soft rounded text-xs">
                {agent}
              </span>
            ))}
          </div>
        </div>
      )}

      <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-info pt-2 border-t border-info/40">
        <div>
          <span class="font-medium">API Key:</span> {sessionInfo.apiKeySource}
        </div>
        <div>
          <span class="font-medium">Output:</span> {sessionInfo.output_style}
        </div>
      </div>
    </div>
  );
}
