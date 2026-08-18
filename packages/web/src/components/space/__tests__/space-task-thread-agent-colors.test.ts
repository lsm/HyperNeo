import { describe, expect, it } from 'vitest';
import { getAgentColor } from '../thread/space-task-thread-agent-colors';

describe('getAgentColor', () => {
  it('returns the correct color for Task Agent', () => {
    expect(getAgentColor('Task Agent')).toBe('#66A7FF');
  });

  it('returns the correct color for Plan Agent', () => {
    expect(getAgentColor('Plan Agent')).toBe('#AD8BFF');
  });

  it('returns the correct color for Coder Agent', () => {
    expect(getAgentColor('Coder Agent')).toBe('#42C7B5');
  });

  it('returns the correct color for Reviewer Agent', () => {
    expect(getAgentColor('Reviewer Agent')).toBe('#F2C66D');
  });

  it('returns the correct color for Space Agent', () => {
    expect(getAgentColor('Space Agent')).toBe('#73C7FF');
  });

  it('returns the correct color for Workflow Agent', () => {
    expect(getAgentColor('Workflow Agent')).toBe('#E794FF');
  });

  it('is case-insensitive for known agent names', () => {
    expect(getAgentColor('task agent')).toBe('#66A7FF');
    expect(getAgentColor('TASK AGENT')).toBe('#66A7FF');
    expect(getAgentColor('CODER AGENT')).toBe('#42C7B5');
    expect(getAgentColor('coder agent')).toBe('#42C7B5');
  });

  it('trims whitespace before matching known agents', () => {
    expect(getAgentColor('  Task Agent  ')).toBe('#66A7FF');
    expect(getAgentColor('\tCoder Agent\t')).toBe('#42C7B5');
  });

  it('returns an HSL fallback for unknown agent labels', () => {
    const color = getAgentColor('Custom Agent');
    expect(color).toMatch(/^hsl\(\d+ 70% 62%\)$/);
  });

  it('returns an HSL fallback for completely unknown labels', () => {
    const color = getAgentColor('My Special Bot');
    expect(color).toMatch(/^hsl\(\d+ 70% 62%\)$/);
  });

  it('returns same color on repeated calls for the same label', () => {
    const color1 = getAgentColor('Task Agent');
    const color2 = getAgentColor('Task Agent');
    expect(color1).toBe(color2);
  });

  it('returns same fallback color on repeated calls for unknown label', () => {
    const label = 'Unknown Bot Alpha';
    const color1 = getAgentColor(label);
    const color2 = getAgentColor(label);
    expect(color1).toBe(color2);
  });

  it('Task Agent and Coder Agent return different colors', () => {
    const taskColor = getAgentColor('Task Agent');
    const coderColor = getAgentColor('Coder Agent');
    expect(taskColor).not.toBe(coderColor);
  });

  it('all 6 known agents have distinct colors', () => {
    const agentLabels = [
      'Task Agent',
      'Plan Agent',
      'Coder Agent',
      'Reviewer Agent',
      'Space Agent',
      'Workflow Agent',
    ];
    const colors = agentLabels.map(getAgentColor);
    const uniqueColors = new Set(colors);
    expect(uniqueColors.size).toBe(6);
  });

  it('two different unknown labels produce different HSL colors', () => {
    const color1 = getAgentColor('Alpha Bot 9999');
    const color2 = getAgentColor('Beta Bot 8888');
    expect(color1).toMatch(/^hsl\(\d+ 70% 62%\)$/);
    expect(color2).toMatch(/^hsl\(\d+ 70% 62%\)$/);
    expect(color1).not.toBe(color2);
  });

  it('returns an HSL fallback (not crash) for empty string', () => {
    const color = getAgentColor('');
    expect(color).toMatch(/^hsl\(\d+ 70% 62%\)$/);
  });

  it('does not throw and returns a string for null input coerced as string', () => {
    const color = getAgentColor(null as unknown as string);
    expect(typeof color).toBe('string');
    expect(color.length).toBeGreaterThan(0);
  });

  it('does not throw and returns a string for undefined input coerced as string', () => {
    const color = getAgentColor(undefined as unknown as string);
    expect(typeof color).toBe('string');
    expect(color.length).toBeGreaterThan(0);
  });
});
