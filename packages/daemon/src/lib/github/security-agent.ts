/**
 * Security Agent - Sandboxed AI for Prompt Injection Detection
 *
 * This agent has NO tools, NO filesystem access, NO network access.
 * It is purely for text analysis to detect prompt injection attempts
 * in incoming GitHub content.
 *
 * Uses a two-stage approach:
 * 1. Fast pattern-based pre-check (catches obvious attacks)
 * 2. AI-based deep check for suspicious content (catches sophisticated attacks)
 */

import type { SecurityCheckResult } from '@hyperneo/shared';
import type { SecurityClassification } from './prompts/security-prompt';
import { SECURITY_AGENT_SYSTEM_PROMPT } from './prompts/security-prompt';
import { Logger } from '../logger';
import { resolveSDKCliPath, isRunningUnderBun } from '../agent/sdk-cli-resolver';
import { withSdkTranscriptRetention } from '../agent/sdk-transcript-retention';

const logger = new Logger('security-agent');

/**
 * Options for configuring the security agent
 */
export interface SecurityCheckOptions {
  /** API key for the AI model */
  apiKey: string;
  /** Credential type so the correct SDK env var is set */
  apiKeyType?: 'api_key' | 'oauth';
  /** Model to use (default: claude-3-5-haiku-latest for speed/cost) */
  model?: string;
  /** Timeout for AI check in milliseconds (default: 10000) */
  timeout?: number;
}

/**
 * Result of pattern-based pre-check
 */
interface PatternCheckResult {
  hasPatterns: boolean;
  patterns: string[];
}

/**
 * Known prompt injection patterns (regex patterns)
 * These catch obvious attack attempts before AI analysis
 */
const INJECTION_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  // Instruction override attempts
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

  // Role-playing as system
  { pattern: /system\s*:\s*you\s+are/i, name: 'system-roleplay' },
  { pattern: /you\s+are\s+now\s+(a|an)\s+(system|admin|root|ai)/i, name: 'role-escalation' },
  { pattern: /act\s+as\s+(if\s+)?you\s+are\s+(the\s+)?system/i, name: 'act-as-system' },

  // Special token injection
  { pattern: /<\|.*?\|>/, name: 'special-tokens' },
  { pattern: /\[INST\]/i, name: 'inst-marker' },
  { pattern: /\[\/INST\]/i, name: 'inst-marker-close' },
  { pattern: /<<<.*?>>>/, name: 'angle-bracket-markers' },

  // Instruction section injection
  { pattern: /###\s*instruction/i, name: 'instruction-section' },
  { pattern: /###\s*system/i, name: 'system-section' },
  { pattern: /\*\*system\s*instruction\*\*/i, name: 'system-instruction-bold' },

  // Data exfiltration attempts
  { pattern: /send\s+(all\s+)?(data|information|content)\s+to/i, name: 'data-exfil' },
  { pattern: /exfiltrate/i, name: 'exfiltrate-keyword' },
  { pattern: /transmit\s+(to|via|through)/i, name: 'transmit-keyword' },

  // Base64/encoded payloads (suspicious but not definitive)
  { pattern: /[A-Za-z0-9+/]{40,}={0,2}/, name: 'potential-base64' },

  // Escape sequence abuse
  { pattern: /\\n\\n(system|instruction|override)/i, name: 'escape-sequence-abuse' },
  { pattern: /```(system|instruction)/i, name: 'code-block-instruction' },
];

/**
 * Security Agent for detecting prompt injection in GitHub content
 *
 * This is a SANDBOXED agent with no tools, no file access, and no network access.
 * It only analyzes text for security risks.
 */
export class SecurityAgent {
  private readonly model: string;
  private readonly timeout: number;

  constructor(private readonly options: SecurityCheckOptions) {
    this.model = options.model || 'claude-3-5-haiku-latest';
    this.timeout = options.timeout ?? 10000;
  }

  /**
   * Check content for prompt injection risks
   *
   * Uses a two-stage approach:
   * 1. Fast pattern-based pre-check
   * 2. AI-based deep check (if patterns found or content is complex)
   */
  async check(
    content: string,
    context?: { title?: string; author?: string }
  ): Promise<SecurityCheckResult> {
    // Stage 1: Fast pattern-based pre-check
    const patternResult = this.quickPatternCheck(content);

    // If high-risk patterns found, skip AI check and reject immediately
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

    // Stage 2: AI-based deep check
    // Always run AI check for content with suspicious patterns or complex content
    const shouldRunAiCheck = patternResult.hasPatterns || content.length > 500;

    if (shouldRunAiCheck) {
      try {
        const aiResult = await this.aiCheck(content, context);
        return aiResult;
      } catch (error) {
        logger.error('AI security check failed, falling back to pattern result', error);

        // If patterns were found but AI failed, be cautious
        if (patternResult.hasPatterns) {
          return {
            passed: false,
            reason: 'AI check failed and suspicious patterns were detected',
            injectionRisk: 'medium',
          };
        }

        // No patterns and AI failed - allow with low risk
        return {
          passed: true,
          reason: 'No suspicious patterns detected (AI check unavailable)',
          injectionRisk: 'low',
        };
      }
    }

    // No patterns and simple content - safe
    return {
      passed: true,
      reason: 'Content passed pattern check with no issues',
      injectionRisk: 'none',
    };
  }

  /**
   * Fast pattern-based pre-check for obvious injection attempts
   */
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

  /**
   * AI-based deep check for sophisticated injection attempts
   *
   * Uses the SDK directly with NO tools for true sandboxing.
   */
  private async aiCheck(
    content: string,
    context?: { title?: string; author?: string }
  ): Promise<SecurityCheckResult> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    // Build context-aware prompt
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

    // Inject the API key into process.env so the SDK subprocess can find it.
    // The SDK inherits the parent environment; without this, stored credentials
    // that never reached process.env are invisible to the CLI.
    // Use apiKeyType to set only the matching env var (OAuth →
    // CLAUDE_CODE_OAUTH_TOKEN, API key → ANTHROPIC_API_KEY).
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
          systemPrompt: SECURITY_AGENT_SYSTEM_PROMPT,
          // NO tools array - truly sandboxed
          pathToClaudeCodeExecutable: resolveSDKCliPath(),
          executable: isRunningUnderBun() ? 'bun' : undefined,
          settings: withSdkTranscriptRetention(),
        },
      });
    } finally {
      // Restore env immediately after spawn so we don't leak the key globally
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

      // Parse the JSON response
      const classification = this.parseClassification(result);

      return {
        passed: classification.safe && classification.injectionRisk !== 'high',
        reason: classification.reason,
        injectionRisk: classification.injectionRisk,
      };
    } finally {
      // Always interrupt the query to clean up
      queryObj.interrupt().catch(() => {});
    }
  }

  /**
   * Parse AI response into structured classification
   */
  private parseClassification(responseText: string): SecurityClassification {
    // Try to extract JSON from the response
    // AI might wrap JSON in markdown code blocks or add preamble
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
      const parsed = JSON.parse(jsonStr);

      // Validate required fields
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

      // Default to safe-but-review on parse failure
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

/**
 * Create a security agent instance
 */
export function createSecurityAgent(options: SecurityCheckOptions): SecurityAgent {
  return new SecurityAgent(options);
}
