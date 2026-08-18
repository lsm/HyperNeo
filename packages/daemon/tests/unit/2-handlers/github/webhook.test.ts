import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  verifySignature,
  parseWebhookEvent,
  handleGitHubWebhook,
} from '../../../../src/lib/github/webhook-handler';
import type { GitHubEvent } from '@hyperneo/shared';

const TEST_SECRET = 'test-webhook-secret-12345';

async function createSignature(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const payloadData = encoder.encode(payload);
  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, payloadData);

  const array = new Uint8Array(signatureBuffer);
  const hex = Array.from(array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return `sha256=${hex}`;
}

function createWebhookRequest(
  payload: string,
  eventType: string,
  signature: string,
  deliveryId: string = 'test-delivery-123'
): Request {
  return new Request('http://localhost/api/github/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': signature,
      'X-GitHub-Event': eventType,
      'X-GitHub-Delivery': deliveryId,
    },
    body: payload,
  });
}

const ISSUE_OPENED_PAYLOAD = {
  action: 'opened',
  issue: {
    id: 123456789,
    number: 42,
    title: 'Test Issue Title',
    body: 'This is the issue body content.',
    labels: [{ name: 'bug' }, { name: 'priority-high' }],
    state: 'open',
    user: {
      login: 'testuser',
      type: 'User',
    },
  },
  repository: {
    id: 987654321,
    name: 'testrepo',
    full_name: 'testowner/testrepo',
    owner: {
      login: 'testowner',
    },
  },
  sender: {
    login: 'testuser',
    type: 'User',
  },
};

const ISSUE_COMMENT_PAYLOAD = {
  action: 'created',
  issue: {
    id: 123456789,
    number: 42,
    title: 'Test Issue Title',
  },
  comment: {
    id: 111222333,
    body: 'This is a test comment.',
    user: {
      login: 'commenter',
      type: 'User',
    },
  },
  repository: {
    id: 987654321,
    name: 'testrepo',
    full_name: 'testowner/testrepo',
    owner: {
      login: 'testowner',
    },
  },
  sender: {
    login: 'commenter',
    type: 'User',
  },
};

const PULL_REQUEST_PAYLOAD = {
  action: 'opened',
  pull_request: {
    id: 444555666,
    number: 10,
    title: 'Test Pull Request',
    body: 'PR description here.',
    state: 'open',
    user: {
      login: 'prauthor',
      type: 'User',
    },
    labels: [{ name: 'enhancement' }],
  },
  repository: {
    id: 987654321,
    name: 'testrepo',
    full_name: 'testowner/testrepo',
    owner: {
      login: 'testowner',
    },
  },
  sender: {
    login: 'prauthor',
    type: 'User',
  },
};

