/**
 * Router Agent - Sandboxed AI for Event Routing Decisions
 *
 * This agent has NO tools, NO filesystem access, NO network access.
 * It is purely for analyzing GitHub events and determining which room
 * should handle them, or if they should go to the inbox.
 *
 * Uses a two-stage approach:
 * 1. Quick rule-based routing (no AI needed for simple cases)
 * 2. AI-based disambiguation for complex multi-room scenarios
 */

import type { GitHubEvent, RoutingResult, SecurityCheckResult } from '@hyperneo/shared';
import type { RoutingClassification } from './prompts/router-prompt';
import { ROUTER_AGENT_SYSTEM_PROMPT } from './prompts/router-prompt';
import { Logger } from '../logger';
import { resolveSDKCliPath, isRunningUnderBun } from '../agent/sdk-cli-resolver';
import { withSdkTranscriptRetention } from '../agent/sdk-transcript-retention';

const logger = new Logger('router-agent');

/**
 * Options for configuring the router agent
 */
export interface RouterAgentOptions {
  /** API key for the AI model */
  apiKey: string;
  /** Credential type so the correct SDK env var is set */
  apiKeyType?: 'api_key' | 'oauth';
  /** Model to use (default: claude-3-5-haiku-latest for speed/cost) */
  model?: string;
  /** Timeout for AI routing in milliseconds (default: 15000) */
  timeout?: number;
}

/**
 * A candidate room for routing
 */
export interface RoomCandidate {
  /** Room ID */
  roomId: string;
  /** Room name for display */
  roomName: string;
  /** Room description for context */
  roomDescription?: string;
  /** Repositories this room is mapped to */
  repositories: string[];
  /** Priority of this mapping (higher = more specific) */
  priority: number;
}

/**
 * Router Agent for determining which room handles incoming GitHub events
 *
 * This is a SANDBOXED agent with no tools, no file access, and no network access.
 * It only analyzes event content and room candidates to make routing decisions.
 */
export class RouterAgent {
  private readonly model: string;
  private readonly timeout: number;

  constructor(private readonly options: RouterAgentOptions) {
    this.model = options.model || 'claude-3-5-haiku-latest';
    this.timeout = options.timeout ?? 15000;
  }

  /**
   * Route an event to a room or inbox
   *
   * Uses a two-stage approach:
   * 1. Quick rule-based routing for simple cases
   * 2. AI-based disambiguation for complex scenarios
   */
  async route(
    event: GitHubEvent,
    candidates: RoomCandidate[],
    securityResult: SecurityCheckResult
  ): Promise<RoutingResult> {
    // If security check failed, reject immediately
    if (!securityResult.passed) {
      return {
        decision: 'reject',
        confidence: 'high',
        reason: `Security check failed: ${securityResult.reason}`,
        securityCheck: securityResult,
      };
    }

    // Stage 1: Quick rule-based routing
    const quickResult = this.quickRoute(event, candidates);
    if (quickResult) {
      logger.debug('Quick routing decision made', {
        decision: quickResult.decision,
        roomId: quickResult.roomId,
      });
      return {
        ...quickResult,
        securityCheck: securityResult,
      };
    }

    // Stage 2: AI-based disambiguation
    try {
      const aiResult = await this.aiRoute(event, candidates);
      return {
        ...aiResult,
        securityCheck: securityResult,
      };
    } catch (error) {
      logger.error('AI routing failed, falling back to inbox', error);
      return {
        decision: 'inbox',
        confidence: 'low',
        reason: 'AI routing failed, sent to inbox for manual triage',
        securityCheck: securityResult,
      };
    }
  }

