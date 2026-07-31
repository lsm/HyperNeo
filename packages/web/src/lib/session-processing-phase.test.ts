/**
 * Tests for session-processing-phase.ts
 *
 * Verifies agent processing states and phases map to the expected tones.
 */

import { describe, expect, it } from 'vitest';
import {
  getAgentProcessingStateClasses,
  getAgentProcessingStateConfig,
  SESSION_PROCESSING_PHASE_CONFIG,
  SESSION_PROCESSING_STATUS_CONFIG,
} from './session-processing-phase.js';

describe('session-processing-phase', () => {
  it('maps idle to neutral', () => {
    expect(SESSION_PROCESSING_STATUS_CONFIG.idle.tone).toBe('neutral');
  });

  it('maps queued to progress', () => {
    expect(SESSION_PROCESSING_STATUS_CONFIG.queued.tone).toBe('progress');
  });

  it('maps waiting_for_input to warning', () => {
    expect(SESSION_PROCESSING_STATUS_CONFIG.waiting_for_input.tone).toBe('warning');
  });

  it('maps rate_limit_cooldown to warning', () => {
    expect(SESSION_PROCESSING_STATUS_CONFIG.rate_limit_cooldown.tone).toBe('warning');
  });

  it('maps interrupted to danger', () => {
    expect(SESSION_PROCESSING_STATUS_CONFIG.interrupted.tone).toBe('danger');
  });

  it('maps initializing phase to progress', () => {
    expect(SESSION_PROCESSING_PHASE_CONFIG.initializing.tone).toBe('progress');
  });

  it('maps thinking phase to info', () => {
    expect(SESSION_PROCESSING_PHASE_CONFIG.thinking.tone).toBe('info');
  });

  it('maps streaming phase to success', () => {
    expect(SESSION_PROCESSING_PHASE_CONFIG.streaming.tone).toBe('success');
  });

  it('maps finalizing phase to special', () => {
    expect(SESSION_PROCESSING_PHASE_CONFIG.finalizing.tone).toBe('special');
  });

  it('resolves processing state to phase config', () => {
    const config = getAgentProcessingStateConfig({
      status: 'processing',
      messageId: 'msg-1',
      phase: 'streaming',
    });
    expect(config.tone).toBe('success');
    expect(config.label).toBe('Streaming');
  });

  it('resolves idle status config', () => {
    const config = getAgentProcessingStateConfig({ status: 'idle' });
    expect(config.tone).toBe('neutral');
    expect(config.label).toBe('Idle');
  });

  it('resolves interrupted status config', () => {
    const config = getAgentProcessingStateConfig({ status: 'interrupted' });
    expect(config.tone).toBe('danger');
  });

  it('returns tone classes from getAgentProcessingStateClasses', () => {
    const classes = getAgentProcessingStateClasses({
      status: 'processing',
      messageId: 'msg-1',
      phase: 'thinking',
    });
    expect(classes.bg).toBe('bg-blue-500');
  });

  it('falls back to the processing config for an unrecognized persisted phase', () => {
    // Persisted processingState JSON is only cast to the union, so an older or
    // unknown phase can reach this code at runtime. It must not throw and must
    // resolve to the generic 'processing' config (parity with the default case
    // in getProcessingPhaseColor).
    const unknown = {
      status: 'processing',
      messageId: 'msg-1',
      phase: 'compacting-legacy',
    } as unknown as Parameters<typeof getAgentProcessingStateConfig>[0];
    const config = getAgentProcessingStateConfig(unknown);
    expect(config.tone).toBe('info');
    expect(config.label).toBe('Processing');
  });

  it('falls back to the idle config for an unrecognized persisted status', () => {
    // Symmetric guard to the phase fallback: an unrecognized persisted status is
    // only filtered by the type at compile time. It must not throw and must
    // resolve to the neutral 'idle' config so getAgentProcessingStateClasses
    // does not NPE on `.tone`.
    const unknown = { status: 'schema-v9-running' } as unknown as Parameters<
      typeof getAgentProcessingStateConfig
    >[0];
    const config = getAgentProcessingStateConfig(unknown);
    expect(config.tone).toBe('neutral');
    expect(config.label).toBe('Idle');
  });
});
