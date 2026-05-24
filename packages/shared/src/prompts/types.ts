/**
 * Prompt Template Types
 *
 * Defines the structure for centralized prompt templates that can be:
 * - Stored centrally in packages/shared for easy management
 * - Rendered per-room at creation time
 * - Self-updated by room agents when patterns are discovered
 */

/**
 * Available prompt template categories
 */
export type PromptTemplateCategory =
  | 'worker_agent' // Worker agent prompts
  | 'lobby_agent' // External message processing prompts
  | 'security_agent' // Security checking prompts
  | 'router_agent'; // Routing decision prompts

/**
 * Template variable that can be substituted
 */
export interface TemplateVariable {
  name: string;
  description: string;
  defaultValue?: string;
  required?: boolean;
}

/**
 * A prompt template definition
 */
export interface PromptTemplate {
  /** Unique identifier for this template */
  id: string;
  /** Category for organization */
  category: PromptTemplateCategory;
  /** Human-readable name */
  name: string;
  /** Description of when to use this prompt */
  description: string;
  /** The template content with {{variable}} placeholders */
  template: string;
  /** Variables that can be substituted */
  variables: TemplateVariable[];
  /** Version for tracking updates */
  version: number;
  /** When this template was created */
  createdAt: number;
  /** When this template was last updated */
  updatedAt: number;
}

/**
 * Rendered prompt for a specific room
 */
export interface RenderedPrompt {
  /** ID of the template this was rendered from */
  templateId: string;
  /** Room ID this prompt belongs to */
  roomId: string;
  /** The rendered content */
  content: string;
  /** Variables used for rendering */
  renderedWith: Record<string, string>;
  /** Version of template at render time */
  templateVersion: number;
  /** When this was rendered */
  renderedAt: number;
  /** Customizations made by room agent */
  customizations?: string;
}

/**
 * Room prompt context — variables available for template rendering
 */
export interface RoomPromptContext {
  /** Room ID */
  roomId: string;
  /** Room name */
  roomName: string;
  /** Room description */
  roomDescription?: string;
  /** Background context for the room */
  backgroundContext?: string;
  /** Allowed paths for file operations */
  allowedPaths: string[];
  /** Default workspace path */
  defaultPath?: string;
  /** Repository mappings (owner/repo format) */
  repositories: string[];
  /** Active goals for the room */
  activeGoals: Array<{ title: string; progress: number; status: string }>;
  /** Current date/time */
  currentDate: string;
  /** Any custom variables */
  customVariables?: Record<string, string>;
}

/**
 * Built-in template IDs
 */
export const BUILTIN_TEMPLATE_IDS = {
  // Worker Agent prompts
  WORKER_AGENT_SYSTEM: 'worker_agent_system',

  // Lobby Agent prompts
  LOBBY_AGENT_ROUTER: 'lobby_agent_router',
  LOBBY_AGENT_SECURITY: 'lobby_agent_security',
} as const;