  /**
   * Quick rule-based routing (no AI needed)
   *
   * Returns null if AI routing is needed for disambiguation.
   */
  private quickRoute(
    event: GitHubEvent,
    candidates: RoomCandidate[]
  ): Omit<RoutingResult, 'securityCheck'> | null {
    // No candidates -> inbox
    if (candidates.length === 0) {
      return {
        decision: 'inbox',
        confidence: 'high',
        reason: 'No room mappings configured for this repository',
      };
    }

    const eventRepo = event.repository.fullName;

    // Find exact repository matches
    const exactMatches = candidates.filter((c) =>
      c.repositories.some((repo) => repo.toLowerCase() === eventRepo.toLowerCase())
    );

    // Single exact match with highest priority -> route immediately
    if (exactMatches.length === 1) {
      return {
        decision: 'route',
        roomId: exactMatches[0].roomId,
        confidence: 'high',
        reason: `Direct repository match: ${eventRepo} -> ${exactMatches[0].roomName}`,
      };
    }

    // Multiple exact matches with same priority -> needs AI disambiguation
    if (exactMatches.length > 1) {
      const topPriority = Math.max(...exactMatches.map((c) => c.priority));
      const topMatches = exactMatches.filter((c) => c.priority === topPriority);

      if (topMatches.length === 1) {
        return {
          decision: 'route',
          roomId: topMatches[0].roomId,
          confidence: 'high',
          reason: `Repository match with highest priority: ${eventRepo} -> ${topMatches[0].roomName}`,
        };
      }

      // Multiple rooms with same priority - need AI
      logger.debug('Multiple rooms with same priority, requires AI disambiguation', {
        rooms: topMatches.map((c) => c.roomName),
        priority: topPriority,
      });
      return null;
    }

    // No exact matches, but have candidates (wildcard or partial matches)
    // Check if any room has wildcard matching
    const wildcardMatches = candidates.filter((c) =>
      c.repositories.some((repo) => repo.includes('*') || repo.includes('?'))
    );

    if (wildcardMatches.length === 1) {
      return {
        decision: 'route',
        roomId: wildcardMatches[0].roomId,
        confidence: 'medium',
        reason: `Wildcard repository match -> ${wildcardMatches[0].roomName}`,
      };
    }

    if (wildcardMatches.length > 1) {
      // Multiple wildcard matches - need AI
      return null;
    }

    // No direct or wildcard matches but have candidates -> inbox
    return {
      decision: 'inbox',
      confidence: 'medium',
      reason: 'No direct repository match found',
    };
  }

  /**
   * Build the routing prompt for AI analysis
   */
  private buildRoutingPrompt(event: GitHubEvent, candidates: RoomCandidate[]): string {
    const eventInfo: string[] = [
      '## Event Details',
      `- Type: ${event.eventType}`,
      `- Action: ${event.action}`,
      `- Repository: ${event.repository.fullName}`,
      `- Sender: ${event.sender.login} (${event.sender.type})`,
    ];

    if (event.issue) {
      eventInfo.push(`- Issue #${event.issue.number}: ${event.issue.title}`);
      if (event.issue.labels.length > 0) {
        eventInfo.push(`- Labels: ${event.issue.labels.join(', ')}`);
      }
      if (event.issue.body) {
        eventInfo.push(
          `- Body: ${event.issue.body.substring(0, 500)}${event.issue.body.length > 500 ? '...' : ''}`
        );
      }
    }

    if (event.comment) {
      eventInfo.push(
        `- Comment: ${event.comment.body.substring(0, 500)}${event.comment.body.length > 500 ? '...' : ''}`
      );
    }

    const roomsInfo: string[] = ['## Available Rooms'];

    for (const candidate of candidates) {
      roomsInfo.push(`\n### ${candidate.roomName} (ID: ${candidate.roomId})`);
      if (candidate.roomDescription) {
        roomsInfo.push(`Description: ${candidate.roomDescription}`);
      }
      roomsInfo.push(`Repositories: ${candidate.repositories.join(', ')}`);
      roomsInfo.push(`Priority: ${candidate.priority}`);
    }

    return `${eventInfo.join('\n')}

${roomsInfo.join('\n')}

## Task
Analyze the event and determine which room should handle it. Respond with valid JSON matching the RoutingClassification schema.`;
  }

  /**
   * AI-based routing for complex disambiguation
   */
  private async aiRoute(
    event: GitHubEvent,
    candidates: RoomCandidate[]
  ): Promise<Omit<RoutingResult, 'securityCheck'>> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    const userPrompt = this.buildRoutingPrompt(event, candidates);

