// @ts-nocheck

import { describe, it, expect } from 'vitest';
import { render, cleanup } from '@testing-library/preact';
import { ErrorOutput, parseErrorOutput, hasErrorOutput } from '../ErrorOutput';

describe('ErrorOutput', () => {
  afterEach(() => {
    cleanup();
  });

  describe('parseErrorOutput', () => {
    it('should extract content from local-command-stderr tags', () => {
      const content = '<local-command-stderr>Error message here</local-command-stderr>';
      const result = parseErrorOutput(content);
      expect(result).toBe('Error message here');
    });

    it('should trim whitespace from extracted content', () => {
      const content = '<local-command-stderr>  Error message  </local-command-stderr>';
      const result = parseErrorOutput(content);
      expect(result).toBe('Error message');
    });

    it('should return null when no stderr tags present', () => {
      const content = 'Just some regular text';
      const result = parseErrorOutput(content);
      expect(result).toBeNull();
    });

    it('should handle multiline content', () => {
      const content = `<local-command-stderr>
Line 1
Line 2
Line 3
</local-command-stderr>`;
      const result = parseErrorOutput(content);
      expect(result).toContain('Line 1');
      expect(result).toContain('Line 2');
      expect(result).toContain('Line 3');
    });

    it('should extract first match when multiple tags present', () => {
      const content =
        '<local-command-stderr>First</local-command-stderr><local-command-stderr>Second</local-command-stderr>';
      const result = parseErrorOutput(content);
      expect(result).toBe('First');
    });
  });

  describe('hasErrorOutput', () => {
    it('should return true when stderr tags are present', () => {
      const content = '<local-command-stderr>Error</local-command-stderr>';
      expect(hasErrorOutput(content)).toBe(true);
    });

    it('should return false when no stderr tags present', () => {
      const content = 'Regular content without errors';
      expect(hasErrorOutput(content)).toBe(false);
    });

    it('should return true for multiline stderr content', () => {
      const content = `<local-command-stderr>
Multi
Line
Error
</local-command-stderr>`;
      expect(hasErrorOutput(content)).toBe(true);
    });

    it('should return false for empty string', () => {
      expect(hasErrorOutput('')).toBe(false);
    });

    it('should return false for partial tags', () => {
      expect(hasErrorOutput('<local-command-stderr>')).toBe(false);
      expect(hasErrorOutput('</local-command-stderr>')).toBe(false);
    });
  });

  describe('ErrorOutput component', () => {
    it('should return null when no error content', () => {
      const { container } = render(<ErrorOutput content="No error here" />);
      expect(container.innerHTML).toBe('');
    });

    it('should render error content when present', () => {
      const content = '<local-command-stderr>Something went wrong</local-command-stderr>';
      const { container } = render(<ErrorOutput content={content} />);

      expect(container.textContent).toContain('Something went wrong');
    });

    it('should render error icon', () => {
      const content = '<local-command-stderr>Error</local-command-stderr>';
      const { container } = render(<ErrorOutput content={content} />);

      const icon = container.querySelector('svg');
      expect(icon).toBeTruthy();
    });

    it('should show "Error" label for non-API errors', () => {
      const content = '<local-command-stderr>Generic error message</local-command-stderr>';
      const { container } = render(<ErrorOutput content={content} />);

      expect(container.textContent).toContain('Error');
    });

    it('should apply custom className', () => {
      const content = '<local-command-stderr>Error</local-command-stderr>';
      const { container } = render(<ErrorOutput content={content} className="custom-class" />);

      const wrapper = container.querySelector('.custom-class');
      expect(wrapper).toBeTruthy();
    });

    it('should have error styling classes', () => {
      const content = '<local-command-stderr>Error</local-command-stderr>';
      const { container } = render(<ErrorOutput content={content} />);

      const errorBox = container.querySelector('.bg-danger\\/40');
      expect(errorBox).toBeTruthy();

      const errorBorder = container.querySelector('.border-danger\\/50');
      expect(errorBorder).toBeTruthy();
    });
  });

  describe('API Error Formatting', () => {
    it('should parse API error with status code', () => {
      const content =
        '<local-command-stderr>Error: 400 {"error":{"type":"invalid_request","message":"Bad request"}}</local-command-stderr>';
      const { container } = render(<ErrorOutput content={content} />);

      expect(container.textContent).toContain('API Error (400)');
      expect(container.textContent).toContain('invalid_request');
      expect(container.textContent).toContain('Bad request');
    });

    it('should parse API error with 500 status', () => {
      const content =
        '<local-command-stderr>Error: 500 {"error":{"type":"server_error","message":"Internal server error"}}</local-command-stderr>';
      const { container } = render(<ErrorOutput content={content} />);

      expect(container.textContent).toContain('API Error (500)');
      expect(container.textContent).toContain('server_error');
    });

    it('should parse plain JSON error', () => {
      const content =
        '<local-command-stderr>{"error":{"type":"authentication_error","message":"Invalid API key"}}</local-command-stderr>';
      const { container } = render(<ErrorOutput content={content} />);

      expect(container.textContent).toContain('authentication_error');
      expect(container.textContent).toContain('Invalid API key');
    });

    it('should parse JSON with top-level message', () => {
      const content =
        '<local-command-stderr>{"type":"rate_limit","message":"Too many requests"}</local-command-stderr>';
      const { container } = render(<ErrorOutput content={content} />);

      expect(container.textContent).toContain('rate_limit');
      expect(container.textContent).toContain('Too many requests');
    });

    it('should handle invalid JSON gracefully', () => {
      const content = '<local-command-stderr>Error: 400 {invalid json here}</local-command-stderr>';
      const { container } = render(<ErrorOutput content={content} />);

      expect(container.textContent).toContain('API Error (400)');
      expect(container.textContent).toContain('{invalid json here}');
    });

    it('should handle JSON without error.message', () => {
      const content = '<local-command-stderr>{"status":"failed","code":123}</local-command-stderr>';
      const { container } = render(<ErrorOutput content={content} />);

      expect(container.textContent).toContain('Error');
      expect(container.textContent).toContain('failed');
    });

    it('should stringify JSON when Error:statusCode format lacks message fields', () => {
      const content =
        '<local-command-stderr>Error: 403 {"status":"forbidden","code":403}</local-command-stderr>';
      const { container } = render(<ErrorOutput content={content} />);

      expect(container.textContent).toContain('API Error (403)');
      expect(container.textContent).toContain('"status"');
      expect(container.textContent).toContain('forbidden');
    });

    it('should show "Error" label when no status code', () => {
      const content =
        '<local-command-stderr>{"error":{"message":"Something failed"}}</local-command-stderr>';
      const { container } = render(<ErrorOutput content={content} />);

      const text = container.textContent || '';
      expect(text).not.toContain('API Error (');
    });

    it('should handle plain text error', () => {
      const content = '<local-command-stderr>Plain text error without JSON</local-command-stderr>';
      const { container } = render(<ErrorOutput content={content} />);

      expect(container.textContent).toContain('Plain text error without JSON');
    });

    it('should use error.type as title when available', () => {
      const content =
        '<local-command-stderr>Error: 429 {"error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}</local-command-stderr>';
      const { container } = render(<ErrorOutput content={content} />);

      expect(container.textContent).toContain('rate_limit_error');
    });

    it('should fallback to "API Error" when no type', () => {
      const content =
        '<local-command-stderr>Error: 400 {"message":"Something happened"}</local-command-stderr>';
      const { container } = render(<ErrorOutput content={content} />);

      expect(container.textContent).toContain('API Error');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty stderr tags', () => {
      const content = '<local-command-stderr></local-command-stderr>';
      const { container } = render(<ErrorOutput content={content} />);

      expect(container.innerHTML).toBe('');
    });

    it('should handle whitespace-only stderr', () => {
      const content = '<local-command-stderr>   </local-command-stderr>';
      const { container } = render(<ErrorOutput content={content} />);

      expect(container.innerHTML).toBe('');
    });

    it('should handle stderr with special characters', () => {
      const content =
        '<local-command-stderr>Error: <script>alert("xss")</script></local-command-stderr>';
      const { container } = render(<ErrorOutput content={content} />);

      expect(container.textContent).toContain('<script>');
    });

    it('should handle stderr with newlines and tabs', () => {
      const content = '<local-command-stderr>Error:\n\tLine 1\n\tLine 2</local-command-stderr>';
      const { container } = render(<ErrorOutput content={content} />);

      expect(container.textContent).toContain('Line 1');
      expect(container.textContent).toContain('Line 2');
    });

    it('should preserve whitespace in error display', () => {
      const content = '<local-command-stderr>Error</local-command-stderr>';
      const { container } = render(<ErrorOutput content={content} />);

      const errorBox = container.querySelector('.whitespace-pre-wrap');
      expect(errorBox).toBeTruthy();
    });
  });
});
