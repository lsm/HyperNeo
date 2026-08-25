import type { GitHubEvent, RoutingResult, SecurityCheckResult } from '@hyperneo/shared';
import type { RoutingClassification } from './prompts/router-prompt.ts';
import { ROUTER_AGENT_SYSTEM_PROMPT } from './prompts/router-prompt.ts';
import { Logger } from '../logger.ts';
import { resolveSDKCliPath, isRunningUnderBun } from '../agent/sdk-cli-resolver.ts';
import { withSdkTranscriptRetention } from '../agent/sdk-transcript-retention.ts';
import { buildSdkRuntimeEnv } from '../spawn-env.ts';

const logger = new Logger('router-agent');

export interface RouterAgentOptions {
  apiKey: string;
  apiKeyType?: 'api_key' | 'oauth';
  model?: string;
  timeout?: number;
}

export interface RoomCandidate {
  roomId: string;
  roomName: string;
  roomDescription?: string;
  repositories: string[];
  priority: number;
}

export class RouterAgent {
  private readonly model: string;
  private readonly timeout: number;

  constructor(private readonly options: RouterAgentOptions) {
    this.model = options.model || 'claude-3-5-haiku-latest';
    this.timeout = options.timeout ?? 15000;
  }

  async route(
    event: GitHubEvent,
    candidates: RoomCandidate[],
    securityResult: SecurityCheckResult
  ): Promise<RoutingResult> {
    if (!securityResult.passed) {
      return {
        decision: 'reject',
        confidence: 'high',
        reason: `Security check failed: ${securityResult.reason}`,
        securityCheck: securityResult,
      };
    }

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

  private quickRoute(
    event: GitHubEvent,
    candidates: RoomCandidate[]
  ): Omit<RoutingResult, 'securityCheck'> | null {
    if (candidates.length === 0) {
      return {
        decision: 'inbox',
        confidence: 'high',
        reason: 'No room mappings configured for this repository',
      };
    }

    const eventRepo = event.repository.fullName;

    const exactMatches = candidates.filter((c) =>
      c.repositories.some((repo) => repo.toLowerCase() === eventRepo.toLowerCase())
    );

    if (exactMatches.length === 1) {
      return {
        decision: 'route',
        roomId: exactMatches[0].roomId,
        confidence: 'high',
        reason: `Direct repository match: ${eventRepo} -> ${exactMatches[0].roomName}`,
      };
    }

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

      logger.debug('Multiple rooms with same priority, requires AI disambiguation', {
        rooms: topMatches.map((c) => c.roomName),
        priority: topPriority,
      });
      return null;
    }

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
      return null;
    }

    return {
      decision: 'inbox',
      confidence: 'medium',
      reason: 'No direct repository match found',
    };
  }

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

  private async aiRoute(
    event: GitHubEvent,
    candidates: RoomCandidate[]
  ): Promise<Omit<RoutingResult, 'securityCheck'>> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    const userPrompt = this.buildRoutingPrompt(event, candidates);

    const credentialEnv =
      this.options.apiKeyType === 'oauth'
        ? { CLAUDE_CODE_OAUTH_TOKEN: this.options.apiKey }
        : { ANTHROPIC_API_KEY: this.options.apiKey };

    const queryObj = query({
      prompt: userPrompt,
      options: {
        model: this.model,
        cwd: '/tmp',
        maxTurns: 1,
        systemPrompt: ROUTER_AGENT_SYSTEM_PROMPT,
        pathToClaudeCodeExecutable: resolveSDKCliPath(),
        executable: isRunningUnderBun() ? 'bun' : undefined,
        settings: withSdkTranscriptRetention(),
        env: { ...buildSdkRuntimeEnv(), ...credentialEnv },
      },
    });

    try {
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

      return this.parseResponse(result, candidates);
    } finally {
      queryObj.interrupt().catch(() => {});
    }
  }

  private parseResponse(
    responseText: string,
    candidates: RoomCandidate[]
  ): Omit<RoutingResult, 'securityCheck'> {
    let jsonStr = responseText;

    const codeBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    try {
      const parsed = JSON.parse(jsonStr) as RoutingClassification;

      if (!['route', 'inbox', 'reject'].includes(parsed.decision)) {
        throw new Error('Invalid decision value');
      }
      if (!['high', 'medium', 'low'].includes(parsed.confidence)) {
        throw new Error('Invalid confidence value');
      }
      if (typeof parsed.reason !== 'string') {
        throw new Error('Missing or invalid reason');
      }

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

      return {
        decision: 'inbox',
        confidence: 'low',
        reason: 'Failed to parse AI routing response, sent to inbox for triage',
      };
    }
  }
}

export function createRouterAgent(options: RouterAgentOptions): RouterAgent {
  return new RouterAgent(options);
}