    // Inject the API key into process.env so the SDK subprocess can find it.
    // Use apiKeyType to set only the matching env var.
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    const originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (this.options.apiKeyType === 'oauth') {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = this.options.apiKey;
    } else {
      process.env.ANTHROPIC_API_KEY = this.options.apiKey;
    }

    // Create sandboxed query with NO tools
    let queryObj: ReturnType<typeof query>;
    try {
      queryObj = query({
        prompt: userPrompt,
        options: {
          model: this.model,
          cwd: '/tmp', // Isolated directory - no real workspace access
          maxTurns: 1, // Single response only
          systemPrompt: ROUTER_AGENT_SYSTEM_PROMPT,
          // NO tools array - truly sandboxed
          pathToClaudeCodeExecutable: resolveSDKCliPath(),
          executable: isRunningUnderBun() ? 'bun' : undefined,
          settings: withSdkTranscriptRetention(),
        },
      });
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = originalApiKey;
      }
      if (originalOAuthToken === undefined) {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      } else {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken;
      }
    }

    try {
      // Collect response with timeout
      let responseText = '';
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('AI routing timeout')), this.timeout)
      );

      const collectPromise = (async () => {
        for await (const message of queryObj) {
          if (
            message &&
            typeof message === 'object' &&
            'type' in message &&
            message.type === 'assistant' &&
            'message' in message
          ) {
            const assistantMessage = message as {
              message?: { content?: Array<{ type: string; text?: string }> };
            };
            if (assistantMessage.message?.content) {
              for (const block of assistantMessage.message.content) {
                if (block.type === 'text' && block.text) {
                  responseText += block.text;
                }
              }
            }
          }
        }
        return responseText;
      })();

      const result = await Promise.race([collectPromise, timeoutPromise]);

      // Parse the JSON response
      return this.parseResponse(result, candidates);
    } finally {
      // Always interrupt the query to clean up
      queryObj.interrupt().catch(() => {});
    }
  }

  /**
   * Parse AI response into routing result
   */
  private parseResponse(
    responseText: string,
    candidates: RoomCandidate[]
  ): Omit<RoutingResult, 'securityCheck'> {
    // Try to extract JSON from the response
    let jsonStr = responseText;

    // Extract from code block if present
    const codeBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    // Find JSON object in the text
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    try {
      const parsed = JSON.parse(jsonStr) as RoutingClassification;

      // Validate required fields
      if (!['route', 'inbox', 'reject'].includes(parsed.decision)) {
        throw new Error('Invalid decision value');
      }
      if (!['high', 'medium', 'low'].includes(parsed.confidence)) {
        throw new Error('Invalid confidence value');
      }
      if (typeof parsed.reason !== 'string') {
        throw new Error('Missing or invalid reason');
      }

      // If decision is route, validate roomId exists in candidates
      if (parsed.decision === 'route') {
        if (!parsed.roomId) {
          throw new Error('Route decision requires roomId');
        }
        const validRoom = candidates.find((c) => c.roomId === parsed.roomId);
        if (!validRoom) {
          logger.warn('AI returned invalid roomId, falling back to inbox', {
            roomId: parsed.roomId,
            validRooms: candidates.map((c) => c.roomId),
          });
          return {
            decision: 'inbox',
            confidence: 'low',
            reason: 'AI returned invalid room ID, sent to inbox for triage',
          };
        }
      }

      return {
        decision: parsed.decision,
        roomId: parsed.decision === 'route' ? parsed.roomId! : undefined,
        confidence: parsed.confidence,
        reason: parsed.reason,
      };
    } catch (parseError) {
      logger.warn('Failed to parse AI routing response', {
        error: parseError,
        responseText: responseText.substring(0, 200),
      });

      // Default to inbox on parse failure
      return {
        decision: 'inbox',
        confidence: 'low',
        reason: 'Failed to parse AI routing response, sent to inbox for triage',
      };
    }
  }
}

/**
 * Create a router agent instance
 */
export function createRouterAgent(options: RouterAgentOptions): RouterAgent {
  return new RouterAgent(options);
}
