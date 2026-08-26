import type { SecurityCheckResult } from '@hyperneo/shared';
import type { SecurityClassification } from './prompts/security-prompt.ts';
import { SECURITY_AGENT_SYSTEM_PROMPT } from './prompts/security-prompt.ts';
import { Logger } from '../logger.ts';
import { resolveSDKCliPath, isRunningUnderBun } from '../agent/sdk-cli-resolver.ts';
import { withSdkTranscriptRetention } from '../agent/sdk-transcript-retention.ts';
import { buildClassifierSdkEnv } from '../spawn-env.ts';

const logger = new Logger('security-agent');

export interface SecurityCheckOptions {
  apiKey: string;
  apiKeyType?: 'api_key' | 'oauth';
  model?: string;
  timeout?: number;
}

interface PatternCheckResult {
  hasPatterns: boolean;
  patterns: string[];
}

const INJECTION_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  {
    pattern: /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|messages?)/i,
    name: 'ignore-instructions',
  },
  {
    pattern: /disregard\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|messages?)/i,
    name: 'disregard-instructions',
  },
  {
    pattern: /forget\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?)/i,
    name: 'forget-instructions',
  },

  { pattern: /system\s*:\s*you\s+are/i, name: 'system-roleplay' },
  { pattern: /you\s+are\s+now\s+(a|an)\s+(system|admin|root|ai)/i, name: 'role-escalation' },
  { pattern: /act\s+as\s+(if\s+)?you\s+are\s+(the\s+)?system/i, name: 'act-as-system' },

  { pattern: /<\|.*?\|>/, name: 'special-tokens' },
  { pattern: /\[INST\]/i, name: 'inst-marker' },
  { pattern: /\[\/INST\]/i, name: 'inst-marker-close' },
  { pattern: /<<<.*?>>>/, name: 'angle-bracket-markers' },

  { pattern: /###\s*instruction/i, name: 'instruction-section' },
  { pattern: /###\s*system/i, name: 'system-section' },
  { pattern: /\*\*system\s*instruction\*\*/i, name: 'system-instruction-bold' },

  { pattern: /send\s+(all\s+)?(data|information|content)\s+to/i, name: 'data-exfil' },
  { pattern: /exfiltrate/i, name: 'exfiltrate-keyword' },
  { pattern: /transmit\s+(to|via|through)/i, name: 'transmit-keyword' },

  { pattern: /[A-Za-z0-9+/]{40,}={0,2}/, name: 'potential-base64' },

  { pattern: /\\n\\n(system|instruction|override)/i, name: 'escape-sequence-abuse' },
  { pattern: /```(system|instruction)/i, name: 'code-block-instruction' },
];

export class SecurityAgent {
  private readonly model: string;
  private readonly timeout: number;

  constructor(private readonly options: SecurityCheckOptions) {
    this.model = options.model || 'claude-3-5-haiku-latest';
    this.timeout = options.timeout ?? 10000;
  }

  async check(
    content: string,
    context?: { title?: string; author?: string }
  ): Promise<SecurityCheckResult> {
    const patternResult = this.quickPatternCheck(content);

    const highRiskPatterns = [
      'ignore-instructions',
      'disregard-instructions',
      'forget-instructions',
      'system-roleplay',
      'role-escalation',
    ];
    const hasHighRiskPattern = patternResult.patterns.some((p) => highRiskPatterns.includes(p));

    if (hasHighRiskPattern) {
      logger.warn('High-risk injection pattern detected, rejecting immediately', {
        patterns: patternResult.patterns,
        author: context?.author,
      });

      return {
        passed: false,
        reason: `High-risk prompt injection patterns detected: ${patternResult.patterns.join(', ')}`,
        injectionRisk: 'high',
      };
    }

    const shouldRunAiCheck = patternResult.hasPatterns || content.length > 500;

    if (shouldRunAiCheck) {
      try {
        const aiResult = await this.aiCheck(content, context);
        return aiResult;
      } catch (error) {
        logger.error('AI security check failed, falling back to pattern result', error);

        if (patternResult.hasPatterns) {
          return {
            passed: false,
            reason: 'AI check failed and suspicious patterns were detected',
            injectionRisk: 'medium',
          };
        }

        return {
          passed: true,
          reason: 'No suspicious patterns detected (AI check unavailable)',
          injectionRisk: 'low',
        };
      }
    }

    return {
      passed: true,
      reason: 'Content passed pattern check with no issues',
      injectionRisk: 'none',
    };
  }

  private quickPatternCheck(content: string): PatternCheckResult {
    const detectedPatterns: string[] = [];

    for (const { pattern, name } of INJECTION_PATTERNS) {
      if (pattern.test(content)) {
        detectedPatterns.push(name);
      }
    }

    return {
      hasPatterns: detectedPatterns.length > 0,
      patterns: detectedPatterns,
    };
  }

  private async aiCheck(
    content: string,
    context?: { title?: string; author?: string }
  ): Promise<SecurityCheckResult> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    const contextInfo: string[] = [];
    if (context?.title) {
      contextInfo.push(`Title: ${context.title}`);
    }
    if (context?.author) {
      contextInfo.push(`Author: ${context.author}`);
    }

    const userPrompt =
      contextInfo.length > 0
        ? `${contextInfo.join('\n')}\n\nContent to analyze:\n${content}`
        : `Analyze the following content:\n${content}`;

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
        systemPrompt: SECURITY_AGENT_SYSTEM_PROMPT,
        pathToClaudeCodeExecutable: resolveSDKCliPath(),
        executable: isRunningUnderBun() ? 'bun' : undefined,
        settings: withSdkTranscriptRetention(),
        env: { ...buildClassifierSdkEnv(), ...credentialEnv },
      },
    });

    try {
      let responseText = '';
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('AI security check timeout')), this.timeout)
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

      const classification = this.parseClassification(result);

      return {
        passed: classification.safe && classification.injectionRisk !== 'high',
        reason: classification.reason,
        injectionRisk: classification.injectionRisk,
      };
    } finally {
      queryObj.interrupt().catch(() => {});
    }
  }

  private parseClassification(responseText: string): SecurityClassification {
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
      const parsed = JSON.parse(jsonStr);

      if (typeof parsed.safe !== 'boolean') {
        throw new Error('Missing or invalid "safe" field');
      }
      if (!['none', 'low', 'medium', 'high'].includes(parsed.injectionRisk)) {
        throw new Error('Missing or invalid "injectionRisk" field');
      }
      if (typeof parsed.reason !== 'string') {
        throw new Error('Missing or invalid "reason" field');
      }
      if (typeof parsed.requiresHumanReview !== 'boolean') {
        throw new Error('Missing or invalid "requiresHumanReview" field');
      }

      return {
        safe: parsed.safe,
        injectionRisk: parsed.injectionRisk,
        reason: parsed.reason,
        requiresHumanReview: parsed.requiresHumanReview,
        detectedPatterns: parsed.detectedPatterns,
      };
    } catch (parseError) {
      logger.warn('Failed to parse AI classification response', {
        error: parseError,
        responseText: responseText.substring(0, 200),
      });

      return {
        safe: true,
        injectionRisk: 'low',
        reason: 'Failed to parse AI response, defaulting to review required',
        requiresHumanReview: true,
        detectedPatterns: [],
      };
    }
  }
}

export function createSecurityAgent(options: SecurityCheckOptions): SecurityAgent {
  return new SecurityAgent(options);
}
