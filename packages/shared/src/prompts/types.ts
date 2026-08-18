export type PromptTemplateCategory =
  | 'worker_agent'
  | 'lobby_agent'
  | 'security_agent'
  | 'router_agent';

export interface TemplateVariable {
  name: string;
  description: string;
  defaultValue?: string;
  required?: boolean;
}

export interface PromptTemplate {
  id: string;
  category: PromptTemplateCategory;
  name: string;
  description: string;
  template: string;
  variables: TemplateVariable[];
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface RenderedPrompt {
  templateId: string;
  roomId: string;
  content: string;
  renderedWith: Record<string, string>;
  templateVersion: number;
  renderedAt: number;
  customizations?: string;
}

export interface RoomPromptContext {
  roomId: string;
  roomName: string;
  roomDescription?: string;
  backgroundContext?: string;
  allowedPaths: string[];
  defaultPath?: string;
  repositories: string[];
  activeGoals: Array<{ title: string; progress: number; status: string }>;
  currentDate: string;
  customVariables?: Record<string, string>;
}

export const BUILTIN_TEMPLATE_IDS = {
  WORKER_AGENT_SYSTEM: 'worker_agent_system',

  LOBBY_AGENT_ROUTER: 'lobby_agent_router',
  LOBBY_AGENT_SECURITY: 'lobby_agent_security',
} as const;
