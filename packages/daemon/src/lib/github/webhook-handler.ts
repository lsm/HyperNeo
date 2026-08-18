import type { GitHubEvent } from '@hyperneo/shared';
import { Logger } from '../logger';
import { normalizeWebhookEvent } from './event-normalizer';
import type { WebhookParseResult } from './types';

const log = new Logger('github-webhook');

export async function verifySignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const signatureParts = signature.split('=');
  if (signatureParts.length !== 2 || signatureParts[0] !== 'sha256') {
    log.error('Invalid signature format');
    return false;
  }

  const expectedHex = signatureParts[1];
  if (!expectedHex) {
    return false;
  }

  try {
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

    const computedHex = bufferToHex(signatureBuffer);

    return constantTimeEqual(computedHex, expectedHex);
  } catch (error) {
    log.error('Signature verification failed', error);
    return false;
  }
}

function bufferToHex(buffer: ArrayBuffer): string {
  const array = new Uint8Array(buffer);
  const parts: string[] = [];
  for (let i = 0; i < array.length; i++) {
    parts.push(array[i]!.toString(16).padStart(2, '0'));
  }
  return parts.join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export function parseWebhookEvent(payload: unknown, eventType: string): WebhookParseResult {
  try {
    const event = normalizeWebhookEvent(eventType, payload);

    if (!event) {
      return {
        event: null,
        error: `Unsupported event type or action: ${eventType}`,
      };
    }

    return { event };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error('Failed to parse webhook event', errorMessage);
    return {
      event: null,
      error: `Failed to parse event: ${errorMessage}`,
    };
  }
}

export async function handleGitHubWebhook(
  req: Request,
  secret: string,
  onEvent?: (event: GitHubEvent) => Promise<void> | void
): Promise<Response> {
  const signature = req.headers.get('X-Hub-Signature-256');
  const eventType = req.headers.get('X-GitHub-Event');
  const deliveryId = req.headers.get('X-GitHub-Delivery');

  if (!signature) {
    log.warn('Missing X-Hub-Signature-256 header');
    return new Response(JSON.stringify({ error: 'Missing signature header' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!eventType) {
    log.warn('Missing X-GitHub-Event header');
    return new Response(JSON.stringify({ error: 'Missing event type header' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!deliveryId) {
    log.warn('Missing X-GitHub-Delivery header');
    return new Response(JSON.stringify({ error: 'Missing delivery ID header' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const rawBody = await req.text();

  const isValid = await verifySignature(rawBody, signature, secret);
  if (!isValid) {
    log.warn('Invalid webhook signature', { deliveryId, eventType });
    return new Response(JSON.stringify({ error: 'Invalid signature' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    log.error('Failed to parse webhook payload as JSON', error);
    return new Response(JSON.stringify({ error: 'Invalid JSON payload' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const parseResult = parseWebhookEvent(payload, eventType);

  if (!parseResult.event) {
    log.debug('Ignoring unsupported event', {
      deliveryId,
      eventType,
      error: parseResult.error,
    });
    return new Response(
      JSON.stringify({
        message: 'Event type not supported',
        eventType,
        deliveryId,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  if (onEvent) {
    try {
      await onEvent(parseResult.event);
    } catch (error) {
      log.error('Event handler failed', {
        deliveryId,
        eventType,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  log.info('Webhook processed successfully', {
    deliveryId,
    eventType,
    action: parseResult.event.action,
    repository: parseResult.event.repository.fullName,
  });

  return new Response(
    JSON.stringify({
      message: 'Webhook received',
      eventType,
      deliveryId,
      eventId: parseResult.event.id,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

export function createWebhookHandler(
  secret: string,
  onEvent?: (event: GitHubEvent) => Promise<void> | void
): (req: Request) => Promise<Response> {
  return (req: Request) => handleGitHubWebhook(req, secret, onEvent);
}