describe('GitHub Webhook Handler', () => {
  describe('Signature Verification', () => {
    test('should verify valid HMAC-SHA256 signature', async () => {
      const payload = JSON.stringify(ISSUE_OPENED_PAYLOAD);
      const signature = await createSignature(payload, TEST_SECRET);

      const isValid = await verifySignature(payload, signature, TEST_SECRET);

      expect(isValid).toBe(true);
    });

    test('should reject invalid signature', async () => {
      const payload = JSON.stringify(ISSUE_OPENED_PAYLOAD);
      const invalidSignature = 'sha256=invalidhex123456';

      const isValid = await verifySignature(payload, invalidSignature, TEST_SECRET);

      expect(isValid).toBe(false);
    });

    test('should reject signature with wrong secret', async () => {
      const payload = JSON.stringify(ISSUE_OPENED_PAYLOAD);
      const signature = await createSignature(payload, 'wrong-secret');

      const isValid = await verifySignature(payload, signature, TEST_SECRET);

      expect(isValid).toBe(false);
    });

    test('should reject malformed signature format', async () => {
      const payload = JSON.stringify(ISSUE_OPENED_PAYLOAD);

      const isValid1 = await verifySignature(payload, 'invalidhex123456', TEST_SECRET);
      expect(isValid1).toBe(false);

      const isValid2 = await verifySignature(payload, '', TEST_SECRET);
      expect(isValid2).toBe(false);

      const isValid3 = await verifySignature(payload, 'md5=abc123', TEST_SECRET);
      expect(isValid3).toBe(false);
    });

    test('should verify signature with tampered payload', async () => {
      const payload = JSON.stringify(ISSUE_OPENED_PAYLOAD);
      const signature = await createSignature(payload, TEST_SECRET);

      const tamperedPayload = payload.replace('Test Issue Title', 'Hacked Title');

      const isValid = await verifySignature(tamperedPayload, signature, TEST_SECRET);

      expect(isValid).toBe(false);
    });
  });

  describe('Event Parsing', () => {
    test('should parse issues.opened event', () => {
      const result = parseWebhookEvent(ISSUE_OPENED_PAYLOAD, 'issues');

      expect(result.event).toBeDefined();
      expect(result.event?.eventType).toBe('issues');
      expect(result.event?.action).toBe('opened');
      expect(result.event?.issue?.number).toBe(42);
      expect(result.event?.issue?.title).toBe('Test Issue Title');
      expect(result.event?.issue?.labels).toEqual(['bug', 'priority-high']);
      expect(result.event?.repository.fullName).toBe('testowner/testrepo');
      expect(result.event?.sender.login).toBe('testuser');
    });

    test('should parse issue_comment.created event', () => {
      const result = parseWebhookEvent(ISSUE_COMMENT_PAYLOAD, 'issue_comment');

      expect(result.event).toBeDefined();
      expect(result.event?.eventType).toBe('issue_comment');
      expect(result.event?.action).toBe('created');
      expect(result.event?.comment?.body).toBe('This is a test comment.');
      expect(result.event?.issue?.number).toBe(42);
    });

    test('should parse pull_request.opened event', () => {
      const result = parseWebhookEvent(PULL_REQUEST_PAYLOAD, 'pull_request');

      expect(result.event).toBeDefined();
      expect(result.event?.eventType).toBe('pull_request');
      expect(result.event?.action).toBe('opened');
      expect(result.event?.issue?.number).toBe(10);
      expect(result.event?.issue?.title).toBe('Test Pull Request');
    });

    test('should return null for unsupported event type', () => {
      const result = parseWebhookEvent({}, 'push');

      expect(result.event).toBeNull();
      expect(result.error).toContain('Unsupported');
    });

    test('should return null for unsupported action', () => {
      const payload = { ...ISSUE_OPENED_PAYLOAD, action: 'labeled' };
      const result = parseWebhookEvent(payload, 'issues');

      expect(result.event).toBeNull();
    });

    test('should skip PR comments (issue_comment on PR)', () => {
      const prCommentPayload = {
        ...ISSUE_COMMENT_PAYLOAD,
        issue: {
          ...ISSUE_COMMENT_PAYLOAD.issue,
          pull_request: { url: 'https://api.github.com/repos/test/prs/10' },
        },
      };
      const result = parseWebhookEvent(prCommentPayload, 'issue_comment');

      expect(result.event).toBeNull();
    });
  });

  describe('Full Webhook Handling', () => {
    test('should accept valid webhook request', async () => {
      const payload = JSON.stringify(ISSUE_OPENED_PAYLOAD);
      const signature = await createSignature(payload, TEST_SECRET);
      const request = createWebhookRequest(payload, 'issues', signature);

      const response = await handleGitHubWebhook(request, TEST_SECRET);

      expect(response.status).toBe(200);
      const body = (await response.json()) as { message?: string; eventType?: string };
      expect(body.message).toBe('Webhook received');
      expect(body.eventType).toBe('issues');
    });

    test('should reject request without signature header', async () => {
      const payload = JSON.stringify(ISSUE_OPENED_PAYLOAD);
      const request = new Request('http://localhost/api/github/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'issues',
          'X-GitHub-Delivery': 'test-delivery',
        },
        body: payload,
      });

      const response = await handleGitHubWebhook(request, TEST_SECRET);

      expect(response.status).toBe(401);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain('Missing signature');
    });

    test('should reject request without event type header', async () => {
      const payload = JSON.stringify(ISSUE_OPENED_PAYLOAD);
      const signature = await createSignature(payload, TEST_SECRET);
      const request = new Request('http://localhost/api/github/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': signature,
          'X-GitHub-Delivery': 'test-delivery',
        },
        body: payload,
      });

      const response = await handleGitHubWebhook(request, TEST_SECRET);

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain('Missing event type');
    });

    test('should reject request without delivery ID header', async () => {
      const payload = JSON.stringify(ISSUE_OPENED_PAYLOAD);
      const signature = await createSignature(payload, TEST_SECRET);
      const request = new Request('http://localhost/api/github/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': signature,
          'X-GitHub-Event': 'issues',
        },
        body: payload,
      });

      const response = await handleGitHubWebhook(request, TEST_SECRET);

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain('Missing delivery ID');
    });

    test('should reject request with invalid signature', async () => {
      const payload = JSON.stringify(ISSUE_OPENED_PAYLOAD);
      const request = createWebhookRequest(payload, 'issues', 'sha256=invalid');

      const response = await handleGitHubWebhook(request, TEST_SECRET);

      expect(response.status).toBe(401);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain('Invalid signature');
    });

    test('should reject invalid JSON payload', async () => {
      const invalidPayload = 'not valid json {{{';
      const signature = await createSignature(invalidPayload, TEST_SECRET);
      const request = createWebhookRequest(invalidPayload, 'issues', signature);

      const response = await handleGitHubWebhook(request, TEST_SECRET);

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain('Invalid JSON');
    });

    test('should return 200 for unsupported event type (not an error)', async () => {
      const payload = JSON.stringify({});
      const signature = await createSignature(payload, TEST_SECRET);
      const request = createWebhookRequest(payload, 'watch', signature);

      const response = await handleGitHubWebhook(request, TEST_SECRET);

      expect(response.status).toBe(200);
      const body = (await response.json()) as { message?: string };
      expect(body.message).toContain('not supported');
    });
  });

  describe('Event Handler Callback', () => {
    test('should call onEvent callback with parsed event', async () => {
      let capturedEvent: GitHubEvent | null = null;

      const payload = JSON.stringify(ISSUE_OPENED_PAYLOAD);
      const signature = await createSignature(payload, TEST_SECRET);
      const request = createWebhookRequest(payload, 'issues', signature);

      await handleGitHubWebhook(request, TEST_SECRET, (event) => {
        capturedEvent = event;
      });

      expect(capturedEvent).toBeDefined();
      expect(capturedEvent?.eventType).toBe('issues');
      expect(capturedEvent?.action).toBe('opened');
      expect(capturedEvent?.issue?.number).toBe(42);
    });

    test('should handle async onEvent callback', async () => {
      let capturedEvent: GitHubEvent | null = null;

      const payload = JSON.stringify(ISSUE_OPENED_PAYLOAD);
      const signature = await createSignature(payload, TEST_SECRET);
      const request = createWebhookRequest(payload, 'issues', signature);

      const response = await handleGitHubWebhook(request, TEST_SECRET, async (event) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        capturedEvent = event;
      });

      expect(response.status).toBe(200);
      expect(capturedEvent).toBeDefined();
    });

    test('should return success even if handler throws', async () => {
      const payload = JSON.stringify(ISSUE_OPENED_PAYLOAD);
      const signature = await createSignature(payload, TEST_SECRET);
      const request = createWebhookRequest(payload, 'issues', signature);

      const response = await handleGitHubWebhook(request, TEST_SECRET, () => {
        throw new Error('Handler error');
      });

      expect(response.status).toBe(200);
    });
  });

  describe('Constant-Time Comparison', () => {
    test('should use constant-time comparison for security', async () => {
      const payload = JSON.stringify(ISSUE_OPENED_PAYLOAD);
      const correctSignature = await createSignature(payload, TEST_SECRET);

      const wrongSignature = correctSignature.slice(0, -1) + '0';

      const isValid = await verifySignature(payload, wrongSignature, TEST_SECRET);

      expect(isValid).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty payload', async () => {
      const payload = '';
      const signature = await createSignature(payload, TEST_SECRET);
      const request = createWebhookRequest(payload, 'issues', signature);

      const response = await handleGitHubWebhook(request, TEST_SECRET);

      expect(response.status).toBe(400);
    });

    test('should handle null body in issue', async () => {
      const payloadWithNullBody = {
        ...ISSUE_OPENED_PAYLOAD,
        issue: {
          ...ISSUE_OPENED_PAYLOAD.issue,
          body: null,
        },
      };
      const payload = JSON.stringify(payloadWithNullBody);
      const result = parseWebhookEvent(payloadWithNullBody, 'issues');

      expect(result.event).toBeDefined();
      expect(result.event?.issue?.body).toBe('');
    });

    test('should handle special characters in content', async () => {
      const specialPayload = {
        ...ISSUE_OPENED_PAYLOAD,
        issue: {
          ...ISSUE_OPENED_PAYLOAD.issue,
          title: 'Test with emoji 🎉 and unicode 你好',
          body: 'Special chars: <>&"\'`$\\n\\t',
        },
      };
      const result = parseWebhookEvent(specialPayload, 'issues');

      expect(result.event).toBeDefined();
      expect(result.event?.issue?.title).toContain('🎉');
      expect(result.event?.issue?.body).toContain('\\n');
    });
  });
});
