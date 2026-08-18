import { parseErrorOutput, hasErrorOutput } from '../ErrorOutput';

describe('ErrorOutput', () => {
  describe('hasErrorOutput', () => {
    it('should detect stderr tags in content', () => {
      const content = '<local-command-stderr>Error: 400 {"type":"error"}</local-command-stderr>';
      expect(hasErrorOutput(content)).toBe(true);
    });

    it('should return false for content without stderr tags', () => {
      expect(hasErrorOutput('Hello world')).toBe(false);
      expect(hasErrorOutput('<local-command-stdout>OK</local-command-stdout>')).toBe(false);
    });

    it('should handle multiline stderr content', () => {
      const content = `<local-command-stderr>Error: 400 {
				"type": "error",
				"error": {
					"type": "invalid_request_error",
					"message": "prompt is too long"
				}
			}</local-command-stderr>`;
      expect(hasErrorOutput(content)).toBe(true);
    });

    it('should handle mixed content with stderr', () => {
      const content =
        'Some text before <local-command-stderr>Error</local-command-stderr> and after';
      expect(hasErrorOutput(content)).toBe(true);
    });
  });

  describe('parseErrorOutput', () => {
    it('should extract content from stderr tags', () => {
      const content = '<local-command-stderr>Error: 400 {"type":"error"}</local-command-stderr>';
      expect(parseErrorOutput(content)).toBe('Error: 400 {"type":"error"}');
    });

    it('should return null for content without stderr tags', () => {
      expect(parseErrorOutput('Hello world')).toBe(null);
      expect(parseErrorOutput('<local-command-stdout>OK</local-command-stdout>')).toBe(null);
    });

    it('should trim whitespace from extracted content', () => {
      const content = '<local-command-stderr>  Error: 400  </local-command-stderr>';
      expect(parseErrorOutput(content)).toBe('Error: 400');
    });

    it('should handle complex API error JSON', () => {
      const content = `<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content.0: unexpected \`tool_use_id\` found in \`tool_result\` blocks: toolu_01GuuKwisqkrZK2zgSY4BUSs. Each \`tool_result\` block must have a corresponding \`tool_use\` block in the previous message."},"request_id":"req_011CWvC8ic7WgWQfmEasGh1V"}</local-command-stderr>`;

      const parsed = parseErrorOutput(content);
      expect(parsed).not.toBe(null);
      expect(parsed).toContain('invalid_request_error');
      expect(parsed).toContain('tool_result');
    });

    it('should handle thinking block errors', () => {
      const content = `<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.153.content.0.type: Expected \`thinking\` or \`redacted_thinking\`, but found \`text\`. When \`thinking\` is enabled, a final \`assistant\` message must start with a thinking block."},"request_id":"req_011CWuPJiJorsdkEiphgSECJ"}</local-command-stderr>`;

      const parsed = parseErrorOutput(content);
      expect(parsed).not.toBe(null);
      expect(parsed).toContain('thinking');
      expect(parsed).toContain('invalid_request_error');
    });

    it('should handle connection errors', () => {
      const content = '<local-command-stderr>Error: Connection error.</local-command-stderr>';
      const parsed = parseErrorOutput(content);
      expect(parsed).toBe('Error: Connection error.');
    });

    it('should handle rate limit errors', () => {
      const content =
        '<local-command-stderr>Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}</local-command-stderr>';
      const parsed = parseErrorOutput(content);
      expect(parsed).not.toBe(null);
      expect(parsed).toContain('429');
      expect(parsed).toContain('rate_limit_error');
    });
  });

  describe('real-world error scenarios', () => {
    it('should parse the dead loop error (invalid_request_error with thinking blocks)', () => {
      const content = `<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.153.content.0.type: Expected \`thinking\` or \`redacted_thinking\`, but found \`text\`. When \`thinking\` is enabled, a final \`assistant\` message must start with a thinking block. We recommend you include thinking blocks from previous turns. To avoid this requirement, disable \`thinking\`. Please consult our documentation at https://docs.claude.com/en/docs/build-with-claude/extended-thinking"},"request_id":"req_011CWuPJiJorsdkEiphgSECJ"}</local-command-stderr>`;

      expect(hasErrorOutput(content)).toBe(true);
      const parsed = parseErrorOutput(content);
      expect(parsed).not.toBe(null);
      expect(parsed).toContain('400');
      expect(parsed).toContain('invalid_request_error');
      expect(parsed).toContain('thinking');
    });

    it('should parse tool_use_id mismatch error', () => {
      const content = `<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content.0: unexpected \`tool_use_id\` found in \`tool_result\` blocks: toolu_01GuuKwisqkrZK2zgSY4BUSs. Each \`tool_result\` block must have a corresponding \`tool_use\` block in the previous message."},"request_id":"req_011CWvC8ic7WgWQfmEasGh1V"}</local-command-stderr>`;

      expect(hasErrorOutput(content)).toBe(true);
      const parsed = parseErrorOutput(content);
      expect(parsed).not.toBe(null);
      expect(parsed).toContain('tool_use_id');
      expect(parsed).toContain('tool_result');
    });

    it('should parse prompt too long error', () => {
      const content = `<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 205616 tokens > 200000 maximum"}}</local-command-stderr>`;

      expect(hasErrorOutput(content)).toBe(true);
      const parsed = parseErrorOutput(content);
      expect(parsed).not.toBe(null);
      expect(parsed).toContain('prompt is too long');
      expect(parsed).toContain('205616');
    });
  });
});
